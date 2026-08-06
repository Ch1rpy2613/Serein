import { describe, expect, it } from 'vitest';
import {
  dewPointFromRh,
  kIndex,
  potentialTemperature,
  wetBulb,
} from './atmosphere';
import type { AtmosProfile } from './contracts';

describe('atmosphere', () => {
  it('wetBulb is below dry-bulb and rises with RH', () => {
    const dry = wetBulb(30, 20);
    const humid = wetBulb(30, 80);
    expect(dry).toBeLessThan(30);
    expect(humid).toBeLessThanOrEqual(30);
    expect(humid).toBeGreaterThan(dry);
    // 30°C / 50% RH ≈ 20–23°C（Stull 量级）
    const mid = wetBulb(30, 50);
    expect(mid).toBeGreaterThan(18);
    expect(mid).toBeLessThan(25);
  });

  it('potentialTemperature rises as pressure falls (same T)', () => {
    const at1000 = potentialTemperature(15, 1000);
    const at850 = potentialTemperature(15, 850);
    expect(at1000).toBeCloseTo(15, 0);
    expect(at850).toBeGreaterThan(at1000 + 10);
    // ISA 近似：海平面 15°C @1000 hPa → θ≈15；850 hPa 同 T 时 θ≈28°C 量级
    expect(at850).toBeGreaterThan(25);
    expect(at850).toBeLessThan(35);
  });

  it('kIndex for a moist mid-latitude summer sounding is tens of °C', () => {
    const profile: AtmosProfile = {
      levels: [
        { pressure: 1000, heightM: 100, temperature: 28, windSpeed: 3, windDirection: 180, rh: 70 },
        { pressure: 850, heightM: 1500, temperature: 18, windSpeed: 8, windDirection: 200, rh: 75 },
        { pressure: 700, heightM: 3000, temperature: 8, windSpeed: 12, windDirection: 220, rh: 60 },
        { pressure: 500, heightM: 5500, temperature: -12, windSpeed: 20, windDirection: 250, rh: 40 },
      ],
    };
    const k = kIndex(profile);
    expect(k).not.toBeNull();
    // T850−T500=30；Td850≈13；T700−Td700≈数度 → K 约 25–40
    expect(k!).toBeGreaterThan(20);
    expect(k!).toBeLessThan(45);
    expect(dewPointFromRh(18, 75)).toBeLessThanOrEqual(18);
  });

  it('kIndex returns null when required levels are missing', () => {
    const profile: AtmosProfile = {
      levels: [
        { pressure: 1000, heightM: 100, temperature: 20, windSpeed: 2, windDirection: 90, rh: 50 },
      ],
    };
    expect(kIndex(profile)).toBeNull();
  });
});
