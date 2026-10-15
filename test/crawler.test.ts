import { afterEach, describe, expect, it } from "vitest";
import { attachFolderGenre, buildGenreSeedPlan, enqueueEdges, FrontierQueue } from "../src/crawler.js";
import type { GenreRegistry } from "../src/genre-registry.js";
import type { GenreSeed } from "../src/genre-seeds.js";
import type { PipelineInput } from "../src/pipeline.js";
import { makeSlug } from "../src/slug.js";
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
		similar_artists: [],
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

describe("attachFolderGenre (TRA-263)", () => {
	const folderGenre: PipelineInput = { type: "genre", name: "Gabber", slug: "genre:gabber", qid: "Q1085907" };

	it("adds the folder's genre edge, with its qid, when the node doesn't already cite it", () => {
		const node = artistNode({ genres: [{ type: "genre", slug: "genre:rave", name: "Rave" }] });

		const updated = attachFolderGenre(node, folderGenre);

		expect(updated).not.toBe(node);
		expect((updated as ArtistNode).genres).toEqual([
			{ type: "genre", slug: "genre:rave", name: "Rave" },
			{ type: "genre", slug: "genre:gabber", name: "Gabber", qid: "Q1085907" },
		]);
		// Only the genres field changes -- everything else is the same object/values.
		expect((updated as ArtistNode).labels).toBe(node.labels);
	});

	it("does not duplicate an edge already pointing at the folder genre's slug, even under another name", () => {
		const node = artistNode({
			genres: [{ type: "genre", slug: "genre:gabber", name: "Old Gabber Name" }],
		});

		const updated = attachFolderGenre(node, folderGenre);

		expect(updated).toBe(node);
		expect((updated as ArtistNode).genres).toEqual([
			{ type: "genre", slug: "genre:gabber", name: "Old Gabber Name" },
		]);
	});

	it("omits the qid key when the folder genre has none", () => {
		const node = artistNode({ genres: [] });
		const noQidGenre: PipelineInput = { type: "genre", name: "Gabber", slug: "genre:gabber" };

		const updated = attachFolderGenre(node, noQidGenre);

		const edge = (updated as ArtistNode).genres[0];
		expect(edge && "qid" in edge).toBe(false);
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

// TRA-476 (graph-integrity 1.5). 2026-10-14: 111 work links resolved to a homonym. The crawler keyed the
// frontier by the edge's slug and dropped its `artist` and `mbid`, so Rohff's "Fitna" was never
// materialized -- `track:fitna` (Akuma) was already cached -- and Rohff's link pointed at Akuma's node.
describe("enqueueEdges artist context (TRA-476)", () => {
	const rohff = (notable_tracks: ArtistNode["notable_tracks"]): ArtistNode =>
		artistNode({ slug: "artist:rohff", name: "Rohff", notable_tracks });
	const originalFlag = process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
	afterEach(() => {
		if (originalFlag === undefined) delete process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
		else process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = originalFlag;
	});

	it("enqueues Rohff's scoped Fitna with its artist, never the Akuma slug", () => {
		const frontier = new FrontierQueue();
		const node = rohff([{ type: "track", slug: "track:fitna--rohff", name: "Fitna", artist: "Rohff" }]);

		enqueueEdges(node, 1, frontier, () => {});

		expect(frontier.size()).toBe(1);
		const popped = frontier.pop();
		expect(popped?.slug).toBe("track:fitna--rohff");
		expect(popped?.slug).not.toBe("track:fitna--akuma");
		expect(popped?.entry.input).toMatchObject({
			type: "track",
			name: "Fitna",
			slug: "track:fitna--rohff",
			artist: "Rohff",
		});
		expect(popped?.entry.requesters).toEqual([{ slug: "artist:rohff", field: "notable_tracks" }]);
	});

	// The case that failed before TRA-462: a bare slug. The crawl worker skips any frontier slug that is
	// already cached (`skip cached`, see crawler-e2e.test.ts), so with `track:fitna` held by Akuma the edge
	// was never materialized. Pinned here so nobody reads the bare slug as a valid input again.
	it("documents the pre-TRA-462 failure: a bare slug collides with the homonym's cached node", () => {
		const frontier = new FrontierQueue();
		const bare = makeSlug("track", "Fitna");
		const node = rohff([{ type: "track", slug: bare, name: "Fitna", artist: "Rohff" }]);

		enqueueEdges(node, 1, frontier, () => {});

		// The frontier key is the Akuma node's key too: the worker's cache.has() check hits and the
		// edge is dropped. A scoped slug (`track:fitna--rohff`) has no such collision.
		expect(bare).toBe("track:fitna");
		expect(frontier.pop()?.slug).toBe("track:fitna");
	});

	it("forwards the edge's mbid onto the pipeline input, and leaves it unset otherwise", () => {
		const frontier = new FrontierQueue();
		const mbid = "11111111-2222-3333-4444-555555555555";
		const node = rohff([
			{ type: "track", slug: "track:fitna--rohff", name: "Fitna", artist: "Rohff", mbid },
			{ type: "track", slug: "track:autre--rohff", name: "Autre", artist: "Rohff" },
		]);

		enqueueEdges(node, 1, frontier, () => {});

		expect(frontier.pop()?.entry.input.mbid).toBe(mbid);
		expect(frontier.pop()?.entry.input).not.toHaveProperty("mbid");
	});

	it("records every parent that cites a target, once per field, and counts the re-push", () => {
		const frontier = new FrontierQueue();
		const edge = { type: "track", slug: "track:fitna--rohff", name: "Fitna", artist: "Rohff" } as const;
		const other = artistNode({ slug: "artist:rohff-live", name: "Rohff Live", notable_tracks: [edge] });

		enqueueEdges(rohff([edge]), 1, frontier, () => {});
		enqueueEdges(rohff([edge]), 1, frontier, () => {}); // same parent, same field: no duplicate
		enqueueEdges(other, 1, frontier, () => {});

		expect(frontier.size()).toBe(1);
		const popped = frontier.pop();
		expect(popped?.entry.refCount).toBe(3);
		expect(popped?.entry.requesters).toEqual([
			{ slug: "artist:rohff", field: "notable_tracks" },
			{ slug: "artist:rohff-live", field: "notable_tracks" },
		]);
	});

	it("keeps recording a requester that arrives after the target was popped (in flight)", () => {
		const frontier = new FrontierQueue();
		const edge = { type: "track", slug: "track:fitna--rohff", name: "Fitna", artist: "Rohff" } as const;
		enqueueEdges(rohff([edge]), 1, frontier, () => {});
		const popped = frontier.pop();

		const other = artistNode({ slug: "artist:rohff-live", name: "Rohff Live", notable_tracks: [edge] });
		enqueueEdges(other, 1, frontier, () => {});

		expect(frontier.size()).toBe(0);
		expect(popped?.entry.requesters.map((r) => r.slug)).toEqual(["artist:rohff", "artist:rohff-live"]);
	});

	it("flag on: two works sharing a bare slug but credited to different artists are not merged", () => {
		process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = "true";
		const frontier = new FrontierQueue();
		const logs: string[] = [];
		const akuma = artistNode({
			slug: "artist:akuma",
			name: "Akuma",
			notable_tracks: [{ type: "track", slug: "track:fitna", name: "Fitna", artist: "Akuma" }],
		});
		const rohffBare = rohff([{ type: "track", slug: "track:fitna", name: "Fitna", artist: "Rohff" }]);

		enqueueEdges(akuma, 1, frontier, (s) => logs.push(s));
		enqueueEdges(rohffBare, 1, frontier, (s) => logs.push(s));

		const popped = frontier.pop();
		expect(frontier.size()).toBe(0);
		expect(popped?.entry.input.artist).toBe("Akuma");
		expect(popped?.entry.refCount).toBe(1);
		expect(popped?.entry.requesters).toEqual([{ slug: "artist:akuma", field: "notable_tracks" }]);
		expect(logs.some((l) => l.includes("not merged"))).toBe(true);
	});

	it("flag on: the conflict is still detected once the earlier target was popped, and for non-Latin names", () => {
		process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = "true";
		const frontier = new FrontierQueue();
		const bare = (artist: string) => ({ type: "track", slug: "track:song", name: "Song", artist }) as const;
		const first = artistNode({ slug: "artist:a", name: "A", notable_tracks: [bare("坂本龍一")] });

		enqueueEdges(first, 1, frontier, () => {});
		frontier.pop(); // in flight: no longer in the queue, still owned by its artist

		expect(frontier.hasArtistConflict("track:song", "宇多田ヒカル")).toBe(true);
		expect(frontier.hasArtistConflict("track:song", "坂本龍一")).toBe(false);
		expect(frontier.hasArtistConflict("track:song", undefined)).toBe(false);
	});

	it("flag off: the same bare-slug collision still merges by slug, as before", () => {
		delete process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
		const frontier = new FrontierQueue();
		const edge = (artist: string) => ({ type: "track", slug: "track:fitna", name: "Fitna", artist }) as const;
		const akuma = artistNode({ slug: "artist:akuma", name: "Akuma", notable_tracks: [edge("Akuma")] });

		enqueueEdges(akuma, 1, frontier, () => {});
		enqueueEdges(rohff([edge("Rohff")]), 1, frontier, () => {});

		expect(frontier.size()).toBe(1);
		expect(frontier.pop()?.entry.refCount).toBe(2);
	});
});

// A parent that cites a requested slug AFTER the child was filed under its canonical slug missed the
// requester pass: it is repointed before it is written instead.
describe("FrontierQueue.repointResolved (TRA-476)", () => {
	const requested = "project:new-forms--roni-size" as const;
	const canonical = "project:new-forms--roni-size-reprazent" as const;
	const target = {
		slug: canonical,
		artist: "Roni Size / Reprazent",
		mbid: "66666666-7777-8888-9999-000000000000",
	};

	it("repoints a late parent's edge to the canonical slug, artist and mbid, without touching other edges", () => {
		const frontier = new FrontierQueue();
		frontier.markResolved(requested, target);
		const node = artistNode({
			slug: "artist:krust",
			name: "Krust",
			discography: [
				{ type: "project", slug: requested, name: "New Forms", artist: "Roni Size", year: "1997" },
				{ type: "project", slug: "project:other--krust", name: "Other", artist: "Krust" },
			],
		});

		const repointed = frontier.repointResolved(node) as ArtistNode;

		expect(repointed.discography).toEqual([
			{
				type: "project",
				slug: canonical,
				name: "New Forms",
				artist: target.artist,
				mbid: target.mbid,
				year: "1997",
			},
			{ type: "project", slug: "project:other--krust", name: "Other", artist: "Krust" },
		]);
		expect(node.discography[0]?.slug).toBe(requested); // the input is not mutated
	});

	it("keeps one edge when the list already cited the canonical slug", () => {
		const frontier = new FrontierQueue();
		frontier.markResolved(requested, target);
		const node = artistNode({
			discography: [
				{ type: "project", slug: requested, name: "New Forms", artist: "Roni Size" },
				{ type: "project", slug: canonical, name: "New Forms", artist: target.artist },
				{ type: "project", slug: requested, name: "New Forms (dup)", artist: "Roni Size" },
			],
		});

		const repointed = frontier.repointResolved(node) as ArtistNode;

		expect(repointed.discography.map((e) => e.slug)).toEqual([canonical]);
	});
});
