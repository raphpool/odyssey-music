#!/usr/bin/env bash
# E2E verifier for rubric item r5_crawler_e2e.
# Runs the crawler against a fixed seed under a strict node budget, then asserts
# the cache shape + dedup + reverse-edge invariants.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-/tmp/og1}"
SEED="${SEED:-jan jelinek tendency}"
MAX_DEPTH="${MAX_DEPTH:-3}"
MAX_NODES="${MAX_NODES:-100}"
CONCURRENCY="${CONCURRENCY:-4}"
MOBILE_SMOKE=0

for arg in "$@"; do
  case "$arg" in
    --mobile-smoke) MOBILE_SMOKE=1 ;;
    *)
      echo "ERROR: unknown argument '$arg' (expected --mobile-smoke)" >&2
      exit 2
      ;;
  esac
done

# This mode is deliberately separate from the crawler recipe below: deployment verification must
# never materialize a broad seed just to prove that the public mobile facade is reachable.
if [[ "$MOBILE_SMOKE" -eq 1 ]]; then
  MOBILE_API_URL="${MOBILE_API_URL:-https://dropcliffs.com/api/odyssey/mobile/v1}"
  : "${MOBILE_SMOKE_IDENTITY:?MOBILE_SMOKE_IDENTITY must name an existing genre node}"
  : "${MOBILE_EXPECTED_SHA:?MOBILE_EXPECTED_SHA must be the exact deployed Git SHA}"
  MOBILE_CONNECT_TIMEOUT_SECONDS="${MOBILE_CONNECT_TIMEOUT_SECONDS:-5}"
  MOBILE_REQUEST_TIMEOUT_SECONDS="${MOBILE_REQUEST_TIMEOUT_SECONDS:-15}"
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT

  if ! node -e '
    const url = new URL(process.argv[1]);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
    const ipv4 = parseIpv4(host);
    const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    function parseIpv4(value) {
      const parts = value.split(".");
      if (parts.length !== 4) return null;
      const octets = parts.map((part) => Number(part));
      return octets.every((octet, index) => /^\d+$/.test(parts[index]) && octet >= 0 && octet <= 255)
        ? octets
        : null;
    }

    // Do not attempt an incomplete local allowlist for IANA special-purpose IPv4/IPv6 ranges.
    // A deployment smoke must use its configured public DNS origin, never an IP literal; this
    // rejects both non-public addresses and otherwise-global exceptions such as 192.0.0.9/.10.
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      ipv4 !== null ||
      host.includes(":") ||
      !dnsName.test(host) ||
      !url.pathname.replace(/\/+$/, "").endsWith("/mobile/v1")
    ) process.exit(1);
  ' "$MOBILE_API_URL"; then
    echo "ERROR: MOBILE_API_URL must be an HTTPS DNS URL ending in /mobile/v1 (IP literals are refused)" >&2
    exit 2
  fi
  if [[ ! "$MOBILE_SMOKE_IDENTITY" =~ ^genre:[a-z0-9]+(-[a-z0-9]+)*(--[a-z0-9]+(-[a-z0-9]+)*)?$ ]]; then
    echo "ERROR: MOBILE_SMOKE_IDENTITY must be a canonical genre identity" >&2
    exit 2
  fi
  if [[ ! "$MOBILE_EXPECTED_SHA" =~ ^[a-f0-9]{40}$ ]]; then
    echo "ERROR: MOBILE_EXPECTED_SHA must be a full lowercase Git SHA" >&2
    exit 2
  fi
  if [[ ! "$MOBILE_CONNECT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ || ! "$MOBILE_REQUEST_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: mobile smoke timeouts must be positive integer seconds" >&2
    exit 2
  fi

  request() {
    local name="$1"
    local url="$2"
    shift 2
    local status
    if ! status="$(curl --silent --show-error --connect-timeout "$MOBILE_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$MOBILE_REQUEST_TIMEOUT_SECONDS" --dump-header "$TEMP_DIR/$name.headers" \
      --output "$TEMP_DIR/$name.body" --write-out '%{http_code}' "$@" "$url")"; then
      echo "ERROR: mobile smoke $name network request failed within ${MOBILE_REQUEST_TIMEOUT_SECONDS}s" >&2
      exit 1
    fi
    if [[ "$status" != "200" ]]; then
      echo "ERROR: mobile smoke $name returned HTTP $status" >&2
      cat "$TEMP_DIR/$name.body" >&2 || true
      exit 1
    fi
  }

  echo "[verify-e2e] mobile smoke: $MOBILE_API_URL ($MOBILE_SMOKE_IDENTITY)"
  request catalog "$MOBILE_API_URL/catalog"
  node -e '
    const payload = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (payload.version !== "v1" || typeof payload.revision !== "string" || !Array.isArray(payload.nodes)) process.exit(1);
  ' "$TEMP_DIR/catalog.body" || {
    echo "ERROR: mobile catalog response is not the documented contract" >&2
    exit 1
  }

  ETAG="$(awk 'BEGIN{IGNORECASE=1} /^ETag:/ {gsub("\\r", "", $2); print $2; exit}' "$TEMP_DIR/catalog.headers")"
  if [[ -z "$ETAG" ]]; then
    echo "ERROR: mobile catalog did not provide an ETag" >&2
    exit 1
  fi
  if ! STATUS_304="$(curl --silent --show-error --connect-timeout "$MOBILE_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$MOBILE_REQUEST_TIMEOUT_SECONDS" --dump-header "$TEMP_DIR/catalog-304.headers" \
    --output "$TEMP_DIR/catalog-304.body" --write-out '%{http_code}' -H "If-None-Match: $ETAG" \
    "$MOBILE_API_URL/catalog")"; then
    echo "ERROR: mobile smoke catalog ETag request failed within ${MOBILE_REQUEST_TIMEOUT_SECONDS}s" >&2
    exit 1
  fi
  if [[ "$STATUS_304" != "304" || -s "$TEMP_DIR/catalog-304.body" ]]; then
    echo "ERROR: mobile catalog did not return an empty 304 for its ETag" >&2
    exit 1
  fi

  request genre-search "$MOBILE_API_URL/search?q=ambient&type=genre&limit=5"
  node -e '
    const payload = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(payload.hits) || typeof payload.sources !== "object" || payload.sources === null) process.exit(1);
  ' "$TEMP_DIR/genre-search.body" || {
    echo "ERROR: mobile search response is not the documented contract" >&2
    exit 1
  }

  ENCODED_IDENTITY="$(node -p 'encodeURIComponent(process.argv[1])' "$MOBILE_SMOKE_IDENTITY")"
  request node "$MOBILE_API_URL/nodes/$ENCODED_IDENTITY"
  node -e '
    const payload = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const expected = process.argv[2];
    const identity = /^genre:[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
    const node = payload && typeof payload === "object" ? payload.node : null;
    if (
      !node || typeof node !== "object" || Array.isArray(node) ||
      payload.source !== "cache" ||
      Object.hasOwn(payload, "redirected_from") ||
      node.id !== expected || node.type !== "genre" || !identity.test(node.id) ||
      typeof node.name !== "string" || typeof node.article !== "string" ||
      !Array.isArray(node.citations) || !node.edges || typeof node.edges !== "object" || Array.isArray(node.edges) ||
      !node.facts || typeof node.facts !== "object" || Array.isArray(node.facts) ||
      typeof node.materialized_at !== "string"
    ) process.exit(1);
  ' "$TEMP_DIR/node.body" "$MOBILE_SMOKE_IDENTITY" || {
    echo "ERROR: mobile node response is not the documented canonical genre contract" >&2
    exit 1
  }

  VERSION_URL="${MOBILE_API_URL%/mobile/v1}/version"
  request version "$VERSION_URL"
  node -e '
    const payload = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const expected = process.argv[2];
    if (payload.sha !== expected) process.exit(1);
    process.stdout.write(`${payload.sha}\n`);
  ' "$TEMP_DIR/version.body" "$MOBILE_EXPECTED_SHA" || {
    echo "ERROR: /version does not match MOBILE_EXPECTED_SHA exactly" >&2
    exit 1
  }
  echo "[verify-e2e] mobile smoke passed."
  exit 0
fi

: "${GEMINI_API_KEY:?GEMINI_API_KEY required}"
: "${TAVILY_API_KEY:?TAVILY_API_KEY required}"
: "${FIRECRAWL_API_KEY:?FIRECRAWL_API_KEY required}"

rm -rf "$OUT"
mkdir -p "$OUT"

cd "$REPO_ROOT"
echo "[verify-e2e] crawl: seed=$SEED depth=$MAX_DEPTH max-nodes=$MAX_NODES concurrency=$CONCURRENCY out=$OUT"
node "$REPO_ROOT/bin/odyssey-crawl.mjs" run \
  --seed "$SEED" \
  --max-depth "$MAX_DEPTH" \
  --max-nodes "$MAX_NODES" \
  --out "$OUT" \
  --concurrency "$CONCURRENCY"

echo "[verify-e2e] asserting cache invariants"
node --experimental-strip-types "$REPO_ROOT/scripts/assert-cache.ts" "$OUT" "$MAX_NODES"
