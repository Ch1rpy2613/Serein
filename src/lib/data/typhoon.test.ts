import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildForecastCone,
  colorForLevel,
  levelFromWindKts,
  mockTyphoon,
  msToKts,
  normalizeLevelZh,
  parseWindQuadrants,
  resetTyphoonProviderState,
} from './typhoon';
import { windCirclePolygon } from '../scenes/typhoon/TyphoonLayer';

describe('typhoon helpers', () => {
  beforeEach(() => {
    resetTyphoonProviderState();
  });

  it('converts m/s to knots', () => {
    expect(msToKts(0)).toBe(0);
    expect(msToKts(42)).toBe(82); // ≈ 81.6 → 82
  });

  it('maps CMA wind thresholds to Chinese levels', () => {
    expect(levelFromWindKts(20)).toBe('热带低压');
    expect(levelFromWindKts(40)).toBe('热带风暴');
    expect(levelFromWindKts(55)).toBe('强热带风暴');
    expect(levelFromWindKts(70)).toBe('台风');
    expect(levelFromWindKts(90)).toBe('强台风');
    expect(levelFromWindKts(110)).toBe('超强台风');
  });

  it('normalizes QWeather type codes and Chinese labels', () => {
    expect(normalizeLevelZh('STY')).toBe('强台风');
    expect(normalizeLevelZh('SuperTY')).toBe('超强台风');
    expect(normalizeLevelZh('强台风')).toBe('强台风');
    expect(normalizeLevelZh('', 90)).toBe('强台风');
  });

  it('parses wind quadrant radii', () => {
    expect(parseWindQuadrants('250|150|250|150')).toEqual({
      ne: 250,
      se: 150,
      sw: 250,
      nw: 150,
    });
    expect(parseWindQuadrants('360')).toEqual({ ne: 360, se: 360, sw: 360, nw: 360 });
    expect(parseWindQuadrants(null)).toBeUndefined();
    expect(parseWindQuadrants('')).toBeUndefined();
  });

  it('builds a forecast cone hull', () => {
    const cone = buildForecastCone([
      { lat: 20, lon: 130 },
      { lat: 22, lon: 128 },
      { lat: 21, lon: 126 },
      { lat: 19, lon: 127 },
    ]);
    expect(cone).toBeDefined();
    expect(cone!.length).toBeGreaterThanOrEqual(3);
  });

  it('mock typhoon has past / forecast / cone / wind radii', () => {
    const t = mockTyphoon();
    expect(t.name).toBe('灿都');
    expect(t.track.past.length).toBeGreaterThan(2);
    expect(t.track.forecast.length).toBeGreaterThan(0);
    expect(t.track.cone?.length).toBeGreaterThanOrEqual(3);
    expect(t.windRadiiKm?.r7?.ne).toBeGreaterThan(0);
    expect(t.windRadiiKm?.r10?.ne).toBeGreaterThan(0);
    expect(colorForLevel(t.current.levelZh)).toMatch(/^#/);
  });

  it('builds wind circle polygons', () => {
    const ring = windCirclePolygon(135, 26, { ne: 200, se: 180, sw: 160, nw: 190 });
    expect(ring.length).toBeGreaterThan(10);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
});
