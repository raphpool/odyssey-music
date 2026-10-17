import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-17-backfill-reverse-edges.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";

// TRA-488: the REAL reverse-edge backfill through the real deploy/sync-genre-cache.sh, in preview, on a small
// fixture (the pattern of migration-channel-images.test.ts: ssh and rsync are local fakes, no network at all).
// What it proves is the CHANNEL contract: the script accepts the flags the channel passes (--data-dir used to
// make it exit 2), its manifest passes the channel's validation, the pending-reverses.json it rewrites passes
// the union check without a duplicate, and the manifest is the same on every run.

const script = resolve("deploy/sync-genre-cache.sh");
const realRsync = execFileSync("bash", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();
const realNpx = execFileSync("bash", ["-c", "command -v npx"], { encoding: "utf8" }).trim();

const dirs: string[] = [];
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;

// Held by the repo AND by the server: the union must keep one copy, and the migration must not queue it again.
const PENDING_HYPERDUB = {
	"label:hyperdub": [
		{ field: "roster", cardinality: "list", edge: { slug: "artist:burial", type: "artist", name: "Burial" } },
	],
};

function node(slug: string, name: string, fields: Obj = {}): Obj {
	const type = parseSlug(slug).type;
	const prose: Record<NodeType, Obj> = {
		artist: { editorial_bio: "bio" },
		project: { editorial_pitch: "pitch" },
		track: { editorial_teaser: "teaser" },
		label: { editorial_description: "description" },
		genre: { editorial_definition: "definition", editorial_description: "description" },
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

function ref(slug: string, name: string): Obj {
	return { slug, type: parseSlug(slug).type, name };
}

function writeNode(cacheDir: string, n: Obj): void {
	const { type, body } = parseSlug(n.slug as string);
	const path = join(cacheDir, "nodes", type, `${body}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(n));
}

function writeFakeBin(dir: string, name: string, body: string): void {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(path, 0o755);
}

interface Fixture {
	repoCacheDir: string;
	serverRoot: string;
	binDir: string;
	callsLog: string;
}

function makeFixture(): Fixture {
	const root = tmp("reverse-edges-channel-");
	const repoCacheDir = join(root, "repo", "cache");
	const serverRoot = join(root, "server");
	const binDir = join(root, "bin");
	const callsLog = join(root, "npx-calls.log");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(callsLog, "");

	// Aphex Twin names a cached label (its roster gains him) and an uncached one (a pending entry).
	writeNode(
		repoCacheDir,
		node("artist:aphex-twin", "Aphex Twin", {
			labels: [ref("label:ninja-tune", "Ninja Tune"), ref("label:warp", "Warp")],
		}),
	);
	writeNode(repoCacheDir, node("label:ninja-tune", "Ninja Tune"));
	// Burial names an uncached label that the repo's and the server's pending files both already queue.
	writeNode(repoCacheDir, node("artist:burial", "Burial", { labels: [ref("label:hyperdub", "Hyperdub")] }));
	// A project credits a cached artist (his discography gains it) and an uncached one (a pending entry).
	writeNode(
		repoCacheDir,
		node("project:syro", "Syro", {
			artists: [ref("artist:aphex-twin", "Aphex Twin"), ref("artist:gone", "Gone")],
		}),
	);
	mkdirSync(join(dirname(repoCacheDir), "data"), { recursive: true });
	writeFileSync(
		join(dirname(repoCacheDir), "data", "genre-taxonomy.json"),
		JSON.stringify({
			version: 2,
			families: [{ key: "electronic", label: "Electronic", order: 0 }],
			genres: [],
		}),
	);
	writeFileSync(join(repoCacheDir, "pending-reverses.json"), JSON.stringify(PENDING_HYPERDUB));

	const serverCache = join(serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeFileSync(join(serverCache, "pending-reverses.json"), JSON.stringify(PENDING_HYPERDUB));
	mkdirSync(join(serverRoot, "data"), { recursive: true });
	writeFileSync(join(serverRoot, "data", "genre-redirects.json"), JSON.stringify({ redirects: {} }));
	writeFileSync(join(serverRoot, "data", "slug-redirects.json"), JSON.stringify({ redirects: {} }));
	writeFileSync(join(serverRoot, ".service-active"), "");

	writeFakeBin(binDir, "ssh", 'host="$1"; shift\nbash -c "$*"');
	writeFakeBin(
		binDir,
		"rsync",
		`if [[ "$1" == "--server" ]]; then exec "$REAL_RSYNC" "$@"; fi
args=()
for a in "$@"; do
  if [[ "$a" == *:* && "$a" != -* ]]; then args+=("\${a#*:}"); else args+=("$a"); fi
done
exec "$REAL_RSYNC" "\${args[@]}"`,
	);
	// Records every `npx tsx <script> <args>` (one JSON line each) before running the real one.
	writeFakeBin(
		binDir,
		"npx",
		`node -e 'require("fs").appendFileSync(process.env.TEST_CALLS, JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@"
exec "$REAL_NPX" "$@"`,
	);
	return { repoCacheDir, serverRoot, binDir, callsLog };
}

interface Outcome {
	status: number | null;
	stdout: string;
	stderr: string;
	npx: string[][];
}

function runChannel(fx: Fixture, args: string[]): Promise<Outcome> {
	writeFileSync(fx.callsLog, "");
	const env: Record<string, string | undefined> = {
		...process.env,
		PATH: `${fx.binDir}:${process.env.PATH ?? ""}`,
		SERVER: "test@fake-server",
		REPO_CACHE_DIR: fx.repoCacheDir,
		SERVER_CACHE_REMOTE: join(fx.serverRoot, "cache"),
		SERVER_REDIRECTS_REMOTE: join(fx.serverRoot, "data", "genre-redirects.json"),
		SERVER_SLUG_REDIRECTS_REMOTE: join(fx.serverRoot, "data", "slug-redirects.json"),
		SERVER_BACKUP_DIR: join(fx.serverRoot, "backups"),
		SERVER_CRAWL_LOCK: join(fx.serverRoot, ".crawl-lock"),
		REPO_SLUG_REDIRECTS_PATH: join(fx.serverRoot, "data", "slug-redirects.json"),
		TEST_CALLS: fx.callsLog,
		REAL_RSYNC: realRsync,
		REAL_NPX: realNpx,
		SYNC_ALLOW_NON_MAIN: "1",
		SYNC_ALLOW_DIRTY: "1",
	};
	return new Promise((done, fail) => {
		const child = spawn("bash", [script, ...args], { env });
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
			const log = existsSync(fx.callsLog) ? readFileSync(fx.callsLog, "utf8") : "";
			done({
				status,
				stdout,
				stderr,
				npx: log
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as string[]),
			});
		});
	});
}

const manifestOf = (out: Outcome): string => {
	const match = new RegExp(`==> Migration manifest: ${MIGRATION_NAME}\\n([\\s\\S]*?)\\n\\n`).exec(out.stdout);
	return match?.[1] ?? "";
};

describe("migration channel: the reverse-edge backfill (TRA-488)", () => {
	let fx: Fixture;
	let preview: Outcome;
	let again: Outcome;

	beforeAll(async () => {
		fx = makeFixture();
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		again = await runChannel(fx, ["--migration", MIGRATION_NAME]);
	}, 240_000);

	it("is accepted by the channel in preview: name, script, manifest contract", () => {
		expect(`${preview.stdout}\n${preview.stderr}`).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain(`==> Migration manifest: ${MIGRATION_NAME}`);
		expect(preview.stdout).toContain("Preview only");
	});

	it("hands --apply, --manifest and --data-dir to the script, which accepts them", () => {
		const argv = preview.npx.find((a) => a.some((x) => x.endsWith(`${MIGRATION_NAME}.ts`)));
		expect(argv).toBeDefined();
		expect(argv).toContain("--apply");
		expect(argv?.[argv.indexOf("--manifest") + 1]).toMatch(
			new RegExp(`${MIGRATION_NAME}\\.manifest\\.json$`),
		);
		expect(argv?.[argv.indexOf("--data-dir") + 1]).toMatch(/migration-data$/);
	});

	it("declares the channel's fields and the reverse edges added on the union", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			blocked: false,
			removed: [],
			renamed: {},
			redirects: {},
			written: 2,
			added: {
				"artist.labels→label.roster": 1,
				"project.artists→artist.discography": 1,
			},
			pendingAdded: 2,
			unchanged: 1,
			conflicts: [],
			errors: [],
		});
	});

	it("counts the pending entries coherently: the shared one is not duplicated, the new ones are added", () => {
		// The repo and the server both hold label:hyperdub: the union has 1 key / 1 entry. The migration leaves
		// it (unchanged) and queues label:warp and artist:gone.
		expect(preview.stdout).toContain("pending-reverses.json before the migrations: 1 key(s), 1 entries");
		expect(preview.stdout).toContain("pending-reverses.json after the migrations: 3 key(s), 3 entries");
		// A rise is expected for this migration: the channel warns about it and does not refuse.
		expect(preview.stderr).toContain("RAISED the entries of pending-reverses.json (1 -> 3)");
		expect(preview.stderr).not.toMatch(/shrank/);
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
