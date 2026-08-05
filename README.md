# Atmos（Serein）

天津单城、时间驱动的触感天气图集。底层天空常驻；上层按场景切换温度 / 降水 / 风 / 湿度 / 空气 / 能见度 / 气压 / 日照 / 月相 / 雷达 / 台风，并支持垂直剖面、分析模式（探空 · 对比）。

## 功能清单

- **感受模式**：温度、降水、风、湿度、空气、能见度、气压、日照、月相 + 雷达地图图标入口 + 台风（切换器横向滚动磁吸，组间细分隔；无活跃台风时入口半透明可点）
- **分析模式**：同场景分析叠加（能见度迷你折线 · 气压 24h 副图 · 月相未来 7 天图标等）+ 探空（Skew-T）+ 多模式对比
- **模式切换**：右上角胶囊 / 桌面 `A` 键 / 移动端长按 600ms（位移 >10px 取消）；共享场景不跳变，分析专属场景切回感受时落回温度
- **时间轴**：0–24:00  scrub + 播放；日期导航（今天 / 昨天 / 前天 / 自定义）；气候平均幽灵曲线
- **剖面**：屏幕下半上滑进入大气垂直剖面（雷达独占纵向手势时不可进）
- **PWA**：可添加到主屏幕；首次引导「上滑穿过大气层」「长按进入分析模式」
- **性能**：全局 fps 降级（`PerformanceGovernor` → 全场景 `setQuality`）；探空拖轴 30fps 上限、松手补绘；历史加载 >8s 骨架；月球纹理 / 地标剪影等静态资源一次性缓存

## 数据源与署名

| 来源 | 用途 |
|------|------|
| [Open-Meteo](https://open-meteo.com/) Forecast / Archive / Historical Forecast / Air Quality | 地表逐时、气压面廓线、气候平均、多模式、AQI |
| [RainViewer](https://www.rainviewer.com/) | 雷达回波 |
| [OpenStreetMap](https://www.openstreetmap.org/) · [CARTO](https://carto.com/) | 底图 |
| [和风天气](https://dev.qweather.com/)（可选） | 天气预警 + 台风（实现 A）；需 `VITE_QWEATHER_HOST` + `VITE_QWEATHER_KEY`，缺失则静默关闭 / 台风降级 |
| 浙江水利台风 API（经代理） | 台风实现 B（非官方公开源）；经 Cloudflare Pages Function `/api/typhoon/*` |

界面署名（时间轴小字）：

`Weather data © Open-Meteo (CC-BY 4.0) · Radar © RainViewer · Map © OpenStreetMap © CARTO · Typhoon`

离线 / 失败时走 `src/lib/data/mock.ts`；URL `?mock=1` 强制天气 mock；`?mockAlerts=1` 强制红色预警 mock；`?mockTyphoon=1` 强制台风「灿都」mock。

## 开发命令

```bash
npm install
npm run dev          # 本地开发（已含 /api/typhoon → 上游代理）
npm run build        # svelte-check + 生产构建
npm run preview      # 预览 dist（无 Pages Function；台风走空态或 mock）
npm run check        # 仅类型检查
npm run stress:unmount  # mount/unmount 压力脚本（需 playwright）
```

### 台风代理（本地）

`npm run dev` 时 Vite 将 `/api/typhoon/*` 代理到 `https://typhoon.slt.zj.gov.cn/Api/*`（与生产 Pages Function 等价）。

生产部署到 Cloudflare Pages 时，`functions/api/typhoon/[[path]].ts` 生效（CORS + `s-maxage=300`）。也可用 Wrangler 本地验 Function：

```bash
npm run build
npx wrangler pages dev dist
# 另开终端：
curl -sS http://127.0.0.1:8788/api/typhoon/TyhoonActivity | head
```

## 契约说明

所有新场景必须先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。字段名与接口以 `src/lib/contracts.ts` 为准，**不得更改**。

要点摘要：

- `DayData`：一天 25 个逐时点（索引 0 = 00:00，24 = 24:00）
- `WeatherLayer`：`mount` / `unmount` / `setTime` / `setData` / `setQuality`；可选 `setMode` / `setClimateNormals` / `setClimateLoading`
- 场景切换器不含剖面；雷达为图标入口；台风在气象组末尾；分析模式追加探空 / 对比
- 手势仲裁见 `ARCHITECTURE.md` §8；分析模式规范见 §9
- 首屏 gzip JS 预算 **< 250KB**（`maplibre-gl` / `three` 经 Vite `manualChunks` 拆出；雷达与台风共用 `maplibre-gl` chunk）

默认城市：`DEFAULT_CITY = { name: '天津', lat: 39.10, lon: 117.20, tz: 'Asia/Shanghai' }`。全局多城市由 `currentCity` / `savedCities` 驱动；旧导出 `CITY` 为 `DEFAULT_CITY` 别名（已弃用）。
