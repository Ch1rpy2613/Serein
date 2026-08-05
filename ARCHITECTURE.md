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
}
export interface ProfilePoint {
  pressure: number;
  heightM: number;
  temperature: number;
  windSpeed: number;
  windDirection: number;
}
export interface AtmosProfile {
  levels: ProfilePoint[]; // 按高度升序
}
export interface WeatherLayer {
  readonly id: string;
  readonly name: string;            // 中文名，用于场景切换器
  readonly preferredSkyDim: number; // 0–1，希望天空引擎压暗多少
  readonly capturesVerticalPan?: boolean; // true 时该场景独占垂直滑动手势
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

## 6. 数据层规范

实现：`src/lib/data/openmeteo.ts`（真实源）+ `src/lib/data/mock.ts`（离线兜底）。

### 数据源

| API | 用途 |
|-----|------|
| `https://api.open-meteo.com/v1/forecast` | 逐时地表气象 + 六层气压面廓线 |
| `https://air-quality-api.open-meteo.com/v1/air-quality` | 逐时 AQI / 污染物，合并进 `DayData.aqi` |

- 坐标与时区取自 `CITY`（天津 / Asia/Shanghai）
- `fetchDayData()`：forecast + air-quality 并行请求，截取当天 00:00–24:00 共 25 点
- `fetchProfile(minutes)`：取 1000/925/850/700/500/300 hPa 六层，距 `minutes` 最近整点，按 `heightM` 升序
- AOD 无免费直采：固定基线 `0.15` + 随 `cloudCover` 微调（代码内留 TODO）
- URL `?mock=1` 强制走 mock，不发起网络请求

### 缓存

- localStorage key：`serein:{城市名}:{ISO日期}:{数据类型}`
  - 日数据：`day`
  - 廓线：`profile:{整点小时}`
- TTL：**10 分钟**；命中有效缓存则不请求网络
- 本会话内同一 `日期 + 数据类型` 成功取过后，当天跨小时重复进入不再请求（可读过期缓存）
- 并发调用同一 key 会去重（in-flight Promise）

### 兜底

- 超时 **8s** / 离线 / HTTP 失败：指数退避重试，最多 **2** 次
- 仍失败：优先过期缓存 → 否则 `mockDayData` / `mockAtmosProfile`，并 `console.warn`
- 首屏先以 mock 占位，避免白屏；真实数据就绪后替换，Phase 1 场景无感切换
