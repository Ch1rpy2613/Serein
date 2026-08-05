import {
  CITY,
  type AtmosProfile,
  type DayData,
  type ProfilePoint,
} from '../contracts';
import { mockAtmosProfile, mockDayData } from './mock';

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const PRESSURE_LEVELS = [1000, 925, 850, 700, 500, 300] as const;
const HOURS = 25;

type CacheEnvelope<T> = {
  fetchedAt: number;
  data: T;
};

type ForecastHourly = {
  time: string[];
  temperature_2m: number[];
  dew_point_2m: number[];
  relative_humidity_2m: number[];
  precipitation: number[];
  wind_speed_10m: number[];
  wind_direction_10m: number[];
  wind_gusts_10m: number[];
  cloud_cover: number[];
  cloud_cover_low: number[];
  cloud_cover_mid: number[];
  cloud_cover_high: number[];
  pressure_msl: number[];
  visibility: number[];
} & Record<string, number[] | string[] | undefined>;

type AirQualityHourly = {
  time: string[];
  us_aqi: number[];
  pm2_5: number[];
  pm10: number[];
  ozone: number[];
  nitrogen_dioxide: number[];
  sulphur_dioxide: number[];
  carbon_monoxide: number[];
};

const inFlight = new Map<string, Promise<unknown>>();
/** 本会话已成功取过的 (dataType:date)，避免当天跨小时重复进入再打网络 */
const sessionFetched = new Set<string>();

const round2 = (x: number): number => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function isMockForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('mock') === '1';
  } catch {
    return false;
  }
}

/** 城市时区下的今日 ISO 日期 */
export function todayInCity(now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CITY.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // fall through
  }
  return now.toISOString().slice(0, 10);
}

function cacheKey(dataType: string, date: string): string {
  return `serein:${CITY.name}:${date}:${dataType}`;
}

function readCache<T>(key: string): CacheEnvelope<T> | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (
      !parsed ||
      typeof parsed.fetchedAt !== 'number' ||
      parsed.data === undefined ||
      parsed.data === null
    ) {
      return null;
    }
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, data: T): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const envelope: CacheEnvelope<T> = { fetchedAt: Date.now(), data };
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Quota / private mode — ignore.
  }
}

function mockSeedForDate(date: string): number {
  let hash = 2166136261;
  for (let i = 0; i < date.length; i += 1) {
    hash ^= date.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pctToUnit(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return round2(clamp((value as number) / 100, 0, 1));
}

function num(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function sliceDayIndices(times: string[], date: string): number[] {
  const indices: number[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const stamp = times[i];
    if (!stamp.startsWith(date)) continue;
    indices.push(i);
  }
  if (indices.length === 0) return [];

  // 取当天 00:00 起连续 24 点，再拼次日 00:00 作为第 25 点
  const start = indices[0];
  const dayIndices = Array.from({ length: 24 }, (_, offset) => start + offset);
  const nextDayStart = start + 24;
  if (nextDayStart < times.length) {
    dayIndices.push(nextDayStart);
  } else {
    dayIndices.push(start + 23);
  }
  return dayIndices;
}

function pickSeries(
  values: Array<number | null | undefined> | undefined,
  indices: number[],
  map: (v: number) => number = (v) => round2(v),
  fallback = 0,
): number[] {
  return indices.map((index) => {
    const raw = values?.[index];
    return map(num(raw, fallback));
  });
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * TODO: AOD 无免费直采源；此处固定 0.15 为基线，并随 cloudCover 微调近似。
 */
function approximateAod(cloudCover: number[]): number {
  return round2(clamp(0.15 + mean(cloudCover) * 0.12, 0, 1));
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('offline');
      }
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_RETRIES) break;
      const delay = 300 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildForecastUrl(): string {
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    hourly: [
      'temperature_2m',
      'dew_point_2m',
      'relative_humidity_2m',
      'precipitation',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m',
      'cloud_cover',
      'cloud_cover_low',
      'cloud_cover_mid',
      'cloud_cover_high',
      'pressure_msl',
      'visibility',
    ].join(','),
    wind_speed_unit: 'ms',
    timezone: CITY.tz,
    forecast_days: '2',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function buildAirQualityUrl(): string {
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    hourly: [
      'us_aqi',
      'pm2_5',
      'pm10',
      'ozone',
      'nitrogen_dioxide',
      'sulphur_dioxide',
      'carbon_monoxide',
    ].join(','),
    timezone: CITY.tz,
    forecast_days: '2',
  });
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
}

function buildProfileUrl(): string {
  const fields: string[] = [];
  for (const level of PRESSURE_LEVELS) {
    fields.push(
      `temperature_${level}hPa`,
      `geopotential_height_${level}hPa`,
      `wind_speed_${level}hPa`,
      `wind_direction_${level}hPa`,
    );
  }
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    hourly: fields.join(','),
    wind_speed_unit: 'ms',
    timezone: CITY.tz,
    forecast_days: '2',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function assembleDayData(
  forecast: { hourly: ForecastHourly },
  air: { hourly: AirQualityHourly },
  date: string,
): DayData {
  const indices = sliceDayIndices(forecast.hourly.time, date);
  if (indices.length !== HOURS) {
    throw new Error(`forecast day slice expected ${HOURS} points, got ${indices.length}`);
  }

  const airIndices = sliceDayIndices(air.hourly.time, date);
  const aqiIndex = airIndices.length === HOURS ? airIndices : indices;

  const cloudCover = pickSeries(forecast.hourly.cloud_cover, indices, pctToUnit);
  const cloudCoverLow = pickSeries(forecast.hourly.cloud_cover_low, indices, pctToUnit);
  const cloudCoverMid = pickSeries(forecast.hourly.cloud_cover_mid, indices, pctToUnit);
  const cloudCoverHigh = pickSeries(forecast.hourly.cloud_cover_high, indices, pctToUnit);

  return {
    date,
    temperature: pickSeries(forecast.hourly.temperature_2m, indices),
    dewPoint: pickSeries(forecast.hourly.dew_point_2m, indices),
    humidity: pickSeries(forecast.hourly.relative_humidity_2m, indices, (v) =>
      round2(clamp(v, 0, 100)),
    ),
    precipitation: pickSeries(forecast.hourly.precipitation, indices, (v) =>
      round2(Math.max(0, v)),
    ),
    windSpeed: pickSeries(forecast.hourly.wind_speed_10m, indices, (v) =>
      round2(Math.max(0, v)),
    ),
    windDirection: pickSeries(forecast.hourly.wind_direction_10m, indices, (v) =>
      round2(((v % 360) + 360) % 360),
    ),
    windGust: pickSeries(forecast.hourly.wind_gusts_10m, indices, (v) =>
      round2(Math.max(0, v)),
    ),
    cloudCover,
    pressure: pickSeries(forecast.hourly.pressure_msl, indices),
    aod: approximateAod(cloudCover),
    visibility: pickSeries(forecast.hourly.visibility, indices, (v) =>
      round2(clamp(v, 0, 100000)),
    ),
    cloudCoverLow,
    cloudCoverMid,
    cloudCoverHigh,
    aqi: {
      usAqi: pickSeries(air.hourly.us_aqi, aqiIndex, (v) => Math.round(clamp(v, 0, 500))),
      pm25: pickSeries(air.hourly.pm2_5, aqiIndex, (v) => round2(Math.max(0, v))),
      pm10: pickSeries(air.hourly.pm10, aqiIndex, (v) => round2(Math.max(0, v))),
      o3: pickSeries(air.hourly.ozone, aqiIndex, (v) => round2(Math.max(0, v))),
      no2: pickSeries(air.hourly.nitrogen_dioxide, aqiIndex, (v) => round2(Math.max(0, v))),
      so2: pickSeries(air.hourly.sulphur_dioxide, aqiIndex, (v) => round2(Math.max(0, v))),
      co: pickSeries(air.hourly.carbon_monoxide, aqiIndex, (v) => round2(Math.max(0, v))),
    },
  };
}

function nearestHourIndex(times: string[], minutes: number): number {
  const date = todayInCity();
  const targetHour = Math.min(24, Math.max(0, Math.round(minutes / 60)));
  // 24:00 对齐次日 00:00
  const wantDate =
    targetHour === 24
      ? (() => {
          const [y, m, d] = date.split('-').map(Number);
          return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
        })()
      : date;
  const wantHour = targetHour === 24 ? 0 : targetHour;

  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times.length; i += 1) {
    const stamp = times[i];
    const stampDate = stamp.slice(0, 10);
    const hour = Number(stamp.slice(11, 13));
    if (!Number.isFinite(hour)) continue;
    const dayBias = stampDate === wantDate ? 0 : 100;
    const dist = dayBias + Math.abs(hour - wantHour);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function assembleProfile(hourly: ForecastHourly, minutes: number): AtmosProfile {
  const index = nearestHourIndex(hourly.time, minutes);
  const levels: ProfilePoint[] = PRESSURE_LEVELS.map((pressure) => {
    const temperature = num(hourly[`temperature_${pressure}hPa`]?.[index] as number | undefined, 0);
    const heightM = num(
      hourly[`geopotential_height_${pressure}hPa`]?.[index] as number | undefined,
      0,
    );
    const windSpeed = num(hourly[`wind_speed_${pressure}hPa`]?.[index] as number | undefined, 0);
    const windDirection = num(
      hourly[`wind_direction_${pressure}hPa`]?.[index] as number | undefined,
      0,
    );
    return {
      pressure,
      heightM: round2(heightM),
      temperature: round2(temperature),
      windSpeed: round2(Math.max(0, windSpeed)),
      windDirection: round2(((windDirection % 360) + 360) % 360),
    };
  });
  levels.sort((a, b) => a.heightM - b.heightM);
  return { levels };
}

async function dedupe<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = factory().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

function sessionKey(dataType: string, date: string): string {
  return `${dataType}:${date}`;
}

function readStaleCache<T>(key: string): T | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}

function fallbackDayData(date: string, reason: unknown): DayData {
  console.warn('[openmeteo] fetchDayData 回退 mock', reason);
  const data = mockDayData(mockSeedForDate(date));
  return { ...data, date };
}

function fallbackProfile(minutes: number, reason: unknown): AtmosProfile {
  console.warn('[openmeteo] fetchProfile 回退 mock', reason);
  return mockAtmosProfile(mockSeedForDate(todayInCity()), minutes);
}

/** GET forecast + air-quality，合并为当天 25 点 DayData */
export async function fetchDayData(): Promise<DayData> {
  const date = todayInCity();

  if (isMockForced()) {
    const data = mockDayData(mockSeedForDate(date));
    return { ...data, date };
  }

  const key = cacheKey('day', date);
  const cached = readCache<DayData>(key);
  if (cached) {
    sessionFetched.add(sessionKey('day', date));
    return cached.data;
  }

  // 当天内跨小时重复进入：本会话已取过则不再请求
  if (sessionFetched.has(sessionKey('day', date))) {
    const stale = readStaleCache<DayData>(key);
    if (stale) return stale;
  }

  return dedupe(key, async () => {
    try {
      const [forecast, air] = await Promise.all([
        fetchJson<{ hourly: ForecastHourly }>(buildForecastUrl()),
        fetchJson<{ hourly: AirQualityHourly }>(buildAirQualityUrl()),
      ]);
      const data = assembleDayData(forecast, air, date);
      writeCache(key, data);
      sessionFetched.add(sessionKey('day', date));
      return data;
    } catch (error) {
      const stale = readStaleCache<DayData>(key);
      if (stale) {
        console.warn('[openmeteo] fetchDayData 使用过期缓存', error);
        sessionFetched.add(sessionKey('day', date));
        return stale;
      }
      return fallbackDayData(date, error);
    }
  });
}

/** 取距 minutes 最近整点的六层气压面廓线，按高度升序 */
export async function fetchProfile(minutes: number): Promise<AtmosProfile> {
  const date = todayInCity();
  const hour = Math.min(24, Math.max(0, Math.round(minutes / 60)));
  const dataType = `profile:${hour}`;

  if (isMockForced()) {
    return mockAtmosProfile(mockSeedForDate(date), minutes);
  }

  const key = cacheKey(dataType, date);
  const cached = readCache<AtmosProfile>(key);
  if (cached) {
    sessionFetched.add(sessionKey(dataType, date));
    return cached.data;
  }

  if (sessionFetched.has(sessionKey(dataType, date))) {
    const stale = readStaleCache<AtmosProfile>(key);
    if (stale) return stale;
  }

  return dedupe(key, async () => {
    try {
      const forecast = await fetchJson<{ hourly: ForecastHourly }>(buildProfileUrl());
      const data = assembleProfile(forecast.hourly, minutes);
      writeCache(key, data);
      sessionFetched.add(sessionKey(dataType, date));
      return data;
    } catch (error) {
      const stale = readStaleCache<AtmosProfile>(key);
      if (stale) {
        console.warn('[openmeteo] fetchProfile 使用过期缓存', error);
        return stale;
      }
      return fallbackProfile(minutes, error);
    }
  });
}

/** 缓存条目的更新时刻（供 UI 展示）；无缓存时返回当前时间 */
export function getCachedDayUpdatedAt(date = todayInCity()): Date {
  const cached = readCache<DayData>(cacheKey('day', date));
  if (cached) return new Date(cached.fetchedAt);
  return new Date();
}
