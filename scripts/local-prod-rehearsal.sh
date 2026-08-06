#!/usr/bin/env bash
# 本地「干净服务器」部署彩排：镜像 /srv/atmos 布局，走 deploy 同款步骤，
# 验证 API 启停与前端壳降级（无需真实 VPS / systemd / Caddy）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${STAGE:-/tmp/atmos-rehearsal}"
API_PORT="${API_PORT:-18787}"
STATIC_PORT="${STATIC_PORT:-4177}"

cleanup() {
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${STATIC_PID:-}" ]] && kill -0 "$STATIC_PID" 2>/dev/null; then
    kill "$STATIC_PID" 2>/dev/null || true
    wait "$STATIC_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> 舞台目录 $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# 用 rsync/cp 镜像仓库（排除 node_modules / .git 体积）
rsync -a \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude 'server/node_modules' \
  --exclude 'server/data' \
  "$ROOT/" "$STAGE/"

cd "$STAGE"
mkdir -p server/data
# 复用源仓库依赖（彩排跳过 npm ci；生产仍走 deploy.sh 的 ci）
ln -sfn "$ROOT/node_modules" "$STAGE/node_modules"
ln -sfn "$ROOT/server/node_modules" "$STAGE/server/node_modules"
# 彩排用最小 .env（无真实 key → qweather 503 优雅降级）
cat > server/.env <<'EOF'
QWEATHER_HOST=
QWEATHER_KEY=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:atmos@localhost
EOF
chmod 600 server/.env

echo "==> 前端 build（舞台）"
npm run build

echo "==> start API on :${API_PORT} (empty key -> expect qweather 503)"
cd server
ATMOS_PORT="${API_PORT}" ./node_modules/.bin/tsx src/index.ts > /tmp/atmos-rehearsal-api.log 2>&1 &
API_PID=$!
cd "$STAGE"
sleep 1

HZ_READY=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${API_PORT}/healthz" | grep -q 200; then
    HZ_READY=1
    break
  fi
  sleep 0.4
done
if [[ "${HZ_READY}" != "1" ]]; then
  echo "ERROR: API not ready" >&2
  cat /tmp/atmos-rehearsal-api.log >&2 || true
  exit 1
fi

QW_CODE=$(curl -sS -o /tmp/atmos-rehearsal-qw.json -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:${API_PORT}/api/qweather/v7/warning/now?location=117.2,39.1" || echo 000)
echo "qweather HTTP ${QW_CODE} (expect 503 without key; or 200/401/403)"
if [[ ! "${QW_CODE}" =~ ^(200|401|403|503)$ ]]; then
  echo "ERROR: API health check failed" >&2
  cat /tmp/atmos-rehearsal-api.log >&2 || true
  exit 1
fi

# sync smoke
SYNC_CREATE=$(curl -sS -o /tmp/atmos-rehearsal-sync.json -w '%{http_code}' --max-time 5 \
  -X POST -H 'Content-Type: application/json' \
  -d '{"payload":{"savedCities":[{"name":"天津","lat":39.1,"lon":117.2,"tz":"Asia/Shanghai"}]}}' \
  "http://127.0.0.1:${API_PORT}/api/sync/create" || echo 000)
echo "sync/create HTTP ${SYNC_CREATE}"
if [[ "${SYNC_CREATE}" != "200" ]]; then
  echo "ERROR: sync/create failed" >&2
  cat /tmp/atmos-rehearsal-sync.json >&2 || true
  exit 1
fi

echo "==> static dist on :${STATIC_PORT} (no /api proxy = backend-down shell)"
for try in 1 2 3 4 5; do
  if ! curl -sS -o /dev/null --max-time 1 "http://127.0.0.1:${STATIC_PORT}/" 2>/dev/null; then
    break
  fi
  STATIC_PORT=$((STATIC_PORT + 1))
done
echo "static port -> ${STATIC_PORT}"
python3 -m http.server "${STATIC_PORT}" --directory dist >/tmp/atmos-rehearsal-static.log 2>&1 &
STATIC_PID=$!
for i in 1 2 3 4 5 6 7 8; do
  if curl -sS -o /dev/null --max-time 1 "http://127.0.0.1:${STATIC_PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.3
done

SHELL_CODE=$(curl -sS -o /tmp/atmos-rehearsal-shell.html -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:${STATIC_PORT}/" || echo 000)
if [[ "${SHELL_CODE}" != "200" ]]; then
  echo "ERROR: shell unreachable HTTP ${SHELL_CODE}" >&2
  exit 1
fi
if ! grep -q '<div id="app"' /tmp/atmos-rehearsal-shell.html && ! grep -qi 'serein\|atmos\|script' /tmp/atmos-rehearsal-shell.html; then
  echo "ERROR: shell HTML unexpected" >&2
  head -c 400 /tmp/atmos-rehearsal-shell.html >&2
  exit 1
fi
echo "OK shell HTTP 200"

echo "==> stop API (simulate systemctl stop atmos-api)"
# 杀进程组，避免 tsx 子进程残留
kill -TERM "-${API_PID}" 2>/dev/null || kill -TERM "${API_PID}" 2>/dev/null || true
wait "${API_PID}" 2>/dev/null || true
# 扫端口残留
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -tiTCP:"${API_PORT}" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "${PIDS}" ]]; then
    kill -TERM ${PIDS} 2>/dev/null || true
    sleep 0.3
    kill -KILL ${PIDS} 2>/dev/null || true
  fi
fi
API_PID=
sleep 0.5

DOWN=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${API_PORT}/healthz" || echo 000)
echo "API down probe HTTP ${DOWN} (expect non-200 / connect fail)"
if [[ "${DOWN}" == "200" ]]; then
  echo "ERROR: API still responding after stop" >&2
  exit 1
fi

SHELL2=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${STATIC_PORT}/?mock=1" || echo 000)
if [[ "${SHELL2}" != "200" ]]; then
  echo "ERROR: shell unavailable after API stop" >&2
  exit 1
fi
echo "OK shell still up after API stop (?mock=1)"

echo "==> 安全审计（源仓库）"
bash "$ROOT/scripts/security-audit.sh"

echo
echo "本地生产彩排全绿"
echo "  stage: $STAGE"
echo "  日志: /tmp/atmos-rehearsal-api.log /tmp/atmos-rehearsal-static.log"
