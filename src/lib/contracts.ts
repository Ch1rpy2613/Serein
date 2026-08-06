// 数据：一天 25 个逐时点，索引 0 = 00:00，24 = 24:00
export interface DayData {
  date: string;            // ISO 日期
  temperature: number[];   // °C, 25 点
  dewPoint: number[];      // °C, 25 点
  humidity: number[];      // %, 25 点
  precipitation: number[]; // mm/h, 25 点
  windSpeed: number[];     // m/s, 25 点
  windDirection: number[]; // 度, 0=北 90=东, 25 点
  windGust: number[];      // m/s, 25 点
  cloudCover: number[];    // 0–1, 25 点
  pressure: number[];      // hPa, 25 点
  aod: number;             // 气溶胶光学厚度，标量 0–1
  visibility: number[];    // 米, 25 点
  cloudCoverLow: number[]; // 0–1, 25 点
  cloudCoverMid: number[];
  cloudCoverHigh: number[];
  aqi: {
    usAqi: number[];   // 25 点
    pm25: number[];    // μg/m³
    pm10: number[];
    o3: number[];
    no2: number[];
    so2: number[];
    co: number[];
  };
  uvIndex: number[];           // 25 点
  sunshineDuration: number[];  // 每小时日照秒数, 25 点
  astro: {
    sunrise: number;           // 分钟 0–1440
    sunset: number;
    moonrise: number | null;   // 当天可能无月出/月落 → null
    moonset: number | null;
    moonPhase: number;         // 0–1，0=新月 0.5=满月
    moonIllumination: number;  // 0–1
  };
  /** 土壤：全球有值；缺测时 null（勿硬造） */
  soil: {
    temp0_1: number[];      // °C，浅层（预报≈0cm / 历史≈0–7cm）
    temp1_3: number[];      // °C，次浅层（预报≈6cm / 历史≈7–28cm）
    moisture0_1: number[];  // %，0–1cm（历史≈0–7cm）
    moisture1_3: number[];  // %，1–3cm（历史≈7–28cm）
  } | null;
  /** 海洋：近海有值；内陆 / 全缺测 → null */
  marine: {
    sst: number[];        // °C 海表温度
    waveHeight: number[]; // m 浪高
  } | null;
  /** 花粉：CAMS 仅欧洲；缺字段或全 null → null */
  pollen: {
    alder: number[];    // 粒/m³
    birch: number[];
    grass: number[];
    mugwort: number[];
    olive: number[];
    ragweed: number[];
  } | null;
  apparentTemperature: number[];  // °C, 25 点
  surfacePressure: number[];      // hPa 站压, 25 点
  snowDepth: number[];            // cm, 25 点（Open-Meteo 返回 m，换算）
  snowfall: number[];             // cm/h, 25 点
  kpIndex: number | null;         // 当前行星 KP 指数（标量）
  minutely: { minutes: number; precipitation: number }[] | null; // 未来 2h 分钟级
}

export interface ProfilePoint {
  pressure: number;
  heightM: number;
  temperature: number;
  windSpeed: number;
  windDirection: number;
  rh: number;                 // 该层相对湿度 %
}

export interface SereinProfile {
  levels: ProfilePoint[]; // 按高度升序
}

/** 常年同日气候平均（25 点逐时） */
export interface ClimateNormals {
  temperature: number[];    // 25 点，常年同日逐时平均 °C
  precipitation: number[];  // 25 点 mm/h
  years: number;            // 参与平均的年数
}

export interface ModelSeries {
  model: string;
  label: string;
  values: number[];
}

export interface MultiModelData {
  variable: 'temperature' | 'precipitation';
  unit: string;
  series: ModelSeries[];
}

/** 全局城市（Phase 5）；坐标与时区驱动取数 / 天文 / 雷达中心 */
export interface City {
  name: string;
  lat: number;
  lon: number;
  tz: string;
}

/** 默认城市：天津（行为不变的基线） */
export const DEFAULT_CITY: City = {
  name: '天津',
  lat: 39.1,
  lon: 117.2,
  tz: 'Asia/Shanghai',
};

/**
 * @deprecated 使用 `DEFAULT_CITY` 或 `currentCity` store。保留别名以防旧代码编译断裂。
 */
export const CITY = DEFAULT_CITY;

/** 天气预警（AlertProvider 归一化后的应用内模型） */
export interface WeatherAlert {
  id: string;
  title: string;
  type: string; // 如 暴雨/大风/雷电
  level: 'blue' | 'yellow' | 'orange' | 'red';
  text: string;
  pubTime: number; // 发布 Epoch 秒
}

export interface WeatherLayer {
  readonly id: string;
  readonly name: string;            // 中文名，用于场景切换器
  readonly preferredSkyDim: number; // 0–1，希望天空引擎压暗多少
  /** true 时该场景独占垂直滑动手势 */
  readonly capturesVerticalPan?: boolean;
  mount(container: HTMLElement): void;
  unmount(): void;                  // 必须释放 GL 上下文、取消 rAF、移除全部事件监听
  setTime(minutes: number): void;   // 0–1440，由全局 store 驱动
  setData(data: DayData): void;
  setQuality(q: 'low' | 'medium' | 'high'): void;
  /** Phase 3：体感 / 分析模式；旧场景可不实现 */
  setMode?(mode: 'feel' | 'analysis'): void;
  /** Phase 3：气候平均幽灵曲线；旧场景可不实现 */
  setClimateNormals?(normals: ClimateNormals | null): void;
  /** Phase 3：气候平均首次拉取中（显示「计算气候平均…」） */
  setClimateLoading?(loading: boolean): void;
}
