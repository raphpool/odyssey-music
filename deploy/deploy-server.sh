#!/usr/bin/env bash
set -euo pipefail
# Deploy odyssey-server to the dropcliffs droplet.

SERVER="${SERVER:-root@46.101.167.241}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "ERROR: missing $REPO_ROOT/.env" >&2
  exit 1
fi

set -a
. "$REPO_ROOT/.env"
set +a

echo "==> Rsyncing source to $SERVER:/opt/odyssey-music"
# IMPORTANT: --exclude='cache' so we don't delete nodes the server has materialized
# via JIT since the last deploy. The repo `cache/` and the server `cache/` evolve
# independently; both write atomically and share the same schema.
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.reviews' \
  --exclude='dist' \
  --exclude='cache' \
  "$REPO_ROOT/" "$SERVER:/opt/odyssey-music/"

# Seed cache only if the server has none (first deploy).
echo "==> Seeding cache (first deploy only)"
ssh "$SERVER" 'test -d /opt/odyssey-music/cache/nodes && echo "cache exists, keeping"' \
  || rsync -az "$REPO_ROOT/cache/" "$SERVER:/opt/odyssey-music/cache/"

# Also pull the server-only nodes back into the repo so they survive the next deploy
# and are visible to the local CLI / dropcliffs lab generator.
echo "==> Pulling server-only JIT nodes back into repo"
rsync -az --ignore-existing "$SERVER:/opt/odyssey-music/cache/" "$REPO_ROOT/cache/" || true

echo "==> Installing on server + writing env + unit + nginx"
ssh "$SERVER" \
  GEMINI_API_KEY="$GEMINI_API_KEY" \
  TAVILY_API_KEY="$TAVILY_API_KEY" \
  FIRECRAWL_API_KEY="$FIRECRAWL_API_KEY" \
  bash -s <<'REMOTE'
set -euo pipefail
cd /opt/odyssey-music

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

umask 077
cat > /etc/odyssey-music.env <<EOF
GEMINI_API_KEY=$GEMINI_API_KEY
TAVILY_API_KEY=$TAVILY_API_KEY
FIRECRAWL_API_KEY=$FIRECRAWL_API_KEY
ODYSSEY_CACHE_DIR=/opt/odyssey-music/cache
STREAM_CACHE_DIR=/opt/odyssey-music/stream-cache
PORT=18792
EOF
chmod 600 /etc/odyssey-music.env
umask 022

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

curl -fsS http://127.0.0.1:18792/health
echo
echo "==> odyssey-server deployed."
REMOTE

echo "==> Smoke test public origin"
curl -fsS "https://dropcliffs.com/api/odyssey/health"
echo
echo "==> Deploy complete."
