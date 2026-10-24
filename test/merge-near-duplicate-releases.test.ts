import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	MIGRATION_NAME,
	PAIRS_PATH,
	type PairsTable,
	pairsSchema,
	parseCliArgs,
	runMigration,
} from "../scripts/migrations/2026-10-24-merge-near-duplicate-releases.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";

// TRA-633 PR 2. The twins already in the cache are merged from a closed, proven list; a pair is touched only when
// the cache is in the state the table describes, and a second run writes nothing.

type Obj = Record<string, unknown>;
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MBID = "65a686ad-40c1-4a48-a9ac-3fdaceff4003";
const OTHER_MBID = "11111111-2222-3333-4444-555555555555";

const ref = (slug: string, name: string, extra: Obj = {}): Obj => ({
	slug,
	type: parseSlug(slug).type,
	name,
	...extra,
});

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

const pathOf = (cache: string, slug: string): string => {
	const { type, body } = parseSlug(slug);
	return join(cache, "nodes", type, `${body}.json`);
};
const read = (cache: string, slug: string): Obj =>
	JSON.parse(readFileSync(pathOf(cache, slug), "utf8")) as Obj;
const slugsOf = (list: unknown): string[] => (list as { slug: string }[]).map((e) => e.slug);

function makeCache(
	nodes: Obj[],
	opts: { pending?: Obj; redirects?: Record<string, string> } = {},
): { cache: string; data: string } {
	const root = mkdtempSync(join(tmpdir(), "merge-near-dup-"));
	dirs.push(root);
	const cache = join(root, "cache");
	for (const n of nodes) {
		mkdirSync(dirname(pathOf(cache, n.slug as string)), { recursive: true });
		writeFileSync(pathOf(cache, n.slug as string), JSON.stringify(n));
	}
	writeFileSync(join(cache, "pending-reverses.json"), JSON.stringify(opts.pending ?? {}));
	const data = join(root, "data");
	mkdirSync(data, { recursive: true });
	writeFileSync(
		join(data, "slug-redirects.json"),
		JSON.stringify({
			source: "test",
			generated_at: "2026-10-16T00:00:00.000Z",
			redirects: opts.redirects ?? {},
		}),
	);
	return { cache, data };
}

const LOSER = "project:800-ndagga";
const SURVIVOR = "project:800-ndagga--mark-ernestus";
const SURVIVOR_ENTRY = ref(SURVIVOR, "800% Ndagga", {
	artist: "Mark Ernestus",
	mbid: MBID,
	year: "2013",
	releaseType: "album",
});
const LOSER_ENTRY = ref(LOSER, "800% Ndagga (album)");
const KEPT_PAIR = [ref("project:inside", "Inside"), ref("project:inside-the-songs", "Inside (The Songs)")];

const table = (over: Partial<PairsTable["pairs"][number]> = {}): PairsTable => ({
	source: "test",
	pairs: [
		{
			id: "mark-ernestus/800-ndagga",
			kind: "release-group",
			artist: "artist:mark-ernestus",
			loser: { slug: LOSER, name: "800% Ndagga (album)" },
			survivor: { slug: SURVIVOR, name: "800% Ndagga", mbid: MBID },
			evidence: "test",
			...over,
		},
	],
	kept: [],
});

const world = (disc: Obj[] = [SURVIVOR_ENTRY, LOSER_ENTRY, ...KEPT_PAIR], extra: Obj[] = []): Obj[] => [
	node("artist:mark-ernestus", "Mark Ernestus", {
		discography: disc,
		landmark_project: ref(LOSER, "800% Ndagga (album)"),
	}),
	node("label:ndagga-records", "Ndagga Records", {
		notable_releases: [
			ref(LOSER, "800% Ndagga (album)"),
			ref(SURVIVOR, "800% Ndagga", { artist: "Mark Ernestus" }),
		],
	}),
	node("genre:mbalax", "Mbalax", { landmark_projects: [ref(LOSER, "800% Ndagga (album)")] }),
	node("artist:someone-else", "Someone Else", { discography: [ref(LOSER, "800% Ndagga (album)")] }),
	...extra,
];

describe("merge of the near-duplicate releases (TRA-633 PR 2)", () => {
	it("merges a proven twin: artist, other nodes, pending reverses, redirect", async () => {
		const { cache, data } = makeCache(world(), {
			pending: {
				[LOSER]: [
					{ field: "artists", cardinality: "list", edge: ref("artist:mark-ernestus", "Mark Ernestus") },
				],
			},
		});
		const { manifest, exitCode } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			table: table(),
		});
		expect(exitCode).toBe(0);
		expect(manifest.merged.map((m) => m.loser)).toEqual([LOSER]);

		const artist = read(cache, "artist:mark-ernestus");
		// The loser is gone, the survivor keeps its mbid, and the look-alikes that are not on the list stay.
		expect(slugsOf(artist.discography)).toEqual([SURVIVOR, "project:inside", "project:inside-the-songs"]);
		expect((artist.discography as Obj[])[0]).toMatchObject({
			mbid: MBID,
			year: "2013",
			releaseType: "album",
		});
		expect(artist.landmark_project).toMatchObject({
			slug: SURVIVOR,
			name: "800% Ndagga",
			artist: "Mark Ernestus",
		});
		// Another node's edge follows, with the survivor's name, and is not doubled.
		const label = read(cache, "label:ndagga-records");
		expect(label.notable_releases).toEqual([ref(SURVIVOR, "800% Ndagga", { artist: "Mark Ernestus" })]);
		expect(slugsOf(read(cache, "genre:mbalax").landmark_projects)).toEqual([SURVIVOR]);
		// Another artist's edge to a bare slug may be a homonym: it is listed, never rewritten.
		expect(slugsOf(read(cache, "artist:someone-else").discography)).toEqual([LOSER]);
		expect(manifest.foreignArtistEdges).toEqual([
			{ id: "mark-ernestus/800-ndagga", artist: "artist:someone-else", field: "discography" },
		]);
		expect(manifest.redirects).toEqual({ [LOSER]: SURVIVOR });
		const redirects = JSON.parse(readFileSync(join(data, "slug-redirects.json"), "utf8")) as Obj;
		expect(redirects.redirects).toEqual({ [LOSER]: SURVIVOR });
		const pending = JSON.parse(readFileSync(join(cache, "pending-reverses.json"), "utf8")) as Obj;
		expect(Object.keys(pending)).toEqual([SURVIVOR]);
		expect(manifest.removed).toEqual([]);
	});

	it("keeps a label or genre edge on the old slug when the survivor's node does not point back", async () => {
		const survivorNode = node(SURVIVOR, "800% Ndagga", { label: ref("label:other", "Other"), genres: [] });
		const { cache, data } = makeCache(world(undefined, [survivorNode]));
		const { manifest } = await runMigration({ cacheDir: cache, apply: true, dataDir: data, table: table() });
		expect(slugsOf(read(cache, "genre:mbalax").landmark_projects)).toEqual([LOSER]);
		expect(slugsOf(read(cache, "label:ndagga-records").notable_releases)).toEqual([LOSER, SURVIVOR]);
		expect(manifest.left).toEqual([
			{ id: "mark-ernestus/800-ndagga", node: "genre:mbalax" },
			{ id: "mark-ernestus/800-ndagga", node: "label:ndagga-records" },
		]);
		// The artist's own discography is still merged.
		expect(slugsOf(read(cache, "artist:mark-ernestus").discography)).not.toContain(LOSER);
	});

	it("deletes the old copy of a node the repository already moved, merges its lists, follows every edge", async () => {
		// The union after the repository run: the survivor's node (moved copy) and the server's old node.
		const tracks = [ref("track:one", "One"), ref("track:two", "Two")];
		const oldCopy = node(LOSER, "800% Ndagga (album)", { tracklist: tracks, label: ref("label:old", "Old") });
		const moved = node(SURVIVOR, "800% Ndagga", {
			tracklist: [tracks[0] as Obj],
			label: ref("label:new", "New"),
		});
		const { cache, data } = makeCache(world(undefined, [oldCopy, moved]), {
			redirects: { [LOSER]: SURVIVOR },
		});
		const { manifest, exitCode } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			table: table(),
		});
		expect(exitCode).toBe(0);
		expect(existsSync(pathOf(cache, LOSER))).toBe(false);
		const survivor = read(cache, SURVIVOR);
		expect(slugsOf(survivor.tracklist)).toEqual(["track:one", "track:two"]);
		expect(survivor.label).toEqual(ref("label:new", "New"));
		expect(manifest.renamed).toEqual({ [LOSER]: SURVIVOR });
		// The redirect is already committed: it is not emitted again, and every edge follows.
		expect(manifest.redirects).toEqual({});
		expect(slugsOf(read(cache, "artist:mark-ernestus").discography)).not.toContain(LOSER);
		expect(slugsOf(read(cache, "genre:mbalax").landmark_projects)).toEqual([SURVIVOR]);
		expect(slugsOf(read(cache, "label:ndagga-records").notable_releases)).toEqual([SURVIVOR]);
		expect(manifest.left).toEqual([]);
	});

	it("keeps the survivor's title and node and gives it the mbid of the entry that holds the release group", async () => {
		// Kraftwerk: the English entry has the node and no mbid, the German entry has the release group.
		const german = ref("project:computerwelt--kraftwerk", "Computerwelt", {
			artist: "Kraftwerk",
			mbid: MBID,
			year: "1981",
			releaseType: "album",
		});
		const english = ref("project:computer-world--kraftwerk", "Computer World");
		const pair = {
			id: "kraftwerk/computerwelt--kraftwerk",
			kind: "release-group" as const,
			artist: "artist:kraftwerk",
			loser: { slug: german.slug as string, name: "Computerwelt", mbid: MBID },
			survivor: { slug: english.slug as string, name: "Computer World" },
			evidence: "test",
		};
		const { cache, data } = makeCache([
			node("artist:kraftwerk", "Kraftwerk", {
				discography: [ref("project:other", "Other", { year: "1990" }), german, english],
			}),
			node(english.slug as string, "Computer World", { label: ref("label:kling-klang", "Kling Klang") }),
			node("label:kling-klang", "Kling Klang", {
				notable_releases: [ref(german.slug as string, "Computerwelt")],
			}),
		]);
		const { manifest } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			table: { source: "test", pairs: [pair], kept: [] },
		});
		expect(manifest.renamed).toEqual({});
		const disc = read(cache, "artist:kraftwerk").discography as Obj[];
		// The adopted entry takes the German entry's place; the old English entry is gone.
		expect(disc).toEqual([
			ref("project:other", "Other", { year: "1990" }),
			{ ...german, slug: english.slug, name: "Computer World" },
		]);
		expect(read(cache, "label:kling-klang").notable_releases).toEqual([
			ref(english.slug as string, "Computer World", { artist: "Kraftwerk" }),
		]);
		expect(manifest.redirects).toEqual({ [german.slug as string]: english.slug });
		// Not the right mbid: left alone.
		const wrong = makeCache([
			node("artist:kraftwerk", "Kraftwerk", { discography: [{ ...german, mbid: OTHER_MBID }, english] }),
		]);
		const w = await runMigration({
			cacheDir: wrong.cache,
			apply: false,
			dataDir: wrong.data,
			table: { source: "test", pairs: [pair], kept: [] },
		});
		expect(w.manifest.flagged.map((f) => f.reason)).toEqual(["state-differs"]);
	});

	it("is idempotent: a second run writes nothing", async () => {
		const { cache, data } = makeCache(world());
		await runMigration({ cacheDir: cache, apply: true, dataDir: data, table: table() });
		const before = readFileSync(join(data, "slug-redirects.json"), "utf8");
		const second = await runMigration({ cacheDir: cache, apply: true, dataDir: data, table: table() });
		expect(second.manifest.written).toBe(0);
		expect(second.manifest.merged).toEqual([]);
		expect(second.manifest.alreadyDone).toEqual(["mark-ernestus/800-ndagga"]);
		expect(readFileSync(join(data, "slug-redirects.json"), "utf8")).toBe(before);
	});

	it("writes nothing in a dry-run", async () => {
		const { cache, data } = makeCache(world());
		const before = readFileSync(pathOf(cache, "artist:mark-ernestus"), "utf8");
		const { manifest } = await runMigration({ cacheDir: cache, apply: false, dataDir: data, table: table() });
		expect(manifest.merged).toHaveLength(1);
		expect(readFileSync(pathOf(cache, "artist:mark-ernestus"), "utf8")).toBe(before);
		expect(manifest.mode).toBe("dry-run");
	});

	it("moves the loser's node to the survivor's slug and name when only the loser has one", async () => {
		const { cache, data } = makeCache(
			world(undefined, [node(LOSER, "800% Ndagga (album)", { editorial_article: "y".repeat(120) })]),
		);
		const { manifest } = await runMigration({ cacheDir: cache, apply: true, dataDir: data, table: table() });
		expect(existsSync(pathOf(cache, LOSER))).toBe(false);
		const moved = read(cache, SURVIVOR);
		expect(moved).toMatchObject({ slug: SURVIVOR, name: "800% Ndagga", editorial_article: "y".repeat(120) });
		expect(manifest.renamed).toEqual({ [LOSER]: SURVIVOR });
		// Every edge to a moved node follows, reciprocal or not: the old slug has no file any more.
		expect(slugsOf(read(cache, "genre:mbalax").landmark_projects)).toEqual([SURVIVOR]);
		expect(manifest.left).toEqual([]);
		// Another artist's edge to a moved node cannot stay: the file is gone.
		expect(slugsOf(read(cache, "artist:someone-else").discography)).toEqual([SURVIVOR]);
		expect(manifest.foreignArtistEdges).toEqual([]);
	});

	it.each([
		[
			"the survivor carries another mbid",
			{ survivor: { slug: SURVIVOR, name: "800% Ndagga", mbid: OTHER_MBID } },
			"state-differs",
		],
		["the names differ from the table", { loser: { slug: LOSER, name: "Something else" } }, "state-differs"],
	])("flags and leaves the pair alone when %s", async (_label, over, reason) => {
		const { cache, data } = makeCache(world());
		const before = readFileSync(pathOf(cache, "artist:mark-ernestus"), "utf8");
		const { manifest, exitCode } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			table: table(over as Partial<PairsTable["pairs"][number]>),
		});
		expect(exitCode).toBe(0);
		expect(manifest.flagged.map((f) => f.reason)).toEqual([reason]);
		expect(manifest.written).toBe(0);
		expect(readFileSync(pathOf(cache, "artist:mark-ernestus"), "utf8")).toBe(before);
	});

	it("flags a loser that carries its own mbid, two project nodes, and a redirect that leads elsewhere", async () => {
		const own = world([SURVIVOR_ENTRY, { ...LOSER_ENTRY, mbid: OTHER_MBID }]);
		const a = await runMigration({ cacheDir: makeCache(own).cache, apply: false, table: table() });
		expect(a.manifest.flagged[0]?.detail).toContain("its own mbid");

		// Two nodes and no committed redirect: not for the migration to pick, and the run must FAIL, not exit 0.
		const both = makeCache(world(undefined, [node(LOSER, "x"), node(SURVIVOR, "y")]));
		const b = await runMigration({ cacheDir: both.cache, apply: true, dataDir: both.data, table: table() });
		expect(b.exitCode).toBe(2);
		expect(b.manifest.blocked).toBe(true);
		expect(b.manifest.errors.join("\n")).toContain("the redirect is not committed");
		expect(slugsOf(read(both.cache, "artist:mark-ernestus").discography)).toContain(LOSER);

		const elsewhere = makeCache(world(), { redirects: { [LOSER]: "project:other" } });
		const c = await runMigration({
			cacheDir: elsewhere.cache,
			apply: false,
			dataDir: elsewhere.data,
			table: table(),
		});
		expect(c.manifest.flagged.map((f) => f.reason)).toEqual(["redirect-conflict"]);
	});

	it("blocks the run when a node it would write is invalid, and writes nothing", async () => {
		const bad = world();
		(bad[0] as Obj).citations = "not a list";
		const { cache, data } = makeCache(bad);
		const { manifest, exitCode } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			table: table(),
		});
		expect(manifest.blocked).toBe(true);
		expect(exitCode).toBe(2);
		expect(slugsOf(read(cache, "artist:mark-ernestus").discography)).toContain(LOSER);
	});

	it("parses the CLI like the channel calls it", () => {
		expect(parseCliArgs(["cache", "--apply", "--manifest", "m.json", "--data-dir", "d"])).toEqual({
			cacheDir: "cache",
			apply: true,
			manifestPath: "m.json",
			dataDir: "d",
		});
		expect(parseCliArgs(["--apply"])).toBeNull();
		expect(parseCliArgs(["cache", "--nope"])).toBeNull();
	});
});

describe("the committed proof table", () => {
	const committed = pairsSchema.parse(JSON.parse(readFileSync(PAIRS_PATH, "utf8")));

	it("is closed and consistent: unique ids, a loser is never a survivor, every pair has evidence", () => {
		const ids = committed.pairs.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		const survivors = new Set(committed.pairs.map((p) => p.survivor.slug));
		for (const p of committed.pairs) {
			expect(survivors.has(p.loser.slug)).toBe(false);
			expect(p.loser.slug).not.toBe(p.survivor.slug);
			expect(p.evidence.length).toBeGreaterThan(30);
			// A release-group pair names the release group it was proven against.
			if (p.kind === "release-group") expect(p.survivor.mbid ?? p.loser.mbid).toBeDefined();
		}
	});

	it("keeps apart the look-alikes the ticket says are distinct", () => {
		const merged = new Set(committed.pairs.flatMap((p) => [p.loser.name, p.survivor.name]));
		for (const title of [
			"Gruppen",
			"Gruppen / Carré",
			"Inside",
			"Inside (The Songs)",
			"Confetti",
			"Joe's Garage",
			"Runt",
		]) {
			expect(merged.has(title)).toBe(false);
		}
		const kept = committed.kept.flatMap((k) => k.titles);
		for (const title of ["Gruppen", "Inside", "Confetti", "Joe's Garage", "Runt", "Sine of the Dub"]) {
			expect(kept).toContain(title);
		}
	});

	it("is accepted by the migration channel", () => {
		const script = readFileSync(join(__dirname, "..", "deploy", "sync-genre-cache.sh"), "utf8");
		const pattern = /MIGRATION_NAME_PATTERN='([^']+)'/u.exec(script)?.[1] ?? "";
		expect(new RegExp(pattern, "u").test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(join(__dirname, "..", "scripts", "migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
	});
});
