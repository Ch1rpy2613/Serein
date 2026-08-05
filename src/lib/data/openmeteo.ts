import {
  CITY,
  type AtmosProfile,
  type ClimateNormals,
  type DayData,
  type MultiModelData,
  type ProfilePoint,
} from '../contracts';
import {
  mockAtmosProfile,
  mockClimateNormals,
  mockDayData,
  mockMultiModel,
} from './mock';

/** 预报 / 近几日（today−5…today）缓存 TTL */
const FORECAST_TTL_MS = 10 * 60 * 1000;
/** 历史（archive）缓存 TTL */
const HISTORICAL_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const FORECAST_LOOKBACK_DAYS = 5;
const CLIMATE_YEARS = 10;
const HOURS = 25;

/**
 * 气压面（hPa）。预报 / Historical Forecast 均支持；
 * ERA5 archive API 不含气压面变量（见 fetchProfile 注释）。
 */
const PRESSURE_LEVELS = [
  1000, 975, 950, 925, 900, 850, 800, 700, 600, 550, 500, 450, 400, 350, 300, 250, 200,
] as const;

/**
 * 多模式预报 model ID（Open-Meteo Forecast `models` 参数，2026-08 文档）：
 * - ecmwf_ifs025 — ECMWF IFS 0.25°
 * - gfs_global  — NOAA GFS 全局
 * - icon_global — DWD ICON 全局
 * 若任一 ID 报错，可在 https://open-meteo.com/en/docs 的 models 列表中替换。
 */
const MULTI_MODELS = [
  { model: 'ecmwf_ifs025', label: 'ECMWF' },
  { model: 'gfs_global', label: 'GFS' },
  { model: 'icon_global', label: 'ICON' },
] as const;

/** 地表逐时字段；与预报 API 对齐 */
const SURFACE_HOURLY = [
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
] as const;

/**
 * ERA5 archive 不支持 / 恒为 null 的变量（从 archive 请求中剔除）：
 * - visibility：hourly_units 为 undefined，值全 null
 */
const ARCHIVE_UNSUPPORTED = new Set<string>(['visibility']);

type CacheKind = 'forecast' | 'historical' | 'normals';

type CacheEnvelope<T> = {
  fetchedAt: number;
  data: T;
};

type ForecastHourly = {
  time: string[];
} & Record<string, Array<number | null | undefined> | string[] | undefined>;

type AirQualityHourly = {
  time: string[];
  us_aqi: Array<number | null | undefined>;
  pm2_5: Array<number | null | undefined>;
  pm10: Array<number | null | undefined>;
  ozone: Array<number | null | undefined>;
  nitrogen_dioxide: Array<number | null | undefined>;
  sulphur_dioxide: Array<number | null | undefined>;
  carbon_monoxide: Array<number | null | undefined>;
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

function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
}

/** today − date（日历日差）；未来为负 */
function daysBeforeToday(date: string, today = todayInCity()): number {
  const [ty, tm, td] = today.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  const t = Date.UTC(ty, tm - 1, td);
  const d = Date.UTC(dy, dm - 1, dd);
  return Math.round((t - d) / 86_400_000);
}

/** 目标日期在今天−5 天以内（含今天/未来）→ 预报 API；更早 → 历史 archive */
export function usesForecastApi(date: string, today = todayInCity()): boolean {
  return daysBeforeToday(date, today) <= FORECAST_LOOKBACK_DAYS;
}

function cacheKey(dataType: string, date: string): string {
  return `serein:${CITY.name}:${date}:${dataType}`;
}

/** 气候平均永久缓存 key：normals-城市-MMDD */
function normalsCacheKey(date: string): string {
  const mmdd = date.slice(5, 7) + date.slice(8, 10);
  return `normals-${CITY.name}-${mmdd}`;
}

function ttlMs(kind: CacheKind): number | null {
  if (kind === 'forecast') return FORECAST_TTL_MS;
  if (kind === 'historical') return HISTORICAL_TTL_MS;
  return null; // normals：不过期
}

function readCache<T>(key: string, kind: CacheKind): CacheEnvelope<T> | null {
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
    const ttl = ttlMs(kind);
    if (ttl !== null && Date.now() - parsed.fetchedAt > ttl) return null;
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

function pctToUnit(value: number): number {
  return round2(clamp(value / 100, 0, 1));
}

function num(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/**
 * 缺测相邻线性插值；两端外推用最近有效值；全缺测用 fallback。
 */
function interpolateSeries(
  values: Array<number | null | undefined> | undefined,
  length: number,
  fallback = 0,
): number[] {
  const out: Array<number | null> = Array.from({ length }, (_, i) => {
    const raw = values?.[i];
    return Number.isFinite(raw as number) ? (raw as number) : null;
  });

  let i = 0;
  while (i < length) {
    if (out[i] !== null) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < length && out[j] === null) j += 1;
    const left = i > 0 ? (out[i - 1] as number) : null;
    const right = j < length ? (out[j] as number) : null;
    for (let k = i; k < j; k += 1) {
      if (left !== null && right !== null) {
        const t = (k - (i - 1)) / (j - (i - 1));
        out[k] = left + (right - left) * t;
      } else if (left !== null) {
        out[k] = left;
      } else if (right !== null) {
        out[k] = right;
      } else {
        out[k] = fallback;
      }
    }
    i = j;
  }

  return out.map((v) => (v === null ? fallback : v));
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
  const raw = indices.map((index) => {
    const v = values?.[index];
    return Number.isFinite(v as number) ? (v as number) : null;
  });
  const filled = interpolateSeries(raw, indices.length, fallback);
  return filled.map(map);
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

function surfaceHourlyParams(forArchive: boolean): string {
  const fields = SURFACE_HOURLY.filter((f) => !(forArchive && ARCHIVE_UNSUPPORTED.has(f)));
  return fields.join(',');
}

function buildForecastDayUrl(date: string, today: string): string {
  const lookback = clamp(daysBeforeToday(date, today), 0, 92);
  // 覆盖目标日 + 次日 00:00（第 25 点）
  const ahead = Math.max(2, 1 - Math.min(0, daysBeforeToday(date, today)) + 1);
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    hourly: surfaceHourlyParams(false),
    wind_speed_unit: 'ms',
    timezone: CITY.tz,
    forecast_days: String(ahead),
  });
  if (lookback > 0) params.set('past_days', String(lookback));
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function buildArchiveDayUrl(date: string): string {
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    start_date: date,
    end_date: addDaysIso(date, 1),
    hourly: surfaceHourlyParams(true),
    wind_speed_unit: 'ms',
    timezone: CITY.tz,
  });
  return `https://archive-api.open-meteo.com/v1/archive?${params}`;
}

function buildAirQualityUrl(date: string, today: string, historical: boolean): string {
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
  });
  if (historical) {
    params.set('start_date', date);
    params.set('end_date', addDaysIso(date, 1));
  } else {
    const lookback = clamp(daysBeforeToday(date, today), 0, 92);
    const ahead = Math.max(2, 1 - Math.min(0, daysBeforeToday(date, today)) + 1);
    params.set('forecast_days', String(ahead));
    if (lookback > 0) params.set('past_days', String(lookback));
  }
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
}

function profileHourlyFields(): string {
  const fields: string[] = [];
  for (const level of PRESSURE_LEVELS) {
    fields.push(
      `temperature_${level}hPa`,
      `geopotential_height_${level}hPa`,
      `wind_speed_${level}hPa`,
      `wind_direction_${level}hPa`,
      `relative_humidity_${level}hPa`,
    );
  }
  return fields.join(',');
}

function buildForecastProfileUrl(date: string, today: string): string {
  const lookback = clamp(daysBeforeToday(date, today), 0, 92);
  const ahead = Math.max(2, 1 - Math.min(0, daysBeforeToday(date, today)) + 1);
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    hourly: profileHourlyFields(),
    wind_speed_unit: 'ms',
    timezone: CITY.tz,
    forecast_days: String(ahead),
  });
  if (lookback > 0) params.set('past_days', String(lookback));
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

/**
 * ERA5 archive（archive-api）不存储气压面变量（值恒 null / 未收录）。
 * 廓线历史改走 Historical Forecast API（与 Forecast 同参，含气压面 + RH）。
 * @see https://open-meteo.com/en/docs/historical-forecast-api
 */
function buildHistoricalProfileUrl(date: string): string {
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    start_date: date,
    end_date: addDaysIso(date, 1),
    hourly: profileHourlyFields(),
    wind_speed_unit: 'ms',
    timezone: CITY.tz,
  });
  return `https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`;
}

function buildMultiModelUrl(variable: 'temperature' | 'precipitation'): string {
  const hourly = variable === 'temperature' ? 'temperature_2m' : 'precipitation';
  const params = new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    hourly,
    // 最终确认可用的 model ID（见 MULTI_MODELS 注释）
    models: MULTI_MODELS.map((m) => m.model).join(','),
    timezone: CITY.tz,
    forecast_days: '2',
    wind_speed_unit: 'ms',
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

  const cloudCover = pickSeries(forecast.hourly.cloud_cover as number[], indices, pctToUnit);
  const cloudCoverLow = pickSeries(
    forecast.hourly.cloud_cover_low as number[],
    indices,
    pctToUnit,
  );
  const cloudCoverMid = pickSeries(
    forecast.hourly.cloud_cover_mid as number[],
    indices,
    pctToUnit,
  );
  const cloudCoverHigh = pickSeries(
    forecast.hourly.cloud_cover_high as number[],
    indices,
    pctToUnit,
  );

  // archive 剔除 visibility 后用湿度反推兜底（与 mock 同思路）
  const humidity = pickSeries(
    forecast.hourly.relative_humidity_2m as number[],
    indices,
    (v) => round2(clamp(v, 0, 100)),
  );
  const visibilityRaw = forecast.hourly.visibility as Array<number | null | undefined> | undefined;
  const visibility = visibilityRaw
    ? pickSeries(visibilityRaw, indices, (v) => round2(clamp(v, 0, 100_000)), 10_000)
    : humidity.map((rh) => round2(clamp(25_000 - ((rh - 15) / 85) * 21_000, 4000, 25_000)));

  return {
    date,
    temperature: pickSeries(forecast.hourly.temperature_2m as number[], indices),
    dewPoint: pickSeries(forecast.hourly.dew_point_2m as number[], indices),
    humidity,
    precipitation: pickSeries(forecast.hourly.precipitation as number[], indices, (v) =>
      round2(Math.max(0, v)),
    ),
    windSpeed: pickSeries(forecast.hourly.wind_speed_10m as number[], indices, (v) =>
      round2(Math.max(0, v)),
    ),
    windDirection: pickSeries(forecast.hourly.wind_direction_10m as number[], indices, (v) =>
      round2(((v % 360) + 360) % 360),
    ),
    windGust: pickSeries(forecast.hourly.wind_gusts_10m as number[], indices, (v) =>
      round2(Math.max(0, v)),
    ),
    cloudCover,
    pressure: pickSeries(forecast.hourly.pressure_msl as number[], indices),
    aod: approximateAod(cloudCover),
    visibility,
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

function nearestHourIndex(times: string[], minutes: number, date: string): number {
  const targetHour = Math.min(24, Math.max(0, Math.round(minutes / 60)));
  // 24:00 对齐次日 00:00
  const wantDate = targetHour === 24 ? addDaysIso(date, 1) : date;
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

function assembleProfile(hourly: ForecastHourly, minutes: number, date: string): AtmosProfile {
  const index = nearestHourIndex(hourly.time, minutes, date);
  const levels: ProfilePoint[] = PRESSURE_LEVELS.map((pressure) => {
    const temperature = num(
      hourly[`temperature_${pressure}hPa`]?.[index] as number | undefined,
      0,
    );
    const heightM = num(
      hourly[`geopotential_height_${pressure}hPa`]?.[index] as number | undefined,
      0,
    );
    const windSpeed = num(
      hourly[`wind_speed_${pressure}hPa`]?.[index] as number | undefined,
      0,
    );
    const windDirection = num(
      hourly[`wind_direction_${pressure}hPa`]?.[index] as number | undefined,
      0,
    );
    const rh = num(
      hourly[`relative_humidity_${pressure}hPa`]?.[index] as number | undefined,
      50,
    );
    return {
      pressure,
      heightM: round2(heightM),
      temperature: round2(temperature),
      windSpeed: round2(Math.max(0, windSpeed)),
      windDirection: round2(((windDirection % 360) + 360) % 360),
      rh: round2(clamp(rh, 0, 100)),
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

function fallbackProfile(date: string, minutes: number, reason: unknown): AtmosProfile {
  console.warn('[openmeteo] fetchProfile 回退 mock', reason);
  return mockAtmosProfile(mockSeedForDate(date), minutes);
}

function fallbackNormals(date: string, reason: unknown): ClimateNormals {
  console.warn('[openmeteo] fetchClimateNormals 回退 mock', reason);
  return mockClimateNormals(mockSeedForDate(date));
}

function fallbackMultiModel(
  variable: 'temperature' | 'precipitation',
  reason: unknown,
): MultiModelData {
  console.warn('[openmeteo] fetchMultiModel 回退 mock', reason);
  return mockMultiModel(variable, mockSeedForDate(todayInCity()));
}

/** GET forecast / archive + air-quality，合并为指定日 25 点 DayData */
export async function fetchDayData(date: string = todayInCity()): Promise<DayData> {
  const today = todayInCity();
  const historical = !usesForecastApi(date, today);
  const kind: CacheKind = historical ? 'historical' : 'forecast';

  if (isMockForced()) {
    const data = mockDayData(mockSeedForDate(date));
    return { ...data, date };
  }

  const key = cacheKey('day', date);
  const cached = readCache<DayData>(key, kind);
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
      const weatherUrl = historical
        ? buildArchiveDayUrl(date)
        : buildForecastDayUrl(date, today);
      const [forecast, air] = await Promise.all([
        fetchJson<{ hourly: ForecastHourly }>(weatherUrl),
        fetchJson<{ hourly: AirQualityHourly }>(buildAirQualityUrl(date, today, historical)),
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

/**
 * 取距 minutes 最近整点的气压面廓线（含 rh），按高度升序。
 * @param date 可选；默认今天。历史日期：预报窗内走 forecast+past_days，更早走 Historical Forecast
 *             （ERA5 archive 无气压面，见 buildHistoricalProfileUrl 注释）。
 */
export async function fetchProfile(
  minutes: number,
  date: string = todayInCity(),
): Promise<AtmosProfile> {
  const today = todayInCity();
  const historical = !usesForecastApi(date, today);
  const kind: CacheKind = historical ? 'historical' : 'forecast';
  const hour = Math.min(24, Math.max(0, Math.round(minutes / 60)));
  const dataType = `profile:${hour}`;

  if (isMockForced()) {
    return mockAtmosProfile(mockSeedForDate(date), minutes);
  }

  const key = cacheKey(dataType, date);
  const cached = readCache<AtmosProfile>(key, kind);
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
      const url = historical
        ? buildHistoricalProfileUrl(date)
        : buildForecastProfileUrl(date, today);
      const forecast = await fetchJson<{ hourly: ForecastHourly }>(url);
      const data = assembleProfile(forecast.hourly, minutes, date);
      writeCache(key, data);
      sessionFetched.add(sessionKey(dataType, date));
      return data;
    } catch (error) {
      const stale = readStaleCache<AtmosProfile>(key);
      if (stale) {
        console.warn('[openmeteo] fetchProfile 使用过期缓存', error);
        return stale;
      }
      return fallbackProfile(date, minutes, error);
    }
  });
}

/**
 * 同一日历日向前取 10 年 ERA5 逐时平均 → ClimateNormals。
 * localStorage 永久缓存：key = normals-城市-MMDD。
 */
export async function fetchClimateNormals(date: string): Promise<ClimateNormals> {
  const key = normalsCacheKey(date);

  if (isMockForced()) {
    return mockClimateNormals(mockSeedForDate(date));
  }

  const cached = readCache<ClimateNormals>(key, 'normals');
  if (cached) return cached.data;

  return dedupe(key, async () => {
    try {
      const mmdd = date.slice(5); // MM-DD
      const endYear = Number(date.slice(0, 4)) - 1;
      const years: number[] = [];
      for (let y = endYear - CLIMATE_YEARS + 1; y <= endYear; y += 1) years.push(y);

      const yearSeries = await Promise.all(
        years.map(async (year) => {
          const day = `${year}-${mmdd}`;
          const url = buildArchiveDayUrl(day);
          const json = await fetchJson<{ hourly: ForecastHourly }>(url);
          const indices = sliceDayIndices(json.hourly.time, day);
          if (indices.length !== HOURS) {
            throw new Error(`normals ${day}: expected ${HOURS} points`);
          }
          return {
            temperature: pickSeries(json.hourly.temperature_2m as number[], indices),
            precipitation: pickSeries(
              json.hourly.precipitation as number[],
              indices,
              (v) => round2(Math.max(0, v)),
            ),
          };
        }),
      );

      const temperature = Array.from({ length: HOURS }, (_, h) =>
        round2(mean(yearSeries.map((s) => s.temperature[h]))),
      );
      const precipitation = Array.from({ length: HOURS }, (_, h) =>
        round2(mean(yearSeries.map((s) => s.precipitation[h]))),
      );

      const data: ClimateNormals = {
        temperature,
        precipitation,
        years: yearSeries.length,
      };
      writeCache(key, data);
      return data;
    } catch (error) {
      const stale = readStaleCache<ClimateNormals>(key);
      if (stale) {
        console.warn('[openmeteo] fetchClimateNormals 使用缓存', error);
        return stale;
      }
      return fallbackNormals(date, error);
    }
  });
}

/** 今日 25 点多模式预报（温度或降水） */
export async function fetchMultiModel(
  variable: 'temperature' | 'precipitation',
): Promise<MultiModelData> {
  const date = todayInCity();
  const dataType = `multimodel:${variable}`;
  const key = cacheKey(dataType, date);

  if (isMockForced()) {
    return mockMultiModel(variable, mockSeedForDate(date));
  }

  const cached = readCache<MultiModelData>(key, 'forecast');
  if (cached) return cached.data;

  if (sessionFetched.has(sessionKey(dataType, date))) {
    const stale = readStaleCache<MultiModelData>(key);
    if (stale) return stale;
  }

  return dedupe(key, async () => {
    try {
      const json = await fetchJson<{ hourly: ForecastHourly }>(buildMultiModelUrl(variable));
      const indices = sliceDayIndices(json.hourly.time, date);
      if (indices.length !== HOURS) {
        throw new Error(`multimodel day slice expected ${HOURS} points, got ${indices.length}`);
      }

      const fieldBase = variable === 'temperature' ? 'temperature_2m' : 'precipitation';
      const unit = variable === 'temperature' ? '°C' : 'mm';
      const map =
        variable === 'precipitation'
          ? (v: number) => round2(Math.max(0, v))
          : (v: number) => round2(v);

      const series = MULTI_MODELS.map(({ model, label }) => {
        // 多模型响应字段形如 temperature_2m_ecmwf_ifs025
        const keyed = json.hourly[`${fieldBase}_${model}`] as
          | Array<number | null | undefined>
          | undefined;
        const plain = json.hourly[fieldBase] as Array<number | null | undefined> | undefined;
        const values = pickSeries(keyed ?? plain, indices, map);
        return { model, label, values };
      });

      const data: MultiModelData = { variable, unit, series };
      writeCache(key, data);
      sessionFetched.add(sessionKey(dataType, date));
      return data;
    } catch (error) {
      const stale = readStaleCache<MultiModelData>(key);
      if (stale) {
        console.warn('[openmeteo] fetchMultiModel 使用过期缓存', error);
        return stale;
      }
      return fallbackMultiModel(variable, error);
    }
  });
}

/** 缓存条目的更新时刻（供 UI 展示）；无缓存时返回当前时间 */
export function getCachedDayUpdatedAt(date = todayInCity()): Date {
  const kind: CacheKind = usesForecastApi(date) ? 'forecast' : 'historical';
  const cached = readCache<DayData>(cacheKey('day', date), kind);
  if (cached) return new Date(cached.fetchedAt);
  // 允许展示过期缓存时间戳
  const stale = readStaleCache<DayData>(cacheKey('day', date));
  if (stale) {
    try {
      const raw = localStorage.getItem(cacheKey('day', date));
      if (raw) {
        const parsed = JSON.parse(raw) as CacheEnvelope<DayData>;
        if (typeof parsed.fetchedAt === 'number') return new Date(parsed.fetchedAt);
      }
    } catch {
      // ignore
    }
  }
  return new Date();
}
