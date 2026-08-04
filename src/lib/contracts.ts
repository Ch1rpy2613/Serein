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
}
export interface WeatherLayer {
  readonly id: string;
  readonly name: string;            // 中文名，用于场景切换器
  readonly preferredSkyDim: number; // 0–1，希望天空引擎压暗多少
  mount(container: HTMLElement): void;
  unmount(): void;                  // 必须释放 GL 上下文、取消 rAF、移除全部事件监听
  setTime(minutes: number): void;   // 0–1440，由全局 store 驱动
  setData(data: DayData): void;
  setQuality(q: 'low' | 'medium' | 'high'): void;
}
export const CITY = { name: '天津', lat: 39.10, lon: 117.20, tz: 'Asia/Shanghai' };
