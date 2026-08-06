import { describe, expect, it } from 'vitest';
import { formatKoppenLabel } from './koppen-labels';

describe('formatKoppenLabel', () => {
  it('formats Tianjin Dwa with Chinese name', () => {
    expect(formatKoppenLabel('Dwa')).toBe('Dwa · 温带季风气候');
  });

  it('falls back to code only for unknown classes', () => {
    expect(formatKoppenLabel('Xyz')).toBe('Xyz');
    expect(formatKoppenLabel(null)).toBe('');
  });
});
