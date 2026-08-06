/**
 * 分钟级降水（和风 Minutely Precipitation，经同源 `/api/qweather` 代理）。
 *
 * 官方文档：https://dev.qweather.com/docs/api/minutely/minutely-precipitation/
 * 路径：GET /v7/minutely/5m?location={lon},{lat}
 * 中国 1 km、未来 2h、每 5 分钟一点。无 key / 无权限 / 无数据 → null。
 */

import { DEFAULT_CITY, type City } from '../contracts';

/** 官方端点（经同源代理；密钥仅在 server/.env） */
export const QWEATHER_MINUTELY_PATH = '/api/qweather/v7/minutely/5m';

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_PREFIX = 'serein:minutely:';

export type MinutelyPoint = { minutes: number; precipitation: number };

type CacheEnvelope = { fetchedAt: number; data: MinutelyPoint[] | null };

let providerDisabled = false;
const inFlight = new Map<string, Promise<MinutelyPoint[] | null>>();

function isMockForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('mock') === '1';
  } catch {
    return false;
  }
}

function cacheKey(city: City): string {
  return `${CACHE_PREFIX}${city.name}`;
}

function readCache(city: City): MinutelyPoint[] | null | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(cacheKey(city));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (!parsed || Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

function writeCache(city: City, data: MinutelyPoint[] | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      cacheKey(city),
      JSON.stringify({ fetchedAt: Date.now(), data } satisfies CacheEnvelope),
    );
  } catch {
    // ignore
  }
}

function parseFxTimeToMinutes(fxTime: string): number | null {
  // 例：2026-08-06T20:05+08:00
  const match = fxTime.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 归一化和风 minutely 响应 → 相对「现在」的分钟偏移 + 降水 mm */
export function normalizeMinutelyResponse(json: unknown): MinutelyPoint[] | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as {
    code?: string;
    minutely?: Array<{ fxTime?: string; precip?: string | number; type?: string }>;
  };
  if (root.code && root.code !== '200') return null;
  const rows = root.minutely;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const points: MinutelyPoint[] = [];
  let origin: number | null = null;
  for (const row of rows) {
    if (!row?.fxTime) continue;
    const abs = parseFxTimeToMinutes(row.fxTime);
    if (abs == null) continue;
    if (origin == null) origin = abs;
    const precip = Number(row.precip);
    if (!Number.isFinite(precip)) continue;
    points.push({
      minutes: abs - origin,
      precipitation: Math.round(Math.max(0, precip) * 100) / 100,
    });
  }
  return points.length > 0 ? points : null;
}

async function fetchUpstream(city: City): Promise<MinutelyPoint[] | null> {
  if (providerDisabled) return null;
  const lon = Math.round(city.lon * 100) / 100;
  const lat = Math.round(city.lat * 100) / 100;
  const url = `${QWEATHER_MINUTELY_PATH}?location=${lon},${lat}&lang=zh`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (res.status === 503 || res.status === 401 || res.status === 403) {
      providerDisabled = true;
      return null;
    }
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return normalizeMinutelyResponse(json);
  } catch (err) {
    console.warn('[minutely] fetch failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 未来约 2h 分钟级降水；无数据 / 无权限 → null（不抛错）。
 */
export async function fetchMinutelyPrecipitation(
  city: City = DEFAULT_CITY,
): Promise<MinutelyPoint[] | null> {
  if (isMockForced()) return null;

  const cached = readCache(city);
  if (cached !== undefined) return cached;

  const key = city.name;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const data = await fetchUpstream(city);
    writeCache(city, data);
    return data;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export function resetMinutelyProviderState(): void {
  providerDisabled = false;
  inFlight.clear();
}
