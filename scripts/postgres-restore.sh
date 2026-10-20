#!/bin/sh
# Restore a Postgres custom-format dump. Stop WA MCP first.
# Without --force, pg_restore does not drop existing objects.
set -eu

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore is required to restore Postgres" >&2
  exit 1
fi

dump=${1:-}
database_url=${2:-${WA_DATABASE_URL:-}}
force=0

if [ "${3:-}" = "--force" ] || [ "${2:-}" = "--force" ]; then
  force=1
  if [ "${2:-}" = "--force" ]; then
    database_url=${WA_DATABASE_URL:-}
  fi
fi

if [ -z "$dump" ] || [ -z "$database_url" ]; then
  echo "Usage: postgres-restore.sh <dump> <postgres-url> [--force]" >&2
  exit 1
fi

if [ "$force" -eq 1 ]; then
  pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$database_url" "$dump"
else
  pg_restore --no-owner --exit-on-error --dbname="$database_url" "$dump"
fi
