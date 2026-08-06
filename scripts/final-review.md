# Atmos 1.0.0 终审记录

日期：2026-08-06  
执行：本地仓库 + `scripts/local-prod-rehearsal.sh`（无可用远程 SSH / Docker daemon；真机 VPS 请按 README「生产部署」）

## 安全终审

| 项 | 结果 | 证据 |
|----|------|------|
| 构建产物零 `VAPID_PRIVATE` / `QWEATHER_KEY` 赋值 | PASS | `scripts/security-audit.sh` |
| 构建产物无 `VAPID_PRIVATE_KEY` 字符串 | PASS | 同上 |
| 构建产物无 `VITE_QWEATHER_*` | PASS | 同上 |
| `server/.env` gitignore | PASS | `.gitignore` + `git check-ignore` |
| `server/.env` 权限 600 | PASS | `chmod 600`；审计脚本校验 |
| `/api/*` 内存 rate limit（60/分/IP） | PASS | `server/src/index.ts` + `utils.ts` |
| 订阅 endpoint 须 https | PASS | `server/src/routes/push.ts` |
| `sw.js` 不缓存 `/api/*`（含 sync / push） | PASS | `public/sw.js` / `dist/sw.js` early return |

## 功能 / 部署终审

| 项 | 结果 |
|----|------|
| `npm run build` | PASS（首屏 gzip JS ~71KB &lt; 250KB） |
| `npm test` | PASS（67） |
| `server` `tsc --noEmit` | PASS |
| 本地生产彩排（无 key → qweather 503、sync/create 200、停 API 后壳仍可用） | PASS |
| Phase 6 清单 | 已写入 `scripts/smoke.md` §11（人工勾选） |
| 备份脚本 | `scripts/backup-sqlite.sh`（cron / rclone 见 README） |

## 性能终审

| 项 | 结果 |
|----|------|
| 首屏零后端依赖（停 API + `?mock=1` 壳可用） | PASS（彩排） |
| Lighthouse Mobile（`?mock=1`） | Perf **86** / A11y **89** / BP **96** / SEO **100**（均 ≥ 85） |
| Lighthouse Desktop | Perf **100** / A11y 89 / BP 96 / SEO 100 |

修：`app.css` 启动标从 `opacity:0` 改为首帧 `1`，消除 headless `NO_LCP`。

## 产物清单

- `deploy/Caddyfile` · `deploy/atmos-api.service`
- `scripts/deploy.sh` · `backup-sqlite.sh` · `security-audit.sh` · `local-prod-rehearsal.sh`
- `ARCHITECTURE.md` §11 后端架构
- 版本 `1.0.0` / tag `v1.0.0`
- 自托管台风代理：`server/src/routes/typhoon.ts`（Caddy 将全部 `/api/*` 打到 Node）
