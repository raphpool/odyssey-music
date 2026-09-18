#!/usr/bin/env bash
set -euo pipefail
# Controlled transfer of a validated genre-cache union onto the server -- B6b (TRA-67).
#
# deploy-server.sh's own rsync excludes cache/ entirely (the server materializes nodes on its
# own via JIT), so shipping the seed/curation work done in the repo needs its own, careful path.
# This wraps scripts/prepare-genre-cache-union.ts (B6a/TRA-66, B6a-2/TRA-234) with the sequence
# fixed by the plan's decision 6: snapshot the server cache read-only, build a validated union,
# print its manifest, and only with --apply actually touch the server -- archive first, stop the
# writer, re-check nothing wrote to the server between the snapshot and the stop, transfer,
# restart, smoke test. Rollback = the printed archive.
#
# "Additive" here is file-additive: rsync never passes --delete, so no node file is removed, but a
# node present on both sides is OVERWRITTEN in place -- a field or an edge only the server had is
# lost unless the union preserved it. The archive, not the transfer mode, makes that recoverable.
#
# No personal SSH key: this relies on the caller's ssh-agent (same as deploy-server.sh / the
# `deploy` job on the self-hosted runner) and never writes to $HOME/.ssh or $HOME/.
#
# DO NOT RUN WITH --apply YET. Two separate tickets gate it, and both must land first:
#   - TRA-271 (blocks TRA-269, the prod rollout): an independent review of this ticket found a
#     relevé/arrêt race and writer-left-down gaps in the --apply path below (a stop or the smoke
#     test failing can leave odyssey-server stopped).
#   - TRA-268: the union keeps the winning file whole when a slug exists on both sides, so an edge
#     only the server carries is dropped -- reproduced on a shared node, where a server-only
#     `related_genres` entry vanished with exit code 0 and an empty `referenceRegressions` (the
#     target is still a live node, so the union's own check sees nothing). Preview-only is safe.
# A third gap -- the union's own deletions and merged redirects table, which an additive
# transfer cannot propagate -- is refused outright below rather than left to prose.
#
# Usage:
#   bash deploy/sync-genre-cache.sh            # preview only: builds + prints the union manifest
#   bash deploy/sync-genre-cache.sh --apply    # also syncs the server cache (see above)
#
# Real workflow_dispatch wiring (when this runs, and from what trigger) is out of scope here --
# that's B6c, a separate ticket. A git branch/clean-tree guard (deploy-server.sh:34-43's own
# pattern) was reviewed as a nit but deferred to TRA-271 to keep this ticket under the diff-size
# gate -- add it there alongside the other hardening.

SERVER="${SERVER:-root@46.101.167.241}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_CACHE_DIR="${REPO_CACHE_DIR:-$REPO_ROOT/cache}"
SERVER_CACHE_REMOTE="${SERVER_CACHE_REMOTE:-/opt/odyssey-music/cache}"
SERVER_REDIRECTS_REMOTE="${SERVER_REDIRECTS_REMOTE:-/opt/odyssey-music/data/genre-redirects.json}"
SERVER_BACKUP_DIR="${SERVER_BACKUP_DIR:-/opt/odyssey-music-backups}"
# Not a real convention anywhere else in the repo yet -- a future crawl-on-the-server automation
# (out of scope here) is expected to create/remove this marker around its own run.
SERVER_CRAWL_LOCK="${SERVER_CRAWL_LOCK:-/opt/odyssey-music/.crawl-lock}"
SERVER_HEALTH_URL="${SERVER_HEALTH_URL:-https://dropcliffs.com/api/odyssey/health}"
SERVER_VERSION_URL="${SERVER_VERSION_URL:-https://dropcliffs.com/api/odyssey/version}"

APPLY=0
for arg in "$@"; do
	case "$arg" in
		--apply) APPLY=1 ;;
		*)
			echo "ERROR: unknown argument '$arg'." >&2
			exit 1
			;;
	esac
done

WORKDIR="$(mktemp -d)"
SNAPSHOT_DIR="$WORKDIR/server-cache-snapshot"
SNAPSHOT_REDIRECTS="$WORKDIR/server-genre-redirects.json"
UNION_DIR=""
# Removes WORKDIR and the union's own mktemp output under os.tmpdir(), which
# prepare-genre-cache-union.ts never removes itself.
cleanup() {
	[[ -n "$UNION_DIR" ]] && rm -rf "$UNION_DIR"
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

# Content fingerprint of the server's cache tree, computed ON the server (not from a local copy,
# which can't change) so two calls at different times reflect the server's real state. `find |
# while read` (rather than xargs) never runs the pipeline's tail on an empty listing, so an empty
# cache still yields a deterministic hash instead of hanging or erroring.
remote_hash() {
	ssh "$SERVER" "find '$SERVER_CACHE_REMOTE' -type f -name '*.json' | LC_ALL=C sort | while read -r f; do cat \"\$f\"; done | sha256sum | awk '{print \$1}'"
}

echo "==> Snapshotting server cache (read-only) from $SERVER:$SERVER_CACHE_REMOTE"
mkdir -p "$SNAPSHOT_DIR"
rsync -az "$SERVER:$SERVER_CACHE_REMOTE/" "$SNAPSHOT_DIR/"
# A missing table is a hard refusal, never a silent "no redirects" (same discipline as
# loadRequiredGenreRedirects, TRA-245): the server's table is untrusted data.
if ! ssh "$SERVER" "test -f '$SERVER_REDIRECTS_REMOTE'"; then
	echo "ERROR: server redirects table missing or unreachable at $SERVER:$SERVER_REDIRECTS_REMOTE -- refusing." >&2
	exit 1
fi
ssh "$SERVER" "cat '$SERVER_REDIRECTS_REMOTE'" >"$SNAPSHOT_REDIRECTS"
SNAPSHOT_FINGERPRINT="$(remote_hash)"

echo "==> Building the validated cache union (repo + server snapshot)"
set +e
UNION_OUTPUT="$(cd "$REPO_ROOT" && npx tsx scripts/prepare-genre-cache-union.ts \
	"$REPO_CACHE_DIR" "$SNAPSHOT_DIR" --apply-merge \
	--server-redirects-path "$SNAPSHOT_REDIRECTS")"
UNION_EXIT=$?
set -e
echo "$UNION_OUTPUT"
UNION_DIR="$(printf '%s\n' "$UNION_OUTPUT" | sed -n 's/^Union written to \(.*\) (.*)$/\1/p' | tail -n1)"
if [[ -z "$UNION_DIR" ]]; then
	echo "ERROR: could not parse the union output directory from: $UNION_OUTPUT" >&2
	exit 1
fi
echo "==> Manifest: $UNION_DIR/manifest.json"
cat "$UNION_DIR/manifest.json"

# Belt-and-suspenders (TRA-245 review): never rely on the exit code alone -- a non-empty
# redirectsConflicts (diverged-target / inverted-pair / cycle / dangling) is refused explicitly
# even if a future change to the union's own exit-code logic ever missed counting it.
if [[ $UNION_EXIT -ne 0 ]] || grep -q '"redirectsConflicts"' "$UNION_DIR/manifest.json"; then
	echo "ERROR: cache union reported problems (conflicts/regressions/redirects, see manifest above) -- refusing." >&2
	exit 1
fi

if [[ $APPLY -eq 0 ]]; then
	echo "==> Preview only (pass --apply to sync the server). No server write performed."
	exit 0
fi

# 2026-09-18 (review of TRA-67): the union runs the merge migration with --apply-merge, which
# DELETES the losing file of a duplicate-QID group from the artifact and writes the merged
# genre-redirects.json. The transfer below ships only nodes/, never with --delete: a duplicate that
# already exists on the server therefore survives there and keeps being served, while the validated
# union declares it merged -- and the redirects table that would point at the winner is never sent.
# Nothing else catches it: deletedCount is not part of countUnionProblems, so the union exits 0 and
# the run would end on "Sync complete". Refuse instead, before touching the server at all.
# Propagating deletions and the redirects table is B6c's job (TRA-269), not this ticket's.
DELETED_COUNT="$(node -e 'const m=require(process.argv[1]);const a=m.migrationApply;process.stdout.write(String((a?.deletedCount ?? 0) + (a?.removedByMigration?.length ?? 0)))' "$UNION_DIR/manifest.json")"
if [[ "$DELETED_COUNT" != "0" ]]; then
	echo "ERROR: the union merged duplicate nodes (deletedCount + removedByMigration = $DELETED_COUNT) -- an additive transfer cannot propagate those deletions nor the merged redirects table, so the server would keep serving the merged-away duplicates. Refusing before any server write." >&2
	exit 1
fi

echo "==> Checking for an active crawl lock on the server"
if ssh "$SERVER" "test -f '$SERVER_CRAWL_LOCK'"; then
	echo "ERROR: crawl lock present ($SERVER_CRAWL_LOCK) -- a crawl is in progress, refusing." >&2
	exit 1
fi

echo "==> Archiving server cache before writing (mandatory)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_PATH="$SERVER_BACKUP_DIR/genre-cache-$TIMESTAMP.tar.gz"
ssh "$SERVER" "mkdir -p '$SERVER_BACKUP_DIR' && tar czf '$ARCHIVE_PATH' -C '$(dirname "$SERVER_CACHE_REMOTE")' '$(basename "$SERVER_CACHE_REMOTE")'"
echo "==> Verifying archive integrity"
ssh "$SERVER" "gzip -t '$ARCHIVE_PATH'"
echo "==> Rollback archive: $SERVER:$ARCHIVE_PATH"

STOPPED=0
restart_writer() {
	if [[ $STOPPED -eq 1 ]]; then
		echo "==> Restarting odyssey-server.service"
		ssh "$SERVER" "systemctl start odyssey-server.service" || true
		STOPPED=0
	fi
}
on_failure() {
	local code=$?
	restart_writer
	# 2026-09-17 (review of TRA-67): claiming "no data was removed" here skipped a needed restore.
	echo "ERROR: sync failed -- the writer was restarted, but node files already transferred were overwritten in place (rsync never deletes, it overwrites). Restore from the archive if the run got past the transfer step: $SERVER:$ARCHIVE_PATH" >&2
	exit "$code"
}
trap on_failure ERR

echo "==> Stopping odyssey-server.service (writer)"
ssh "$SERVER" "systemctl stop odyssey-server.service"
STOPPED=1
if ssh "$SERVER" "systemctl is-active --quiet odyssey-server.service"; then
	echo "ERROR: odyssey-server.service is still active after stop -- refusing to write." >&2
	# Explicit call (not relying on the ERR trap for a deliberate `exit`): restart whatever we can,
	# even though "still active" means our own stop above likely had no effect either way.
	restart_writer
	exit 1
fi

echo "==> Verifying the server cache has not changed since the snapshot"
CURRENT_FINGERPRINT="$(remote_hash)"
if [[ "$CURRENT_FINGERPRINT" != "$SNAPSHOT_FINGERPRINT" ]]; then
	echo "ERROR: server cache fingerprint changed since the snapshot ($SNAPSHOT_FINGERPRINT -> $CURRENT_FINGERPRINT) -- refusing to write." >&2
	restart_writer
	exit 1
fi

echo "==> Transferring the validated union (never --delete; shared node files are overwritten)"
rsync -az "$UNION_DIR/nodes/" "$SERVER:$SERVER_CACHE_REMOTE/nodes/"

restart_writer

echo "==> Smoke test"
curl -fsS "$SERVER_HEALTH_URL"
echo
curl -fsS "$SERVER_VERSION_URL"
echo

trap - ERR
echo "==> Sync complete. Rollback archive if needed: $SERVER:$ARCHIVE_PATH"
