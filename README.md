# Atmos（Serein）

时间驱动的触感天气图集。底层天空常驻；上层按场景切换气象 / 天空 / 雷达 / 台风，并支持垂直剖面、分析模式、城市切换、天气预警与白噪音。

## 功能全景

| 区域 | 内容 |
|------|------|
| **气象组** | 温度 · 降水 · 风 · 湿度 · 空气 · 能见度 · 气压 |
| **天空组** | 日照 · 月相 · 潮汐 |
| **雷达** | MapLibre + RainViewer 回波；可切 NASA GIBS 真彩色卫星（延迟数小时，非实时） |
| **台风** | 路径 / 风圈 / 预报锥；场景内独立回放轴（不占全局时间） |
| **分析模式** | 同场分析叠加 + 探空（Skew-T）· 多模式对比 · 环境 · 空间剖面（地图切两点） |
| **剖面** | 单点垂直：屏幕下半上滑；空间剖面：雷达「切剖面」（雷达 / 台风独占纵向时不可进垂直剖面） |
| **城市** | 搜索与收藏；天津保底不可删；切换重取日数据 / 气候平均 / 雷达视野 |
| **预警** | 和风预警横幅（经本地 `server/` 代理）；雷暴潜势由 CAPE 推导；无 secret 静默 |
| **推送** | Web Push：SW + 订阅上报 + 服务端 15 分钟巡检和风预警并推送；VAPID 公钥 `VITE_VAPID_PUBLIC_KEY` |
| **跨设备同步** | 8 位同步码（无账号）；城市列表与偏好云端同步；设置区生成／输入码恢复 |
| **白噪音** | 雨 / 风 / 雷混音 + 睡眠定时；PWA 快捷方式或 `/?whitenoise=1` 直达 |
| **PWA** | Service Worker；添加到主屏幕；`black-translucent` 状态栏；shortcuts / 可选 share_target |

**模式切换**：右上角胶囊 / 桌面 `A` / 移动端长按 600ms（位移 >10px 取消）。分析专属场景切回感受时落回温度。

**时间轴**：0–24:00 scrub + 播放；日期导航（今天 / 昨天 / 前天 / 自定义）；气候平均幽灵曲线。

**性能**：`PerformanceGovernor` 按 fps 全场景 `setQuality`；白噪音为纯 UI，帧率不纳入降级；探空拖轴 30fps 上限；首屏 gzip JS **< 250KB**（`maplibre-gl` / `three` / 雷达·剖面场景独立 chunk）。GIBS 与空间剖面采样均懒加载，不进首屏。Lighthouse Mobile 四项 **≥ 85**。

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

`Weather data © Open-Meteo (CC-BY 4.0) · Tide © QWeather · Radar © RainViewer · KP © NOAA SWPC · Satellite © NASA GIBS · Map © OpenStreetMap © CARTO · Köppen Beck et al. 2018 · Typhoon`

**说明**：降水「潜势驱动」闪光与预警 sheet 雷暴档位由 **CAPE 推导**，非真实雷电监测（无免费实时源）。

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

- 全部气象 / 天空 / 雷达（含 GIBS 卫星）/ 环境 / 白噪音 / 垂直剖面 / 空间剖面可用
- 预警 / 分钟级降水返回空或 `null`，不抛错；KP 失败隐藏卡片
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

## 生产部署（自有服务器）

版本 **1.0.0**。拓扑：Caddy（HTTPS）托管 `dist/`，`/api/*` 反代到本机 `atmos-api`（`127.0.0.1:8787`）。照做可从零复现。

### 0. 前置

- Ubuntu 22.04+（或同类），域名 A/AAAA 指向服务器
- 安装：Node.js **20+**、git、Caddy 2、ufw（或云安全组）
- 仓库放到 `/srv/atmos`（下例用 git clone）

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
# 前端构建需要公钥：在 /srv/atmos/.env 写 VITE_VAPID_PUBLIC_KEY=<公钥>
sudo -u atmos cp /srv/atmos/.env.example /srv/atmos/.env
sudo -u atmos nano /srv/atmos/.env
```

生成 VAPID：`cd /srv/atmos/server && npx web-push generate-vapid-keys`。

### 2. systemd（API）

```bash
# 首次构建一次以得到 node_modules/.bin/tsx
sudo -u atmos bash -lc 'cd /srv/atmos && npm ci && npm ci --prefix server'
sudo ln -sfn /srv/atmos/server/node_modules/.bin/tsx /usr/bin/tsx

sudo cp /srv/atmos/deploy/atmos-api.service /etc/systemd/system/atmos-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now atmos-api
sudo systemctl status atmos-api
```

单元要点（见 `deploy/atmos-api.service`）：

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

等价站点块：

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
sudo ufw status
```

云厂商安全组同样只放行 **22 / 80 / 443**；**不要**对公网开放 8787。

### 5. 部署脚本

```bash
sudo -u atmos bash /srv/atmos/scripts/deploy.sh
# 流程：git pull → 前端 npm ci && npm run build → 服务端 npm ci
#      → systemctl restart atmos-api → curl /api/qweather/...（200 或 503 均算存活）
```

本地无 systemd 时可彩排：`./scripts/local-prod-rehearsal.sh`。

### 6. 备份（每日 SQLite）

```bash
sudo chmod +x /srv/atmos/scripts/backup-sqlite.sh
# 每天 03:00 UTC 打包到 /srv/backups，保留 14 天
echo '0 3 * * * atmos /srv/atmos/scripts/backup-sqlite.sh >> /var/log/atmos-backup.log 2>&1' \
  | sudo tee /etc/cron.d/atmos-backup
sudo chmod 644 /etc/cron.d/atmos-backup
```

可选 rclone 同步对象存储（事先 `rclone config`）：

```bash
sudo -u atmos env RCLONE_REMOTE=b2:atmos-backups /srv/atmos/scripts/backup-sqlite.sh
```

### 7. 验收：后端故障时前端仍可用

```bash
sudo systemctl stop atmos-api
# 浏览器打开 https://atmos.你的域名.com/?mock=1
# 期望：App 壳可开、场景走 mock、预警/推送/同步优雅失败（无未捕获异常）
sudo systemctl start atmos-api
```

安全审计（构建产物零 key、`.env` 权限、sw 不缓存 `/api`）：

```bash
./scripts/security-audit.sh
```

## 契约

所有新场景必须先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。字段名与接口以 `src/lib/contracts.ts` 为准，**不得更改**。

要点：

- `DayData`：一天 25 个逐时点（索引 0 = 00:00，24 = 24:00）
- `WeatherLayer`：`mount` / `unmount` / `setTime` / `setData` / `setQuality`；可选 `setMode` / `setClimateNormals`
- 切换器分组：气象 ｜ 天空 ｜ 雷达 ｜ 台风；（分析追加探空 / 对比 / 环境）；剖面不进切换器
- 手势仲裁 §8；分析模式 §9；音频 / 白噪音 §10；后端自托管 §11
- 默认城市 `DEFAULT_CITY`（天津）；`CITY` 为弃用别名
