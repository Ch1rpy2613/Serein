#!/usr/bin/env bash
# Atmos 安全终审（本地 / CI）：构建产物 key 泄漏、gitignore、sw 策略、权限提示
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAIL=1; }

echo "==> 构建（若 dist 过旧）"
if [[ ! -d dist/assets ]]; then
  npm ci
  npm run build
fi

echo "==> 构建产物零 key 泄漏"
# 私钥 / 服务端 secret 不得出现在 dist
if rg -n --hidden -g '!node_modules' 'VAPID_PRIVATE|QWEATHER_KEY\s*=' dist 2>/dev/null; then
  fail "dist 含 VAPID_PRIVATE 或 QWEATHER_KEY 赋值"
else
  pass "dist 无 VAPID_PRIVATE / QWEATHER_KEY 赋值"
fi

# 前端不应出现服务端 env 名的私钥形态
if rg -n 'VAPID_PRIVATE_KEY' dist 2>/dev/null; then
  fail "dist 含 VAPID_PRIVATE_KEY 字符串"
else
  pass "dist 无 VAPID_PRIVATE_KEY 字符串"
fi

# QWEATHER 仅允许代理路径常量，不允许真实 key 形态（长 hex/base64 另查 env）
if rg -n 'VITE_QWEATHER' dist 2>/dev/null; then
  fail "dist 含 VITE_QWEATHER_*（前端不得持有和风 key）"
else
  pass "dist 无 VITE_QWEATHER_*"
fi

echo "==> server/.env gitignore + 权限"
if git check-ignore -q server/.env; then
  pass "server/.env 已被 gitignore"
else
  fail "server/.env 未被 gitignore"
fi

if [[ -f server/.env ]]; then
  MODE=$(stat -f '%Lp' server/.env 2>/dev/null || stat -c '%a' server/.env)
  if [[ "$MODE" == "600" || "$MODE" == "400" ]]; then
    pass "server/.env 权限 $MODE"
  else
    fail "server/.env 权限应为 600（当前 $MODE）— 请 chmod 600 server/.env"
  fi
else
  pass "server/.env 不存在（干净环境）"
fi

echo "==> /api rate limit + 订阅 https 校验（源码契约）"
if rg -n 'allowRequest' server/src/index.ts server/src/utils.ts >/dev/null; then
  pass "全局 /api rate limit 存在"
else
  fail "缺少 allowRequest rate limit"
fi

if rg -n "startsWith\\('https://'\\)" server/src/routes/push.ts >/dev/null; then
  pass "push subscribe 校验 https endpoint"
else
  fail "push 未校验 https endpoint"
fi

echo "==> sw.js 不缓存 /api（含 sync / push）"
if rg -n "pathname.startsWith\\('/api/'\\)" public/sw.js >/dev/null \
  && rg -n 'isApiRequest\(request\)\) return' public/sw.js >/dev/null; then
  pass "sw.js 对 /api/*（含 /api/sync、/api/push）直接放行、不缓存"
else
  fail "sw.js 未明确跳过 /api 缓存"
fi

# 确认 dist 里的 sw 同源策略
if [[ -f dist/sw.js ]]; then
  if rg -n "pathname.startsWith\\('/api/'\\)" dist/sw.js >/dev/null; then
    pass "dist/sw.js 保留 /api 跳过策略"
  else
    fail "dist/sw.js 缺少 /api 跳过"
  fi
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "安全终审未通过"
  exit 1
fi
echo "安全终审全绿"
exit 0
