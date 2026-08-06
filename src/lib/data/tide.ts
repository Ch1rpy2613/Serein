/**
 * TideProvider —— 和风 Ocean / Tide API（经同源 `/api/qweather` 代理）。
 *
 * 流程：GeoAPI POI `type=TSTA` 找最近潮汐站 → `GET /v7/ocean/tide` 取当日
 * 逐时潮位 + 满潮/干潮表。城市不靠海 / 无数据 / 无 key → null（不抛错）。
 *
 * 官方文档：https://dev.qweather.com/docs/api/ocean/tide/
 * POI：https://dev.qweather.com/docs/api/geoapi/poi-lookup/
 */

import { writable } from 'svelte/store';
import { DEFAULT_CITY, type City } from '../contracts';

/** 官方端点路径（经同源代理；密钥仅在 server/.env） */
export const QWEATHER_POI_LOOKUP_PATH = '/api/qweather/geo/v2/poi/lookup';
export const QWEATHER_OCEAN_TIDE_PATH = '/api/qweather/v7/ocean/tide';

/** 最近潮汐站超过此距离（km）视为内陆无数据 */
export const MAX_TIDE_STATION_KM = 100;

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_PREFIX = 'serein:tide:';
const STATION_CACHE_PREFIX = 'serein:tide-station:';

export interface TideHourlyPoint {
  minutes: number;
  heightM: number;
}

export interface TideExtremum {
  minutes: number;
  type: 'high' | 'low';
  heightM: number;
}

export interface TideData {
  hourly: TideHourlyPoint[];
  extrema: TideExtremum[];
}

export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
}

export type TideStatus = '涨潮中' | '退潮中' | '满潮' | '干潮';

export interface TideProvider {
  readonly id: string;
  fetchTide(city: City, date: string): Promise<TideData | null>;
}

/** 切换器入口：无潮汐数据时 50% 透明度 */
export const tideAvailable = writable(true);

type CacheEnvelope<T> = { fetchedAt: number; data: T };

let providerDisabled = false;
const inFlight = new Map<string, Promise<TideData | null>>();
const stationInFlight = new Map<string, Promise<TideStation | null>>();

function isMockTideForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('mockTide') === '1';
  } catch {
    return false;
  }
}

/** @deprecated 密钥在服务端；未禁用时视为可尝试 */
export function isTideProviderConfigured(): boolean {
  return !providerDisabled;
}

export function resetTideProviderState(): void {
  providerDisabled = false;
  inFlight.clear();
  stationInFlight.clear();
  tideAvailable.set(true);
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** ISO YYYY-MM-DD → 和风 date=yyyyMMdd */
export function toQweatherDate(iso: string): string {
  return iso.replace(/-/g, '');
}

/** ISO 日期加减整天（UTC 日历算术，避免本地 DST） */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** 从和风 fxTime 解析本地分钟；仅保留目标日 */
export function fxTimeToMinutes(fxTime: string, dateIso: string): number | null {
  if (typeof fxTime !== 'string' || fxTime.length < 16) return null;
  const datePart = fxTime.slice(0, 10);
  if (datePart !== dateIso) return null;
  const m = fxTime.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (!Number.isFinite(minutes)) return null;
  return Math.max(0, Math.min(1440, minutes));
}

function num(value: unknown, fallback = NaN): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

type QwTideTableRaw = { fxTime?: string; height?: string | number; type?: string };
type QwTideHourlyRaw = { fxTime?: string; height?: string | number | null };

/** 归一化和风潮汐响应 → TideData；无有效点则 null */
export function normalizeTideResponse(
  json: unknown,
  dateIso: string,
): TideData | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as {
    code?: string | number;
    tideTable?: QwTideTableRaw[] | null;
    tideHourly?: QwTideHourlyRaw[] | null;
  };
  const code = root.code != null ? String(root.code) : '';
  if (code === '401' || code === '403') {
    providerDisabled = true;
    return null;
  }
  if (code && code !== '200') return null;

  const hourly: TideHourlyPoint[] = [];
  const hourlyRaw = Array.isArray(root.tideHourly) ? root.tideHourly : [];
  for (const row of hourlyRaw) {
    const minutes = fxTimeToMinutes(String(row.fxTime ?? ''), dateIso);
    const heightM = num(row.height);
    if (minutes === null || !Number.isFinite(heightM)) continue;
    hourly.push({ minutes, heightM });
  }
  hourly.sort((a, b) => a.minutes - b.minutes);

  const extrema: TideExtremum[] = [];
  const tableRaw = Array.isArray(root.tideTable) ? root.tideTable : [];
  for (const row of tableRaw) {
    const minutes = fxTimeToMinutes(String(row.fxTime ?? ''), dateIso);
    const heightM = num(row.height);
    const t = String(row.type ?? '').toUpperCase();
    if (minutes === null || !Number.isFinite(heightM)) continue;
    if (t !== 'H' && t !== 'L') continue;
    extrema.push({
      minutes,
      type: t === 'H' ? 'high' : 'low',
      heightM,
    });
  }
  extrema.sort((a, b) => a.minutes - b.minutes);

  if (hourly.length === 0 && extrema.length === 0) return null;
  return { hourly, extrema };
}

/** 线性插值潮高（m）；无数据 NaN */
export function sampleTideHeight(data: TideData, minutes: number): number {
  const pts = data.hourly;
  if (pts.length === 0) {
    // 仅有极值时用相邻极值粗插
    const ex = data.extrema;
    if (ex.length === 0) return NaN;
    if (ex.length === 1) return ex[0]!.heightM;
    const t = clamp(minutes, 0, 1440);
    if (t <= ex[0]!.minutes) return ex[0]!.heightM;
    if (t >= ex[ex.length - 1]!.minutes) return ex[ex.length - 1]!.heightM;
    for (let i = 0; i < ex.length - 1; i += 1) {
      const a = ex[i]!;
      const b = ex[i + 1]!;
      if (t >= a.minutes && t <= b.minutes) {
        const u = (t - a.minutes) / Math.max(1, b.minutes - a.minutes);
        return a.heightM + (b.heightM - a.heightM) * u;
      }
    }
    return ex[ex.length - 1]!.heightM;
  }

  const t = clamp(minutes, 0, 1440);
  if (t <= pts[0]!.minutes) return pts[0]!.heightM;
  if (t >= pts[pts.length - 1]!.minutes) return pts[pts.length - 1]!.heightM;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (t >= a.minutes && t <= b.minutes) {
      const u = (t - a.minutes) / Math.max(1, b.minutes - a.minutes);
      return a.heightM + (b.heightM - a.heightM) * u;
    }
  }
  return pts[pts.length - 1]!.heightM;
}

const EXTREMUM_NEAR_MIN = 18;

/**
 * 由相邻极值判断状态词。
 * 距极值 ≤18 分钟 → 满潮/干潮；否则看下一极值类型（向满潮=涨、向干潮=退）。
 */
export function tideStatusAt(data: TideData, minutes: number): TideStatus {
  const ex = data.extrema;
  if (ex.length === 0) {
    const h0 = sampleTideHeight(data, minutes);
    const h1 = sampleTideHeight(data, minutes + 20);
    if (!Number.isFinite(h0) || !Number.isFinite(h1)) return '涨潮中';
    return h1 >= h0 ? '涨潮中' : '退潮中';
  }

  const t = clamp(minutes, 0, 1440);
  let nearest: TideExtremum | null = null;
  let nearestDist = Infinity;
  for (const e of ex) {
    const d = Math.abs(e.minutes - t);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = e;
    }
  }
  if (nearest && nearestDist <= EXTREMUM_NEAR_MIN) {
    return nearest.type === 'high' ? '满潮' : '干潮';
  }

  let prev: TideExtremum | null = null;
  let next: TideExtremum | null = null;
  for (const e of ex) {
    if (e.minutes <= t) prev = e;
    if (e.minutes > t && !next) next = e;
  }
  if (!next && prev) {
    // 日末：用潮高导数
    const h0 = sampleTideHeight(data, t);
    const h1 = sampleTideHeight(data, Math.min(1440, t + 20));
    if (Number.isFinite(h0) && Number.isFinite(h1)) {
      return h1 >= h0 ? '涨潮中' : '退潮中';
    }
    return prev.type === 'low' ? '涨潮中' : '退潮中';
  }
  if (!prev && next) {
    return next.type === 'high' ? '涨潮中' : '退潮中';
  }
  if (next) {
    return next.type === 'high' ? '涨潮中' : '退潮中';
  }
  return '涨潮中';
}

export function formatTideClock(minutes: number): string {
  const m = Math.round(clamp(minutes, 0, 1440)) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 验收 / 离线：半日潮近似（两涨两落） */
export function mockTideData(dateIso = '2026-08-06'): TideData {
  const hourly: TideHourlyPoint[] = [];
  // 相位锚定：满潮 ~03:40 / 16:20，干潮 ~10:00 / 22:30
  for (let h = 0; h <= 23; h += 1) {
    const minutes = h * 60;
    const rad = ((minutes - 220) / 1440) * Math.PI * 4;
    const heightM = 1.7 + 1.15 * Math.cos(rad) + 0.12 * Math.sin(rad * 0.5);
    hourly.push({ minutes, heightM: Math.round(heightM * 100) / 100 });
  }
  const extrema: TideExtremum[] = [
    { minutes: 3 * 60 + 40, type: 'high', heightM: 2.95 },
    { minutes: 10 * 60 + 5, type: 'low', heightM: 0.62 },
    { minutes: 16 * 60 + 20, type: 'high', heightM: 3.12 },
    { minutes: 22 * 60 + 30, type: 'low', heightM: 0.78 },
  ];
  void dateIso;
  return { hourly, extrema };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function tideCacheKey(city: City, date: string): string {
  return `${CACHE_PREFIX}${city.name}:${date}`;
}

function stationCacheKey(city: City): string {
  return `${STATION_CACHE_PREFIX}${city.name}`;
}

function writeCache<T>(key: string, data: T): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const envelope: CacheEnvelope<T> = { fetchedAt: Date.now(), data };
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // quota / private mode
  }
}

function readCacheEnvelope<T>(key: string): CacheEnvelope<T> | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.fetchedAt !== 'number') return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<{ status: number; json: unknown } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (response.status === 503 || response.status === 401 || response.status === 403) {
      providerDisabled = true;
      return { status: response.status, json: null };
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type QwPoiRaw = {
  id?: string;
  name?: string;
  lat?: string | number;
  lon?: string | number;
  type?: string;
};

/** 最近潮汐观测站；过远 / 无结果 → null */
export async function resolveTideStation(city: City): Promise<TideStation | null> {
  if (providerDisabled) return null;

  const cacheKey = stationCacheKey(city);
  const cachedEnvelope = readCacheEnvelope<TideStation | null>(cacheKey);
  if (cachedEnvelope) return cachedEnvelope.data;

  const existing = stationInFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async (): Promise<TideStation | null> => {
    const location = `${city.lon.toFixed(2)},${city.lat.toFixed(2)}`;
    const url =
      `${QWEATHER_POI_LOOKUP_PATH}?location=${encodeURIComponent(location)}` +
      `&type=TSTA&number=10&lang=zh`;
    const result = await fetchJson(url);
    if (!result || providerDisabled) {
      writeCache(cacheKey, null);
      return null;
    }
    const root = result.json as { code?: string | number; poi?: QwPoiRaw[] | null };
    const code = root?.code != null ? String(root.code) : '';
    if (code === '401' || code === '403') {
      providerDisabled = true;
      writeCache(cacheKey, null);
      return null;
    }
    if (code && code !== '200') {
      writeCache(cacheKey, null);
      return null;
    }
    const list = Array.isArray(root?.poi) ? root.poi : [];
    let best: TideStation | null = null;
    for (const poi of list) {
      const id = typeof poi.id === 'string' ? poi.id.trim() : '';
      const lat = num(poi.lat);
      const lon = num(poi.lon);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const distanceKm = haversineKm(city.lat, city.lon, lat, lon);
      if (distanceKm > MAX_TIDE_STATION_KM) continue;
      if (!best || distanceKm < best.distanceKm) {
        best = {
          id,
          name: typeof poi.name === 'string' ? poi.name : id,
          lat,
          lon,
          distanceKm,
        };
      }
    }
    writeCache(cacheKey, best);
    return best;
  })();

  stationInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    stationInFlight.delete(cacheKey);
  }
}

async function fetchTideFromStation(
  stationId: string,
  dateIso: string,
): Promise<TideData | null> {
  if (providerDisabled) return null;
  const url =
    `${QWEATHER_OCEAN_TIDE_PATH}?location=${encodeURIComponent(stationId)}` +
    `&date=${encodeURIComponent(toQweatherDate(dateIso))}`;
  const result = await fetchJson(url);
  if (!result || providerDisabled) return null;
  if (!result.json) return null;
  return normalizeTideResponse(result.json, dateIso);
}

export const qweatherTideProvider: TideProvider = {
  id: 'qweather',
  async fetchTide(city: City, date: string): Promise<TideData | null> {
    const station = await resolveTideStation(city);
    if (!station) return null;
    return fetchTideFromStation(station.id, date);
  },
};

export const mockTideProvider: TideProvider = {
  id: 'mock',
  async fetchTide(_city: City, date: string): Promise<TideData | null> {
    return mockTideData(date);
  },
};

function activeProvider(): TideProvider | null {
  if (isMockTideForced()) return mockTideProvider;
  if (providerDisabled) return null;
  return qweatherTideProvider;
}

/**
 * 拉取城市某日潮汐。
 * - 503 / 401/403 / 已禁用 / 无站点 / 无数据 → null，不抛错
 * - `?mockTide=1` → mock
 * - 缓存 10 分钟（key 含城市 + 日期）
 */
export async function fetchTide(
  city: City = DEFAULT_CITY,
  date: string,
  provider?: TideProvider | null,
): Promise<TideData | null> {
  const resolved = provider === undefined ? activeProvider() : provider;
  if (!resolved) {
    tideAvailable.set(false);
    return null;
  }

  if (resolved.id === 'mock') {
    const data = await resolved.fetchTide(city, date);
    tideAvailable.set(data != null);
    return data;
  }

  const key = tideCacheKey(city, date);
  // 区分「未缓存」与「已缓存 null」（内陆 / 无数据）
  const cachedEnvelope = readCacheEnvelope<TideData | null>(key);
  if (cachedEnvelope) {
    tideAvailable.set(cachedEnvelope.data != null);
    return cachedEnvelope.data;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<TideData | null> => {
    try {
      const data = await resolved.fetchTide(city, date);
      writeCache(key, data);
      tideAvailable.set(data != null);
      return data;
    } catch {
      tideAvailable.set(false);
      return null;
    }
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** 探测当前城市是否有潮汐（用于切换器半透明）；不强制拉全日曲线 */
export async function probeTideAvailability(city: City = DEFAULT_CITY): Promise<boolean> {
  if (isMockTideForced()) {
    tideAvailable.set(true);
    return true;
  }
  if (providerDisabled) {
    tideAvailable.set(false);
    return false;
  }
  const station = await resolveTideStation(city);
  const ok = station != null;
  tideAvailable.set(ok);
  return ok;
}

export interface TideDaySummary {
  date: string;
  extrema: TideExtremum[];
}

/** 分析模式：自 startDate 起连续 days 天的满潮/干潮表（缺日跳过） */
export async function fetchTideExtremaRange(
  city: City,
  startDate: string,
  days = 3,
  provider?: TideProvider | null,
): Promise<TideDaySummary[]> {
  const out: TideDaySummary[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDaysIso(startDate, i);
    const data = await fetchTide(city, date, provider);
    if (data && data.extrema.length > 0) {
      out.push({ date, extrema: data.extrema });
    }
  }
  return out;
}
