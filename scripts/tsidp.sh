#!/bin/bash
# Upstream development mode: tsidp on the Mac's existing tailscaled.
# Do not use this on mac-muon. The node is tagged, and tsidp rejects tagged
# nodes at /authorize. Direct connections also skip Tailscale Serve, so WhoIs
# fails. Use `docker compose up -d tsidp` instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export TAILSCALE_USE_WIP_CODE=1
exec "$ROOT/bin/tsidp-server" \
  --use-local-tailscaled \
  --enable-sts \
  --dir "$ROOT/tsidp-state" \
  --port "${TSIDP_PORT:-443}"
