#!/bin/bash
# Runs once, when the database volume is first created.
set -euo pipefail

if [ -z "${MCP_READER_PASSWORD:-}" ]; then
  echo "MCP_READER_PASSWORD is not set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v reader_password="$MCP_READER_PASSWORD" <<'SQL'
CREATE USER mcp_reader WITH PASSWORD :'reader_password';
GRANT CONNECT ON DATABASE shop TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
SQL
