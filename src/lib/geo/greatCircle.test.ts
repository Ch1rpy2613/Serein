import { describe, expect, it } from 'vitest';
import { haversineKm, sampleGreatCircle } from './greatCircle';

describe('greatCircle', () => {
  it('Tianjin–Beijing distance ≈ 120 km (±5%)', () => {
    const tianjin = { lat: 39.1, lon: 117.2 };
    const beijing = { lat: 39.9, lon: 116.4 };
    const km = haversineKm(tianjin, beijing);
    // 实测大圆约 110–130 km
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(130);
  });

  it('samples include endpoints and are monotonic in distance', () => {
    const a = { lat: 39.1, lon: 117.2 };
    const b = { lat: 39.9, lon: 116.4 };
    const pts = sampleGreatCircle(a, b, 7);
    expect(pts).toHaveLength(7);
    expect(pts[0].lat).toBeCloseTo(a.lat, 5);
    expect(pts[6].lat).toBeCloseTo(b.lat, 5);
    let prev = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const d = haversineKm(a, pts[i]);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = d;
    }
  });
});
