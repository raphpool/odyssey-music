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
# A .deployed-sha JSON marker is written into the rsynced tree so we can tell at
# any time what commit is live (curl https://dropcliffs.com/labs/odyssey/.deployed-sha).
#
# Usage:
#   bash scripts/deploy-web.sh                   # rebuild data.json + push
#   bash scripts/deploy-web.sh --no-build        # push current web/ as-is
#   bash scripts/deploy-web.sh --allow-non-main  # deploy a branch other than main
#   bash scripts/deploy-web.sh --dirty           # deploy with uncommitted changes (NOT recommended)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${SERVER:-root@46.101.167.241}"
TARGET="${TARGET:-/opt/dropcliffs/labs/odyssey}"

BUILD=1
ALLOW_NON_MAIN=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --no-build)        BUILD=0 ;;
    --allow-non-main)  ALLOW_NON_MAIN=1 ;;
    --dirty)           ALLOW_DIRTY=1 ;;
  esac
done

cd "$REPO_ROOT"

# --- Git hygiene gates ---------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
SHA_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  DIRTY=1
fi

if [[ "$BRANCH" != "main" && $ALLOW_NON_MAIN -eq 0 ]]; then
  echo "ERROR: refusing to deploy from branch '$BRANCH' (expected main)." >&2
  echo "       Either merge to main first, or pass --allow-non-main." >&2
  exit 1
fi
if [[ $DIRTY -eq 1 && $ALLOW_DIRTY -eq 0 ]]; then
  echo "ERROR: working tree is dirty. Commit/stash first, or pass --dirty." >&2
  git status --short >&2
  exit 1
fi
if [[ "$BRANCH" != "main" ]]; then
  echo "WARN: deploying from non-main branch '$BRANCH' ($SHA_SHORT)."
fi
if [[ $DIRTY -eq 1 ]]; then
  echo "WARN: deploying with uncommitted changes (sha $SHA_SHORT does not reflect what's on disk)."
fi

# --- Build ---------------------------------------------------------------------
if [[ $BUILD -eq 1 ]]; then
  echo "==> Rebuilding web/data.json from local cache"
  ( cd "$REPO_ROOT" && npx tsx scripts/build-graph-json.ts cache web/data.json )
fi

if [[ ! -f "$REPO_ROOT/web/index.html" ]]; then
  echo "ERROR: $REPO_ROOT/web/index.html missing." >&2
  exit 1
fi

# --- Provenance marker ---------------------------------------------------------
cat > "$REPO_ROOT/web/.deployed-sha" <<EOF
{
  "sha": "$SHA",
  "sha_short": "$SHA_SHORT",
  "branch": "$BRANCH",
  "dirty": $DIRTY,
  "deployer": "$(whoami)@$(hostname)",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "kind": "web"
}
EOF

echo "==> Rsyncing $REPO_ROOT/web/ -> $SERVER:$TARGET/  (branch=$BRANCH sha=$SHA_SHORT)"
rsync -az --delete "$REPO_ROOT/web/" "$SERVER:$TARGET/"

echo "==> Smoke test"
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" "https://dropcliffs.com/labs/odyssey/"
echo "==> Done. Live SHA: $SHA_SHORT"
