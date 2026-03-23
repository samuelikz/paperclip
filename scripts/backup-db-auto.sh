#!/usr/bin/env bash
# Automated database backup with integrity verification and retention policy
#
# Usage:
#   ./scripts/backup-db-auto.sh
#
# Environment variables (all optional, have defaults):
#   PAPERCLIP_DIR       - Project root directory (default: dir of this script/..)
#   COMPOSE_FILE        - docker-compose file (default: docker-compose.prod.yml)
#   BACKUP_DIR          - Where to store backups (default: $PAPERCLIP_DIR/backups)
#   DB_USER             - Database user (default: paperclip)
#   DB_NAME             - Database name (default: paperclip)
#   DB_CONTAINER        - Postgres container name (default: paperclip-db)
#   BACKUP_KEEP_COUNT   - Number of backups to retain (default: 14)
#   VERIFY_BACKUP       - Run integrity check: true/false (default: true)
#   NOTIFY_WEBHOOK_URL  - Webhook URL to POST on failure (optional)
#   LOG_FORMAT          - Output format: json/text (default: json)
#
# Cron example (every 6h in prod):
#   0 */6 * * * /opt/paperclip/scripts/backup-db-auto.sh >> /var/log/paperclip-backup.log 2>&1
#
# Cron example (once daily in staging):
#   0 2 * * * /opt/paperclip/scripts/backup-db-auto.sh >> /var/log/paperclip-backup.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Configuration ---
PAPERCLIP_DIR="${PAPERCLIP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$PAPERCLIP_DIR/docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-$PAPERCLIP_DIR/backups}"
DB_USER="${DB_USER:-paperclip}"
DB_NAME="${DB_NAME:-paperclip}"
DB_CONTAINER="${DB_CONTAINER:-paperclip-db}"
BACKUP_KEEP_COUNT="${BACKUP_KEEP_COUNT:-14}"
VERIFY_BACKUP="${VERIFY_BACKUP:-true}"
NOTIFY_WEBHOOK_URL="${NOTIFY_WEBHOOK_URL:-}"
LOG_FORMAT="${LOG_FORMAT:-json}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/paperclip-${TIMESTAMP}.dump"
TEMP_CONTAINER="paperclip-backup-verify-$$"
EXIT_CODE=0

# --- Logging ---
log() {
  local level="$1"
  local message="$2"
  local extras="${3:-}"
  if [ "$LOG_FORMAT" = "json" ]; then
    printf '{"ts":"%s","level":"%s","msg":"%s"%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$message" "${extras:+,$extras}"
  else
    printf '[%s] [%s] %s%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$message" "${extras:+ ($extras)}"
  fi
}

# --- Failure notification ---
notify_failure() {
  local reason="$1"
  log "ERROR" "Backup failed" "\"reason\":\"$reason\",\"backup_file\":\"$BACKUP_FILE\",\"db\":\"$DB_NAME\""

  if [ -n "$NOTIFY_WEBHOOK_URL" ]; then
    curl -s -m 10 -X POST "$NOTIFY_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"event\":\"backup_failed\",\"db\":\"$DB_NAME\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"reason\":\"$reason\"}" \
      >/dev/null 2>&1 || log "WARN" "Webhook notification failed (non-fatal)"
  fi
}

# --- Cleanup on exit ---
cleanup() {
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${TEMP_CONTAINER}$"; then
    docker rm -f "$TEMP_CONTAINER" >/dev/null 2>&1 || true
    log "INFO" "Removed temp verify container"
  fi
}
trap cleanup EXIT

# --- Pre-flight checks ---
log "INFO" "Starting backup" "\"db\":\"$DB_NAME\",\"keep\":$BACKUP_KEEP_COUNT,\"verify\":\"$VERIFY_BACKUP\""

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DB_CONTAINER}$"; then
  notify_failure "DB container '$DB_CONTAINER' is not running"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# --- Step 1: Create backup ---
log "INFO" "Creating pg_dump" "\"file\":\"$BACKUP_FILE\""
if ! docker exec "$DB_CONTAINER" pg_dump \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --format=custom \
  --compress=9 \
  --no-password 2>/dev/null > "$BACKUP_FILE"; then
  notify_failure "pg_dump failed"
  rm -f "$BACKUP_FILE"
  exit 1
fi

BACKUP_SIZE="$(du -sh "$BACKUP_FILE" 2>/dev/null | cut -f1)"
log "INFO" "Backup created" "\"file\":\"$BACKUP_FILE\",\"size\":\"$BACKUP_SIZE\""

# --- Step 2: Integrity verification ---
if [ "$VERIFY_BACKUP" = "true" ]; then
  log "INFO" "Running integrity check" "\"container\":\"$TEMP_CONTAINER\""

  # Get postgres image from running container
  PG_IMAGE="$(docker inspect "$DB_CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || echo 'postgres:17-alpine')"

  # Start temp postgres for restore
  docker run -d \
    --name "$TEMP_CONTAINER" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="verify_tmp_pass_$(date +%s)" \
    -e POSTGRES_DB="verify_db" \
    "$PG_IMAGE" >/dev/null

  # Wait for temp DB to be ready (up to 30s)
  READY=false
  for i in $(seq 1 15); do
    if docker exec "$TEMP_CONTAINER" pg_isready -U "$DB_USER" -q 2>/dev/null; then
      READY=true
      break
    fi
    sleep 2
  done

  if [ "$READY" != "true" ]; then
    notify_failure "Temp verify container failed to start"
    EXIT_CODE=1
  else
    # Restore dump into temp DB
    if docker exec -i "$TEMP_CONTAINER" pg_restore \
      -U "$DB_USER" \
      -d "verify_db" \
      --no-password \
      --exit-on-error 2>/dev/null < "$BACKUP_FILE"; then

      # Validate schema: check that at least one table exists
      TABLE_COUNT="$(docker exec "$TEMP_CONTAINER" psql \
        -U "$DB_USER" -d "verify_db" -t \
        -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
        2>/dev/null | tr -d '[:space:]' || echo '0')"

      if [ "${TABLE_COUNT:-0}" -gt 0 ]; then
        log "INFO" "Integrity check passed" "\"tables\":$TABLE_COUNT"
      else
        notify_failure "Integrity check failed: no tables found after restore"
        EXIT_CODE=1
      fi
    else
      notify_failure "pg_restore to verify container failed"
      EXIT_CODE=1
    fi
  fi
fi

# --- Step 3: Retention policy ---
# Keep only the N most recent backups
BACKUP_LIST=$(find "$BACKUP_DIR" -maxdepth 1 -name 'paperclip-*.dump' | sort)
BACKUP_COUNT=$(echo "$BACKUP_LIST" | grep -c . 2>/dev/null || echo 0)

if [ "$BACKUP_COUNT" -gt "$BACKUP_KEEP_COUNT" ]; then
  TO_DELETE=$((BACKUP_COUNT - BACKUP_KEEP_COUNT))
  DELETED=0
  while IFS= read -r old_file; do
    [ "$DELETED" -ge "$TO_DELETE" ] && break
    rm -f "$old_file"
    log "INFO" "Removed old backup" "\"file\":\"$old_file\""
    DELETED=$((DELETED + 1))
  done <<< "$BACKUP_LIST"
fi

# --- Done ---
if [ "$EXIT_CODE" -eq 0 ]; then
  REMAINING=$(find "$BACKUP_DIR" -maxdepth 1 -name 'paperclip-*.dump' | wc -l | tr -d '[:space:]')
  log "INFO" "Backup completed successfully" "\"file\":\"$BACKUP_FILE\",\"size\":\"$BACKUP_SIZE\",\"retained_count\":$REMAINING"
else
  log "ERROR" "Backup finished with errors" "\"file\":\"$BACKUP_FILE\""
fi

exit "$EXIT_CODE"
