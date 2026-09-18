#!/usr/bin/env bash
set -euo pipefail
# Controlled transfer of a validated genre-cache union onto the server -- B6b (TRA-67), hardened
# against process failures and signals in B6b-2 (TRA-271).
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
# DEPLOY GUARD: the merge-duplicate refusal below (search "merged duplicate nodes") is a permanent
# safety net, not a placeholder for a blocking ticket -- both tickets that used to gate --apply
# (TRA-271, this hardening pass, and TRA-268, the union's edge-merge) are now landed. The union
# still deletes the losing file of a duplicate-QID group from its artifact and writes a merged
# genre-redirects.json when it runs with --apply-merge; an additive transfer (rsync without
# --delete) cannot propagate either the deletion or the redirects table, so that refusal stays
# active until a future ticket (B6c / TRA-269) teaches this script to ship deletions too.
#
# Usage:
#   bash deploy/sync-genre-cache.sh            # preview only: builds + prints the union manifest
#   bash deploy/sync-genre-cache.sh --apply    # also syncs the server cache (see above)
#
# Real workflow_dispatch wiring (when this runs, and from what trigger) is out of scope here --
# that's B6c, a separate ticket.

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
# How many archives to keep in SERVER_BACKUP_DIR (TRA-269 runs this on a recurring schedule, so
# the directory needs a retention policy or it grows unbounded -- PR #221 review).
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-10}"
# tsx can take 5-10s to warm up after a restart (same constant as deploy/deploy-server.sh's own
# health-check retry loop); retry instead of a single shot.
SMOKE_RETRY_COUNT="${SMOKE_RETRY_COUNT:-10}"
SMOKE_RETRY_DELAY="${SMOKE_RETRY_DELAY:-3}"

# 2026-09-18 (TRA-271, deferred as a nit on TRA-67 to keep that diff under the CI gate): same
# branch/clean-tree discipline as deploy/deploy-server.sh:34-43, reused verbatim in spirit. Kept
# as env-var overrides (not flags) so the test harness can run the script from this repo's own
# worktree/branch without faking an entire git checkout for every scenario.
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [[ "$BRANCH" != "main" && "${SYNC_ALLOW_NON_MAIN:-0}" != "1" ]]; then
	echo "ERROR: refusing to sync from branch '$BRANCH' (expected main) -- merge to main first, or set SYNC_ALLOW_NON_MAIN=1." >&2
	exit 1
fi
if { ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; } \
	&& [[ "${SYNC_ALLOW_DIRTY:-0}" != "1" ]]; then
	echo "ERROR: working tree is dirty -- commit or stash first, or set SYNC_ALLOW_DIRTY=1." >&2
	git -C "$REPO_ROOT" status --short >&2
	exit 1
fi

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
ARCHIVE_PATH=""
STOPPED=0
WRITER_WAS_STOPPED=0

# Removes WORKDIR and the union's own mktemp output under os.tmpdir(), which
# prepare-genre-cache-union.ts never removes itself.
cleanup() {
	[[ -n "$UNION_DIR" ]] && rm -rf "$UNION_DIR"
	rm -rf "$WORKDIR"
}
restart_writer() {
	if [[ $STOPPED -eq 1 ]]; then
		echo "==> Restarting odyssey-server.service"
		# 2026-09-18 (review of TRA-67): `|| true` here used to swallow a failed `systemctl start`
		# outright -- the script would report success (or fall through into a doomed smoke test)
		# with the writer still down. STOPPED stays 1 on failure so a later retry (the EXIT trap
		# below, or the explicit check right after the transfer) still tries again / fails loud.
		if ssh "$SERVER" "systemctl start odyssey-server.service"; then
			STOPPED=0
		else
			echo "ERROR: failed to restart odyssey-server.service -- the writer is still down, restart it manually on $SERVER." >&2
		fi
	fi
}
# 2026-09-18 (independent review of TRA-67): STOPPED used to flip to 1 only AFTER the stop
# command succeeded, so a stop that itself failed triggered no restart attempt; and the recovery
# path only trapped ERR, which never fires for a signal -- a SIGTERM or Ctrl-C during the transfer
# left the writer stopped with nothing to bring it back. STOPPED now flips before the stop is even
# attempted (below), and this fires from EXIT (which INT/TERM reach too, via the explicit `exit`
# in their own trap, since a signal with no trap of its own does not reliably run the EXIT trap).
on_exit() {
	local code=$?
	restart_writer
	cleanup
	if [[ $code -ne 0 && $WRITER_WAS_STOPPED -eq 1 ]]; then
		echo "ERROR: sync failed -- the writer was restarted if it could be, but any node files already transferred were overwritten in place (rsync never deletes, it overwrites). Restore from the archive if the run got past the transfer step: $SERVER:$ARCHIVE_PATH" >&2
	fi
	exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Content fingerprint of the server's cache tree, computed ON the server (not from a local copy,
# which can't change) so two calls at different times reflect the server's real state. `find |
# while read` (rather than xargs) never runs the pipeline's tail on an empty listing, so an empty
# cache still yields a deterministic hash instead of hanging or erroring. `set -o pipefail` on the
# remote shell (TRA-271 nit) makes a failed read of one file fail the whole pipeline instead of
# silently hashing a partial tree; excluding youtube/ and links/ (TRA-271 nit) keeps the fingerprint
# stable across resolver sidecar churn the CLAUDE.md conventions already treat as regenerable.
remote_hash() {
	ssh "$SERVER" "set -o pipefail; find '$SERVER_CACHE_REMOTE' -type f -name '*.json' -not -path '$SERVER_CACHE_REMOTE/youtube/*' -not -path '$SERVER_CACHE_REMOTE/links/*' | LC_ALL=C sort | while read -r f; do cat \"\$f\"; done | sha256sum | awk '{print \$1}'"
}

# 2026-09-17 (independent review of TRA-271's own planning): the fingerprint used to be taken
# AFTER the snapshot rsync below, so a write landing on the server during that copy entered the
# reference fingerprint without ever reaching the copy -- and the post-stop recheck, comparing
# against that same tainted reference, would not catch it. Taking it first means any write from
# this point on (including mid-copy) changes the server's real state relative to the reference,
# and the post-stop recheck below refuses on the mismatch.
echo "==> Fingerprinting server cache (before the snapshot copy)"
SNAPSHOT_FINGERPRINT="$(remote_hash)"

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
set +e
ssh "$SERVER" "test -f '$SERVER_CRAWL_LOCK'"
LOCK_STATUS=$?
set -e
if [[ $LOCK_STATUS -eq 0 ]]; then
	echo "ERROR: crawl lock present ($SERVER_CRAWL_LOCK) -- a crawl is in progress, refusing." >&2
	exit 1
fi
# 2026-09-18 (review of TRA-67): `if ssh ...; then` read an SSH transport failure (exit 255) the
# same as "lock absent" -- a dropped connection silently continued as if it were safe (fail-open).
# The redirects-table check above already fails closed on any non-zero exit because it wants the
# same outcome either way; here the two failure modes want DIFFERENT outcomes ("no lock" must
# proceed, "couldn't even ask" must not), so they need to be told apart explicitly.
if [[ $LOCK_STATUS -eq 255 ]]; then
	echo "ERROR: could not check the crawl lock on $SERVER (ssh connection failed) -- refusing (fail-closed)." >&2
	exit 1
fi

echo "==> Archiving server cache before writing (mandatory)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_PATH="$SERVER_BACKUP_DIR/genre-cache-$TIMESTAMP.tar.gz"
ssh "$SERVER" "mkdir -p '$SERVER_BACKUP_DIR' && tar czf '$ARCHIVE_PATH' -C '$(dirname "$SERVER_CACHE_REMOTE")' '$(basename "$SERVER_CACHE_REMOTE")'"
echo "==> Verifying archive integrity"
ssh "$SERVER" "gzip -t '$ARCHIVE_PATH'"
echo "==> Rollback archive: $SERVER:$ARCHIVE_PATH"

echo "==> Pruning old backup archives (keeping the $BACKUP_RETENTION_COUNT most recent)"
ssh "$SERVER" "cd '$SERVER_BACKUP_DIR' && ls -1t genre-cache-*.tar.gz 2>/dev/null | tail -n +$((BACKUP_RETENTION_COUNT + 1)) | while read -r f; do rm -f -- \"\$f\"; done"

echo "==> Stopping odyssey-server.service (writer)"
STOPPED=1
WRITER_WAS_STOPPED=1
ssh "$SERVER" "systemctl stop odyssey-server.service"

set +e
ssh "$SERVER" "systemctl is-active --quiet odyssey-server.service"
ACTIVE_STATUS=$?
set -e
if [[ $ACTIVE_STATUS -eq 0 ]]; then
	echo "ERROR: odyssey-server.service is still active after stop -- refusing to write." >&2
	exit 1
fi
# Same fail-closed fix as the crawl-lock check above: an ssh transport failure must not be read as
# "confirmed stopped".
if [[ $ACTIVE_STATUS -eq 255 ]]; then
	echo "ERROR: could not confirm odyssey-server.service stopped on $SERVER (ssh connection failed) -- refusing (fail-closed)." >&2
	exit 1
fi

echo "==> Verifying the server cache has not changed since the snapshot"
CURRENT_FINGERPRINT="$(remote_hash)"
if [[ "$CURRENT_FINGERPRINT" != "$SNAPSHOT_FINGERPRINT" ]]; then
	echo "ERROR: server cache fingerprint changed since the snapshot ($SNAPSHOT_FINGERPRINT -> $CURRENT_FINGERPRINT) -- refusing to write." >&2
	exit 1
fi

echo "==> Transferring the validated union (never --delete; shared node files are overwritten)"
rsync -az "$UNION_DIR/nodes/" "$SERVER:$SERVER_CACHE_REMOTE/nodes/"

restart_writer
if [[ $STOPPED -eq 1 ]]; then
	# restart_writer already printed the specific ssh failure above.
	exit 1
fi

echo "==> Smoke test (tsx can take 5-10s to warm up after a restart; retrying)"
SMOKE_OK=0
SMOKE_OUTPUT=""
for i in $(seq 1 "$SMOKE_RETRY_COUNT"); do
	if SMOKE_OUTPUT="$(curl -fsS "$SERVER_HEALTH_URL" 2>&1)"; then
		SMOKE_OK=1
		break
	fi
	[[ "$i" -lt "$SMOKE_RETRY_COUNT" ]] && sleep "$SMOKE_RETRY_DELAY"
done
if [[ $SMOKE_OK -ne 1 ]]; then
	echo "ERROR: server did not respond on $SERVER_HEALTH_URL after $SMOKE_RETRY_COUNT attempts." >&2
	echo "$SMOKE_OUTPUT" >&2
	exit 1
fi
echo "$SMOKE_OUTPUT"
curl -fsS "$SERVER_VERSION_URL"
echo

echo "==> Sync complete. Rollback archive if needed: $SERVER:$ARCHIVE_PATH"
