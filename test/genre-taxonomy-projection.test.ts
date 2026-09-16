import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { GenreRedirects } from "../src/genre-registry.js";
import type { GenreTaxonomy } from "../src/genre-taxonomy.js";
import { type GenreTaxonomyProjection, projectGenreTaxonomy } from "../src/genre-taxonomy-projection.js";
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

// Materializes a genre. Unless `quarantined`, it gets an edge to genre:support, which alone
// clears the reverse-edge quarantine check measureGenreCoverage runs on every genre-type source.
// Unless `admissible` is false, it also gets three canonical neighbours, clearing the publication
// floor -- irrelevant to a quarantined source, which measureGenreCoverage never resolves anyway.
async function materialize(
	slug: Slug,
	options: { qid?: string; admissible?: boolean; quarantined?: boolean } = {},
): Promise<void> {
	const { qid, admissible = true, quarantined = false } = options;
	const node: GenreNode = { type: "genre", slug, name: slug, ...(qid ? { qid } : {}), ...genreDefaults };
	await cache.write(node);
	nodes.push(vizNode(slug, "genre"));
	if (!quarantined) edges.push({ source: slug, target: "genre:support", kind: "related_genres" });
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
// Shared entry point for every test below: builds the taxonomy (with the default single family
// unless overridden) and projects it onto the fixture graph built by the preceding materialize()
// calls.
function project(
	genres: GenreTaxonomy["genres"],
	options: { redirects?: GenreRedirects; families?: GenreTaxonomy["families"] } = {},
): Promise<GenreTaxonomyProjection> {
	return projectGenreTaxonomy(
		taxonomy(genres, options.families),
		cache,
		graph(),
		options.redirects ?? noRedirects,
	);
}

describe("projectGenreTaxonomy", () => {
	it("unions a genre's admissible sources and drops one that was never materialized", async () => {
		await materialize("genre:admissible-a");
		await materialize("genre:admissible-b");
		const result = await project([
			choice("Q10", ["genre:admissible-a", "genre:admissible-b", "genre:missing-src"]),
		]);

		expect(result.genres).toHaveLength(1);
		expect(result.genres[0]?.slugs.sort()).toEqual(["genre:admissible-a", "genre:admissible-b"]);
	});

	it("excludes an unpublished entry and one whose only source is inadmissible", async () => {
		await materialize("genre:unpublished-src");
		await materialize("genre:inadmissible-src", { admissible: false });
		const result = await project([
			choice("Q11", ["genre:unpublished-src"], false),
			choice("Q12", ["genre:inadmissible-src"]),
		]);

		expect(result.genres).toHaveLength(0);
	});

	it("excludes an entry whose only source is quarantined, but keeps a quarantined source as a migration key when its entry is otherwise admissible", async () => {
		await materialize("genre:quarantined-only", { quarantined: true, admissible: false });
		await materialize("genre:quarantined-extra", { quarantined: true, admissible: false });
		await materialize("genre:mixed-admissible");
		const result = await project([
			choice("Q13", ["genre:quarantined-only"]),
			choice("Q14", ["genre:quarantined-extra", "genre:mixed-admissible"]),
		]);

		expect(result.genres.map((g) => g.id)).toEqual(["Q14"]);
		expect(result.genres[0]?.slugs).toEqual(["genre:mixed-admissible"]);
		expect(result.legacySelectionBySlug["genre:quarantined-only"]).toBeUndefined();
		expect(result.legacySelectionBySlug["genre:quarantined-extra"]).toEqual(["Q14"]);
	});

	it("resolves a family slug from its QID, and leaves a QID-less family without one", async () => {
		await materialize("genre:core-root", { qid: "Q1", admissible: false });
		const families = [coreFamily, { key: "extra", label: "Extra", order: 1 }];
		const result = await project([], { families });

		expect(result.families.find((f) => f.key === "core")).toMatchObject({ slug: "genre:core-root" });
		expect(result.families.find((f) => f.key === "extra")?.slug).toBeUndefined();
	});

	it("leaves a family's slug unresolved when its QID root is quarantined or never materialized", async () => {
		await materialize("genre:core-root", { qid: "Q1", quarantined: true, admissible: false });
		const families = [coreFamily, { key: "never", label: "Never", order: 1, qid: "Q99" }];
		const result = await project([], { families });

		expect(result.families.find((f) => f.key === "core")?.slug).toBeUndefined();
		expect(result.families.find((f) => f.key === "never")?.slug).toBeUndefined();
	});

	it("builds the legacy-slug migration table: known sources, a redirect to a live source, and a redirect to the family root", async () => {
		await materialize("genre:core-root", { qid: "Q1", admissible: false });
		await materialize("genre:child-live");
		const redirects: GenreRedirects = new Map([
			["genre:child-legacy", "genre:child-live"],
			["genre:rock-music", "genre:core-root"],
		]);
		const result = await project([choice("Q2", ["genre:child-live"])], { redirects });

		// Known source and known redirect both resolve to the same current id.
		expect(result.legacySelectionBySlug["genre:child-live"]).toEqual(["Q2"]);
		expect(result.legacySelectionBySlug["genre:child-legacy"]).toEqual(["Q2"]);
		// Old family slug, and a redirect landing on it, both -> published children within it.
		expect(result.legacySelectionBySlug["genre:core-root"]).toEqual(["Q2"]);
		expect(result.legacySelectionBySlug["genre:rock-music"]).toEqual(["Q2"]);
	});

	it("keeps a live slug's own migration key separate from a live redirect target's, and drops a redirect to a never-materialized destination", async () => {
		await materialize("genre:old-live");
		await materialize("genre:new-live");
		await materialize("genre:country-music");
		const redirects: GenreRedirects = new Map([
			["genre:old-live", "genre:new-live"],
			["genre:country-music", "genre:country"],
		]);
		const result = await project(
			[
				choice("Q-old", ["genre:old-live"]),
				choice("Q-new", ["genre:new-live"]),
				choice("Q4", ["genre:country-music"]),
			],
			{ redirects },
		);

		expect(result.legacySelectionBySlug["genre:old-live"]).toEqual(["Q-old"]);
		expect(result.legacySelectionBySlug["genre:new-live"]).toEqual(["Q-new"]);
		expect(result.genres.find((g) => g.id === "Q4")?.slugs).toEqual(["genre:country-music"]);
		expect(result.legacySelectionBySlug["genre:country"]).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('genre:country"');
	});
});
