import { describe, expect, it } from "vitest";
import { enqueueEdges, FrontierQueue } from "../src/crawler.js";
import type { ArtistNode } from "../src/types.js";

/** Minimal valid ArtistNode, only the fields enqueueEdges actually reads matter here. */
function artistNode(overrides: Partial<ArtistNode> = {}): ArtistNode {
	return {
		type: "artist",
		slug: "artist:fixture-artist",
		name: "Fixture Artist",
		editorial_bio: "A short bio.",
		editorial_article: "A real long article about this artist, well past the eighty character floor. ".repeat(
			2,
		),
		citations: [{ url: "https://example.com/fixture-artist" }],
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

// TRA-28 review, B1: canonicalizeNodeEdges rewrites a genre edge's `slug` without touching its
// `name` (genre-registry.ts) -- edge.slug === makeSlug(edge.type, edge.name) is NOT an invariant
// once a genre edge has been canonicalized. enqueueEdges used to re-derive the frontier key from
// `e.name` instead of reading the already-canonical `e.slug`, so a genre edge canonicalized onto
// an existing node under another slug got enqueued under a fresh, name-derived slug the
// crawler's own cache.has() dedup check (in crawl()'s worker loop) could never match -- minting
// a second, orphaned duplicate node for a target that was never actually missing.
describe("enqueueEdges (TRA-28 review B1)", () => {
	it("enqueues a canonicalized genre edge under its own slug, not one re-derived from its display name", () => {
		const frontier = new FrontierQueue();
		const node = artistNode({
			genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic Music", qid: "Q9778" }],
		});
		const logs: string[] = [];

		enqueueEdges(node, 1, frontier, (s) => logs.push(s));

		expect(frontier.size()).toBe(1);
		const popped = frontier.pop();
		// Before the fix this was "genre:electronic-music" (makeSlug("genre", "Electronic Music")):
		// a different slug than the one the edge was actually canonicalized onto.
		expect(popped?.slug).toBe("genre:electronic");
		expect(popped?.entry.input).toMatchObject({
			type: "genre",
			name: "Electronic Music",
			slug: "genre:electronic",
		});
		expect(logs.some((l) => l.includes("+ frontier genre:electronic "))).toBe(true);
		expect(logs.some((l) => l.includes("electronic-music"))).toBe(false);
	});

	it("still derives a synthetic-slug-free key correctly for a non-genre edge (no regression)", () => {
		const frontier = new FrontierQueue();
		const node = artistNode({
			labels: [{ type: "label", slug: "label:fixture-label", name: "Fixture Label" }],
		});
		const logs: string[] = [];

		enqueueEdges(node, 0, frontier, (s) => logs.push(s));

		const popped = frontier.pop();
		expect(popped?.slug).toBe("label:fixture-label");
		expect(popped?.entry.input.name).toBe("Fixture Label");
	});
});
