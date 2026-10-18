import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-20-merge-duplicate-labels.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";

// TRA-600: the REAL label merge through the real deploy/sync-genre-cache.sh, in preview and with --apply, on a
// small fixture (the pattern of migration-channel-reverse-edges.test.ts; ssh, rsync and curl are local fakes).
// The merge is a deletion: what it proves is the CHANNEL contract. The loser is removed on the server, the nodes
// that exist only in prod are re-pointed, the redirect is shipped, and --apply is refused while the redirect is
// not committed in the repo.

const script = resolve("deploy/sync-genre-cache.sh");
const realRsync = execFileSync("bash", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;
const ref = (slug: string, name: string): Obj => ({ slug, type: parseSlug(slug).type, name });
const WARP = ref("label:warp", "Warp");
const WARP_RECORDS = ref("label:warp-records", "Warp Records");

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

interface Fixture {
	repoCacheDir: string;
	serverRoot: string;
	binDir: string;
}

/** `committed`: whether the repo's data/slug-redirects.json already holds the redirect (the repo run landed). */
function makeFixture(committed: boolean): Fixture {
	const root = mkdtempSync(join(tmpdir(), "labels-channel-"));
	dirs.push(root);
	const repoCacheDir = join(root, "repo", "cache");
	const serverRoot = join(root, "server");
	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const aphex = ref("artist:aphex-twin", "Aphex Twin");
	const boc = ref("artist:boards-of-canada", "Boards of Canada");

	// The repo AFTER the repo run: merged survivor, re-pointed edges, loser deleted.
	writeNode(repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(
		repoCacheDir,
		node("label:warp", "Warp", {
			founded: "1989",
			roster: [aphex, boc],
			notable_releases: [ref("project:syro", "Syro")],
		}),
	);
	writeNode(repoCacheDir, node("artist:aphex-twin", "Aphex Twin", { labels: [WARP] }));
	writeNode(repoCacheDir, node("artist:boards-of-canada", "Boards of Canada", { labels: [WARP] }));
	writeNode(repoCacheDir, node("project:syro", "Syro", { label: WARP }));
	writeFileSync(join(repoCacheDir, "pending-reverses.json"), "{}");
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
	writeFileSync(
		join(repoData, "slug-redirects.json"),
		JSON.stringify({ redirects: committed ? { "label:warp-records": "label:warp" } : {} }),
	);

	// The server BEFORE the merge: both labels, and nodes only prod has, pointing at the loser.
	const serverCache = join(serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeNode(serverCache, node("label:warp", "Warp", { founded: "1989", roster: [aphex] }));
	writeNode(
		serverCache,
		node("label:warp-records", "Warp Records", {
			founded: "1989",
			location: "Sheffield",
			roster: [boc, ref("artist:prod-only", "Prod Only")],
		}),
	);
	writeNode(serverCache, node("artist:boards-of-canada", "Boards of Canada", { labels: [WARP_RECORDS] }));
	writeNode(serverCache, node("artist:prod-only", "Prod Only", { labels: [WARP_RECORDS] }));
	writeNode(serverCache, node("project:prod-only-ep", "Prod EP", { label: WARP_RECORDS }));
	writeFileSync(
		join(serverCache, "pending-reverses.json"),
		JSON.stringify({ "artist:unborn": [{ field: "labels", cardinality: "list", edge: WARP_RECORDS }] }),
	);
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
	return { repoCacheDir, serverRoot, binDir };
}

interface Outcome {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runChannel(fx: Fixture, args: string[]): Promise<Outcome> {
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
		TEST_SERVICE_MARKER: join(fx.serverRoot, ".service-active"),
		REAL_RSYNC: realRsync,
		SYNC_ALLOW_NON_MAIN: "1",
		SYNC_ALLOW_DIRTY: "1",
		// The script is offline; this only guarantees nothing could leave the machine.
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
		child.on("close", (status) => done({ status, stdout, stderr }));
	});
}

const manifestOf = (out: Outcome): string =>
	new RegExp(`==> Migration manifest: ${MIGRATION_NAME}\\n([\\s\\S]*?)\\n\\n`).exec(out.stdout)?.[1] ?? "";
const readServer = (fx: Fixture, ...parts: string[]): Obj =>
	JSON.parse(readFileSync(join(fx.serverRoot, ...parts), "utf8")) as Obj;
const serverNode = (fx: Fixture, type: string, body: string): Obj =>
	readServer(fx, "cache", "nodes", type, `${body}.json`);
const slugsOf = (list: unknown): string[] => (list as { slug: string }[]).map((e) => e.slug);

describe("migration channel: the label merge (TRA-600), redirect committed", () => {
	let fx: Fixture;
	let preview: Outcome;
	let again: Outcome;
	let serverBeforeApply: boolean;
	let apply: Outcome;

	beforeAll(async () => {
		fx = makeFixture(true);
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		again = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		serverBeforeApply = existsSync(join(fx.serverRoot, "cache", "nodes", "label", "warp-records.json"));
		apply = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);
	}, 300_000);

	it("is accepted in preview, declares the deletion and the redirect, and touches nothing on the server", () => {
		expect(`${preview.stdout}\n${preview.stderr}`).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain("Preview only");
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			removed: ["nodes/label/warp-records.json"],
			renamed: {},
			redirects: { "label:warp-records": "label:warp" },
			errors: [],
		});
		expect(serverBeforeApply).toBe(true);
	});

	it("gives a byte-identical manifest on a second preview", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});

	it("with --apply deletes the loser on the server, re-points the nodes only prod has, and ships the redirect", () => {
		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "label", "warp-records.json"))).toBe(false);
		expect(serverNode(fx, "artist", "prod-only").labels).toEqual([WARP]);
		expect(serverNode(fx, "artist", "boards-of-canada").labels).toEqual([WARP]);
		expect(serverNode(fx, "project", "prod-only-ep").label).toEqual(WARP);
		// The union keeps every artist either cache gave the label: 26-from-the-loser is not lost.
		expect(slugsOf(serverNode(fx, "label", "warp").roster).sort()).toEqual([
			"artist:aphex-twin",
			"artist:boards-of-canada",
			"artist:prod-only",
		]);
		expect(readServer(fx, "cache", "pending-reverses.json")["artist:unborn"]).toEqual([
			{ field: "labels", cardinality: "list", edge: WARP },
		]);
		expect(readServer(fx, "data", "slug-redirects.json").redirects).toEqual({
			"label:warp-records": "label:warp",
		});
	});
});

describe("migration channel: the label merge (TRA-600), redirect not committed", () => {
	it("refuses --apply before any server write, and says which redirect is missing", async () => {
		const fx = makeFixture(false);
		const out = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);

		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain("label:warp-records -> label:warp");
		expect(out.stderr).toMatch(/refusing --apply until the redirects above are committed/);
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "label", "warp-records.json"))).toBe(true);
		expect(readServer(fx, "data", "slug-redirects.json").redirects).toEqual({});
	});
});
