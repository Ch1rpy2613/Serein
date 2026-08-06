/**
 * 大气热力学纯函数（可单测）。
 *
 * - wetBulb：Stull (2011) 经验湿球近似，输入 °C / %
 * - potentialTemperature：Poisson 位温 θ = Tₖ (1000/p)^κ，κ = Rd/cpd ≈ 0.286
 * - kIndex：K = T850 − T500 + Td850 − (T700 − Td700)；Td 用 Magnus（与 sounding/indices 同式）
 *
 * 文献：
 * - Stull, R., 2011: Wet-Bulb Temperature from Relative Humidity and Air Temperature.
 *   J. Appl. Meteor. Climatol., 50, 2267–2269.
 * - Alduchov & Eskridge, 1996: Improved Magnus form for saturation vapor pressure.
 * - George, J. J., 1960: Weather Forecasting for Aeronautics.（K 指数定义）
 */

import type { AtmosProfile, ProfilePoint } from './contracts';

const KAPPA = 0.286; // Rd/cpd ≈ 287/1005
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Magnus / Alduchov–Eskridge：由 T + RH 求露点 °C */
export function dewPointFromRh(tC: number, rh: number): number {
  const rhClamped = clamp(rh, 0.01, 100);
  const b = 17.62;
  const c = 243.12;
  const g = Math.log(rhClamped / 100) + (b * tC) / (c + tC);
  return Math.min((c * g) / (b - g), tC);
}

/**
 * Stull (2011) 湿球温度 °C。
 * 适用范围约 −20…50°C、RH 5…99%；结果 clamp 到 ≤ T。
 */
export function wetBulb(tC: number, rh: number): number {
  const T = tC;
  const RH = clamp(rh, 1, 99);
  const tw =
    T * Math.atan(0.151977 * (RH + 8.313659) ** 0.5) +
    Math.atan(T + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * RH ** 1.5 * Math.atan(0.023101 * RH) -
    4.686035;
  return round2(Math.min(tw, T));
}

/** 位温 °C（输入气温 °C、气压 hPa；输出亦为 °C） */
export function potentialTemperature(tC: number, pressureHpa: number): number {
  const p = Math.max(1, pressureHpa);
  const tK = tC + 273.15;
  const thetaK = tK * (1000 / p) ** KAPPA;
  return round2(thetaK - 273.15);
}

function nearestLevel(levels: ProfilePoint[], pressure: number): ProfilePoint | null {
  if (!levels.length) return null;
  let best = levels[0];
  let bestDist = Math.abs(best.pressure - pressure);
  for (let i = 1; i < levels.length; i += 1) {
    const d = Math.abs(levels[i].pressure - pressure);
    if (d < bestDist) {
      best = levels[i];
      bestDist = d;
    }
  }
  return bestDist <= 60 ? best : null;
}

/**
 * K 指数 (°C)：K = T850 − T500 + Td850 − (T700 − Td700)。
 * 缺层时返回 null。
 */
export function kIndex(profile: AtmosProfile): number | null {
  const l850 = nearestLevel(profile.levels, 850);
  const l700 = nearestLevel(profile.levels, 700);
  const l500 = nearestLevel(profile.levels, 500);
  if (!l850 || !l700 || !l500) return null;
  const td850 = dewPointFromRh(l850.temperature, l850.rh);
  const td700 = dewPointFromRh(l700.temperature, l700.rh);
  return round2(l850.temperature - l500.temperature + td850 - (l700.temperature - td700));
}
