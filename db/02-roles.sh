#!/bin/bash
# Runs once, when the database volume is first created.
#
# Two roles, so the read tools and the write tools hold different credentials:
#   mcp_reader  SELECT only
#   mcp_writer  SELECT, INSERT, UPDATE -- no DELETE, no DDL
set -euo pipefail

for required in MCP_READER_PASSWORD MCP_WRITER_PASSWORD; do
  if [ -z "${!required:-}" ]; then
    echo "$required is not set" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v reader_password="$MCP_READER_PASSWORD" \
  -v writer_password="$MCP_WRITER_PASSWORD" \
  -v database="$POSTGRES_DB" <<'SQL'
CREATE USER mcp_reader WITH PASSWORD :'reader_password';
GRANT CONNECT ON DATABASE :"database" TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;

CREATE USER mcp_writer WITH PASSWORD :'writer_password';
GRANT CONNECT ON DATABASE :"database" TO mcp_writer;
GRANT USAGE ON SCHEMA public TO mcp_writer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO mcp_writer;
-- create_order inserts without an id, so it needs the identity sequence.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mcp_writer;
SQL
