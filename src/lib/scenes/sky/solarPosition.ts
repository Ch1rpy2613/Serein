/**
 * solarPosition —— NOAA 太阳位置近似算法（独立纯函数，可单测、可复用）。
 *
 * 输入：
 *   date    ISO 日期 "YYYY-MM-DD"（该日期的日序数参与计算）
 *   minutes 当地时钟分钟 0–1440（可含小数，便于缓动插值）
 *   lat     纬度，北纬为正（度）
 *   lon     经度，东经为正（度）
 * 输出：
 *   elevation 太阳高度角（度，地平线为 0，可负）
 *   azimuth   方位角（度，0=北，90=东，顺时针）
 *
 * 时区：本项目 CITY 固定 Asia/Shanghai（UTC+8，无夏令时），
 * 故时区偏移取常量 +480 分钟；若复用到其他时区需自行换算 minutes。
 *
 * 参考：NOAA Solar Calculator（ https://gml.noaa.gov/grad/solcalc/ ），
 * 精度约 ±0.01° 量级，对可视化绰绰有余。未做大气折射修正（视觉差异 <0.6°，
 * 且折射只影响日出日落时刻的表观位置，不影响天空颜色的连续性）。
 */

/** CITY.tz = 'Asia/Shanghai' 的固定 UTC 偏移（分钟） */
const TZ_OFFSET_MINUTES = 8 * 60;

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
