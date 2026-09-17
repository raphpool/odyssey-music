import { describe, expect, it } from "vitest";
import { buildGenreSeedPlan, enqueueEdges, FrontierQueue } from "../src/crawler.js";
import type { GenreRegistry } from "../src/genre-registry.js";
import type { GenreSeed } from "../src/genre-seeds.js";
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

	// TRA-43: a genre edge carrying a qid must produce a PipelineInput with that same qid, so a
	// rematerialization at this frontier target is stamped with the edge's own identity instead
	// of a fresh by-name resolve that could land on a different QID (2026-09-10).
	it("forwards a genre edge's qid onto the enqueued PipelineInput", () => {
		const frontier = new FrontierQueue();
		const node = artistNode({
			genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic Music", qid: "Q9778" }],
		});

		enqueueEdges(node, 1, frontier, () => {});

		const popped = frontier.pop();
		expect(popped?.entry.input.qid).toBe("Q9778");
	});

	it("leaves PipelineInput.qid unset for an edge without one (no undefined leaking through)", () => {
		const frontier = new FrontierQueue();
		const node = artistNode({
			labels: [{ type: "label", slug: "label:fixture-label", name: "Fixture Label" }],
		});

		enqueueEdges(node, 0, frontier, () => {});

		const popped = frontier.pop();
		expect(popped?.entry.input.qid).toBeUndefined();
		expect(popped?.entry.input).not.toHaveProperty("qid");
	});
});

describe("buildGenreSeedPlan (TRA-61)", () => {
	const folder: GenreSeed = {
		genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" },
		anchors: [{ slug: "genre:hip-hop", name: "Hip hop", qid: "Q11401" }],
		targets: [
			{
				type: "artist",
				name: "Fixture Artist",
				slug: "artist:fixture-artist",
				mbid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			},
			{ type: "track", name: "Fixture Track", slug: "track:fixture-track" },
		],
	};

	it("preserves seed identities, reuses the canonical genre, and puts anchors before explicit targets", async () => {
		const seen: Array<{ slug: string; qid?: string }> = [];
		const registry: Pick<GenreRegistry, "canonicalSlugFor"> = {
			canonicalSlugFor: async (ref) => {
				seen.push({ slug: ref.slug, ...(ref.qid ? { qid: ref.qid } : {}) });
				if (ref.qid === "Q2913982") return { slug: "genre:cached-trap", qid: ref.qid };
				return ref.qid ? { slug: ref.slug, qid: ref.qid } : { slug: ref.slug };
			},
		};

		const plan = await buildGenreSeedPlan(folder, registry);

		expect(seen).toEqual([
			{ slug: "genre:hip-hop", qid: "Q11401" },
			{ slug: "genre:trap-hip-hop", qid: "Q2913982" },
		]);
		expect(plan.map(({ stage, input }) => ({ stage, input }))).toEqual([
			{
				stage: "anchor",
				input: { type: "genre", name: "Hip hop", slug: "genre:hip-hop", qid: "Q11401" },
			},
			{
				stage: "genre",
				input: { type: "genre", name: "Trap Hip-Hop", slug: "genre:cached-trap", qid: "Q2913982" },
			},
			{
				stage: "target",
				input: {
					type: "artist",
					name: "Fixture Artist",
					slug: "artist:fixture-artist",
					mbid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				},
			},
			{
				stage: "target",
				input: { type: "track", name: "Fixture Track", slug: "track:fixture-track" },
			},
		]);
	});

	// TRA-254: a folder's genre disambiguator (e.g. distinguishing Afrobeats pop from Fela
	// Kuti's Afrobeat) must reach the pipeline input for the genre stage, without changing the
	// canonical slug or QID the registry already resolved.
	it("forwards the folder genre's disambiguator onto the genre stage's pipeline input", async () => {
		const disambiguatedFolder: GenreSeed = {
			...folder,
			genre: {
				...folder.genre,
				disambiguator: "2000s pop, distinct from Fela Kuti's Afrobeat",
			},
		};
		const registry: Pick<GenreRegistry, "canonicalSlugFor"> = {
			canonicalSlugFor: async (ref) => (ref.qid ? { slug: ref.slug, qid: ref.qid } : { slug: ref.slug }),
		};

		const plan = await buildGenreSeedPlan(disambiguatedFolder, registry);

		const genreEntry = plan.find(({ stage }) => stage === "genre");
		expect(genreEntry?.input).toEqual({
			type: "genre",
			name: "Trap Hip-Hop",
			slug: "genre:trap-hip-hop",
			qid: "Q2913982",
			disambiguator: "2000s pop, distinct from Fela Kuti's Afrobeat",
		});
	});

	// TRA-254 code review: genre-seeds.ts's targetSchema also accepts a disambiguator (for a
	// homonymous target such as a same-named artist), so buildGenreSeedPlan must not drop it.
	it("forwards a target's disambiguator onto its pipeline input", async () => {
		const disambiguatedFolder: GenreSeed = {
			...folder,
			targets: [
				{
					type: "artist",
					name: "Fixture Artist",
					slug: "artist:fixture-artist",
					disambiguator: "British rock band, not the American rapper",
				},
			],
		};
		const registry: Pick<GenreRegistry, "canonicalSlugFor"> = {
			canonicalSlugFor: async (ref) => (ref.qid ? { slug: ref.slug, qid: ref.qid } : { slug: ref.slug }),
		};

		const plan = await buildGenreSeedPlan(disambiguatedFolder, registry);

		const targetEntry = plan.find(({ stage }) => stage === "target");
		expect(targetEntry?.input).toEqual({
			type: "artist",
			name: "Fixture Artist",
			slug: "artist:fixture-artist",
			disambiguator: "British rock band, not the American rapper",
		});
	});
});
