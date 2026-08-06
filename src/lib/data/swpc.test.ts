import { describe, expect, it } from 'vitest';
import { parseLatestKp } from './swpc';

describe('parseLatestKp', () => {
  it('skips header and returns the latest finite KP', () => {
    const payload = [
      ['time_tag', 'Kp', 'a_running', 'station_count'],
      ['2026-08-06 00:00:00.000', '2.33', '8', '8'],
      ['2026-08-06 03:00:00.000', '4.00', '27', '9'],
      ['2026-08-06 06:00:00.000', '3.67', '18', '9'],
    ];
    expect(parseLatestKp(payload)).toBe(3.7);
  });

  it('returns null for empty or malformed payloads', () => {
    expect(parseLatestKp(null)).toBeNull();
    expect(parseLatestKp([])).toBeNull();
    expect(parseLatestKp([['time_tag', 'Kp']])).toBeNull();
  });
});
