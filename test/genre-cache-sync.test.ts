import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
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
// commands the fakes don't special-case (test -f, mkdir -p, tar czf, cat) can just run for real
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
case "$cmd" in
  *"systemctl stop odyssey-server.service"*)
    if [[ "\${TEST_STOP_NOOP:-0}" != "1" ]]; then rm -f "$TEST_SERVICE_MARKER"; fi
    ;;
  *"systemctl start odyssey-server.service"*)
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

	// 2026-09-18 (review of TRA-67): the union runs the merge migration with --apply-merge, which
	// deletes the loser of a duplicate-QID group from its artifact and writes the merged redirects
	// table. The transfer ships only nodes/, never with --delete, so a duplicate already on the
	// server survives there and keeps being served while the validated union calls it merged away.
	// Nothing else catches it -- deletedCount sits outside countUnionProblems, so the union exits 0
	// and the run used to end on "Sync complete".
	it("refuses when the union merged duplicate nodes, before any server write", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			duplicateOnServer: true,
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/merged duplicate nodes/);
		// The refusal lands before the archive, the stop and the transfer: nothing on the server moved,
		// and the loser the union wanted gone is still there -- which is exactly why we refuse.
		expect(existsSync(serverBackupDir)).toBe(false);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
	});

	it("archives the server cache before any apply, verifies it with gzip -t, and prints the rollback archive path", () => {
		const { result, calls, serverBackupDir } = run({ apply: true });
		expect(result.status).toBe(0);
		expect(calls).toContain("tar czf");
		expect(calls).toContain("gzip -t");
		const archives = readdirSync(serverBackupDir);
		expect(archives).toHaveLength(1);
		expect(archives[0]).toMatch(/^genre-cache-.*\.tar\.gz$/);
		expect(result.stdout).toContain(
			`Rollback archive: test@fake-server:${join(serverBackupDir, archives[0]!)}`,
		);
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
		expect(calls).not.toContain("tar czf");
		expect(existsSync(serverBackupDir)).toBe(false);
	});

	it("refuses to write when the writer is still active after the stop attempt", () => {
		const { result, calls } = run({ apply: true, env: { TEST_STOP_NOOP: "1" } });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("still active after stop");
		// Archived (mandatory, happens before the stop) but never transferred.
		expect(calls).toContain("tar czf");
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
});
