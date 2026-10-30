#!/bin/bash
# Upstream development mode: tsidp on an existing local tailscaled, instead of
# its own tsnet node. Only useful for hacking on tsidp itself.
#
# The node running this must be untagged. tsidp rejects a tagged node at
# /authorize with "tagged node doesn't have a user identity", and a direct
# connection also skips Tailscale Serve, so WhoIs has nothing to resolve.
# For everything else use `docker compose up -d tsidp`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export TAILSCALE_USE_WIP_CODE=1
exec "$ROOT/bin/tsidp-server" \
  --use-local-tailscaled \
  --enable-sts \
  --dir "$ROOT/tsidp-state" \
  --port "${TSIDP_PORT:-443}"
