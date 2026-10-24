import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-21-backfill-discography-mbid.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";

// TRA-619: the REAL discography backfill (TRA-618) through the real deploy/sync-genre-cache.sh, in preview and
// with --apply, on a small fixture (the pattern of migration-channel-merge-duplicate-labels.test.ts: ssh, rsync
// and curl are local fakes). MusicBrainz is a local HTTP server reached through MB_BASE_URL, so nothing leaves
// the machine. What it proves is the CHANNEL contract for a migration that only completes `discography` lists:
// the flags the script parses, the manifest shape, no deletion, pending-reverses.json untouched, the union
// check, the refusal of a run whose MusicBrainz does not answer.

const script = resolve("deploy/sync-genre-cache.sh");
const realRsync = execFileSync("bash", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();
const realNpx = execFileSync("bash", ["-c", "command -v npx"], { encoding: "utf8" }).trim();

const dirs: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

type Obj = Record<string, unknown>;
const ref = (slug: string, name: string): Obj => ({ slug, type: parseSlug(slug).type, name });

const FLASH_MBID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const PROD_MBID = "f1c6f5a0-7a3e-4d3c-9b6e-2c1d8e4a5b77";
const RG = {
	firstLight: "11111111-1111-4111-8111-111111111111",
	secondWind: "22222222-2222-4222-8222-222222222222",
	nightShift: "33333333-3333-4333-8333-333333333333",
	dayside: "44444444-4444-4444-8444-444444444444",
};
// Voted and old: the policy's unrated cut depends on the current year, this fixture must not.
const releaseGroup = (id: string, title: string, type: string, date: string, who: [string, string]): Obj => ({
	id,
	title,
	"primary-type": type,
	"secondary-types": [],
	"first-release-date": date,
	rating: { "votes-count": 4 },
	"artist-credit": [{ name: who[1], artist: { id: who[0], name: who[1] } }],
});
const MB_ANSWERS: Record<string, Obj[]> = {
	[FLASH_MBID]: [
		releaseGroup(RG.firstLight, "First Light", "Album", "1999-05-01", [FLASH_MBID, "Flash"]),
		releaseGroup(RG.secondWind, "Second Wind", "Album", "2003-03-03", [FLASH_MBID, "Flash"]),
	],
	[PROD_MBID]: [
		releaseGroup(RG.nightShift, "Night Shift", "Album", "2001-01-01", [PROD_MBID, "Prod Only"]),
		releaseGroup(RG.dayside, "Dayside", "EP", "2005-05-05", [PROD_MBID, "Prod Only"]),
	],
};

/** A MusicBrainz browse endpoint; `down` answers 400 (not retried by the client, so the artist is `unavailable`). */
async function startMusicBrainz(
	down: boolean,
): Promise<{ baseUrl: string; asked: string[]; refused: string[] }> {
	const asked: string[] = [];
	const refused: string[] = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const artist = url.searchParams.get("artist") ?? "";
		if (down || url.pathname !== "/ws/2/release-group" || !(artist in MB_ANSWERS)) {
			refused.push(`${url.pathname}?artist=${artist}`);
			res.writeHead(400).end("{}");
			return;
		}
		asked.push(artist);
		const type = (url.searchParams.get("type") ?? "").toLowerCase();
		const groups = (MB_ANSWERS[artist] ?? []).filter((g) => String(g["primary-type"]).toLowerCase() === type);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ "release-group-count": groups.length, "release-groups": groups }));
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ws/2`, asked, refused };
}

function node(slug: string, name: string, fields: Obj = {}): Obj {
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

const PENDING_REPO = {
	"artist:unborn-repo": [{ field: "labels", cardinality: "list", edge: ref("label:warp", "Warp") }],
};
const PENDING_PROD = {
	"artist:unborn-prod": [{ field: "labels", cardinality: "list", edge: ref("label:warp", "Warp") }],
};

interface Fixture {
	repoCacheDir: string;
	serverRoot: string;
	binDir: string;
	callsLog: string;
	mb: { baseUrl: string; asked: string[]; refused: string[] };
}

async function makeFixture(mbDown = false): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "discography-channel-"));
	dirs.push(root);
	const repoCacheDir = join(root, "repo", "cache");
	const serverRoot = join(root, "server");
	const binDir = join(root, "bin");
	const callsLog = join(root, "calls.log");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(callsLog, "");

	// The repo: one artist with an mbid whose list has an entry WITHOUT mbid, and one artist without mbid.
	writeNode(repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(
		repoCacheDir,
		node("artist:flash", "Flash", {
			mbid: FLASH_MBID,
			discography: [ref("project:first-light", "First Light")],
		}),
	);
	writeNode(repoCacheDir, node("artist:solo", "Solo"));
	writeFileSync(join(repoCacheDir, "pending-reverses.json"), JSON.stringify(PENDING_REPO));
	const repoData = join(dirname(repoCacheDir), "data");
	mkdirSync(repoData, { recursive: true });
	writeFileSync(
		join(repoData, "genre-taxonomy.json"),
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
	writeFileSync(join(repoData, "slug-redirects.json"), JSON.stringify({ redirects: {} }));
	// The union's own genre merges mint redirects the committed table must already hold: take the repo's.
	copyFileSync(resolve("data/genre-redirects.json"), join(repoData, "genre-redirects.json"));
	writeFileSync(join(repoData, "identity-exclusions.json"), JSON.stringify({ artists: {} }));

	// The server: a snapshot with an artist only prod has, mbid included.
	const serverCache = join(serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeNode(
		serverCache,
		node("artist:prod-only", "Prod Only", {
			mbid: PROD_MBID,
			discography: [ref("project:night-shift", "Night Shift")],
		}),
	);
	writeFileSync(join(serverCache, "pending-reverses.json"), JSON.stringify(PENDING_PROD));
	mkdirSync(join(serverRoot, "data"), { recursive: true });
	writeFileSync(join(serverRoot, "data", "genre-redirects.json"), JSON.stringify({ redirects: {} }));
	writeFileSync(join(serverRoot, "data", "slug-redirects.json"), JSON.stringify({ redirects: {} }));
	writeFileSync(join(serverRoot, ".service-active"), "");

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
	// Records every rsync (one JSON line, the arguments as received) before running the real one.
	writeFakeBin(
		binDir,
		"rsync",
		`if [[ "$1" == "--server" ]]; then exec "$REAL_RSYNC" "$@"; fi
node -e 'require("fs").appendFileSync(process.env.TEST_CALLS, JSON.stringify({ rsync: process.argv.slice(1) }) + "\\n")' -- "$@"
args=()
for a in "$@"; do
  if [[ "$a" == *:* && "$a" != -* ]]; then args+=("\${a#*:}"); else args+=("$a"); fi
done
exec "$REAL_RSYNC" "\${args[@]}"`,
	);
	// Records every `npx tsx <script> <args>` with the slug flag it runs under, then runs the real one.
	writeFakeBin(
		binDir,
		"npx",
		`node -e 'require("fs").appendFileSync(process.env.TEST_CALLS, JSON.stringify({ npx: process.argv.slice(1), scoped: process.env.ODYSSEY_SCOPED_RELEASE_SLUGS ?? null }) + "\\n")' -- "$@"
exec "$REAL_NPX" "$@"`,
	);
	return { repoCacheDir, serverRoot, binDir, callsLog, mb: await startMusicBrainz(mbDown) };
}

interface Outcome {
	status: number | null;
	stdout: string;
	stderr: string;
	rsyncs: string[][];
	npxs: { npx: string[]; scoped: string | null }[];
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
		REPO_SLUG_REDIRECTS_PATH: join(dirname(fx.repoCacheDir), "data", "slug-redirects.json"),
		REPO_REDIRECTS_PATH: join(dirname(fx.repoCacheDir), "data", "genre-redirects.json"),
		REPO_IDENTITY_EXCLUSIONS_PATH: join(dirname(fx.repoCacheDir), "data", "identity-exclusions.json"),
		TEST_SERVICE_MARKER: join(fx.serverRoot, ".service-active"),
		TEST_CALLS: fx.callsLog,
		REAL_RSYNC: realRsync,
		REAL_NPX: realNpx,
		SYNC_ALLOW_NON_MAIN: "1",
		SYNC_ALLOW_DIRTY: "1",
		MB_BASE_URL: fx.mb.baseUrl,
		MB_MIN_INTERVAL_MS: "0",
	};
	// No key in the environment: the migration has no LLM, this makes it a fact of the run.
	delete env.GEMINI_API_KEY;
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
			const lines = (existsSync(fx.callsLog) ? readFileSync(fx.callsLog, "utf8") : "")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Obj);
			done({
				status,
				stdout,
				stderr,
				rsyncs: lines.filter((l) => "rsync" in l).map((l) => l.rsync as string[]),
				npxs: lines.filter((l) => "npx" in l) as Outcome["npxs"],
			});
		});
	});
}

const manifestOf = (out: Outcome): string =>
	new RegExp(`==> Migration manifest: ${MIGRATION_NAME}\\n([\\s\\S]*?)\\n\\n`).exec(out.stdout)?.[1] ?? "";
const readServer = (fx: Fixture, ...parts: string[]): Obj =>
	JSON.parse(readFileSync(join(fx.serverRoot, ...parts), "utf8")) as Obj;
const serverArtist = (fx: Fixture, body: string): Obj =>
	readServer(fx, "cache", "nodes", "artist", `${body}.json`);
const mbidsOf = (list: unknown): (string | undefined)[] => (list as { mbid?: string }[]).map((e) => e.mbid);

/** Every file of the server's cache/ and data/, path -> bytes: what "nothing was written" is compared on. */
function serverTree(fx: Fixture): Record<string, string> {
	const tree: Record<string, string> = {};
	for (const sub of ["cache", "data"]) {
		const base = join(fx.serverRoot, sub);
		for (const rel of readdirSync(base, { recursive: true, encoding: "utf8" })) {
			if (statSync(join(base, rel)).isFile()) tree[`${sub}/${rel}`] = readFileSync(join(base, rel), "utf8");
		}
	}
	return tree;
}

describe("migration channel: the discography backfill (TRA-619)", () => {
	let fx: Fixture;
	let serverBefore: Record<string, string>;
	let preview: Outcome;
	let serverAfterPreview: Record<string, string>;
	let backupsAfterPreview: boolean;
	let apply: Outcome;

	beforeAll(async () => {
		fx = await makeFixture();
		serverBefore = serverTree(fx);
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		serverAfterPreview = serverTree(fx);
		backupsAfterPreview = existsSync(join(fx.serverRoot, "backups"));
		apply = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);
	}, 300_000);

	it("preview: exits 0, the manifest passes the channel's shape check, no rsync goes to the server", () => {
		expect(`${preview.stdout}\n${preview.stderr}`).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain("Preview only");
		expect(manifestOf(preview)).not.toBe("");
		expect(JSON.parse(manifestOf(preview))).toMatchObject({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
		});
		// An rsync reads the server (source) but never writes it: no destination, the last argument, is remote.
		expect(preview.rsyncs.length).toBeGreaterThan(0);
		for (const args of preview.rsyncs) expect(args.at(-1)).not.toMatch(/^test@fake-server:/);
		expect(serverAfterPreview).toEqual(serverBefore);
		expect(backupsAfterPreview).toBe(false);
	});

	it("hands --apply, --manifest and --data-dir to the script, with no --resume and the channel's slug flag", () => {
		const call = preview.npxs.find((c) => c.npx.some((x) => x.endsWith(`${MIGRATION_NAME}.ts`)));
		expect(call).toBeDefined();
		const argv = call?.npx ?? [];
		expect(argv).toContain("--apply");
		expect(argv).not.toContain("--resume");
		expect(argv[argv.indexOf("--manifest") + 1]).toMatch(new RegExp(`${MIGRATION_NAME}\\.manifest\\.json$`));
		expect(argv[argv.indexOf("--data-dir") + 1]).toMatch(/migration-data$/);
		// The channel runs every migration with the flag on (TRA-599); the migration still pins it itself.
		expect(call?.scoped).toBe("1");
		// Both mbids reached MusicBrainz, the union's one (prod-only) included; the artist without mbid did not.
		expect([...new Set(fx.mb.asked)].sort()).toEqual([FLASH_MBID, PROD_MBID].sort());
		// Nothing else was asked: not for the artist without mbid, not for anything but release groups.
		expect(fx.mb.refused).toEqual([]);
	});

	it("--apply ships the repo artist and the prod-only artist with completed discographies, deleting nothing", () => {
		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		expect(JSON.parse(manifestOf(apply))).toMatchObject({ removed: [], renamed: {}, redirects: {} });
		expect(apply.stdout).not.toContain("Removing");
		for (const [artist, mbids] of [
			["flash", [RG.firstLight, RG.secondWind]],
			["prod-only", [RG.nightShift, RG.dayside]],
		] as const) {
			// The entry that had no mbid has it now, and the work MusicBrainz knows and the list lacked is appended.
			expect(mbidsOf(serverArtist(fx, artist).discography).sort()).toEqual([...mbids].sort());
		}
		// The entry that existed keeps its slug and name; the appended one is a well-formed project ref.
		const flash = serverArtist(fx, "flash").discography as Obj[];
		expect(flash.find((e) => e.mbid === RG.firstLight)).toMatchObject({
			slug: "project:first-light",
			name: "First Light",
		});
		expect(flash.find((e) => e.mbid === RG.secondWind)).toMatchObject({
			type: "project",
			name: "Second Wind",
		});
		// A discography backfill writes no work and no inverse edge: cache/nodes/project/ does not exist.
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "project"))).toBe(false);
		// Every file the server had is still there: the transfer only adds and overwrites.
		for (const path of Object.keys(serverBefore)) expect(existsSync(join(fx.serverRoot, path))).toBe(true);
		// The repo artist travelled with the union; the one without an mbid was not touched.
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "artist", "solo.json"))).toBe(true);
		expect(serverArtist(fx, "solo")).toEqual(node("artist:solo", "Solo"));
	});

	it("ships pending-reverses.json identical to the union's input (the repo's and the server's files)", () => {
		expect(readServer(fx, "cache", "pending-reverses.json")).toEqual({ ...PENDING_REPO, ...PENDING_PROD });
		expect(apply.stdout).toMatch(/before the migrations: 2 key\(s\), 2 entries/);
		expect(apply.stdout).toMatch(/after the migrations: 2 key\(s\), 2 entries/);
	});

	it("passes the migrated union through validate-migrated-union.ts, which accepts it", () => {
		const check = apply.npxs.find(
			(c) => c.npx.some((x) => x.endsWith("validate-migrated-union.ts")) && c.npx.includes("check"),
		);
		expect(check).toBeDefined();
		expect(apply.stdout + apply.stderr).not.toContain("the migrated union is invalid");
		expect(apply.stdout).toContain("Sync complete");
	});
});

describe("migration channel: the discography backfill (TRA-619), MusicBrainz not answering", () => {
	it("refuses the run before any server write: every artist asked about is unavailable, the script exits 1", async () => {
		const fx = await makeFixture(true);
		const before = serverTree(fx);
		const out = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);

		expect(out.status).not.toBe(0);
		expect(out.stderr).toMatch(new RegExp(`migration ${MIGRATION_NAME} failed \\(exit 1\\) -- refusing`));
		// It is MusicBrainz's silence that refused it: both artists were asked about and answered nothing.
		expect(out.stdout).toContain("2 of 2 artist(s) unavailable on MusicBrainz");
		expect(fx.mb.refused.length).toBeGreaterThan(0);
		expect(serverTree(fx)).toEqual(before);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
		expect(existsSync(join(fx.serverRoot, ".service-active"))).toBe(true);
	});
});
