import { describe, expect, it } from "vitest";
import { nodePayloadSchema } from "../src/schemas.js";

const baseArtist = {
	type: "artist" as const,
	slug: "artist:aphex-twin",
	name: "Aphex Twin",
	editorial_bio: "Cornish electronic musician.",
	editorial_article: "A long piece about Aphex Twin and his cultural significance. ".repeat(8),
	citations: [{ url: "https://en.wikipedia.org/wiki/Aphex_Twin", title: "Wikipedia" }],
	materialized_at: new Date().toISOString(),
	genres: [{ type: "genre", slug: "genre:idm", name: "IDM" }],
	labels: [{ type: "label", slug: "label:warp-records", name: "Warp Records" }],
	discography: [],
	notable_tracks: [],
	influences: [],
	influenced: [],
	collaborators: [],
	aliases: [{ type: "artist", slug: "artist:afx", name: "AFX" }],
	members: [],
};

const baseTrack = {
	type: "track" as const,
	slug: "track:tendency",
	name: "Tendency",
	editorial_teaser: "A Jan Jelinek track.",
	editorial_article: "A real prose body about the track Tendency. ".repeat(8),
	citations: [{ url: "https://example.com/tendency", title: "Tendency" }],
	materialized_at: new Date().toISOString(),
	artists: [{ type: "artist", slug: "artist:jan-jelinek", name: "Jan Jelinek" }],
	genres: [],
	producers: [],
	samples: [],
	sampled_by: [],
	remixed_by: [],
};

describe("nodePayloadSchema", () => {
	it("accepts a well-formed artist node", () => {
		const parsed = nodePayloadSchema.parse(baseArtist);
		expect(parsed.type).toBe("artist");
		expect(parsed.name).toBe("Aphex Twin");
	});

	it("rejects a node with an invalid slug format", () => {
		expect(() => nodePayloadSchema.parse({ ...baseArtist, slug: "no-colon" })).toThrow();
	});

	it("rejects an artist missing a required edge field", () => {
		const bad = { ...baseArtist } as Record<string, unknown>;
		delete bad.genres;
		expect(() => nodePayloadSchema.parse(bad)).toThrow();
	});

	it("rejects a track with a too-short article", () => {
		const track = { ...baseTrack, editorial_article: "A real article body." };
		expect(() => nodePayloadSchema.parse(track)).toThrow();
	});

	it("rejects a track with empty citations", () => {
		const track = { ...baseTrack, citations: [] };
		expect(() => nodePayloadSchema.parse(track)).toThrow();
	});

	it("rejects a track with bogus edge type", () => {
		const track = { ...baseTrack, artists: [{ type: "not-a-type", slug: "x:y", name: "x" }] };
		expect(() => nodePayloadSchema.parse(track)).toThrow();
	});

	it("accepts an optional singular edge (track.project) when present", () => {
		const track = {
			...baseTrack,
			editorial_teaser: "Teaser.",
			project: {
				type: "project",
				slug: "project:loop-finding-jazz-records",
				name: "Loop-Finding-Jazz-Records",
			},
		};
		expect(() => nodePayloadSchema.parse(track)).not.toThrow();
	});

	it("validates all 5 node types via the discriminated union", () => {
		const types = ["genre", "label", "artist", "project", "track"];
		expect(types).toHaveLength(5);
	});

	// TRA-17: qid on edges and on the genre node itself.
	it("accepts a legacy node with no qid anywhere (non-regression on the existing cache)", () => {
		expect(() => nodePayloadSchema.parse(baseArtist)).not.toThrow();
	});

	it("keeps a valid qid on an edge after a parse round-trip", () => {
		const artist = {
			...baseArtist,
			genres: [{ type: "genre", slug: "genre:idm", name: "IDM", qid: "Q170611" }],
		};
		const parsed = nodePayloadSchema.parse(artist);
		expect((parsed as typeof artist).genres[0]?.qid).toBe("Q170611");
	});

	it.each(["Q0", "170611", "", 170611])("rejects a malformed edge qid (%p)", (badQid) => {
		const artist = {
			...baseArtist,
			genres: [{ type: "genre", slug: "genre:idm", name: "IDM", qid: badQid }],
		};
		expect(() => nodePayloadSchema.parse(artist)).toThrow();
	});

	it("keeps a valid qid on a genre node after a parse round-trip", () => {
		const genre = {
			type: "genre" as const,
			slug: "genre:techno",
			name: "Techno",
			qid: "Q170611",
			editorial_definition: "A genre of electronic dance music.",
			editorial_article: "A long piece about techno and its cultural significance. ".repeat(8),
			citations: [{ url: "https://en.wikipedia.org/wiki/Techno", title: "Wikipedia" }],
			materialized_at: new Date().toISOString(),
			parent_genres: [],
			subgenres: [],
			related_genres: [],
			key_artists: [],
			key_labels: [],
			landmark_projects: [],
			landmark_tracks: [],
		};
		const parsed = nodePayloadSchema.parse(genre);
		expect((parsed as typeof genre).qid).toBe("Q170611");
	});
});

describe("nodePayloadSchema — identity fields (TRA-451)", () => {
	it("keeps EdgeRef.artist on a track's project edge without loss", () => {
		const track = {
			...baseTrack,
			slug: "track:fitna--rohff",
			project: {
				type: "project",
				slug: "project:la-vie-avant-la-mort--rohff",
				name: "La vie avant la mort",
				artist: "Rohff",
			},
		};
		const parsed = nodePayloadSchema.parse(track);
		if (parsed.type !== "track") throw new Error("expected a track");
		expect(parsed.project?.artist).toBe("Rohff");
	});

	it("keeps EdgeRef.artist on artist.discography edges", () => {
		const artist = {
			...baseArtist,
			discography: [
				{
					type: "project",
					slug: "project:new-forms--roni-size-reprazent",
					name: "New Forms",
					artist: "Roni Size / Reprazent",
				},
			],
		};
		const parsed = nodePayloadSchema.parse(artist);
		if (parsed.type !== "artist") throw new Error("expected an artist");
		expect(parsed.discography[0]?.artist).toBe("Roni Size / Reprazent");
	});

	it("rejects an empty EdgeRef.artist", () => {
		const artist = {
			...baseArtist,
			discography: [{ type: "project", slug: "project:new-forms--x", name: "New Forms", artist: "" }],
		};
		expect(() => nodePayloadSchema.parse(artist)).toThrow();
	});

	it("still loads edges that carry no artist", () => {
		const parsed = nodePayloadSchema.parse(baseArtist);
		if (parsed.type !== "artist") throw new Error("expected an artist");
		expect(parsed.genres[0] && "artist" in parsed.genres[0]).toBe(false);
	});

	it("keeps artist_kind person and group", () => {
		for (const kind of ["person", "group"] as const) {
			const parsed = nodePayloadSchema.parse({ ...baseArtist, artist_kind: kind });
			if (parsed.type !== "artist") throw new Error("expected an artist");
			expect(parsed.artist_kind).toBe(kind);
		}
	});

	it("loads an artist without artist_kind", () => {
		const parsed = nodePayloadSchema.parse(baseArtist);
		if (parsed.type !== "artist") throw new Error("expected an artist");
		expect(parsed.artist_kind).toBeUndefined();
	});

	it("rejects an unknown artist_kind", () => {
		expect(() => nodePayloadSchema.parse({ ...baseArtist, artist_kind: "band" })).toThrow();
	});
});
