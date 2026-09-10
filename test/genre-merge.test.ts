import { describe, expect, it } from "vitest";
import {
	type ElectionCandidate,
	electCanonical,
	mergeGenreEdges,
	mergeRedirects,
	rewriteNodeEdges,
	rewritePendingReverses,
	unionListField,
	unionSingularField,
} from "../scripts/migrations/2026-09-04-merge-genre-duplicates.js";
import type { PendingReverse } from "../src/cache.js";
import type { ArtistNode, EdgeRef, GenreNode } from "../src/types.js";

function artistNode(overrides: Partial<ArtistNode> = {}): ArtistNode {
	return {
		type: "artist",
		slug: "artist:test-artist",
		name: "Test Artist",
		editorial_bio: "A test artist bio.",
		editorial_article: "A real long article about the test artist. ".repeat(4),
		citations: [{ url: "https://example.com/test-artist", title: "Test Artist" }],
		materialized_at: new Date().toISOString(),
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		...overrides,
	};
}

function genreNode(overrides: Partial<GenreNode> = {}): GenreNode {
	return {
		type: "genre",
		slug: "genre:test-genre",
		name: "Test Genre",
		editorial_definition: "A test genre definition.",
		editorial_article: "A real long article about the test genre. ".repeat(4),
		citations: [{ url: "https://example.com/test-genre", title: "Test Genre" }],
		materialized_at: new Date().toISOString(),
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
		...overrides,
	};
}

describe("electCanonical", () => {
	it("elects by usage count outright, even when the other member carries the catalog name (2026-09-10 reversal)", () => {
		const members: ElectionCandidate[] = [
			{ slug: "genre:electronic", name: "Electronic", usages: 179 },
			{ slug: "genre:electronic-music", name: "Electronic music", usages: 61 },
		];
		const result = electCanonical(members, "electronic music");
		expect(result.winner.slug).toBe("genre:electronic");
		expect(result.criterion).toBe("usage-count");
		expect(result.losers).toEqual([members[1]]);
	});

	it("at a tied usage count, the catalog name tiebreaks; then the shortest slug; then lex order", () => {
		const tiedByUsage: ElectionCandidate[] = [
			{ slug: "genre:foo", name: "Foo", usages: 5 },
			{ slug: "genre:bar", name: "Bar", usages: 5 },
		];
		expect(electCanonical(tiedByUsage, "bar").winner.slug).toBe("genre:bar");
		expect(electCanonical(tiedByUsage, "bar").criterion).toBe("catalog-name");

		const tiedByUsageAndName: ElectionCandidate[] = [
			{ slug: "genre:longer-slug", name: "A", usages: 5 },
			{ slug: "genre:short", name: "B", usages: 5 },
		];
		expect(electCanonical(tiedByUsageAndName, undefined).winner.slug).toBe("genre:short");
		expect(electCanonical(tiedByUsageAndName, undefined).criterion).toBe("slug-length");

		const tiedByEverything: ElectionCandidate[] = [
			{ slug: "genre:zzz", name: "A", usages: 5 },
			{ slug: "genre:aaa", name: "B", usages: 5 },
		];
		expect(electCanonical(tiedByEverything, undefined).winner.slug).toBe("genre:aaa");
		expect(electCanonical(tiedByEverything, undefined).criterion).toBe("slug-lex-order");
	});

	it("is deterministic: the same group in a different order elects the same winner", () => {
		const members: ElectionCandidate[] = [
			{ slug: "genre:electronic", name: "Electronic", usages: 179 },
			{ slug: "genre:electronic-music", name: "Electronic music", usages: 61 },
		];
		const forward = electCanonical(members, "electronic music");
		const reversed = electCanonical([...members].reverse(), "electronic music");
		expect(forward.winner.slug).toBe(reversed.winner.slug);
		expect(forward.criterion).toBe(reversed.criterion);
	});
});

describe("unionListField", () => {
	it("merges the winner's and loser's edges, deduplicated by slug, first occurrence wins", () => {
		const winnerList: EdgeRef[] = [{ slug: "genre:house", type: "genre", name: "House" }];
		const loserList: EdgeRef[] = [
			{ slug: "genre:house", type: "genre", name: "House (stale copy)" },
			{ slug: "genre:techno", type: "genre", name: "Techno" },
		];
		const merged = unionListField(winnerList, [loserList]);
		expect(merged).toEqual([
			{ slug: "genre:house", type: "genre", name: "House" },
			{ slug: "genre:techno", type: "genre", name: "Techno" },
		]);
	});
});

describe("unionSingularField", () => {
	it("keeps the canonical's value when present", () => {
		expect(unionSingularField("canonical-value", ["loser-value"])).toBe("canonical-value");
	});

	it("falls back to the first non-empty loser value when the canonical's is empty", () => {
		expect(unionSingularField(undefined, [undefined, "loser-value"])).toBe("loser-value");
	});
});

describe("mergeGenreEdges", () => {
	it("unions edge fields but keeps the canonical's editorial body untouched, never concatenated", () => {
		const winner = genreNode({
			slug: "genre:electronic-music",
			editorial_article: "Canonical article.",
			editorial_definition: "Canonical definition.",
			subgenres: [{ slug: "genre:house", type: "genre", name: "House" }],
		});
		const loser = genreNode({
			slug: "genre:electronic",
			editorial_article: "Loser article.",
			editorial_definition: "Loser definition.",
			subgenres: [
				{ slug: "genre:house", type: "genre", name: "House" },
				{ slug: "genre:techno", type: "genre", name: "Techno" },
			],
		});

		const merged = mergeGenreEdges(winner as unknown as Record<string, unknown>, [
			loser as unknown as Record<string, unknown>,
		]);

		expect(merged.editorial_article).toBe("Canonical article.");
		expect(merged.editorial_definition).toBe("Canonical definition.");
		expect(merged.subgenres).toEqual([
			{ slug: "genre:house", type: "genre", name: "House" },
			{ slug: "genre:techno", type: "genre", name: "Techno" },
		]);
	});
});

describe("rewriteNodeEdges", () => {
	it("collapses a third-party node's references to both group members into one canonical reference", () => {
		const thirdParty = artistNode({
			genres: [
				{ slug: "genre:electronic", type: "genre", name: "Electronic" },
				{ slug: "genre:electronic-music", type: "genre", name: "Electronic music" },
			],
		});
		const rewriteMap = new Map([["genre:electronic", "genre:electronic-music"]]);

		const { node, hits } = rewriteNodeEdges(
			thirdParty as unknown as Record<string, unknown>,
			"artist",
			rewriteMap,
		);

		// Only the slug is rewritten (per contract); the first occurrence in the list wins the
		// dedupe, so the surviving entry keeps the first edge's own `name`.
		expect(node.genres).toEqual([{ slug: "genre:electronic-music", type: "genre", name: "Electronic" }]);
		expect(hits.get("genre:electronic")).toBe(1);
	});
});

describe("mergeRedirects", () => {
	it("flattens a chain: a -> b then b -> c becomes a -> c and b -> c", () => {
		const existing = { "genre:a": "genre:b" };
		const additions = { "genre:b": "genre:c" };
		const merged = mergeRedirects(existing, additions);
		expect(merged).toEqual({ "genre:a": "genre:c", "genre:b": "genre:c" });
	});

	it("never amputates a preexisting table when there are no new redirects", () => {
		const existing = { "genre:x": "genre:y", "genre:p": "genre:q" };
		const merged = mergeRedirects(existing, {});
		expect(merged).toEqual(existing);
	});

	it("never stores a value that is also a key", () => {
		const existing = { "genre:a": "genre:b" };
		const additions = { "genre:b": "genre:c", "genre:d": "genre:c" };
		const merged = mergeRedirects(existing, additions);
		const keys = new Set(Object.keys(merged));
		for (const value of Object.values(merged)) {
			expect(keys.has(value)).toBe(false);
		}
	});
});

describe("rewritePendingReverses", () => {
	it("rewrites a loser key to its canonical, merging with any list already there, and rewrites edge.slug too", () => {
		const pending = {
			"genre:electronic": [
				{
					field: "genres",
					cardinality: "list" as const,
					edge: { slug: "artist:someone" as const, type: "artist" as const, name: "Someone" },
				},
			],
			"genre:electronic-music": [
				{
					field: "genres",
					cardinality: "list" as const,
					edge: { slug: "artist:someone-else" as const, type: "artist" as const, name: "Someone Else" },
				},
			],
			"artist:third-party": [
				{
					field: "genres",
					cardinality: "list" as const,
					// This entry's own edge points at a loser too -- both key and edge.slug rewrites
					// must apply independently in the same pass.
					edge: { slug: "genre:electronic" as const, type: "genre" as const, name: "Electronic" },
				},
			],
		} satisfies Record<string, PendingReverse[]>;
		const rewriteMap = new Map([["genre:electronic", "genre:electronic-music"]]);

		const { result, changed } = rewritePendingReverses(pending, rewriteMap);

		expect(changed).toBe(true);
		expect(result["genre:electronic"]).toBeUndefined();
		expect(result["genre:electronic-music"]).toHaveLength(2);
		expect(result["artist:third-party"]?.[0]?.edge.slug).toBe("genre:electronic-music");
	});

	it("reports no change when nothing in the table touches a loser slug", () => {
		const pending = {
			"artist:untouched": [
				{
					field: "genres",
					cardinality: "list" as const,
					edge: { slug: "genre:techno" as const, type: "genre" as const, name: "Techno" },
				},
			],
		} satisfies Record<string, PendingReverse[]>;
		const { changed } = rewritePendingReverses(
			pending,
			new Map([["genre:electronic", "genre:electronic-music"]]),
		);
		expect(changed).toBe(false);
	});
});
