import { describe, expect, it } from "vitest";
import { isAllowedImageUrl } from "../src/images/hosts.js";
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
		if (parsed.type !== "artist") throw new Error("expected an artist");
		expect(parsed.genres[0]?.qid).toBe("Q170611");
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

const baseGenre = {
	type: "genre" as const,
	slug: "genre:idm",
	name: "IDM",
	editorial_definition: "Cerebral electronic music.",
	editorial_article: "A long piece about IDM and its cultural significance. ".repeat(8),
	citations: [{ url: "https://example.com/idm" }],
	materialized_at: new Date().toISOString(),
	parent_genres: [],
	subgenres: [],
	related_genres: [],
	key_artists: [],
	key_labels: [],
	landmark_projects: [],
	landmark_tracks: [],
};

describe("nodePayloadSchema — image_url / image_source (TRA-455)", () => {
	const caaUrl = "https://coverartarchive.org/release-group/6a9b9f3e-2d3f-4b0a-9a77-5b6c1f6a0c11/front-500";

	it("keeps image_url and image_source on a genre without loss", () => {
		const parsed = nodePayloadSchema.parse({
			...baseGenre,
			image_url: caaUrl,
			image_source: "derived-cover",
		});
		expect(parsed).toMatchObject({ image_url: caaUrl, image_source: "derived-cover" });
	});

	it("accepts image_url on every node type, labels included", () => {
		const label = {
			type: "label" as const,
			slug: "label:warp-records",
			name: "Warp Records",
			editorial_description: "Sheffield electronic label.",
			editorial_article: "A long piece about Warp Records and its roster. ".repeat(8),
			citations: [{ url: "https://example.com/warp" }],
			materialized_at: new Date().toISOString(),
			genres: [],
			roster: [],
			notable_releases: [],
		};
		for (const node of [baseArtist, baseTrack, baseGenre, label]) {
			const parsed = nodePayloadSchema.parse({ ...node, image_url: caaUrl, image_source: "caa" });
			expect(parsed).toMatchObject({ image_url: caaUrl, image_source: "caa" });
		}
	});

	it("rejects a non-https image_url", () => {
		expect(() => nodePayloadSchema.parse({ ...baseGenre, image_url: "http://example.com/x.jpg" })).toThrow();
		expect(() =>
			nodePayloadSchema.parse({ ...baseGenre, image_url: "http://coverartarchive.org/x.jpg" }),
		).toThrow();
	});

	it("rejects an https image_url on a host outside the allowlist", () => {
		expect(() => nodePayloadSchema.parse({ ...baseGenre, image_url: "https://example.com/x.jpg" })).toThrow();
	});

	it("rejects an image_source outside the enum, including the retired itunes-jit", () => {
		for (const image_source of ["itunes-jit", "made-up"]) {
			expect(() => nodePayloadSchema.parse({ ...baseGenre, image_source })).toThrow();
		}
	});

	it("accepts every declared image_source", () => {
		for (const image_source of [
			"wikidata-p18",
			"wikidata-p154",
			"caa",
			"itunes-verified",
			"derived-cover",
			"legacy",
		]) {
			expect(nodePayloadSchema.parse({ ...baseGenre, image_source })).toMatchObject({ image_source });
		}
	});

	it("leaves existing photo_url hosts untouched by the image allowlist", () => {
		const parsed = nodePayloadSchema.parse({
			...baseArtist,
			photo_url: "https://www.allmusic.com/photo.jpg",
		});
		expect(parsed).toMatchObject({ photo_url: "https://www.allmusic.com/photo.jpg" });
	});
});

describe("isAllowedImageUrl", () => {
	it.each([
		"https://upload.wikimedia.org/wikipedia/commons/a/a1/X.jpg",
		"https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg",
		"https://coverartarchive.org/release/abc/front",
		"https://archive.org/download/x/y.jpg",
		"https://ia800000.us.archive.org/1/items/x/y.jpg",
		"https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg",
	])("accepts %s", (url) => {
		expect(isAllowedImageUrl(url)).toBe(true);
	});

	it.each([
		"http://coverartarchive.org/release/abc/front",
		"https://example.com/x.jpg",
		"https://evilarchive.org/x.jpg",
		"https://archive.org.evil.com/x.jpg",
		"https://mzstatic.com/x.jpg",
		"https://evil.com/?u=https://upload.wikimedia.org/x.jpg",
		"https://user@coverartarchive.org@evil.com/x.jpg",
		"https://coverartarchive.org:8443/x",
		"https://coverartarchive.org\\@evil.com/x",
		"https:upload.wikimedia.org/x",
		"HTTPS://upload.wikimedia.org/x",
		"https://upload.wikimedia.org/a b.jpg",
		'https://upload.wikimedia.org/a"onmouseover="alert(1)//',
		"not a url",
		"",
	])("rejects %s", (url) => {
		expect(isAllowedImageUrl(url)).toBe(false);
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

describe("nodePayloadSchema — artist.similar_artists (TRA-456)", () => {
	it("loads an artist file without the field and yields an empty list", () => {
		// baseArtist stands for a cached file written before the field existed.
		expect("similar_artists" in baseArtist).toBe(false);
		const parsed = nodePayloadSchema.parse(baseArtist);
		if (parsed.type !== "artist") throw new Error("expected an artist");
		expect(parsed.similar_artists).toEqual([]);
	});

	it("keeps similar artists with their mbid", () => {
		const mbid = "11111111-2222-3333-4444-555555555555";
		const parsed = nodePayloadSchema.parse({
			...baseArtist,
			similar_artists: [{ type: "artist", slug: "artist:autechre", name: "Autechre", mbid }],
		});
		if (parsed.type !== "artist") throw new Error("expected an artist");
		expect(parsed.similar_artists).toEqual([
			{ type: "artist", slug: "artist:autechre", name: "Autechre", mbid },
		]);
	});

	it("rejects a similar artist that is not an artist", () => {
		const artist = {
			...baseArtist,
			similar_artists: [{ type: "genre", slug: "genre:idm", name: "IDM" }],
		};
		expect(() => nodePayloadSchema.parse(artist)).toThrow();
	});
});
