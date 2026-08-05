/**
 * 月球相位 / 位置 / 月出月落（纯函数，近似算法）。
 *
 * 相位：平朔望月（synodic）相对已知新月历元；
 * 位置：低精度黄道→赤道→地平（误差通常 <1°，可视化足够）；
 * 月出月落：当天每 10 分钟扫高度角求过零。
 */

import { TZ_OFFSET_MINUTES } from './sun';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 平朔望月长度（日） */
const SYNODIC_MONTH = 29.530588853;
/**
 * 已知新月：2000-01-06 18:14 UTC ≈ JD 2451550.09765（Meeus）
 * 用于 phase ∈ [0,1)，0=新月、0.5=满月。
 */
const NEW_MOON_JD = 2451550.09765;

export interface MoonPosition {
  /** 高度角（度） */
  elevation: number;
  /** 方位角（度），0=北 90=东 */
  azimuth: number;
}

/** 儒略日（UTC）；month 1–12 */
export function julianDateUTC(
  year: number,
  month: number,
  day: number,
  hourUTC = 12,
): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const jd0 =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    B -
    1524.5;
  return jd0 + hourUTC / 24;
}

/** 本地日 + 分钟 → 儒略日（按 Asia/Shanghai 固定偏移） */
function julianLocal(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const hourUTC = minutes / 60 - TZ_OFFSET_MINUTES / 60;
  return julianDateUTC(y, m, d, hourUTC);
}

/** 月相 0–1：0=新月，0.5=满月。默认取该日 12:00 UTC。 */
export function moonPhase(date: string, hourUTC = 12): number {
  const [y, m, d] = date.split('-').map(Number);
  const jd = julianDateUTC(y, m, d, hourUTC);
  let age = ((jd - NEW_MOON_JD) / SYNODIC_MONTH) % 1;
  if (age < 0) age += 1;
  return age;
}

/** 月面照亮比例 0–1（几何近似） */
export function moonIllumination(date: string, hourUTC = 12): number {
  const phase = moonPhase(date, hourUTC);
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/**
 * 月球地平坐标（近似）。
 * 算法：低精度平黄经/黄纬 → 黄道转赤道 → 地方恒星时 → 高度/方位。
 */
export function moonPosition(
  date: string,
  minutes: number,
  lat: number,
  lon: number,
): MoonPosition {
  const jd = julianLocal(date, minutes);
  const T = (jd - 2451545.0) / 36525;

  // 平黄经、平近点角、升交点幅角（度）——低精度
  const L = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T;
  const M = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T;
  const F = 93.272095 + 483202.0175233 * T - 0.0036539 * T * T;
  const Ms = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;

  const Lm = (((L % 360) + 360) % 360) * DEG;
  const Mm = (((M % 360) + 360) % 360) * DEG;
  const Fm = (((F % 360) + 360) % 360) * DEG;
  const MsRad = (((Ms % 360) + 360) % 360) * DEG;

  // 主项摄动 → 视黄经 / 黄纬
  const lambda =
    Lm +
    DEG *
      (6.289 * Math.sin(Mm) +
        1.274 * Math.sin(2 * Lm - Mm) +
        0.658 * Math.sin(2 * Lm) +
        0.214 * Math.sin(2 * Mm) -
        0.186 * Math.sin(MsRad) -
        0.114 * Math.sin(2 * Fm));
  const beta =
    DEG *
    (5.128 * Math.sin(Fm) + 0.281 * Math.sin(Mm + Fm) + 0.278 * Math.sin(Mm - Fm));

  // 黄赤交角
  const eps = (23.439291 - 0.0130042 * T) * DEG;
  const sinEps = Math.sin(eps);
  const cosEps = Math.cos(eps);

  const sinBeta = Math.sin(beta);
  const cosBeta = Math.cos(beta);
  const sinLam = Math.sin(lambda);
  const cosLam = Math.cos(lambda);

  const ra = Math.atan2(sinLam * cosEps - Math.tan(beta) * sinEps, cosLam);
  const dec = Math.asin(
    Math.min(1, Math.max(-1, sinBeta * cosEps + cosBeta * sinEps * sinLam)),
  );

  // 平恒星时 → 地方恒星时
  const d = jd - 2451545.0;
  const gmst =
    (280.46061837 + 360.98564736629 * d + 0.000387933 * T * T) * DEG;
  const lst = gmst + lon * DEG;
  const ha = lst - ra;

  const latRad = lat * DEG;
  const sinAlt =
    Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha);
  const elevation = Math.asin(Math.min(1, Math.max(-1, sinAlt))) * RAD;

  const y = Math.sin(ha);
  const x = Math.cos(ha) * Math.sin(latRad) - Math.tan(dec) * Math.cos(latRad);
  let azimuth = (Math.atan2(y, x) * RAD + 180) % 360;
  if (azimuth < 0) azimuth += 360;

  return { elevation, azimuth };
}

/**
 * 当天月出 / 月落（本地分钟）。每 10 分钟扫高度角过零；
 * 极圈附近可能整夜在上/下 → null。
 */
export function moonriseMoonset(
  date: string,
  lat: number,
  lon: number,
): { moonrise: number | null; moonset: number | null } {
  let moonrise: number | null = null;
  let moonset: number | null = null;
  let prev = moonPosition(date, 0, lat, lon).elevation;
  for (let m = 10; m <= 1440; m += 10) {
    const elev = moonPosition(date, m, lat, lon).elevation;
    if (moonrise === null && prev < 0 && elev >= 0) {
      const t = prev === elev ? 0 : -prev / (elev - prev);
      moonrise = Math.round(m - 10 + 10 * t);
    }
    if (moonset === null && prev >= 0 && elev < 0) {
      const t = prev === elev ? 0 : prev / (prev - elev);
      moonset = Math.round(m - 10 + 10 * t);
    }
    prev = elev;
  }
  return { moonrise, moonset };
}
