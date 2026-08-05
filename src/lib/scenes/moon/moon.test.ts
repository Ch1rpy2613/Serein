import { describe, expect, it } from 'vitest';
import { moonIllumination, moonPhase } from '../../astro/moon';
import {
  astronomicalDarkFactor,
  illuminatedFractionFromPhase,
  milkyWayVisibility,
  phaseName,
  stargazingIndex,
  stargazingVerdict,
  STARGATE_WEIGHTS,
} from './MoonLayer';

describe('phaseName (八分段)', () => {
  it('centers names on canonical phases', () => {
    expect(phaseName(0)).toBe('新月');
    expect(phaseName(0.125)).toBe('娥眉月');
    expect(phaseName(0.25)).toBe('上弦');
    expect(phaseName(0.375)).toBe('盈凸');
    expect(phaseName(0.5)).toBe('满月');
    expect(phaseName(0.625)).toBe('亏凸');
    expect(phaseName(0.75)).toBe('下弦');
    expect(phaseName(0.875)).toBe('残月');
  });

  it('keeps neighborhood of full/new inside the same bin', () => {
    expect(phaseName(0.5 - 0.04)).toBe('满月');
    expect(phaseName(0.5 + 0.04)).toBe('满月');
    expect(phaseName(0.01)).toBe('新月');
    expect(phaseName(0.99)).toBe('新月');
  });
});

describe('illumination vs moonIllumination', () => {
  it('matches library on 4 sample days across new→full', () => {
    const dates = ['2024-01-11', '2024-01-15', '2024-01-20', '2024-01-25'];
    for (const date of dates) {
      const phase = moonPhase(date);
      const fromPhase = illuminatedFractionFromPhase(phase);
      const fromLib = moonIllumination(date);
      expect(Math.abs(fromPhase - fromLib)).toBeLessThan(1e-9);
    }
  });
});

describe('stargazingIndex', () => {
  it('uses the documented weights', () => {
    expect(STARGATE_WEIGHTS.cloud + STARGATE_WEIGHTS.moon + STARGATE_WEIGHTS.twilight).toBeCloseTo(
      1,
      6,
    );
  });

  it('scores clear new-moon night near 100', () => {
    expect(stargazingIndex(0, 0, 1)).toBeCloseTo(100, 5);
  });

  it('scores cloudy full-moon day near 0', () => {
    expect(stargazingIndex(1, 1, 0)).toBeCloseTo(0, 5);
  });

  it('matches verdict bands', () => {
    expect(stargazingVerdict(70)).toBe('今晚适合观星');
    expect(stargazingVerdict(69)).toBe('一般');
    expect(stargazingVerdict(40)).toBe('一般');
    expect(stargazingVerdict(39)).toBe('不建议');
  });
});

describe('milkyWayVisibility', () => {
  it('almost hides under full moon at night', () => {
    expect(milkyWayVisibility(1, 0, 1)).toBeLessThan(0.05);
  });

  it('stays clear on new-moon clear night', () => {
    expect(milkyWayVisibility(0, 0, 1)).toBeGreaterThan(0.9);
  });

  it('collapses under heavy cloud', () => {
    expect(milkyWayVisibility(0, 1, 1)).toBeLessThan(0.05);
  });
});

describe('astronomicalDarkFactor', () => {
  it('is 1 below −18° and 0 above horizon', () => {
    expect(astronomicalDarkFactor(-20)).toBe(1);
    expect(astronomicalDarkFactor(-18)).toBe(1);
    expect(astronomicalDarkFactor(0)).toBe(0);
    expect(astronomicalDarkFactor(10)).toBe(0);
    expect(astronomicalDarkFactor(-9)).toBeCloseTo(0.5, 5);
  });
});
