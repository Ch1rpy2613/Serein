<p align="center">
  <img src="public/atmos-icon.svg" width="112" alt="Atmos" />
</p>

<h1 align="center">Atmos</h1>

<p align="center">
  <strong>时间驱动的触感天气图集</strong><br />
  <sub>底层天空常驻 · 上层场景切换 · 感受与分析双模式</sub>
</p>

<p align="center">
  <a href="#快速开始"><img src="https://img.shields.io/badge/version-1.1.0-7ec8ff?style=flat-square" alt="version" /></a>
  <a href="#技术栈"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white" alt="Svelte 5" /></a>
  <a href="#技术栈"><img src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="#技术栈"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-lightgrey?style=flat-square" alt="license" /></a>
  <a href="#性能与体验"><img src="https://img.shields.io/badge/Lighthouse-≥85-22c55e?style=flat-square" alt="Lighthouse" /></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#功能全景">功能</a> ·
  <a href="#数据源与署名">数据源</a> ·
  <a href="#生产部署">部署</a> ·
  <a href="ARCHITECTURE.md">架构契约</a>
</p>

---

## 定位

Atmos（仓库名 Serein）不是「又一个天气 App」。它是一张**可被时间推动的大气画布**：

- **感受模式** — 用场景语言呈现温度、降水、风、湿度、空气、能见度、气压、日照、月相与潮汐
- **分析模式** — 同场叠加、Skew-T 探空、多模式对比、环境数据、雷达空间剖面
- **常驻天空** — 场景切换时底层天空引擎不卸载，只压暗与让位
- **可降级** — 无和风密钥、后端宕机或离线时，核心图集仍可运行（mock / 静默空态）

> 一手滑动时间，一手切换气象层。预警、台风、推送与跨设备同步是增强能力，不是硬依赖。

---

## 功能全景

### 场景图谱

| 分组 | 场景 |
|------|------|
| **气象** | 温度 · 降水 · 风 · 湿度 · 空气 · 能见度 · 气压 |
| **天空** | 日照 · 月相 · 潮汐 |
| **雷达** | MapLibre + RainViewer 回波；可切 NASA GIBS 真彩色卫星（延迟数小时，非实时） |
| **台风** | 路径 / 风圈 / 预报锥；场景内独立回放轴（不占用全局时间） |
| **分析专属** | 探空（Skew-T）· 多模式对比 · 环境 · 空间剖面（地图切两点） |

### 交互与系统能力

| 能力 | 说明 |
|------|------|
| **模式切换** | 右上角胶囊 / 桌面 `A` / 移动端长按 600ms（位移 >10px 取消）；分析专属场景切回感受时落回温度 |
| **时间轴** | 0–24:00 scrub + 播放；今天 / 昨天 / 前天 / 自定义日期；气候平均幽灵曲线 |
| **剖面** | 单点垂直：屏幕下半上滑；空间剖面：雷达「切剖面」（雷达 / 台风独占纵向时不可进垂直剖面） |
| **城市** | 搜索与收藏；天津保底不可删；Köppen 气候型标签；切换重取日数据 / 气候平均 / 雷达视野 |
| **预警** | 和风预警横幅（经本地 `server/` 代理）；雷暴潜势由 CAPE 推导；无 secret 静默 |
| **推送** | Web Push：SW + 订阅上报 + 服务端 15 分钟巡检；VAPID 公钥 `VITE_VAPID_PUBLIC_KEY` |
| **跨设备同步** | 8 位同步码（无账号）；城市列表与偏好云端同步 |
| **白噪音** | 雨 / 风 / 雷混音 + 睡眠定时；PWA 快捷方式或 `/?whitenoise=1` |
| **PWA** | Service Worker；主屏幕；`black-translucent`；shortcuts / 可选 share_target |

### 性能与体验

| 指标 | 目标 / 现状 |
|------|-------------|
| 首屏 gzip JS | **< 250KB**（`maplibre-gl` / `three` / 雷达·剖面独立 chunk） |
| 懒加载 | GIBS、空间剖面、Köppen 网格不进首屏 |
| 自适应画质 | `PerformanceGovernor` 按 fps 全场景 `setQuality` |
| 探空拖轴 | 30fps 上限 |
| Lighthouse Mobile | Perf / A11y / BP / SEO **≥ 85** |
| 白噪音 | 纯 UI，帧率不纳入降级 |

---

## 技术栈

```
Frontend     Svelte 5 · Vite 8 · TypeScript · MapLibre GL · Three.js
Backend      Node · tsx · SQLite（推送订阅 / 同步码）
Edge         Cloudflare Pages Function（可选台风代理）
Deploy       Caddy HTTPS · systemd · 自有服务器可复现拓扑
Test         Vitest · Playwright（mount/unmount 压力）
```

契约字段以 [`src/lib/contracts.ts`](./src/lib/contracts.ts) 为准，架构规范见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 快速开始

```bash
# 前端
npm install
npm run dev

# 另开终端：可选 API（预警 / 推送 / 同步 / SWPC 代理）
cd server && npm install && npm run dev   # http://127.0.0.1:8787
```

| 命令 | 作用 |
|------|------|
| `npm run build` | `svelte-check` + 生产构建（仅静态；不含 Pages Function / server） |
| `npm run preview` | 预览 `dist/`（无代理时预警/台风降级或 `?mock*=1`） |
| `npm run check` | 仅类型检查 |
| `npm run test` | Vitest |
| `npm run stress:unmount` | mount/unmount 压力（需 Playwright） |
| `npm run security:audit` | 构建产物零 key、`.env` 权限、SW 不缓存 `/api` |
| `npm run deploy:rehearsal` | 本地生产彩排（无 systemd） |

本地验和风代理：

```bash
curl -sS "http://127.0.0.1:8787/api/qweather/v7/warning/now?location=117.2,39.1" | head
```

人工走查清单：[`scripts/smoke.md`](./scripts/smoke.md)。

### URL 开关

| 参数 | 作用 |
|------|------|
| `?mock=1` | 强制 mock 天气，不发起网络请求 |
| `?mockAlerts=1` | 注入红色预警 |
| `?mockTyphoon=1` | 注入台风「灿都」 |
| `?mockTide=1` | 注入潮汐 |
| `?whitenoise=1` | 白噪音直达 |
| `/?alert={id}` | 打开对应预警 sheet（推送点击入口） |

---

## 可选服务：和风 · 推送 · 同步

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

- **入口**：预警详情 sheet「开启预警推送」／右下设置齿轮
- **流程**：授权 → `pushManager.subscribe` → `POST /api/push/subscribe`（upsert SQLite）
- **巡检**：服务端每 15 分钟（启动后 30s 首跑）拉和风预警；新预警且命中订阅级别则推送
- **本地无真实预警**：`ALERT_PUSH_MOCK=1` 注入橙色 mock；或从 `pushed_alerts` 删掉已推 `alert_id` 造差异
- **iOS**：非主屏幕会先提示「添加到主屏幕」；已装 PWA 后可正常订阅
- **SW**：`public/sw.js` — HTML network-first，静态 SWR，`/api` 不缓存

### 无 secret 干净环境

未配 `server/.env` / 代理返回 503 时：

- 全部气象 / 天空 / 雷达（含 GIBS）/ 环境 / 白噪音 / 垂直剖面 / 空间剖面可用
- 预警 / 分钟级降水返回空或 `null`，不抛错；KP 失败隐藏卡片
- 台风自动降级到浙江水利代理；两路皆失败 → 空列表，入口半透明可点
- 控制台无未捕获错误；构建产物中无 `VITE_QWEATHER` / key 字符串

---

## 数据源与署名

| 来源 | 用途 |
|------|------|
| [Open-Meteo](https://open-meteo.com/) Forecast / Archive / Historical Forecast / Air Quality / Geocoding / Marine | 地表逐时、廓线、气候平均、多模式、AQI、花粉、海洋、城市搜索 |
| [和风天气](https://dev.qweather.com/)（可选） | 天气预警 + 台风实现 A + 潮汐（Ocean）+ 分钟级降水 |
| [RainViewer](https://www.rainviewer.com/) | 雷达回波 |
| [NOAA SWPC](https://www.swpc.noaa.gov/) Planetary K-index | KP 指数（直连失败走 `/api/swpc/kp`） |
| [NASA GIBS](https://earthdata.nasa.gov/gibs) | 卫星真彩色（延迟数小时，非实时云图；无 key） |
| [Köppen–Geiger](https://doi.org/10.1038/sdata.2018.214)（Beck et al. 2018, CC-BY 4.0） | 本地气候型网格 `koppen-grid.json` |
| [CARTO](https://carto.com/) · [OpenStreetMap](https://www.openstreetmap.org/) | 底图 |
| 浙江水利台风 API（经代理） | 台风实现 B（非官方公开源）→ `/api/typhoon/*` |

界面署名（时间轴小字）：

```
Weather data © Open-Meteo (CC-BY 4.0) · Tide © QWeather · Radar © RainViewer
· KP © NOAA SWPC · Satellite © NASA GIBS · Map © OpenStreetMap © CARTO
· Köppen Beck et al. 2018 · Typhoon
```

**诚实说明**：降水「潜势驱动」闪光与预警 sheet 雷暴档位由 **CAPE 推导**，非真实雷电监测（无免费实时源）。离线 / 失败走 `src/lib/data/mock.ts`。

---

## Pages Function 本地调试

生产部署到 Cloudflare Pages 时，`functions/api/typhoon/[[path]].ts` 代理浙江水利上游（CORS + `s-maxage=300`）。

| 环境 | 行为 |
|------|------|
| `npm run dev` | Vite `server.proxy`：`/api/typhoon/*` → `https://typhoon.slt.zj.gov.cn/Api/*` |
| `npm run build` | **只**产出 `dist/` 静态资源；`functions/` 不参与打包 |
| 本地验 Function | `npm run build` → `npx wrangler pages dev dist` |

```bash
npm run build
npx wrangler pages dev dist
# 另开终端：
curl -sS http://127.0.0.1:8788/api/typhoon/TyhoonActivity | head
```

---

## 生产部署

版本 **1.1.0**。推荐拓扑：

```
                   ┌─────────────┐
  HTTPS 443  ───▶  │    Caddy    │
                   │  (dist SPA) │
                   └──────┬──────┘
                          │ /api/*
                          ▼
                   ┌─────────────┐
                   │  atmos-api  │  127.0.0.1:8787
                   │ Node + SQLite│
                   └─────────────┘
```

照做可从零复现。脚本：[`scripts/deploy.sh`](./scripts/deploy.sh) · [`deploy/Caddyfile`](./deploy/Caddyfile) · [`deploy/atmos-api.service`](./deploy/atmos-api.service)。

### 0. 前置

- Ubuntu 22.04+（或同类），域名 A/AAAA 指向服务器
- 安装：Node.js **20+**、git、Caddy 2、ufw（或云安全组）
- 仓库放到 `/srv/atmos`

```bash
sudo mkdir -p /srv/atmos /srv/backups
sudo useradd --system --home /srv/atmos --shell /usr/sbin/nologin atmos || true
sudo git clone https://github.com/Ch1rpy2613/Serein.git /srv/atmos
sudo chown -R atmos:atmos /srv/atmos /srv/backups
```

### 1. 密钥

```bash
sudo -u atmos cp /srv/atmos/server/.env.example /srv/atmos/server/.env
sudo chmod 600 /srv/atmos/server/.env
sudo -u atmos nano /srv/atmos/server/.env
# 填 QWEATHER_HOST / QWEATHER_KEY / VAPID_*

# 前端构建需要公钥
sudo -u atmos cp /srv/atmos/.env.example /srv/atmos/.env
sudo -u atmos nano /srv/atmos/.env   # VITE_VAPID_PUBLIC_KEY=<公钥>
```

生成 VAPID：`cd /srv/atmos/server && npx web-push generate-vapid-keys`。

### 2. systemd（API）

```bash
sudo -u atmos bash -lc 'cd /srv/atmos && npm ci && npm ci --prefix server'
sudo ln -sfn /srv/atmos/server/node_modules/.bin/tsx /usr/bin/tsx

sudo cp /srv/atmos/deploy/atmos-api.service /etc/systemd/system/atmos-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now atmos-api
sudo systemctl status atmos-api
```

| 项 | 值 |
|----|-----|
| `ExecStart` | `/usr/bin/tsx /srv/atmos/server/src/index.ts` |
| `WorkingDirectory` | `/srv/atmos/server` |
| `EnvironmentFile` | `/srv/atmos/server/.env`（`chmod 600`） |
| `Restart` / `RestartSec` | `always` / `3` |

### 3. Caddy

将 `deploy/Caddyfile` 中的 `atmos.example.com` 换成你的域名后安装：

```bash
sudo cp /srv/atmos/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # 改域名
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

```caddy
atmos.你的域名.com {
	root * /srv/atmos/dist
	encode zstd gzip
	handle /api/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		try_files {path} /index.html
		file_server
	}
}
```

Caddy 自动申请并续期 HTTPS 证书。

### 4. 防火墙

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

云安全组同样只放行 **22 / 80 / 443**；**不要**对公网开放 8787。

### 5. 部署脚本

```bash
sudo -u atmos bash /srv/atmos/scripts/deploy.sh
# git pull → 前端 build → 服务端 npm ci → restart atmos-api → 存活探测
```

本地无 systemd 时可彩排：`./scripts/local-prod-rehearsal.sh`。

### 6. 备份（每日 SQLite）

```bash
sudo chmod +x /srv/atmos/scripts/backup-sqlite.sh
echo '0 3 * * * atmos /srv/atmos/scripts/backup-sqlite.sh >> /var/log/atmos-backup.log 2>&1' \
  | sudo tee /etc/cron.d/atmos-backup
sudo chmod 644 /etc/cron.d/atmos-backup
```

可选 rclone：`sudo -u atmos env RCLONE_REMOTE=b2:atmos-backups /srv/atmos/scripts/backup-sqlite.sh`

### 7. 验收：后端故障时前端仍可用

```bash
sudo systemctl stop atmos-api
# 浏览器打开 https://atmos.你的域名.com/?mock=1
# 期望：App 壳可开、场景走 mock、预警/推送/同步优雅失败
sudo systemctl start atmos-api

./scripts/security-audit.sh
```

---

## 架构契约

所有新场景必须先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。字段名与接口以 `src/lib/contracts.ts` 为准，**不得更改**。

| 要点 | 约定 |
|------|------|
| `DayData` | 一天 25 个逐时点（索引 0 = 00:00，24 = 24:00） |
| `WeatherLayer` | `mount` / `unmount` / `setTime` / `setData` / `setQuality`；可选 `setMode` / `setClimateNormals` |
| 切换器分组 | 气象 ｜ 天空 ｜ 雷达 ｜ 台风；（分析追加探空 / 对比 / 环境）；剖面不进切换器 |
| 手势 / 模式 / 音频 | 见架构 §8 · §9 · §10；后端自托管 §11 |
| 默认城市 | `DEFAULT_CITY`（天津）；`CITY` 为弃用别名 |

原则：**契约留字段、无数据自动隐藏，不为弱数据硬造场景。**

---

## 许可

[BSD 3-Clause](./LICENSE) · Copyright © 2026 Ch1rpy

第三方数据与地图版权归各自权利方所有；使用本项目时请保留界面署名与上游许可要求。
