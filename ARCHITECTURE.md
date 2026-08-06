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
  /** 土壤 / 海洋 / 花粉：可空；无数据时场景卡片整体隐藏，勿硬造 */
  soil: {
    temp0_1: number[]; temp1_3: number[];
    moisture0_1: number[]; moisture1_3: number[];
  } | null;
  marine: { sst: number[]; waveHeight: number[] } | null;
  pollen: {
    alder: number[]; birch: number[]; grass: number[];
    mugwort: number[]; olive: number[]; ragweed: number[];
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

/** 全局城市（Phase 5） */
export interface City { name: string; lat: number; lon: number; tz: string; }
export const DEFAULT_CITY: City = { name: '天津', lat: 39.10, lon: 117.20, tz: 'Asia/Shanghai' };
/** @deprecated 使用 DEFAULT_CITY 或 currentCity store；保留别名以防旧代码编译断裂 */
export const CITY = DEFAULT_CITY;

/** 天气预警（AlertProvider 归一化） */
export interface WeatherAlert {
  id: string; title: string; type: string;
  level: 'blue' | 'yellow' | 'orange' | 'red';
  text: string; pubTime: number; // Epoch 秒
}
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

### stores/app.ts（Phase 3 + Phase 5）

```ts
export const appMode = writable<'feel' | 'analysis'>('feel');
export const currentDate = writable<string>(/* 当前城市时区今日 ISO YYYY-MM-DD */);
export const currentCity = writable<City>(DEFAULT_CITY);
export const savedCities = writable<City[]>([DEFAULT_CITY]); // localStorage: serein:saved-cities / serein:current-city
```

- `currentTime` 语义始终为**当地**分钟 0–1440（时区变化不改语义）
- `currentCity` 变化 → 清空当前数据 → `fetchDayData` / `fetchClimateNormals`（带 city）→ 全场景 `setData`；雷达重设视野；天空 / 日照 / 月相读 `currentCity` 经纬度
- 城市切换时预警 / 台风走同源代理；代理 503 或会话已禁用则不再打和风（见 §6 AlertProvider）
- 天津为保底城市，不可从 `savedCities` 删除；列表至少保留一座

## 5. 设计 tokens（app.css :root，所有场景统一使用）

```
--bg: #0a121c; --fg-1: rgba(236,242,248,.94); --fg-2: rgba(168,190,210,.58);
--line: rgba(170,200,220,.16); --accent: #a8d4e8;
--chrome / --chrome-strong / --scrim：壳层玻璃；--font-ui: Outfit + 中文无衬线；--font-display: Fraunces
```

字体栈见 `app.css`；数字一律 font-variant-numeric: tabular-nums。

坐标轴规范：1px var(--line)；刻度文字 11px var(--fg-2)；时间刻度格式 "00:00"、"06:00"…，间隔 2 小时。

## 6. 数据层规范

实现：`src/lib/data/openmeteo.ts`（真实源）+ `src/lib/data/mock.ts`（离线兜底）。

### 数据源

| API | 用途 |
|-----|------|
| `https://api.open-meteo.com/v1/forecast` | 近几日逐时地表 + 土壤 + 气压面廓线 + 多模式（`models=`） |
| `https://archive-api.open-meteo.com/v1/archive` | ERA5 历史地表 / 土壤（气候平均 / 更早日期日数据） |
| `https://historical-forecast-api.open-meteo.com/v1/forecast` | 历史气压面廓线（ERA5 archive **不含**气压面变量） |
| `https://air-quality-api.open-meteo.com/v1/air-quality` | 逐时 AQI / 污染物 / 花粉（CAMS 欧洲），合并进 `DayData.aqi` / `pollen` |
| `https://marine-api.open-meteo.com/v1/marine` | 海表温度 / 浪高 → `DayData.marine`；内陆全缺测 → `null` |
| NOAA SWPC planetary K-index | `DayData.kpIndex`；直连失败走 `GET /api/swpc/kp`（3h 缓存） |
| 和风 `/v7/minutely/5m`（经 `/api/qweather`） | `DayData.minutely`；无 key/无数据 → `null` |

- 坐标与时区取自参数 `city`（默认 `DEFAULT_CITY` = 天津 / Asia/Shanghai）；**勿再硬编码 `CITY`**
- **日期路由**：目标日期在 **今天−5 天以内**（含今天/未来）→ 预报 API（`past_days`）；**更早** → 历史 archive（ERA5）
- `fetchDayData(date?, city?)`：按路由取 forecast/archive + air-quality，截取目标日 00:00–24:00 共 25 点；默认今天 + `DEFAULT_CITY`
- `fetchProfile(minutes, date?, city?)`：17 层气压面（1000…200 hPa）+ 每层 `rh`；预报窗走 forecast，更早走 Historical Forecast
- `fetchClimateNormals(date, city?)`：同一日历日向前 10 年 ERA5 逐时平均 → `ClimateNormals`
- `fetchMultiModel(variable, city?)`：今日 25 点，模型 ID `ecmwf_ifs025` / `gfs_global` / `icon_global`
- 城市搜索：Open-Meteo Geocoding `https://geocoding-api.open-meteo.com/v1/search?name={词}&count=8&language=zh&format=json`（`src/lib/data/geocode.ts`，输入防抖 300ms）
- archive 不支持的地表变量（如 `visibility`、`uv_index`）从请求剔除，缺测相邻插值 / 湿度反推 / 太阳高度角近似兜底
- 预报 hourly 含 `uv_index`、`sunshine_duration`、土壤（`soil_temperature_0cm`/`6cm` + `soil_moisture_0_to_1cm`/`1_to_3cm`）；daily 含 `sunrise`/`sunset`（ISO → 本地分钟写入 `DayData.astro`）
- 历史 archive 土壤深度带不同（`0_to_7cm` / `7_to_28cm`），映射进同一 `DayData.soil` 字段；湿度存 **%**（m³/m³×100）
- 海洋：同城经纬度 + `cell_selection=sea`；当日切片无有限值 → `marine = null`（不抛错）
- 花粉：air-quality hourly 加六种 `*_pollen`；响应缺字段或全日全 null → `pollen = null`（不抛错；欧洲以外常见）
- 月相 / 月出月落 / 月照由本地 `src/lib/astro` 计算并写入 `DayData.astro`（API 不提供）
- AOD 无免费直采：固定基线 `0.15` + 随 `cloudCover` 微调（代码内留 TODO）
- URL `?mock=1` 强制走 mock，不发起网络请求

### 数据覆盖清单

原则：**契约留字段、无数据自动隐藏，不为弱数据硬造场景。**

| 数据 | 契约字段 | 覆盖 | 备注 |
|------|----------|------|------|
| 温度 / 露点 / 湿度 / 降水 | `temperature`… | ✅ | 预报 + archive |
| 风（速/向/阵风） | `windSpeed`… | ✅ | |
| 云量（总/低/中/高） | `cloudCover*` | ✅ | |
| 气压 / 能见度 | `pressure` / `visibility` | ✅ | archive 能见度湿度反推 |
| AQI / 六项污染物 | `aqi` | ✅ | air-quality API |
| UV / 日照秒数 | `uvIndex` / `sunshineDuration` | ✅ | archive UV 太阳高度近似 |
| 天文 | `astro` | ✅ | 日出日落 API + 本地月相库 |
| 气压面廓线 | `SereinProfile` | ✅ | 历史走 Historical Forecast |
| 气候平均 | `ClimateNormals` | ✅ | 10 年 ERA5 |
| 多模式 | `MultiModelData` | ✅ | ECMWF / GFS / ICON |
| 土壤温湿度 | `soil` | ✅ | 全球；层深预报/历史映射见上 |
| 海表温度 / 浪高 | `marine` | ✅ | 近海有值；内陆 `null` 隐藏 |
| 花粉（六种） | `pollen` | ✅ | CAMS 欧洲；域外 `null` 隐藏 |
| 天气预警 | `WeatherAlert` | ✅ | 和风；无 key 静默 |
| 台风 | TyphoonProvider | ✅ | 和风 → 浙江水利代理 |
| 潮汐 | TideProvider | ✅ | 和风 Ocean；内陆 `null` |
| 雷达回波 | RadarLayer | ✅ | RainViewer（懒加载 maplibre） |
| 卫星真彩色 | RadarLayer 卫星层 | ✅ | **NASA GIBS** 真彩色（`VIIRS_SNPP_CorrectedReflectance_TrueColor`）；**延迟数小时，非实时云图**；无 key / CORS 开放；实时云图（FY-4 / Himawari）TODO |
| 雷电 / 潜势闪光 | 降水场景 + 预警 sheet | ✅ | **CAPE 潜势驱动视觉**（非真实监测；无免费实时雷电源）；设置可关「潜势驱动」 |
| 体感温度 / 站压 | `apparentTemperature` / `surfacePressure` | ✅ | Open-Meteo hourly；体感读数 / 海站压并排 |
| 积雪深 / 降雪 | `snowDepth` / `snowfall` | ✅ | depth m→cm；snowfall cm；环境页积雪卡 |
| KP 指数 | `kpIndex` | ✅ | SWPC；失败 `null`；月相 / 环境页按阈值显隐 |
| 分钟级降水 | `minutely` | ✅ | 和风 5m；失败 `null`；降水分析顶条 |
| Köppen 分类 | `lookupKoppen(lat,lon)` | ✅ | 本地 1° 网格，零请求；城市选择器标签 |
| 湿球 / 位温 / K 指数 | `src/lib/atmosphere.ts` | ✅ | 纯函数 + vitest；Skew-T / 湿度分析 |
| 空间剖面 | `XSectionLayer` | ✅ | 两点大圆 7 点廓线；分析专属、懒加载；关闭回雷达 |

### 大气派生量 `src/lib/atmosphere.ts`

| 函数 | 说明 |
|------|------|
| `wetBulb(T, RH)` | Stull (2011) 经验湿球 °C |
| `potentialTemperature(T, pressureHpa)` | Poisson 位温 °C |
| `kIndex(profile)` | K = T850−T500+Td850−(T700−Td700)；Td 用 Magnus |

Köppen：`scripts/fetch-koppen.mjs` → `src/lib/data/koppen-grid.json`（Beck et al. 2018 CC-BY 4.0；运行时 `lookupKoppen`）。

### 天文库 `src/lib/astro/`（纯函数，可单测）

| 模块 | 职责 |
|------|------|
| `sun.ts` | `solarPosition`（NOAA，自 SkyLayer 迁入；原路径兼容 re-export）、`sunriseSunset`、`isAstronomicalNight` |
| `moon.ts` | `moonPhase` / `moonIllumination` / `moonPosition` / `moonriseMoonset`（10 分钟扫高度角过零） |
| `milkyway.ts` | `galacticCenterAlt`（银心 RA 17h45.6m / Dec −29°）、`galacticWindow`（天文昏影 + 银心 >15° + 月照 <0.3 或月在地平下） |
| `index.ts` | 统一导出 + `computeAstro(date)` 组装 `DayData.astro` |

锚点测试（`vitest`）：2024-01-11 新月、2024-01-25 满月（±0.02）；天津 8 月夜晚 `galacticWindow` 非空、1 月全日 null。

### 缓存

| 数据类型 | TTL | key |
|----------|-----|-----|
| 预报 / 近几日（today−5…today）日数据、廓线、多模式 | **10 分钟** | `serein:{城市名}:{lat,lon}:{ISO日期}:{类型}` |
| 历史（archive / historical-forecast）日数据、廓线 | **1 天** | 同上 |
| 气候平均 | **永久**（不过期） | `normals-{城市名}-{MMDD}` |

- 城市维度以 `City.name` + 坐标两位小数写入 key（例：`serein:天津:39.10,117.20:2026-08-05:day`、`normals-上海-0805`）；空间剖面任意采样点可复用廓线缓存
- 日数据：`day`；廓线：`profile:{整点小时}`；多模式：`multimodel:{variable}`
- 命中有效缓存则不请求网络
- 本会话内同一 `城市 + 坐标 + 日期 + 数据类型` 成功取过后，跨小时重复进入不再请求（可读过期缓存）
- 并发调用同一 key 会去重（in-flight Promise）

### 兜底

- 超时 **8s** / 离线 / HTTP 失败：指数退避重试，最多 **2** 次
- 仍失败：优先过期缓存 → 否则 `mockDayData` / `mockSereinProfile` / `mockClimateNormals` / `mockMultiModel`，并 `console.warn`
- 首屏先以 mock 占位，避免白屏；真实数据就绪后替换，Phase 1 场景无感切换

### AlertProvider（天气预警，`src/lib/data/alerts.ts`）

契约模型见 `contracts.ts`：

```ts
export interface WeatherAlert {
  id: string;
  title: string;
  type: string;       // 如 暴雨/大风/雷电
  level: 'blue' | 'yellow' | 'orange' | 'red';
  text: string;
  pubTime: number;    // 发布 Epoch 秒
}

export interface AlertProvider {
  readonly id: string;
  fetchAlerts(city: City): Promise<WeatherAlert[]>;
}
```

| 项 | 约定 |
|----|------|
| 和风实现 | 浏览器只打同源 `GET /api/qweather/v7/warning/now?location={lon},{lat}`；由 `server/`（Hono · `127.0.0.1:8787`）转发 `https://{QWEATHER_HOST}/v7/...` 并加 `X-QW-Api-Key`（密钥仅在 `server/.env`，**不得**出现在前端 bundle） |
| `level` | 从 `title` 解析（蓝 / 黄 / 橙 / 红） |
| 静默禁用 | 代理返回 **503**（服务端无 secret）或 HTTP/业务码 401/403 → 本会话禁用，返回 `[]`，**不抛错** |
| 缓存 | TTL **10 分钟**，key `serein:alerts:{城市名}`；`currentCity` 变化重取 |
| Mock | URL `?mockAlerts=1` → 固定红色暴雨预警，不依赖 key（与 `?mock=1` 天气 mock 独立） |
| UI | `AlertBanner`：TimeScrubber 上方横幅（级别色描边 + 圆点 + 标题，多条 5s 轮播）→ 详情 sheet（全文 / 发布时间 / 防御指南）→ 下滑关闭；同 id **24h** 内手动关闭不再现（`serein:alert-dismissed:{id}`） |
| 角标 | `navigator.setAppBadge?.(count)`；清零时 `clearAppBadge`；不支持则跳过 |
| 雷暴潜势 | **零预警 API**：`indices.ts` CAPE + `DayData.precipitation` 推导当日降水概率；四档 CAPE `<400` / `400–1000` / `1000–2500` / `>2500` → 弱 / 中 / 强 / 极强；详情 sheet 底部常驻，标注「由 CAPE 推导」 |

### TyphoonProvider（台风，`src/lib/data/typhoon.ts`）

| 项 | 约定 |
|----|------|
| 实现 A（首选） | 同源 `GET /api/qweather/v7/tropical/storm-list?basin=NP&year={年}` → `storm-track` / `storm-forecast`（服务端注入 `X-QW-Api-Key`） |
| 实现 B | 浙江水利公开源 `typhoon.slt.zj.gov.cn/Api`（常量可换），经 `functions/api/typhoon/[[path]].ts` 代理；本地 Vite `server.proxy` `/api/typhoon` 等价 |
| 降级 | 代理 503 / 401/403 → B；两路皆失败 / 无活跃 → `[]`，**不抛错** |
| Mock | `?mockTyphoon=1` → 固定「灿都」强台风（路径 / 锥 / 风圈） |
| 缓存 | TTL **5 分钟**，key `serein:typhoons:active` |
| UI | 场景内独立 mini 时间轴（默认 4× 循环）；不占用全局 `currentTime`；城市切换不重取 |

### TideProvider（潮汐，`src/lib/data/tide.ts`）

| 项 | 约定 |
|----|------|
| 端点 | POI `GET /api/qweather/geo/v2/poi/lookup?type=TSTA` → `GET /api/qweather/v7/ocean/tide?location={站ID}&date=yyyyMMdd`（官方路径，经同源代理） |
| 归一化 | `TideData { hourly, extrema }`；`minutes` 为当地 0–1440；`type: 'high'\|'low'` |
| 空数据 | 无近海站（>100km）/ 接口无数据 / 503·401·403 → `null`，不抛错；切换器入口 **50%** 透明可点；场景空态「该城市无潮汐数据」 |
| Mock | `?mockTide=1` → 半日潮近似曲线 |
| 缓存 | TTL **10 分钟**，key `serein:tide:{城市}:{日期}` + 站点 `serein:tide-station:{城市}` |
| UI | `TideLayer`：上半引力示意（`moonPosition` 绕转 + 双凸水圈）+ 下半 24h 潮位曲线；分析：未来 3 天满潮/干潮表 |

### 后端 `server/`（Node · Hono · SQLite）

| 项 | 约定 |
|----|------|
| 入口 | `server/src/index.ts`，监听 **`127.0.0.1:8787`**（tsx；`dev` = watch） |
| 密钥 | `server/.env`：`QWEATHER_KEY` / `QWEATHER_HOST`（`chmod 600`，gitignored） |
| 代理 | `GET /api/qweather/*` → 上游 + `Cache-Control` 5–10 分钟；secret 缺失 → **503 JSON**；`GET /api/typhoon/*` → 浙江水利（自托管，路径白名单同 Pages Function） |
| DB | `server/data/serein.db`（better-sqlite3）；启动按 `migrations/` 顺序执行，记入 `_migrations` |
| 安全 | `/api/*` 响应加 `X-Content-Type-Options: nosniff`；**不**写 `Access-Control-Allow-Origin`；同 IP **60 次/分** 内存限流 |
| 本地前端 | Vite `server.proxy`：`/api/qweather` · `/api/push` · `/api/sync` → `http://127.0.0.1:8787`；`/api/typhoon` → 浙江水利（开发）/ 生产经 Node |
| 生产 | 见 **§11**（Caddy · systemd · `scripts/deploy.sh` · 备份） |
| Push | `POST /api/push/subscribe` upsert `push_subscriptions`（endpoint PK，`last_seen`）；`POST /api/push/unsubscribe` 按 endpoint 删；endpoint 须 **https** |
| 定时推送 | 进程内 `server/src/jobs/alertPush.ts`：启动后 **30s** 首跑 + `setInterval` **15min**；去重城市 → 和风 `warning/now` → 与 `pushed_alerts` diff → 命中级别则 `web-push` 发送 |
| 推送文案 | `title` = 预警标题；`body` = 正文前 80 字；`url` = `/?alert={id}` |
| 失败 | 单城市拉取失败跳过；连续 3 轮全失败 `console.error`（TODO: 邮件/Webhook）；发送 410/404 → 删订阅 |
| 密钥 | `server/.env`：`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`；前端仅 `VITE_VAPID_PUBLIC_KEY` |
| 跨设备同步 | `POST /api/sync/create` → 8 位码（字符集 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`）+ 初始 payload；`GET/PUT /api/sync/:code` 乐观锁 `version`；冲突 **409**；payload 小于 64KB JSON，服务端不解析字段；sync 路由同 IP **30 次/分**；响应 `Cache-Control: no-store`；表 `sync_states` |
| 迁移 | `0002_pushed_alerts.sql`：`pushed_alerts(alert_id TEXT PRIMARY KEY, pushed_at INTEGER)`；WAL 模式 |

### 跨设备同步（前端）

| 项 | 约定 |
|----|------|
| 凭证 | 8 位同步码即凭证，无账号；`localStorage` key `serein:sync-code` / `serein:sync-version` |
| payload | `{ savedCities, currentCity, dismissedAlertIds, audioPrefs, qualityOverride, pushLevels }`（不含位置轨迹） |
| UI | 设置区「跨设备同步」：生成码（4-4 等宽展示 + 复制）／输入码恢复／隐私小字 |
| 上传 | 有码时相关 store 变化防抖 **5s** `PUT`；409 → 提示后 GET 覆盖本地 |
| 启动 | 有码则 `GET` 比对 version，云端新则覆盖 +「已从云端恢复」 |
| 代理 | Vite `server.proxy`：`/api/sync` → `http://127.0.0.1:8787` |

### Web Push（`src/lib/push/subscribe.ts` + `public/sw.js` + `server/`）

| 项 | 约定 |
|----|------|
| Service Worker | 手写 `public/sw.js`（无 Workbox）；`main.ts` 注册；`install` → `skipWaiting`，`activate` → `clientsClaim` + 删旧 `CACHE_VERSION` |
| 缓存 | HTML **network-first**；同源静态 **stale-while-revalidate**；`/api/*` **不缓存**（数据层 localStorage） |
| push | payload JSON：`title` / `body` / `icon` / `url` → `showNotification`，`data.url` 默认 `/?alert=1`；服务端下发 `/?alert={id}` |
| notificationclick | 聚焦已有窗口并 `postMessage({ type: 'serein:open-alert' })`，否则 `openWindow`；App 展开预警 sheet |
| 订阅 | `Notification.requestPermission` → `serviceWorker.ready` → `pushManager.subscribe({ applicationServerKey: VITE_VAPID_PUBLIC_KEY })` → `POST /api/push/subscribe` `{ subscription, city, levels }` |
| 级别 | 默认可勾选 `yellow` / `orange` / `red`；本地 key `serein:push-subscription` |
| 退订 | 设置区关闭 → `unsubscribe` + `POST /api/push/unsubscribe` |
| 对账 | 启动时 `getSubscription` 与本地记录比对，不一致以浏览器为准重新上报 |
| iOS | 非 standalone → 引导「添加到主屏幕」；无 `PushManager` → 入口置灰「不支持」 |
| UI | 预警详情 sheet 底「开启预警推送」；右下 chrome 齿轮 → 设置 sheet |
| 密钥 | 仅 `VITE_VAPID_PUBLIC_KEY`（公钥）；私钥不下发前端 |
| 本地 mock | `server/.env` 设 `ALERT_PUSH_MOCK=1` 可跳过和风注入橙色 mock 预警（验收用） |

## 7. 场景清单

剖面模式**不进**场景切换器，仅通过垂直手势进入。切换器为横向滚动条带（`scroll-snap` 磁吸，当前项居中），分组：气象组（温度 / 降水 / 风 / 湿度 / 空气 / 能见度 / 气压）｜ 天空组（日照 / 月相 / 潮汐）｜ 雷达 ｜ 台风；分析模式追加探空 / 对比 / 环境。

| id | 名称 | 渲染 | 懒加载 chunk | preferredSkyDim | 备注 |
|----|------|------|--------------|-----------------|------|
| `temperature` | 温度 | Three.js | `TemperatureLayer`（含 `three`） | 0.55 | 曲线纵向拖拽：`data-scene-vertical-drag` |
| `precipitation` | 降水 | Three.js | `PrecipitationLayer` | 0.85 | |
| `wind` | 风 | WebGL 粒子 | `WindLayer`（轻量，默认首屏） | 0.6 | |
| `humidity` | 湿度 | Canvas / WebGL | `HumidityLayer` | 0.5 | |
| `aqi` | 空气 | Canvas / DOM | `AqiLayer` | 0.7 | |
| `visibility` | 能见度 | Canvas2D | `VisibilityLayer` | 0.4 | 分析：逐时迷你折线；地标 Path2D 缓存 |
| `pressure` | 气压 | Canvas2D | `PressureLayer` | 0.5 | 分析：24h 气压副图 |
| `sunlight` | 日照 | Canvas2D | `SunlightLayer` | 0.15 | 分析：日照累计 / 日出日落 |
| `moon` | 月相 | Canvas2D | `MoonLayer` | 0 | 分析：未来 7 天月相；月球纹理模块缓存 |
| `tide` | 潮汐 | Canvas2D | `TideLayer` | 0.3 | 和风 Ocean；引力示意 + 潮位曲线；内陆入口 50% 透明；分析：未来 3 天潮汐表 |
| `radar` | 雷达 | MapLibre + RainViewer / GIBS 卫星 | `RadarLayer` + `maplibre-gl` + `lib/data/gibs.ts` | 1 | `capturesVerticalPan`；顶部分段「雷达｜卫星」；偏好 `serein:radar-map-overlay` |
| `typhoon` | 台风 | MapLibre | `TyphoonLayer`（共用 `maplibre-gl` chunk） | 1 | `capturesVerticalPan`；无活跃时入口 50% 透明可点；场景内独立回放轴 |
| `sounding` | 探空 | Canvas2D | `SoundingLayer`（分析专属） | 0.9 | |
| `models` | 对比 | Canvas2D | `ModelsLayer`（分析专属） | 0.75 | |
| `envdata` | 环境 | DOM 卡片 | `EnvDataLayer`（分析专属） | 0.8 | 土壤 / 海洋 / 花粉；空数据卡片不渲染 |
| `profile` | 剖面 | WebGL / DOM | 随 App 常驻（非切换器） | 见层内 | 上滑进入 / 下滑退出（单点垂直） |
| `xsection` | 空间剖面 | Canvas2D | `XSectionLayer`（分析专属） | 1 | 雷达「切剖面」选两点大圆；7 点 `fetchProfile`；关闭回地图 |

天空引擎 `SkyLayer` 常驻底层；所有 `WeatherLayer` 必须实现 `setQuality('low'|'medium'|'high')`。全局 `PerformanceGovernor`（`src/lib/perf.ts`）按 fps 下调/回升质量，覆盖全部场景。白噪音模式为纯 UI：进入时 `setSamplingEnabled(false)`，帧率**不**纳入质量降级。

分包约束：`maplibre-gl` 与雷达 / 台风场景不得进入首屏；雷达与台风共用单一 `maplibre-gl` chunk；首屏 gzip JS **小于 250KB**（Vite `manualChunks` 固定 `maplibre-gl` / `three`）。**GIBS 瓦片**仅在雷达场景切到「卫星」后请求；**空间剖面**为独立懒加载 chunk，选点后才 `fetchProfile`——二者均不进首屏。Cloudflare Pages Function（`functions/`）仅运行时代理，**不**参与 Vite 静态构建。Lighthouse Mobile 四项目标 **≥ 85**。

署名（TimeScrubber 小字）：`Weather data © Open-Meteo (CC-BY 4.0) · Tide © QWeather · Radar © RainViewer · Map © OpenStreetMap © CARTO · Typhoon`

## 8. 手势仲裁（App 壳层，capture 阶段）

锁定期：**起始 12px** 位移后按主方向判定，之后整段手势不再改判。

优先级（高 → 低）：

1. **chrome / 忽略区**：`[data-scene-swipe-ignore]`（时间轴、切换器、雷达地图根节点等）— App 不接管。
2. **长按切模式**（仅 touch / pen）：场景区域按下后 **600ms** 切换 `feel` ↔ `analysis`；位移 **>10px** 立即取消长按；一旦与场景内拖拽 / 剖面进入 / 水平切场锁定冲突则取消，不触发切场。桌面用 **A** 键或右上角模式胶囊。
3. **场景内纵向拖拽**：起点在 `[data-scene-vertical-drag]`（如温度曲线编辑）且主方向为纵向 → 让给场景，不触发剖面/切场。
4. **`capturesVerticalPan`**：当前场景为 `true`（雷达 / 台风）时，纵向手势全部让给场景；不可上滑进剖面。
5. **剖面进入**：起点在屏幕**下半部分**、主方向为纵向上滑，且未命中 3/4 → 进入剖面模式。
6. **场景切换**：主方向为水平滑动 → 在切换器场景序列间切页（含雷达索引；剖面激活时禁用）。

水平 / 纵向判定阈值：主轴位移大于副轴 × 1.15。剖面进入距离阈值约 80px。首次进入 App 底部展示一次「上滑穿过大气层 ↑」（`localStorage` key：`serein:profile-guide-seen`）。首次展示一次「长按进入分析模式」（`localStorage` key：`serein:analysis-guide-seen`）。

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
- 示范：`temperature`（25 点标注 + Y 网格 + 极值标记）、`precipitation`（累计副轴 mm + 各小时数值；顶部「未来 2 小时」minutely 细柱，null 不占位）、`wind`（风速数值 + 风向角度标注）、`humidity`（露点副线 + 湿球虚线副线）、`aqi`（六项浓度 small multiples）、`visibility`（逐时能见度迷你折线）、`pressure`（24h 气压折线副图；读数下海压/站压并排）、`sunlight`（日照累计 / 日出日落）、`moon`（未来 7 天月相图标横排）、`tide`（未来 3 天满潮/干潮时刻表）；Skew-T 指数盒含 K；环境页含积雪深度 / KP（null 隐藏）
- 天空 / 雷达 / 剖面可不实现 `setMode`
- 分析模式下场景切换器追加专属入口（探空、对比、环境）；未实现场景显示「即将上线」，hover 提示、点击无响应
- 空间剖面（`xsection`）不进切换器：雷达分析模式右上角「切剖面」选点 / 快捷城市对进入；关闭返回地图
- 模式切换保持当前场景；若当前为分析专属场景（探空 / 对比 / 环境 / 空间剖面），切回感受模式时离开分析专属场景（剖面回地图，其余回温度）
- Skew-T（探空）：拖时间轴时重绘上限 30fps，松手补绘；历史日数据加载超过 8s 显示骨架；探空 / 对比纳入全局 `PerformanceGovernor` fps 降级

### 日期导航与气候平均（幽灵曲线）

- TimeScrubber 右侧日期：今天点击弹出「今天 / 昨天 / 前天」+ `<input type="date">`（`1940-01-01`…今天）；非今天为历史模式（`--accent` + 前缀「历史 ·」），点击一键回今天
- 写 `currentDate` → `fetchDayData` / `fetchClimateNormals` → 全场景 `setData` / `setClimateNormals`，250ms 交叉淡入
- `WeatherLayer` 可选：`setClimateNormals?(normals)`、`setClimateLoading?(loading)`
- 温度：主曲线后方虚线幽灵曲线（可图例开关）+ 距平读数；降水：雨幕后淡色柱状轮廓；首次计算显示「计算气候平均…」，`normals-{城市}-{MMDD}` 永久缓存
- 历史模式：雷达提示历史回波暂缺并切最近帧；剖面按日期取廓线；对比入口提示「历史模式下暂不可用」

## 10. 音频引擎与白噪音

实现：`src/lib/audio/engine.ts`（`index.ts` 再导出）。**单** `AudioContext`，场景层不得 `close`。

| 通道 | 驱动 | 声纹 |
|------|------|------|
| `rain` | precip mm/h（参考 10） | 粉噪+水滴缓冲循环 + lowpass（自降水场景迁入） |
| `wind` | windSpeed m/s（参考 12） | 白噪 bandpass（自风场景迁入） |
| `thunder` | CAPE > 1000 **且** precip > 2 mm/h；仅白噪音模式；间隔 8–20s 随机 | 滤波噪声 + 低频扫频包络；音量 ∝ CAPE，上限 `AUDIO_LIMITS.THUNDER_GAIN_MAX` |

- 主增益 + `muted` 全局静音；白噪音另有 `masterVolume` 滑条
- 自动播放：首次用户手势后 `resumeSharedAudio`
- **白噪音模式**（TimeScrubber 播放钮旁音符 → `WhiteNoiseOverlay`；PWA shortcut / `/?whitenoise=1` 直达）：全屏极简 UI、三通道电平条、定时 15/30/60/整晚(8h)、黑色遮罩渐至不透明度 0.7；混音跟随 `currentTime` / `dayData`；Media Session metadata「Serein 白噪音」（不支持则静默）；定时结束 3s 渐出后 `suspend`
- 与场景扬声器**互斥**：进白噪音冻结并关闭场景声偏好的现场输出，退出后恢复；雨/风层只调 `setScene*Enabled` / `updateScene*`，不再自建 AudioNode
- PWA：`manifest.webmanifest` shortcuts「白噪音」→ `/?whitenoise=1`；可选 `share_target`（GET `/`）；`apple-mobile-web-app-status-bar-style=black-translucent` + `viewport-fit=cover`，顶栏 / 底栏 / 预警横幅均用 `env(safe-area-inset-*)`，横幅不遮挡状态栏与 Home Indicator

## 11. 后端架构（自托管 Node · Caddy · systemd）

生产拓扑：Caddy（443）→ 静态 `dist/` + `reverse_proxy /api/*` → `serein-api`（`127.0.0.1:8787`）。密钥仅在 `server/.env`（`chmod 600`）。版本 **1.0.0**（git tag `v1.0.0`）。

### 端点清单

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/healthz` | 进程存活 |
| `GET` | `/api/qweather/*` | 和风代理；无 secret → **503**；`Cache-Control` ~8min；全局限流 60/分/IP |
| `POST` | `/api/push/subscribe` | upsert `push_subscriptions`；endpoint 须 **https** |
| `POST` | `/api/push/unsubscribe` | 按 endpoint 删除 |
| `POST` | `/api/sync/create` | 8 位码 + 初始 payload；sync 限流 30/分/IP；`Cache-Control: no-store` |
| `GET` | `/api/sync/:code` | 读 payload + version |
| `PUT` | `/api/sync/:code` | 乐观锁；冲突 **409**；payload &lt; 64KB |
| `GET` | `/api/typhoon/*` | 浙江水利代理（自托管；与 Pages Function 路径白名单一致） |

响应惯例：`X-Content-Type-Options: nosniff`；**不**写 `Access-Control-Allow-Origin`（同源由 Caddy 提供）。

### SQLite 表（`server/data/serein.db`，WAL）

| 表 | 用途 | 迁移 |
|----|------|------|
| `_migrations` | 已应用迁移文件名 | 启动自动 |
| `push_subscriptions` | Web Push 订阅（endpoint PK） | `0001_init.sql` |
| `sync_states` | 跨设备同步码 / payload / version | `0001_init.sql` |
| `pushed_alerts` | 已推送预警去重 | `0002_pushed_alerts.sql` |

### systemd

单元文件：`deploy/serein-api.service` → `/etc/systemd/system/serein-api.service`

| 项 | 值 |
|----|-----|
| `WorkingDirectory` | `/srv/serein/server` |
| `EnvironmentFile` | `/srv/serein/server/.env` |
| `ExecStart` | `/usr/bin/tsx /srv/serein/server/src/index.ts` |
| `Restart` / `RestartSec` | `always` / `3` |
| 用户 | `serein`（只写 `server/data`） |

部署：`scripts/deploy.sh`（`git pull` → 前端 `npm ci && build` → 服务端 `npm ci` → `systemctl restart` → curl `/api/qweather/...`）。

### Caddy

示例：`deploy/Caddyfile`。站点块要点：`root * /srv/serein/dist`；`handle /api/* { reverse_proxy 127.0.0.1:8787 }`；其余 `file_server`（SPA `try_files`）；`encode zstd gzip`；证书自动申请续期。

防火墙：仅 **22 / 80 / 443**（ufw 或云安全组）。备份：`scripts/backup-sqlite.sh` 每日 cron → `/srv/backups/` 保留 14 天；可选 `RCLONE_REMOTE`。
