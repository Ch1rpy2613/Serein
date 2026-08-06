#!/usr/bin/env bash
# 每日打包 Atmos SQLite（含 WAL）到 /srv/backups，保留 14 天
# cron 例：0 3 * * * /srv/atmos/scripts/backup-sqlite.sh >> /var/log/atmos-backup.log 2>&1
set -euo pipefail

ATMOS_ROOT="${ATMOS_ROOT:-/srv/atmos}"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups}"
DB_PATH="${DB_PATH:-$ATMOS_ROOT/server/data/atmos.db}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$BACKUP_DIR/atmos-db-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: SQLite 不存在: $DB_PATH" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 优先用 sqlite3 热备份（若已安装）；否则拷贝主库 + 旁路文件
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$TMP/atmos.db'"
else
  cp -a "$DB_PATH" "$TMP/atmos.db"
  [[ -f "${DB_PATH}-wal" ]] && cp -a "${DB_PATH}-wal" "$TMP/atmos.db-wal" || true
  [[ -f "${DB_PATH}-shm" ]] && cp -a "${DB_PATH}-shm" "$TMP/atmos.db-shm" || true
fi

tar -C "$TMP" -czf "$ARCHIVE" .
echo "OK wrote $ARCHIVE ($(du -h "$ARCHIVE" | awk '{print $1}'))"

# 清理超过 KEEP_DAYS 的归档
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'atmos-db-*.tar.gz' -mtime +"$KEEP_DAYS" -print -delete

# 可选：rclone 同步到对象存储（需事先 rclone config）
# 例：RCLONE_REMOTE=b2:atmos-backups ./scripts/backup-sqlite.sh
if [[ -n "${RCLONE_REMOTE:-}" ]] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$ARCHIVE" "$RCLONE_REMOTE/" --checksum
  echo "OK rclone → $RCLONE_REMOTE"
fi
