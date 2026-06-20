#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="${PID_FILE:-$PROJECT_DIR/.http-pg.pid}"

# ---------------------------------------------------------------------------
# Configuration — override via environment
# ---------------------------------------------------------------------------
REQU_PORT="${REQU_PORT:-8788}"
REQU_HOST="${REQU_HOST:-0.0.0.0}"
REQU_ROOT="${REQU_ROOT:-$PROJECT_DIR}"
PG_USER="${PG_USER:-requ}"
PG_PASSWORD="${PG_PASSWORD:-requ}"
PG_DB="${PG_DB:-requ}"
PG_PORT="${PG_PORT:-5432}"
PG_HOST="${PG_HOST:-127.0.0.1}"
REQU_PG_URL="${REQU_PG_URL:-postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}}"

start() {
  # ---------------------------------------------------------------------------
  # 1. Ensure PostgreSQL is running via docker-compose
  # ---------------------------------------------------------------------------
  echo "Starting PostgreSQL (docker-compose)..."
  docker compose -f "$PROJECT_DIR/docker-compose.yml" up -d postgres

  echo "Waiting for PostgreSQL to become healthy..."
  until docker compose -f "$PROJECT_DIR/docker-compose.yml" exec -T postgres \
    pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
    sleep 1
  done
  echo "PostgreSQL is ready."

  # ---------------------------------------------------------------------------
  # 2. Start requ-mcp in HTTP mode (background)
  # ---------------------------------------------------------------------------
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "requ-mcp is already running (PID $(cat "$PID_FILE"))."
    exit 1
  fi

  echo "Starting requ-mcp in HTTP mode on ${REQU_HOST}:${REQU_PORT}..."
  export REQU_TRANSPORT=http
  export REQU_PG_URL
  export REQU_PORT
  export REQU_HOST
  export REQU_ROOT

  nohup "$PROJECT_DIR/node_modules/.bin/tsx" "$PROJECT_DIR/src/index.ts" > /dev/null 2>&1 &
  echo $! > "$PID_FILE"
  echo "requ-mcp started (PID $(cat "$PID_FILE"))."
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "PID file not found. requ-mcp does not appear to be running."
    return
  fi

  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping requ-mcp (PID $PID)..."
    kill "$PID"
    rm -f "$PID_FILE"
    echo "requ-mcp stopped."
  else
    echo "No process found for PID $PID. Cleaning up PID file."
    rm -f "$PID_FILE"
  fi
}

usage() {
  echo "Usage: $0 {start|stop}"
  exit 1
}

case "${1:-}" in
  start) start ;;
  stop)  stop  ;;
  *)     usage ;;
esac
