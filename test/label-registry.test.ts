import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { loadRedirects, parseSlugRedirects } from "../src/genre-registry.js";
import {
	createLabelRegistry,
	type LabelIdentityGroup,
	labelBaseOf,
	loadLabelIdentities,
	parseLabelIdentities,
} from "../src/label-registry.js";
import type { LabelNode, Slug } from "../src/types.js";

// TRA-607. A label edge is canonicalized onto an existing label only when its identity is proven: a live
// node, a redirect, a group of the TRA-600/608 identity table, or the same mbid. A name that merely
// normalizes to the same body (Virgin, KMS, Plus 8, six "Axis Records" on MusicBrainz) proves nothing.

const WARP_MBID = "46f0f4cd-8aab-4b33-b698-f459faf64190";
const OTHER_MBID = "11111111-2222-4333-8444-555555555555";

let dir: string;
let cache: NodeCache;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-label-registry-"));
	cache = new NodeCache(join(dir, "cache"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function labelNode(slug: Slug, name: string, mbid?: string): LabelNode {
	return {
		type: "label",
		slug,
		name,
		editorial_article: "A real long article about this label, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_description: "A short description.",
		citations: [{ url: "https://example.com/label" }],
		materialized_at: "2026-10-24T00:00:00.000Z",
		genres: [],
		roster: [],
		notable_releases: [],
		...(mbid ? { mbid } : {}),
	};
}

const WARP_TABLE = {
	groups: [{ key: "warp", members: ["label:warp", "label:warp-records"], mbids: [WARP_MBID] }],
};

const warpGroups = (): LabelIdentityGroup[] => parseLabelIdentities(WARP_TABLE);
const redirects = (entries: Record<string, string>) => parseSlugRedirects({ redirects: entries });

describe("labelBaseOf", () => {
	it("strips the company suffixes and nothing else", () => {
		expect(labelBaseOf("label:warp-records")).toBe("warp");
		expect(labelBaseOf("label:warp")).toBe("warp");
		expect(labelBaseOf("label:hotflush-recordings")).toBe("hotflush");
		expect(labelBaseOf("label:foolek-music")).toBe("foolek");
		expect(labelBaseOf("label:acme-records-ltd")).toBe("acme");
		expect(labelBaseOf("label:plus-8-records")).toBe("plus-8");
	});

	it("gives up on a disambiguated slug and on a slug that is only a suffix", () => {
		expect(labelBaseOf("label:columbia-records--american-major-label-founded-1888")).toBeUndefined();
		expect(labelBaseOf("label:records")).toBeUndefined();
	});
});

describe("parseLabelIdentities", () => {
	it("reads the groups and lowercases their mbids", () => {
		const groups = parseLabelIdentities({
			groups: [
				{
					key: "virgin",
					members: ["label:virgin", "label:virgin-records"],
					mbids: [WARP_MBID.toUpperCase()],
				},
			],
		});
		expect(groups).toHaveLength(1);
		expect(groups[0]?.members).toEqual(["label:virgin", "label:virgin-records"]);
		expect([...(groups[0]?.mbids ?? [])]).toEqual([WARP_MBID]);
	});

	it("throws on a malformed table instead of reading less proof", () => {
		expect(() =>
			parseLabelIdentities({ groups: [{ key: "x", members: ["artist:x"], mbids: [] }] }),
		).toThrow();
		expect(() => parseLabelIdentities({ groups: [{ key: "x", members: [], mbids: ["nope"] }] })).toThrow();
		expect(() => parseLabelIdentities({ nope: true })).toThrow();
	});

	// data/label-identities.json is a copy of the proven groups of the migration's table (see label-registry.ts).
	// A group proven there but missing here, or a refused one that crept in, would change what the pipeline merges.
	it("matches the proven groups of the migration's table, and only those", async () => {
		const source = JSON.parse(
			readFileSync("scripts/migrations/2026-10-20-merge-duplicate-labels.identities.json", "utf8"),
		) as {
			groups: {
				key: string;
				status: string;
				members: string[];
				mb?: { mbid: string };
				brands?: { mbid: string }[];
			}[];
		};
		const proven = source.groups
			.filter((g) => g.status === "proven")
			.map((g) => ({
				key: g.key,
				members: g.members,
				mbids: [
					...new Set(
						[g.mb?.mbid, ...(g.brands ?? []).map((b) => b.mbid)]
							.filter((id): id is string => id !== undefined)
							.map((id) => id.toLowerCase()),
					),
				].sort(),
			}));
		const loaded = (await loadLabelIdentities()).map((g) => ({
			key: g.key,
			members: [...g.members],
			mbids: [...g.mbids].sort(),
		}));
		expect(loaded).toEqual(proven);
		expect(loaded.length).toBeGreaterThan(0);
	});

	it("loads the committed table", async () => {
		const groups = await loadLabelIdentities();
		const warp = groups.find((g) => g.key === "warp");
		expect(warp?.members).toEqual(["label:warp", "label:warp-records"]);
		expect(warp?.mbids.has(WARP_MBID)).toBe(true);
	});

	it("is empty, not an error, when the table is absent", async () => {
		expect(await loadLabelIdentities(join(dir, "missing.identities.json"))).toEqual([]);
	});

	it("still throws on a present but invalid file", async () => {
		const path = join(dir, "bad.identities.json");
		await writeFile(path, "{ not json");
		await expect(loadLabelIdentities(path)).rejects.toThrow();
	});
});

describe("canonicalSlugFor", () => {
	it("keeps a slug that has a live node, even when a redirect names it", async () => {
		await cache.write(labelNode("label:warp-records", "Warp Records"));
		const registry = createLabelRegistry({
			cache,
			redirects: redirects({ "label:warp-records": "label:warp" }),
			identities: warpGroups(),
		});
		expect(await registry.canonicalSlugFor({ slug: "label:warp-records" })).toBe("label:warp-records");
	});

	it("follows a redirect: a merged loser does not come back", async () => {
		await cache.write(labelNode("label:warp", "Warp"));
		const registry = createLabelRegistry({
			cache,
			redirects: redirects({ "label:warp-records": "label:warp" }),
		});
		expect(await registry.canonicalSlugFor({ slug: "label:warp-records" })).toBe("label:warp");
	});

	it("follows the committed redirects (Warp Records, Columbia Records, Virgin)", async () => {
		const registry = createLabelRegistry({ cache, redirects: await loadRedirects() });
		expect(await registry.canonicalSlugFor({ slug: "label:warp-records" })).toBe("label:warp");
		expect(await registry.canonicalSlugFor({ slug: "label:columbia-records" })).toBe("label:columbia");
		expect(await registry.canonicalSlugFor({ slug: "label:virgin" })).toBe("label:virgin-records");
	});

	describe("an edge whose mbid is another label's does not follow a redirect (B1)", () => {
		// 4AD's ancestor, one of the seven "Axis Records" of MusicBrainz; Jeff Mills's Axis is 0aa73845.
		const FOREIGN_AXIS = "d6025dee-9ac4-4790-ac52-b83bb032b23e";
		const AXIS_MBID = "0aa73845-13c6-49fc-935f-82b8db65cd8e";

		it("keeps label:axis-records on the committed redirects, and leaves label:axis alone", async () => {
			await cache.write(labelNode("label:axis", "Axis"));
			const registry = createLabelRegistry({
				cache,
				redirects: await loadRedirects(),
				identities: await loadLabelIdentities(),
			});
			expect(await registry.canonicalSlugFor({ slug: "label:axis-records", mbid: FOREIGN_AXIS })).toBe(
				"label:axis-records",
			);
			// The same name with Axis's own mbid, or none, is still the merged loser.
			expect(await registry.canonicalSlugFor({ slug: "label:axis-records", mbid: AXIS_MBID })).toBe(
				"label:axis",
			);
			expect(await registry.canonicalSlugFor({ slug: "label:axis-records" })).toBe("label:axis");
			// Epic and Virgin, merged the other way round, are protected the same way.
			expect(await registry.canonicalSlugFor({ slug: "label:epic-records", mbid: FOREIGN_AXIS })).toBe(
				"label:epic-records",
			);
			expect(await registry.canonicalSlugFor({ slug: "label:virgin", mbid: FOREIGN_AXIS })).toBe(
				"label:virgin",
			);
		});

		it("does not take the Wikidata-only mbid of the other Columbia as a proof", async () => {
			const registry = createLabelRegistry({
				cache,
				redirects: await loadRedirects(),
				identities: await loadLabelIdentities(),
			});
			// EMI's Columbia Records (GB): P966 on Wikidata's Columbia item, but another MusicBrainz label.
			const emiColumbia = "ad6f8706-c95e-443b-8579-8e3ecd27126c";
			expect(await registry.canonicalSlugFor({ slug: "label:columbia-records", mbid: emiColumbia })).toBe(
				"label:columbia-records",
			);
		});

		it("also holds against the mbid of the redirect target's cached node", async () => {
			await cache.write(labelNode("label:foo", "Foo", OTHER_MBID));
			const registry = createLabelRegistry({
				cache,
				redirects: redirects({ "label:foo-records": "label:foo" }),
			});
			expect(await registry.canonicalSlugFor({ slug: "label:foo-records", mbid: WARP_MBID })).toBe(
				"label:foo-records",
			);
			expect(await registry.canonicalSlugFor({ slug: "label:foo-records", mbid: OTHER_MBID })).toBe(
				"label:foo",
			);
		});
	});

	it("sends a suffix variant to the group's survivor when the mbid is the group's", async () => {
		const registry = createLabelRegistry({
			cache,
			redirects: redirects({ "label:warp-records": "label:warp" }),
			identities: warpGroups(),
		});
		// "Warp Recordings" is in no table entry: its mbid, the group's, is what proves it.
		expect(await registry.canonicalSlugFor({ slug: "label:warp-recordings", mbid: WARP_MBID })).toBe(
			"label:warp",
		);
	});

	it("matches the mbid whatever its case", async () => {
		const registry = createLabelRegistry({
			cache,
			redirects: redirects({ "label:warp-records": "label:warp" }),
			identities: warpGroups(),
		});
		expect(await registry.canonicalSlugFor({ slug: "label:warp-music", mbid: WARP_MBID.toUpperCase() })).toBe(
			"label:warp",
		);
	});

	it("leaves a homonym alone: the group's mbid on a name that is not a variant proves nothing", async () => {
		const registry = createLabelRegistry({
			cache,
			redirects: redirects({ "label:warp-records": "label:warp" }),
			identities: warpGroups(),
		});
		expect(await registry.canonicalSlugFor({ slug: "label:warp-japan", mbid: WARP_MBID })).toBe(
			"label:warp-japan",
		);
	});

	it("leaves a homonym alone: a variant of the right name without the group's mbid", async () => {
		const registry = createLabelRegistry({
			cache,
			redirects: redirects({ "label:warp-records": "label:warp" }),
			identities: warpGroups(),
		});
		expect(await registry.canonicalSlugFor({ slug: "label:warp-recordings" })).toBe("label:warp-recordings");
		expect(await registry.canonicalSlugFor({ slug: "label:warp-recordings", mbid: OTHER_MBID })).toBe(
			"label:warp-recordings",
		);
	});

	it("does not treat a group absent from the table (a refused one) as a proof", async () => {
		await cache.write(labelNode("label:axis", "Axis"));
		const registry = createLabelRegistry({ cache, redirects: new Map(), identities: warpGroups() });
		expect(await registry.canonicalSlugFor({ slug: "label:axis-records" })).toBe("label:axis-records");
	});

	it("before the merge ran, lands on the member that has a node", async () => {
		await cache.write(labelNode("label:warp-records", "Warp Records"));
		const registry = createLabelRegistry({ cache, redirects: new Map(), identities: warpGroups() });
		expect(await registry.canonicalSlugFor({ slug: "label:warp" })).toBe("label:warp-records");
	});

	it("leaves a table member alone when nothing says where it goes", async () => {
		const registry = createLabelRegistry({ cache, redirects: new Map(), identities: warpGroups() });
		expect(await registry.canonicalSlugFor({ slug: "label:warp" })).toBe("label:warp");
	});

	describe("without a table", () => {
		it("still follows redirects", async () => {
			const registry = createLabelRegistry({
				cache,
				redirects: redirects({ "label:warp-records": "label:warp" }),
			});
			expect(await registry.canonicalSlugFor({ slug: "label:warp-records" })).toBe("label:warp");
		});

		it("merges nothing on a name alone, nor on a mbid the cache does not hold", async () => {
			await cache.write(labelNode("label:foo", "Foo"));
			const registry = createLabelRegistry({ cache, redirects: new Map() });
			expect(await registry.canonicalSlugFor({ slug: "label:foo-records" })).toBe("label:foo-records");
			expect(await registry.canonicalSlugFor({ slug: "label:foo-records", mbid: OTHER_MBID })).toBe(
				"label:foo-records",
			);
		});
	});

	describe("same mbid on a cached node", () => {
		it("sends x-records to a cached x carrying the same mbid", async () => {
			await cache.write(labelNode("label:foo", "Foo", OTHER_MBID));
			const registry = createLabelRegistry({ cache, redirects: new Map() });
			expect(await registry.canonicalSlugFor({ slug: "label:foo-records", mbid: OTHER_MBID })).toBe(
				"label:foo",
			);
		});

		it("and x to a cached x-records, the other way round", async () => {
			await cache.write(labelNode("label:foo-records", "Foo Records", OTHER_MBID));
			const registry = createLabelRegistry({ cache, redirects: new Map() });
			expect(await registry.canonicalSlugFor({ slug: "label:foo", mbid: OTHER_MBID })).toBe(
				"label:foo-records",
			);
		});

		it("keeps the slug when the cached homonym has another mbid", async () => {
			await cache.write(labelNode("label:stand-high", "Stand High", WARP_MBID));
			const registry = createLabelRegistry({ cache, redirects: new Map() });
			expect(await registry.canonicalSlugFor({ slug: "label:stand-high-records", mbid: OTHER_MBID })).toBe(
				"label:stand-high-records",
			);
		});

		it("keeps the slug when the cached homonym has no mbid, or the ref has none", async () => {
			await cache.write(labelNode("label:dor-et-de-platine", "Dor et de Platine"));
			await cache.write(labelNode("label:stand-high", "Stand High", OTHER_MBID));
			const registry = createLabelRegistry({ cache, redirects: new Map() });
			expect(
				await registry.canonicalSlugFor({ slug: "label:dor-et-de-platine-records", mbid: OTHER_MBID }),
			).toBe("label:dor-et-de-platine-records");
			expect(await registry.canonicalSlugFor({ slug: "label:stand-high-records" })).toBe(
				"label:stand-high-records",
			);
		});

		it("never merges a disambiguated slug on a name", async () => {
			await cache.write(labelNode("label:foo", "Foo", OTHER_MBID));
			const registry = createLabelRegistry({ cache, redirects: new Map() });
			expect(await registry.canonicalSlugFor({ slug: "label:foo--1999", mbid: OTHER_MBID })).toBe(
				"label:foo--1999",
			);
		});
	});
});

describe("canonicalizeNodeEdges", () => {
	const edge = (slug: Slug, name: string, extra: Record<string, unknown> = {}) => ({
		type: "label",
		slug,
		name,
		...extra,
	});

	function registry() {
		return createLabelRegistry({
			cache,
			redirects: redirects({ "label:warp-records": "label:warp" }),
			identities: warpGroups(),
		});
	}

	it("canonicalizes artist.labels and de-duplicates by final slug, first occurrence wins", async () => {
		const node = {
			type: "artist",
			slug: "artist:aphex-twin",
			labels: [
				edge("label:warp", "Warp"),
				edge("label:warp-records", "Warp Records"),
				edge("label:rephlex", "Rephlex"),
			],
			genres: [{ type: "genre", slug: "genre:techno", name: "Techno" }],
		};
		await registry().canonicalizeNodeEdges(node);
		expect(node.labels.map((l) => l.slug)).toEqual(["label:warp", "label:rephlex"]);
		expect(node.labels[0]?.name).toBe("Warp");
		expect(node.genres[0]?.slug).toBe("genre:techno");
	});

	it("keeps the edge's own name and mbid when it is redirected", async () => {
		const node = {
			type: "artist",
			slug: "artist:autechre",
			labels: [edge("label:warp-records", "Warp Records", { mbid: WARP_MBID })],
		};
		await registry().canonicalizeNodeEdges(node);
		expect(node.labels).toEqual([edge("label:warp", "Warp Records", { mbid: WARP_MBID })]);
	});

	it("canonicalizes the single label of a project and of a track", async () => {
		const project = {
			type: "project",
			slug: "project:x--y",
			label: edge("label:warp-records", "Warp Records"),
		};
		const track = { type: "track", slug: "track:x--y", label: edge("label:warp-records", "Warp Records") };
		await registry().canonicalizeNodeEdges(project);
		await registry().canonicalizeNodeEdges(track);
		expect(project.label.slug).toBe("label:warp");
		expect(track.label.slug).toBe("label:warp");
	});

	it("canonicalizes genre.key_labels", async () => {
		const node = {
			type: "genre",
			slug: "genre:idm",
			key_labels: [edge("label:warp-records", "Warp Records"), edge("label:warp", "Warp")],
		};
		await registry().canonicalizeNodeEdges(node);
		expect(node.key_labels.map((l) => l.slug)).toEqual(["label:warp"]);
	});

	it("keeps the mbid of a later duplicate when the first occurrence has none", async () => {
		const node = {
			type: "artist",
			slug: "artist:autechre",
			labels: [edge("label:warp", "Warp"), edge("label:warp-records", "Warp Records", { mbid: WARP_MBID })],
		};
		await registry().canonicalizeNodeEdges(node);
		expect(node.labels).toEqual([edge("label:warp", "Warp", { mbid: WARP_MBID })]);
	});

	it("does not move a table member whose own mbid is another label's", async () => {
		await cache.write(labelNode("label:warp-records", "Warp Records"));
		const node = {
			type: "artist",
			slug: "artist:x",
			labels: [edge("label:warp", "Warp", { mbid: OTHER_MBID })],
		};
		// Before the merge ran, an unmbid'd "Warp" would land on the live label:warp-records (see above); with
		// a foreign mbid it stays its own label.
		await createLabelRegistry({
			cache,
			redirects: new Map(),
			identities: warpGroups(),
		}).canonicalizeNodeEdges(node);
		expect(node.labels.map((l) => l.slug)).toEqual(["label:warp"]);
	});

	it("leaves a node without label edges, or a non-node, alone", async () => {
		const node = {
			type: "label",
			slug: "label:warp",
			roster: [{ type: "artist", slug: "artist:a", name: "A" }],
		};
		const before = JSON.stringify(node);
		await registry().canonicalizeNodeEdges(node);
		await registry().canonicalizeNodeEdges(null);
		await registry().canonicalizeNodeEdges("label:warp");
		expect(JSON.stringify(node)).toBe(before);
	});
});
