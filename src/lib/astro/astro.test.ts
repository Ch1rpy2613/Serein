import { describe, expect, it } from 'vitest';
import { CITY } from '../contracts';
import {
  galacticCenterPosition,
  galacticWindow,
  nextGalacticWindowDate,
} from './milkyway';
import { moonPhase } from './moon';

describe('moonPhase anchors', () => {
  it('2024-01-11 near new moon (11:57 UTC)', () => {
    // 当天 11:57 UTC 新月；默认取 12:00 UTC，相位应接近 0
    expect(moonPhase('2024-01-11')).toBeLessThan(0.02);
    expect(moonPhase('2024-01-11')).toBeGreaterThanOrEqual(0);
  });

  it('2024-01-25 near full moon', () => {
    expect(Math.abs(moonPhase('2024-01-25') - 0.5)).toBeLessThanOrEqual(0.02);
  });
});

describe('galacticWindow (天津)', () => {
  const { lat, lon } = CITY;

  it('8 月夜晚窗口非空（近新月）', () => {
    const win = galacticWindow('2024-08-05', lat, lon);
    expect(win).not.toBeNull();
    expect(win!.end).toBeGreaterThan(win!.start);
    // 夜晚：窗口应落在日落后 / 日出前
    expect(win!.start).toBeGreaterThan(18 * 60);
  });

  it('1 月正午无观星窗口', () => {
    // 天津冬季银心仅白天升高，整夜不满足条件 → 全日 null
    expect(galacticWindow('2024-01-15', lat, lon)).toBeNull();
  });

  it('nextGalacticWindowDate stretches past a null day', () => {
    const next = nextGalacticWindowDate('2024-01-15', lat, lon, 240);
    expect(next).not.toBeNull();
    expect(next! > '2024-01-15').toBe(true);
    expect(galacticWindow(next!, lat, lon)).not.toBeNull();
  });

  it('galacticCenterPosition returns finite az/alt', () => {
    const pos = galacticCenterPosition('2024-08-05', 22 * 60, lat, lon);
    expect(Number.isFinite(pos.elevation)).toBe(true);
    expect(pos.azimuth).toBeGreaterThanOrEqual(0);
    expect(pos.azimuth).toBeLessThan(360);
  });
});
