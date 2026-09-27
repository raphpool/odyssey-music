import type { Catalog } from "../src/api/contracts";
import { rankAffinity } from "../src/recommendation/affinity";

const revision = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function catalog(nodes: Catalog["nodes"], edges: Catalog["edges"]): Catalog {
	return { version: "v1", revision, taxonomy: { mode: "degraded", available: true }, nodes, edges };
}

const genre = (identity: string, name: string) => ({ identity, name, teaser: null, type: "genre" as const });
const artist = (identity: string, name: string) => ({
	identity,
	name,
	teaser: null,
	type: "artist" as const,
});
const project = (identity: string, name: string) => ({
	identity,
	name,
	teaser: null,
	type: "project" as const,
});

describe("rankAffinity", () => {
	it("scores direct, nearby and curated contributions once and excludes genres and labels", () => {
		const result = rankAffinity(
			catalog(
				[
					genre("genre:electronic", "Électronique"),
					genre("genre:ambient", "Ambient"),
					artist("artist:one", "One"),
					project("project:two", "Two"),
					{ identity: "label:three", name: "Three", teaser: null, type: "label" },
				],
				[
					{ source: "genre:electronic", target: "genre:ambient", type: "related_genres" },
					{ source: "artist:one", target: "genre:electronic", type: "genres" },
					{ source: "artist:one", target: "genre:electronic", type: "genres" },
					{ source: "artist:one", target: "genre:ambient", type: "genres" },
					{ source: "genre:electronic", target: "artist:one", type: "key_artists" },
					{ source: "genre:electronic", target: "artist:one", type: "key_artists" },
					{ source: "genre:electronic", target: "project:two", type: "landmark_projects" },
					{ source: "genre:electronic", target: "label:three", type: "landmark_projects" },
				],
			),
			["genre:electronic"],
		);

		expect(result).toEqual([
			expect.objectContaining({ node: expect.objectContaining({ identity: "artist:one" }), score: 7 }),
			expect.objectContaining({ node: expect.objectContaining({ identity: "project:two" }), score: 4 }),
		]);
		expect(result[0]?.reasons).toEqual(
			expect.arrayContaining(["Artiste clé d’Électronique", "Lié à Électronique"]),
		);
	});

	it("orders ties by slug and limits eligibility to the deterministic top sixty", () => {
		const works = Array.from({ length: 61 }, (_, index) =>
			artist(`artist:${String(61 - index).padStart(2, "0")}`, `A ${index}`),
		);
		const ranked = rankAffinity(
			catalog(
				[genre("genre:ambient", "Ambient"), ...works],
				works.map((work) => ({ source: work.identity, target: "genre:ambient", type: "genres" })),
			),
			["genre:ambient"],
		);

		expect(ranked).toHaveLength(60);
		expect(ranked[0]?.node.identity).toBe("artist:01");
		expect(ranked.at(-1)?.node.identity).toBe("artist:60");
	});
});
