import { get, writable } from 'svelte/store';
import { DEFAULT_CITY, type City } from '../contracts';

const SAVED_CITIES_KEY = 'serein:saved-cities';
const CURRENT_CITY_KEY = 'serein:current-city';

/** 城市时区下的今日 ISO 日期 YYYY-MM-DD */
export function todayIso(city: City = DEFAULT_CITY, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: city.tz,
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

export function sameCity(a: City, b: City): boolean {
  return (
    a.name === b.name &&
    Math.abs(a.lat - b.lat) < 1e-4 &&
    Math.abs(a.lon - b.lon) < 1e-4
  );
}

/** 天津保底城市（不可删除） */
export function isProtectedCity(city: City): boolean {
  return city.name === DEFAULT_CITY.name || sameCity(city, DEFAULT_CITY);
}

export function isValidCity(value: unknown): value is City {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.name === 'string' &&
    c.name.length > 0 &&
    typeof c.lat === 'number' &&
    Number.isFinite(c.lat) &&
    typeof c.lon === 'number' &&
    Number.isFinite(c.lon) &&
    typeof c.tz === 'string' &&
    c.tz.length > 0
  );
}

export function ensureTianjin(list: City[]): City[] {
  if (list.some(isProtectedCity)) return list;
  return [DEFAULT_CITY, ...list];
}

function readSavedCities(): City[] {
  if (typeof localStorage === 'undefined') return [DEFAULT_CITY];
  try {
    const raw = localStorage.getItem(SAVED_CITIES_KEY);
    if (!raw) return [DEFAULT_CITY];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [DEFAULT_CITY];
    const cities = parsed.filter(isValidCity);
    return ensureTianjin(cities.length > 0 ? cities : [DEFAULT_CITY]);
  } catch {
    return [DEFAULT_CITY];
  }
}

function readCurrentCity(fallbackList: City[]): City {
  if (typeof localStorage === 'undefined') return DEFAULT_CITY;
  try {
    const raw = localStorage.getItem(CURRENT_CITY_KEY);
    if (!raw) return fallbackList[0] ?? DEFAULT_CITY;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidCity(parsed)) return fallbackList[0] ?? DEFAULT_CITY;
    const match = fallbackList.find((c) => sameCity(c, parsed));
    return match ?? parsed;
  } catch {
    return fallbackList[0] ?? DEFAULT_CITY;
  }
}

function persistSavedCities(cities: City[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SAVED_CITIES_KEY, JSON.stringify(cities));
  } catch {
    // quota / private mode
  }
}

function persistCurrentCity(city: City): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CURRENT_CITY_KEY, JSON.stringify(city));
  } catch {
    // quota / private mode
  }
}

const initialSaved = readSavedCities();
const initialCurrent = readCurrentCity(initialSaved);

/** 体感 feel / 分析 analysis */
export const appMode = writable<'feel' | 'analysis'>('feel');
/** 当前分析/展示日期，ISO YYYY-MM-DD（相对当前城市时区） */
export const currentDate = writable<string>(todayIso(initialCurrent));
/** 当前城市（默认天津） */
export const currentCity = writable<City>(initialCurrent);
/** 已存城市列表（localStorage 持久化，至少含天津） */
export const savedCities = writable<City[]>(initialSaved);

if (typeof window !== 'undefined') {
  currentCity.subscribe((city) => {
    persistCurrentCity(city);
  });
  savedCities.subscribe((cities) => {
    persistSavedCities(ensureTianjin(cities));
  });
}

/** 选中城市：写入 currentCity，若不在已存列表则追加 */
export function selectCity(city: City): void {
  currentCity.set(city);
  savedCities.update((list) => {
    if (list.some((c) => sameCity(c, city))) return list;
    return ensureTianjin([...list, city]);
  });
}

/** 删除已存城市；天津与最后一座不可删；若删的是当前则切到天津 */
export function removeSavedCity(city: City): boolean {
  if (isProtectedCity(city)) return false;
  const list = get(savedCities);
  if (list.length <= 1) return false;
  const next = list.filter((c) => !sameCity(c, city));
  if (next.length === 0) return false;
  const ensured = ensureTianjin(next);
  savedCities.set(ensured);
  if (sameCity(get(currentCity), city)) {
    currentCity.set(ensured.find(isProtectedCity) ?? ensured[0] ?? DEFAULT_CITY);
  }
  return true;
}
