import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDaysIso,
  fxTimeToMinutes,
  haversineKm,
  mockTideData,
  normalizeTideResponse,
  resetTideProviderState,
  sampleTideHeight,
  tideStatusAt,
  toQweatherDate,
} from './tide';

describe('tide helpers', () => {
  beforeEach(() => {
    resetTideProviderState();
  });

  it('formats qweather date and adds calendar days', () => {
    expect(toQweatherDate('2026-08-06')).toBe('20260806');
    expect(addDaysIso('2026-08-06', 1)).toBe('2026-08-07');
    expect(addDaysIso('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('parses fxTime into local minutes for the target day', () => {
    expect(fxTimeToMinutes('2026-08-06T08:24+08:00', '2026-08-06')).toBe(8 * 60 + 24);
    expect(fxTimeToMinutes('2026-08-06T14:51+08:00', '2026-08-06')).toBe(14 * 60 + 51);
    expect(fxTimeToMinutes('2026-08-07T00:10+08:00', '2026-08-06')).toBeNull();
  });

  it('computes haversine distance', () => {
    // 天津市区 → 塘沽附近约 40–60 km
    const km = haversineKm(39.1, 117.2, 38.98, 117.7);
    expect(km).toBeGreaterThan(30);
    expect(km).toBeLessThan(80);
  });

  it('normalizes qweather tide payload', () => {
    const data = normalizeTideResponse(
      {
        code: '200',
        tideTable: [
          { fxTime: '2026-08-06T08:24+08:00', height: '3.20', type: 'H' },
          { fxTime: '2026-08-06T14:51+08:00', height: '0.80', type: 'L' },
        ],
        tideHourly: [
          { fxTime: '2026-08-06T00:00+08:00', height: '1.50' },
          { fxTime: '2026-08-06T01:00+08:00', height: '1.80' },
          { fxTime: '2026-08-06T08:00+08:00', height: '3.10' },
          { fxTime: '2026-08-06T15:00+08:00', height: '0.90' },
        ],
      },
      '2026-08-06',
    );
    expect(data).not.toBeNull();
    expect(data!.extrema).toEqual([
      { minutes: 8 * 60 + 24, type: 'high', heightM: 3.2 },
      { minutes: 14 * 60 + 51, type: 'low', heightM: 0.8 },
    ]);
    expect(data!.hourly[0]).toEqual({ minutes: 0, heightM: 1.5 });
    expect(data!.hourly).toHaveLength(4);
  });

  it('returns null for empty / error payloads', () => {
    expect(normalizeTideResponse({ code: '204' }, '2026-08-06')).toBeNull();
    expect(normalizeTideResponse({ code: '200', tideTable: [], tideHourly: [] }, '2026-08-06')).toBeNull();
  });

  it('samples height and switches status at extrema', () => {
    const data = mockTideData('2026-08-06');
    const atHigh = tideStatusAt(data, 3 * 60 + 40);
    const atLow = tideStatusAt(data, 10 * 60 + 5);
    expect(atHigh).toBe('满潮');
    expect(atLow).toBe('干潮');

    // 干潮后、下一满潮前 → 涨潮
    expect(tideStatusAt(data, 12 * 60)).toBe('涨潮中');
    // 满潮后、下一干潮前 → 退潮
    expect(tideStatusAt(data, 18 * 60)).toBe('退潮中');

    const h = sampleTideHeight(data, 60);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it('mock has two highs and two lows', () => {
    const data = mockTideData();
    const highs = data.extrema.filter((e) => e.type === 'high');
    const lows = data.extrema.filter((e) => e.type === 'low');
    expect(highs).toHaveLength(2);
    expect(lows).toHaveLength(2);
    expect(data.hourly.length).toBe(24);
  });
});
