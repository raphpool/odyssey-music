import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
 * looksLikeCacheDir guard accepts it. Carries an explicit `slug` field (2026-09-19, TRA-277):
 * runMigration's taxonomy-protection guard reads a node's survival from its own `slug` field,
 * not its filename, and `seedGenreTaxonomy` below needs this node to count as "surviving" so a
 * published source can safely point at it. */
function seedRepoCache(dir: string, slug = "only-repo"): void {
	mkdirSync(join(dir, "nodes", "genre"), { recursive: true });
	writeFileSync(
		join(dir, "nodes", "genre", `${slug}.json`),
		JSON.stringify({
			type: "genre",
			slug: `genre:${slug}`,
			name: slug,
			materialized_at: "2026-01-01T00:00:00.000Z",
		}),
	);
}

/** A minimal, valid, published genre taxonomy next to `repoCacheDir` (TRA-277): once
 * ONBOARDING_GENRES is retired from web/index.html (TRA-211), the union's own merge guard falls
 * through to this taxonomy-era protection instead -- see buildCacheUnion's own taxonomyPath
 * default, anchored to `dirname(repoCacheDir)/data/genre-taxonomy.json`, the same layout the real
 * repo checkout has. Its one entry only protects the repo-only seed node (always present, never
 * a duplicate-merge participant in these fixtures) -- runMigration's "every published source
 * must still resolve" check is a whole-cache invariant, so pointing it at anything these small
 * fixtures don't actually materialize would spuriously refuse every scenario. */
function seedGenreTaxonomy(repoCacheDir: string): void {
	const dataDir = join(dirname(repoCacheDir), "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "genre-taxonomy.json"),
		JSON.stringify({
			version: 2,
			families: [{ key: "electronic", label: "Electronic", order: 0 }],
			genres: [
				{
					id: "local:sync-fixture-genre",
					name: "Sync Fixture Genre",
					family: "electronic",
					published: true,
					sourceSlugs: ["genre:only-repo"],
				},
			],
		}),
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

/** seedDuplicateOnServer's merge elects genre:dancehall and creates a genre:dance-hall ->
 * genre:dancehall redirect. The durability guard (see deploy/sync-genre-cache.sh) compares the
 * union's FULL redirects table -- which always includes the real committed data/genre-redirects.json
 * as its base, regardless of this override -- against this fixture's keys, so the fixture must carry
 * the real committed table too (not just the new pair), or every one of its ~20 real entries would
 * spuriously show up as "not yet committed". Most `duplicateOnServer` scenarios need this passed as
 * `repoRedirects` to satisfy the guard and reach the behavior they actually mean to test --
 * otherwise every one of them would now hit that guard's own refusal first. The dedicated
 * durability tests below omit `repoRedirects` entirely instead (defaulting to the real committed
 * file, which genuinely lacks this synthetic pair) to exercise the "missing" case. */
const REAL_COMMITTED_REDIRECTS = JSON.parse(readFileSync(resolve("data/genre-redirects.json"), "utf8")) as {
	redirects: Record<string, string>;
};
const DANCE_HALL_ALREADY_COMMITTED = JSON.stringify({
	redirects: { ...REAL_COMMITTED_REDIRECTS.redirects, "genre:dance-hall": "genre:dancehall" },
});

/** Every redirect TARGET in the real, committed data/genre-redirects.json, materialized as a
 * minimal live genre node in the repo fixture (2026-09-19, TRA-277). Needed only once a real
 * duplicate group reaches runMigration's taxonomy-era protection (D6a): that check treats every
 * key of the real repo's own committed redirects table as still-protected (same rule as an
 * already-published taxonomy source, see runMigration's "protectedSlugs"), independently of
 * whatever this fixture's own scoped taxonomy publishes -- and that table is loaded from the
 * real repo unconditionally (sync-genre-cache.sh never overrides the union's source-side
 * redirectsPath, only --server-redirects-path; see buildCacheUnion). Without a live node for
 * every one of its targets, the protection would spuriously refuse on redirects this tiny fixture
 * never otherwise touches. Reads the real file dynamically, like the "diverges from the repo's
 * committed one" test below, so this stays correct as that table's content evolves. */
function seedRealGenreRedirectTargets(repoCacheDir: string): void {
	const committed = JSON.parse(readFileSync(resolve("data/genre-redirects.json"), "utf8")) as {
		redirects: Record<string, string>;
	};
	mkdirSync(join(repoCacheDir, "nodes", "genre"), { recursive: true });
	for (const target of new Set(Object.values(committed.redirects))) {
		const body = target.slice("genre:".length);
		const path = join(repoCacheDir, "nodes", "genre", `${body}.json`);
		if (existsSync(path)) continue; // never clobber a fixture node seeded for another reason
		writeFileSync(
			path,
			JSON.stringify({
				type: "genre",
				slug: target,
				name: body,
				materialized_at: "2026-01-01T00:00:00.000Z",
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
	/** Overrides REPO_REDIRECTS_PATH -- the repo's own committed genre-redirects.json content the
	 * "not yet committed" durability guard compares the union's table against. Omitted, the script
	 * defaults to the real repo file, which is what almost every scenario wants (no new keys). Set
	 * this to control whether a synthetic merge's redirect counts as "already committed". */
	repoRedirects?: string;
	// The server redirects table is seeded with a valid empty table by default so most scenarios
	// don't have to think about it; set this to skip seeding entirely (the missing-table test).
	omitRedirects?: boolean;
	crawlLock?: boolean;
	serviceActive?: boolean;
	/** Seed this many pre-existing backup archives (older mtimes), for the retention test. */
	preexistingBackups?: number;
	/** TRA-464: migrations to pass as `--migration <name>` (in key order), each backed by a fake
	 * script written to a temp MIGRATIONS_DIR -- see fakeMigration. */
	migrations?: Record<string, string>;
	/** Raw extra argv, for invalid-name scenarios that have no script behind them. */
	extraArgs?: string[];
	/** Content of the repo's committed data/slug-redirects.json (REPO_SLUG_REDIRECTS_PATH). */
	slugRedirects?: string;
	/** TRA-499: raw content of the repo's / the server's cache/pending-reverses.json (absent if omitted). */
	repoPending?: string;
	serverPending?: string;
	/** TRA-499: make the server's pending-reverses.json a symlink to a real file. */
	serverPendingSymlink?: boolean;
}

interface FakeMigrationSpec {
	/** Paths (relative to the union dir) the fake deletes. */
	remove?: string[];
	/** Paths (relative to the union dir) -> content the fake writes. */
	write?: Record<string, string>;
	/** Manifest body; `migration` defaults to the script's own name. `null` writes no manifest. */
	manifest?: Record<string, unknown> | null;
	exit?: number;
	/** Raw JS run after `remove`/`write` (TRA-499: for filesystem tricks the specs above cannot express). */
	extra?: string;
}

/** A stand-in for scripts/migrations/<name>.ts: plain node builtins only, so `npx tsx` can run it
 * from a temp dir. Records its argv (to TEST_CALLS.migration) so the tests can check the contract
 * `<union dir> --apply --manifest <path>`, applies `remove`/`write` to the union dir it is given,
 * then writes the manifest the channel is meant to read. */
function fakeMigration(name: string, spec: FakeMigrationSpec = {}): string {
	const manifest =
		spec.manifest === null
			? null
			: {
					migration: name,
					generated_at: "2026-10-15T00:00:00.000Z",
					renamed: {},
					removed: [],
					redirects: {},
					written: 0,
					...spec.manifest,
				};
	return `import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(process.env.TEST_CALLS + ".migration", JSON.stringify(argv) + "\\n");
const cacheDir = argv[0] as string;
// TRA-499: what the union handed this migration as its pending-reverses.json (before it changes anything).
const pendingPath = join(cacheDir, "pending-reverses.json");
if (existsSync(pendingPath)) appendFileSync(process.env.TEST_CALLS + ".pending-seen", readFileSync(pendingPath, "utf8") + "\\n");
for (const rel of ${JSON.stringify(spec.remove ?? [])} as string[]) rmSync(join(cacheDir, rel), { force: true });
for (const [rel, body] of Object.entries(${JSON.stringify(spec.write ?? {})} as Record<string, string>)) {
	mkdirSync(dirname(join(cacheDir, rel)), { recursive: true });
	writeFileSync(join(cacheDir, rel), body);
}
${spec.extra ?? ""}
const manifest = ${JSON.stringify(manifest)};
if (manifest) writeFileSync(argv[argv.indexOf("--manifest") + 1] as string, JSON.stringify(manifest, null, 2));
process.exit(${spec.exit ?? 0});
`;
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
	// A "cache" subdir of its own fresh root (2026-09-19, TRA-277), not the bare tmp dir itself:
	// gives repoCacheDir a sibling data/ to carry the genre-taxonomy.json fixture below, mirroring
	// the real repo's own cache/ + data/ layout (deploy/sync-genre-cache.sh's REPO_CACHE_DIR is
	// likewise "$REPO_ROOT/cache").
	const repoRoot = tmp("sync-repo-");
	const repoCacheDir = join(repoRoot, "cache");
	const callsLog = join(tmp("sync-calls-"), "calls.log");
	writeFileSync(callsLog, "");

	seedRepoCache(repoCacheDir);
	seedGenreTaxonomy(repoCacheDir);
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
	if (options.duplicateOnServer) {
		seedDuplicateOnServer(serverCacheRemote);
		seedRealGenreRedirectTargets(repoCacheDir);
	}
	if (options.repoPending !== undefined) {
		writeFileSync(join(repoCacheDir, "pending-reverses.json"), options.repoPending);
	}
	if (options.serverPending !== undefined) {
		writeFileSync(join(serverCacheRemote, "pending-reverses.json"), options.serverPending);
	}
	if (options.serverPendingSymlink) {
		const target = join(serverRoot, "pending-target.json");
		writeFileSync(target, "{}");
		symlinkSync(target, join(serverCacheRemote, "pending-reverses.json"));
	}
	if (options.crawlLock) writeFileSync(serverCrawlLock, "");
	if (options.serviceActive !== false) writeFileSync(serviceMarker, "");
	if (options.preexistingBackups) seedOldBackups(serverBackupDir, options.preexistingBackups);

	const migrationsDir = tmp("sync-migrations-");
	for (const [name, source] of Object.entries(options.migrations ?? {})) {
		writeFileSync(join(migrationsDir, `${name}.ts`), source);
	}
	const migrationFlags = Object.keys(options.migrations ?? {}).flatMap((name) => ["--migration", name]);
	const argv = [...(options.apply ? ["--apply"] : []), ...migrationFlags, ...(options.extraArgs ?? [])];
	// The server's pre-existing slug table: a marker so the archive/ship tests can tell old from new.
	const serverSlugRedirectsRemote = join(serverRoot, "data", "slug-redirects.json");
	mkdirSync(join(serverRoot, "data"), { recursive: true });
	writeFileSync(serverSlugRedirectsRemote, JSON.stringify({ redirects: {}, marker: "server-old" }));
	let slugRedirectsPath: string | undefined;
	if (options.slugRedirects !== undefined) {
		slugRedirectsPath = join(tmp("sync-repo-slug-redirects-"), "slug-redirects.json");
		writeFileSync(slugRedirectsPath, options.slugRedirects);
	}

	let repoRedirectsPath: string | undefined;
	if (options.repoRedirects !== undefined) {
		repoRedirectsPath = join(tmp("sync-repo-redirects-"), "genre-redirects.json");
		writeFileSync(repoRedirectsPath, options.repoRedirects);
	}

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

	const result = spawnSync("bash", [script, ...argv], {
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
			MIGRATIONS_DIR: migrationsDir,
			SERVER_SLUG_REDIRECTS_REMOTE: serverSlugRedirectsRemote,
			...(slugRedirectsPath ? { REPO_SLUG_REDIRECTS_PATH: slugRedirectsPath } : {}),
			...(repoRedirectsPath ? { REPO_REDIRECTS_PATH: repoRedirectsPath } : {}),
			...options.env,
		},
	});
	const calls = existsSync(callsLog) ? readFileSync(callsLog, "utf8") : "";
	const migrationLog = existsSync(`${callsLog}.migration`)
		? readFileSync(`${callsLog}.migration`, "utf8")
		: "";
	const pendingSeenLog = `${callsLog}.pending-seen`;
	return {
		result,
		calls,
		serverRoot,
		serverRedirectsRemote,
		pendingSeen: existsSync(pendingSeenLog) ? readFileSync(pendingSeenLog, "utf8") : "",
		serverCacheRemote,
		serverBackupDir,
		repoCacheDir,
		serverSlugRedirectsRemote,
		migrationLog,
	};
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
			repoRedirects: DANCE_HALL_ALREADY_COMMITTED,
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
			repoRedirects: DANCE_HALL_ALREADY_COMMITTED,
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
			repoRedirects: DANCE_HALL_ALREADY_COMMITTED,
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
			repoRedirects: DANCE_HALL_ALREADY_COMMITTED,
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

	// 2026-09-19 (TRA-276/B6c-2, CI review): deploy-server.sh:70-76 rsyncs the repo's own data/ onto
	// the server on EVERY app deploy (excludes cache/, not data/), so a redirect the union's table
	// carries but the repo hasn't committed yet would survive only until the next app deploy erases
	// it -- while the node it used to point at is already permanently `rm -f --`'d on this run.
	// Scenario (a): no repoRedirects override -- the REAL committed data/genre-redirects.json has no
	// entry for this synthetic merge (confirmed: it carries no dancehall/dance-hall pair at all), so
	// --apply must refuse before any server write, naming the pair.
	it("refuses --apply when the union created a redirect not yet committed in the repo's table, before any write", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			duplicateOnServer: true,
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/not yet committed/);
		expect(result.stderr).toContain("genre:dance-hall -> genre:dancehall");
		expect(result.stderr).toMatch(/next app deploy/);
		// Refused before the archive and the writer stop -- and well before the node deletion.
		expect(calls).not.toContain("tar cf");
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(serverBackupDir)).toBe(false);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
	});

	// Scenario (b): the exact same "repo table doesn't have it yet" case, but in preview -- must
	// only warn (stderr), never refuse, and never write.
	it("preview warns (without refusing) when the union created a redirect not yet committed in the repo's table", () => {
		const { result, calls, serverCacheRemote } = run({
			duplicateOnServer: true,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Preview only");
		expect(result.stderr).toMatch(/not yet committed/);
		expect(result.stderr).toContain("genre:dance-hall -> genre:dancehall");
		expect(calls).not.toMatch(/rm -f --/);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "dance-hall.json"))).toBe(true);
	});

	// Ticket note: a deletion failure must be handled exactly like any other post-transfer failure --
	// restart the writer, point at the archive. TEST_SSH_FAIL_MATCH is scoped to the loser's own
	// path (not the bare "rm -f --" substring, which the unrelated backup-retention prune also
	// uses), so only this deletion call fails and the file it targets was never actually touched.
	it("on a deletion failure, restarts the writer and points at the archive like other post-transfer failures", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			duplicateOnServer: true,
			repoRedirects: DANCE_HALL_ALREADY_COMMITTED,
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

// TRA-464: the migration channel. The migrations here are fakes (fakeMigration above) -- the real
// ones are other tickets; what is under test is the contract this script enforces around them.
describe("sync-genre-cache.sh -- migration channel (TRA-464)", () => {
	const NAME = "2026-10-15-fake-rename";
	// The fixture's server cache holds genre:only-server: the fake renames it, so the old file must
	// leave the server (explicit rm) and the new one arrive (rsync of the union).
	// A node that passes the real nodePayloadSchema: the channel re-validates what a migration wrote.
	const genreNode = (body: string, slug = `genre:${body}`) =>
		JSON.stringify({
			type: "genre",
			slug,
			name: body,
			editorial_article: "x".repeat(80),
			citations: [{ url: "https://example.com/x" }],
			editorial_definition: "x",
			parent_genres: [],
			subgenres: [],
			related_genres: [],
			key_artists: [],
			key_labels: [],
			landmark_projects: [],
			landmark_tracks: [],
			materialized_at: "2026-01-01T00:00:00.000Z",
		});
	const RENAME = {
		remove: ["nodes/genre/only-server.json"],
		write: { "nodes/genre/renamed-server.json": genreNode("renamed-server") },
		manifest: {
			renamed: { "genre:only-server": "genre:renamed-server" },
			redirects: { "genre:only-server": "genre:renamed-server" },
			written: 1,
		},
	};
	const PAIR = { "genre:only-server": "genre:renamed-server" };
	const COMMITTED_IN_SLUG_TABLE = JSON.stringify({ redirects: PAIR });

	it("previews: builds the union, runs the migration on it, prints its manifest, touches nothing", () => {
		const { result, calls, serverBackupDir, serverCacheRemote, migrationLog, serverSlugRedirectsRemote } =
			run({
				migrations: { [NAME]: fakeMigration(NAME, RENAME) },
			});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`Running migration ${NAME} on the union`);
		expect(result.stdout).toContain(`"migration": "${NAME}"`);
		expect(result.stdout).toContain("Preview only");
		// Contract: <union dir> --apply --manifest <path>, where the dir is the union, not the repo.
		const argv = JSON.parse(migrationLog.trim()) as string[];
		const unionDir = /Union written to (\S+) /.exec(result.stdout)?.[1];
		expect(argv[0]).toBe(unionDir);
		expect(argv.slice(1, 3)).toEqual(["--apply", "--manifest"]);
		expect(argv[3]).toMatch(new RegExp(`${NAME}\\.manifest\\.json$`));
		// B1: redirect tables are handed over as a scratch --data-dir, not left to default to the repo's.
		expect(argv[4]).toBe("--data-dir");
		expect(argv[5]).not.toContain(process.cwd());
		// No server write at all: not the stop, not the archive, not the node or the tables.
		expect(calls).not.toContain("systemctl stop");
		expect(calls).not.toMatch(/rm -f --/);
		expect(existsSync(serverBackupDir)).toBe(false);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "renamed-server.json"))).toBe(false);
		expect(readFileSync(serverSlugRedirectsRemote, "utf8")).toContain("server-old");
	});

	it("applies: removes the migrated-away file explicitly, ships the new one and the committed slug table, archives the old table", () => {
		const { result, calls, serverCacheRemote, serverBackupDir, serverSlugRedirectsRemote } = run({
			apply: true,
			slugRedirects: COMMITTED_IN_SLUG_TABLE,
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(false);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "renamed-server.json"))).toBe(true);
		// One explicit rm -f -- for the old path, never a --delete.
		expect(calls).toContain(`rm -f -- '${serverCacheRemote}/nodes/genre/only-server.json'`);
		expect(calls).not.toContain("--delete");
		expect(readFileSync(serverSlugRedirectsRemote, "utf8")).toBe(COMMITTED_IN_SLUG_TABLE);
		// Rollback = the archive: it holds the server's slug table as it was before this run.
		const archive = join(serverBackupDir, readdirSync(serverBackupDir).find((f) => f.endsWith(".tar.gz"))!);
		const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
		expect(listing).toContain("data/slug-redirects.json");
		const oldTable = execFileSync("tar", ["-xzOf", archive, "data/slug-redirects.json"], {
			encoding: "utf8",
		});
		expect(oldTable).toContain("server-old");
	});

	it("does not ship the slug table, nor touch the archive for it, on a plain sync without --migration", () => {
		const { result, calls, serverSlugRedirectsRemote } = run({ apply: true });
		expect(result.status).toBe(0);
		expect(calls).not.toContain("slug-redirects");
		expect(readFileSync(serverSlugRedirectsRemote, "utf8")).toContain("server-old");
	});

	it("accepts a redirect already committed in data/genre-redirects.json instead", () => {
		const { result } = run({
			apply: true,
			slugRedirects: JSON.stringify({ redirects: {} }),
			repoRedirects: JSON.stringify({ redirects: { ...REAL_COMMITTED_REDIRECTS.redirects, ...PAIR } }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
	});

	it("refuses --apply when a manifest redirect is in neither committed table, before the archive and the stop", () => {
		const { result, calls, serverBackupDir, serverCacheRemote } = run({
			apply: true,
			slugRedirects: JSON.stringify({ redirects: {} }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/not yet committed/);
		expect(result.stderr).toContain("genre:only-server -> genre:renamed-server");
		expect(result.stderr).toContain(NAME);
		expect(calls).not.toContain("systemctl stop");
		expect(calls).not.toContain("tar cf");
		expect(existsSync(serverBackupDir)).toBe(false);
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
	});

	it("refuses --apply when the committed table maps the same key to a different target", () => {
		const { result, calls } = run({
			apply: true,
			slugRedirects: JSON.stringify({ redirects: { "genre:only-server": "genre:somewhere-else" } }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/not yet committed/);
		expect(calls).not.toContain("systemctl stop");
	});

	it("only warns about an uncommitted redirect in preview", () => {
		const { result } = run({
			slugRedirects: JSON.stringify({ redirects: {} }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toMatch(/not yet committed/);
	});

	it.each([
		["a path outside nodes/", "data/slug-redirects.json"],
		["a path escaping nodes/", "nodes/../../etc/passwd.json"],
		["a nested path", "nodes/genre/a/b.json"],
		["an unknown node type", "nodes/secret/x.json"],
		["a body outside the slug charset", "nodes/genre/x'; reboot; echo '.json"],
		["a non-json file", "nodes/genre/x.txt"],
	])(
		"refuses a removed[] entry that is %s, in preview as well as --apply, before any write",
		(_label, bad) => {
			for (const apply of [false, true]) {
				const { result, calls } = run({
					apply,
					slugRedirects: COMMITTED_IN_SLUG_TABLE,
					migrations: { [NAME]: fakeMigration(NAME, { manifest: { removed: [bad] } }) },
				});
				expect(result.status).not.toBe(0);
				expect(result.stderr).toMatch(/invalid manifest/);
				expect(calls).not.toContain("systemctl stop");
				expect(calls).not.toMatch(/rm -f --/);
			}
		},
	);

	it("refuses a renamed{} entry that is not a pair of distinct valid slugs", () => {
		for (const renamed of [
			{ "genre:a": "genre:a" },
			{ "not-a-slug": "genre:b" },
			{ "genre:../x": "genre:b" },
		]) {
			const { result } = run({ migrations: { [NAME]: fakeMigration(NAME, { manifest: { renamed } }) } });
			expect(result.status).not.toBe(0);
			expect(result.stderr).toMatch(/invalid manifest/);
		}
	});

	it("refuses a node declared removed that is still in the union (rsync would ship it, then rm it)", () => {
		const { result, calls } = run({
			apply: true,
			migrations: { [NAME]: fakeMigration(NAME, { manifest: { removed: ["nodes/genre/only-repo.json"] } }) },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/in the final union/);
		expect(calls).not.toContain("systemctl stop");
	});

	it("refuses a failing migration, a missing manifest, and a manifest naming another migration", () => {
		const failing = run({ migrations: { [NAME]: fakeMigration(NAME, { exit: 3 }) } });
		expect(failing.result.status).not.toBe(0);
		expect(failing.result.stderr).toMatch(/failed \(exit 3\)/);

		const noManifest = run({ migrations: { [NAME]: fakeMigration(NAME, { manifest: null }) } });
		expect(noManifest.result.status).not.toBe(0);
		expect(noManifest.result.stderr).toMatch(/wrote no manifest/);

		const wrongName = run({
			migrations: { [NAME]: fakeMigration(NAME, { manifest: { migration: "other" } }) },
		});
		expect(wrongName.result.status).not.toBe(0);
		expect(wrongName.result.stderr).toMatch(/invalid manifest/);
	});

	it("runs several migrations in the order given, on the same union", () => {
		const first = "2026-10-15-first";
		const second = "2026-10-16-second";
		const { result, migrationLog } = run({
			migrations: { [first]: fakeMigration(first), [second]: fakeMigration(second) },
		});
		expect(result.status).toBe(0);
		const [a, b] = migrationLog
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as string[]);
		expect(a?.[0]).toBe(b?.[0]);
		expect(a?.[3]).toContain(first);
		expect(b?.[3]).toContain(second);
	});

	it.each([
		["a path separator", ["--migration", "../2026-10-15-x"]],
		["shell metacharacters", ["--migration", "2026-10-15-x;reboot"]],
		["no date prefix", ["--migration", "unescape"]],
		["an empty name", ["--migration", ""]],
		["no value at all", ["--migration"]],
	])("rejects a migration name with %s before touching the server", (_label, extraArgs) => {
		const { result, calls } = run({ extraArgs });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/--migration|invalid migration name/);
		expect(calls).toBe("");
	});

	// ---- Deep review of PR #413 (BLOCK): scenarios reproduced by the reviewer, now regressions ----

	const NEW_NODE = genreNode("renamed-server");

	/** A rename migration written like the existing models: it renames the node in the union AND
	 * writes its redirect to `tablePathExpr` (a JS expression), the way the models default to the
	 * repo's own data/. `afterWrite` is extra code run once the table is written. */
	function tableWritingMigration(name: string, tablePathExpr: string, afterWrite = ""): string {
		return `import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const cacheDir = argv[0] as string;
rmSync(join(cacheDir, "nodes/genre/only-server.json"), { force: true });
writeFileSync(join(cacheDir, "nodes/genre/renamed-server.json"), ${JSON.stringify(NEW_NODE)});
const tablePath = ${tablePathExpr};
const table = JSON.parse(readFileSync(tablePath, "utf8"));
table.redirects["genre:only-server"] = "genre:renamed-server";
writeFileSync(tablePath, JSON.stringify(table));
${afterWrite}
writeFileSync(argv[argv.indexOf("--manifest") + 1] as string, JSON.stringify({ migration: "${name}", generated_at: "x", renamed: ${JSON.stringify(PAIR)}, removed: [], redirects: ${JSON.stringify(PAIR)}, written: 1 }));
`;
	}

	it("B1: a migration writing its redirect into the repo's committed table is refused, not read back as committed", () => {
		for (const apply of [true, false]) {
			const { result, calls, serverBackupDir, serverCacheRemote, serverSlugRedirectsRemote } = run({
				apply,
				// The committed table LACKS the pair; the migration adds it to the live repo file.
				slugRedirects: JSON.stringify({ redirects: {} }),
				migrations: { [NAME]: tableWritingMigration(NAME, "process.env.REPO_SLUG_REDIRECTS_PATH as string") },
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toMatch(/modified the repo's committed redirects table/);
			expect(calls).not.toContain("systemctl stop");
			expect(existsSync(serverBackupDir)).toBe(false);
			expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
			expect(readFileSync(serverSlugRedirectsRemote, "utf8")).toContain("server-old");
		}
	});

	it("B1: a migration that follows the contract (writes its table to --data-dir) still cannot ship an uncommitted redirect", () => {
		const { result, calls } = run({
			apply: true,
			slugRedirects: JSON.stringify({ redirects: {} }),
			migrations: {
				[NAME]: tableWritingMigration(
					NAME,
					'join(argv[argv.indexOf("--data-dir") + 1] as string, "slug-redirects.json")',
				),
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/not yet committed/);
		expect(calls).not.toContain("systemctl stop");
	});

	it("B1: a migration that changes anything under the repo's cache/ is refused (git state compared before/after)", () => {
		// The script runs against this checkout, so the probe is a real untracked file, always removed.
		const probe = join(process.cwd(), "cache", "tra464-guard-probe.json");
		try {
			const { result, calls } = run({
				slugRedirects: COMMITTED_IN_SLUG_TABLE,
				migrations: {
					[NAME]: fakeMigration(NAME, { manifest: {} }).replace(
						"process.exit(",
						`writeFileSync(${JSON.stringify(probe)}, "{}");\nprocess.exit(`,
					),
				},
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toMatch(/changed the repo's cache\/ or data\//);
			expect(calls).not.toContain("systemctl stop");
		} finally {
			rmSync(probe, { force: true });
		}
	});

	it("N2: a later migration recreating a path an earlier one removed is refused (shipped, then rm'd otherwise)", () => {
		const first = "2026-10-15-a-rename";
		const second = "2026-10-16-b-recreate";
		const { result, calls, serverCacheRemote } = run({
			apply: true,
			slugRedirects: COMMITTED_IN_SLUG_TABLE,
			migrations: {
				[first]: fakeMigration(first, { ...RENAME, manifest: { ...RENAME.manifest } }),
				[second]: fakeMigration(second, {
					write: { "nodes/genre/only-server.json": genreNode("only-server") },
					manifest: { written: 1 },
				}),
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/in the final union/);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
	});

	it("N2: a renamed target that no migration wrote is refused as dangling, before the old node is deleted", () => {
		const { result, calls, serverCacheRemote } = run({
			apply: true,
			slugRedirects: COMMITTED_IN_SLUG_TABLE,
			migrations: {
				[NAME]: fakeMigration(NAME, { remove: RENAME.remove, manifest: RENAME.manifest }),
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/genre:renamed-server.*dangling/);
		expect(calls).not.toContain("systemctl stop");
		expect(existsSync(join(serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
	});

	it("N2: a node a migration wrote that fails the node schema, or sits under the wrong path, is refused", () => {
		for (const [file, body] of [
			["only-repo", JSON.stringify({ type: "genre", slug: "genre:only-repo", name: 42 })],
			["misplaced", genreNode("misplaced", "genre:elsewhere")],
		] as const) {
			const { result, calls, serverCacheRemote } = run({
				apply: true,
				slugRedirects: COMMITTED_IN_SLUG_TABLE,
				migrations: {
					[NAME]: fakeMigration(NAME, {
						write: { [`nodes/genre/${file}.json`]: body },
						manifest: { written: 1 },
					}),
				},
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(`nodes/genre/${file}.json`);
			expect(calls).not.toContain("systemctl stop");
			expect(existsSync(join(serverCacheRemote, "nodes", "genre", `${file}.json`))).toBe(false);
		}
	});

	it("N3: a renamed pair needs its committed redirect even when the manifest lists no redirects", () => {
		const { result, calls } = run({
			apply: true,
			slugRedirects: JSON.stringify({ redirects: {} }),
			migrations: {
				[NAME]: fakeMigration(NAME, { ...RENAME, manifest: { renamed: PAIR, redirects: {}, written: 1 } }),
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/not yet committed/);
		expect(result.stderr).toContain("genre:only-server -> genre:renamed-server");
		expect(calls).not.toContain("systemctl stop");
	});

	it("N4: a migration run's rollback instructions say to empty cache/ first, on success and on a post-transfer failure", () => {
		const ok = run({
			apply: true,
			slugRedirects: COMMITTED_IN_SLUG_TABLE,
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(ok.result.status).toBe(0);
		expect(ok.result.stdout).toMatch(
			/Rollback archive: .*remove the server's whole cache\/ tree, then extract the archive/,
		);

		const failed = run({
			apply: true,
			slugRedirects: COMMITTED_IN_SLUG_TABLE,
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
			env: { TEST_RSYNC_FAIL_ON_CALL: "2" },
		});
		expect(failed.result.status).not.toBe(0);
		expect(failed.result.stderr).toMatch(/Restore from the archive.*remove the server's whole cache\/ tree/);
		// A plain sync keeps the original wording.
		const plain = run({ apply: true });
		expect(plain.result.stdout).not.toContain("migration run");
	});

	it("rejects an unknown migration script and a duplicated name before touching the server", () => {
		const unknown = run({ extraArgs: ["--migration", "2026-10-15-does-not-exist"] });
		expect(unknown.result.status).not.toBe(0);
		expect(unknown.result.stderr).toMatch(/migration script not found/);
		expect(unknown.calls).toBe("");

		const dup = run({
			migrations: { [NAME]: fakeMigration(NAME) },
			extraArgs: ["--migration", NAME],
		});
		expect(dup.result.status).not.toBe(0);
		expect(dup.result.stderr).toMatch(/given twice/);
		expect(dup.calls).toBe("");
	});
});

// TRA-499: pending-reverses.json is unioned, rewritten by migrations and shipped; genre-redirects.json
// is shipped from the committed copy; nothing else may change at the union root during the loop.
describe("sync-genre-cache.sh -- pending-reverses and union-root guard (TRA-499)", () => {
	const NAME = "2026-10-15-fake-rename";
	const genreNode = (body: string) =>
		JSON.stringify({
			type: "genre",
			slug: `genre:${body}`,
			name: body,
			editorial_article: "x".repeat(80),
			citations: [{ url: "https://example.com/x" }],
			editorial_definition: "x",
			parent_genres: [],
			subgenres: [],
			related_genres: [],
			key_artists: [],
			key_labels: [],
			landmark_projects: [],
			landmark_tracks: [],
			materialized_at: "2026-01-01T00:00:00.000Z",
		});
	const RENAME = {
		remove: ["nodes/genre/only-server.json"],
		write: { "nodes/genre/renamed-server.json": genreNode("renamed-server") },
		manifest: {
			renamed: { "genre:only-server": "genre:renamed-server" },
			redirects: { "genre:only-server": "genre:renamed-server" },
			written: 1,
		},
	};
	const SLUG_TABLE = JSON.stringify({ redirects: { "genre:only-server": "genre:renamed-server" } });
	const reverse = (slug: string, field = "members") => ({
		field,
		cardinality: "list",
		edge: { slug, type: slug.split(":")[0], name: slug },
	});
	const [E1, E2, E3] = [reverse("artist:e1"), reverse("artist:e2"), reverse("artist:e3")];
	// A reverse valid on a genre node (genre.subgenres takes genre edges): the file's keys may be genres.
	const G1 = {
		field: "subgenres",
		cardinality: "list",
		edge: { slug: "genre:sub", type: "genre", name: "sub" },
	};
	const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

	/** The refusal contract of TRA-464: stderr says why, and nothing happened to the server. */
	function expectRefusedBeforeAnyWrite(r: ReturnType<typeof run>, message: RegExp): void {
		expect(r.result.status).not.toBe(0);
		expect(r.result.stderr).toMatch(message);
		expect(r.calls).not.toContain("systemctl stop");
		expect(existsSync(r.serverBackupDir)).toBe(false);
		expect(existsSync(join(r.serverCacheRemote, "nodes", "genre", "only-server.json"))).toBe(true);
	}

	it("ships the union of the two files: repo {A:[e1]} + server {A:[e2], B:[e3]} -> {A:[e1,e2], B:[e3]}", () => {
		const { result, serverCacheRemote } = run({
			apply: true,
			slugRedirects: SLUG_TABLE,
			repoPending: JSON.stringify({ "artist:a": [E1] }),
			serverPending: JSON.stringify({ "artist:a": [E2], "artist:b": [E3] }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
		expect(readJson(join(serverCacheRemote, "pending-reverses.json"))).toEqual({
			"artist:a": [E1, E2],
			"artist:b": [E3],
		});
		expect(result.stdout).toContain("Shipping the migrated pending-reverses.json");
	});

	it("hands the migration a union that already carries the merged file", () => {
		const { result, pendingSeen } = run({
			slugRedirects: SLUG_TABLE,
			repoPending: JSON.stringify({ "artist:a": [E1] }),
			serverPending: JSON.stringify({ "artist:b": [E3] }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
		expect(JSON.parse(pendingSeen)).toEqual({ "artist:a": [E1], "artist:b": [E3] });
	});

	it("ships the file the migration REWROTE (key renamed), never the old one", () => {
		const rewritten = { "genre:renamed-server": [G1] };
		const { result, serverCacheRemote } = run({
			apply: true,
			slugRedirects: SLUG_TABLE,
			repoPending: JSON.stringify({ "genre:only-server": [G1] }),
			serverPending: JSON.stringify({ "genre:only-server": [G1] }),
			migrations: {
				[NAME]: fakeMigration(NAME, {
					...RENAME,
					write: { ...RENAME.write, "pending-reverses.json": JSON.stringify(rewritten) },
				}),
			},
		});
		expect(result.status).toBe(0);
		const shipped = readJson(join(serverCacheRemote, "pending-reverses.json")) as Record<string, unknown>;
		expect(shipped).toEqual(rewritten);
		expect(shipped).not.toHaveProperty(["genre:only-server"]);
	});

	it("archives the server's pre-write pending-reverses.json (inside the cache tree) for rollback", () => {
		const before = JSON.stringify({ "artist:b": [E3] });
		const { result, serverBackupDir } = run({
			apply: true,
			slugRedirects: SLUG_TABLE,
			serverPending: before,
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
		const archive = join(serverBackupDir, readdirSync(serverBackupDir).find((f) => f.endsWith(".tar.gz"))!);
		expect(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })).toContain(
			"cache/pending-reverses.json",
		);
		expect(execFileSync("tar", ["-xzOf", archive, "cache/pending-reverses.json"], { encoding: "utf8" })).toBe(
			before,
		);
	});

	it("previews without shipping it", () => {
		const { result, serverCacheRemote, calls } = run({
			slugRedirects: SLUG_TABLE,
			repoPending: JSON.stringify({ "artist:a": [E1] }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
		expect(existsSync(join(serverCacheRemote, "pending-reverses.json"))).toBe(false);
		expect(calls).not.toContain("pending-reverses");
	});

	it("leaves a plain genre sync (no --migration) unchanged: file neither read, unioned nor shipped", () => {
		const serverPending = JSON.stringify({ "artist:b": [E3] });
		const { result, serverCacheRemote, calls } = run({
			apply: true,
			// Malformed on purpose: a plain sync must not even look at it.
			repoPending: "{not json",
			serverPending,
		});
		expect(result.status).toBe(0);
		expect(readFileSync(join(serverCacheRemote, "pending-reverses.json"), "utf8")).toBe(serverPending);
		expect(calls).not.toMatch(/rsync .*pending-reverses/);
		expect(result.stdout).not.toContain("pending-reverses");
	});

	it("refuses a malformed pending-reverses.json on either side before the archive and the stop", () => {
		for (const side of ["repoPending", "serverPending"] as const) {
			const r = run({
				apply: true,
				slugRedirects: SLUG_TABLE,
				[side]: JSON.stringify({ "not a slug": [] }),
				migrations: { [NAME]: fakeMigration(NAME, RENAME) },
			});
			expectRefusedBeforeAnyWrite(r, /pending-reverses.*not a valid slug/);
		}
	});

	it("refuses a migration that leaves pending-reverses.json malformed, deleted or replaced by a symlink", () => {
		const specs: FakeMigrationSpec[] = [
			{ ...RENAME, write: { ...RENAME.write, "pending-reverses.json": '{"x": 1}' } },
			{ ...RENAME, remove: [...RENAME.remove, "pending-reverses.json"] },
			{
				...RENAME,
				extra:
					'rmSync(join(cacheDir, "pending-reverses.json"));\nsymlinkSync("/etc/hosts", join(cacheDir, "pending-reverses.json"));',
			},
		];
		for (const spec of specs) {
			const r = run({
				apply: true,
				slugRedirects: SLUG_TABLE,
				repoPending: JSON.stringify({ "artist:a": [E1] }),
				migrations: { [NAME]: fakeMigration(NAME, spec) },
			});
			expectRefusedBeforeAnyWrite(r, /pending-reverses\.json/);
		}
	});

	it("refuses a symlinked pending-reverses.json on the server before the archive and the stop", () => {
		const r = run({
			apply: true,
			slugRedirects: SLUG_TABLE,
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
			serverPendingSymlink: true,
		});
		expectRefusedBeforeAnyWrite(r, /pending-reverses.*not a regular file/);
	});

	it("P2: refuses a rename X->Y that left pending-reverses.json untouched (key on a deleted node)", () => {
		const r = run({
			apply: true,
			slugRedirects: SLUG_TABLE,
			repoPending: JSON.stringify({ "genre:only-server": [G1] }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expectRefusedBeforeAnyWrite(
			r,
			/pending-reverses\.json: key genre:only-server: names a node the migrations deleted/,
		);
	});

	it("P2: refuses an edge.slug pointing to a node the migration deleted", () => {
		const toDeleted = { ...G1, edge: { slug: "genre:only-server", type: "genre", name: "only-server" } };
		const r = run({
			apply: true,
			slugRedirects: SLUG_TABLE,
			repoPending: JSON.stringify({ "genre:other": [toDeleted] }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expectRefusedBeforeAnyWrite(r, /edge\.slug genre:only-server is a node the migrations deleted/);
	});

	it("refuses an edge that fails the target node's edge schema (it would make the node unwritable in prod)", () => {
		const invalid = { field: "subgenres", cardinality: "list", edge: { slug: "genre:sub", type: "genre" } };
		for (const apply of [true, false]) {
			const r = run({
				apply,
				slugRedirects: SLUG_TABLE,
				repoPending: JSON.stringify({ "genre:other": [invalid] }),
				migrations: { [NAME]: fakeMigration(NAME, RENAME) },
			});
			expectRefusedBeforeAnyWrite(r, /genre\.subgenres edge schema/);
		}
	});

	it("P5: prints key and entry counts before and after the migrations, in preview and apply, and warns on a drop", () => {
		for (const apply of [false, true]) {
			const r = run({
				apply,
				slugRedirects: SLUG_TABLE,
				repoPending: JSON.stringify({ "artist:a": [E1, E2] }),
				serverPending: JSON.stringify({ "artist:b": [E3] }),
				migrations: {
					[NAME]: fakeMigration(NAME, {
						...RENAME,
						write: { ...RENAME.write, "pending-reverses.json": "{}" },
					}),
				},
			});
			expect(r.result.status).toBe(0);
			expect(r.result.stdout).toContain("pending-reverses.json before the migrations: 2 key(s), 3 entries");
			expect(r.result.stdout).toContain("pending-reverses.json after the migrations: 0 key(s), 0 entries");
			expect(r.result.stdout).toContain(
				'"beforeMigrations":{"keys":2,"entries":3},"afterMigrations":{"keys":0,"entries":0}',
			);
			expect(r.result.stderr).toMatch(
				/WARNING: the migrations shrank pending-reverses\.json \(2 -> 0 keys, 3 -> 0 entries\)/,
			);
		}
	});

	it("P5: no warning when the migrations leave the counts as they were", () => {
		const r = run({
			slugRedirects: SLUG_TABLE,
			repoPending: JSON.stringify({ "artist:a": [E1] }),
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(r.result.stdout).toContain("after the migrations: 1 key(s), 1 entries");
		expect(r.result.stderr).not.toContain("shrank");
	});

	it("ships the committed genre-redirects.json byte for byte, not the union's rewritten copy", () => {
		const committed = JSON.stringify(REAL_COMMITTED_REDIRECTS); // compact: the union rewrites it pretty-printed
		const { result, serverRedirectsRemote } = run({
			apply: true,
			slugRedirects: SLUG_TABLE,
			repoRedirects: committed,
			migrations: { [NAME]: fakeMigration(NAME, RENAME) },
		});
		expect(result.status).toBe(0);
		expect(readFileSync(serverRedirectsRemote, "utf8")).toBe(committed);
	});

	it("refuses a migration that writes genre-redirects.json at the root of its cache dir, before the stop (preview too)", () => {
		const forged = JSON.stringify({ redirects: { "genre:only-server": "genre:evil" } });
		for (const apply of [true, false]) {
			const r = run({
				apply,
				slugRedirects: SLUG_TABLE,
				migrations: {
					[NAME]: fakeMigration(NAME, {
						...RENAME,
						write: { ...RENAME.write, "genre-redirects.json": forged },
					}),
				},
			});
			expectRefusedBeforeAnyWrite(r, /changed the union's root/);
			expect(r.calls).not.toMatch(/rsync .*genre-redirects/);
		}
	});

	it("refuses any other file added or changed at the union root, including under archive/", () => {
		for (const rel of ["stray.json", "archive/stray.json", "manifest.json"]) {
			const r = run({
				apply: true,
				slugRedirects: SLUG_TABLE,
				migrations: { [NAME]: fakeMigration(NAME, { ...RENAME, write: { ...RENAME.write, [rel]: "{}" } }) },
			});
			expectRefusedBeforeAnyWrite(r, /changed the union's root/);
		}
	});

	it("still lets a migration write nodes/ and a well-formed pending-reverses.json (the two allowed outputs)", () => {
		const { result } = run({
			slugRedirects: SLUG_TABLE,
			migrations: {
				[NAME]: fakeMigration(NAME, {
					...RENAME,
					write: { ...RENAME.write, "pending-reverses.json": JSON.stringify({ "artist:a": [E1] }) },
				}),
			},
		});
		expect(result.status).toBe(0);
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
