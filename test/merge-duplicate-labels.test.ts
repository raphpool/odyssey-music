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

	it.each([
		[
			"a better source on the loser wins (logo over derived cover)",
			"derived-cover",
			"wikidata-p154",
			"loser",
		],
		["an equal source keeps the survivor's", "caa", "caa", "survivor"],
		["a worse source on the loser never wins", "wikidata-p154", "derived-cover", "survivor"],
		["no image on the survivor takes the loser's", undefined, "derived-cover", "loser"],
	] as const)("image: %s", async (_label, own, other, expected) => {
		const image = (who: string, source?: string): Obj =>
			source ? { image_url: `https://coverartarchive.org/${who}/front-500`, image_source: source } : {};
		const nodes = warpNodes().map((n) =>
			n.slug === "label:warp"
				? { ...n, ...image("survivor", own) }
				: n.slug === "label:warp-records"
					? { ...n, ...image("loser", other) }
					: n,
		);
		const { cache, data } = makeCache(nodes);
		const { manifest } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			identities: proof(),
		});
		expect(manifest.errors).toEqual([]);
		const winner = read(cache, "label:warp");
		expect(winner.image_url).toBe(`https://coverartarchive.org/${expected}/front-500`);
		expect(winner.image_source).toBe(expected === "loser" ? other : own);
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
		// A slug the server disambiguated ("columbia-records--american-major-label-founded-1888") keys on what
		// precedes the "--": the suffix is the disambiguator, not part of the name.
		for (const g of table.groups)
			expect(
				g.members.every((m) => groupKey(m.slice("label:".length).split("--")[0] as string) === g.key),
			).toBe(true);
	});
});

// TRA-611. Prod holds a third Columbia node the repo never had: "Columbia Records" under a slug disambiguated by
// the server ("--american-major-label-founded-1888"). The 2026-10-18 prod run refused the whole group because
// the proof table did not cover it (member-not-covered). These fixtures mirror what the public API returned on
// 2026-10-23 (names, founded, image source, an article naming the founder), trimmed to a few edges.
describe("Columbia as prod holds it (TRA-611)", () => {
	const DISAMBIGUATED = "label:columbia-records--american-major-label-founded-1888";
	const LOGO =
		"https://commons.wikimedia.org/wiki/Special:FilePath/Columbia%20Records%20Colored%20Logo.svg?width=600";
	const article = (extra: string): string =>
		`Columbia Records was founded in Washington, D.C. in 1889 by Edward D. Easton. ${extra}`.repeat(2);
	const logo = { image_url: LOGO, image_source: "wikidata-p154" };
	const bob = ref("artist:bob-dylan", "Bob Dylan");
	const miles = ref("artist:miles-davis", "Miles Davis");
	const duke = ref("artist:duke-ellington", "Duke Ellington");

	const columbiaNodes = (opts: { disambiguatedArticle?: string; withMiddle?: boolean } = {}): Obj[] => [
		// The survivor in prod still has the cover derived from a release, not the logo.
		node("label:columbia", "Columbia", {
			editorial_article: article("Home of Bob Dylan."),
			founded: "1889",
			image_url: "https://coverartarchive.org/release/abc/front-500",
			image_source: "derived-cover",
			roster: [bob, miles],
		}),
		...(opts.withMiddle === false
			? []
			: [
					node("label:columbia-records", "Columbia Records", {
						editorial_article: article("Home of Miles Davis."),
						founded: "1889",
						...logo,
						roster: [miles, duke],
					}),
				]),
		node(DISAMBIGUATED, "Columbia Records", {
			editorial_article: opts.disambiguatedArticle ?? article("Home of Duke Ellington."),
			disambiguator: "American major label founded 1888",
			founded: "1889",
			...logo,
			roster: [duke, ref("artist:frank-sinatra", "Frank Sinatra")],
			notable_releases: [ref("project:time-out", "Time Out")],
		}),
		node("artist:frank-sinatra", "Frank Sinatra", { labels: [ref(DISAMBIGUATED, "Columbia Records")] }),
		node("artist:duke-ellington", "Duke Ellington", {
			labels: [
				...(opts.withMiddle === false ? [] : [ref("label:columbia-records", "Columbia Records")]),
				ref(DISAMBIGUATED, "Columbia Records"),
			],
		}),
	];
	const committed = (): Identities => JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as Identities;
	const committedRedirects = (): Record<string, string> =>
		(JSON.parse(readFileSync("data/slug-redirects.json", "utf8")) as { redirects: Record<string, string> })
			.redirects;

	it("merges the three nodes, the disambiguated one included, into label:columbia with the logo", async () => {
		const { cache, data } = makeCache(columbiaNodes());
		// No injected table: the run reads the committed file through its own schema, as the channel does.
		const { manifest, exitCode } = await runMigration({ cacheDir: cache, apply: true, dataDir: data });

		expect(manifest.errors).toEqual([]);
		expect(exitCode).toBe(0);
		expect(manifest.refused).toEqual([]);
		expect(manifest).toMatchObject({
			removed: [
				`nodes/label/columbia-records--american-major-label-founded-1888.json`,
				"nodes/label/columbia-records.json",
			],
			redirects: { [DISAMBIGUATED]: "label:columbia", "label:columbia-records": "label:columbia" },
			merged: [
				{
					survivor: "label:columbia",
					losers: ["label:columbia-records", DISAMBIGUATED],
					chosenBy: "musicbrainz-name",
				},
			],
		});
		const winner = read(cache, "label:columbia");
		expect(slugsOf(winner.roster)).toEqual([
			"artist:bob-dylan",
			"artist:miles-davis",
			"artist:duke-ellington",
			"artist:frank-sinatra",
		]);
		// The rule of the merge: the logo (wikidata-p154) beats the derived cover the prod survivor carries.
		expect(winner).toMatchObject({ image_url: LOGO, image_source: "wikidata-p154" });
		expect(existsSync(pathOf(cache, DISAMBIGUATED))).toBe(false);
		expect(existsSync(pathOf(cache, "label:columbia-records"))).toBe(false);
		expect(read(cache, "artist:frank-sinatra").labels).toEqual([ref("label:columbia", "Columbia")]);
		// An artist that cited the plain and the disambiguated node keeps a single edge.
		expect(read(cache, "artist:duke-ellington").labels).toEqual([ref("label:columbia", "Columbia")]);
		expect(nodePayloadSchema.safeParse(winner).success).toBe(true);
	});

	it("covers the node alone too, which is what the repo cache plus this prod node makes", async () => {
		const { cache, data } = makeCache(columbiaNodes({ withMiddle: false }));
		const { manifest } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			identities: committed(),
		});
		expect(manifest.errors).toEqual([]);
		expect(manifest.refused).toEqual([]);
		expect(manifest.redirects).toEqual({ [DISAMBIGUATED]: "label:columbia" });
		expect(read(cache, "label:columbia").image_source).toBe("wikidata-p154");
	});

	it("refuses the group when the disambiguated article does not name the founder (the UK homonym)", async () => {
		const { cache, data } = makeCache(
			columbiaNodes({
				disambiguatedArticle: "Columbia Records was an EMI label in the United Kingdom. ".repeat(3),
			}),
		);
		const { manifest } = await runMigration({
			cacheDir: cache,
			apply: true,
			dataDir: data,
			identities: committed(),
		});
		expect(manifest.refused).toMatchObject([{ key: "columbia", reason: "anchor-missing" }]);
		expect(manifest).toMatchObject({ merged: [], removed: [], written: 0 });
		expect(existsSync(pathOf(cache, DISAMBIGUATED))).toBe(true);
	});

	it("has its redirects committed, and they are exactly what the migration emits (the channel refuses otherwise)", async () => {
		const { cache, data } = makeCache(columbiaNodes());
		const { manifest } = await runMigration({
			cacheDir: cache,
			apply: false,
			dataDir: data,
			identities: committed(),
		});
		expect(Object.keys(manifest.redirects)).toHaveLength(2);
		const table = committedRedirects();
		for (const [from, to] of Object.entries(manifest.redirects)) expect(table[from]).toBe(to);
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
