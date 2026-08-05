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
  rh: number;                 // 该层相对湿度 %
}
export interface AtmosProfile {
  levels: ProfilePoint[]; // 按高度升序
}
export interface ClimateNormals {
  temperature: number[];    // 25 点，常年同日逐时平均 °C
  precipitation: number[];  // 25 点 mm/h
  years: number;            // 参与平均的年数
}
export interface ModelSeries { model: string; label: string; values: number[]; }
export interface MultiModelData { variable: 'temperature' | 'precipitation'; unit: string; series: ModelSeries[]; }
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
  setMode?(mode: 'feel' | 'analysis'): void; // Phase 3 可选
}
export const CITY = { name: '天津', lat: 39.10, lon: 117.20, tz: 'Asia/Shanghai' };
```

## 3. stores

### stores/time.ts

```ts
import { writable } from 'svelte/store';
export const currentTime = writable(480);  // 分钟 0–1440，默认 08:00
export const isPlaying = writable(false);
export const playSpeed = writable(1);      // 小时/秒，可选 0.5 / 1 / 4
```

播放推进逻辑后续在 TimeScrubber 实现，本任务只定义 store。

### stores/app.ts（Phase 3）

```ts
export const appMode = writable<'feel' | 'analysis'>('feel');
export const currentDate = writable<string>(/* 今天 ISO YYYY-MM-DD */);
```

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
| `https://api.open-meteo.com/v1/forecast` | 近几日逐时地表 + 气压面廓线 + 多模式（`models=`） |
| `https://archive-api.open-meteo.com/v1/archive` | ERA5 历史地表（气候平均 / 更早日期日数据） |
| `https://historical-forecast-api.open-meteo.com/v1/forecast` | 历史气压面廓线（ERA5 archive **不含**气压面变量） |
| `https://air-quality-api.open-meteo.com/v1/air-quality` | 逐时 AQI / 污染物，合并进 `DayData.aqi` |

- 坐标与时区取自 `CITY`（天津 / Asia/Shanghai）
- **日期路由**：目标日期在 **今天−5 天以内**（含今天/未来）→ 预报 API（`past_days`）；**更早** → 历史 archive（ERA5）
- `fetchDayData(date?)`：按路由取 forecast/archive + air-quality，截取目标日 00:00–24:00 共 25 点；默认今天
- `fetchProfile(minutes, date?)`：17 层气压面（1000…200 hPa）+ 每层 `rh`；预报窗走 forecast，更早走 Historical Forecast
- `fetchClimateNormals(date)`：同一日历日向前 10 年 ERA5 逐时平均 → `ClimateNormals`
- `fetchMultiModel(variable)`：今日 25 点，模型 ID `ecmwf_ifs025` / `gfs_global` / `icon_global`
- archive 不支持的地表变量（如 `visibility`）从请求剔除，缺测相邻插值 / 湿度反推兜底
- AOD 无免费直采：固定基线 `0.15` + 随 `cloudCover` 微调（代码内留 TODO）
- URL `?mock=1` 强制走 mock，不发起网络请求

### 缓存

| 数据类型 | TTL | key |
|----------|-----|-----|
| 预报 / 近几日（today−5…today）日数据、廓线、多模式 | **10 分钟** | `serein:{城市}:{ISO日期}:{类型}` |
| 历史（archive / historical-forecast）日数据、廓线 | **1 天** | 同上 |
| 气候平均 | **永久**（不过期） | `normals-{城市}-{MMDD}` |

- 日数据：`day`；廓线：`profile:{整点小时}`；多模式：`multimodel:{variable}`
- 命中有效缓存则不请求网络
- 本会话内同一 `日期 + 数据类型` 成功取过后，跨小时重复进入不再请求（可读过期缓存）
- 并发调用同一 key 会去重（in-flight Promise）

### 兜底

- 超时 **8s** / 离线 / HTTP 失败：指数退避重试，最多 **2** 次
- 仍失败：优先过期缓存 → 否则 `mockDayData` / `mockAtmosProfile` / `mockClimateNormals` / `mockMultiModel`，并 `console.warn`
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

## 9. 分析模式规范

同一 App 两套信息密度：`feel`（感受，默认）给大众；`analysis`（分析）给进阶用户。全局 store：`appMode`（`stores/app.ts`）。

### 入口手势

| 路径 | 行为 |
|------|------|
| 移动端长按 | 场景区域（非 `[data-scene-swipe-ignore]`）长按 **600ms** 切换；位移 **>10px** 立即取消；与拖曲线 / 滑场景锁冲突时取消，不触发切场 |
| 桌面键盘 | 按 **A**（忽略输入框内） |
| 模式胶囊 | 右上角常驻「感受 / 分析」；11px `--fg-2`，当前项 `--fg-1` + `--accent` 下划线，点击切换 |

切换密度动画 **400ms**：感受装饰降透明，分析元素（网格、数值标注）淡入。天空引擎 `uDim` 在分析模式相对当前场景 `preferredSkyDim` **+0.1**（上限 1）。

### 排版密度规则

| | 感受模式 | 分析模式 |
|--|----------|----------|
| 字号 | 遵循 §5（轴刻度 11px 等）；**禁止** 9px 级标注与网格线 | 允许 **9px** `--fg-2` 数值标注与网格线 |
| 装饰 | 粒子光晕、热浪、雾气、大号读数等可完整呈现 | 上述装饰应降透明；网格 / 极值 / 副轴等分析层淡入 |
| 残留 | — | 切回感受后须无任何分析元素残留 |

### `setMode` 契约

```ts
setMode?(mode: 'feel' | 'analysis'): void; // WeatherLayer 可选
```

- App / `LayerHost` / `LazyWeatherLayer` 在模式变化时调用；**未实现则忽略，不报错**
- 场景在 `setMode` 内切换自身分析叠加；密度过渡建议 400ms
- 示范：`temperature`（25 点标注 + Y 网格 + 极值标记）、`precipitation`（累计副轴 mm + 各小时数值）
- 分析模式下场景切换器追加专属入口占位（探空、对比）；未实现场景显示「即将上线」，hover 提示、点击无响应

### 日期导航与气候平均（幽灵曲线）

- TimeScrubber 右侧日期：今天点击弹出「今天 / 昨天 / 前天」+ `<input type="date">`（`1940-01-01`…今天）；非今天为历史模式（`--accent` + 前缀「历史 ·」），点击一键回今天
- 写 `currentDate` → `fetchDayData` / `fetchClimateNormals` → 全场景 `setData` / `setClimateNormals`，250ms 交叉淡入
- `WeatherLayer` 可选：`setClimateNormals?(normals)`、`setClimateLoading?(loading)`
- 温度：主曲线后方虚线幽灵曲线（可图例开关）+ 距平读数；降水：雨幕后淡色柱状轮廓；首次计算显示「计算气候平均…」，`normals-{城市}-{MMDD}` 永久缓存
- 历史模式：雷达提示历史回波暂缺并切最近帧；剖面按日期取廓线；对比入口提示「历史模式下暂不可用」
