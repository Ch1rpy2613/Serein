import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '../../contracts';
import { solarPosition } from '../../astro/sun';
import {
  computeShadow,
  cumulativeSunshineHours,
  formatClock,
  shadowBearing,
  shadowLengthRatio,
  twilightBand,
  uvGradeLabel,
} from './SunlightLayer';

describe('shadowBearing / shadowLengthRatio', () => {
  it('shadow bearing is sun azimuth + 180°', () => {
    expect(shadowBearing(0)).toBeCloseTo(180, 6);
    expect(shadowBearing(90)).toBeCloseTo(270, 6);
    expect(shadowBearing(180)).toBeCloseTo(0, 6);
    expect(shadowBearing(270)).toBeCloseTo(90, 6);
    expect(shadowBearing(359)).toBeCloseTo(179, 6);
  });

  it('noon shadow shorter than low-sun shadow; night has no shadow', () => {
    const noon = computeShadow(180, 65);
    const low = computeShadow(90, 10);
    const night = computeShadow(0, -5);

    expect(noon.sunUp).toBe(true);
    expect(low.sunUp).toBe(true);
    expect(night.alpha).toBe(0);
    expect(night.lengthNorm).toBe(0);

    expect(noon.lengthNorm).toBeLessThan(low.lengthNorm);
    expect(low.alpha).toBeLessThan(noon.alpha);
    expect(shadowLengthRatio(65)).toBeLessThan(shadowLengthRatio(10));
    expect(shadowLengthRatio(-1)).toBe(0);
  });

  it('bearing stays continuous across a full day (no 180° flips)', () => {
    const date = '2024-08-05';
    let previous = shadowBearing(
      solarPosition(date, 0, DEFAULT_CITY.lat, DEFAULT_CITY.lon).azimuth,
    );
    for (let minutes = 1; minutes <= 1440; minutes += 1) {
      const { azimuth, elevation } = solarPosition(date, minutes, DEFAULT_CITY.lat, DEFAULT_CITY.lon);
      const bearing = shadowBearing(azimuth);
      let delta = bearing - previous;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      // 1 分钟步长下方位角变化应远小于 5°
      expect(Math.abs(delta)).toBeLessThan(5);
      if (elevation > 0) {
        expect(computeShadow(azimuth, elevation).bearing).toBeCloseTo(bearing, 6);
      }
      previous = bearing;
    }
  });
});

describe('twilightBand vs solarPosition (天津 2024-08-05)', () => {
  const date = '2024-08-05';

  it('marks civil / nautical / astronomical at three evening moments', () => {
    // 预先用 solarPosition 标定：1172≈−3°、1206≈−9°、1244≈−15°
    const samples: Array<{ minutes: number; band: ReturnType<typeof twilightBand> }> = [
      { minutes: 1172, band: 'civil' },
      { minutes: 1206, band: 'nautical' },
      { minutes: 1244, band: 'astronomical' },
    ];

    for (const { minutes, band } of samples) {
      const { elevation } = solarPosition(date, minutes, DEFAULT_CITY.lat, DEFAULT_CITY.lon);
      expect(twilightBand(elevation)).toBe(band);
    }
  });

  it('classifies day and deep night correctly', () => {
    expect(twilightBand(solarPosition(date, 720, DEFAULT_CITY.lat, DEFAULT_CITY.lon).elevation)).toBe('day');
    expect(twilightBand(solarPosition(date, 0, DEFAULT_CITY.lat, DEFAULT_CITY.lon).elevation)).toBe('night');
  });
});

describe('uvGradeLabel / analysis helpers', () => {
  it('maps WHO UV bands', () => {
    expect(uvGradeLabel(0)).toBe('低');
    expect(uvGradeLabel(2)).toBe('低');
    expect(uvGradeLabel(3)).toBe('中');
    expect(uvGradeLabel(5)).toBe('中');
    expect(uvGradeLabel(6)).toBe('高');
    expect(uvGradeLabel(7)).toBe('高');
    expect(uvGradeLabel(8)).toBe('很高');
    expect(uvGradeLabel(10)).toBe('很高');
    expect(uvGradeLabel(11)).toBe('极高');
  });

  it('sums sunshineDuration seconds into hours (skips hour-24)', () => {
    const series = new Float32Array(25);
    series.fill(1800, 0, 24); // 每小时 0.5h × 24 = 12h
    series[24] = 9999;
    expect(cumulativeSunshineHours(series)).toBeCloseTo(12, 6);
  });

  it('formats sunrise/sunset as HH:MM', () => {
    expect(formatClock(315)).toBe('05:15');
    expect(formatClock(1159)).toBe('19:19');
  });
});
