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
# "Additive" here is file-additive: rsync never passes --delete, so a NORMAL node is never removed,
# but a node present on both sides is OVERWRITTEN in place -- a field or an edge only the server had
# is lost unless the union preserved it. The archive, not the transfer mode, makes that recoverable.
# The one deliberate exception is the small, explicit set of files the union's own merge migration
# declares gone (see DEPLOY GUARD below): those are removed with individual `rm -f --` calls by
# their own computed path, never with rsync --delete, which could also remove anything a concurrent
# write added to the server between the snapshot and the transfer.
#
# No personal SSH key: this relies on the caller's ssh-agent (same as deploy-server.sh / the
# `deploy` job on the self-hosted runner) and never writes to $HOME/.ssh or $HOME/.
#
# DEPLOY GUARD (2026-09-19, TRA-276/B6c-2): the union runs the merge migration with --apply-merge,
# which deletes the losing file of a duplicate-QID group from its artifact and writes a merged
# genre-redirects.json. This script now propagates both explicitly, after the additive node
# transfer succeeds and before the writer restarts (search "Shipping the union's redirects table"
# below) -- see manifest.migrationApply.removedByMigration / .deletedCount and the validation right
# after the union-problems check. The refusal that used to block EVERY merge unconditionally (see
# TRA-67 / TRA-269) is gone; what remains is a narrower guard that only refuses when the manifest
# disagrees with itself or a removed path would land outside nodes/.
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
# 2026-09-18 (independent review of this PR): unvalidated, a non-numeric value fed straight into
# the remote `tail -n +...` below would just fail there (a normal, non-fatal refusal) -- but this
# same value used to reach a local `$((BACKUP_RETENTION_COUNT + 1))` before the fix below existed,
# where bash arithmetic treats a bareword like "ten" as an unset nested variable under `set -u`,
# a fatal shell error class this PR's on_exit fix (see below) had to be hardened against on its
# own. And 0 made the prune re-list (and, without the belt-and-suspenders exclusion below) delete
# every archive, including the one this very run just made. Reject both eagerly, before anything
# destructive can happen -- clearer error, and one less path into the fatal-error class entirely.
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-10}"
if ! [[ "$BACKUP_RETENTION_COUNT" =~ ^[0-9]+$ ]] || [[ "$BACKUP_RETENTION_COUNT" -lt 1 ]]; then
	echo "ERROR: BACKUP_RETENTION_COUNT must be a positive integer (got '$BACKUP_RETENTION_COUNT')." >&2
	exit 1
fi
# tsx can take 5-10s to warm up after a restart (same constant as deploy/deploy-server.sh's own
# health-check retry loop); retry instead of a single shot.
SMOKE_RETRY_COUNT="${SMOKE_RETRY_COUNT:-10}"
SMOKE_RETRY_DELAY="${SMOKE_RETRY_DELAY:-3}"

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

# 2026-09-18 (TRA-271, deferred as a nit on TRA-67 to keep that diff under the CI gate): same
# branch/clean-tree discipline as deploy/deploy-server.sh:34-43, reused verbatim in spirit. Kept
# as env-var overrides (not flags) so the test harness can run the script from this repo's own
# worktree/branch without faking an entire git checkout for every scenario.
#
# 2026-09-18 (independent review of this PR): this guard used to run before argument parsing, so
# it applied even to the read-only --apply-less preview -- which the Usage comment above still
# documents as safe to run from a feature branch with a curated cache/. Gate it on --apply, the
# only path that can actually touch the server. And check `git status --short` (not `git diff` /
# `git diff --cached`, which both ignore untracked files) so an uncommitted
# cache/nodes/genre/foo.json -- which enters REPO_CACHE_DIR and the union regardless -- doesn't
# ship to prod while this guard still calls the tree clean.
if [[ $APPLY -eq 1 ]]; then
	BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
	if [[ "$BRANCH" != "main" && "${SYNC_ALLOW_NON_MAIN:-0}" != "1" ]]; then
		echo "ERROR: refusing to sync from branch '$BRANCH' (expected main) -- merge to main first, or set SYNC_ALLOW_NON_MAIN=1." >&2
		exit 1
	fi
	DIRTY_STATUS="$(git -C "$REPO_ROOT" status --short)"
	if [[ -n "$DIRTY_STATUS" && "${SYNC_ALLOW_DIRTY:-0}" != "1" ]]; then
		echo "ERROR: working tree is dirty (including untracked files) -- commit or stash first, or set SYNC_ALLOW_DIRTY=1." >&2
		echo "$DIRTY_STATUS" >&2
		exit 1
	fi
fi

WORKDIR="$(mktemp -d)"
SNAPSHOT_DIR="$WORKDIR/server-cache-snapshot"
SNAPSHOT_REDIRECTS="$WORKDIR/server-genre-redirects.json"
UNION_DIR=""
ARCHIVE_PATH=""
STOPPED=0
WRITER_WAS_STOPPED=0
SYNC_SUCCEEDED=0

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
	if [[ $SYNC_SUCCEEDED -eq 1 ]]; then
		exit 0
	fi
	# 2026-09-18 (second independent review): this used to be gated on `$code -ne 0`, the very value
	# the sentinel above exists because it cannot be trusted -- a fatal shell error AFTER the
	# transfer left the operator with no pointer to the archive, in the one state where they need
	# it. We are already past the success branch, so the writer having been stopped is the whole
	# condition: it means the transfer step was reached.
	if [[ $WRITER_WAS_STOPPED -eq 1 ]]; then
		echo "ERROR: sync failed -- the writer was restarted if it could be, but any node files already transferred were overwritten in place (rsync never deletes, it overwrites). Restore from the archive if the run got past the transfer step: $SERVER:$ARCHIVE_PATH" >&2
	fi
	# 2026-09-18 (independent review of this PR, reproduced on bash 3.2): on a fatal shell-level
	# error -- an unbound variable under `set -u`, a bad `$(( ))` -- bash resets $? to 0 before this
	# trap even runs, so `code` above can read 0 despite the script failing; re-exiting with that
	# value would report success. We only reach this branch when SYNC_SUCCEEDED was never set, so
	# always exit non-zero: use `code` when it IS non-zero (the reliable, common case -- an
	# explicit `exit N` from one of this script's own refusals, or an ordinary failing command
	# under `set -e`), otherwise fall back to a generic failure code instead of the misleading 0.
	if [[ $code -ne 0 ]]; then
		exit "$code"
	fi
	exit 1
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Test-only hook (independent review of this PR): deliberately triggers the exact fatal-shell-error
# class (an unbound variable read under `set -u`) that used to make on_exit's old `exit "$code"`
# report success -- see the trap's own comment above. Never set outside test/genre-cache-sync.test.ts.
if [[ "${TEST_FORCE_FATAL_ERROR:-0}" == "1" ]]; then
	echo "$__TEST_TRIGGER_UNBOUND_VARIABLE_FOR_FATAL_ERROR_TEST"
fi

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
	SYNC_SUCCEEDED=1
	exit 0
fi

# 2026-09-19 (TRA-276/B6c-2): manifest.migrationApply.{deletedCount,removedByMigration} are always
# present once --apply-merge ran (this script always passes it) -- only their CONTENT differs when
# there was nothing to merge (both empty/0). Trust neither blindly: the two must agree in count
# (deletedCount is the migration's own tally; removedByMigration is derived independently from live
# -slug membership -- a real disagreement means the manifest is internally inconsistent, and this
# script has no way to tell which side is right), and each removed slug's own computed path must
# land inside nodes/ -- isValidSlug/parseSlug (src/slug.ts) reject neither '/' nor '..' in a slug
# body, so this is real defense-in-depth, not paranoia. Refuse before any write on either failure.
MIGRATION_DELETED_COUNT="$(node -e 'const m=require(process.argv[1]);process.stdout.write(String(m.migrationApply?.deletedCount ?? 0))' "$UNION_DIR/manifest.json")"
REMOVED_SLUGS="$(node -e 'const m=require(process.argv[1]);const list=m.migrationApply?.removedByMigration ?? [];process.stdout.write(list.map((e) => e.slug).join("\n"))' "$UNION_DIR/manifest.json")"

# Test-only hooks (never set outside test/genre-cache-sync.test.ts): the real union script has no
# way to produce, on demand, a manifest where these two disagree or where a removed slug escapes
# nodes/ -- both only guard a future bug that corrupts the manifest, so the tests drive the guard
# below directly instead.
if [[ "${TEST_FORCE_REMOVED_COUNT_MISMATCH:-0}" == "1" ]]; then
	MIGRATION_DELETED_COUNT=$((MIGRATION_DELETED_COUNT + 1))
fi
if [[ -n "${TEST_OVERRIDE_REMOVED_SLUG:-}" && -n "$REMOVED_SLUGS" ]]; then
	REMOVED_SLUGS="$TEST_OVERRIDE_REMOVED_SLUG"
fi

REMOVED_COUNT=0
REMOVE_PATHS=()
if [[ -n "$REMOVED_SLUGS" ]]; then
	while IFS= read -r slug; do
		[[ -z "$slug" ]] && continue
		REMOVED_COUNT=$((REMOVED_COUNT + 1))
		node_type="${slug%%:*}"
		node_body="${slug#*:}"
		if [[ "$node_type" == "$slug" || -z "$node_body" ]]; then
			echo "ERROR: malformed removedByMigration slug '$slug' -- refusing before any write." >&2
			exit 1
		fi
		case "$node_type" in
			genre | label | artist | project | track) ;;
			*)
				echo "ERROR: removedByMigration slug '$slug' has an unexpected node type '$node_type' -- refusing before any write." >&2
				exit 1
				;;
		esac
		if [[ "$node_body" == *".."* || "$node_body" == */* ]]; then
			echo "ERROR: removedByMigration slug '$slug' resolves outside nodes/ -- refusing before any write." >&2
			exit 1
		fi
		REMOVE_PATHS+=("nodes/$node_type/$node_body.json")
	done <<<"$REMOVED_SLUGS"
fi

if [[ "$MIGRATION_DELETED_COUNT" != "$REMOVED_COUNT" ]]; then
	echo "ERROR: the union's manifest disagrees with itself about what was merged away (migrationApply.deletedCount=$MIGRATION_DELETED_COUNT vs removedByMigration entries=$REMOVED_COUNT) -- refusing before any write." >&2
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
# Belt-and-suspenders (independent review of this PR): BACKUP_RETENTION_COUNT is validated >= 1
# above, so the archive just made -- always the newest by mtime -- already survives the `tail`
# offset below on its own. Excluding it from the candidate list by name too means a future change
# to the retention arithmetic can't ever delete the one archive this very run depends on for
# rollback, the same discipline as the redirectsConflicts double-check earlier in this script.
ssh "$SERVER" "cd '$SERVER_BACKUP_DIR' && ls -1t genre-cache-*.tar.gz 2>/dev/null | grep -v -F -x '$(basename "$ARCHIVE_PATH")' | tail -n +$BACKUP_RETENTION_COUNT | while read -r f; do rm -f -- \"\$f\"; done"

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

# 2026-09-19 (TRA-276/B6c-2): propagate what the additive transfer above cannot -- the union's own
# redirects table (always written, whether or not anything was merged: identical content when
# nothing changed) and the individually-validated set of node files the merge migration deleted
# from its own artifact. Explicit `rm -f --` per file, never rsync --delete, which could also remove
# anything a concurrent write added to the server. A failure here (ssh/rsync) is just another
# post-transfer failure under `set -e`: on_exit still restarts the writer and points at the archive.
echo "==> Shipping the union's redirects table to the server"
rsync -az "$UNION_DIR/genre-redirects.json" "$SERVER:$SERVER_REDIRECTS_REMOTE"

if [[ ${#REMOVE_PATHS[@]} -gt 0 ]]; then
	echo "==> Removing ${#REMOVE_PATHS[@]} node file(s) merged away by the union (explicit paths, never --delete)"
	for rel in "${REMOVE_PATHS[@]}"; do
		ssh "$SERVER" "rm -f -- '$SERVER_CACHE_REMOTE/$rel'"
	done
fi

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

# Same test-only hook as above, fired here instead so a test can reach the failure path with the
# transfer already done -- the state where the archive pointer matters.
if [[ "${TEST_FORCE_FATAL_ERROR:-0}" == "after-transfer" ]]; then
	echo "$__TEST_TRIGGER_UNBOUND_VARIABLE_FOR_FATAL_ERROR_TEST"
fi

SYNC_SUCCEEDED=1
echo "==> Sync complete. Rollback archive if needed: $SERVER:$ARCHIVE_PATH"
