import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { GenreRedirects } from "../src/genre-registry.js";
import type { GenreTaxonomy } from "../src/genre-taxonomy.js";
import { projectGenreTaxonomy } from "../src/genre-taxonomy-projection.js";
import type { GraphProjection, VizNode } from "../src/graph.js";
import type { GenreNode, NodeType, Slug } from "../src/types.js";

const genreDefaults = {
	editorial_definition: "Fixture definition.",
	editorial_article: "Fixture article. ".repeat(8),
	citations: [{ url: "https://example.com/genre" }],
	materialized_at: new Date().toISOString(),
	parent_genres: [],
	subgenres: [],
	related_genres: [],
	key_artists: [],
	key_labels: [],
	landmark_projects: [],
	landmark_tracks: [],
};
const vizDefaults = {
	teaser: "",
	article: "",
	citations: [],
	facts: {},
	edges: {},
	materialized_at: "",
};
function vizNode(id: string, type: NodeType): VizNode {
	return { id, type, name: id, ...vizDefaults };
}

let directory: string;
let cache: NodeCache;
let nodes: VizNode[];
let edges: GraphProjection["edges"];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "odyssey-taxonomy-projection-"));
	cache = new NodeCache(directory);
	nodes = [vizNode("genre:support", "genre")];
	edges = [];
	await cache.write({ type: "genre", slug: "genre:support", name: "Support", ...genreDefaults });
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

// Materializes a genre with an edge to genre:support -- on its own, this clears the reverse-edge
// quarantine check that measureGenreCoverage runs on every genre-type source. When `admissible`
// (the default), it also gets three canonical neighbours, clearing the publication floor.
async function materialize(slug: Slug, qid?: string, admissible = true): Promise<void> {
	const node: GenreNode = { type: "genre", slug, name: slug, ...(qid ? { qid } : {}), ...genreDefaults };
	await cache.write(node);
	nodes.push(vizNode(slug, "genre"));
	edges.push({ source: slug, target: "genre:support", kind: "related_genres" });
	if (!admissible) return;
	const [artist, project, track] = [`artist:${slug}`, `project:${slug}`, `track:${slug}`];
	nodes.push(vizNode(artist, "artist"), vizNode(project, "project"), vizNode(track, "track"));
	edges.push(
		{ source: slug, target: artist, kind: "key_artists" },
		{ source: project, target: slug, kind: "genres" },
		{ source: slug, target: track, kind: "landmark_tracks" },
	);
}
const graph = (): GraphProjection => ({ generated_at: "", total: 0, types: {}, nodes, edges });
const coreFamily = { key: "core", label: "Core", order: 0, qid: "Q1" };
function taxonomy(
	genres: GenreTaxonomy["genres"],
	families: GenreTaxonomy["families"] = [coreFamily],
): GenreTaxonomy {
	return { version: 2, families, genres };
}
function choice(id: string, sourceSlugs: Slug[], published = true): GenreTaxonomy["genres"][number] {
	return { id, qid: id, name: id, family: "core", published, sourceSlugs };
}
const noRedirects: GenreRedirects = new Map();

describe("projectGenreTaxonomy", () => {
	it("unions a genre's admissible sources and drops one that was never materialized", async () => {
		await materialize("genre:admissible-a");
		await materialize("genre:admissible-b");
		const result = await projectGenreTaxonomy(
			taxonomy([choice("Q10", ["genre:admissible-a", "genre:admissible-b", "genre:missing-src"])]),
			cache,
			graph(),
			noRedirects,
		);

		expect(result.genres).toHaveLength(1);
		expect(result.genres[0]?.slugs.sort()).toEqual(["genre:admissible-a", "genre:admissible-b"]);
	});

	it("excludes an unpublished entry and one whose only source is inadmissible", async () => {
		await materialize("genre:unpublished-src");
		await materialize("genre:inadmissible-src", undefined, false);
		const result = await projectGenreTaxonomy(
			taxonomy([choice("Q11", ["genre:unpublished-src"], false), choice("Q12", ["genre:inadmissible-src"])]),
			cache,
			graph(),
			noRedirects,
		);

		expect(result.genres).toHaveLength(0);
	});

	it("resolves a family slug from its QID, and leaves a QID-less family without one", async () => {
		await materialize("genre:core-root", "Q1", false);
		const families = [coreFamily, { key: "extra", label: "Extra", order: 1 }];
		const result = await projectGenreTaxonomy(taxonomy([], families), cache, graph(), noRedirects);

		expect(result.families.find((f) => f.key === "core")).toMatchObject({ slug: "genre:core-root" });
		expect(result.families.find((f) => f.key === "extra")?.slug).toBeUndefined();
	});

	it("builds the legacy-slug migration table: known sources, a redirect, and the family slug", async () => {
		await materialize("genre:core-root", "Q1", false);
		await materialize("genre:child-live");
		const redirects: GenreRedirects = new Map([["genre:child-legacy", "genre:child-live"]]);
		const result = await projectGenreTaxonomy(
			taxonomy([choice("Q2", ["genre:child-live"])]),
			cache,
			graph(),
			redirects,
		);

		// Known source and known redirect both resolve to the same current id.
		expect(result.legacySelectionBySlug["genre:child-live"]).toEqual(["Q2"]);
		expect(result.legacySelectionBySlug["genre:child-legacy"]).toEqual(["Q2"]);
		// Old family slug -> published children within it.
		expect(result.legacySelectionBySlug["genre:core-root"]).toEqual(["Q2"]);
	});

	// genre:country-music is live AND (inconsistently) a redirect key to the never-materialized
	// genre:country -- resolveReadSlug lets the live node win, so no dead slug should surface.
	it("exports only the live source when it is also an inconsistent redirect key (country case)", async () => {
		await materialize("genre:country-music");
		const redirects: GenreRedirects = new Map([["genre:country-music", "genre:country"]]);
		const result = await projectGenreTaxonomy(
			taxonomy([choice("Q4", ["genre:country-music"])]),
			cache,
			graph(),
			redirects,
		);

		expect(result.genres[0]?.slugs).toEqual(["genre:country-music"]);
		expect(JSON.stringify(result)).not.toContain('genre:country"');
	});

	// The three QID-bearing families today (avant-garde Q2332751, rock Q11399, jazz Q8341) are
	// never a real entry's sourceSlug, so this never fires in production -- but if one ever did
	// list a family root as its own source, the projection must reject rather than silently merge
	// the two entries onto it.
	it("rejects a source slug assigned to two different entries", async () => {
		await materialize("genre:shared");
		await expect(
			projectGenreTaxonomy(
				taxonomy([choice("Q20", ["genre:shared"]), choice("Q21", ["genre:shared"])]),
				cache,
				graph(),
				noRedirects,
			),
		).rejects.toThrow(/multiple genres/i);
	});
});
