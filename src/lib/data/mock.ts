import type { DayData } from '../contracts';

/** mulberry32：可种子化伪随机，同一 seed 输出序列完全一致 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOURS = 25; // 索引 0 = 00:00 … 24 = 24:00
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * 温度日变化曲线，返回 -1…1：
 * 05:00 取最低 -1，14:00 取最高 +1，24h 周期且处处光滑。
 */
function diurnal(h: number): number {
  const rise = 9;  // 05 → 14 升温段
  const fall = 15; // 14 → 次日 05 降温段
  const t = (((h - 5) % 24) + 24) % 24;
  return t <= rise
    ? -Math.cos((Math.PI * t) / rise)
    : Math.cos((Math.PI * (t - rise)) / fall);
}

/** Magnus 公式：由温度与相对湿度求露点，RH ≤ 100% 时恒有露点 ≤ 温度 */
function dewPointFromRh(tC: number, rh: number): number {
  const b = 17.62;
  const c = 243.12;
  const g = Math.log(rh / 100) + (b * tC) / (c + tC);
  return (c * g) / (b - g);
}

export function mockDayData(seed: number): DayData {
  const rng = mulberry32(seed);
  const hours = Array.from({ length: HOURS }, (_, i) => i);

  // 温度：日均 22°C + 振幅 8°C（14 点最高、05 点最低）+ 小噪声；
  // 噪声在极值附近收窄，保证采样后最高 / 最低仍落在 14 点 / 05 点
  const temperature = hours.map((h) => {
    const v = diurnal(h);
    const noise = (rng() - 0.5) * 0.6 * (1 - 0.9 * Math.abs(v));
    return round2(22 + 8 * v + noise);
  });

  // 湿度：与温度反相关，限制在 15–100%
  const humidity = hours.map((_, i) => {
    const rh = 65 - 2.5 * (temperature[i] - 22) + (rng() - 0.5) * 4;
    return round2(Math.min(100, Math.max(15, rh)));
  });

  // 露点：由温度与湿度物理推导，恒 ≤ 温度
  const dewPoint = hours.map((_, i) =>
    round2(Math.min(dewPointFromRh(temperature[i], humidity[i]), temperature[i])),
  );

  // 降水：2–3 个高斯雨峰，分布在凌晨 / 午后 / 傍晚时段；
  // 首个雨峰峰值 8–14 mm/h 且中心取整点，保证采样后至少一个点 ≥ 8 mm/h
  const eventCount = 2 + Math.floor(rng() * 2);
  const windows = [
    [1, 8],
    [10, 16],
    [17, 23],
  ] as const;
  const events = Array.from({ length: eventCount }, (_, e) => ({
    center: Math.round(windows[e][0] + rng() * (windows[e][1] - windows[e][0])),
    sigma: 1 + rng() * 1.5,
    peak: e === 0 ? 8 + rng() * 6 : 1.5 + rng() * 5,
  }));
  const precipitation = hours.map((h) => {
    let p = 0;
    for (const ev of events) {
      p += ev.peak * Math.exp(-((h - ev.center) ** 2) / (2 * ev.sigma ** 2));
    }
    return round2(Math.max(0, p));
  });

  // 风向：起点 120–240°，线性漂移 ±100° 叠加 ±8° 波动，
  // 全天总变幅 ≤ 120° 且始终落在 [0, 360) 内、无跨 0° 跳变
  const dirStart = 120 + rng() * 120;
  const dirDrift = (rng() * 2 - 1) * 100;
  const wigglePhase = rng() * Math.PI * 2;
  const windDirection = hours.map((h) =>
    round2(dirStart + dirDrift * (h / 24) + 8 * Math.sin((2 * Math.PI * h) / 24 + wigglePhase)),
  );

  // 风速：基础 1.5–4 m/s 加日变化与噪声，阵风 = 风速 × 1.3–1.8
  const windBase = 1.5 + rng() * 2.5;
  const windSpeed = hours.map((h) =>
    round2(
      Math.max(
        0.2,
        windBase + 1.2 * Math.sin((2 * Math.PI * (h - 13)) / 24) + (rng() - 0.5) * 0.8,
      ),
    ),
  );
  const windGust = windSpeed.map((v) => round2(v * (1.3 + rng() * 0.5)));

  // 云量：0–1，缓慢起伏
  const cloudBase = 0.3 + rng() * 0.4;
  const cloudPhase = rng() * Math.PI * 2;
  const cloudCover = hours.map((h) =>
    round2(
      Math.min(
        1,
        Math.max(
          0,
          cloudBase + 0.25 * Math.sin((2 * Math.PI * h) / 24 + cloudPhase) + (rng() - 0.5) * 0.1,
        ),
      ),
    ),
  );

  // 气压：1008–1018 hPa 基线加全天线性趋势与微噪声
  const pBase = 1008 + rng() * 10;
  const pTrend = (rng() * 2 - 1) * 4;
  const pressure = hours.map((h) =>
    round2(pBase + pTrend * (h / 24) + (rng() - 0.5) * 0.6),
  );

  // 气溶胶光学厚度：标量 0–1
  const aod = round2(0.05 + rng() * 0.45);

  // ISO 日期：由 seed 确定性推出
  const date = new Date(Date.UTC(2026, 0, 1 + (Math.abs(Math.trunc(seed)) % 365)))
    .toISOString()
    .slice(0, 10);

  return {
    date,
    temperature,
    dewPoint,
    humidity,
    precipitation,
    windSpeed,
    windDirection,
    windGust,
    cloudCover,
    pressure,
    aod,
  };
}
