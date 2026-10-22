#!/bin/sh
# Restore a Postgres custom-format dump. Stop WA MCP first.
# Without --force, pg_restore does not drop existing objects.
set -eu

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore is required to restore Postgres" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required on the host to restore Postgres" >&2
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

pgpass=$(mktemp)
chmod 600 "$pgpass"
trap 'rm -f "$pgpass"' EXIT
safe_url=$(WAMCP_DATABASE_URL="$database_url" WAMCP_PGPASS_FILE="$pgpass" node -e '
const fs = require("node:fs");
const url = new URL(process.env.WAMCP_DATABASE_URL);
const esc = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
const host = url.hostname || "localhost";
const port = url.port || "5432";
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
fs.writeFileSync(process.env.WAMCP_PGPASS_FILE, `${esc(host)}:${esc(port)}:${esc(database)}:${esc(user)}:${esc(password)}\n`);
url.password = "";
process.stdout.write(url.href);
')
if [ "$force" -eq 1 ]; then
  PGPASSFILE=$pgpass pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$safe_url" "$dump"
else
  PGPASSFILE=$pgpass pg_restore --no-owner --exit-on-error --dbname="$safe_url" "$dump"
fi
