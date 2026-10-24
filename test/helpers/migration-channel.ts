/**
 * Shared harness of the `test/migration-channel-*.test.ts` files (TRA-632).
 *
 * Each of those tests runs a REAL migration through the REAL deploy/sync-genre-cache.sh, on a small fixture:
 * ssh, rsync, curl and npx are local fakes (ssh runs the command on this machine, rsync strips the `host:`
 * prefix, curl answers `ok`, npx records its argv and then runs the real one), MusicBrainz is unreachable
 * unless the test brings its own fake server. This module holds what the files used to copy: the node fixture,
 * the fake binaries, the workspace layout, `runChannel` and the readers of the server tree. What a test proves
 * about its migration (the fixture content, the assertions) stays in the test file.
 *
 * Usage from a test file:
 *
 *   const fx = createChannelWorkspace("my-channel-");
 *   writeNode(fx.repoCacheDir, node("artist:flash", "Flash"));
 *   writeGenreTaxonomy(fx.repoDataDir);
 *   const out = await runChannel(fx, ["--migration", MIGRATION_NAME]);
 *   afterAll(removeTmpDirs);
 */
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../../src/node-spec.js";
import { parseSlug } from "../../src/slug.js";

export type Obj = Record<string, unknown>;

const script = resolve("deploy/sync-genre-cache.sh");
const realRsync = execFileSync("bash", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();
const realNpx = execFileSync("bash", ["-c", "command -v npx"], { encoding: "utf8" }).trim();

// --- Temp dirs ---

const dirs: string[] = [];

/** A fresh temp dir, removed by `removeTmpDirs` (call it from the file's `afterAll`). */
export function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

export function removeTmpDirs(): void {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

// --- Node fixtures ---

export const ref = (slug: string, name: string): Obj => ({ slug, type: parseSlug(slug).type, name });

/** A node that passes the schema: the prose field of its type, the lists empty, `fields` on top. */
export function node(slug: string, name: string, fields: Obj = {}): Obj {
	const type = parseSlug(slug).type;
	const prose: Record<NodeType, Obj> = {
		artist: { editorial_bio: "bio" },
		project: { editorial_pitch: "pitch" },
		track: { editorial_teaser: "teaser" },
		label: { editorial_description: "description" },
		genre: { editorial_definition: "definition" },
	};
	return {
		slug,
		name,
		type,
		editorial_article: "x".repeat(100),
		citations: [{ url: "https://example.com/a", title: "a" }],
		materialized_at: "2026-10-16T00:00:00.000Z",
		...prose[type],
		...Object.fromEntries(LIST_EDGES_BY_TYPE[type].map((f) => [f, []])),
		...fields,
	};
}

export function writeNode(cacheDir: string, n: Obj): void {
	const { type, body } = parseSlug(n.slug as string);
	const path = join(cacheDir, "nodes", type, `${body}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(n));
}

/**
 * The repo's data/genre-taxonomy.json. The union's taxonomy guard wants every genre node to be a source of a
 * published genre: `withSyncGenre` publishes `local:sync-fixture-genre` over `genre:only-repo`, so a repo that
 * holds that node passes; without it the taxonomy has no genre at all.
 */
export function writeGenreTaxonomy(repoDataDir: string, withSyncGenre = true): void {
	mkdirSync(repoDataDir, { recursive: true });
	writeFileSync(
		join(repoDataDir, "genre-taxonomy.json"),
		JSON.stringify({
			version: 2,
			families: [{ key: "electronic", label: "Electronic", order: 0 }],
			genres: withSyncGenre
				? [
						{
							id: "local:sync-fixture-genre",
							name: "Sync Fixture Genre",
							family: "electronic",
							published: true,
							sourceSlugs: ["genre:only-repo"],
						},
					]
				: [],
		}),
	);
}

// --- Fake binaries ---

export function writeFakeBin(dir: string, name: string, body: string): void {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(path, 0o755);
}

/**
 * ssh runs the command here; the systemctl calls of the channel move a marker file instead. rsync records its
 * arguments (one JSON line) and runs the real one with the `host:` prefix stripped. npx records its argv and the
 * slug flag it runs under, then runs the real one. Every record goes to $TEST_CALLS.
 */
function installFakeBins(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	writeFakeBin(
		binDir,
		"ssh",
		`host="$1"; shift
cmd="$*"
case "$cmd" in
  *"systemctl stop odyssey-server.service"*) rm -f "$TEST_SERVICE_MARKER" ;;
  *"systemctl start odyssey-server.service"*) touch "$TEST_SERVICE_MARKER" ;;
  *"systemctl is-active --quiet odyssey-server.service"*) [[ -f "$TEST_SERVICE_MARKER" ]] ;;
  *) bash -c "$cmd" ;;
esac`,
	);
	writeFakeBin(binDir, "curl", "echo ok");
	writeFakeBin(
		binDir,
		"rsync",
		`if [[ "$1" == "--server" ]]; then exec "$REAL_RSYNC" "$@"; fi
node -e 'require("fs").appendFileSync(process.env.TEST_CALLS, JSON.stringify({ tool: "rsync", argv: process.argv.slice(1), scoped: null }) + "\\n")' -- "$@"
args=()
for a in "$@"; do
  if [[ "$a" == *:* && "$a" != -* ]]; then args+=("\${a#*:}"); else args+=("$a"); fi
done
exec "$REAL_RSYNC" "\${args[@]}"`,
	);
	writeFakeBin(
		binDir,
		"npx",
		`node -e 'require("fs").appendFileSync(process.env.TEST_CALLS, JSON.stringify({ tool: "npx", argv: process.argv.slice(1), scoped: process.env.ODYSSEY_SCOPED_RELEASE_SLUGS ?? null }) + "\\n")' -- "$@"
exec "$REAL_NPX" "$@"`,
	);
}

// --- The workspace ---

export interface ChannelFixture {
	/** repo/cache: the committed cache the run starts from. A test writes its nodes here. */
	repoCacheDir: string;
	/** repo/data, next to it: the committed tables (taxonomy, redirects, ...). */
	repoDataDir: string;
	/** The fake prod server: `cache/`, `data/` and the `.service-active` marker live under it. */
	serverRoot: string;
	binDir: string;
	callsLog: string;
	/** Environment of every run of this fixture, on top of the harness's (a test's own knobs). */
	env: Record<string, string>;
}

/**
 * The empty layout of a run: repo/{cache,data}, server/data with its two empty redirect tables and the service
 * marker, the fake binaries. Everything else (the nodes, the pending-reverses files, the taxonomy) is the test's.
 */
export function createChannelWorkspace(
	prefix: string,
	{ serverSlugRedirects = {} }: { serverSlugRedirects?: Record<string, string> } = {},
): ChannelFixture {
	const root = tmp(prefix);
	const repoCacheDir = join(root, "repo", "cache");
	const repoDataDir = join(root, "repo", "data");
	const serverRoot = join(root, "server");
	const binDir = join(root, "bin");
	const callsLog = join(root, "calls.log");
	mkdirSync(repoCacheDir, { recursive: true });
	mkdirSync(repoDataDir, { recursive: true });
	mkdirSync(join(serverRoot, "data"), { recursive: true });
	writeFileSync(callsLog, "");
	writeFileSync(join(serverRoot, "data", "genre-redirects.json"), JSON.stringify({ redirects: {} }));
	writeFileSync(
		join(serverRoot, "data", "slug-redirects.json"),
		JSON.stringify({ redirects: serverSlugRedirects }),
	);
	writeFileSync(join(serverRoot, ".service-active"), "");
	installFakeBins(binDir);
	return { repoCacheDir, repoDataDir, serverRoot, binDir, callsLog, env: {} };
}

// --- Running the channel ---

export interface ToolCall {
	argv: string[];
	/** ODYSSEY_SCOPED_RELEASE_SLUGS as the tool saw it (npx only; null when unset). */
	scoped: string | null;
}

export interface ChannelOutcome {
	status: number | null;
	stdout: string;
	stderr: string;
	/** Every `npx` call, in order. */
	npxCalls: ToolCall[];
	/** The argv of each `npxCalls` entry. */
	npx: string[][];
	/** The arguments of every rsync the channel ran (the transfers with the server included). */
	rsyncs: string[][];
}

/**
 * Runs deploy/sync-genre-cache.sh on the fixture. `env` is added on top of `fx.env` for this run only. The
 * scoped-slug flag and the Gemini key are removed from the inherited environment first: the channel must set the
 * flag itself, and none of these migrations has an LLM -- a test that wants either passes it in `env`.
 */
export function runChannel(
	fx: ChannelFixture,
	args: string[],
	env: Record<string, string> = {},
): Promise<ChannelOutcome> {
	writeFileSync(fx.callsLog, "");
	const inherited: Record<string, string | undefined> = { ...process.env };
	delete inherited.ODYSSEY_SCOPED_RELEASE_SLUGS;
	delete inherited.GEMINI_API_KEY;
	const childEnv: Record<string, string | undefined> = {
		...inherited,
		PATH: `${fx.binDir}:${process.env.PATH ?? ""}`,
		SERVER: "test@fake-server",
		REPO_CACHE_DIR: fx.repoCacheDir,
		SERVER_CACHE_REMOTE: join(fx.serverRoot, "cache"),
		SERVER_REDIRECTS_REMOTE: join(fx.serverRoot, "data", "genre-redirects.json"),
		SERVER_SLUG_REDIRECTS_REMOTE: join(fx.serverRoot, "data", "slug-redirects.json"),
		SERVER_BACKUP_DIR: join(fx.serverRoot, "backups"),
		SERVER_CRAWL_LOCK: join(fx.serverRoot, ".crawl-lock"),
		REPO_SLUG_REDIRECTS_PATH: join(fx.serverRoot, "data", "slug-redirects.json"),
		TEST_SERVICE_MARKER: join(fx.serverRoot, ".service-active"),
		TEST_CALLS: fx.callsLog,
		REAL_RSYNC: realRsync,
		REAL_NPX: realNpx,
		SYNC_ALLOW_NON_MAIN: "1",
		SYNC_ALLOW_DIRTY: "1",
		// Belt and braces: even if a fixture reached MusicBrainz or ListenBrainz, nothing would leave the machine.
		MB_BASE_URL: "http://127.0.0.1:9/ws/2",
		MB_MIN_INTERVAL_MS: "0",
		LISTENBRAINZ_MIN_INTERVAL_MS: "0",
		...fx.env,
		...env,
	};
	return new Promise((done, fail) => {
		const child = spawn("bash", [script, ...args], { env: childEnv });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", fail);
		child.on("close", (status) => {
			const lines = (existsSync(fx.callsLog) ? readFileSync(fx.callsLog, "utf8") : "")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as { tool: string; argv: string[]; scoped: string | null });
			const npxCalls = lines.filter((l) => l.tool === "npx").map(({ argv, scoped }) => ({ argv, scoped }));
			done({
				status,
				stdout,
				stderr,
				npxCalls,
				npx: npxCalls.map((c) => c.argv),
				rsyncs: lines.filter((l) => l.tool === "rsync").map((l) => l.argv),
			});
		});
	});
}

/** The manifest block the channel prints for a migration (`==> Migration manifest: <name>`), "" when absent. */
export const manifestReader =
	(migrationName: string) =>
	(out: ChannelOutcome): string =>
		new RegExp(`==> Migration manifest: ${migrationName}\\n([\\s\\S]*?)\\n\\n`).exec(out.stdout)?.[1] ?? "";

// --- Reading the server ---

export const readServer = (fx: ChannelFixture, ...parts: string[]): Obj =>
	JSON.parse(readFileSync(join(fx.serverRoot, ...parts), "utf8")) as Obj;

/** Every file of the server's cache/ and data/, path -> bytes: what "nothing was written" is compared on. */
export function serverTree(fx: ChannelFixture): Record<string, string> {
	const tree: Record<string, string> = {};
	for (const sub of ["cache", "data"]) {
		const base = join(fx.serverRoot, sub);
		for (const rel of readdirSync(base, { recursive: true, encoding: "utf8" })) {
			if (statSync(join(base, rel)).isFile()) tree[`${sub}/${rel}`] = readFileSync(join(base, rel), "utf8");
		}
	}
	return tree;
}
