#!/usr/bin/env bash
set -euo pipefail
# One-time bootstrap of /etc/odyssey-music.env on the droplet.
#
# Run this manually from a trusted host (e.g. a maintainer's laptop) whenever
# the API keys change or on a fresh droplet. The auto-deploy workflow does NOT
# touch /etc/odyssey-music.env — the file is the single source of truth and
# lives only on the droplet.
#
# Usage:
#   bash deploy/bootstrap-env.sh
#
# Reads $REPO_ROOT/.env (must contain GEMINI_API_KEY / TAVILY_API_KEY /
# FIRECRAWL_API_KEY) and writes /etc/odyssey-music.env on $SERVER with
# 0600 perms. Restarts odyssey-server after to pick up new values.

SERVER="${SERVER:-root@46.101.167.241}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "ERROR: missing $REPO_ROOT/.env (need GEMINI_API_KEY / TAVILY_API_KEY / FIRECRAWL_API_KEY)" >&2
  exit 1
fi

set -a
. "$REPO_ROOT/.env"
set +a

: "${GEMINI_API_KEY:?missing in .env}"
: "${TAVILY_API_KEY:?missing in .env}"
: "${FIRECRAWL_API_KEY:?missing in .env}"

echo "==> Writing /etc/odyssey-music.env on $SERVER"
ssh "$SERVER" \
  GEMINI_API_KEY="$GEMINI_API_KEY" \
  TAVILY_API_KEY="$TAVILY_API_KEY" \
  FIRECRAWL_API_KEY="$FIRECRAWL_API_KEY" \
  bash -s <<'REMOTE'
set -euo pipefail
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
echo "  -> /etc/odyssey-music.env written ($(wc -c < /etc/odyssey-music.env) bytes)"

if systemctl is-active --quiet odyssey-server.service; then
  echo "  -> restarting odyssey-server.service to pick up new env"
  systemctl restart odyssey-server.service
fi
REMOTE

echo "==> Bootstrap complete."
