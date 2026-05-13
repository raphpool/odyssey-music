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
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.reviews' \
  --exclude='dist' \
  "$REPO_ROOT/" "$SERVER:/opt/odyssey-music/"

echo "==> Installing on server + writing env + unit + nginx"
ssh "$SERVER" \
  GEMINI_API_KEY="$GEMINI_API_KEY" \
  TAVILY_API_KEY="$TAVILY_API_KEY" \
  FIRECRAWL_API_KEY="$FIRECRAWL_API_KEY" \
  bash -s <<'REMOTE'
set -euo pipefail
cd /opt/odyssey-music

umask 077
cat > /etc/odyssey-music.env <<EOF
GEMINI_API_KEY=$GEMINI_API_KEY
TAVILY_API_KEY=$TAVILY_API_KEY
FIRECRAWL_API_KEY=$FIRECRAWL_API_KEY
ODYSSEY_CACHE_DIR=/opt/odyssey-music/cache
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

NGINX_CONF=/etc/nginx/sites-enabled/dropcliffs
if ! grep -q "location /api/odyssey" "$NGINX_CONF"; then
  echo "  -> patching nginx"
  python3 - <<'PY'
import re
p = "/etc/nginx/sites-enabled/dropcliffs"
s = open(p).read()
block = """    location /api/odyssey/ {
        proxy_pass http://127.0.0.1:18792/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }

"""
new = re.sub(r'(    location /api \{)', block + r'\1', s, count=1)
if new == s:
    raise SystemExit("could not find /api block")
open(p, 'w').write(new)
PY
  cp "$NGINX_CONF" /etc/nginx/sites-available/dropcliffs
  nginx -t
  systemctl reload nginx
fi

curl -fsS http://127.0.0.1:18792/health
echo
echo "==> odyssey-server deployed."
REMOTE

echo "==> Smoke test public origin"
curl -fsS "https://dropcliffs.com/api/odyssey/health"
echo
echo "==> Deploy complete."
