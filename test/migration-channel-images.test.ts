import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-18-backfill-images.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";

// TRA-489 (a): the REAL image backfill through the real deploy/sync-genre-cache.sh, in preview, on a small
// fixture (the pattern of migration-channel-identity.test.ts: ssh and rsync are local fakes). The fixture holds
// no MBID and no artist name on a work, so the resolver makes no request at all: nothing leaves the machine and
// the run needs no fake server. What it proves is the CHANNEL contract: the name is accepted, the flags are
// the ones the migration parses, the manifest passes the channel's validation and is the same on every run.

const script = resolve("deploy/sync-genre-cache.sh");
const realRsync = execFileSync("bash", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();
const realNpx = execFileSync("bash", ["-c", "command -v npx"], { encoding: "utf8" }).trim();
const WIKIMEDIA_PHOTO = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg";

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
	const root = tmp("images-channel-");
	const repoCacheDir = join(root, "repo", "cache");
	const serverRoot = join(root, "server");
	const binDir = join(root, "bin");
	const callsLog = join(root, "npx-calls.log");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(callsLog, "");

	writeNode(repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(repoCacheDir, node("artist:flash", "Flash", { photo_url: WIKIMEDIA_PHOTO }));
	writeNode(repoCacheDir, node("project:bare", "Bare"));
	mkdirSync(join(dirname(repoCacheDir), "data"), { recursive: true });
	writeFileSync(
		join(dirname(repoCacheDir), "data", "genre-taxonomy.json"),
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
	writeFileSync(join(repoCacheDir, "pending-reverses.json"), "{}");

	const serverCache = join(serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeFileSync(join(serverCache, "pending-reverses.json"), "{}");
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
		// Belt and braces: even if the fixture reached MusicBrainz, it would not leave the machine.
		MB_BASE_URL: "http://127.0.0.1:9/ws/2",
		MB_MIN_INTERVAL_MS: "0",
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

describe("migration channel: the image backfill (TRA-489)", () => {
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

	it("does not copy the artist's photo_url (no legacy fallback): every node of the union is in none", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			none: [
				{ slug: "artist:flash", reason: "no-mbid" },
				{ slug: "genre:only-repo", reason: "no-related-image" },
				{ slug: "genre:only-server", reason: "no-related-image" },
				{ slug: "project:bare", reason: "no-mbid" },
			],
			failed: [],
		});
		expect((manifest.coverage as Obj).artist).toEqual({ before: 0, after: 0, total: 1 });
		expect((manifest.bySource as Obj).legacy).toBe(0);
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
