/**
 * NOAA SWPC Planetary K-index（免费无 key）。
 *
 * 1. 浏览器直连 `services.swpc.noaa.gov`（若 CORS 允许）
 * 2. 失败则同源 `GET /api/swpc/kp`（Hono 代理 + 3h 缓存）
 *
 * 取数组最新一条有效 KP（表头行跳过）。
 */

const DIRECT_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const PROXY_URL = '/api/swpc/kp';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_KEY = 'serein:swpc:kp';

type CacheEnvelope = { fetchedAt: number; kp: number };

let inFlight: Promise<number | null> | null = null;

function readCache(): number | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (!parsed || Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return Number.isFinite(parsed.kp) ? parsed.kp : null;
  } catch {
    return null;
  }
}

function writeCache(kp: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), kp }));
  } catch {
    // ignore
  }
}

/** SWPC JSON：首行表头，其后 `[time, kp, a_running, station_count]` */
export function parseLatestKp(payload: unknown): number | null {
  if (!Array.isArray(payload) || payload.length < 2) return null;
  for (let i = payload.length - 1; i >= 1; i -= 1) {
    const row = payload[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    const kp = Number(row[1]);
    if (Number.isFinite(kp) && kp >= 0 && kp <= 9) return Math.round(kp * 10) / 10;
  }
  return null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 最新行星 KP 指数；失败返回 null（不抛错）。
 */
export async function fetchKpIndex(): Promise<number | null> {
  const cached = readCache();
  if (cached != null) return cached;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      let payload: unknown;
      try {
        payload = await fetchJson(DIRECT_URL);
      } catch (directErr) {
        console.warn('[swpc] direct fetch failed, trying proxy', directErr);
        payload = await fetchJson(PROXY_URL);
      }
      const kp = parseLatestKp(payload);
      if (kp != null) writeCache(kp);
      return kp;
    } catch (err) {
      console.warn('[swpc] fetchKpIndex failed', err);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
