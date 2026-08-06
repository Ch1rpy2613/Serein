import { writable } from 'svelte/store';
import { DEFAULT_CITY, type City, type WeatherAlert } from '../contracts';

/** 横幅占位高度（px）；App 据此上移场景切换器 / 静音钮 */
export const alertBannerOffset = writable(0);

export const ALERT_LEVEL_COLORS: Record<WeatherAlert['level'], string> = {
  blue: '#3b82f6',
  yellow: '#facc15',
  orange: '#fb923c',
  red: '#ef4444',
};

export type ThunderstormTier = '弱' | '中' | '强' | '极强';

/** AlertProvider：可替换数据源（和风 / mock / 未来其它源） */
export interface AlertProvider {
  readonly id: string;
  fetchAlerts(city: City): Promise<WeatherAlert[]>;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
const DISMISS_PREFIX = 'serein:alert-dismissed:';
const CACHE_PREFIX = 'serein:alerts:';

type CacheEnvelope = {
  fetchedAt: number;
  data: WeatherAlert[];
};

const inFlight = new Map<string, Promise<WeatherAlert[]>>();

/**
 * 同源代理 `/api/qweather` 在 503（服务端无 secret）/ 401 / 403 后静默禁用，
 * 本会话不再打网络。密钥只存在于 server/.env，前端 bundle 不含 key。
 */
let providerDisabled = false;

/** @deprecated 密钥已迁至服务端；保留导出以免测试/调用方断裂。始终为 true（未禁用时）。 */
export function isAlertProviderConfigured(): boolean {
  return !providerDisabled;
}

function isMockAlertsForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('mockAlerts') === '1';
  } catch {
    return false;
  }
}

/** 从标题解析级别（蓝/黄/橙/红）；缺省 yellow */
export function parseAlertLevel(title: string): WeatherAlert['level'] {
  if (/红/.test(title)) return 'red';
  if (/橙/.test(title)) return 'orange';
  if (/黄/.test(title)) return 'yellow';
  if (/蓝/.test(title)) return 'blue';
  return 'yellow';
}

/** 从标题粗提类型名 */
export function parseAlertType(title: string, fallback = '预警'): string {
  const m = title.match(
    /(暴雨|暴雪|寒潮|大风|沙尘暴|陆地大风|雷电|冰雹|霜冻|大雾|霾|道路结冰|干旱|高温|森林火险|雷雨大风|台风|龙卷风)/,
  );
  return m?.[1] ?? fallback;
}

function toEpochSec(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value / 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.round(ms / 1000);
  }
  return Math.round(Date.now() / 1000);
}

type QwWarningRaw = {
  id?: string;
  title?: string;
  typeName?: string;
  type?: string;
  text?: string;
  pubTime?: string | number;
  level?: string;
};

function mapQweatherWarning(raw: QwWarningRaw, index: number): WeatherAlert | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  const id =
    typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : `qw-${index}-${title.slice(0, 24)}`;
  const typeName =
    typeof raw.typeName === 'string' && raw.typeName.length > 0
      ? raw.typeName
      : parseAlertType(title);
  return {
    id,
    title,
    type: typeName,
    level: parseAlertLevel(title),
    text: typeof raw.text === 'string' ? raw.text : '',
    pubTime: toEpochSec(raw.pubTime),
  };
}

/** 验收用：红色暴雨预警 */
export function mockRedAlert(now = Date.now()): WeatherAlert {
  return {
    id: 'mock-red-rain-001',
    title: '天津市气象台发布暴雨红色预警',
    type: '暴雨',
    level: 'red',
    text:
      '天津市气象台发布暴雨红色预警信号：预计未来 3 小时本市部分地区降雨量将达 100 毫米以上，局地可超过 150 毫米，并伴有雷电和短时强降水。\n\n防御指南：\n1. 政府及相关部门按照职责做好防暴雨应急和抢险工作。\n2. 停止集会、停课、停业（除特殊行业外）。\n3. 做好山洪、滑坡、泥石流等灾害的防御和抢险工作。',
    pubTime: Math.round(now / 1000),
  };
}

function cacheKey(city: City): string {
  return `${CACHE_PREFIX}${city.name}`;
}

function readAlertCache(city: City): WeatherAlert[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey(city));
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

function writeAlertCache(city: City, data: WeatherAlert[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const envelope: CacheEnvelope = { fetchedAt: Date.now(), data };
    localStorage.setItem(cacheKey(city), JSON.stringify(envelope));
  } catch {
    // quota / private mode
  }
}

function dismissKey(id: string): string {
  return `${DISMISS_PREFIX}${id}`;
}

export function isAlertDismissed(id: string, now = Date.now()): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(dismissKey(id));
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    if (now - at > DISMISS_TTL_MS) {
      localStorage.removeItem(dismissKey(id));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 24h 内同 id 不再出现 */
export function dismissAlert(id: string, now = Date.now()): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(dismissKey(id), String(now));
  } catch {
    // ignore
  }
}

export function filterVisibleAlerts(alerts: WeatherAlert[]): WeatherAlert[] {
  return alerts.filter((a) => !isAlertDismissed(a.id));
}

/** Badging API；不支持则静默跳过 */
export function syncAppBadge(count: number): void {
  if (typeof navigator === 'undefined') return;
  try {
    if (count > 0) {
      void navigator.setAppBadge?.(count);
    } else {
      void navigator.clearAppBadge?.();
    }
  } catch {
    // unsupported / denied
  }
}

/**
 * 雷暴潜势四档（纯 CAPE）：
 * 弱 <400 / 中 400–1000 / 强 1000–2500 / 极强 >2500
 */
export function thunderstormTier(cape: number): ThunderstormTier {
  if (!Number.isFinite(cape) || cape < 400) return '弱';
  if (cape < 1000) return '中';
  if (cape < 2500) return '强';
  return '极强';
}

/**
 * 当日降水概率 0–100：有可测降水小时占比（零 API，由 DayData.precipitation 推导）。
 * 索引 24 为日界线点，不计入分母。
 */
export function dayPrecipProbability(precipitation: number[]): number {
  if (!Array.isArray(precipitation) || precipitation.length === 0) return 0;
  const hours = precipitation.length > 1 ? precipitation.slice(0, -1) : precipitation;
  let wet = 0;
  for (const mm of hours) {
    if (Number.isFinite(mm) && mm > 0.1) wet += 1;
  }
  return Math.round((wet / hours.length) * 100);
}

async function fetchQweatherAlerts(city: City): Promise<WeatherAlert[]> {
  if (providerDisabled) return [];

  const location = `${city.lon.toFixed(2)},${city.lat.toFixed(2)}`;
  const url = `/api/qweather/v7/warning/now?location=${encodeURIComponent(location)}&lang=zh`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    return [];
  }

  // 503 = 服务端未配置 secret；401/403 = 上游鉴权失败 → 本会话静默禁用
  if (response.status === 503 || response.status === 401 || response.status === 403) {
    providerDisabled = true;
    return [];
  }

  if (!response.ok) return [];

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return [];
  }

  const root = json as {
    code?: string | number;
    warning?: QwWarningRaw[] | null;
  };

  const code = root.code != null ? String(root.code) : '';
  if (code === '401' || code === '403') {
    providerDisabled = true;
    return [];
  }
  // 204 = 无预警；200 = 有数据
  if (code && code !== '200' && code !== '204') return [];

  const list = Array.isArray(root.warning) ? root.warning : [];
  const mapped: WeatherAlert[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = mapQweatherWarning(list[i]!, i);
    if (item) mapped.push(item);
  }
  return mapped;
}

export const qweatherAlertProvider: AlertProvider = {
  id: 'qweather',
  fetchAlerts: fetchQweatherAlerts,
};

export const mockAlertProvider: AlertProvider = {
  id: 'mock',
  async fetchAlerts(_city: City): Promise<WeatherAlert[]> {
    return [mockRedAlert()];
  },
};

function activeProvider(): AlertProvider | null {
  if (isMockAlertsForced()) return mockAlertProvider;
  if (providerDisabled) return null;
  return qweatherAlertProvider;
}

/**
 * 拉取当前城市预警。
 * - 服务端无 secret（503）或 401/403 / 已禁用 → []，不抛错
 * - `?mockAlerts=1` → mock 红色预警
 * - 缓存 10 分钟（key 含城市名）
 */
export async function fetchWeatherAlerts(
  city: City = DEFAULT_CITY,
  provider?: AlertProvider | null,
): Promise<WeatherAlert[]> {
  const resolved = provider === undefined ? activeProvider() : provider;
  if (!resolved) return [];

  // mock 不走磁盘缓存，保证验收可重复
  if (resolved.id === 'mock') {
    return resolved.fetchAlerts(city);
  }

  const cached = readAlertCache(city);
  if (cached) return cached;

  const key = cacheKey(city);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = resolved
    .fetchAlerts(city)
    .then((alerts) => {
      writeAlertCache(city, alerts);
      return alerts;
    })
    .catch(() => [] as WeatherAlert[])
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** 测试辅助：重置会话级禁用标志 */
export function resetAlertProviderState(): void {
  providerDisabled = false;
  inFlight.clear();
}
