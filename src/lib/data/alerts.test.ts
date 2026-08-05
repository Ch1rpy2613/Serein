import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CITY } from '../contracts';
import {
  dayPrecipProbability,
  dismissAlert,
  fetchWeatherAlerts,
  filterVisibleAlerts,
  isAlertDismissed,
  mockAlertProvider,
  mockRedAlert,
  parseAlertLevel,
  parseAlertType,
  resetAlertProviderState,
  thunderstormTier,
} from './alerts';

function installMemoryLocalStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } satisfies Storage);
}

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  resetAlertProviderState();
  vi.unstubAllGlobals();
});

describe('parseAlertLevel', () => {
  it('parses 蓝/黄/橙/红 from title', () => {
    expect(parseAlertLevel('大风蓝色预警')).toBe('blue');
    expect(parseAlertLevel('暴雨黄色预警')).toBe('yellow');
    expect(parseAlertLevel('高温橙色预警')).toBe('orange');
    expect(parseAlertLevel('暴雨红色预警')).toBe('red');
  });

  it('defaults to yellow when level word missing', () => {
    expect(parseAlertLevel('气象台发布大风预警')).toBe('yellow');
  });
});

describe('parseAlertType', () => {
  it('extracts type token from title', () => {
    expect(parseAlertType('天津市气象台发布暴雨红色预警')).toBe('暴雨');
    expect(parseAlertType('雷电黄色预警信号')).toBe('雷电');
  });
});

describe('thunderstormTier (CAPE bands)', () => {
  it('maps three sample CAPE days to expected tiers', () => {
    // 抽 3「天」代表性 CAPE：稳定日 / 雷暴日 / 极端日
    expect(thunderstormTier(120)).toBe('弱'); // <400
    expect(thunderstormTier(720)).toBe('中'); // 400–1000
    expect(thunderstormTier(1800)).toBe('强'); // 1000–2500
  });

  it('boundary edges', () => {
    expect(thunderstormTier(399)).toBe('弱');
    expect(thunderstormTier(400)).toBe('中');
    expect(thunderstormTier(999)).toBe('中');
    expect(thunderstormTier(1000)).toBe('强');
    expect(thunderstormTier(2499)).toBe('强');
    expect(thunderstormTier(2500)).toBe('极强');
    expect(thunderstormTier(4200)).toBe('极强');
  });
});

describe('dayPrecipProbability', () => {
  it('counts wet hours excluding the 24:00 point', () => {
    const precip = Array.from({ length: 25 }, (_, i) => (i < 6 ? 1.2 : 0));
    expect(dayPrecipProbability(precip)).toBe(25); // 6/24
  });
});

describe('mock red alert + dismiss', () => {
  it('mock provider returns one red alert', async () => {
    const alerts = await fetchWeatherAlerts(DEFAULT_CITY, mockAlertProvider);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.level).toBe('red');
    expect(alerts[0]!.title).toContain('红色');
    expect(alerts[0]!.text.length).toBeGreaterThan(20);
  });

  it('dismiss hides alert for 24h', () => {
    const alert = mockRedAlert();
    expect(filterVisibleAlerts([alert])).toHaveLength(1);
    dismissAlert(alert.id);
    expect(isAlertDismissed(alert.id)).toBe(true);
    expect(filterVisibleAlerts([alert])).toHaveLength(0);
  });
});

describe('silent disable without credentials', () => {
  it('returns [] with null provider and never fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const alerts = await fetchWeatherAlerts(DEFAULT_CITY, null);
    expect(alerts).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
