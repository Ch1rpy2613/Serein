# Atmos（Serein）

时间驱动的触感天气图集。底层天空常驻；上层按场景切换气象 / 天空 / 雷达 / 台风，并支持垂直剖面、分析模式、城市切换、天气预警与白噪音。

## 功能全景

| 区域 | 内容 |
|------|------|
| **气象组** | 温度 · 降水 · 风 · 湿度 · 空气 · 能见度 · 气压 |
| **天空组** | 日照 · 月相 |
| **雷达** | MapLibre + RainViewer 回波 |
| **台风** | 路径 / 风圈 / 预报锥；场景内独立回放轴（不占全局时间） |
| **分析模式** | 同场分析叠加 + 探空（Skew-T）· 多模式对比 · 环境（土壤 / 海洋 / 花粉） |
| **剖面** | 屏幕下半上滑进入大气垂直剖面（雷达 / 台风独占纵向手势时不可进） |
| **城市** | 搜索与收藏；天津保底不可删；切换重取日数据 / 气候平均 / 雷达视野 |
| **预警** | 和风预警横幅（经本地 `server/` 代理）；雷暴潜势由 CAPE 推导；无 secret 静默 |
| **推送** | Web Push：SW + 订阅上报 + 服务端 15 分钟巡检和风预警并推送；VAPID 公钥 `VITE_VAPID_PUBLIC_KEY` |
| **跨设备同步** | 8 位同步码（无账号）；城市列表与偏好云端同步；设置区生成／输入码恢复 |
| **白噪音** | 雨 / 风 / 雷混音 + 睡眠定时；PWA 快捷方式或 `/?whitenoise=1` 直达 |
| **PWA** | Service Worker；添加到主屏幕；`black-translucent` 状态栏；shortcuts / 可选 share_target |

**模式切换**：右上角胶囊 / 桌面 `A` / 移动端长按 600ms（位移 >10px 取消）。分析专属场景切回感受时落回温度。

**时间轴**：0–24:00 scrub + 播放；日期导航（今天 / 昨天 / 前天 / 自定义）；气候平均幽灵曲线。

**性能**：`PerformanceGovernor` 按 fps 全场景 `setQuality`；白噪音为纯 UI，帧率不纳入降级；探空拖轴 30fps 上限；首屏 gzip JS **< 250KB**（`maplibre-gl` / `three` 独立 chunk）。

## 数据源与署名

| 来源 | 用途 |
|------|------|
| [Open-Meteo](https://open-meteo.com/) Forecast / Archive / Historical Forecast / Air Quality / Geocoding / Marine | 地表逐时、廓线、气候平均、多模式、AQI、花粉、海洋、城市搜索 |
| [和风天气](https://dev.qweather.com/)（可选） | 天气预警 + 台风实现 A + 潮汐（Ocean） |
| [RainViewer](https://www.rainviewer.com/) | 雷达回波 |
| [CARTO](https://carto.com/) · [OpenStreetMap](https://www.openstreetmap.org/) | 底图 |
| 浙江水利台风 API（经代理） | 台风实现 B（非官方公开源）→ `/api/typhoon/*` |

界面署名（时间轴小字）：

`Weather data © Open-Meteo (CC-BY 4.0) · Tide © QWeather · Radar © RainViewer · Map © OpenStreetMap © CARTO · Typhoon`

离线 / 失败走 `src/lib/data/mock.ts`。URL 开关：`?mock=1`（天气）· `?mockAlerts=1`（红色预警）· `?mockTyphoon=1`（「灿都」）· `?mockTide=1`（潮汐）· `?whitenoise=1`（白噪音直达）。

## 和风天气配置（可选，仅服务端）

密钥**不得**进入前端。复制 `server/.env.example` → `server/.env`，并 `chmod 600`：

```bash
cd server
cp .env.example .env
chmod 600 .env
# 编辑 QWEATHER_HOST / QWEATHER_KEY
npm install
npm run dev            # http://127.0.0.1:8787
```

| 变量 | 说明 |
|------|------|
| `QWEATHER_HOST` | 和风专属域名（如 `abc123.qweatherapi.com`），**不用**公共 `devapi.qweather.com` |
| `QWEATHER_KEY` | API Key；服务端以请求头 `X-QW-Api-Key` 转发，**不用** `?key=` |

前端只请求同源 `/api/qweather/v7/...`；Vite 开发时代理到 `127.0.0.1:8787`。

### Web Push

在 `server/` 生成 VAPID 密钥对，**公钥**写入前端 `.env`，**私钥 / subject** 写入 `server/.env`：

```bash
cd server && npx web-push generate-vapid-keys
# 根目录 .env
VITE_VAPID_PUBLIC_KEY=<公钥>
# server/.env
VAPID_PUBLIC_KEY=<公钥>
VAPID_PRIVATE_KEY=<私钥>
VAPID_SUBJECT=mailto:you@example.com
```

- 入口：预警详情 sheet「开启预警推送」／右下设置齿轮
- 流程：授权 → `pushManager.subscribe` → `POST /api/push/subscribe`（upsert SQLite）
- 服务端进程内每 15 分钟（启动后 30s 首跑）拉和风预警；新预警且命中订阅级别则推送；`/?alert={id}` 点击打开 sheet
- 本地无真实预警时：`ALERT_PUSH_MOCK=1` 注入橙色 mock；或从 `pushed_alerts` 删掉已推 `alert_id` 造差异
- iOS：非主屏幕 App 会先提示「添加到主屏幕」；已装 PWA 后可正常订阅
- SW：`public/sw.js`；HTML network-first，静态 SWR，`/api` 不缓存

**无 secret 干净环境**（未配 `server/.env` / 代理返回 503）：

- 全部气象 / 天空 / 雷达 / 环境 / 白噪音 / 剖面可用
- 预警返回 `[]`，不抛错
- 台风自动降级到浙江水利代理；两路皆失败 → 空列表，入口半透明可点
- 控制台无未捕获错误；构建产物中无 `VITE_QWEATHER` / key 字符串

## 开发 / 构建

```bash
npm install
npm run dev            # 前端（/api/qweather|/api/push|/api/sync → :8787；/api/typhoon → 浙江水利）
# 另开终端：
cd server && npm install && npm run dev
npm run build          # svelte-check + 生产构建（仅静态；不含 Pages Function / server）
npm run preview        # 预览 dist（无代理时预警/台风降级或 ?mock*=1）
npm run check          # 仅类型检查
npm run test           # vitest
npm run stress:unmount # mount/unmount 压力（需 playwright）
```

本地验和风代理：

```bash
curl -sS "http://127.0.0.1:8787/api/qweather/v7/warning/now?location=117.2,39.1" | head
```

人工走查清单见 [`scripts/smoke.md`](./scripts/smoke.md)。

## Pages Function 本地调试

生产部署到 Cloudflare Pages 时，`functions/api/typhoon/[[path]].ts` 代理浙江水利上游（CORS + `s-maxage=300`）。

| 环境 | 行为 |
|------|------|
| `npm run dev` | Vite `server.proxy`：`/api/typhoon/*` → `https://typhoon.slt.zj.gov.cn/Api/*` |
| `npm run build` | **只**产出 `dist/` 静态资源；`functions/` 不参与打包 |
| 本地验 Function | 见下 |

```bash
npm run build
npx wrangler pages dev dist
# 另开终端：
curl -sS http://127.0.0.1:8788/api/typhoon/TyhoonActivity | head
```

## 契约

所有新场景必须先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。字段名与接口以 `src/lib/contracts.ts` 为准，**不得更改**。

要点：

- `DayData`：一天 25 个逐时点（索引 0 = 00:00，24 = 24:00）
- `WeatherLayer`：`mount` / `unmount` / `setTime` / `setData` / `setQuality`；可选 `setMode` / `setClimateNormals`
- 切换器分组：气象 ｜ 天空 ｜ 雷达 ｜ 台风；（分析追加探空 / 对比 / 环境）；剖面不进切换器
- 手势仲裁 §8；分析模式 §9；音频 / 白噪音 §10
- 默认城市 `DEFAULT_CITY`（天津）；`CITY` 为弃用别名
