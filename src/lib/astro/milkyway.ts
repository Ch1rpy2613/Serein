/**
 * 银河（银心）可见性（纯函数）。
 *
 * 银心赤道坐标：RA 17h45.6m / Dec −29°00′；
 * 赤道 → 地平后判断观星窗口。
 */

import { moonIllumination, moonPosition } from './moon';
import { solarPosition, TZ_OFFSET_MINUTES } from './sun';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 银心赤经（度）：17h45.6m = 266.4° */
const GC_RA_DEG = (17 + 45.6 / 60) * 15;
/** 银心赤纬（度） */
const GC_DEC_DEG = -29;

export interface GalacticWindow {
  start: number; // 本地分钟
  end: number;
}

/** 本地日 + 分钟 → 儒略日（Asia/Shanghai 固定偏移） */
function julianLocal(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  let y2 = y;
  let m2 = m;
  if (m2 <= 2) {
    y2 -= 1;
    m2 += 12;
  }
  const A = Math.floor(y2 / 100);
  const B = 2 - A + Math.floor(A / 4);
  const day = d + (minutes / 60 - TZ_OFFSET_MINUTES / 60) / 24;
  return (
    Math.floor(365.25 * (y2 + 4716)) +
    Math.floor(30.6001 * (m2 + 1)) +
    day +
    B -
    1524.5
  );
}

/** 赤道坐标 → 地平高度角 */
function equatorialAltitude(
  raDeg: number,
  decDeg: number,
  date: string,
  minutes: number,
  lat: number,
  lon: number,
): number {
  const jd = julianLocal(date, minutes);
  const T = (jd - 2451545.0) / 36525;
  const d = jd - 2451545.0;
  const gmst =
    (280.46061837 + 360.98564736629 * d + 0.000387933 * T * T) * DEG;
  const lst = gmst + lon * DEG;
  const ha = lst - raDeg * DEG;
  const dec = decDeg * DEG;
  const latRad = lat * DEG;
  const sinAlt =
    Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.min(1, Math.max(-1, sinAlt))) * RAD;
}

/** 银心高度角（度） */
export function galacticCenterAlt(
  date: string,
  minutes: number,
  lat: number,
  lon: number,
): number {
  return equatorialAltitude(GC_RA_DEG, GC_DEC_DEG, date, minutes, lat, lon);
}

/**
 * 银河观星窗口：天文昏影（太阳 < −18°）且银心高度角 > 15°，
 * 且月照 < 0.3 或月球在地平下。返回本地分钟起止；无则 null。
 */
export function galacticWindow(
  date: string,
  lat: number,
  lon: number,
  moonIllum?: number,
): GalacticWindow | null {
  const illum = moonIllum ?? moonIllumination(date);
  let start: number | null = null;
  let end: number | null = null;

  for (let m = 0; m <= 1440; m += 10) {
    const sunElev = solarPosition(date, m, lat, lon).elevation;
    const gcAlt = galacticCenterAlt(date, m, lat, lon);
    const moonElev = moonPosition(date, m, lat, lon).elevation;
    const darkEnough = sunElev < -18;
    const gcHigh = gcAlt > 15;
    const moonOk = illum < 0.3 || moonElev < 0;
    const ok = darkEnough && gcHigh && moonOk;

    if (ok) {
      if (start === null) start = m;
      end = m;
    } else if (start !== null && end !== null) {
      // 取当天第一段连续窗口
      break;
    }
  }

  if (start === null || end === null || end <= start) return null;
  return { start, end };
}
