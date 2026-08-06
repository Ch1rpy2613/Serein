/**
 * TyphoonProvider —— 活跃台风列表 + 路径（双实现优雅降级）。
 *
 * 实现 A（首选）：和风 Tropical Cyclone API，经同源 `/api/qweather/v7/*` 代理
 * 实现 B：浙江水利非官方公开源，经 `/api/typhoon/*` 代理（Pages Function / Vite proxy）
 *
 * 代理 503（无 secret）/ 401/403 → 切 B；两路皆失败 / 无活跃 → []（不抛错）
 * `?mockTyphoon=1` → 固定「灿都」mock，便于离线验收
 */

import { writable } from 'svelte/store';

/** 非官方上游（失效可换）；仅 Pages Function / 服务端应直连 */
export const UNOFFICIAL_TYPHOON_UPSTREAM = 'https://typhoon.slt.zj.gov.cn/Api';

/** 浏览器侧代理前缀（Vite proxy 或 Cloudflare Pages Function） */
export const TYPHOON_PROXY_BASE = '/api/typhoon';

export interface TrackPoint {
  time: number;
  lat: number;
  lon: number;
  windKts: number;
  pressure: number;
  levelZh: string;
}

export interface WindQuadrants {
  ne: number;
  se: number;
  sw: number;
  nw: number;
}

export interface Typhoon {
  id: string;
  name: string;
  enName: string;
  current: {
    lat: number;
    lon: number;
    windKts: number;
    pressure: number;
    levelZh: string;
  };
  track: {
    past: TrackPoint[];
    forecast: TrackPoint[];
    cone?: [number, number][];
  };
  /** 7/10 级风圈（km）；provider 有则填，渲染侧无则跳过 */
  windRadiiKm?: {
    r7?: WindQuadrants;
    r10?: WindQuadrants;
  };
}

export interface TyphoonProvider {
  readonly id: string;
  fetchActive(): Promise<Typhoon[]>;
}

/** 强度色阶：热带低压 → 超强台风（气象惯例） */
export const TYPHOON_LEVEL_COLORS: Record<string, string> = {
  热带低压: '#5b8def',
  热带风暴: '#3ecf8e',
  强热带风暴: '#f0d060',
  台风: '#f5a623',
  强台风: '#e85d4c',
  超强台风: '#d946ef',
};

export const TYPHOON_LEVEL_ORDER = [
  '热带低压',
  '热带风暴',
  '强热带风暴',
  '台风',
  '强台风',
  '超强台风',
] as const;

/** 切换器入口：无活跃台风时 50% 透明度 */
export const activeTyphoonCount = writable(0);

const MS_PER_KT = 1.943844;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = 'serein:typhoons:active';
const FETCH_TIMEOUT_MS = 8_000;

type CacheEnvelope = { fetchedAt: number; data: Typhoon[] };

let qweatherDisabled = false;
let inFlight: Promise<Typhoon[]> | null = null;

/** 同源和风代理前缀（密钥仅在 server/.env） */
const QWEATHER_PROXY_BASE = '/api/qweather';

/** @deprecated 密钥已迁至服务端；未禁用时视为可尝试实现 A */
export function isQweatherTyphoonConfigured(): boolean {
  return !qweatherDisabled;
}

function isMockTyphoonForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('mockTyphoon') === '1';
  } catch {
    return false;
  }
}

function toEpochSec(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value / 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const ms = Date.parse(normalized);
    if (Number.isFinite(ms)) return Math.round(ms / 1000);
    const msCn = Date.parse(normalized + '+08:00');
    if (Number.isFinite(msCn)) return Math.round(msCn / 1000);
  }
  return Math.round(Date.now() / 1000);
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** m/s → knots */
export function msToKts(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.round(ms * MS_PER_KT);
}

/** 和风 type 码 / 中文强度 → 标准中文等级 */
export function normalizeLevelZh(raw: string | undefined | null, windKts = 0): string {
  const s = (raw ?? '').trim();
  if (!s) return levelFromWindKts(windKts);
  if (/超强/.test(s) || /^SuperTY$/i.test(s)) return '超强台风';
  if (/强台风/.test(s) || /^STY$/i.test(s)) return '强台风';
  if (/强热带风暴/.test(s) || /^STS$/i.test(s)) return '强热带风暴';
  if (/热带风暴/.test(s) || /^TS$/i.test(s)) return '热带风暴';
  if (/热带低压/.test(s) || /^TD$/i.test(s)) return '热带低压';
  if (/^台风$/.test(s) || /^TY$/i.test(s)) return '台风';
  if (TYPHOON_LEVEL_COLORS[s]) return s;
  return levelFromWindKts(windKts);
}

/** CMA 近中心风速阈值（kt） */
export function levelFromWindKts(windKts: number): string {
  if (windKts >= 100) return '超强台风';
  if (windKts >= 81) return '强台风';
  if (windKts >= 64) return '台风';
  if (windKts >= 48) return '强热带风暴';
  if (windKts >= 34) return '热带风暴';
  return '热带低压';
}

export function colorForLevel(levelZh: string): string {
  return TYPHOON_LEVEL_COLORS[levelZh] ?? TYPHOON_LEVEL_COLORS['热带低压']!;
}

/** 解析 "NE|SE|SW|NW" 或单值（km） */
export function parseWindQuadrants(raw: unknown): WindQuadrants | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { ne: raw, se: raw, sw: raw, nw: raw };
  }
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t === 'null') return undefined;
  if (t.includes('|')) {
    const parts = t.split('|').map((p) => Number(p.trim()));
    if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
    const [ne, se, sw, nw] = parts;
    if (ne <= 0 && se <= 0 && sw <= 0 && nw <= 0) return undefined;
    return { ne: ne || 0, se: se || 0, sw: sw || 0, nw: nw || 0 };
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return { ne: n, se: n, sw: n, nw: n };
}

function readCache(): Typhoon[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCache(data: Typhoon[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const envelope: CacheEnvelope = { fetchedAt: Date.now(), data };
    localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // quota / private mode
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: unknown }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: abort.signal });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Mock（灿都 · 强台风）──────────────────────────────────────────

/** 验收用：西北太平洋「灿都」路径 + 概率锥 + 风圈 */
export function mockTyphoon(now = Date.now()): Typhoon {
  const t0 = Math.round(now / 1000) - 36 * 3600;
  const past: TrackPoint[] = [];
  for (let i = 0; i <= 12; i += 1) {
    const frac = i / 12;
    const windKts = Math.round(45 + frac * 40);
    past.push({
      time: t0 + i * 3 * 3600,
      lat: 16 + frac * 8,
      lon: 142 - frac * 12,
      windKts,
      pressure: Math.round(1000 - frac * 45),
      levelZh: levelFromWindKts(windKts),
    });
  }
  const cur = past[past.length - 1]!;
  const forecast: TrackPoint[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const windKts = Math.max(40, cur.windKts - i * 6);
    forecast.push({
      time: cur.time + i * 6 * 3600,
      lat: cur.lat + i * 1.2,
      lon: cur.lon - i * 1.8,
      windKts,
      pressure: Math.min(1005, cur.pressure + i * 5),
      levelZh: levelFromWindKts(windKts),
    });
  }
  // 简易概率锥（绕预报路径的喇叭形）
  const cone: [number, number][] = [];
  const spine = [cur, ...forecast];
  for (let i = 0; i < spine.length; i += 1) {
    const p = spine[i]!;
    const spread = 0.4 + i * 0.55;
    cone.push([p.lon, p.lat + spread * 0.6]);
  }
  for (let i = spine.length - 1; i >= 0; i -= 1) {
    const p = spine[i]!;
    const spread = 0.4 + i * 0.55;
    cone.push([p.lon, p.lat - spread * 0.6]);
  }
  return {
    id: 'mock-chandu-2024',
    name: '灿都',
    enName: 'Chanthu',
    current: {
      lat: cur.lat,
      lon: cur.lon,
      windKts: cur.windKts,
      pressure: cur.pressure,
      levelZh: cur.levelZh,
    },
    track: { past, forecast, cone },
    windRadiiKm: {
      r7: { ne: 280, se: 260, sw: 240, nw: 270 },
      r10: { ne: 120, se: 110, sw: 100, nw: 115 },
    },
  };
}

export const mockTyphoonProvider: TyphoonProvider = {
  id: 'mock',
  async fetchActive(): Promise<Typhoon[]> {
    return [mockTyphoon()];
  },
};

// ─── 实现 A：和风 ──────────────────────────────────────────────────

type QwStormListItem = {
  id?: string;
  name?: string;
  basin?: string;
  year?: string;
  isActive?: string | number;
};

type QwWindRadius = {
  neRadius?: string | number;
  seRadius?: string | number;
  swRadius?: string | number;
  nwRadius?: string | number;
};

type QwTrackPoint = {
  time?: string;
  lat?: string | number;
  lon?: string | number;
  type?: string;
  pressure?: string | number;
  windSpeed?: string | number;
  windRadius30?: QwWindRadius | null;
  windRadius50?: QwWindRadius | null;
};

type QwForecastPoint = {
  fxTime?: string;
  lat?: string | number;
  lon?: string | number;
  type?: string;
  pressure?: string | number;
  windSpeed?: string | number;
};

function qwRadiusToQuadrants(raw: QwWindRadius | null | undefined): WindQuadrants | undefined {
  if (!raw) return undefined;
  const ne = num(raw.neRadius);
  const se = num(raw.seRadius);
  const sw = num(raw.swRadius);
  const nw = num(raw.nwRadius);
  if (ne <= 0 && se <= 0 && sw <= 0 && nw <= 0) return undefined;
  return { ne, se, sw, nw };
}

function mapQwPoint(raw: QwTrackPoint | QwForecastPoint, timeField: 'time' | 'fxTime'): TrackPoint | null {
  const lat = num((raw as QwTrackPoint).lat);
  const lon = num((raw as QwTrackPoint).lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  const windMs = num((raw as QwTrackPoint).windSpeed);
  const windKts = msToKts(windMs);
  const type = (raw as QwTrackPoint).type;
  const timeRaw =
    timeField === 'fxTime'
      ? (raw as QwForecastPoint).fxTime
      : (raw as QwTrackPoint).time;
  return {
    time: toEpochSec(timeRaw),
    lat,
    lon,
    windKts,
    pressure: num((raw as QwTrackPoint).pressure, 1010),
    levelZh: normalizeLevelZh(type, windKts),
  };
}

async function fetchQweatherStorm(storm: QwStormListItem): Promise<Typhoon | null> {
  const id = typeof storm.id === 'string' ? storm.id : '';
  if (!id) return null;
  const headers = { Accept: 'application/json' };

  const trackRes = await fetchJson(
    `${QWEATHER_PROXY_BASE}/v7/tropical/storm-track?stormid=${encodeURIComponent(id)}&lang=zh`,
    { headers },
  );
  if (trackRes.status === 503 || trackRes.status === 401 || trackRes.status === 403) {
    qweatherDisabled = true;
    return null;
  }
  if (!trackRes.ok || !trackRes.json) return null;

  const trackRoot = trackRes.json as {
    code?: string | number;
    isActive?: string | number;
    now?: QwTrackPoint | null;
    track?: QwTrackPoint[] | null;
  };
  const code = trackRoot.code != null ? String(trackRoot.code) : '';
  if (code === '401' || code === '403') {
    qweatherDisabled = true;
    return null;
  }
  if (code && code !== '200') return null;

  const past: TrackPoint[] = [];
  for (const raw of trackRoot.track ?? []) {
    const pt = mapQwPoint(raw, 'time');
    if (pt) past.push(pt);
  }
  past.sort((a, b) => a.time - b.time);

  let forecast: TrackPoint[] = [];
  if (!qweatherDisabled) {
    const fxRes = await fetchJson(
      `${QWEATHER_PROXY_BASE}/v7/tropical/storm-forecast?stormid=${encodeURIComponent(id)}&lang=zh`,
      { headers },
    );
    if (fxRes.status === 503 || fxRes.status === 401 || fxRes.status === 403) {
      qweatherDisabled = true;
    } else if (fxRes.ok && fxRes.json) {
      const fxRoot = fxRes.json as {
        code?: string | number;
        forecast?: QwForecastPoint[] | null;
      };
      const fxCode = fxRoot.code != null ? String(fxRoot.code) : '';
      if (fxCode === '401' || fxCode === '403') {
        qweatherDisabled = true;
      } else if (!fxCode || fxCode === '200') {
        for (const raw of fxRoot.forecast ?? []) {
          const pt = mapQwPoint(raw, 'fxTime');
          if (pt) forecast.push(pt);
        }
        forecast.sort((a, b) => a.time - b.time);
      }
    }
  }

  const now = trackRoot.now;
  let current: Typhoon['current'];
  let windRadiiKm: Typhoon['windRadiiKm'];
  if (now && num(now.lat) !== 0) {
    const windKts = msToKts(num(now.windSpeed));
    current = {
      lat: num(now.lat),
      lon: num(now.lon),
      windKts,
      pressure: num(now.pressure, 1010),
      levelZh: normalizeLevelZh(now.type, windKts),
    };
    const r7 = qwRadiusToQuadrants(now.windRadius30);
    const r10 = qwRadiusToQuadrants(now.windRadius50);
    if (r7 || r10) windRadiiKm = { r7, r10 };
  } else if (past.length > 0) {
    const last = past[past.length - 1]!;
    current = {
      lat: last.lat,
      lon: last.lon,
      windKts: last.windKts,
      pressure: last.pressure,
      levelZh: last.levelZh,
    };
  } else {
    return null;
  }

  const enName = typeof storm.name === 'string' ? storm.name : id;
  // 和风 list 名多为英文；中文名优先用等级标签场景里的 name，无则回退英文
  const name = enName;

  return {
    id,
    name,
    enName,
    current,
    track: { past, forecast },
    windRadiiKm,
  };
}

async function fetchQweatherActive(): Promise<Typhoon[] | 'auth' | 'skip' | 'fail'> {
  if (qweatherDisabled) return 'skip';

  const year = new Date().getFullYear();
  const listUrl = `${QWEATHER_PROXY_BASE}/v7/tropical/storm-list?basin=NP&year=${year}&lang=zh`;

  const listRes = await fetchJson(listUrl, {
    headers: { Accept: 'application/json' },
  });

  if (listRes.status === 503 || listRes.status === 401 || listRes.status === 403) {
    qweatherDisabled = true;
    return 'auth';
  }
  if (!listRes.ok || !listRes.json) return 'fail';

  const root = listRes.json as {
    code?: string | number;
    storm?: QwStormListItem[] | null;
  };
  const code = root.code != null ? String(root.code) : '';
  if (code === '401' || code === '403') {
    qweatherDisabled = true;
    return 'auth';
  }
  // 204 = 无台风（合法空态，不再降级）
  if (code === '204') return [];
  if (code && code !== '200') return 'fail';

  const storms = (root.storm ?? []).filter((s) => String(s.isActive) === '1');
  if (storms.length === 0) return [];

  const results: Typhoon[] = [];
  for (const storm of storms) {
    if (qweatherDisabled) return 'auth';
    const mapped = await fetchQweatherStorm(storm);
    if (mapped) results.push(mapped);
  }
  return results;
}

export const qweatherTyphoonProvider: TyphoonProvider = {
  id: 'qweather',
  async fetchActive(): Promise<Typhoon[]> {
    const result = await fetchQweatherActive();
    return Array.isArray(result) ? result : [];
  },
};

// ─── 实现 B：非官方公开源（经代理）────────────────────────────────

type ZjActivityItem = {
  tfid?: string;
  name?: string;
  enname?: string;
  lat?: string | number;
  lng?: string | number;
  speed?: string | number;
  pressure?: string | number;
  strong?: string;
  radius7?: string | number | null;
  radius10?: string | number | null;
  time?: string;
};

type ZjForecastPoint = {
  time?: string;
  lat?: string | number;
  lng?: string | number;
  strong?: string;
  speed?: string | number;
  pressure?: string | number;
};

type ZjPoint = {
  time?: string;
  lat?: string | number;
  lng?: string | number;
  strong?: string;
  speed?: string | number;
  pressure?: string | number;
  radius7?: string | number | null;
  radius10?: string | number | null;
  forecast?: Array<{ tm?: string; forecastpoints?: ZjForecastPoint[] }> | null;
};

type ZjInfo = {
  tfid?: string;
  name?: string;
  enname?: string;
  isactive?: string | number;
  points?: ZjPoint[] | null;
};

function mapZjPoint(raw: ZjPoint | ZjForecastPoint): TrackPoint | null {
  const lat = num(raw.lat);
  const lon = num((raw as ZjPoint).lng ?? (raw as { lon?: unknown }).lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const windKts = msToKts(num(raw.speed));
  return {
    time: toEpochSec(raw.time),
    lat,
    lon,
    windKts,
    pressure: num(raw.pressure, 1010),
    levelZh: normalizeLevelZh(raw.strong, windKts),
  };
}

/** 用多机构预报点做简易凸包概率锥（经度, 纬度） */
export function buildForecastCone(points: Array<{ lat: number; lon: number }>): [number, number][] | undefined {
  if (points.length < 3) return undefined;
  const unique = new Map<string, [number, number]>();
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    unique.set(`${p.lon.toFixed(3)},${p.lat.toFixed(3)}`, [p.lon, p.lat]);
  }
  const pts = [...unique.values()];
  if (pts.length < 3) return undefined;

  // Andrew's monotone chain
  pts.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : undefined;
}

function mapZjInfo(info: ZjInfo, activity?: ZjActivityItem): Typhoon | null {
  const id = typeof info.tfid === 'string' ? info.tfid : activity?.tfid;
  if (!id) return null;
  const points = Array.isArray(info.points) ? info.points : [];
  const past: TrackPoint[] = [];
  const coneSeeds: Array<{ lat: number; lon: number }> = [];
  let forecast: TrackPoint[] = [];

  for (const raw of points) {
    const pt = mapZjPoint(raw);
    if (pt) past.push(pt);
  }
  past.sort((a, b) => a.time - b.time);

  const lastRaw = points.length > 0 ? points[points.length - 1] : null;
  if (lastRaw?.forecast && Array.isArray(lastRaw.forecast)) {
    // 优先中国台预报作主预报线；其余机构点入锥
    const cn = lastRaw.forecast.find((f) => f.tm === '中国') ?? lastRaw.forecast[0];
    if (cn?.forecastpoints) {
      for (const fp of cn.forecastpoints) {
        const pt = mapZjPoint(fp);
        if (pt) forecast.push(pt);
      }
    }
    for (const agency of lastRaw.forecast) {
      for (const fp of agency.forecastpoints ?? []) {
        const lat = num(fp.lat);
        const lon = num(fp.lng);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          coneSeeds.push({ lat, lon });
        }
      }
    }
  }
  forecast.sort((a, b) => a.time - b.time);
  if (past.length > 0) {
    const last = past[past.length - 1]!;
    coneSeeds.push({ lat: last.lat, lon: last.lon });
  }

  let current: Typhoon['current'];
  let windRadiiKm: Typhoon['windRadiiKm'];

  if (activity && num(activity.lat) !== 0) {
    const windKts = msToKts(num(activity.speed));
    current = {
      lat: num(activity.lat),
      lon: num(activity.lng),
      windKts,
      pressure: num(activity.pressure, 1010),
      levelZh: normalizeLevelZh(activity.strong, windKts),
    };
    const r7 = parseWindQuadrants(activity.radius7);
    const r10 = parseWindQuadrants(activity.radius10);
    if (r7 || r10) windRadiiKm = { r7, r10 };
  } else if (past.length > 0) {
    const last = past[past.length - 1]!;
    current = {
      lat: last.lat,
      lon: last.lon,
      windKts: last.windKts,
      pressure: last.pressure,
      levelZh: last.levelZh,
    };
    if (lastRaw) {
      const r7 = parseWindQuadrants(lastRaw.radius7);
      const r10 = parseWindQuadrants(lastRaw.radius10);
      if (r7 || r10) windRadiiKm = { r7, r10 };
    }
  } else {
    return null;
  }

  const name =
    (typeof info.name === 'string' && info.name) ||
    (typeof activity?.name === 'string' && activity.name) ||
    id;
  const enName =
    (typeof info.enname === 'string' && info.enname) ||
    (typeof activity?.enname === 'string' && activity.enname) ||
    name;

  return {
    id,
    name,
    enName,
    current,
    track: {
      past,
      forecast,
      cone: buildForecastCone(coneSeeds),
    },
    windRadiiKm,
  };
}

async function fetchUnofficialActive(): Promise<Typhoon[]> {
  const listRes = await fetchJson(`${TYPHOON_PROXY_BASE}/TyhoonActivity`);
  if (!listRes.ok || !listRes.json) return [];

  const list = Array.isArray(listRes.json) ? (listRes.json as ZjActivityItem[]) : [];
  if (list.length === 0) return [];

  const results: Typhoon[] = [];
  for (const item of list) {
    const tfid = typeof item.tfid === 'string' ? item.tfid : '';
    if (!tfid) continue;
    const infoRes = await fetchJson(`${TYPHOON_PROXY_BASE}/TyphoonInfo/${encodeURIComponent(tfid)}`);
    if (!infoRes.ok || !infoRes.json) {
      // 详情失败时仍用列表粗数据兜底一条
      const windKts = msToKts(num(item.speed));
      if (num(item.lat) === 0 && num(item.lng) === 0) continue;
      results.push({
        id: tfid,
        name: item.name || tfid,
        enName: item.enname || item.name || tfid,
        current: {
          lat: num(item.lat),
          lon: num(item.lng),
          windKts,
          pressure: num(item.pressure, 1010),
          levelZh: normalizeLevelZh(item.strong, windKts),
        },
        track: {
          past: [
            {
              time: toEpochSec(item.time),
              lat: num(item.lat),
              lon: num(item.lng),
              windKts,
              pressure: num(item.pressure, 1010),
              levelZh: normalizeLevelZh(item.strong, windKts),
            },
          ],
          forecast: [],
        },
        windRadiiKm: {
          r7: parseWindQuadrants(item.radius7),
          r10: parseWindQuadrants(item.radius10),
        },
      });
      continue;
    }
    const mapped = mapZjInfo(infoRes.json as ZjInfo, item);
    if (mapped) results.push(mapped);
  }
  return results;
}

export const unofficialTyphoonProvider: TyphoonProvider = {
  id: 'unofficial',
  fetchActive: fetchUnofficialActive,
};

// ─── 编排 ──────────────────────────────────────────────────────────

/**
 * 拉取活跃台风（西北太平洋）。
 * - `?mockTyphoon=1` → mock
 * - 和风代理可用则优先；503 / 401/403 → 非官方代理
 * - 皆失败 → []，不抛错
 */
export async function fetchActiveTyphoons(provider?: TyphoonProvider | null): Promise<Typhoon[]> {
  if (provider) {
    try {
      const data = await provider.fetchActive();
      activeTyphoonCount.set(data.length);
      return data;
    } catch {
      activeTyphoonCount.set(0);
      return [];
    }
  }

  if (isMockTyphoonForced()) {
    const data = await mockTyphoonProvider.fetchActive();
    activeTyphoonCount.set(data.length);
    return data;
  }

  const cached = readCache();
  if (cached) {
    activeTyphoonCount.set(cached.length);
    return cached;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // A：和风同源代理（skip/auth/fail → B；合法 [] 直接返回）
      if (!qweatherDisabled) {
        const qw = await fetchQweatherActive();
        if (Array.isArray(qw)) {
          writeCache(qw);
          activeTyphoonCount.set(qw.length);
          return qw;
        }
        // 'auth' | 'skip' | 'fail' → 实现 B
      }

      // B：非官方代理
      const unofficial = await fetchUnofficialActive();
      writeCache(unofficial);
      activeTyphoonCount.set(unofficial.length);
      return unofficial;
    } catch {
      activeTyphoonCount.set(0);
      return [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** 测试辅助：重置会话级状态 */
export function resetTyphoonProviderState(): void {
  qweatherDisabled = false;
  inFlight = null;
  activeTyphoonCount.set(0);
}
