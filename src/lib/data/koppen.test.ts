import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '../contracts';
import { ensureKoppenGrid, lookupKoppen } from './koppen';

describe('lookupKoppen', () => {
  beforeAll(async () => {
    await ensureKoppenGrid();
  });

  it('returns Dwa for Tianjin', () => {
    expect(lookupKoppen(DEFAULT_CITY.lat, DEFAULT_CITY.lon)).toBe('Dwa');
    expect(lookupKoppen(39.1, 117.2)).toBe('Dwa');
  });

  it('returns null for invalid coordinates', () => {
    expect(lookupKoppen(Number.NaN, 0)).toBeNull();
    expect(lookupKoppen(100, 0)).toBeNull();
  });
});
