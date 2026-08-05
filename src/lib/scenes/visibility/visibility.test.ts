import { describe, expect, it } from 'vitest';
import {
  formatVisibility,
  justVisibleLandmark,
  landmarkFogCover,
} from './VisibilityLayer';

describe('landmarkFogCover', () => {
  it('clears all landmarks at 25km visibility', () => {
    for (const km of [0.5, 2, 4, 8, 16, 32]) {
      expect(landmarkFogCover(km * 1000, 25_000, 60)).toBeLessThan(0.1);
    }
  });

  it('hides landmarks beyond 8km when visibility is 8km', () => {
    expect(landmarkFogCover(8000, 8000, 60)).toBeLessThan(0.7);
    expect(landmarkFogCover(4000, 8000, 60)).toBeLessThan(0.2);
    expect(landmarkFogCover(16_000, 8000, 60)).toBeGreaterThan(0.95);
    expect(landmarkFogCover(32_000, 8000, 60)).toBeGreaterThan(0.95);
  });

  it('keeps only the nearest landmark at 500m visibility', () => {
    expect(landmarkFogCover(500, 500, 60)).toBeLessThan(0.7);
    expect(landmarkFogCover(2000, 500, 60)).toBeGreaterThan(0.95);
    expect(landmarkFogCover(8000, 500, 60)).toBeGreaterThan(0.95);
  });

  it('adds near-field haze when RH > 85%', () => {
    const dry = landmarkFogCover(500, 25_000, 60);
    const wet = landmarkFogCover(500, 25_000, 95);
    expect(wet).toBeGreaterThan(dry);
  });
});

describe('justVisibleLandmark', () => {
  it('matches human-readable landmarks to visibility', () => {
    expect(justVisibleLandmark(8000)?.name).toBe('工厂烟囱');
    expect(justVisibleLandmark(4000)?.name).toBe('天塔');
    expect(justVisibleLandmark(500)?.name).toBe('树');
  });
});

describe('formatVisibility', () => {
  it('formats by magnitude', () => {
    expect(formatVisibility(25_000)).toBe('25 km');
    expect(formatVisibility(8000)).toBe('8.0 km');
    expect(formatVisibility(500)).toBe('500 m');
  });
});
