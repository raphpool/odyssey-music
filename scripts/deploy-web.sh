#!/usr/bin/env bash
set -euo pipefail
# Deploy the odyssey-music lab UI to dropcliffs.com/labs/odyssey/.
#
# Lives under odyssey-music (this repo) because the lab UI is owned by THIS repo,
# not dropcliffs. Dropcliffs' main rsyncs are additive (no --delete on labs/) so
# this artifact survives across dropcliffs redeploys.
#
# The --delete inside this script is scoped to /opt/dropcliffs/labs/odyssey/ only,
# so it cannot touch foreign labs (voxel, conviction, etc).
#
# Usage:
#   bash scripts/deploy-web.sh             # rebuild data.json + push
#   bash scripts/deploy-web.sh --no-build  # push current web/ as-is

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${SERVER:-root@46.101.167.241}"
TARGET="${TARGET:-/opt/dropcliffs/labs/odyssey}"

BUILD=1
for arg in "$@"; do
  if [[ "$arg" == "--no-build" ]]; then BUILD=0; fi
done

if [[ $BUILD -eq 1 ]]; then
  echo "==> Rebuilding web/data.json from local cache"
  ( cd "$REPO_ROOT" && npx tsx scripts/build-graph-json.ts cache web/data.json )
fi

if [[ ! -f "$REPO_ROOT/web/index.html" ]]; then
  echo "ERROR: $REPO_ROOT/web/index.html missing." >&2
  exit 1
fi

echo "==> Rsyncing $REPO_ROOT/web/ -> $SERVER:$TARGET/"
rsync -az --delete "$REPO_ROOT/web/" "$SERVER:$TARGET/"

echo "==> Smoke test"
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" "https://dropcliffs.com/labs/odyssey/"
echo "==> Done."
