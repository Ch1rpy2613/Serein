import { describe, expect, it } from 'vitest';
import type { SereinProfile } from '../../contracts';
import { buildXSectionGrid, heightOfValue, type XSectionColumn } from './grid';

function syntheticProfile(surfaceT: number): SereinProfile {
  const levels = [];
  for (let h = 0; h <= 12_000; h += 1000) {
    // 约 −6.5°C / km
    const temperature = surfaceT - (h / 1000) * 6.5;
    levels.push({
      pressure: 1013 - h * 0.08,
      heightM: h,
      temperature,
      windSpeed: 5 + h / 2000,
      windDirection: 270,
      rh: 60,
    });
  }
  return { levels };
}

describe('xsection grid', () => {
  it('fills a failed middle column from neighbors', () => {
    const columns: XSectionColumn[] = [
      {
        lat: 0,
        lon: 0,
        distanceKm: 0,
        profile: syntheticProfile(20),
        failed: false,
      },
      {
        lat: 0,
        lon: 0,
        distanceKm: 50,
        profile: null,
        failed: true,
      },
      {
        lat: 0,
        lon: 0,
        distanceKm: 100,
        profile: syntheticProfile(10),
        failed: false,
      },
    ];
    const grid = buildXSectionGrid(columns, 'temperature');
    // surface mid should be ~15
    expect(grid.values[1]).toBeCloseTo(15, 0);
    expect(Number.isFinite(grid.values[1])).toBe(true);
  });

  it('finds 0°C height consistent with lapse rate', () => {
    const columns: XSectionColumn[] = [
      {
        lat: 0,
        lon: 0,
        distanceKm: 0,
        profile: syntheticProfile(13),
        failed: false,
      },
    ];
    const grid = buildXSectionGrid(columns, 'temperature');
    const h0 = heightOfValue(grid, 0, 0);
    expect(h0).not.toBeNull();
    // 13 / 6.5 ≈ 2 km
    expect(h0!).toBeGreaterThan(1800);
    expect(h0!).toBeLessThan(2200);
  });
});
