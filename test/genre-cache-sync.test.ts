import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// deploy/sync-genre-cache.sh -- B6b (TRA-67). Real ssh/rsync/curl are never invoked: fake
// binaries are put at the head of PATH (same technique as test/review-status-script.test.ts's
// fake `gh`), and every "$SERVER:" remote path the script builds is pointed, via its own
// SERVER_CACHE_REMOTE / SERVER_REDIRECTS_REMOTE / SERVER_BACKUP_DIR / SERVER_CRAWL_LOCK env
// overrides, at a real local directory that stands in for "the server" -- so ssh/rsync/curl
// commands the fakes don't special-case (test -f, mkdir -p, tar cf, tar --append, cat) can just run for real
// against that local stand-in. Only prepare-genre-cache-union.ts's own manifest logic is real,
// per the ticket's "not the code of the manifest" boundary.

const script = resolve("deploy/sync-genre-cache.sh");
const realRsync = execFileSync("bash", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();

const dirs: string[] = [];
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFakeBin(dir: string, name: string, body: string): void {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(path, 0o755);
}

/** A minimal but valid repo cache: one genre node, so prepare-genre-cache-union.ts's own
 * looksLikeCacheDir guard accepts it. */
function seedRepoCache(dir: string, slug = "only-repo"): void {
	mkdirSync(join(dir, "nodes", "genre"), { recursive: true });
	writeFileSync(
		join(dir, "nodes", "genre", `${slug}.json`),
		JSON.stringify({ type: "genre", name: slug, materialized_at: "2026-01-01T00:00:00.000Z" }),
	);
}

/** A minimal server-side cache "on the server" (really a local dir, stood in for via
 * SERVER_CACHE_REMOTE) -- has its own nodes/ so the union has something to compare against. */
function seedServerCache(dir: string, slug = "only-server"): void {
	mkdirSync(join(dir, "nodes", "genre"), { recursive: true });
	writeFileSync(
		join(dir, "nodes", "genre", `${slug}.json`),
		JSON.stringify({ type: "genre", name: slug, materialized_at: "2026-01-01T00:00:00.000Z" }),
	);
}

/** Two server-side genre nodes sharing one QID. The union's --apply-merge merges them and deletes
 * the loser from its artifact -- the deletion an additive transfer cannot propagate. */
function seedDuplicateOnServer(dir: string): void {
	mkdirSync(join(dir, "nodes", "genre"), { recursive: true });
	for (const [slug, when] of [
		["dancehall", "2026-02-01T00:00:00.000Z"],
		["dance-hall", "2026-01-01T00:00:00.000Z"],
	] as const) {
		writeFileSync(
			join(dir, "nodes", "genre", `${slug}.json`),
			// The duplicate report skips any genre node without a `slug` (report-genre-duplicates.ts:98),
			// so these two carry one -- unlike the single-node helpers above, which never need it.
			JSON.stringify({
				type: "genre",
				slug: `genre:${slug}`,
				name: slug,
				qid: "Q474027",
				materialized_at: when,
			}),
		);
	}
}

interface RunOptions {
	apply?: boolean;
	/** Seed the server cache with a duplicate-QID pair, so the union has a merge to apply. */
	duplicateOnServer?: boolean;
	env?: Record<string, string>;
	seedServer?: boolean;
	seedRedirects?: string;
	// The server redirects table is seeded with a valid empty table by default so most scenarios
	// don't have to think about it; set this to skip seeding entirely (the missing-table test).
	omitRedirects?: boolean;
	crawlLock?: boolean;
	serviceActive?: boolean;
	/** Seed this many pre-existing backup archives (older mtimes), for the retention test. */
	preexistingBackups?: number;
}

/** Pre-existing backup archives with staggered mtimes, oldest first, so `ls -1t` ordering (what
 * the retention prune relies on) is deterministic regardless of how fast the test runs. */
function seedOldBackups(dir: string, count: number): void {
	mkdirSync(dir, { recursive: true });
	const now = Date.now() / 1000;
	for (let i = 0; i < count; i++) {
		const p = join(dir, `genre-cache-19990101T00000${i}Z.tar.gz`);
		writeFileSync(p, "old-archive");
		const mtime = now - (count - i) * 3600;
		utimesSync(p, mtime, mtime);
	}
}

function run(options: RunOptions = {}) {
	const binDir = tmp("sync-fakes-");
	const serverRoot = tmp("sync-fake-server-");
	const repoCacheDir = tmp("sync-repo-cache-");
	const callsLog = join(tmp("sync-calls-"), "calls.log");
	writeFileSync(callsLog, "");

	seedRepoCache(repoCacheDir);
	const serverCacheRemote = join(serverRoot, "cache");
	const serverRedirectsRemote = join(serverRoot, "data", "genre-redirects.json");
	const serverBackupDir = join(serverRoot, "backups");
	const serverCrawlLock = join(serverRoot, ".crawl-lock");
	const serviceMarker = join(serverRoot, ".service-active");

	if (options.seedServer !== false) seedServerCache(serverCacheRemote);
	else mkdirSync(join(serverCacheRemote, "nodes"), { recursive: true });
	if (!options.omitRedirects) {
		mkdirSync(join(serverRoot, "data"), { recursive: true });
		writeFileSync(serverRedirectsRemote, options.seedRedirects ?? JSON.stringify({ redirects: {} }));
	}
	if (options.duplicateOnServer) seedDuplicateOnServer(serverCacheRemote);
	if (options.crawlLock) writeFileSync(serverCrawlLock, "");
	if (options.serviceActive !== false) writeFileSync(serviceMarker, "");
	if (options.preexistingBackups) seedOldBackups(serverBackupDir, options.preexistingBackups);

	// Fake ssh: runs the remote command locally via bash -c, since every remote path the script
	// builds already points at a real local dir (see file header). systemctl and the sha256sum
	// fingerprint command are special-cased -- nothing else needs to be.
	writeFakeBin(
		binDir,
		"ssh",
		`
printf 'ssh %s\\n' "$*" >> "$TEST_CALLS"
if [[ "\${TEST_SSH_FAIL:-0}" == "1" ]]; then
  echo "ssh: simulated connection failure" >&2
  exit 255
fi
host="$1"; shift
cmd="$*"
# Fails only the ONE remote command whose text contains this substring (e.g. "systemctl stop",
# ".crawl-lock", "is-active"), simulating a transport drop for just that call -- the rest of the
# run proceeds normally, which a blanket TEST_SSH_FAIL can't exercise.
if [[ -n "\${TEST_SSH_FAIL_MATCH:-}" && "$cmd" == *"\${TEST_SSH_FAIL_MATCH}"* ]]; then
  echo "ssh: simulated connection failure for matched command" >&2
  exit 255
fi
case "$cmd" in
  *"systemctl stop odyssey-server.service"*)
    if [[ "\${TEST_STOP_NOOP:-0}" != "1" ]]; then rm -f "$TEST_SERVICE_MARKER"; fi
    ;;
  *"systemctl start odyssey-server.service"*)
    if [[ "\${TEST_START_FAIL:-0}" == "1" ]]; then
      echo "systemctl: simulated start failure" >&2
      exit 1
    fi
    touch "$TEST_SERVICE_MARKER"
    ;;
  *"systemctl is-active --quiet odyssey-server.service"*)
    [[ -f "$TEST_SERVICE_MARKER" ]]
    ;;
  *"sha256sum"*)
    count_file="$TEST_CALLS.fingerprint_count"
    n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$count_file"
    if [[ -n "\${TEST_FINGERPRINT_CHANGES_AFTER:-}" && "$n" -ge "\${TEST_FINGERPRINT_CHANGES_AFTER}" ]]; then
      echo "changed-hash-call-$n"
    else
      bash -c "$cmd"
    fi
    ;;
  *"gzip -t"*)
    if [[ "\${TEST_CORRUPT_ARCHIVE:-0}" == "1" ]]; then
      path=$(printf '%s' "$cmd" | sed -n "s/.*gzip -t '\\(.*\\)'.*/\\1/p")
      printf 'not a gzip file' > "$path"
    fi
    bash -c "$cmd"
    ;;
  *"&& test ! -e"*)
    # Simulates an 'rm -f' that silently removed nothing (wrong permissions, a stale mount): only
    # run the existence check the real command chains after it, never the removal itself -- so the
    # file survives and the check (if the script has it) is what must catch that.
    if [[ "\${TEST_RM_SILENT_NOOP:-0}" == "1" ]]; then
      bash -c "\${cmd#*&& }"
    else
      bash -c "$cmd"
    fi
    ;;
  *)
    bash -c "$cmd"
    ;;
esac
`,
	);

	// Fake rsync: strips a "host:" prefix off any remote-looking arg (every one built by the
	// script is really a local path, see file header) and delegates to the real rsync so files
	// actually move between the two local stand-in directories.
	writeFakeBin(
		binDir,
		"rsync",
		`
# rsync forks a --server side of ITSELF even for a purely local copy (no remote host involved),
# re-invoking the bare \`rsync\` command -- which, with this fake bin dir still first on PATH,
# would recurse back into this very script. That must never be counted as a new top-level call
# (it would corrupt both the call counter and which call the injected failure targets), so it is
# special-cased straight through to the real binary before any of that bookkeeping.
if [[ "$1" == "--server" ]]; then
  args=()
  for a in "$@"; do
    if [[ "$a" == *:* && "$a" != -* ]]; then
      args+=("\${a#*:}")
    else
      args+=("$a")
    fi
  done
  exec "$REAL_RSYNC" "\${args[@]}"
fi
printf 'rsync %s\\n' "$*" >> "$TEST_CALLS"
count_file="$TEST_CALLS.rsync_count"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
if [[ -n "\${TEST_RSYNC_FAIL_ON_CALL:-}" && "$n" == "\${TEST_RSYNC_FAIL_ON_CALL}" ]]; then
  echo "rsync: simulated transfer failure" >&2
  exit 23
fi
args=()
for a in "$@"; do
  if [[ "$a" == *:* && "$a" != -* ]]; then
    args+=("\${a#*:}")
  else
    args+=("$a")
  fi
done
exec "$REAL_RSYNC" "\${args[@]}"
`,
	);

	writeFakeBin(
		binDir,
		"curl",
		`
printf 'curl %s\\n' "$*" >> "$TEST_CALLS"
if [[ "\${TEST_CURL_FAIL:-0}" == "1" ]]; then
  echo "curl: simulated smoke-test failure" >&2
  exit 7
fi
# Fails the first N calls then succeeds, simulating tsx's 5-10s warm-up window that the smoke
# test's retry loop is meant to ride out.
if [[ -n "\${TEST_CURL_FAIL_COUNT:-}" ]]; then
  count_file="$TEST_CALLS.curl_count"
  n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$count_file"
  if [[ "$n" -le "\${TEST_CURL_FAIL_COUNT}" ]]; then
    echo "curl: simulated smoke-test failure (warming up)" >&2
    exit 7
  fi
fi
echo "ok"
`,
	);

	const result = spawnSync("bash", [script, ...(options.apply ? ["--apply"] : [])], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			SERVER: "test@fake-server",
			REPO_CACHE_DIR: repoCacheDir,
			SERVER_CACHE_REMOTE: serverCacheRemote,
			SERVER_REDIRECTS_REMOTE: serverRedirectsRemote,
			SERVER_BACKUP_DIR: serverBackupDir,
			SERVER_CRAWL_LOCK: serverCrawlLock,
			SERVER_HEALTH_URL: "https://example.invalid/api/odyssey/health",
			SERVER_VERSION_URL: "https://example.invalid/api/odyssey/version",
			TEST_CALLS: callsLog,
			TEST_SERVICE_MARKER: serviceMarker,
			REAL_RSYNC: realRsync,
			// This suite runs the real script against this repo's own worktree (REPO_ROOT is derived
			// from the script's real on-disk path), which is never actually branch "main" or clean in
			// dev/CI -- bypass the branch/clean-tree guard here; it has its own dedicated tests below
			// against an isolated git fixture.
			SYNC_ALLOW_NON_MAIN: "1",
			SYNC_ALLOW_DIRTY: "1",
			...options.env,
		},
	});
	const calls = existsSync(callsLog) ? readFileSync(callsLog, "utf8") : "";
	return { result, calls, serverRoot, serverCacheRemote, serverBackupDir, repoCacheDir };
}

describe("sync-genre-cache.sh", () => {
	it("previews by default: builds and prints the union manifest, but performs no server write", () => {
		const { result, calls, serverBackupDir } = run();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Preview only");
		expect(result.stdout).toContain("manifest.json");
		// The snapshot pull happens (read-only), but never the writer stop, the final nodes/
		// transfer, or the archive.
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(serverBackupDir)).toBe(false);
		// Nit: the union's own mktemp output dir (never removed by prepare-genre-cache-union.ts
		// itself) must not be left behind once this script exits.
		const unionDir = /Union written to (\S+) /.exec(result.stdout)?.[1];
		expect(unionDir).toBeTruthy();
		expect(existsSync(unionDir!)).toBe(false);
	});

	// Nit: a missing/unreachable server table must be a hard refusal, never a silent "no
	// redirects" -- same discipline as loadRequiredGenreRedirects (TRA-245).
	it("refuses when the server's redirects table is missing, rather than assuming it's empty", () => {
		const { result } = run({ omitRedirects: true });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/redirects table missing|unreachable/);
	});

	it("refuses to apply and never writes when the union itself reports a problem (e.g. a qid conflict)", () => {
		// Seed a same-slug qid conflict between repo and server so the union's own exit code is
		// non-zero -- the sync script must propagate that refusal rather than silently applying.
		const binDir = tmp("sync-fakes-");
		const serverRoot = tmp("sync-fake-server-");
		const repoCacheDir = tmp("sync-repo-cache-");
		mkdirSync(join(repoCacheDir, "nodes", "genre"), { recursive: true });
		writeFileSync(
			join(repoCacheDir, "nodes", "genre", "conflict.json"),
			JSON.stringify({ type: "genre", name: "x", qid: "Q1", materialized_at: "2026-01-01T00:00:00.000Z" }),
		);
		const serverCacheRemote = join(serverRoot, "cache");
		mkdirSync(join(serverCacheRemote, "nodes", "genre"), { recursive: true });
		writeFileSync(
			join(serverCacheRemote, "nodes", "genre", "conflict.json"),
			JSON.stringify({ type: "genre", name: "x", qid: "Q2", materialized_at: "2026-01-01T00:00:00.000Z" }),
		);
		mkdirSync(join(serverRoot, "data"), { recursive: true });
		writeFileSync(join(serverRoot, "data", "genre-redirects.json"), JSON.stringify({ redirects: {} }));
		const callsLog = join(tmp("sync-calls-"), "calls.log");
		writeFileSync(callsLog, "");
		writeFakeBin(binDir, "ssh", `printf 'ssh %s\\n' "$*" >> "$TEST_CALLS"\nhost="$1"; shift\nbash -c "$*"\n`);
		writeFakeBin(
			binDir,
			"rsync",
			// No --server guard here: this test never injects a call-numbered failure, so rsync's own
			// internal self-reinvocation (see the main fake's comment) can't corrupt anything it reads.
			`printf 'rsync %s\\n' "$*" >> "$TEST_CALLS"\nargs=()\nfor a in "$@"; do if [[ "$a" == *:* && "$a" != -* ]]; then args+=("\${a#*:}"); else args+=("$a"); fi; done\nexec "$REAL_RSYNC" "\${args[@]}"\n`,
		);
		writeFakeBin(binDir, "curl", `printf 'curl %s\\n' "$*" >> "$TEST_CALLS"\necho ok\n`);

		const result = spawnSync("bash", [script, "--apply"], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				SERVER: "test@fake-server",
				REPO_CACHE_DIR: repoCacheDir,
				SERVER_CACHE_REMOTE: serverCacheRemote,
				SERVER_REDIRECTS_REMOTE: join(serverRoot, "data", "genre-redirects.json"),
				SERVER_BACKUP_DIR: join(serverRoot, "backups"),
				SERVER_CRAWL_LOCK: join(serverRoot, ".crawl-lock"),
				TEST_CALLS: callsLog,
				REAL_RSYNC: realRsync,
				SYNC_ALLOW_NON_MAIN: "1",
				SYNC_ALLOW_DIRTY: "1",
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("reported problems");
		expect(existsSync(join(serverRoot, "backups"))).toBe(false);
	});

	it("passes --server-redirects-path through without tripping the guard when the two tables don't overlap", () => {
		const { result } = run({
			seedRedirects: JSON.stringify({ redirects: { "genre:only-server": "genre:only-repo" } }),
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Preview only");
	});

	// PR #213 review (B6a-2): a real duplicate group where the server already redirected the SAME
	// loser slug somewhere else than the repo's own committed table must be refused, not silently
	// resolved -- see diffGenreRedirects. Reads the repo's actual committed table (rather than
	// hardcoding one of its entries) so this stays correct as that file's content evolves; picking
	// its first entry and fabricating a different target for the SAME key is what "diverges" means.
	it("refuses when the server's own redirects table diverges from the repo's committed one, with no server write even under --apply", () => {
		const committed = JSON.parse(readFileSync(resolve("data/genre-redirects.json"), "utf8")) as {
			redirects: Record<string, string>;
		};
		const [loserSlug] = Object.entries(committed.redirects)[0] ?? [];
		if (!loserSlug) throw new Error("data/genre-redirects.json has no entries to diverge from");

		const { result, serverBackupDir } = run({
			apply: true,
			seedRedirects: JSON.stringify({ redirects: { [loserSlug]: "genre:sync-test-diverged-target" } }),
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("reported problems");
		expect(result.stdout).toContain("diverged-target");
		expect(existsSync(serverBackupDir)).toBe(false);
	});

	// 2026-09-19 (TRA-276/B6c-2): the union runs the merge migration with --apply-merge, which
	// deletes the loser of a duplicate-QID group from its artifact and writes the merged redirects
	// table (see prepare-genre-cache-union.ts). seedDuplicateOnServer's two nodes share a QID with no
	// existing redirect and no usages, so electCanonical's tie-break (shortest slug) elects
	// genre:dancehall as the winner and genre:dance-hall as the loser -- this must now be propagated,
	// not refused: the loser's file removed on the server, the union's redirects table shipped, the
	// writer restarted, and the smoke test still passing.
	it("propagates a merged duplicate to the server on --apply: removes the loser, ships the redirects table, and the smoke test passes", () => {
		const { result, calls, serverCacheRemote, serverRoot } = run({
			apply: true,
			duplicateOnServer: true,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Sync complete");
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(false);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dancehall.json"))).toBe(true);
		// The unrelated, never-merged server-only node survives untouched.
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
		const serverRedirects = JSON.parse(
			readFileSync(join(serverRoot, "data", "genre-redirects.json"), "utf8"),
		) as { redirects: Record<string, string> };
		expect(serverRedirects.redirects["genre:dance-hall"]).toBe("genre:dancehall");
		// Explicit, individual removal -- never rsync --delete/--del (see the dedicated test below too).
		expect(calls).toMatch(/rm -f -- '.*dance-hall\.json'/);
		expect(calls).not.toMatch(/rsync[^\n]*--delete/);
		expect(calls).not.toMatch(/rsync[^\n]*--del\b/);
		expect(calls).toContain("systemctl stop odyssey-server.service");
		expect(calls).toContain("systemctl start odyssey-server.service");
	});

	// The manifest's own deletedCount and its removedByMigration list are computed independently
	// (see the guard's comment in the script) -- a real union can never make them disagree, so the
	// test drives the guard directly via a test-only hook.
	it("refuses when the manifest disagrees with itself about what was merged away, before any write", () => {
		const { result, calls, serverBackupDir } = run({
			apply: true,
			env: { TEST_FORCE_REMOVED_COUNT_MISMATCH: "1" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/disagrees with itself/);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(serverBackupDir)).toBe(false);
	});

	// isValidSlug/parseSlug (src/slug.ts) enforce neither '/' nor '..' in a slug body -- real
	// defense-in-depth, exercised via a test-only override since makeSlug never produces such a slug.
	it("refuses when a removed slug's body contains a path separator, before any write", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			duplicateOnServer: true,
			env: { TEST_OVERRIDE_REMOVED_SLUG: "genre:../../etc/evil" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/outside the normalized slug charset/);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(serverBackupDir)).toBe(false);
		// Still there: the guard refused before the transfer step that would have removed it.
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
	});

	// Independent review of this PR: a blacklist of '..'/'/' alone let a shell metacharacter through
	// undetected. This slug body is interpolated between single quotes in the remote `rm -f --`
	// command below, so a bare apostrophe breaks the quoting -- `genre:a'; reboot; echo '` used to
	// pass the old check (it contains neither '..' nor '/') and reach `ssh` verbatim, executing
	// `reboot` as its own command, as root, on the real production host. The whitelist regex refuses
	// it outright; no slash is needed to trip it.
	it("refuses when a removed slug's body contains a shell metacharacter (e.g. a quote), before any write", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			duplicateOnServer: true,
			env: { TEST_OVERRIDE_REMOVED_SLUG: "genre:a'; echo pwned; echo '" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/outside the normalized slug charset/);
		expect(calls).not.toContain("systemctl stop");
		// The malicious payload never reached a remote command at all.
		expect(calls).not.toContain("pwned");
		expect(existsSync(serverBackupDir)).toBe(false);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
	});

	// The union always runs with --apply-merge (this script's own invocation), so a missing
	// migrationApply section means the manifest isn't what this script expects -- a contract
	// violation to refuse hard on, not "nothing to merge" (deletedCount:0/removedByMigration:[] are
	// still a present migrationApply, and are exercised by the "without a duplicate" test below).
	it("refuses when the manifest has no migrationApply section at all, before any write", () => {
		const { result, calls, serverBackupDir } = run({
			apply: true,
			env: { TEST_FORCE_MISSING_MIGRATION_APPLY: "1" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/no migrationApply section/);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(serverBackupDir)).toBe(false);
	});

	// 2026-09-19 (TRA-276/B6c-2 review): `rm -f` alone reports success even when it silently removed
	// nothing -- exactly the "merged-away duplicate keeps being served while the run says Sync
	// complete" failure the old blanket refusal existed to prevent. TEST_RM_SILENT_NOOP makes the
	// fake ssh run only the `test ! -e` half of the chained remote command, never the `rm -f` half,
	// so the file survives; the check after it must turn that into a hard failure.
	it("verifies the deletion actually happened, not just that `rm` exited 0 (a silent no-op fails instead of reporting success)", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			duplicateOnServer: true,
			env: { TEST_RM_SILENT_NOOP: "1" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/Restore from the archive/);
		// The file the script believes it removed is, in fact, still there -- exactly what the check
		// exists to catch.
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
		expect(calls).toContain("systemctl start odyssey-server.service");
		expect(readdirSync(serverBackupDir)).toHaveLength(1);
	});

	// Without a duplicate to merge, behavior is unchanged: no deletion, and the redirects table is
	// shipped identically to the repo's own committed one (server's snapshot was empty, so merging it
	// in changes nothing).
	it("without a duplicate on the server, deletes nothing and still ships the (unchanged) redirects table", () => {
		const committed = JSON.parse(readFileSync(resolve("data/genre-redirects.json"), "utf8")) as {
			redirects: Record<string, string>;
		};
		const { result, calls, serverCacheRemote, serverRoot } = run({ apply: true });
		expect(result.status).toBe(0);
		// Not `/rm -f --/` alone -- the backup-retention prune (unrelated to this ticket) also uses
		// `rm -f --` in its own remote command text.
		expect(calls).not.toMatch(/rm -f -- '.*nodes\//);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
		const serverRedirects = JSON.parse(
			readFileSync(join(serverRoot, "data", "genre-redirects.json"), "utf8"),
		) as { redirects: Record<string, string> };
		expect(serverRedirects.redirects).toEqual(committed.redirects);
	});

	// Preview (no --apply) must still write nothing at all, even when the union would merge a
	// duplicate present on the server.
	it("preview mode performs no deletion and no redirects push even when the union would merge a duplicate", () => {
		const { result, calls, serverCacheRemote, serverRoot } = run({ duplicateOnServer: true });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Preview only");
		expect(calls).not.toMatch(/rm -f --/);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dancehall.json"))).toBe(true);
		const serverRedirects = JSON.parse(
			readFileSync(join(serverRoot, "data", "genre-redirects.json"), "utf8"),
		) as { redirects: Record<string, string> };
		expect(serverRedirects.redirects).toEqual({});
	});

	// Ticket note: a deletion failure must be handled exactly like any other post-transfer failure --
	// restart the writer, point at the archive. TEST_SSH_FAIL_MATCH is scoped to the loser's own
	// path (not the bare "rm -f --" substring, which the unrelated backup-retention prune also
	// uses), so only this deletion call fails and the file it targets was never actually touched.
	it("on a deletion failure, restarts the writer and points at the archive like other post-transfer failures", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			duplicateOnServer: true,
			env: { TEST_SSH_FAIL_MATCH: "nodes/genre/dance-hall.json" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/Restore from the archive/);
		expect(calls).toContain("systemctl start odyssey-server.service");
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
		expect(readdirSync(serverBackupDir)).toHaveLength(1);
	});

	it("archives the server cache AND the pre-write redirects table before any apply, verifies it with gzip -t, and prints the rollback archive path", () => {
		const { result, calls, serverBackupDir } = run({ apply: true });
		expect(result.status).toBe(0);
		// gzip can't append to an already-compressed archive, hence the two-step tar (cache/, then
		// the redirects file) compressed last -- see the script's own comment.
		expect(calls).toContain("tar cf");
		expect(calls).toContain("tar --append");
		expect(calls).toContain("gzip -t");
		const archives = readdirSync(serverBackupDir);
		expect(archives).toHaveLength(1);
		expect(archives[0]).toMatch(/^genre-cache-.*\.tar\.gz$/);
		expect(result.stdout).toContain(
			`Rollback archive: test@fake-server:${join(serverBackupDir, archives[0]!)}`,
		);
		// "Rollback = the printed archive" (file header) must be literally true: this script writes
		// the server's redirects table too, so its pre-write content belongs in the same archive as
		// the cache tree -- not just cache/, which cleanup() would otherwise leave with no way back.
		const archivePath = join(serverBackupDir, archives[0]!);
		const entries = execFileSync("tar", ["tzf", archivePath], { encoding: "utf8" });
		expect(entries).toMatch(/(^|\/)cache\//m);
		// Nested under data/, not flat at the archive root (second review round): only then does a single
		// `tar xzf … -C /opt/odyssey-music` put it back where the server reads it.
		expect(entries).toMatch(/^data\/genre-redirects\.json$/m);
		expect(entries).not.toMatch(/^genre-redirects\.json$/m);
	});

	// Nit: the archive is verified (gzip -t) before the script proceeds to stop the writer.
	it("refuses to proceed when the archive fails its integrity check", () => {
		const { result, calls } = run({ apply: true, env: { TEST_CORRUPT_ARCHIVE: "1" } });
		expect(result.status).not.toBe(0);
		expect(calls).toContain("gzip -t");
		expect(calls).not.toContain("systemctl stop");
	});

	it("stops the writer, verifies it stopped, transfers additively (never --delete or --del), and restarts it", () => {
		const { result, calls, serverCacheRemote, repoCacheDir } = run({ apply: true });
		expect(result.status).toBe(0);
		expect(calls).toContain("systemctl stop odyssey-server.service");
		expect(calls).toContain("systemctl start odyssey-server.service");
		expect(calls).not.toMatch(/rsync[^\n]*--delete/);
		expect(calls).not.toMatch(/rsync[^\n]*--del\b/);
		// The repo-only node made it into the server's nodes/ tree, and the server-only node (never
		// in the repo) was NOT deleted -- the criterion this whole script exists to satisfy.
		const repoSlug = readdirSync(join(repoCacheDir, "nodes", "genre"))[0];
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", repoSlug!))).toBe(true);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
	});

	it("refuses to write when a crawl lock is present on the server, and performs no archive", () => {
		const { result, calls, serverBackupDir } = run({ apply: true, crawlLock: true });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/crawl.*progress/i);
		expect(calls).not.toContain("tar cf");
		expect(existsSync(serverBackupDir)).toBe(false);
	});

	it("refuses to write when the writer is still active after the stop attempt", () => {
		const { result, calls } = run({ apply: true, env: { TEST_STOP_NOOP: "1" } });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("still active after stop");
		// Archived (mandatory, happens before the stop) but never transferred.
		expect(calls).toContain("tar cf");
		expect(calls).not.toMatch(/rsync[^\n]*nodes\/$/m);
	});

	it("refuses to write when the server cache fingerprint changed since the snapshot", () => {
		const { result, serverBackupDir } = run({
			apply: true,
			env: { TEST_FINGERPRINT_CHANGES_AFTER: "2" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("fingerprint changed since the snapshot");
		// Archive already happened (mandatory, before the stop/fingerprint recheck) -- rollback is
		// still available even on this refusal path.
		expect(readdirSync(serverBackupDir)).toHaveLength(1);
	});

	it("on a transfer failure, restarts the writer, deletes nothing and points the operator at the archive", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			env: { TEST_RSYNC_FAIL_ON_CALL: "2" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/Restore from the archive/);
		expect(result.stderr).toContain(serverBackupDir.replace(/\/$/, ""));
		// 2026-09-17 (review of TRA-67): "safe state (... no data was removed)" talked an operator
		// out of a restore they need -- a partial transfer leaves a mix of old and new node files.
		expect(result.stderr).not.toMatch(/no data was removed/);
		expect(result.stderr).not.toMatch(/safe state/);
		// The writer was restarted despite the failed transfer.
		expect(calls).toContain("systemctl start odyssey-server.service");
		// Nothing was removed from the (untouched, since the transfer itself failed) server cache.
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
		expect(readdirSync(serverBackupDir)).toHaveLength(1);
	});

	// TRA-271 point 1 (independent review of TRA-67): the fingerprint used to be taken AFTER the
	// snapshot rsync, so a write landing on the server mid-copy entered the reference fingerprint
	// without ever reaching the copy -- and the post-stop recheck, comparing against that same
	// tainted reference, would not catch it. Every ssh/rsync call lands in the same TEST_CALLS log
	// in execution order, so the fix is verifiable directly: the fingerprinting ssh call (its
	// remote command contains "sha256sum") must precede the snapshot-pulling rsync call.
	it("fingerprints the server cache before the snapshot copy (point 1: relevé/arrêt race)", () => {
		const { result, calls } = run();
		expect(result.status).toBe(0);
		const lines = calls.split("\n").filter(Boolean);
		const fingerprintIdx = lines.findIndex((l) => l.includes("sha256sum"));
		const snapshotRsyncIdx = lines.findIndex((l) => l.startsWith("rsync "));
		expect(fingerprintIdx).toBeGreaterThanOrEqual(0);
		expect(snapshotRsyncIdx).toBeGreaterThanOrEqual(0);
		expect(fingerprintIdx).toBeLessThan(snapshotRsyncIdx);
	});

	// TRA-271 point 2a: STOPPED must flip to 1 BEFORE the stop command runs, not after it succeeds
	// -- otherwise a stop call that itself fails never triggers a restart attempt. TEST_SSH_FAIL_MATCH
	// fails only the "systemctl stop" call (not every ssh call), so the run still fails, but the
	// restart must still be attempted.
	it("still attempts to restart the writer when the stop command itself fails (point 2: STOPPED before stop)", () => {
		const { result, calls } = run({ apply: true, env: { TEST_SSH_FAIL_MATCH: "systemctl stop" } });
		expect(result.status).not.toBe(0);
		expect(calls).toContain("systemctl start odyssey-server.service");
	});

	// TRA-271 point 2b: the recovery path used to trap ERR only, which never fires for a signal --
	// a SIGTERM or Ctrl-C mid-transfer left the writer stopped with nothing to bring it back.
	// Driving a real signal through a spawned bash process is inherently timing-sensitive (signal
	// delivery to a shell blocked on a foreground child is not guaranteed to preempt promptly, and
	// differs across bash builds), so this is verified at the source level instead: the script must
	// register an EXIT trap (reachable from a restart) plus explicit INT and TERM traps.
	it("registers EXIT, INT and TERM traps so a signal still restarts the writer (point 2: trap coverage)", () => {
		const src = readFileSync(script, "utf8");
		expect(src).toMatch(/trap\s+\S*on_exit\S*\s+EXIT/);
		expect(src).toMatch(/trap\s+\S*exit \d+\S*\s+INT\b/);
		expect(src).toMatch(/trap\s+\S*exit \d+\S*\s+TERM\b/);
	});

	// TRA-271 point 3a: tsx takes 5-10s to warm up after a restart under Type=simple, so the smoke
	// test needs a retry loop (same pattern as deploy/deploy-server.sh's own health check) instead
	// of a single shot that fails almost every time and prints a misleading rollback message.
	it("retries the smoke test while the server warms up, succeeding once it responds (point 3: smoke retry)", () => {
		const { result, calls } = run({
			apply: true,
			env: { TEST_CURL_FAIL_COUNT: "2", SMOKE_RETRY_DELAY: "0" },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Sync complete");
		const curlHealthCalls = calls
			.split("\n")
			.filter((l) => l.startsWith("curl") && l.includes("health")).length;
		// Failed twice, then succeeded: 3 calls to the health endpoint before "ok" from the loop.
		expect(curlHealthCalls).toBeGreaterThanOrEqual(3);
	});

	it("gives up and refuses after exhausting smoke-test retries (point 3: smoke retry)", () => {
		const { result, calls } = run({
			apply: true,
			env: { TEST_CURL_FAIL: "1", SMOKE_RETRY_DELAY: "0", SMOKE_RETRY_COUNT: "3" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/did not respond/);
		// The writer was still restarted (transfer succeeded) even though the smoke test never did.
		expect(calls).toContain("systemctl start odyssey-server.service");
	});

	// TRA-271 point 3b: `ssh ... systemctl start || true` used to swallow a failed restart outright
	// -- the script would fall through into a doomed smoke test instead of failing loud immediately.
	it("does not swallow a failed restart: exits before the smoke test instead (point 3: don't swallow start)", () => {
		const { result, calls } = run({ apply: true, env: { TEST_START_FAIL: "1" } });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/failed to restart/);
		expect(calls).toContain("systemctl start odyssey-server.service");
		expect(calls).not.toMatch(/^curl /m);
	});

	// TRA-271 point 4: TEST_SSH_FAIL (a blanket ssh transport failure) must actually be exercised by
	// a test, not just supported by the fake -- an ssh outage must refuse cleanly, not partially run.
	it("refuses cleanly when ssh cannot reach the server at all (point 4: TEST_SSH_FAIL exercised)", () => {
		const { result, calls } = run({ env: { TEST_SSH_FAIL: "1" } });
		expect(result.status).not.toBe(0);
		expect(calls).not.toContain("rsync ");
	});

	// TRA-271 point 5 (nit): the remote fingerprint pipeline must run under `set -o pipefail` (a
	// failed read of one file must not be silently swallowed by the pipe's last exit code) and must
	// exclude the youtube/ and links/ sidecar directories (CLAUDE.md: resolver sidecars are
	// derived/regenerable, so churn there must not trip the "cache changed" refusal). Asserted on
	// the actual remote command text sent over ssh, so removing either flag turns this red.
	it("computes the remote fingerprint under pipefail, excluding youtube/ and links/ sidecars (point 5: fingerprint nits)", () => {
		const { result, calls } = run();
		expect(result.status).toBe(0);
		const fingerprintCall = calls.split("\n").find((l) => l.includes("sha256sum"));
		expect(fingerprintCall).toBeDefined();
		expect(fingerprintCall).toMatch(/\bpipefail\b/);
		expect(fingerprintCall).toMatch(/-not -path[^|]*youtube/);
		expect(fingerprintCall).toMatch(/-not -path[^|]*links/);
	});

	// TRA-271 point 5 (nit) + PR #221 review remark: TRA-269 runs this script on a recurring
	// schedule, so /opt/odyssey-music-backups grows unbounded without a retention policy.
	it("prunes old backup archives, keeping only the BACKUP_RETENTION_COUNT most recent (point 5: retention)", () => {
		const { result, calls, serverBackupDir } = run({
			apply: true,
			preexistingBackups: 3,
			env: { BACKUP_RETENTION_COUNT: "2" },
		});
		expect(result.status).toBe(0);
		expect(calls).toContain("ls -1t genre-cache-");
		const [, thisRunArchive] = /Rollback archive: [^:]+:(\S+)/.exec(result.stdout) ?? [];
		if (!thisRunArchive) throw new Error("could not find the rollback archive path in stdout");
		// 3 pre-existing + this run's own = 4 candidates; keeping 2 must still keep the one just made.
		expect(existsSync(thisRunArchive)).toBe(true);
		expect(readdirSync(serverBackupDir)).toHaveLength(2);
	});

	// PR #221 review remark: the crawl-lock and is-active guards used `if ssh ...; then`, so an SSH
	// transport failure (exit 255) read the same as "false" (no lock / not active) and the script
	// continued as if it were safe -- fail-open. The redirects-table guard above already fails
	// closed on ANY non-zero exit because both failure modes want the same outcome there; these two
	// guards want DIFFERENT outcomes for "ssh answered no" vs "ssh couldn't even ask", so they must
	// tell the two apart and refuse specifically on the transport failure.
	it("fails closed when checking the crawl lock: an ssh failure refuses rather than reading as 'no lock' (review: fail-open)", () => {
		const { result, calls } = run({ apply: true, env: { TEST_SSH_FAIL_MATCH: ".crawl-lock" } });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/crawl lock/i);
		expect(calls).not.toContain("tar cf");
	});

	it("fails closed when confirming the writer stopped: an ssh failure refuses rather than reading as 'not active' (review: fail-open)", () => {
		const { result, calls } = run({ apply: true, env: { TEST_SSH_FAIL_MATCH: "is-active" } });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/could not confirm/i);
		// The stop call itself succeeded; only the confirmation check's own ssh call failed.
		expect(calls).toContain("systemctl stop odyssey-server.service");
		expect(calls).not.toMatch(/rsync[^\n]*nodes\/$/m);
	});

	// PR #255 review, finding 1: on a fatal shell-level error (unbound variable under `set -u`,
	// invalid `$(( ))`), bash resets $? to 0 before an EXIT trap runs (reproduced on bash 3.2) --
	// the old `on_exit` did `local code=$?; ...; exit "$code"` unconditionally, so this class of
	// crash reported success. TEST_FORCE_FATAL_ERROR triggers exactly that class of error.
	it("does not report success on a fatal shell-level error (review finding 1: EXIT trap swallowed $?)", () => {
		const { result } = run({ env: { TEST_FORCE_FATAL_ERROR: "1" } });
		expect(result.status).not.toBe(0);
	});

	// Second independent review of PR #255: the rollback pointer was gated on `$code -ne 0` -- the
	// value the sentinel exists because bash resets it to 0 on a fatal shell error. Reproduced by
	// the reviewer: writer stopped, transfer DONE, fatal error, and the operator never sees where
	// the archive is. The gate is now "the writer was stopped", i.e. the transfer step was reached.
	it("points at the rollback archive when a fatal shell error hits after the transfer", () => {
		const { result, calls, serverBackupDir } = run({
			apply: true,
			env: { TEST_FORCE_FATAL_ERROR: "after-transfer" },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/Restore from the archive/);
		const archives = readdirSync(serverBackupDir);
		expect(archives).toHaveLength(1);
		expect(result.stderr).toContain(join(serverBackupDir, archives[0]!));
		// The transfer really did happen before the crash -- otherwise this asserts nothing.
		expect(calls).toContain("systemctl stop odyssey-server.service");
	});

	// PR #255 review, finding 2: BACKUP_RETENTION_COUNT was never validated. "ten" fed the
	// unbound-variable bug above via `$((BACKUP_RETENTION_COUNT + 1))` (bash arithmetic treats a
	// bareword as a nested variable reference); 0 made `tail -n +1` re-list (and delete) every
	// archive, including the one this run just made -- reproduced by the reviewer with 3
	// pre-existing archives: backup dir left empty, transfer still applied, status 0.
	it("refuses when BACKUP_RETENTION_COUNT is not a positive integer (review finding 2)", () => {
		const zero = run({ apply: true, preexistingBackups: 3, env: { BACKUP_RETENTION_COUNT: "0" } });
		expect(zero.result.status).not.toBe(0);
		expect(zero.result.stderr).toMatch(/BACKUP_RETENTION_COUNT/);
		// Refused before anything destructive: no archive made, nothing pruned, no transfer.
		expect(zero.calls).not.toContain("tar cf");
		expect(readdirSync(zero.serverBackupDir)).toHaveLength(3);

		const nonNumeric = run({ apply: true, env: { BACKUP_RETENTION_COUNT: "ten" } });
		expect(nonNumeric.result.status).not.toBe(0);
		expect(nonNumeric.result.stderr).toMatch(/BACKUP_RETENTION_COUNT/);
		expect(nonNumeric.calls).not.toContain("tar cf");
	});
});

describe("sync-genre-cache.sh -- branch/clean-tree guard (TRA-271 point 5 nit, reused from deploy-server.sh:34-43)", () => {
	/** An isolated git repo with just the real script committed into it, so the guard's own git
	 * calls (branch name, dirty check) resolve against a repo this suite fully controls -- never
	 * against the actual dev checkout, which must never be mutated by a test. */
	function fixtureRepo(): string {
		const dir = tmp("sync-guard-repo-");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "test@test.invalid"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
		mkdirSync(join(dir, "deploy"), { recursive: true });
		const scriptCopy = join(dir, "deploy", "sync-genre-cache.sh");
		writeFileSync(scriptCopy, readFileSync(script, "utf8"));
		chmodSync(scriptCopy, 0o755);
		writeFileSync(join(dir, "README.md"), "fixture\n");
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
		return dir;
	}

	// 2026-09-18 (independent review of this PR): the guard used to run before argument parsing,
	// so it applied to the read-only preview too -- which the script's own Usage comment documents
	// as safe to run from a branch. It's now gated on --apply (the only path that touches the
	// server), so exercising it here means always passing --apply.
	function runFixture(dir: string, env: Record<string, string> = {}) {
		// SERVER points at an address that refuses instantly rather than the real production host --
		// belt and suspenders in case a guard regression ever lets the script run past this point.
		return spawnSync("bash", [join(dir, "deploy", "sync-genre-cache.sh"), "--apply"], {
			encoding: "utf8",
			env: { ...process.env, SERVER: "unused@127.0.0.1", ...env },
		});
	}

	it("does not apply the guard to the read-only preview (no --apply)", () => {
		const dir = fixtureRepo();
		execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });
		writeFileSync(join(dir, "README.md"), "dirty\n");
		const result = spawnSync("bash", [join(dir, "deploy", "sync-genre-cache.sh")], {
			encoding: "utf8",
			env: { ...process.env, SERVER: "unused@127.0.0.1" },
		});
		// Non-main AND dirty, but no --apply: the guard must not even run. It fails later, for an
		// unrelated reason (no real server), never on "expected main" or "dirty".
		expect(result.stderr).not.toMatch(/expected main|working tree is dirty/);
	});

	it("refuses to apply from a non-main branch", () => {
		const dir = fixtureRepo();
		execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });
		const result = runFixture(dir);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/expected main/);
	});

	it("refuses to apply when the working tree is dirty", () => {
		const dir = fixtureRepo();
		writeFileSync(join(dir, "README.md"), "dirty\n");
		const result = runFixture(dir, { SYNC_ALLOW_NON_MAIN: "1" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/dirty/i);
	});

	// 2026-09-18 (independent review of this PR): `git diff` / `git diff --cached` both ignore
	// untracked files, so an uncommitted cache/nodes/genre/foo.json -- which enters REPO_CACHE_DIR
	// and the union regardless of git's index -- shipped to prod while this guard still called the
	// tree clean. `git status --short` (used now) lists untracked files too.
	it("refuses to apply when there are untracked files, not just tracked changes", () => {
		const dir = fixtureRepo();
		writeFileSync(join(dir, "untracked.txt"), "not added to git\n");
		const result = runFixture(dir, { SYNC_ALLOW_NON_MAIN: "1" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/dirty/i);
	});

	it("proceeds past the guard on main with a clean tree", () => {
		const dir = fixtureRepo();
		const result = runFixture(dir, {});
		// No fakes on PATH here, so it fails as soon as it hits a real ssh/rsync call against
		// 127.0.0.1 -- the point is that it gets PAST the guard, not that the sync itself succeeds.
		expect(result.stderr).not.toMatch(/expected main|working tree is dirty/);
	});
});
