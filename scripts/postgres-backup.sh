#!/bin/sh
# Backup a Postgres WA MCP database. Does not read or change the SQLite file.
set -eu

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump is required to back up Postgres" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required on the host to back up Postgres" >&2
  exit 1
fi

database_url=${1:-${WA_DATABASE_URL:-}}
backup_dir=${2:-.}

if [ -z "$database_url" ]; then
  echo "Usage: postgres-backup.sh <postgres-url> [backup-directory]" >&2
  echo "Or set WA_DATABASE_URL and pass the backup directory as the first argument." >&2
  exit 1
fi

case "$database_url" in
  postgres://*|postgresql://*) ;;
  *)
    if [ -n "${WA_DATABASE_URL:-}" ]; then
      backup_dir=$database_url
      database_url=$WA_DATABASE_URL
    else
      echo "The database URL must use the postgres: or postgresql: scheme" >&2
      exit 1
    fi
    ;;
esac

mkdir -p "$backup_dir"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$backup_dir/wamcp-postgres-$stamp.dump"
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
PGPASSFILE=$pgpass pg_dump --format=custom --no-owner --file="$destination" "$safe_url"
chmod 600 "$destination"
echo "$destination"
