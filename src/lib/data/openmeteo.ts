import { get } from 'svelte/store';
import { computeAstro } from '../astro';
import { solarPosition } from '../astro/sun';
import {
  DEFAULT_CITY,
  type AtmosProfile,
  type City,
  type ClimateNormals,
  type DayData,
  type MultiModelData,
  type ProfilePoint,
} from '../contracts';
import { currentCity } from '../stores/app';
import {
  mockAtmosProfile,
  mockClimateNormals,
  mockDayData,
  mockMultiModel,
} from './mock';

/** 未显式传城市时读 currentCity；SSR / 异常回落天津 */
function activeCity(): City {
  try {
    return get(currentCity);
  } catch {
    return DEFAULT_CITY;
  }
}

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
  'uv_index',
  'sunshine_duration',
] as const;

/** daily 字段：日出日落 ISO → 本地分钟 */
const SURFACE_DAILY = ['sunrise', 'sunset'] as const;

/**
 * ERA5 archive 不支持 / 恒为 null 的变量（从 archive 请求中剔除）：
 * - visibility：hourly_units 为 undefined，值全 null
 * - uv_index：再分析无 UV 谱，Open-Meteo 明确不收录（见 issue #913）
 */
const ARCHIVE_UNSUPPORTED = new Set<string>(['visibility', 'uv_index']);

type CacheKind = 'forecast' | 'historical' | 'normals';

type CacheEnvelope<T> = {
  fetchedAt: number;
  data: T;
};

type ForecastHourly = {
  time: string[];
} & Record<string, Array<number | null | undefined> | string[] | undefined>;

type ForecastDaily = {
  time: string[];
  sunrise?: Array<string | null | undefined>;
  sunset?: Array<string | null | undefined>;
};

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

/** 城市时区下的今日 ISO 日期（默认当前城市） */
export function todayInCity(now = new Date(), city: City = activeCity()): string {
  const tz = city.tz;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
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

/** ISO 日期加减日历日（UTC 日历算术，与时区无关） */
export function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
}

/** 气候平均是否已永久缓存（二次加载零请求） */
export function hasClimateNormalsCache(date: string, city: City = activeCity()): boolean {
  if (isMockForced()) return true;
  return readCache<ClimateNormals>(normalsCacheKey(date, city), 'normals') !== null;
}

/** today − date（日历日差）；未来为负 */
function daysBeforeToday(date: string, today: string): number {
  const [ty, tm, td] = today.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  const t = Date.UTC(ty, tm - 1, td);
  const d = Date.UTC(dy, dm - 1, dd);
  return Math.round((t - d) / 86_400_000);
}

/** 目标日期在今天−5 天以内（含今天/未来）→ 预报 API；更早 → 历史 archive */
export function usesForecastApi(
  date: string,
  today: string = todayInCity(),
): boolean {
  return daysBeforeToday(date, today) <= FORECAST_LOOKBACK_DAYS;
}

/** 缓存 key：`serein:{城市}:{ISO日期}:{类型}` */
function cacheKey(dataType: string, date: string, city: City): string {
  return `serein:${city.name}:${date}:${dataType}`;
}

/** 气候平均永久缓存 key：normals-{城市}-{MMDD} */
function normalsCacheKey(date: string, city: City): string {
  const mmdd = date.slice(5, 7) + date.slice(8, 10);
  return `normals-${city.name}-${mmdd}`;
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

function surfaceDailyParams(): string {
  return SURFACE_DAILY.join(',');
}

/** Open-Meteo daily ISO（本地时区）→ 分钟 0–1440 */
function isoLocalToMinutes(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== 'string') return null;
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function pickDailyIndex(times: string[] | undefined, date: string): number {
  if (!times || times.length === 0) return 0;
  const idx = times.findIndex((t) => t.startsWith(date));
  return idx >= 0 ? idx : 0;
}

/**
 * archive 无 uv_index：用太阳高度角 × 晴空峰值 11，再按云量衰减。
 */
function approximateUvIndex(date: string, cloudCover: number[], city: City): number[] {
  return Array.from({ length: HOURS }, (_, h) => {
    const elev = solarPosition(date, h * 60, city.lat, city.lon).elevation;
    if (elev <= 0) return 0;
    const clear = 11 * Math.sin((elev * Math.PI) / 180);
    return round2(clamp(clear * (1 - cloudCover[h] * 0.65), 0, 11));
  });
}

function buildForecastDayUrl(date: string, today: string, city: City): string {
  const lookback = clamp(daysBeforeToday(date, today), 0, 92);
  // 覆盖目标日 + 次日 00:00（第 25 点）
  const ahead = Math.max(2, 1 - Math.min(0, daysBeforeToday(date, today)) + 1);
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    hourly: surfaceHourlyParams(false),
    daily: surfaceDailyParams(),
    wind_speed_unit: 'ms',
    timezone: city.tz,
    forecast_days: String(ahead),
  });
  if (lookback > 0) params.set('past_days', String(lookback));
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function buildArchiveDayUrl(date: string, city: City): string {
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    start_date: date,
    end_date: addDaysIso(date, 1),
    hourly: surfaceHourlyParams(true),
    daily: surfaceDailyParams(),
    wind_speed_unit: 'ms',
    timezone: city.tz,
  });
  return `https://archive-api.open-meteo.com/v1/archive?${params}`;
}

function buildAirQualityUrl(
  date: string,
  today: string,
  historical: boolean,
  city: City,
): string {
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    hourly: [
      'us_aqi',
      'pm2_5',
      'pm10',
      'ozone',
      'nitrogen_dioxide',
      'sulphur_dioxide',
      'carbon_monoxide',
    ].join(','),
    timezone: city.tz,
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

function buildForecastProfileUrl(date: string, today: string, city: City): string {
  const lookback = clamp(daysBeforeToday(date, today), 0, 92);
  const ahead = Math.max(2, 1 - Math.min(0, daysBeforeToday(date, today)) + 1);
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    hourly: profileHourlyFields(),
    wind_speed_unit: 'ms',
    timezone: city.tz,
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
function buildHistoricalProfileUrl(date: string, city: City): string {
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    start_date: date,
    end_date: addDaysIso(date, 1),
    hourly: profileHourlyFields(),
    wind_speed_unit: 'ms',
    timezone: city.tz,
  });
  return `https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`;
}

function buildMultiModelUrl(variable: 'temperature' | 'precipitation', city: City): string {
  const hourly = variable === 'temperature' ? 'temperature_2m' : 'precipitation';
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    hourly,
    // 最终确认可用的 model ID（见 MULTI_MODELS 注释）
    models: MULTI_MODELS.map((m) => m.model).join(','),
    timezone: city.tz,
    forecast_days: '2',
    wind_speed_unit: 'ms',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function assembleDayData(
  forecast: { hourly: ForecastHourly; daily?: ForecastDaily },
  air: { hourly: AirQualityHourly },
  date: string,
  city: City,
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

  // uv_index：预报直采；archive 已剔除 → 太阳高度角近似
  const uvRaw = forecast.hourly.uv_index as Array<number | null | undefined> | undefined;
  const uvIndex = uvRaw
    ? pickSeries(uvRaw, indices, (v) => round2(clamp(v, 0, 16)), 0)
    : approximateUvIndex(date, cloudCover, city);

  // sunshine_duration：秒/小时；缺测时按云量反相关兜底
  const sunshineRaw = forecast.hourly.sunshine_duration as
    | Array<number | null | undefined>
    | undefined;
  const sunshineDuration = sunshineRaw
    ? pickSeries(sunshineRaw, indices, (v) => round2(clamp(v, 0, 3600)), 0)
    : cloudCover.map((c) => round2(clamp(3600 * (1 - c), 0, 3600)));

  // 天文：日出日落优先 API daily；月相/月出月落用本地 astro 库（城市经纬度）
  const astroLocal = computeAstro(date, city.lat, city.lon);
  const daily = forecast.daily;
  const dayIdx = pickDailyIndex(daily?.time, date);
  const apiSunrise = isoLocalToMinutes(daily?.sunrise?.[dayIdx]);
  const apiSunset = isoLocalToMinutes(daily?.sunset?.[dayIdx]);
  const astro: DayData['astro'] = {
    ...astroLocal,
    sunrise: apiSunrise ?? astroLocal.sunrise,
    sunset: apiSunset ?? astroLocal.sunset,
  };

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
    uvIndex,
    sunshineDuration,
    astro,
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

function sessionKey(dataType: string, date: string, city: City): string {
  return `${city.name}:${dataType}:${date}`;
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
  city: City,
): MultiModelData {
  console.warn('[openmeteo] fetchMultiModel 回退 mock', reason);
  return mockMultiModel(variable, mockSeedForDate(todayInCity(new Date(), city)));
}

/** GET forecast / archive + air-quality，合并为指定日 25 点 DayData */
export async function fetchDayData(
  date?: string,
  city: City = DEFAULT_CITY,
): Promise<DayData> {
  const today = todayInCity(new Date(), city);
  const targetDate = date ?? today;
  const historical = !usesForecastApi(targetDate, today);
  const kind: CacheKind = historical ? 'historical' : 'forecast';

  if (isMockForced()) {
    const data = mockDayData(mockSeedForDate(targetDate));
    return { ...data, date: targetDate };
  }

  const key = cacheKey('day', targetDate, city);
  const cached = readCache<DayData>(key, kind);
  if (cached) {
    sessionFetched.add(sessionKey('day', targetDate, city));
    return cached.data;
  }

  // 当天内跨小时重复进入：本会话已取过则不再请求
  if (sessionFetched.has(sessionKey('day', targetDate, city))) {
    const stale = readStaleCache<DayData>(key);
    if (stale) return stale;
  }

  return dedupe(key, async () => {
    try {
      const weatherUrl = historical
        ? buildArchiveDayUrl(targetDate, city)
        : buildForecastDayUrl(targetDate, today, city);
      const [forecast, air] = await Promise.all([
        fetchJson<{ hourly: ForecastHourly; daily?: ForecastDaily }>(weatherUrl),
        fetchJson<{ hourly: AirQualityHourly }>(
          buildAirQualityUrl(targetDate, today, historical, city),
        ),
      ]);
      const data = assembleDayData(forecast, air, targetDate, city);
      writeCache(key, data);
      sessionFetched.add(sessionKey('day', targetDate, city));
      return data;
    } catch (error) {
      const stale = readStaleCache<DayData>(key);
      if (stale) {
        console.warn('[openmeteo] fetchDayData 使用过期缓存', error);
        sessionFetched.add(sessionKey('day', targetDate, city));
        return stale;
      }
      return fallbackDayData(targetDate, error);
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
  date?: string,
  city: City = DEFAULT_CITY,
): Promise<AtmosProfile> {
  const today = todayInCity(new Date(), city);
  const targetDate = date ?? today;
  const historical = !usesForecastApi(targetDate, today);
  const kind: CacheKind = historical ? 'historical' : 'forecast';
  const hour = Math.min(24, Math.max(0, Math.round(minutes / 60)));
  const dataType = `profile:${hour}`;

  if (isMockForced()) {
    return mockAtmosProfile(mockSeedForDate(targetDate), minutes);
  }

  const key = cacheKey(dataType, targetDate, city);
  const cached = readCache<AtmosProfile>(key, kind);
  if (cached) {
    sessionFetched.add(sessionKey(dataType, targetDate, city));
    return cached.data;
  }

  if (sessionFetched.has(sessionKey(dataType, targetDate, city))) {
    const stale = readStaleCache<AtmosProfile>(key);
    if (stale) return stale;
  }

  return dedupe(key, async () => {
    try {
      const url = historical
        ? buildHistoricalProfileUrl(targetDate, city)
        : buildForecastProfileUrl(targetDate, today, city);
      const forecast = await fetchJson<{ hourly: ForecastHourly }>(url);
      const data = assembleProfile(forecast.hourly, minutes, targetDate);
      writeCache(key, data);
      sessionFetched.add(sessionKey(dataType, targetDate, city));
      return data;
    } catch (error) {
      const stale = readStaleCache<AtmosProfile>(key);
      if (stale) {
        console.warn('[openmeteo] fetchProfile 使用过期缓存', error);
        return stale;
      }
      return fallbackProfile(targetDate, minutes, error);
    }
  });
}

/**
 * 同一日历日向前取 10 年 ERA5 逐时平均 → ClimateNormals。
 * localStorage 永久缓存：key = normals-城市-MMDD。
 */
export async function fetchClimateNormals(
  date: string,
  city: City = DEFAULT_CITY,
): Promise<ClimateNormals> {
  const key = normalsCacheKey(date, city);

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
          const url = buildArchiveDayUrl(day, city);
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
  city: City = DEFAULT_CITY,
): Promise<MultiModelData> {
  const date = todayInCity(new Date(), city);
  const dataType = `multimodel:${variable}`;
  const key = cacheKey(dataType, date, city);

  if (isMockForced()) {
    return mockMultiModel(variable, mockSeedForDate(date));
  }

  const cached = readCache<MultiModelData>(key, 'forecast');
  if (cached) return cached.data;

  if (sessionFetched.has(sessionKey(dataType, date, city))) {
    const stale = readStaleCache<MultiModelData>(key);
    if (stale) return stale;
  }

  return dedupe(key, async () => {
    try {
      const json = await fetchJson<{ hourly: ForecastHourly }>(buildMultiModelUrl(variable, city));
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
      sessionFetched.add(sessionKey(dataType, date, city));
      return data;
    } catch (error) {
      const stale = readStaleCache<MultiModelData>(key);
      if (stale) {
        console.warn('[openmeteo] fetchMultiModel 使用过期缓存', error);
        return stale;
      }
      return fallbackMultiModel(variable, error, city);
    }
  });
}

/** 缓存条目的更新时刻（供 UI 展示）；无缓存时返回当前时间 */
export function getCachedDayUpdatedAt(
  date: string = todayInCity(),
  city: City = activeCity(),
): Date {
  const kind: CacheKind = usesForecastApi(date, todayInCity(new Date(), city))
    ? 'forecast'
    : 'historical';
  const key = cacheKey('day', date, city);
  const cached = readCache<DayData>(key, kind);
  if (cached) return new Date(cached.fetchedAt);
  // 允许展示过期缓存时间戳
  const stale = readStaleCache<DayData>(key);
  if (stale) {
    try {
      const raw = localStorage.getItem(key);
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
