#!/usr/bin/env bash
# Atmos 生产部署：git pull → 前端构建 → 服务端依赖 → 重启 API → 健康检查
# 用法（服务器上）：
#   sudo -u atmos bash /srv/atmos/scripts/deploy.sh
#   或：ATMOS_ROOT=/srv/atmos ./scripts/deploy.sh
set -euo pipefail

ATMOS_ROOT="${ATMOS_ROOT:-/srv/atmos}"
SERVICE_NAME="${SERVICE_NAME:-atmos-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/qweather/v7/warning/now?location=117.2,39.1}"
HEALTH_FALLBACK="${HEALTH_FALLBACK:-http://127.0.0.1:8787/healthz}"

cd "$ATMOS_ROOT"

echo "==> [1/5] git pull"
if [[ -d .git ]]; then
  git pull --ff-only
else
  echo "WARN: $ATMOS_ROOT 不是 git 仓库，跳过 pull"
fi

echo "==> [2/5] 前端 npm ci && npm run build"
npm ci
npm run build

echo "==> [3/5] 服务端 npm ci"
npm ci --prefix server

# 确保 /usr/bin/tsx 可用（systemd ExecStart 固定路径）
if [[ ! -x /usr/bin/tsx ]]; then
  TSX_BIN="$ATMOS_ROOT/server/node_modules/.bin/tsx"
  if [[ -x "$TSX_BIN" ]]; then
    echo "==> 安装 tsx 到 /usr/bin/tsx（需 root）"
    if [[ "$(id -u)" -eq 0 ]]; then
      ln -sfn "$TSX_BIN" /usr/bin/tsx
    else
      sudo ln -sfn "$TSX_BIN" /usr/bin/tsx
    fi
  else
    echo "ERROR: 找不到 tsx，请先 npm ci --prefix server" >&2
    exit 1
  fi
fi

echo "==> [4/5] systemctl restart $SERVICE_NAME"
if command -v systemctl >/dev/null 2>&1; then
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl restart "$SERVICE_NAME"
  else
    sudo systemctl restart "$SERVICE_NAME"
  fi
  sleep 1
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl --no-pager --full status "$SERVICE_NAME" || true
  else
    sudo systemctl --no-pager --full status "$SERVICE_NAME" || true
  fi
else
  echo "WARN: 无 systemctl，跳过重启（本地 dry-run？）"
fi

echo "==> [5/5] 健康检查"
set +e
HTTP_CODE=$(curl -sS -o /tmp/atmos-health.body -w '%{http_code}' --max-time 10 "$HEALTH_URL")
CURL_EXIT=$?
set -e
BODY_HEAD=$(head -c 200 /tmp/atmos-health.body 2>/dev/null || true)

# 200 有数据 / 503 无 key / 401·403 上游鉴权或弃用 —— 均证明代理进程存活并响应
if [[ "$CURL_EXIT" -eq 0 && "$HTTP_CODE" =~ ^(200|401|403|503)$ ]]; then
  echo "OK qweather HTTP $HTTP_CODE — ${BODY_HEAD}"
  exit 0
fi

echo "WARN: qweather 检查失败 (exit=$CURL_EXIT code=$HTTP_CODE)，改试 /healthz"
set +e
HZ_CODE=$(curl -sS -o /tmp/atmos-healthz.body -w '%{http_code}' --max-time 5 "$HEALTH_FALLBACK")
set -e
if [[ "$HZ_CODE" == "200" ]]; then
  echo "OK healthz HTTP 200"
  exit 0
fi

echo "ERROR: 健康检查失败（qweather=$HTTP_CODE healthz=$HZ_CODE）" >&2
exit 1
