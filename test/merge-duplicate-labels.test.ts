import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCacheNodes } from "../scripts/migrations/2026-09-04-merge-genre-duplicates.js";
import {
	electSurvivor,
	groupKey,
	IDENTITIES_PATH,
	type Identities,
	MIGRATION_NAME,
	parseCliArgs,
	planMerge,
	runMigration,
} from "../scripts/migrations/2026-10-20-merge-duplicate-labels.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { nodePayloadSchema } from "../src/schemas.js";
import { parseSlug } from "../src/slug.js";

// TRA-600. The labels sharing a normalized name are merged only when the proof table (MusicBrainz + Wikidata)
// says they are one label AND the cache agrees with it; everything else is left alone and listed.

type Obj = Record<string, unknown>;
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ref = (slug: string, name: string): Obj => ({ slug, type: parseSlug(slug).type, name });

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

function makeCache(nodes: Obj[], pending: Obj = {}): { cache: string; data: string } {
	const root = mkdtempSync(join(tmpdir(), "merge-labels-"));
	dirs.push(root);
	const cache = join(root, "cache");
	for (const n of nodes) {
		mkdirSync(dirname(pathOf(cache, n.slug as string)), { recursive: true });
		writeFileSync(pathOf(cache, n.slug as string), JSON.stringify(n));
	}
	writeFileSync(join(cache, "pending-reverses.json"), JSON.stringify(pending));
	const data = join(root, "data");
	mkdirSync(data, { recursive: true });
	writeFileSync(
		join(data, "slug-redirects.json"),
		JSON.stringify({
			source: "test",
			generated_at: "2026-10-16T00:00:00.000Z",
			redirects: { "artist:old": "artist:new" },
		}),
	);
	return { cache, data };
}

const MB = "46f0f4cd-8aab-4b33-b698-f459faf64190";
const proof = (
	over: Partial<Extract<Identities["groups"][number], { status: "proven" }>> = {},
): Identities => ({
	source: "test",
	groups: [
		{
			key: "warp",
			status: "proven",
			members: ["label:warp", "label:warp-records"],
			mb: { mbid: MB, name: "Warp", aliases: ["Warp Records"], wikidata: "Q543707" },
			wd: { qid: "Q543707", label: "Warp", aliases: ["Warp Records"], inception: 1989, mbids: [MB] },
			anchors: [],
			evidence: [],
			...over,
		},
	],
});

const aphex = ref("artist:aphex-twin", "Aphex Twin");
const boc = ref("artist:boards-of-canada", "Boards of Canada");
const warpNodes = (): Obj[] => [
	node("label:warp", "Warp", {
		founded: "1989",
		roster: [aphex, ref("artist:autechre", "Autechre")],
		genres: [ref("genre:electronic", "Electronic")],
		notable_releases: [ref("project:syro", "Syro")],
	}),
	node("label:warp-records", "Warp Records", {
		founded: "1989",
		location: "London",
		roster: [boc, aphex],
		genres: [ref("genre:electronic", "Electronic"), ref("genre:idm", "IDM")],
		notable_releases: [ref("project:geogaddi", "Geogaddi")],
	}),
	node("artist:aphex-twin", "Aphex Twin", {
		labels: [ref("label:warp-records", "Warp Records"), ref("label:warp", "Warp")],
	}),
	node("artist:boards-of-canada", "Boards of Canada", {
		labels: [ref("label:warp-records", "Warp Records")],
	}),
	node("project:syro", "Syro", { label: ref("label:warp-records", "Warp Records") }),
	node("genre:electronic", "Electronic", { key_labels: [ref("label:warp-records", "Warp Records")] }),
	node("artist:untouched", "Untouched", { labels: [ref("label:other", "Other")] }),
];

describe("merging two labels proven identical", () => {
	it("unions the lists, emits the redirect, re-points every incoming reference and deletes the loser", async () => {
		const { cache, data } = makeCache(warpNodes(), {
			"artist:gone": [
				{ field: "labels", cardinality: "list", edge: ref("label:warp-records", "Warp Records") },
			],
		});
		const untouchedBefore = readFileSync(pathOf(cache, "artist:untouched"), "utf8");
		const manifestPath = join(data, "manifest.json");

		const { manifest, exitCode } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			identities: proof(),
			manifestPath,
		});

		expect(manifest.errors).toEqual([]);
		expect(exitCode).toBe(0);
		const winner = read(cache, "label:warp");
		expect(slugsOf(winner.roster)).toEqual([
			"artist:aphex-twin",
			"artist:autechre",
			"artist:boards-of-canada",
		]);
		expect(slugsOf(winner.genres)).toEqual(["genre:electronic", "genre:idm"]);
		expect(slugsOf(winner.notable_releases)).toEqual(["project:syro", "project:geogaddi"]);
		expect(winner.location).toBe("London");
		expect(existsSync(pathOf(cache, "label:warp-records"))).toBe(false);
		// Re-pointed, with the survivor's name, and an artist that cited both keeps one edge.
		expect(read(cache, "artist:aphex-twin").labels).toEqual([ref("label:warp", "Warp")]);
		expect(read(cache, "artist:boards-of-canada").labels).toEqual([ref("label:warp", "Warp")]);
		expect(read(cache, "project:syro").label).toEqual(ref("label:warp", "Warp"));
		expect(read(cache, "genre:electronic").key_labels).toEqual([ref("label:warp", "Warp")]);
		expect(
			JSON.parse(readFileSync(join(cache, "pending-reverses.json"), "utf8"))["artist:gone"][0].edge,
		).toEqual(ref("label:warp", "Warp"));
		expect(readFileSync(pathOf(cache, "artist:untouched"), "utf8")).toBe(untouchedBefore);
		expect(nodePayloadSchema.safeParse(winner).success).toBe(true);
		// The redirect is added to the existing table, not instead of it.
		expect(JSON.parse(readFileSync(join(data, "slug-redirects.json"), "utf8")).redirects).toEqual({
			"artist:old": "artist:new",
			"label:warp-records": "label:warp",
		});
		expect(manifest).toMatchObject({
			removed: ["nodes/label/warp-records.json"],
			renamed: {},
			redirects: { "label:warp-records": "label:warp" },
			rewritten: { "artist.labels": 2, "genre.key_labels": 1, "project.label": 1 },
			pendingRewritten: 1,
			merged: [
				{ survivor: "label:warp", losers: ["label:warp-records"], chosenBy: "musicbrainz-name", mbid: MB },
			],
		});
	});

	it("writes nothing in a dry-run, gives the same manifest twice, and is a no-op once applied", async () => {
		const { cache, data } = makeCache(warpNodes());
		const dry = { cacheDir: cache, dataDir: data, identities: proof() };
		const first = await runMigration({ ...dry, apply: false });
		expect(existsSync(pathOf(cache, "label:warp-records"))).toBe(true);
		expect(JSON.parse(readFileSync(join(data, "slug-redirects.json"), "utf8")).redirects).not.toHaveProperty(
			"label:warp-records",
		);
		expect(JSON.stringify((await runMigration({ ...dry, apply: false })).manifest)).toBe(
			JSON.stringify(first.manifest),
		);

		await runMigration({ ...dry, apply: true });
		const again = await runMigration({ ...dry, apply: true });
		expect(again.exitCode).toBe(0);
		expect(again.manifest).toMatchObject({ merged: [], refused: [], removed: [], redirects: {}, written: 0 });
	});

	it("keeps the survivor named like MusicBrainz, else the richest, else the lowest slug", async () => {
		const { cache } = makeCache(warpNodes());
		const { nodes } = await readCacheNodes(cache);
		const labels = nodes.filter((n) => n.type === "label");
		const entry = proof().groups[0] as Extract<Identities["groups"][number], { status: "proven" }>;
		expect(electSurvivor(entry, labels).survivor.slug).toBe("label:warp");
		// No member is named "Warp": the richest wins (warp-records has 5 edges against 4)...
		const renamed = { ...entry, mb: { ...entry.mb, name: "E’G" } };
		expect(electSurvivor(renamed, labels)).toMatchObject({
			survivor: { slug: "label:warp-records" },
			chosenBy: "richest",
		});
		// ...and at equal richness the lowest slug.
		const flat = labels.map((l) => ({
			...l,
			node: { ...l.node, roster: [], genres: [], notable_releases: [] },
		}));
		expect(electSurvivor(renamed, flat)).toMatchObject({
			survivor: { slug: "label:warp" },
			chosenBy: "slug",
		});
	});
});

describe("two labels with the same normalized name but no proof", () => {
	const homonym = (): Obj[] => [
		node("label:axis", "Axis", { founded: "1992", editorial_article: "Jeff Mills founded Axis. ".repeat(6) }),
		node("label:axis-records", "Axis Records", {
			founded: "1992",
			editorial_article: "A Dutch dance label. ".repeat(6),
		}),
	];
	const axis = (
		over: Partial<Extract<Identities["groups"][number], { status: "proven" }>> = {},
	): Identities =>
		proof({
			key: "axis",
			members: ["label:axis", "label:axis-records"],
			mb: { mbid: MB, name: "Axis", aliases: ["Axis Records"], wikidata: "Q2874802" },
			wd: { qid: "Q2874802", label: "Axis", aliases: ["Axis Records"], inception: 1992, mbids: [MB] },
			...over,
		});

	const cases: [string, Obj[], Identities, string][] = [
		["no entry in the proof table", warpNodes(), { source: "t", groups: [] }, "no-identity-proof"],
		[
			"an entry the table refuses",
			warpNodes(),
			{
				source: "t",
				groups: [
					{
						key: "warp",
						status: "refused",
						members: ["label:warp", "label:warp-records"],
						reason: "two entities",
						evidence: [],
					},
				],
			},
			"identity-not-proven",
		],
		[
			"a homonym: the anchor is missing from one article (Axis)",
			homonym(),
			axis({ anchors: ["Jeff Mills"] }),
			"anchor-missing",
		],
		[
			"a member founded in another year than the Wikidata inception",
			warpNodes().map((n) => (n.slug === "label:warp-records" ? { ...n, founded: "1995" } : n)),
			proof(),
			"founded-mismatch",
		],
		[
			"a member that is no name of the entity",
			warpNodes().map((n) => (n.slug === "label:warp-records" ? { ...n, name: "Warp Music" } : n)),
			proof(),
			"name-mismatch",
		],
		[
			"a member the proof does not cover",
			[...warpNodes(), node("label:warp-music", "Warp Music")],
			proof(),
			"member-not-covered",
		],
		[
			"Wikidata that does not list the mbid",
			warpNodes(),
			proof({
				wd: {
					qid: "Q543707",
					label: "Warp",
					aliases: [],
					inception: 1989,
					mbids: ["84009bd4-0ba1-411e-a952-78e6f9428572"],
				},
			}),
			"sources-contradict",
		],
		[
			"MusicBrainz that points at another QID",
			warpNodes(),
			proof({ mb: { mbid: MB, name: "Warp", aliases: [], wikidata: "Q1" } }),
			"sources-contradict",
		],
		[
			"sources with no link to each other",
			warpNodes(),
			proof({
				mb: { mbid: MB, name: "Warp", aliases: [], wikidata: null },
				wd: { qid: "Q543707", label: "Warp", aliases: [], inception: 1989, mbids: [] },
			}),
			"sources-not-linked",
		],
	];

	it.each(cases)("is not merged: %s", async (_label, nodes, identities, reason) => {
		const { cache, data } = makeCache(nodes);
		const before = Object.fromEntries(
			nodes.map((n) => [n.slug, readFileSync(pathOf(cache, n.slug as string), "utf8")]),
		);
		const { manifest, exitCode } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			identities,
		});

		expect(exitCode).toBe(0);
		expect(manifest.refused.map((r) => r.reason)).toEqual([reason]);
		expect(manifest).toMatchObject({ merged: [], removed: [], redirects: {}, written: 0 });
		for (const [slug, text] of Object.entries(before))
			expect(readFileSync(pathOf(cache, slug), "utf8")).toBe(text);
		expect(JSON.parse(readFileSync(join(data, "slug-redirects.json"), "utf8")).redirects).toEqual({
			"artist:old": "artist:new",
		});
	});

	it("groups names the way the ticket counts them", () => {
		expect(groupKey("Warp Records")).toBe(groupKey("Warp"));
		expect(groupKey("E.G. Records")).toBe(groupKey("EG Records"));
		expect(groupKey("Plus 8 Records")).toBe(groupKey("Plus 8"));
		expect(groupKey("Warp Records")).not.toBe(groupKey("Warp Films"));
	});
});

describe("the committed proof table against the committed cache", () => {
	it("merges only proven groups and reports the others, without a single error", async () => {
		const { nodes } = await readCacheNodes("cache");
		const table = JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as Identities;
		const { manifest } = planMerge(nodes, {}, table);

		expect(manifest.errors).toEqual([]);
		const status = new Map(table.groups.map((g) => [g.key, g.status]));
		// Once the repo run has landed there is nothing left to detect: every detected group is one the table knows.
		for (const g of manifest.merged) expect(status.get(g.key)).toBe("proven");
		for (const r of manifest.refused)
			expect([status.get(r.key), r.reason]).toEqual(["refused", "identity-not-proven"]);
		for (const g of table.groups)
			expect(g.members.every((m) => groupKey(m.slice("label:".length)) === g.key)).toBe(true);
	});
});

describe("migration channel contract (deploy/sync-genre-cache.sh)", () => {
	it("accepts the flags the channel passes and declares removed / renamed / redirects as it validates them", async () => {
		const args = parseCliArgs([
			"/tmp/union",
			"--apply",
			"--manifest",
			"/tmp/m.json",
			"--data-dir",
			"/tmp/migration-data",
		]);
		expect(args).toEqual({
			cacheDir: "/tmp/union",
			apply: true,
			manifestPath: "/tmp/m.json",
			dataDir: "/tmp/migration-data",
		});
		expect(parseCliArgs(["/tmp/union", "--unknown"])).toBeNull();

		const { cache, data } = makeCache(warpNodes());
		const manifestPath = join(data, "m.json");
		await runMigration({ cacheDir: cache, apply: false, dataDir: data, identities: proof(), manifestPath });
		const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Obj;
		expect(m.migration).toBe(MIGRATION_NAME);
		expect(m.removed).toEqual(["nodes/label/warp-records.json"]);
		expect(m.renamed).toEqual({});
		expect(m.redirects).toEqual({ "label:warp-records": "label:warp" });
	});
});
