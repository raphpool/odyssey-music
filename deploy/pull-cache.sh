#!/usr/bin/env bash
set -euo pipefail
# Bring the nodes materialized in prod (JIT clicks, mobile generations) back into the repo -- TRA-493.
#
# deploy-server.sh already pulls server-only nodes back with `rsync --ignore-existing`, but only into
# the runner's checkout and never as a commit, so the repo stopped being the full knowledge base. This is
# the reviewed path: pull, classify, validate, and only with --apply copy -- the commit and the draft PR
# are the workflow's job (.github/workflows/pull-cache.yml, scripts/ci/pull-cache-pr.sh).
#
# READ-ONLY on the server: one rsync whose source is the server and whose destination is a local scratch
# directory. Nothing is ever written, moved or deleted over there, and no ssh command is run.
#   - only $SERVER_CACHE_REMOTE/nodes/ is pulled: the youtube/ and links/ sidecars are git-ignored,
#     derived data, and pending-reverses.json is the migration channel's business;
#   - --no-links: a symlink on the server is never followed nor recreated here.
# Classification and validation are scripts/ci/pull-cache-validate.ts's (see its header): `new` files
# are those absent from the repo, `changed` ones (same slug, other bytes) are listed and NEVER copied --
# after the identity migration the repo is the source of truth. A copy never overwrites a file either.
#
# No personal SSH key: relies on the caller's ssh-agent, like deploy-server.sh and sync-genre-cache.sh.
#
# Usage:
#   bash deploy/pull-cache.sh            # preview: prints the classification and the validation result
#   bash deploy/pull-cache.sh --apply    # also copies the validated `new` nodes into cache/nodes/
# Env: PULL_OUT_DIR keeps new.txt / changed.txt (one slug per line) for the caller; default: scratch.
# Exit: 0 ok, 1 validation failed (nothing copied), 2 usage or read error; a failed pull exits with rsync's
# own status (nothing copied either).

SERVER="${SERVER:-root@46.101.167.241}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_CACHE_DIR="${REPO_CACHE_DIR:-$REPO_ROOT/cache}"
SERVER_CACHE_REMOTE="${SERVER_CACHE_REMOTE:-/opt/odyssey-music/cache}"

APPLY=0
for arg in "$@"; do
	case "$arg" in
		--apply) APPLY=1 ;;
		*) echo "usage: pull-cache.sh [--apply]" >&2; exit 2 ;;
	esac
done

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
OUT_DIR="${PULL_OUT_DIR:-$SCRATCH/out}"
mkdir -p "$SCRATCH/pulled/nodes"

echo "==> Pulling $SERVER:$SERVER_CACHE_REMOTE/nodes/ (read-only)"
rsync -az --no-links "$SERVER:$SERVER_CACHE_REMOTE/nodes/" "$SCRATCH/pulled/nodes/"

echo "==> Classifying and validating"
# Test seam, like sync-genre-cache.sh's REPO_*_PATH overrides: the workflow sets none, so the committed
# data/integrity-thresholds.json is what judges a real run.
VALIDATE_ARGS=()
if [ -n "${PULL_THRESHOLDS_PATH:-}" ]; then VALIDATE_ARGS+=(--thresholds "$PULL_THRESHOLDS_PATH"); fi
STATUS=0
(cd "$REPO_ROOT" && npx --no-install tsx scripts/ci/pull-cache-validate.ts \
	"$SCRATCH/pulled" "$REPO_CACHE_DIR" --out-dir "$OUT_DIR" ${VALIDATE_ARGS[@]+"${VALIDATE_ARGS[@]}"}) || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
	echo "ERROR: validation failed (exit $STATUS); nothing was copied." >&2
	exit "$STATUS"
fi

NEW_COUNT="$(grep -c . "$OUT_DIR/new.txt" || true)"
if [ "$APPLY" -eq 0 ]; then
	echo "Preview only (no --apply): $NEW_COUNT node(s) would be copied into $REPO_CACHE_DIR/nodes/."
	exit 0
fi

echo "==> Copying $NEW_COUNT validated node(s) into $REPO_CACHE_DIR/nodes/"
while IFS= read -r slug; do
	[ -n "$slug" ] || continue
	# The validator only lists canonical slugs; checked again because this is a path.
	case "$slug" in
		*/* | *..* | *[[:space:]]*) echo "ERROR: refusing the unsafe slug $slug" >&2; exit 1 ;;
	esac
	type="${slug%%:*}"
	body="${slug#*:}"
	dest="$REPO_CACHE_DIR/nodes/$type/$body.json"
	if [ -e "$dest" ] || [ -L "$dest" ]; then
		echo "ERROR: $dest already exists; a pull never overwrites a repo node." >&2
		exit 1
	fi
	mkdir -p "$REPO_CACHE_DIR/nodes/$type"
	cp -- "$SCRATCH/pulled/nodes/$type/$body.json" "$dest"
	chmod 644 "$dest" # rsync -a kept the server's mode: no mode noise in the PR
done < "$OUT_DIR/new.txt"
echo "Copied $NEW_COUNT node(s). Review with git status; the workflow commits them."
