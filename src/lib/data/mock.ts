import type {
  AtmosProfile,
  ClimateNormals,
  DayData,
  MultiModelData,
  ProfilePoint,
} from '../contracts';

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
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** 国际标准大气近似：扩展气压面（按高度升序，与 openmeteo PRESSURE_LEVELS 对齐） */
const ISA_LEVELS: ReadonlyArray<{ pressure: number; heightM: number }> = [
  { pressure: 1000, heightM: 110 },
  { pressure: 975, heightM: 323 },
  { pressure: 950, heightM: 540 },
  { pressure: 925, heightM: 762 },
  { pressure: 900, heightM: 988 },
  { pressure: 850, heightM: 1457 },
  { pressure: 800, heightM: 1949 },
  { pressure: 700, heightM: 3012 },
  { pressure: 600, heightM: 4206 },
  { pressure: 550, heightM: 4865 },
  { pressure: 500, heightM: 5574 },
  { pressure: 450, heightM: 6344 },
  { pressure: 400, heightM: 7185 },
  { pressure: 350, heightM: 8117 },
  { pressure: 300, heightM: 9164 },
  { pressure: 250, heightM: 10_363 },
  { pressure: 200, heightM: 11_784 },
];

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

/** ISA 对流层近似：海平面 15°C，递减率 6.5 K/km */
function isaTemperatureC(heightM: number): number {
  return 15 - 6.5 * (heightM / 1000);
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

  // 分层云量：低层偏多、高层偏少，且不超过总云量
  const cloudCoverLow = cloudCover.map((c) =>
    round2(clamp(c * (0.45 + rng() * 0.25), 0, 1)),
  );
  const cloudCoverMid = cloudCover.map((c, i) =>
    round2(clamp(c * (0.25 + rng() * 0.2) * (1 - cloudCoverLow[i] * 0.15), 0, 1)),
  );
  const cloudCoverHigh = cloudCover.map((c, i) =>
    round2(
      clamp(
        Math.max(0, c - cloudCoverLow[i] * 0.55 - cloudCoverMid[i] * 0.35) +
          c * (0.08 + rng() * 0.1),
        0,
        1,
      ),
    ),
  );

  // 能见度：4000–25000 m，与湿度反相关
  const visibility = humidity.map((rh) => {
    const base = 25000 - ((rh - 15) / 85) * 21000;
    return round2(clamp(base + (rng() - 0.5) * 1200, 4000, 25000));
  });

  // 气压：1008–1018 hPa 基线加全天线性趋势与微噪声
  const pBase = 1008 + rng() * 10;
  const pTrend = (rng() * 2 - 1) * 4;
  const pressure = hours.map((h) =>
    round2(pBase + pTrend * (h / 24) + (rng() - 0.5) * 0.6),
  );

  // 气溶胶光学厚度：标量 0–1
  const aod = round2(0.05 + rng() * 0.45);

  // AQI：晴天偏清洁，午后/傍晚可出现污染峰
  const pollutionCenter = 16 + rng() * 3;
  const pollutionPeak = 40 + rng() * 160;
  const pm25 = hours.map((h) => {
    const diurnalClean = 10 + 20 * (0.5 + 0.5 * Math.sin((2 * Math.PI * (h - 6)) / 24));
    const plume =
      pollutionPeak * Math.exp(-((h - pollutionCenter) ** 2) / (2 * (1.8 + rng() * 0.4) ** 2));
    return round2(clamp(diurnalClean + plume + (rng() - 0.5) * 4, 5, 280));
  });
  const pm10 = pm25.map((v) => round2(v * (1.4 + rng() * 0.5)));
  const o3 = hours.map((h) =>
    round2(clamp(30 + 50 * Math.max(0, diurnal(h)) + (rng() - 0.5) * 8, 10, 180)),
  );
  const no2 = hours.map((h) =>
    round2(
      clamp(
        18 + 22 * Math.exp(-((h - 8) ** 2) / 8) + 18 * Math.exp(-((h - 19) ** 2) / 10) + (rng() - 0.5) * 4,
        5,
        120,
      ),
    ),
  );
  const so2 = hours.map(() => round2(clamp(3 + rng() * 12, 1, 40)));
  const co = hours.map((h) =>
    round2(clamp(0.3 + pm25[h] * 0.004 + (rng() - 0.5) * 0.08, 0.15, 2.5)),
  );
  const usAqi = pm25.map((v) => {
    // 粗映射：以 PM2.5 为主导的 US AQI 近似
    if (v <= 12) return Math.round((v / 12) * 50);
    if (v <= 35.4) return Math.round(51 + ((v - 12.1) / (35.4 - 12.1)) * 49);
    if (v <= 55.4) return Math.round(101 + ((v - 35.5) / (55.4 - 35.5)) * 49);
    if (v <= 150.4) return Math.round(151 + ((v - 55.5) / (150.4 - 55.5)) * 49);
    return Math.round(clamp(201 + ((v - 150.5) / 100) * 99, 201, 400));
  });

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
    visibility,
    cloudCoverLow,
    cloudCoverMid,
    cloudCoverHigh,
    aqi: { usAqi, pm25, pm10, o3, no2, so2, co },
  };
}

/** 扩展气压面廓线：ISA 温度 + 小噪声；风速随高度增大；rh 随高度递减 */
export function mockAtmosProfile(seed: number, minutes = 480): AtmosProfile {
  const rng = mulberry32((seed ^ Math.round(minutes / 60)) >>> 0);
  const surfaceDir = 120 + rng() * 120;
  const levels: ProfilePoint[] = ISA_LEVELS.map((level, i) => {
    const tIsa = isaTemperatureC(level.heightM);
    const temperature = round2(tIsa + (rng() - 0.5) * 1.2);
    const windSpeed = round2(clamp(3 + i * 2.2 + (rng() - 0.5) * 1.5, 0.5, 55));
    const windDirection = round2((((surfaceDir + i * 8 + (rng() - 0.5) * 8) % 360) + 360) % 360);
    // 近地层 ~75%，对流层顶附近 ~15%，随高度近似线性递减
    const t = i / Math.max(1, ISA_LEVELS.length - 1);
    const rh = round2(clamp(75 - t * 60 + (rng() - 0.5) * 6, 5, 100));
    return {
      pressure: level.pressure,
      heightM: level.heightM,
      temperature,
      windSpeed,
      windDirection,
      rh,
    };
  });
  return { levels };
}

/**
 * 气候平均 mock：主日变化曲线上叠加 ±2°C 平滑偏移；降水为减弱版日变化。
 */
export function mockClimateNormals(seed: number): ClimateNormals {
  const day = mockDayData(seed);
  const rng = mulberry32((seed ^ 0x4e0d4e0d) >>> 0);
  const phase = rng() * Math.PI * 2;
  const amp = 1.2 + rng() * 0.8; // ≤ 2°C
  const temperature = day.temperature.map((t, h) =>
    round2(t + amp * Math.sin((2 * Math.PI * h) / 24 + phase)),
  );
  const precipitation = day.precipitation.map((p, h) =>
    round2(Math.max(0, p * 0.55 + 0.15 * Math.sin((2 * Math.PI * h) / 24 + phase * 0.7))),
  );
  return { temperature, precipitation, years: 10 };
}

/**
 * 多模式 mock：主序列 ± 模型特征噪声。
 * ECMWF 稳、GFS 飘、ICON 居中。
 */
export function mockMultiModel(
  variable: 'temperature' | 'precipitation',
  seed: number,
): MultiModelData {
  const day = mockDayData(seed);
  const base = variable === 'temperature' ? day.temperature : day.precipitation;
  const unit = variable === 'temperature' ? '°C' : 'mm';

  const makeSeries = (
    model: string,
    label: string,
    noiseScale: number,
    driftScale: number,
    modelSeed: number,
  ) => {
    const rng = mulberry32((seed ^ modelSeed) >>> 0);
    let drift = 0;
    const values = base.map((v, h) => {
      drift += (rng() - 0.5) * driftScale;
      drift *= 0.92;
      const noise = (rng() - 0.5) * noiseScale;
      const wobble = driftScale * 0.35 * Math.sin((2 * Math.PI * h) / 24 + rng());
      const next = v + noise + drift + wobble;
      return variable === 'precipitation' ? round2(Math.max(0, next)) : round2(next);
    });
    return { model, label, values };
  };

  return {
    variable,
    unit,
    series: [
      // ECMWF：低噪声、几乎无漂移
      makeSeries('ecmwf_ifs025', 'ECMWF', 0.25, 0.02, 0xec0f),
      // GFS：高噪声 + 明显漂移
      makeSeries('gfs_global', 'GFS', 1.4, 0.35, 0x9f5),
      // ICON：居中
      makeSeries('icon_global', 'ICON', 0.7, 0.12, 0x1c07),
    ],
  };
}
