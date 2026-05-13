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

	it("rejects a track with bogus edge type", () => {
		const track = {
			type: "track",
			slug: "track:tendency",
			name: "Tendency",
			editorial_teaser: "A Jan Jelinek track.",
			editorial_article: "A real article body.",
			citations: [],
			materialized_at: new Date().toISOString(),
			artists: [{ type: "not-a-type", slug: "x:y", name: "x" }],
			genres: [],
			producers: [],
			samples: [],
			sampled_by: [],
			remixed_by: [],
		};
		expect(() => nodePayloadSchema.parse(track)).toThrow();
	});

	it("accepts an optional singular edge (track.project) when present", () => {
		const track = {
			type: "track" as const,
			slug: "track:tendency",
			name: "Tendency",
			editorial_teaser: "Teaser.",
			editorial_article: "A real prose body about the track Tendency. ".repeat(8),
			citations: [{ url: "https://example.com/tendency", title: "Tendency" }],
			materialized_at: new Date().toISOString(),
			artists: [{ type: "artist", slug: "artist:jan-jelinek", name: "Jan Jelinek" }],
			project: {
				type: "project",
				slug: "project:loop-finding-jazz-records",
				name: "Loop-Finding-Jazz-Records",
			},
			genres: [],
			producers: [],
			samples: [],
			sampled_by: [],
			remixed_by: [],
		};
		expect(() => nodePayloadSchema.parse(track)).not.toThrow();
	});

	it("validates all 5 node types via the discriminated union", () => {
		const types = ["genre", "label", "artist", "project", "track"];
		expect(types).toHaveLength(5);
	});
});
