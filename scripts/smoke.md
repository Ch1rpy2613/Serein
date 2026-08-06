# Atmos 全链路人工走查清单（Phase 5）

在桌面 Chrome + 一台真机（或模拟器）各跑一轮。控制台保持打开：**全程零未捕获报错 / 零红色失败**。

勾选前准备：

```bash
npm install
npm run build          # 须无错误
npm run preview        # 或 npm run dev
```

记录环境：浏览器 / OS / 有无 `server/.env`（`QWEATHER_*`）/ 构建命令：________

---

## 0. 构建与分包（自动化可先过）

- [ ] `npm run build` 退出码 0
- [ ] `dist/assets` 中存在独立 `maplibre-gl-*.js`（雷达 / 台风共用，单 chunk）
- [ ] `dist/assets` 中存在独立 `three-*.js`
- [ ] 首屏入口 gzip JS **< 250KB**（不含 maplibre / three 懒加载 chunk）
- [ ] `functions/` 未出现在 `dist/`（Pages Function 不影响静态构建）
- [ ] Lighthouse（Mobile）Performance / Accessibility / Best Practices / SEO **均 ≥ 85**  
  建议：`npm run build && npm run preview` 后  
  `npx lighthouse "http://127.0.0.1:4173/?mock=1" --view`  
  （`?mock=1` 避免第三方 API 429/403 污染 Best Practices；Phase 5 本地测得约 Perf 93 / A11y 89 / BP 96 / SEO 100）

---

## 1. 干净环境降级（无 `server/.env` / 代理 503）

**新隐私窗口**，确认服务端未配置 `QWEATHER_*`（或未启动 `server`）；打开应用根路径。

- [ ] 首屏出风场景（或默认场景），天空底层可见，无白屏
- [ ] 控制台无和风 401/403 刷屏；无未捕获异常
- [ ] 预警横幅不出现（或仅 `?mockAlerts=1` 时出现）
- [ ] 台风入口可见；无活跃时 **50% 透明仍可点**；进入后空态或代理数据，不抛错
- [ ] 气象组全部场景可切换并渲染
- [ ] 天空组（日照 / 月相 / 潮汐）可切换；无潮汐数据时入口 **50%** 透明仍可点；`?mockTide=1` 可离线验收
- [ ] 雷达可加载底图与回波（网络允许时）
- [ ] 分析模式：探空 / 对比 / 环境可进
- [ ] 白噪音可进可出

---

## 2. 城市切换

- [ ] 左上角打开城市选择；搜索「上海」等，防抖约 300ms 后出结果
- [ ] 选中后：日数据刷新、读数变化、雷达视野跟城市
- [ ] 天空 / 日照 / 月相经纬度随城市更新（日照时长或月出月落有合理变化）
- [ ] 天津不可从收藏删除；列表至少保留一座
- [ ] 切回天津数据恢复；控制台无报错
- [ ] 城市切换**不会**因无 key 而打预警 / 和风台风失败请求（干净环境）

---

## 3. 预警横幅

有 key 或使用 `?mockAlerts=1`：

- [ ] TimeScrubber **上方**出现横幅（级别色描边 + 圆点 + 标题）
- [ ] 多条时约 5s 轮播
- [ ] 点击打开详情 sheet（全文 / 发布时间 / 防御指南）；底部有「由 CAPE 推导」雷暴潜势
- [ ] 下滑或关闭后，同 id **24h 内**不再出现
- [ ] 横幅出现时，场景切换器 / 静音钮上移（`alertBannerOffset`），无重叠
- [ ] **PWA / iOS `black-translucent`**：顶栏（城市 / 模式胶囊）在 `safe-area-inset-top` 下方；底栏与横幅在 Home Indicator 上方，**状态栏不遮挡横幅、横幅不挡关键控件**

无 key（干净环境）：

- [ ] 无横幅；`?mockAlerts=1` 仍可测 UI

---

## 4. 台风回放

建议 `?mockTyphoon=1` 或活跃台风季：

- [ ] 切换器分组为：气象 ｜ 天空 ｜ 雷达 ｜ 台风（雷达与台风之间有分隔）
- [ ] 进入台风：地图、路径、风圈 / 锥（有数据时）可见
- [ ] **场景内** mini 时间轴可播放 / 拖动；默认约 4× 循环
- [ ] 回放**不**推动全局 `currentTime` / 底部主时间轴
- [ ] 纵向手势留给地图（不可上滑进剖面）
- [ ] 退出后进其他场景正常；城市切换不强制重取台风列表

---

## 5. 环境页（分析模式）

- [ ] 切到「分析」→ 切换器出现 探空 ｜ 对比 ｜ 环境
- [ ] 进入「环境」：土壤 / 海洋 / 花粉卡片按数据出现
- [ ] 内陆城市海洋卡片隐藏（`marine === null`）；域外花粉隐藏（`pollen === null`）— **不硬造、不报错**
- [ ] 拖主时间轴，火花图 / 读数跟随
- [ ] 切回「感受」：若原在环境页，落回温度场景

---

## 6. 白噪音

- [ ] 时间轴播放钮旁音符进入 `WhiteNoiseOverlay`
- [ ] 三通道电平（雨 / 风 / 雷）、音量滑条、定时 15/30/60/整晚
- [ ] 混音随当前时间 / 天气数据变化；首次手势后有声
- [ ] 与场景扬声器互斥：进白噪音后雨/风场景扬声器不响；退出后恢复偏好
- [ ] Esc / 关闭退出；无 AudioContext 泄漏报错
- [ ] `/?whitenoise=1`（或 PWA 快捷方式「白噪音」）直达叠加层，随后 URL 可去掉参数
- [ ] 白噪音开启期间，场景质量**不因**叠加层帧率被降到 low（纯 UI 不纳入 governor）

---

## 7. 全部旧场景（感受模式逐项）

对每个场景：进入 → 拖时间轴 → 播放数秒 → 无控制台报错 → 读数合理。

| 场景 | 通过 |
|------|------|
| 温度（曲线拖拽 / 气候幽灵若有） | [ ] |
| 降水 | [ ] |
| 风（首屏默认） | [ ] |
| 湿度 | [ ] |
| 空气 | [ ] |
| 能见度 | [ ] |
| 气压 | [ ] |
| 日照 | [ ] |
| 月相 | [ ] |
| 雷达（缩放 / 帧切换；历史日提示缺回波） | [ ] |
| 台风（见 §4） | [ ] |

分析叠加抽查：

- [ ] 温度 / 降水 / 风 / 湿度 / 空气 / 能见度 / 气压 / 日照 / 月相在分析模式下有额外标注或副图
- [ ] 切回感受后无分析元素残留
- [ ] 探空：拖轴流畅；历史加载慢时骨架
- [ ] 对比：今日多模式；历史日提示「暂不可用」
- [ ] 水平滑切换场景；剖面：下半上滑进入 / 下滑退出

---

## 8. 切换器最终分组（目视）

- [ ] **气象组**：温度 / 降水 / 风 / 湿度 / 空气 / 能见度 / 气压
- [ ] 分隔 ｜ **天空组**：日照 / 月相
- [ ] 分隔 ｜ **雷达**（图标）
- [ ] 分隔 ｜ **台风**
- [ ] 分析模式再分隔 ｜ 探空 / 对比 / 环境
- [ ] 当前项 scroll-snap 居中；剖面激活时切换器 dimmed / disabled

---

## 9. PWA 收尾

- [ ] `manifest.webmanifest` 含 shortcuts「白噪音」→ `/?whitenoise=1`
- [ ] 含可选 `share_target`（GET `/`）— 分享入口在支持的系统上不报错即可
- [ ] `apple-mobile-web-app-status-bar-style` = `black-translucent`；`viewport-fit=cover`
- [ ] 添加到主屏幕后：顶/底 chrome 与预警横幅均不被系统栏遮挡
- [ ] Service Worker 已注册（Application → Service Workers → `/sw.js`）
- [ ] 桌面 Chrome：设置或预警 sheet → 开启推送 → Network 见 `POST /api/push/subscribe` 200（body 含 `subscription` / `city` / `levels`）
- [ ] 服务端日志约 30s 后出现 `[alertPush] round:…`；`ALERT_PUSH_MOCK=1` 或删 `pushed_alerts` 行可收到通知；点击打开预警 sheet；同 id 第二轮不重复推
- [ ] 过期订阅（410）自动从 `push_subscriptions` 删除；`systemctl restart` 后定时器自恢复
- [ ] iOS Safari 未装 PWA：入口提示先添加到主屏幕；主屏幕 App 内可走订阅
- [ ] 更新 `CACHE_VERSION` 后旧缓存被清理，无旧壳新数据错版
- [ ] 跨设备同步：设备 A 设置区「生成同步码」加 3 城 → 隐私窗口输码 → 城市/偏好完整恢复；提示「已从云端恢复」
- [ ] 双端同时改：低 version `PUT` 得 409 → UI 提示后覆盖成功；错误码 404 提示友好
- [ ] payload 无位置轨迹等敏感字段；`>64KB` 被服务端拒绝（400 `payload_too_large`）

---

## 10. README 一致性

- [ ] README 功能全景与实际上线能力一致
- [ ] 数据源署名含 Open-Meteo / 和风 / RainViewer / CARTO / OSM / 台风源
- [ ] `server/.env` 的 `QWEATHER_KEY` / `QWEATHER_HOST` 说明与 `server/.env.example` 一致；前端无 `VITE_QWEATHER_*`
- [ ] Pages Function 本地调试步骤可跟做
- [ ] 开发 / 构建命令可复制执行

---

## 签署

| 项 | 结果 |
|----|------|
| 日期 | |
| 执行人 | |
| 干净环境（无 key） | 通过 / 失败 |
| 全场景 + 白噪音 + 台风 | 通过 / 失败 |
| 控制台零报错 | 通过 / 失败 |
| `npm run build` + bundle 预算 | 通过 / 失败 |
| Lighthouse ≥ 85 | 通过 / 失败 / 未测 |

失败项请记场景 id、复现步骤、控制台原文。
