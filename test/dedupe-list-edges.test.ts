import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	formatSummary,
	type Manifest,
	MIGRATION_NAME,
	parseCliArgs,
	runMigration,
} from "../scripts/migrations/2026-10-24-dedupe-list-edges.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

// TRA-557: 173 entries of 83 nodes repeat the slug of an earlier entry of their list. The migration keeps one
// per slug (src/edge-dedupe.ts has the rule and its own tests); what is pinned here is the run: which lists
// change, that nothing else does, and the manifest.
const PARAGRAPH = "A real paragraph about the node, long enough for the cache invariants to hold, by far.";
const CITATIONS = [{ url: "https://example.com/source", title: "Source" }];
const MB1 = "11111111-1111-4111-8111-111111111111";
const MB2 = "22222222-2222-4222-8222-222222222222";
const MB3 = "33333333-3333-4333-8333-333333333333";

type Obj = Record<string, unknown>;

function artist(slug: Slug, o: Obj = {}): Obj {
	return {
		type: "artist",
		slug,
		name: slug,
		editorial_article: PARAGRAPH,
		editorial_bio: "A short bio.",
		citations: CITATIONS,
		materialized_at: "2026-10-16T00:00:00.000Z",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...o,
	};
}

function project(slug: Slug, o: Obj = {}): Obj {
	return {
		type: "project",
		slug,
		name: slug,
		editorial_article: PARAGRAPH,
		editorial_pitch: "A pitch.",
		citations: CITATIONS,
		materialized_at: "2026-10-16T00:00:00.000Z",
		artists: [],
		genres: [],
		related_projects: [],
		tracklist: [],
		producers: [],
		personnel: [],
		...o,
	};
}

function release(slug: string, name: string, extra: Obj = {}): Obj {
	return { slug, type: "project", name, artist: "Fixture Artist", ...extra };
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "dedupe-list-edges-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeCache(nodes: readonly Obj[]): Promise<void> {
	for (const node of nodes) {
		const { type, body } = parseSlug(node.slug as Slug);
		const file = join(dir, "nodes", type, `${body}.json`);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
}

async function readNode(slug: Slug): Promise<Obj> {
	const { type, body } = parseSlug(slug);
	return JSON.parse(await readFile(join(dir, "nodes", type, `${body}.json`), "utf8")) as Obj;
}

async function snapshot(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const type of await readdir(join(dir, "nodes"))) {
		for (const f of await readdir(join(dir, "nodes", type))) {
			out[`${type}/${f}`] = await readFile(join(dir, "nodes", type, f), "utf8");
		}
	}
	return out;
}

async function run(apply: boolean): Promise<Manifest> {
	const result = await runMigration({ cacheDir: dir, apply });
	expect(result.manifest.errors).toEqual([]);
	expect(result.exitCode).toBe(0);
	return result.manifest;
}

const REMIX = release("project:booty-la-la--a", "Booty La La (Loefah remix)", {
	mbid: MB1,
	year: "2010",
	releaseType: "single",
});
const ALBUM = release("project:booty-la-la--a", "Booty La La", {
	mbid: MB2,
	year: "2008",
	releaseType: "album",
});
const OTHER = release("project:other--a", "Other", { mbid: MB3, year: "2009", releaseType: "album" });

describe("dedupe-list-edges: the lists", () => {
	it("keeps one discography edge per slug, the album over its remix, in the order of the list", async () => {
		await writeCache([artist("artist:a", { discography: [REMIX, OTHER, ALBUM] })]);

		const manifest = await run(true);

		expect((await readNode("artist:a")).discography).toEqual([OTHER, ALBUM]);
		expect(manifest.written).toBe(1);
		expect(manifest.byField).toEqual({ "artist.discography": 1 });
		expect(manifest.byReason).toEqual({ "release-type": 1 });
	});

	it("cleans a tracklist and a personnel list, and lists the first-occurrence cases as doubts", async () => {
		const touch = { slug: "track:touch--a", type: "track", name: "Touch", mbid: MB1 };
		const part4 = { slug: "track:touch--a", type: "track", name: "Touch (Part 4)", mbid: MB2 };
		const vernon = { slug: "artist:vernon", type: "artist", name: "Vernon", mbid: MB1 };
		const vernon2 = { slug: "artist:vernon", type: "artist", name: "Vernon", mbid: MB2 };
		await writeCache([project("project:p--a", { tracklist: [touch, part4], personnel: [vernon, vernon2] })]);

		const manifest = await run(true);

		const after = await readNode("project:p--a");
		expect([after.tracklist, after.personnel]).toEqual([[touch], [vernon]]);
		expect(manifest.byField).toEqual({ "project.personnel": 1, "project.tracklist": 1 });
		expect(manifest.doubts.map((d) => [d.node, d.field, d.slug])).toEqual([
			["project:p--a", "tracklist", "track:touch--a"],
			["project:p--a", "personnel", "artist:vernon"],
		]);
	});

	it("merges the complementary fields of an entry with the same mbid, without overwriting", async () => {
		const first = release("project:x--a", "X", { mbid: MB1, year: "1992" });
		const again = release("project:x--a", "X", { mbid: MB1, year: "2001", releaseType: "album" });
		await writeCache([artist("artist:a", { discography: [first, again] })]);

		await run(true);

		expect((await readNode("artist:a")).discography).toEqual([{ ...first, releaseType: "album" }]);
	});

	it("records every removed entry with the one that replaces it", async () => {
		await writeCache([artist("artist:a", { discography: [REMIX, ALBUM] })]);

		const manifest = await run(false);

		expect(manifest.removals).toEqual([
			{
				node: "artist:a",
				field: "discography",
				slug: "project:booty-la-la--a",
				reason: "release-type",
				removed: { name: "Booty La La (Loefah remix)", mbid: MB1, year: "2010", releaseType: "single" },
				kept: { name: "Booty La La", mbid: MB2, year: "2008", releaseType: "album" },
			},
		]);
		expect(manifest.removedEdges).toBe(1);
	});

	it("lists a singular pick that sits on another mbid than the kept entry, and does not edit it", async () => {
		const pick = { ...REMIX };
		await writeCache([artist("artist:a", { discography: [REMIX, ALBUM], landmark_project: pick })]);

		const manifest = await run(true);

		const after = await readNode("artist:a");
		expect(after.landmark_project).toEqual(pick);
		expect(manifest.pickDrift).toEqual([
			{
				node: "artist:a",
				field: "landmark_project",
				slug: "project:booty-la-la--a",
				pickMbid: MB1,
				keptMbid: MB2,
			},
		]);
	});
});

describe("dedupe-list-edges: nothing else changes", () => {
	it("does not touch a node without a repeated slug, byte for byte", async () => {
		await writeCache([
			artist("artist:clean", { discography: [ALBUM, OTHER] }),
			artist("artist:dup", { discography: [REMIX, ALBUM] }),
		]);
		const before = await snapshot();

		const manifest = await run(true);

		const after = await snapshot();
		expect(after["artist/clean.json"]).toBe(before["artist/clean.json"]);
		expect(after["artist/dup.json"]).not.toBe(before["artist/dup.json"]);
		expect(manifest.changed).toEqual([{ slug: "artist:dup", fields: ["discography"] }]);
	});

	it("changes the repeated list only: the other fields and the order of the keys stay", async () => {
		const node = artist("artist:a", {
			discography: [REMIX, ALBUM],
			notable_tracks: [{ slug: "track:t--a", type: "track", name: "T" }],
		});
		await writeCache([node]);

		await run(true);

		const after = await readNode("artist:a");
		expect(Object.keys(after)).toEqual(Object.keys(node));
		expect({ ...after, discography: node.discography }).toEqual(node);
	});

	it("does not add the empty lists a node lacks", async () => {
		const node = artist("artist:lean", { discography: [REMIX, ALBUM] });
		delete node.similar_artists; // the schema defaults it to []: the parsed copy would add it
		await writeCache([node]);

		await run(true);

		expect(Object.keys(await readNode("artist:lean"))).toEqual(Object.keys(node));
	});

	it("is idempotent: a second run writes nothing", async () => {
		await writeCache([artist("artist:a", { discography: [REMIX, ALBUM, OTHER] })]);
		await run(true);
		const after = await snapshot();

		const second = await run(true);

		expect(second.written).toBe(0);
		expect(second.removals).toEqual([]);
		expect(await snapshot()).toEqual(after);
	});
});

describe("dedupe-list-edges: the schema gate", () => {
	it("refuses, lists, and writes nothing when a node would no longer pass the schema", async () => {
		await writeCache([
			artist("artist:short", { editorial_article: "too short", discography: [REMIX, ALBUM] }),
			artist("artist:fine", { discography: [REMIX, ALBUM] }),
		]);
		const before = await snapshot();

		const dry = await runMigration({ cacheDir: dir, apply: false });
		const applied = await runMigration({ cacheDir: dir, apply: true });

		expect(dry.exitCode).toBe(1);
		expect(applied.exitCode).toBe(2);
		expect(applied.manifest.blocked).toBe(true);
		expect(applied.manifest.errors).toHaveLength(1);
		expect(applied.manifest.errors[0]).toContain("artist:short");
		// All or nothing: the node that could be written is not.
		expect(await snapshot()).toEqual(before);
	});

	it("blocks the run on an unreadable node file", async () => {
		await writeCache([artist("artist:fine", { discography: [REMIX, ALBUM] })]);
		await writeFile(join(dir, "nodes", "artist", "broken.json"), "{ not json", "utf8");
		const before = await snapshot();

		const result = await runMigration({ cacheDir: dir, apply: true });

		expect(result.exitCode).toBe(2);
		expect(result.manifest.errors.join("\n")).toContain("broken");
		expect(await snapshot()).toEqual(before);
	});
});

describe("dedupe-list-edges: dry-run, manifest and CLI", () => {
	it("a dry-run plans the same count and writes no node", async () => {
		await writeCache([artist("artist:a", { discography: [REMIX, ALBUM] })]);
		const before = await snapshot();

		const manifest = await run(false);

		expect(manifest.mode).toBe("dry-run");
		expect(manifest.written).toBe(1);
		expect(await snapshot()).toEqual(before);
	});

	it("the manifest carries the channel's contract and the changed lists", async () => {
		await writeCache([artist("artist:a", { discography: [REMIX, ALBUM] })]);
		const manifestPath = join(dir, "out", "dedupe.json");

		const { manifest } = await runMigration({ cacheDir: dir, apply: true, manifestPath });

		const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
		expect(onDisk).toMatchObject({
			migration: MIGRATION_NAME,
			mode: "apply",
			blocked: false,
			removed: [],
			renamed: {},
			redirects: {},
			written: 1,
			removedEdges: 1,
			changed: [{ slug: "artist:a", fields: ["discography"] }],
			errors: [],
		});
		expect(formatSummary(manifest, manifestPath)).toContain("entries removed");
	});

	it("parses the arguments of the channel, --data-dir included and ignored", () => {
		expect(parseCliArgs(["/c", "--apply", "--manifest", "/m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/c",
			apply: true,
			manifestPath: "/m.json",
			dataDir: "/d",
		});
		expect(parseCliArgs(["/c"])).toEqual({
			cacheDir: "/c",
			apply: false,
			manifestPath: DEFAULT_MANIFEST_PATH,
			dataDir: undefined,
		});
		for (const bad of [
			[],
			["--apply"],
			["/c", "--bogus"],
			["/c", "--manifest"],
			["/c", "--apply", "--apply"],
		]) {
			expect(parseCliArgs(bad)).toBeNull();
		}
	});

	it("runs end to end with the exact arguments deploy/sync-genre-cache.sh passes", async () => {
		await writeCache([artist("artist:a", { discography: [REMIX, ALBUM] }), artist("artist:clean")]);
		const dataDir = join(dir, "scratch-data");
		await mkdir(dataDir);
		const manifestPath = join(dir, "channel.manifest.json");

		const out = execFileSync(
			join(process.cwd(), "node_modules", ".bin", "tsx"),
			[
				join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`),
				dir,
				"--apply",
				"--manifest",
				manifestPath,
				"--data-dir",
				dataDir,
			],
			{ encoding: "utf8" },
		);

		expect(out).toContain("entries removed");
		const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
		expect([m.migration, m.written, m.removed, m.renamed, m.redirects]).toEqual([
			MIGRATION_NAME,
			1,
			[],
			{},
			{},
		]);
		expect((await readNode("artist:a")).discography).toEqual([ALBUM]);
	});
});

describe("channel contract (deploy/sync-genre-cache.sh)", () => {
	it("the migration name is accepted by the channel's name pattern, and the script it runs exists", () => {
		const script = readFileSync(resolve("deploy/sync-genre-cache.sh"), "utf8");
		const pattern = /^MIGRATION_NAME_PATTERN='(.+)'$/m.exec(script)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(resolve("scripts", "migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
	});
});
