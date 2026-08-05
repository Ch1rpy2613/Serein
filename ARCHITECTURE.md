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

## 7. 场景清单

剖面模式**不进**场景切换器，仅通过垂直手势进入。切换器为五个文字标签 + 末尾雷达地图图标。

| id | 名称 | 渲染 | 懒加载 chunk | preferredSkyDim | 备注 |
|----|------|------|--------------|-----------------|------|
| `temperature` | 温度 | Three.js | `TemperatureLayer`（含 `three`） | 0.55 | 曲线纵向拖拽：`data-scene-vertical-drag` |
| `precipitation` | 降水 | Three.js | `PrecipitationLayer` | 0.85 | |
| `wind` | 风 | WebGL 粒子 | `WindLayer`（轻量，默认首屏） | 0.6 | |
| `humidity` | 湿度 | Canvas / WebGL | `HumidityLayer` | 0.5 | |
| `aqi` | 空气 | Canvas / DOM | `AqiLayer` | 0.7 | |
| `radar` | 雷达 | MapLibre + RainViewer | `RadarLayer` + `maplibre-gl` | 1 | `capturesVerticalPan`；切换器图标入口 |
| `profile` | 剖面 | WebGL / DOM | 随 App 常驻（非切换器） | 见层内 | 上滑进入 / 下滑退出 |

天空引擎 `SkyLayer` 常驻底层；所有 `WeatherLayer` 必须实现 `setQuality('low'|'medium'|'high')`。全局 `PerformanceGovernor`（`src/lib/perf.ts`）按 fps 下调/回升质量，覆盖全部场景。

分包约束：`maplibre-gl` 与雷达场景不得进入首屏；首屏 gzip JS **小于 250KB**（Vite `manualChunks` 固定 `maplibre-gl` / `three`）。

署名（TimeScrubber 小字）：`Weather data © Open-Meteo (CC-BY 4.0) · Radar © RainViewer · Map © OpenStreetMap © CARTO`

## 8. 手势仲裁（App 壳层，capture 阶段）

锁定期：**起始 12px** 位移后按主方向判定，之后整段手势不再改判。

优先级（高 → 低）：

1. **chrome / 忽略区**：`[data-scene-swipe-ignore]`（时间轴、切换器、雷达地图根节点等）— App 不接管。
2. **场景内纵向拖拽**：起点在 `[data-scene-vertical-drag]`（如温度曲线编辑）且主方向为纵向 → 让给场景，不触发剖面/切场。
3. **`capturesVerticalPan`**：当前场景为 `true`（雷达）时，纵向手势全部让给场景；不可上滑进剖面。
4. **剖面进入**：起点在屏幕**下半部分**、主方向为纵向上滑，且未命中 2/3 → 进入剖面模式。
5. **场景切换**：主方向为水平滑动 → 在切换器场景序列间切页（含雷达索引；剖面激活时禁用）。

水平 / 纵向判定阈值：主轴位移大于副轴 × 1.15。剖面进入距离阈值约 80px。首次进入 App 底部展示一次「上滑穿过大气层 ↑」（`localStorage` key：`serein:profile-guide-seen`）。
