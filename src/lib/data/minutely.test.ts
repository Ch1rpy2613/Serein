import { describe, expect, it } from 'vitest';
import { normalizeMinutelyResponse } from './minutely';

describe('normalizeMinutelyResponse', () => {
  it('maps fxTime/precip into relative minutes', () => {
    const points = normalizeMinutelyResponse({
      code: '200',
      minutely: [
        { fxTime: '2026-08-06T20:00+08:00', precip: '0.0' },
        { fxTime: '2026-08-06T20:05+08:00', precip: '0.12' },
        { fxTime: '2026-08-06T20:10+08:00', precip: '0.4' },
      ],
    });
    expect(points).toEqual([
      { minutes: 0, precipitation: 0 },
      { minutes: 5, precipitation: 0.12 },
      { minutes: 10, precipitation: 0.4 },
    ]);
  });

  it('returns null on error codes or empty lists', () => {
    expect(normalizeMinutelyResponse({ code: '403', minutely: [] })).toBeNull();
    expect(normalizeMinutelyResponse({ code: '200', minutely: [] })).toBeNull();
    expect(normalizeMinutelyResponse(null)).toBeNull();
  });
});
