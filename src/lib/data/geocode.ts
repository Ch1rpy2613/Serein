import type { City } from '../contracts';

export interface GeocodeResult extends City {
  /** 省 / 一级行政区（可空） */
  admin1: string | null;
  /** 国家名（可空） */
  country: string | null;
  /** 列表副标题：省/国 */
  subtitle: string;
}

type GeocodeApiItem = {
  name?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  admin1?: string;
  country?: string;
  country_code?: string;
};

const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FETCH_TIMEOUT_MS = 8000;

function subtitleOf(item: GeocodeApiItem): string {
  const parts = [item.admin1, item.country].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.join(' · ');
}

function toResult(item: GeocodeApiItem): GeocodeResult | null {
  if (
    typeof item.name !== 'string' ||
    !item.name ||
    typeof item.latitude !== 'number' ||
    typeof item.longitude !== 'number'
  ) {
    return null;
  }
  return {
    name: item.name,
    lat: item.latitude,
    lon: item.longitude,
    tz: typeof item.timezone === 'string' && item.timezone ? item.timezone : 'Asia/Shanghai',
    admin1: typeof item.admin1 === 'string' ? item.admin1 : null,
    country: typeof item.country === 'string' ? item.country : null,
    subtitle: subtitleOf(item),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Open-Meteo Geocoding：按名称搜索城市（language=zh） */
export async function searchCities(name: string, count = 8): Promise<GeocodeResult[]> {
  const query = name.trim();
  if (!query) return [];
  const params = new URLSearchParams({
    name: query,
    count: String(count),
    language: 'zh',
    format: 'json',
  });
  const json = await fetchJson<{ results?: GeocodeApiItem[] }>(`${SEARCH_URL}?${params}`);
  return (json.results ?? []).map(toResult).filter((r): r is GeocodeResult => r !== null);
}

/**
 * 定位坐标 → City。
 * Open-Meteo Geocoding 无稳定 reverse 端点；用浏览器时区 +「当前位置」占位名。
 */
export function cityFromGeolocation(lat: number, lon: number): City {
  let tz = 'Asia/Shanghai';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch {
    // keep default
  }
  return { name: '当前位置', lat, lon, tz };
}

/** 将 GeocodeResult 收成 City 契约 */
export function toCity(result: GeocodeResult): City {
  return {
    name: result.name,
    lat: result.lat,
    lon: result.lon,
    tz: result.tz,
  };
}
