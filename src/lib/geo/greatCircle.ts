/** 大圆几何（球面近似，WGS84 平均半径） */

const EARTH_RADIUS_KM = 6371.0088;

export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** 两点大圆距离（km） */
export function haversineKm(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lon - a.lon);
  const s =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * 大圆插值：t∈[0,1] 沿 A→B。
 * 重合点时返回 A。
 */
export function interpolateGreatCircle(a: LatLon, b: LatLon, t: number): LatLon {
  const clamped = Math.min(1, Math.max(0, t));
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lon);

  const cosφ1 = Math.cos(φ1);
  const cosφ2 = Math.cos(φ2);
  let cosδ =
    Math.sin(φ1) * Math.sin(φ2) + cosφ1 * cosφ2 * Math.cos(λ2 - λ1);
  cosδ = Math.min(1, Math.max(-1, cosδ));
  const δ = Math.acos(cosδ);
  if (δ < 1e-9) return { lat: a.lat, lon: a.lon };

  const sinδ = Math.sin(δ);
  const A = Math.sin((1 - clamped) * δ) / sinδ;
  const B = Math.sin(clamped * δ) / sinδ;
  const x = A * cosφ1 * Math.cos(λ1) + B * cosφ2 * Math.cos(λ2);
  const y = A * cosφ1 * Math.sin(λ1) + B * cosφ2 * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: toDeg(Math.atan2(z, Math.hypot(x, y))),
    lon: toDeg(Math.atan2(y, x)),
  };
}

/** 沿大圆等距取 n 个点（含端点） */
export function sampleGreatCircle(a: LatLon, b: LatLon, n: number): LatLon[] {
  const count = Math.max(2, Math.floor(n));
  const out: LatLon[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(interpolateGreatCircle(a, b, i / (count - 1)));
  }
  return out;
}
