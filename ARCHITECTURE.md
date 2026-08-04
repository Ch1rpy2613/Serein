所有新场景必须先读本文件

# Serein 架构契约

## 2. contracts.ts（全项目契约，字段名不得更改）

```ts
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
```

## 3. stores/time.ts

```ts
import { writable } from 'svelte/store';
export const currentTime = writable(480);  // 分钟 0–1440，默认 08:00
export const isPlaying = writable(false);
export const playSpeed = writable(1);      // 小时/秒，可选 0.5 / 1 / 4
```

播放推进逻辑后续在 TimeScrubber 实现，本任务只定义 store。

## 5. 设计 tokens（app.css :root，所有场景统一使用）

```
--bg: #05070a; --fg-1: rgba(255,255,255,.92); --fg-2: rgba(255,255,255,.45);
--line: rgba(255,255,255,.22); --accent: #7ec8ff;
```

字体栈 -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif；数字一律 font-variant-numeric: tabular-nums。

坐标轴规范：1px var(--line)；刻度文字 11px var(--fg-2)；时间刻度格式 "00:00"、"06:00"…，间隔 2 小时。
