#!/usr/bin/env bash
set -euo pipefail
# Deploy odyssey-server to the dropcliffs droplet.
#
# Writes a .deployed-sha JSON marker into /opt/odyssey-music/ so /api/odyssey/version
# can report what commit is live.
#
# Usage:
#   bash deploy/deploy-server.sh
#   bash deploy/deploy-server.sh --allow-non-main  # deploy a branch other than main
#   bash deploy/deploy-server.sh --dirty           # deploy with uncommitted changes (NOT recommended)

SERVER="${SERVER:-root@46.101.167.241}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ALLOW_NON_MAIN=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --allow-non-main)  ALLOW_NON_MAIN=1 ;;
    --dirty)           ALLOW_DIRTY=1 ;;
  esac
done

cd "$REPO_ROOT"
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

# /etc/odyssey-music.env is owned by the droplet (manual bootstrap, see
# deploy/bootstrap-env.sh). This deploy script does NOT rewrite it — that
# way API keys live on one host only and never round-trip through CI.
cat > "$REPO_ROOT/.deployed-sha" <<EOF
{
  "sha": "$SHA",
  "sha_short": "$SHA_SHORT",
  "branch": "$BRANCH",
  "dirty": $DIRTY,
  "deployer": "$(whoami)@$(hostname)",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "kind": "server"
}
EOF

echo "==> Rsyncing source to $SERVER:/opt/odyssey-music  (branch=$BRANCH sha=$SHA_SHORT)"
# IMPORTANT: --exclude='cache' so we don't delete nodes the server has materialized
# via JIT since the last deploy. The repo `cache/` and the server `cache/` evolve
# independently; both write atomically and share the same schema.
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.reviews' \
  --exclude='dist' \
  --exclude='cache' \
  --exclude='mobile-state' \
  "$REPO_ROOT/" "$SERVER:/opt/odyssey-music/"

# Seed cache only if the server has none (first deploy).
echo "==> Seeding cache (first deploy only)"
ssh "$SERVER" 'test -d /opt/odyssey-music/cache/nodes && echo "cache exists, keeping"' \
  || rsync -az "$REPO_ROOT/cache/" "$SERVER:/opt/odyssey-music/cache/"

# Also pull the server-only nodes back into the repo so they survive the next deploy
# and are visible to the local CLI / dropcliffs lab generator.
echo "==> Pulling server-only JIT nodes back into repo"
rsync -az --ignore-existing "$SERVER:/opt/odyssey-music/cache/" "$REPO_ROOT/cache/" || true

echo "==> Installing on server + unit + nginx (env is NOT touched)"
ssh "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/odyssey-music

# /etc/odyssey-music.env is the source of truth for API keys and must exist
# before any deploy. Bootstrapped once via deploy/bootstrap-env.sh; never
# rewritten from CI or laptop. Fail loud if missing.
if [[ ! -s /etc/odyssey-music.env ]]; then
  echo "ERROR: /etc/odyssey-music.env missing or empty on droplet." >&2
  echo "Run deploy/bootstrap-env.sh once from a trusted host to seed it." >&2
  exit 1
fi

# yt-dlp + ffmpeg are required by the /stream endpoint (audio player on track pages).
# yt-dlp downloads bestaudio (usually m4a); ffmpeg is its remuxing dependency.
if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "  -> installing yt-dlp"
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod +x /usr/local/bin/yt-dlp
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  -> installing ffmpeg"
  apt-get update -qq && apt-get install -y -qq ffmpeg
fi

mkdir -p /opt/odyssey-music/stream-cache
# The mobile generation and push registries contain paid-work state plus notification
# reservations. They must survive source replacement and remain private to the service account.
install -d -m 0700 -o root -g root /var/lib/track1-mobile

echo "  -> npm install"
rm -rf node_modules
npm install --omit=optional --no-audit --no-fund --silent

cat > /etc/systemd/system/odyssey-server.service <<'UNIT'
[Unit]
Description=odyssey-music JIT scrape API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/odyssey-music
EnvironmentFile=/etc/odyssey-music.env
Environment=MOBILE_STATE_DIR=/var/lib/track1-mobile
# MOBILE_PUSH_ENABLED is absent/false by default. Production activation and EXPO_ACCESS_TOKEN
# stay in /etc/odyssey-music.env; never embed either value in this generated unit.
ExecStart=/opt/odyssey-music/node_modules/.bin/tsx /opt/odyssey-music/src/server.ts
Restart=on-failure
RestartSec=3
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable odyssey-server.service
systemctl restart odyssey-server.service
sleep 3
systemctl is-active odyssey-server.service || (journalctl -u odyssey-server --no-pager -n 50; exit 1)

# Nginx routing for /api/odyssey/ is owned by the dropcliffs deploy template
# (projects/dropcliffs/deploy/nginx.conf). Do NOT patch nginx in place here —
# dropcliffs deploys overwrite the file and silently wiped this route on
# 2026-05-14. Verify route is live; fail loud if it isn't.
if ! grep -q "location /api/odyssey" /etc/nginx/sites-enabled/dropcliffs; then
  echo "ERROR: /api/odyssey route missing from live nginx config." >&2
  echo "Add it to projects/dropcliffs/deploy/nginx.conf and deploy dropcliffs." >&2
  exit 1
fi

# tsx warm-up can take 5-10s after restart; retry the health check instead of
# a single shot. Fail after ~30s.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:18792/health; then
    echo
    break
  fi
  if [ "$i" -eq 10 ]; then
    echo "ERROR: server did not respond on :18792 after 30s" >&2
    journalctl -u odyssey-server --no-pager -n 50 >&2
    exit 1
  fi
  sleep 3
done
echo "==> odyssey-server deployed."
REMOTE

echo "==> Smoke test public origin"
curl -fsS "https://dropcliffs.com/api/odyssey/health"
echo
echo "==> Deploy complete."
