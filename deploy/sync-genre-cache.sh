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
# disagrees with itself or a removed path would land outside nodes/. A second guard (search
# "not yet committed") refuses --apply outright when the union's redirects table has entries the
# repo's own data/genre-redirects.json doesn't -- the repo, not the server, is what deploy-server.sh
# re-syncs data/ from on every app deploy, so an uncommitted redirect would be lost right after a
# node this script already permanently deleted.
#
# MIGRATION CHANNEL (2026-10-15, TRA-464): also the ONLY path by which a repo migration
# (scripts/migrations/<name>.ts) reaches the prod cache, never a direct rsync. `--migration <name>`
# (repeatable) runs each one with --apply on the UNION (temp copy of repo + server snapshot), which
# writes a manifest (`--manifest <path>`):
#   { "migration": "<name>", "generated_at": "...", "renamed": { "<old slug>": "<new slug>" },
#     "removed": ["nodes/track/x.json"], "redirects": { "<old slug>": "<new slug>" }, "written": 123 }
# `removed` and the old side of `renamed` are the only server-side deletions (same explicit
# `rm -f --` as merge losers), and every `redirects` AND `renamed` pair must already be committed in
# data/genre-redirects.json or data/slug-redirects.json (the "not yet committed" guard below).
# A migration also gets `--data-dir <dir>`: a SCRATCH copy of those two tables, the only place it
# may read/write redirect tables. It must never write the repo's data/ (a redirect written there
# would be read back as "committed" and shipped): the script refuses if the repo changed. The tables
# shipped and checked are the copies taken before the run. Its tables are discarded.
#
# 2026-10-15 (TRA-499): what the migration channel ships, and where each file comes from:
#   - nodes/                  the union after the migrations (validated: validate-migrated-union.ts);
#   - pending-reverses.json   the repo's and the server's files UNIONED before the first migration
#                             (prepare-genre-cache-union.ts --merge-pending-reverses; it sits at the
#                             union root because that is where every migration reads and rewrites
#                             it), then rewritten by the migrations and re-validated: shipping the
#                             pre-run file would leave prod's keys on slugs the migration renamed.
#                             The server's pre-write copy is in the rollback archive: it lives in the
#                             cache tree that archive tars whole;
#   - genre-redirects.json    the COMMITTED copy taken before the run (like slug-redirects.json), not
#                             the union's: it is what deploy-server.sh re-ships on every app deploy.
# Everything else at the union root is a copy taken before the run, and the script REFUSES (before
# the archive and the stop) if anything there other than nodes/ and pending-reverses.json changed
# while the migrations ran. A plain genre sync (no --migration) is unchanged: it neither unions nor
# ships pending-reverses.json and ships the union's genre-redirects.json as before.
#
# Usage:
#   bash deploy/sync-genre-cache.sh            # preview only: builds + prints the union manifest
#   bash deploy/sync-genre-cache.sh --apply    # also syncs the server cache (see above)
#   bash deploy/sync-genre-cache.sh --migration 2026-10-15-unescape-newlines [--apply]
#
# Real workflow_dispatch wiring (when this runs, and from what trigger) is out of scope here --
# that's B6c, a separate ticket.

SERVER="${SERVER:-root@46.101.167.241}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_CACHE_DIR="${REPO_CACHE_DIR:-$REPO_ROOT/cache}"
# 2026-09-19 (TRA-276/B6c-2, CI review): the repo's own committed table -- what a plain
# `data/genre-redirects.json` read gets you, same default deploy-server.sh's own rsync of data/
# (see the guard below) ships to prod. Overridable so the test harness can point it at a fixture
# without faking the real committed file.
REPO_REDIRECTS_PATH="${REPO_REDIRECTS_PATH:-$REPO_ROOT/data/genre-redirects.json}"
# 2026-10-15 (TRA-464): the migration channel's inputs. Overridable for the same reason as
# REPO_REDIRECTS_PATH (test fixtures); the workflow sets none of them.
REPO_SLUG_REDIRECTS_PATH="${REPO_SLUG_REDIRECTS_PATH:-$REPO_ROOT/data/slug-redirects.json}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$REPO_ROOT/scripts/migrations}"
SERVER_CACHE_REMOTE="${SERVER_CACHE_REMOTE:-/opt/odyssey-music/cache}"
SERVER_REDIRECTS_REMOTE="${SERVER_REDIRECTS_REMOTE:-/opt/odyssey-music/data/genre-redirects.json}"
SERVER_SLUG_REDIRECTS_REMOTE="${SERVER_SLUG_REDIRECTS_REMOTE:-/opt/odyssey-music/data/slug-redirects.json}"
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
MIGRATIONS=()
MIGRATION_NAME_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
while [[ $# -gt 0 ]]; do
	case "$1" in
		--apply) APPLY=1 ;;
		--migration)
			if [[ $# -lt 2 ]]; then
				echo "ERROR: --migration needs a migration name." >&2
				exit 1
			fi
			shift
			# The name becomes a file path and is typed by a workflow dispatcher: whitelist it
			# (dated, lowercase, dashes -- the scripts/migrations/ naming) so it can never carry a
			# path separator, `..`, or a shell metacharacter.
			if ! [[ "$1" =~ $MIGRATION_NAME_PATTERN ]]; then
				echo "ERROR: invalid migration name '$1' (expected YYYY-MM-DD-some-name)." >&2
				exit 1
			fi
			if [[ ${#MIGRATIONS[@]} -gt 0 ]]; then
				for existing in "${MIGRATIONS[@]}"; do
					if [[ "$existing" == "$1" ]]; then
						echo "ERROR: migration '$1' given twice." >&2
						exit 1
					fi
				done
			fi
			MIGRATIONS+=("$1")
			;;
		*)
			echo "ERROR: unknown argument '$1'." >&2
			exit 1
			;;
	esac
	shift
done
ROLLBACK_NOTE=""
if [[ ${#MIGRATIONS[@]} -gt 0 ]]; then
	# N4: rsync ADDS files a migration created, and the archive cannot contain what did not exist yet.
	ROLLBACK_NOTE=" -- this was a migration run: the archive does not cover the files it CREATED, so a rollback must first remove the server's whole cache/ tree, then extract the archive (tar xzf <archive> -C $(dirname "$SERVER_CACHE_REMOTE")), instead of extracting over it"
	for name in "${MIGRATIONS[@]}"; do
		if [[ ! -f "$MIGRATIONS_DIR/$name.ts" ]]; then
			echo "ERROR: migration script not found: $MIGRATIONS_DIR/$name.ts" >&2
			exit 1
		fi
	done
	# Shipped next to genre-redirects.json after the transfer: a missing file must refuse now, not
	# after the writer is stopped.
	if [[ ! -f "$REPO_SLUG_REDIRECTS_PATH" ]]; then
		echo "ERROR: $REPO_SLUG_REDIRECTS_PATH is missing -- a migration run ships it to the server." >&2
		exit 1
	fi
fi

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
		echo "ERROR: sync failed -- the writer was restarted if it could be, but any node files already transferred were overwritten in place (rsync never deletes, it overwrites). Restore from the archive if the run got past the transfer step: $SERVER:$ARCHIVE_PATH$ROLLBACK_NOTE" >&2
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
# TRA-499: only a migration run unions pending-reverses.json; a plain genre sync does not read it.
MERGE_PENDING_FLAG=""
if [[ ${#MIGRATIONS[@]} -gt 0 ]]; then
	MERGE_PENDING_FLAG="--merge-pending-reverses"
fi
set +e
UNION_OUTPUT="$(cd "$REPO_ROOT" && npx tsx scripts/prepare-genre-cache-union.ts \
	"$REPO_CACHE_DIR" "$SNAPSHOT_DIR" --apply-merge ${MERGE_PENDING_FLAG:+"$MERGE_PENDING_FLAG"} \
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

# 2026-09-19 (TRA-276/B6c-2, CI review): the union's genre-redirects.json (shipped to
# SERVER_REDIRECTS_REMOTE below) is not this script's only writer of that path -- deploy-server.sh
# rsyncs the repo's own data/ onto the server on EVERY app deploy (deploy/deploy-server.sh:70-76
# excludes cache/ but not data/), overwriting it from whatever is committed. A redirect the merge
# migration just created (e.g. dance-hall -> dancehall) that isn't in the repo's OWN committed
# table would survive only until the next app deploy, which erases it -- while the node it used to
# point at is already permanently gone from the server (rm -f --, not a reversible overwrite).
# Before this script existed, that state was unreachable (--apply refused every merge outright);
# shipping the union's table without also requiring it to already be committed would silently
# reintroduce the exact dead-link/duplicate-rematerialization regression TRA-67's original refusal
# was protecting against, on half the ticket (the redirects table, not the deletion). Compare KEYS
# only, not values: any entry the union's table has can differ in target across a rename without
# being "new" here, but a key entirely absent from the repo's table is a redirect the repo has
# never seen. Preview mode only warns (nothing is written either way); --apply refuses outright,
# before any server write, and prints the missing pairs plus the fix (a repo-side migration PR).
NEW_REDIRECT_PAIRS="$(node -e '
const fs = require("fs");
const unionRedirects = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).redirects ?? {};
const repoRedirects = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).redirects ?? {};
const missing = Object.entries(unionRedirects).filter(([from]) => !(from in repoRedirects));
process.stdout.write(missing.map(([from, to]) => from + " -> " + to).join("\n"));
' "$UNION_DIR/genre-redirects.json" "$REPO_REDIRECTS_PATH")"
if [[ -n "$NEW_REDIRECT_PAIRS" ]]; then
	echo "WARNING: this union created redirect(s) not yet committed in $REPO_REDIRECTS_PATH:" >&2
	echo "$NEW_REDIRECT_PAIRS" >&2
	echo "deploy-server.sh rsyncs the repo's data/ onto the server on every app deploy (it excludes cache/ but not data/), so the next app deploy would erase these entries while the merged-away node stays permanently deleted. Add them to data/genre-redirects.json (a repo-side merge migration), deploy, then re-run this sync." >&2
	if [[ $APPLY -eq 1 ]]; then
		echo "ERROR: refusing --apply until data/genre-redirects.json is updated (see the pairs above) -- otherwise the next app deploy would erase the redirect while the node stays deleted." >&2
		exit 1
	fi
fi

# 2026-10-15 (TRA-464): the migration channel. The union's own validation ran BEFORE this, so a
# migration's output is checked by what it declares: the manifest (shape, paths confined to
# nodes/, redirects already committed) and that no declared deletion is still in the union (rsync
# would ship the file, then `rm -f --` would delete it -- a node lost for good).
#
# 2026-10-15 (TRA-464, deep review B1): a migration runs with cwd=$REPO_ROOT, and the existing
# models write their redirects table to the repo's own data/. Read back afterwards as "committed",
# that table would defeat the guard below and ship an uncommitted redirect (the next app deploy then
# erases it while the old node stays deleted). So: (1) the committed tables are copied BEFORE any
# migration runs and only those copies are checked and shipped; (2) the migration is handed a
# scratch --data-dir instead; (3) afterwards the repo's cache/ and data/ and the live tables must be
# unchanged, or the run is refused (in preview too).
repo_state() {
	git -C "$REPO_ROOT" status --porcelain -- cache data 2>/dev/null || true
	{ git -C "$REPO_ROOT" diff HEAD -- cache data 2>/dev/null || true; } | cksum
}
# 2026-10-15 (TRA-499, deep review of #413 scenario F): every entry of the union's root except the
# two outputs a migration is allowed (nodes/, pending-reverses.json -- the latter re-validated by
# validate-migrated-union.ts): names, then content checksums. The root holds manifest.json,
# genre-redirects.json and archive/, none of which a migration may touch -- genre-redirects.json used
# to be shipped from here AFTER the loop, so one written by a migration reached prod unchecked.
union_root_state() {
	(
		cd "$UNION_DIR"
		find . -mindepth 1 \( -path ./nodes -o -path ./pending-reverses.json \) -prune -o -print | LC_ALL=C sort
		find . -mindepth 1 \( -path ./nodes -o -path ./pending-reverses.json \) -prune -o -type f -exec cksum {} + | LC_ALL=C sort
	)
}
# 2026-10-15 (TRA-499 deep review, P5): "<keys> <entries>" of the union's pending-reverses.json, so
# a migration that shrinks it (down to `{}`) shows in the preview, not only after the shipment.
pending_counts() {
	node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const keys = Object.keys(m);
process.stdout.write(keys.length + " " + keys.reduce((n, k) => n + m[k].length, 0));
' "$UNION_DIR/pending-reverses.json"
}
MIGRATION_REMOVE_PATHS=()
MIGRATION_MISSING_REDIRECTS=""
COMMITTED_DIR="$WORKDIR/committed-tables"
MIGRATION_DATA_DIR="$WORKDIR/migration-data"
COMMITTED_GENRE_TABLE="$COMMITTED_DIR/genre-redirects.json"
COMMITTED_SLUG_TABLE="$COMMITTED_DIR/slug-redirects.json"
MIGRATION_TARGETS="$WORKDIR/migration-targets.txt"
if [[ ${#MIGRATIONS[@]} -gt 0 ]]; then
	mkdir -p "$COMMITTED_DIR" "$MIGRATION_DATA_DIR"
	cp "$REPO_REDIRECTS_PATH" "$COMMITTED_GENRE_TABLE"
	cp "$REPO_SLUG_REDIRECTS_PATH" "$COMMITTED_SLUG_TABLE"
	cp "$REPO_REDIRECTS_PATH" "$MIGRATION_DATA_DIR/genre-redirects.json"
	cp "$REPO_SLUG_REDIRECTS_PATH" "$MIGRATION_DATA_DIR/slug-redirects.json"
	: >"$MIGRATION_TARGETS"
	REPO_STATE_BEFORE="$(repo_state)"
	UNION_ROOT_BEFORE="$(union_root_state)"
	PENDING_COUNTS_BEFORE="$(pending_counts)"
	(cd "$REPO_ROOT" && npx tsx scripts/validate-migrated-union.ts snapshot "$UNION_DIR" "$WORKDIR/union-before.json")
	for name in "${MIGRATIONS[@]}"; do
		MIGRATION_MANIFEST="$WORKDIR/$name.manifest.json"
		echo "==> Running migration $name on the union (never on the repo or the server)"
		set +e
		(cd "$REPO_ROOT" && npx tsx "$MIGRATIONS_DIR/$name.ts" "$UNION_DIR" --apply --manifest "$MIGRATION_MANIFEST" --data-dir "$MIGRATION_DATA_DIR")
		MIGRATION_EXIT=$?
		set -e
		if [[ $MIGRATION_EXIT -ne 0 ]]; then
			echo "ERROR: migration $name failed (exit $MIGRATION_EXIT) -- refusing." >&2
			exit 1
		fi
		if [[ ! -f "$MIGRATION_MANIFEST" ]]; then
			echo "ERROR: migration $name wrote no manifest at $MIGRATION_MANIFEST (--manifest is part of the contract) -- refusing." >&2
			exit 1
		fi
		echo "==> Migration manifest: $name"
		cat "$MIGRATION_MANIFEST"
		echo
		# Output: one "RM<TAB>nodes/<type>/<slug>.json" line per deletion, one "MISSING<TAB>from -> to"
		# line per redirect not already committed with the same target. Any malformed manifest exits 1.
		if ! MANIFEST_RESULT="$(node -e '
const fs = require("fs");
const [manifestPath, name, genrePath, slugPath] = process.argv.slice(1);
const fail = (msg) => { process.stdout.write(msg); process.exit(1); };
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const esc = (s) => JSON.stringify(String(s)).slice(1, -1);
const readTable = (p, optional) => {
	let raw;
	try { raw = fs.readFileSync(p, "utf8"); } catch (e) { if (optional && e.code === "ENOENT") return {}; throw e; }
	const parsed = JSON.parse(raw);
	return isRecord(parsed) && isRecord(parsed.redirects) ? parsed.redirects : {};
};
let m;
try { m = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (e) { fail("manifest is not readable JSON: " + e.message); }
if (!isRecord(m)) fail("manifest is not a JSON object");
if (m.migration !== name) fail("manifest.migration is " + JSON.stringify(m.migration) + ", expected " + JSON.stringify(name));
if (!Array.isArray(m.removed) || !isRecord(m.renamed) || !isRecord(m.redirects)) fail("manifest needs removed[], renamed{} and redirects{}");
const TYPES = ["genre", "label", "artist", "project", "track"];
// Same charset normalizeSlugBody produces (src/slug.ts), as for removedByMigration above.
const BODY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const parseSlug = (s) => {
	const i = typeof s === "string" ? s.indexOf(":") : -1;
	if (i < 0) return null;
	const type = s.slice(0, i), body = s.slice(i + 1);
	return TYPES.includes(type) && BODY.test(body) ? { type, body } : null;
};
const paths = new Set();
const pairs = [];
const targets = new Set();
for (const rel of m.removed) {
	const mt = typeof rel === "string" ? /^nodes\/([a-z]+)\/(.+)\.json$/.exec(rel) : null;
	if (!mt || !TYPES.includes(mt[1]) || !BODY.test(mt[2])) fail("removed path is not nodes/<type>/<slug>.json: " + esc(rel));
	paths.add(rel);
}
for (const [oldSlug, newSlug] of Object.entries(m.renamed)) {
	const o = parseSlug(oldSlug), n = parseSlug(newSlug);
	if (!o || !n || oldSlug === newSlug) fail("renamed entry is not a pair of distinct valid slugs: " + esc(oldSlug) + " -> " + esc(newSlug));
	paths.add("nodes/" + o.type + "/" + o.body + ".json");
	// A rename deletes the old node for good: it needs its committed redirect like any other pair.
	pairs.push([oldSlug, newSlug]);
	targets.add(newSlug);
}
for (const [from, to] of Object.entries(m.redirects)) {
	if (!parseSlug(to)) fail("redirect target is not a valid slug: " + esc(from) + " -> " + esc(to));
	pairs.push([from, to]);
	targets.add(to);
}
const genre = readTable(genrePath, false);
const slug = readTable(slugPath, true);
const lines = [...paths].map((p) => "RM\t" + p);
for (const t of targets) lines.push("TARGET\t" + t);
const seen = new Set();
for (const [from, to] of pairs) {
	const key = from + "\n" + to;
	if (seen.has(key)) continue;
	seen.add(key);
	if ((!has(genre, from) || genre[from] !== to) && (!has(slug, from) || slug[from] !== to)) lines.push("MISSING\t" + esc(from) + " -> " + esc(to));
}
process.stdout.write(lines.join("\n"));
' "$MIGRATION_MANIFEST" "$name" "$COMMITTED_GENRE_TABLE" "$COMMITTED_SLUG_TABLE" 2>&1)"; then
			echo "ERROR: migration $name produced an invalid manifest: $MANIFEST_RESULT -- refusing before any write." >&2
			exit 1
		fi
		while IFS=$'\t' read -r kind value; do
			case "$kind" in
				RM) MIGRATION_REMOVE_PATHS+=("$value") ;;
				TARGET) printf '%s\n' "$value" >>"$MIGRATION_TARGETS" ;;
				MISSING) MIGRATION_MISSING_REDIRECTS="$MIGRATION_MISSING_REDIRECTS$value ($name)"$'\n' ;;
			esac
		done <<<"$MANIFEST_RESULT"
	done

	# B1: nothing a migration did may have reached the repo or the committed tables.
	if [[ "$(repo_state)" != "$REPO_STATE_BEFORE" ]]; then
		echo "ERROR: a migration changed the repo's cache/ or data/ (git status/diff differ from before the run) -- migrations must write only to the union and --data-dir. Refusing before any write." >&2
		git -C "$REPO_ROOT" status --porcelain -- cache data >&2 || true
		exit 1
	fi
	if ! cmp -s "$REPO_REDIRECTS_PATH" "$COMMITTED_GENRE_TABLE" || ! cmp -s "$REPO_SLUG_REDIRECTS_PATH" "$COMMITTED_SLUG_TABLE"; then
		echo "ERROR: a migration modified the repo's committed redirects table(s) -- it must write to --data-dir only. Refusing before any write." >&2
		exit 1
	fi
	# TRA-499: the union's root (outside nodes/ and pending-reverses.json) is as it was before the loop.
	if [[ "$(union_root_state)" != "$UNION_ROOT_BEFORE" ]]; then
		echo "ERROR: a migration changed the union's root (genre-redirects.json, manifest.json, archive/ or any other entry besides nodes/ and pending-reverses.json) -- migrations write only nodes/, pending-reverses.json and --data-dir. Refusing before any write." >&2
		exit 1
	fi
	# N2: the FINAL union. Per-migration checks above cannot see a later migration undoing an earlier
	# one, nor a node a migration wrote itself (the union's validation ran before any migration). It
	# also re-validates the pending-reverses.json that is about to be shipped (TRA-499).
	if ! UNION_CHECK="$(cd "$REPO_ROOT" && npx tsx scripts/validate-migrated-union.ts check "$UNION_DIR" "$WORKDIR/union-before.json" "$MIGRATION_TARGETS" 2>&1)"; then
		echo "ERROR: the migrated union is invalid -- refusing before any write:" >&2
		echo "$UNION_CHECK" >&2
		exit 1
	fi
	# TRA-499 (P5): keys and entries of pending-reverses.json before and after the migrations, printed
	# in preview and apply alike and recorded in the union manifest. A drop is a warning, not a
	# refusal: a rename legitimately merges keys. Safe to rewrite manifest.json here: the root guard
	# above has already compared it.
	PENDING_COUNTS_AFTER="$(pending_counts)"
	read -r PENDING_KEYS_BEFORE PENDING_ENTRIES_BEFORE <<<"$PENDING_COUNTS_BEFORE"
	read -r PENDING_KEYS_AFTER PENDING_ENTRIES_AFTER <<<"$PENDING_COUNTS_AFTER"
	echo "==> pending-reverses.json before the migrations: $PENDING_KEYS_BEFORE key(s), $PENDING_ENTRIES_BEFORE entries"
	echo "==> pending-reverses.json after the migrations: $PENDING_KEYS_AFTER key(s), $PENDING_ENTRIES_AFTER entries"
	if [[ $PENDING_KEYS_AFTER -lt $PENDING_KEYS_BEFORE || $PENDING_ENTRIES_AFTER -lt $PENDING_ENTRIES_BEFORE ]]; then
		echo "WARNING: the migrations shrank pending-reverses.json ($PENDING_KEYS_BEFORE -> $PENDING_KEYS_AFTER keys, $PENDING_ENTRIES_BEFORE -> $PENDING_ENTRIES_AFTER entries): check this is intended (a rename merging keys, entries applied) before --apply." >&2
	fi
	node -e '
const fs = require("fs");
const [path, kb, eb, ka, ea] = process.argv.slice(1);
const m = JSON.parse(fs.readFileSync(path, "utf8"));
m.pendingReverses = { ...(m.pendingReverses ?? {}), beforeMigrations: { keys: Number(kb), entries: Number(eb) }, afterMigrations: { keys: Number(ka), entries: Number(ea) } };
fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
process.stdout.write("==> Union manifest pendingReverses: " + JSON.stringify(m.pendingReverses) + "\n");
' "$UNION_DIR/manifest.json" "$PENDING_KEYS_BEFORE" "$PENDING_ENTRIES_BEFORE" "$PENDING_KEYS_AFTER" "$PENDING_ENTRIES_AFTER"
	if [[ ${#MIGRATION_REMOVE_PATHS[@]} -gt 0 ]]; then
		for rel in "${MIGRATION_REMOVE_PATHS[@]}"; do
			if [[ -e "$UNION_DIR/$rel" ]]; then
				echo "ERROR: a migration declares $rel removed, but it is in the final union -- shipping it and then deleting it would lose the node. Refusing before any write." >&2
				exit 1
			fi
		done
	fi
	if [[ -n "$MIGRATION_MISSING_REDIRECTS" ]]; then
		echo "WARNING: the migration(s) produced redirect(s) not yet committed in data/genre-redirects.json or data/slug-redirects.json:" >&2
		printf '%s' "$MIGRATION_MISSING_REDIRECTS" >&2
		echo "deploy-server.sh rsyncs the repo's data/ onto the server on every app deploy, so the next app deploy would erase these entries while the migrated-away nodes stay deleted. Commit them first (the migration's repo-side PR), deploy, then re-run this sync." >&2
		if [[ $APPLY -eq 1 ]]; then
			echo "ERROR: refusing --apply until the redirects above are committed -- before any server write." >&2
			exit 1
		fi
	fi
fi

if [[ $APPLY -eq 0 ]]; then
	echo "==> Preview only (pass --apply to sync the server). No server write performed."
	SYNC_SUCCEEDED=1
	exit 0
fi

# 2026-09-19 (TRA-276/B6c-2 review): migrationApply is only ever absent when this script's own
# invocation contract changes (it always runs the union with --apply-merge) -- a real contract
# violation, not "nothing to merge" (that's deletedCount:0, removedByMigration:[], both still
# present). Refuse hard instead of letting the `?? 0` / `?? []` below silently read it that way.
HAS_MIGRATION_APPLY="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.migrationApply == null ? "0" : "1")' "$UNION_DIR/manifest.json")"
# Test-only hook (never set outside test/genre-cache-sync.test.ts): the real union script can never
# omit migrationApply when --apply-merge is passed (which this script always does), so the test
# drives this refusal directly.
if [[ "${TEST_FORCE_MISSING_MIGRATION_APPLY:-0}" == "1" ]]; then
	HAS_MIGRATION_APPLY=0
fi
if [[ "$HAS_MIGRATION_APPLY" != "1" ]]; then
	echo "ERROR: the union's manifest has no migrationApply section -- this script always runs the union with --apply-merge, so its absence means the manifest isn't what this script expects. Refusing before any write." >&2
	exit 1
fi

# manifest.migrationApply.{deletedCount,removedByMigration} are always present once --apply-merge
# ran (just confirmed above) -- only their CONTENT differs when there was nothing to merge (both
# empty/0). Trust neither blindly: the two must agree in count (deletedCount is the migration's own
# tally; removedByMigration is derived independently from live-slug membership). This is a
# tripwire, not a proven identity -- nothing in prepare-genre-cache-union.ts guarantees the two
# counts describe the same population beyond "both came out of one successful migration run"; if
# that assumption ever breaks, refuse rather than guess which side is right. Each removed slug's
# own computed path must also land inside nodes/, using the SAME charset normalizeSlugBody actually
# produces ([a-z0-9-], no leading/trailing dash) rather than merely excluding '/' and '..' --
# isValidSlug/parseSlug (src/slug.ts) enforce neither, so a slug body could otherwise carry a shell
# metacharacter (an unescaped quote, `$(...)`) straight into the single-quoted remote `ssh` command
# below (independent review of this PR: `genre:a'; reboot; echo '` passed the old '..'/'/' check and
# broke out of the quoting). Real defense-in-depth, not paranoia: refuse before any write on any of
# these failures.
MIGRATION_DELETED_COUNT="$(node -e 'const m=require(process.argv[1]);process.stdout.write(String(m.migrationApply?.deletedCount ?? 0))' "$UNION_DIR/manifest.json")"
REMOVED_SLUGS="$(node -e 'const m=require(process.argv[1]);const list=m.migrationApply?.removedByMigration ?? [];process.stdout.write(list.map((e) => e.slug).join("\n"))' "$UNION_DIR/manifest.json")"

# Test-only hooks (never set outside test/genre-cache-sync.test.ts): the real union script has no
# way to produce, on demand, a manifest where these two disagree or where a removed slug escapes the
# normalized charset -- both only guard a future bug that corrupts the manifest, so the tests drive
# the guard below directly instead.
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
		# Whitelist, not a blacklist: matches exactly what normalizeSlugBody (src/slug.ts) ever
		# produces. A blacklist of '..'/'/' alone still let a quote or a shell substitution through
		# undetected (independent review of this PR) -- this body is interpolated between single
		# quotes in a remote `ssh` command below.
		if ! [[ "$node_body" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
			echo "ERROR: removedByMigration slug '$slug' has a body outside the normalized slug charset -- refusing before any write." >&2
			exit 1
		fi
		REMOVE_PATHS+=("nodes/$node_type/$node_body.json")
	done <<<"$REMOVED_SLUGS"
fi

if [[ "$MIGRATION_DELETED_COUNT" != "$REMOVED_COUNT" ]]; then
	echo "ERROR: the union's manifest disagrees with itself about what was merged away (migrationApply.deletedCount=$MIGRATION_DELETED_COUNT vs removedByMigration entries=$REMOVED_COUNT) -- refusing before any write." >&2
	exit 1
fi
# The migrations' paths were validated when their manifests were read (before the preview exit above),
# and are deliberately outside the count check: that tripwire only describes the genre merge.
if [[ ${#MIGRATION_REMOVE_PATHS[@]} -gt 0 ]]; then
	for rel in "${MIGRATION_REMOVE_PATHS[@]}"; do
		REMOVE_PATHS+=("$rel")
	done
fi
# Every deletion (merge losers and migrations alike) must be absent from the union about to be
# shipped: a file rsync ships and `rm -f --` then deletes is a node lost for good (a later migration
# recreating an earlier one's removal, or a loser recreated by a migration).
if [[ ${#REMOVE_PATHS[@]} -gt 0 ]]; then
	for rel in "${REMOVE_PATHS[@]}"; do
		if [[ -e "$UNION_DIR/$rel" ]]; then
			echo "ERROR: $rel is slated for deletion on the server but is present in the final union -- refusing before any write." >&2
			exit 1
		fi
	done
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
# 2026-09-19 (TRA-276/B6c-2 review): "Rollback = the printed archive" (see file header) must be
# literally true -- this script now writes SERVER_REDIRECTS_REMOTE too (see "Shipping the union's
# redirects table" below), so its PRE-write content belongs in the same archive as the cache tree,
# not just cache/ alone, or cleanup() removing the union's own temp copy would leave no way back to
# it. gzip can't append to an already-compressed archive, hence the intermediate .tar built in two
# steps (cache/, then the redirects file) and compressed last -- `gzip -f` on that .tar produces
# exactly $ARCHIVE_PATH (…tar -> …tar.gz), so no rename is needed afterwards.
ARCHIVE_TAR="$SERVER_BACKUP_DIR/genre-cache-$TIMESTAMP.tar"
# Second review round: the table is appended under its parent directory name (data/…), not flat at
# the archive root, so both entries share the same root as cache/ and one `tar xzf … -C` of that
# root restores the whole thing; a flat entry would land next to data/ and leave the union's table
# in place. And a failed append removes the intermediate .tar: gzip never runs on it, so it would
# escape the retention glob (*.tar.gz) below and pile up in the backup dir for good.
REDIRECTS_PARENT="$(dirname "$SERVER_REDIRECTS_REMOTE")"
# 2026-10-15 (TRA-464): a migration run also overwrites the server's data/slug-redirects.json, so its
# pre-write content joins the archive when it exists (a server that never had one is not an error).
SLUG_ARCHIVE_APPEND=""
if [[ ${#MIGRATIONS[@]} -gt 0 ]]; then
	SLUG_PARENT="$(dirname "$SERVER_SLUG_REDIRECTS_REMOTE")"
	SLUG_ARCHIVE_APPEND=" && { test ! -f '$SERVER_SLUG_REDIRECTS_REMOTE' || tar --append --file='$ARCHIVE_TAR' -C '$(dirname "$SLUG_PARENT")' '$(basename "$SLUG_PARENT")/$(basename "$SERVER_SLUG_REDIRECTS_REMOTE")' || { rm -f -- '$ARCHIVE_TAR'; exit 1; }; }"
fi
ssh "$SERVER" "mkdir -p '$SERVER_BACKUP_DIR' && tar cf '$ARCHIVE_TAR' -C '$(dirname "$SERVER_CACHE_REMOTE")' '$(basename "$SERVER_CACHE_REMOTE")' && { tar --append --file='$ARCHIVE_TAR' -C '$(dirname "$REDIRECTS_PARENT")' '$(basename "$REDIRECTS_PARENT")/$(basename "$SERVER_REDIRECTS_REMOTE")' || { rm -f -- '$ARCHIVE_TAR'; exit 1; }; }$SLUG_ARCHIVE_APPEND && gzip -f '$ARCHIVE_TAR'"
echo "==> Verifying archive integrity"
ssh "$SERVER" "gzip -t '$ARCHIVE_PATH'"
echo "==> Rollback archive: $SERVER:$ARCHIVE_PATH$ROLLBACK_NOTE"

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
if [[ ${#MIGRATIONS[@]} -gt 0 ]]; then
	# 2026-10-15 (TRA-499): a migration run ships the COMMITTED table copied before the loop, never the
	# union root's file (a migration could have written it; union_root_state refuses that, and this
	# makes the source of the shipped bytes unambiguous). It is what the next app deploy ships anyway.
	echo "==> Shipping the committed data/genre-redirects.json to the server"
	rsync -az "$COMMITTED_GENRE_TABLE" "$SERVER:$SERVER_REDIRECTS_REMOTE"
else
	echo "==> Shipping the union's redirects table to the server"
	rsync -az "$UNION_DIR/genre-redirects.json" "$SERVER:$SERVER_REDIRECTS_REMOTE"
fi
# 2026-10-15 (TRA-464): the committed slug table travels with every migration run (the guard above
# guarantees it already holds every redirect the migrations produced). Not on a plain genre sync:
# that run is unchanged, and deploy-server.sh already ships data/ on each app deploy.
if [[ ${#MIGRATIONS[@]} -gt 0 ]]; then
	echo "==> Shipping data/slug-redirects.json to the server"
	rsync -az "$COMMITTED_SLUG_TABLE" "$SERVER:$SERVER_SLUG_REDIRECTS_REMOTE"
	# 2026-10-15 (TRA-499): the unioned, migration-rewritten file (validated above: a regular file that
	# parses). Overwrites the server's own, which is in the rollback archive (cache tree) and was
	# folded into the union, so nothing only the server had is lost.
	echo "==> Shipping the migrated pending-reverses.json to the server"
	rsync -az "$UNION_DIR/pending-reverses.json" "$SERVER:$SERVER_CACHE_REMOTE/pending-reverses.json"
fi

if [[ ${#REMOVE_PATHS[@]} -gt 0 ]]; then
	echo "==> Removing ${#REMOVE_PATHS[@]} node file(s) merged away by the union or removed by migrations (explicit paths, never --delete)"
	for rel in "${REMOVE_PATHS[@]}"; do
		# 2026-09-19 (TRA-276/B6c-2 review): `rm -f` alone reports success even when it silently
		# removed nothing (wrong permissions, a stale mount, a path that never matched what this
		# script computed) -- exactly the "merged-away duplicate keeps being served while the run
		# says Sync complete" failure mode the old blanket refusal existed to prevent. `test ! -e`
		# after it turns that into a hard failure (writer restarted, archive pointed at, same as any
		# other post-transfer failure) instead of a false success; `-f` still makes this a legitimate
		# no-op for a loser that only ever existed in the repo (never reached the server), since
		# `test ! -e` then trivially passes too.
		ssh "$SERVER" "rm -f -- '$SERVER_CACHE_REMOTE/$rel' && test ! -e '$SERVER_CACHE_REMOTE/$rel'"
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
echo "==> Sync complete. Rollback archive if needed: $SERVER:$ARCHIVE_PATH$ROLLBACK_NOTE"
