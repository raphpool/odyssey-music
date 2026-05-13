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
