import { describe, expect, it } from 'vitest';
import {
  bodyFeelFromPressure,
  computeTrend,
  formatPressure,
  formatTrendDelta,
  PRESSURE_CONSTANTS,
  pressureDelta,
  pressureToFillRatio,
  standingWaveOffset,
} from './PressureLayer';

const BODY_FEEL = PRESSURE_CONSTANTS.BODY_FEEL;

describe('pressureToFillRatio', () => {
  it('maps 950→0, 1000→0.5, 1050→1', () => {
    expect(pressureToFillRatio(950)).toBeCloseTo(0, 6);
    expect(pressureToFillRatio(1000)).toBeCloseTo(0.5, 6);
    expect(pressureToFillRatio(1050)).toBeCloseTo(1, 6);
  });

  it('matches hand-checked hours against a synthetic series', () => {
    // 00:00=1000, 03:00=1006, 06:00=1012 … 线性每小时 +2 hPa
    const series = Float32Array.from({ length: 25 }, (_, h) => 1000 + h * 2);

    const samples: Array<{ minutes: number; expected: number }> = [
      { minutes: 0, expected: 1000 },
      { minutes: 180, expected: 1006 },
      { minutes: 360, expected: 1012 },
    ];

    for (const { minutes, expected } of samples) {
      const hour = minutes / 60;
      const left = Math.floor(hour);
      const amount = hour - left;
      const pressure = series[left] + (series[left + 1] - series[left]) * amount;
      expect(pressure).toBeCloseTo(expected, 6);
      expect(pressureToFillRatio(pressure)).toBeCloseTo(
        (expected - 950) / 100,
        6,
      );
    }
  });
});

describe('computeTrend / pressureDelta', () => {
  it('reports 3h delta with correct arrow and label', () => {
    // 每小时 −1 hPa：6h 相对 3h → Δ = −3
    const series = Float32Array.from({ length: 25 }, (_, h) => 1010 - h);
    const trend = computeTrend(series, 360);
    expect(trend.delta).toBeCloseTo(-3, 6);
    expect(trend.arrow).toBe('↓');
    expect(trend.label).toBe('3h −3.0 hPa');
    expect(trend.warn).toBe(true);
  });

  it('uses → for flat pressure and ↑ for rises', () => {
    const flat = new Float32Array(25).fill(1013);
    expect(computeTrend(flat, 480).arrow).toBe('→');
    expect(computeTrend(flat, 480).warn).toBe(false);

    const rising = Float32Array.from({ length: 25 }, (_, h) => 1000 + h);
    const up = computeTrend(rising, 240);
    expect(up.arrow).toBe('↑');
    expect(up.label).toBe('3h +3.0 hPa');
    expect(up.warn).toBe(false);
  });

  it('clamps lookback to day start', () => {
    const series = Float32Array.from({ length: 25 }, (_, h) => 1000 + h);
    // at 60 min: current≈1001, past=00:00→1000, Δ≈1
    expect(pressureDelta(series, 60)).toBeCloseTo(1, 5);
  });
});

describe('bodyFeelFromPressure', () => {
  it('sinks when >1020 and floats when <990 within ±6px', () => {
    const high = bodyFeelFromPressure(1050);
    expect(high.shiftY).toBeCloseTo(BODY_FEEL.maxShiftPx, 6);
    expect(high.contrast).toBeGreaterThan(1);

    const low = bodyFeelFromPressure(950);
    expect(low.shiftY).toBeCloseTo(-BODY_FEEL.maxShiftPx, 6);
    expect(low.contrast).toBeLessThan(1);

    const mid = bodyFeelFromPressure(1005);
    expect(mid.shiftY).toBe(0);
    expect(mid.contrast).toBe(1);
  });

  it('stays restrained near thresholds', () => {
    expect(Math.abs(bodyFeelFromPressure(1021).shiftY)).toBeLessThan(1);
    expect(Math.abs(bodyFeelFromPressure(989).shiftY)).toBeLessThan(1);
  });
});

describe('format helpers', () => {
  it('formats one decimal and trend copy', () => {
    expect(formatPressure(1013.25)).toBe('1013.3');
    expect(formatTrendDelta(-2.1)).toBe('3h −2.1 hPa');
    expect(formatTrendDelta(1.5)).toBe('3h +1.5 hPa');
  });
});

describe('standingWaveOffset', () => {
  it('keeps amplitude under 2px', () => {
    for (let t = 0; t < 20; t += 0.05) {
      expect(Math.abs(standingWaveOffset(t))).toBeLessThan(2);
    }
  });
});

describe('spring constants', () => {
  it('uses stiffness≈100 and damping≈16', () => {
    expect(PRESSURE_CONSTANTS.SPRING.stiffness).toBe(100);
    expect(PRESSURE_CONSTANTS.SPRING.damping).toBe(16);
  });

  it('converges without sustained oscillation (semi-implicit Euler)', () => {
    let x = 1000;
    let v = 0;
    const target = 1020;
    const { stiffness, damping } = PRESSURE_CONSTANTS.SPRING;
    const dt = 1 / 60;
    let crossed = 0;
    let prevSign = Math.sign(x - target);

    for (let i = 0; i < 180; i += 1) {
      const force = -stiffness * (x - target) - damping * v;
      v += force * dt;
      x += v * dt;
      const sign = Math.sign(x - target);
      if (sign !== 0 && sign !== prevSign) {
        crossed += 1;
        prevSign = sign;
      }
    }

    expect(Math.abs(x - target)).toBeLessThan(0.05);
    expect(Math.abs(v)).toBeLessThan(0.5);
    // underdamped but should not chatter: few zero-crossings
    expect(crossed).toBeLessThan(8);
  });
});
