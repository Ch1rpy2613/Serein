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
}

export interface ProfilePoint {
  pressure: number;
  heightM: number;
  temperature: number;
  windSpeed: number;
  windDirection: number;
  rh: number;                 // 该层相对湿度 %
}

export interface AtmosProfile {
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

export const CITY = { name: '天津', lat: 39.10, lon: 117.20, tz: 'Asia/Shanghai' };
