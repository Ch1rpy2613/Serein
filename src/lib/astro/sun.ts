/**
 * 太阳位置与日出日落（纯函数）。
 *
 * solarPosition：NOAA 近似算法（自 SkyLayer/solarPosition 迁入）。
 * 时区：本项目 CITY 固定 Asia/Shanghai（UTC+8，无夏令时）→ +480 分钟。
 *
 * 参考：NOAA Solar Calculator（https://gml.noaa.gov/grad/solcalc/）
 */

/** CITY.tz = 'Asia/Shanghai' 的固定 UTC 偏移（分钟） */
export const TZ_OFFSET_MINUTES = 8 * 60;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface SolarPosition {
  /** 高度角（度），>0 在地平线上 */
  elevation: number;
  /** 方位角（度），0=北 90=东 180=南 270=西 */
  azimuth: number;
}

/** ISO 日期 → 年内日序数（1–366），UTC 解析避免本地时区干扰 */
function dayOfYear(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

export function solarPosition(
  date: string,
  minutes: number,
  lat: number,
  lon: number,
): SolarPosition {
  const n = dayOfYear(date);
  const hour = minutes / 60;

  // 分数年 γ（NOAA 按 365 天归一）
  const gamma = ((2 * Math.PI) / 365) * (n - 1 + (hour - 12) / 24);

  // 均时差（分钟）与赤纬（弧度）
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // 真太阳时 → 时角
  const timeOffset = eqTime + 4 * lon - TZ_OFFSET_MINUTES;
  const tst = (((minutes + timeOffset) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * DEG;

  // 天顶角 / 高度角
  const latRad = lat * DEG;
  const cosZenith =
    Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevation = 90 - zenith * RAD;

  // 方位角（自北顺时针）。天顶/天底附近分母退化时给稳定默认值。
  const azDenom = Math.cos(latRad) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(azDenom) < 1e-6) {
    azimuth = ha > 0 ? 270 : 90;
  } else {
    const ratio = Math.min(
      1,
      Math.max(-1, (Math.sin(latRad) * Math.cos(zenith) - Math.sin(decl)) / azDenom),
    );
    let az = 180 - Math.acos(ratio) * RAD;
    if (ha > 0) az = -az;
    azimuth = ((az % 360) + 360) % 360;
  }

  return { elevation, azimuth };
}

/**
 * 表观日出/日落阈值：几何地平 −0.833°（太阳视半径 + 标准大气折射）。
 * 与 NOAA / Open-Meteo 常用定义对齐。
 */
const SUNRISE_ELEVATION = -0.833;

/**
 * 本地日日出/日落分钟（高度角过 −0.833°）。
 * 无日出（极昼/极夜）时对应字段为 null。
 */
export function sunriseSunset(
  date: string,
  lat: number,
  lon: number,
): { sunrise: number | null; sunset: number | null } {
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let prev = solarPosition(date, 0, lat, lon).elevation - SUNRISE_ELEVATION;
  // 1 分钟步长，保证与公开历误差通常 < 2 分钟
  for (let m = 1; m <= 1440; m += 1) {
    const elev = solarPosition(date, m, lat, lon).elevation - SUNRISE_ELEVATION;
    if (sunrise === null && prev < 0 && elev >= 0) {
      const t = prev === elev ? 0 : -prev / (elev - prev);
      sunrise = Math.round(m - 1 + t);
    }
    if (sunset === null && prev >= 0 && elev < 0) {
      const t = prev === elev ? 0 : prev / (prev - elev);
      sunset = Math.round(m - 1 + t);
    }
    prev = elev;
  }
  return { sunrise, sunset };
}

/** 太阳高度角是否低于天文昏影阈值（−18°） */
export function isAstronomicalNight(
  date: string,
  minutes: number,
  lat: number,
  lon: number,
): boolean {
  return solarPosition(date, minutes, lat, lon).elevation < -18;
}
