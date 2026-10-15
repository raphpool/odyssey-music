import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATIC_GRAPH_OPTIONS } from "../scripts/build-graph-json.js";
import { buildGraphFromCache, toVizNode } from "../src/graph.js";
import { createGraphService } from "../src/services/graph-service.js";
import type { ArtistNode, EdgeRef, GenreNode, NodePayload } from "../src/types.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-graph-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

// Shared minimal-genre-node fixture (mirrors the one in test/cache.test.ts, TRA-18).
function genreNode(overrides: Partial<GenreNode> & Pick<GenreNode, "slug" | "name">): GenreNode {
	return {
		type: "genre",
		editorial_definition: `Test fixture definition for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for graph export coverage. `.repeat(4),
		citations: [{ url: `https://example.com/${overrides.slug.split(":")[1]}` }],
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

function artistNode(overrides: Partial<ArtistNode> & Pick<ArtistNode, "slug" | "name">): ArtistNode {
	return {
		type: "artist",
		editorial_bio: `Test fixture bio for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for graph export coverage. `.repeat(4),
		citations: [{ url: `https://example.com/${overrides.slug.split(":")[1]}` }],
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

// Writes a node payload straight to the cache's on-disk layout, bypassing NodeCache.write's
// eager reverse-edge emission (src/cache.ts emitReverses). This simulates the realistic case —
// per TRA-19's measured 81%/19% split — where a genre node's reverse field was never populated
// on disk and only backfillGenreReverses (src/graph.ts) fills it in at export time.
async function writeRawNode(root: string, node: NodePayload): Promise<void> {
	const [type, ...rest] = node.slug.split(":");
	const file = join(root, "nodes", String(type), `${rest.join(":")}.json`);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(node), "utf8");
}

describe("toVizNode — node-level qid whitelist (TRA-19)", () => {
	it("keeps qid on a genre VizNode when the cached node has one", () => {
		const genre = genreNode({ slug: "genre:acid", name: "Acid", qid: "Q170611" });
		const viz = toVizNode(genre);
		expect(viz.qid).toBe("Q170611");
	});

	it("omits qid on a genre VizNode when the cached node has none", () => {
		const genre = genreNode({ slug: "genre:dub", name: "Dub" });
		const viz = toVizNode(genre);
		expect("qid" in viz).toBe(false);
	});

	it("never surfaces qid on a non-genre VizNode, even if present on the payload by error", () => {
		const artist: ArtistNode = {
			type: "artist",
			slug: "artist:brian-eno",
			name: "Brian Eno",
			editorial_bio: "British producer and ambient pioneer.",
			editorial_article: "A real long article about Brian Eno's ambient legacy. ".repeat(6),
			citations: [{ url: "https://example.com/brian-eno" }],
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
		};
		// ArtistNode doesn't declare qid; schemas.ts would already strip a stray one on write/read
		// (TRA-17/TRA-18). This asserts the node-level whitelist in toVizNode is its own guarantee,
		// not merely incidental coverage inherited from the schema layer.
		const corrupted = { ...artist, qid: "Q999999" } as unknown as ArtistNode;
		const viz = toVizNode(corrupted);
		expect("qid" in viz).toBe(false);
	});
});

describe("toVizNode — image_url projection (TRA-455)", () => {
	const caa = "https://coverartarchive.org/release-group/6a9b9f3e/front-500";

	it("falls back to photo_url for an artist without image_url", () => {
		const artist = artistNode({ slug: "artist:a", name: "A", photo_url: "https://example.com/a.jpg" });
		expect(toVizNode(artist).image_url).toBe("https://example.com/a.jpg");
	});

	it("falls back to cover_url for a project without image_url", () => {
		const project = {
			type: "project",
			slug: "project:p",
			name: "P",
			cover_url: "https://example.com/p.jpg",
		} as unknown as NodePayload;
		expect(toVizNode(project).image_url).toBe("https://example.com/p.jpg");
	});

	it("lets image_url win over photo_url and projects image_source", () => {
		const artist = artistNode({
			slug: "artist:a",
			name: "A",
			photo_url: "https://example.com/a.jpg",
			image_url: caa,
			image_source: "caa",
		});
		const viz = toVizNode(artist);
		expect(viz.image_url).toBe(caa);
		expect(viz.image_source).toBe("caa");
	});

	it("does not project image_source next to a photo_url / cover_url fallback", () => {
		// image_source describes image_url only; a stray value must not label the fallback.
		const artist = artistNode({ slug: "artist:a", name: "A", photo_url: "https://example.com/a.jpg" });
		const viz = toVizNode({ ...artist, image_source: "caa" });
		expect(viz.image_url).toBe("https://example.com/a.jpg");
		expect("image_source" in viz).toBe(false);
	});

	it("projects image_url for genres, which have no photo_url / cover_url", () => {
		const viz = toVizNode(
			genreNode({ slug: "genre:dub", name: "Dub", image_url: caa, image_source: "derived-cover" }),
		);
		expect(viz).toMatchObject({ image_url: caa, image_source: "derived-cover" });
	});

	it("omits both keys when the node has no image field", () => {
		const viz = toVizNode(genreNode({ slug: "genre:dub", name: "Dub" }));
		expect("image_url" in viz).toBe(false);
		expect("image_source" in viz).toBe(false);
	});

	it("projects image_url through buildGraphFromCache with default options", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:dub", name: "Dub", image_url: caa }));
		const graph = await buildGraphFromCache(dir);
		expect(graph.nodes.find((n) => n.id === "genre:dub")?.image_url).toBe(caa);
	});
});

describe("toVizNode — EdgeRef.artist survives projection (TRA-451)", () => {
	it("keeps artist on projected edges and does not leak artist_kind", () => {
		const discography: EdgeRef[] = [
			{
				slug: "project:new-forms--roni-size-reprazent",
				type: "project",
				name: "New Forms",
				artist: "Roni Size / Reprazent",
			},
		];
		const group = artistNode({
			slug: "artist:roni-size-reprazent",
			name: "Roni Size / Reprazent",
			artist_kind: "group",
			discography,
		});
		const viz = toVizNode(group);
		const projected = viz.edges.discography as EdgeRef[];
		expect(projected[0]?.artist).toBe("Roni Size / Reprazent");
		expect("artist_kind" in viz).toBe(false);
	});
});

describe("buildGraphFromCache — genre qid reaches the exported graph (TRA-19)", () => {
	it("keeps the node qid through the full cache-to-graph pipeline", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:acid", name: "Acid", qid: "Q170611" }));
		const graph = await buildGraphFromCache(dir);
		const node = graph.nodes.find((n) => n.id === "genre:acid");
		expect(node?.qid).toBe("Q170611");
	});
});

describe("buildGraphFromCache — genre redirects reach the exported graph (TRA-23)", () => {
	it("populates redirects from a genre-redirects.json-shaped fixture", async () => {
		const redirectsPath = join(dir, "redirects.json");
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:electronic-music": "genre:electronic" } }),
			"utf8",
		);
		const graph = await buildGraphFromCache(dir, { redirectsPath });
		expect(graph.redirects).toEqual({ "genre:electronic-music": "genre:electronic" });
	});

	it("leaves redirects undefined when the redirects file is absent", async () => {
		const graph = await buildGraphFromCache(dir, { redirectsPath: join(dir, "missing.json") });
		expect(graph.redirects).toBeUndefined();
	});

	it("propagates parseGenreRedirects' error for a table that isn't flattened", async () => {
		const redirectsPath = join(dir, "cyclic-redirects.json");
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:a": "genre:b", "genre:b": "genre:c" } }),
			"utf8",
		);
		await expect(buildGraphFromCache(dir, { redirectsPath })).rejects.toThrow(
			/appears as both key and value/,
		);
	});
});

describe("buildGraphFromCache — slug redirects reach the exported graph (TRA-453)", () => {
	it("merges a track entry from slug-redirects.json with the genre table", async () => {
		const redirectsPath = join(dir, "redirects.json");
		const slugRedirectsPath = join(dir, "slug-redirects.json");
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:electronic-music": "genre:electronic" } }),
			"utf8",
		);
		await writeFile(
			slugRedirectsPath,
			JSON.stringify({ redirects: { "track:fitna": "track:fitna--rohff" } }),
			"utf8",
		);
		const graph = await buildGraphFromCache(dir, { redirectsPath, slugRedirectsPath });
		expect(graph.redirects).toEqual({
			"genre:electronic-music": "genre:electronic",
			"track:fitna": "track:fitna--rohff",
		});
	});

	it("emits the track entry when only slug-redirects.json has content", async () => {
		const slugRedirectsPath = join(dir, "slug-redirects.json");
		await writeFile(
			slugRedirectsPath,
			JSON.stringify({ redirects: { "track:fitna": "track:fitna--rohff" } }),
			"utf8",
		);
		const graph = await buildGraphFromCache(dir, {
			redirectsPath: join(dir, "missing.json"),
			slugRedirectsPath,
		});
		expect(graph.redirects).toEqual({ "track:fitna": "track:fitna--rohff" });
	});
});

describe("backfillGenreReverses — stamping self.qid on synthesized reverse edges (TRA-19)", () => {
	it("stamps the source genre's qid onto the reverse edge it synthesizes", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:acid", name: "Acid" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:acid-techno",
				name: "Acid Techno",
				qid: "Q341395",
				parent_genres: [{ type: "genre", slug: "genre:acid", name: "Acid" }],
			}),
		);
		const graph = await buildGraphFromCache(dir);
		const acidNode = graph.nodes.find((n) => n.id === "genre:acid");
		const subgenres = acidNode?.edges.subgenres as EdgeRef[] | undefined;
		const reverse = subgenres?.find((e) => e.slug === "genre:acid-techno");
		expect(reverse?.qid).toBe("Q341395");
	});

	it("omits the qid key on a synthesized reverse edge when the source genre has none", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:idm", name: "IDM" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:braindance",
				name: "Braindance",
				parent_genres: [{ type: "genre", slug: "genre:idm", name: "IDM" }],
			}),
		);
		const graph = await buildGraphFromCache(dir);
		const idmNode = graph.nodes.find((n) => n.id === "genre:idm");
		const subgenres = idmNode?.edges.subgenres as EdgeRef[] | undefined;
		const reverse = subgenres?.find((e) => e.slug === "genre:braindance");
		expect(reverse).toBeDefined();
		expect(reverse && "qid" in reverse).toBe(false);
	});
});

describe("buildGraphFromCache — unified genre quarantine policy (TRA-54)", () => {
	it("applies the static build quarantine policy to the HTTP graph service", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:electronic", name: "Electronic" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:techno",
				name: "Techno",
				parent_genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic" }],
			}),
		);
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:unanchored",
				name: "Unanchored",
				qid: "Q999999",
				related_genres: [{ type: "genre", slug: "genre:missing", name: "Missing" }],
			}),
		);
		await writeRawNode(
			dir,
			artistNode({
				slug: "artist:anchor",
				name: "Anchor",
				genres: [
					{ type: "genre", slug: "genre:techno", name: "Techno" },
					{ type: "genre", slug: "genre:unanchored", name: "Unanchored" },
				],
			}),
		);

		const staticGraph = await buildGraphFromCache(dir, {
			quarantineOrphanGenres: true,
			scrubQuarantinedRefs: true,
		});
		const serviceGraph = await createGraphService(dir).getGraph();

		expect(serviceGraph.nodes).toEqual(staticGraph.nodes);
		expect(serviceGraph.edges).toEqual(staticGraph.edges);
		expect(serviceGraph.quarantine).toEqual([
			{ id: "genre:unanchored", name: "Unanchored", reason: "no genre-genre edges" },
		]);
	});

	it("keeps a genre with a recognized incoming relationship reconstructed before filtering", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:electronic", name: "Electronic" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:techno",
				name: "Techno",
				parent_genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic" }],
			}),
		);

		const graph = await buildGraphFromCache(dir, { quarantineOrphanGenres: true });
		const electronic = graph.nodes.find((node) => node.id === "genre:electronic");

		expect(graph.nodes.map((node) => node.id)).toContain("genre:electronic");
		expect(electronic?.edges.subgenres).toEqual([{ type: "genre", slug: "genre:techno", name: "Techno" }]);
	});

	it("quarantines a genre whose only recognized relationship points to itself", async () => {
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:self-referential",
				name: "Self Referential",
				related_genres: [{ type: "genre", slug: "genre:self-referential", name: "Self Referential" }],
			}),
		);

		const graph = await buildGraphFromCache(dir, {
			quarantineOrphanGenres: true,
			scrubQuarantinedRefs: true,
		});

		expect(graph.nodes.map((node) => node.id)).not.toContain("genre:self-referential");
		expect(graph.quarantine).toEqual([
			{ id: "genre:self-referential", name: "Self Referential", reason: "no genre-genre edges" },
		]);
	});

	it("removes quarantined genre references while preserving materialized relationships and redirects", async () => {
		const redirectsPath = join(dir, "redirects.json");
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:old": "genre:electronic" } }),
			"utf8",
		);
		await writeRawNode(dir, genreNode({ slug: "genre:electronic", name: "Electronic" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:techno",
				name: "Techno",
				parent_genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic" }],
			}),
		);
		await writeRawNode(dir, genreNode({ slug: "genre:orphan", name: "Orphan" }));
		await writeRawNode(
			dir,
			artistNode({
				slug: "artist:anchor",
				name: "Anchor",
				genres: [
					{ type: "genre", slug: "genre:techno", name: "Techno" },
					{ type: "genre", slug: "genre:orphan", name: "Orphan" },
				],
			}),
		);

		const graph = await buildGraphFromCache(dir, {
			quarantineOrphanGenres: true,
			scrubQuarantinedRefs: true,
			redirectsPath,
		});
		const artist = graph.nodes.find((node) => node.id === "artist:anchor");

		expect(artist?.edges.genres).toEqual([{ type: "genre", slug: "genre:techno", name: "Techno" }]);
		expect(graph.edges).toContainEqual({ source: "artist:anchor", target: "genre:techno", kind: "genres" });
		expect(graph.redirects).toEqual({ "genre:old": "genre:electronic" });
	});
});

describe("genre-only graph helpers ignore cross-type reverse pairs (TRA-454)", () => {
	const artistRef = { type: "artist", slug: "artist:anchor", name: "Anchor" } as const;

	it("still quarantines a genre whose only edges are genre.key_artists", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:electronic", name: "Electronic" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:techno",
				name: "Techno",
				parent_genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic" }],
			}),
		);
		await writeRawNode(
			dir,
			genreNode({ slug: "genre:artist-only", name: "Artist Only", key_artists: [artistRef] }),
		);
		await writeRawNode(dir, artistNode({ slug: "artist:anchor", name: "Anchor" }));

		const graph = await buildGraphFromCache(dir, { quarantineOrphanGenres: true });

		expect(graph.quarantine).toEqual([
			{ id: "genre:artist-only", name: "Artist Only", reason: "no genre-genre edges" },
		]);
	});

	it("backfills genre -> genre reverses only and never writes cross-type reverses at export", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:electronic", name: "Electronic" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:techno",
				name: "Techno",
				parent_genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic" }],
				key_artists: [artistRef],
			}),
		);
		await writeRawNode(dir, artistNode({ slug: "artist:anchor", name: "Anchor" }));

		const graph = await buildGraphFromCache(dir);
		const electronic = graph.nodes.find((node) => node.id === "genre:electronic");
		const anchor = graph.nodes.find((node) => node.id === "artist:anchor");

		expect(electronic?.edges.subgenres).toEqual([{ type: "genre", slug: "genre:techno", name: "Techno" }]);
		// artist.genres is the write-path reverse of genre.key_artists; export-time backfill must not invent it.
		expect(anchor?.edges.genres).toBeUndefined();
	});
});

describe("buildGraphFromCache — genre taxonomy projection wired into both exports (TRA-134)", () => {
	let root: string;
	let cacheDir: string;
	let taxonomyPath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "odyssey-graph-taxonomy-"));
		// loadGenreTaxonomy derives its own cache root from the taxonomy path's directory
		// (src/genre-taxonomy.ts's cacheRootFor): a non-"data" parent means "<parent>/cache", so
		// nesting the graph's own cache dir there keeps both lookups pointed at the same fixture.
		cacheDir = join(root, "cache");
		taxonomyPath = join(root, "genre-taxonomy.json");
	});
	afterEach(async () => rm(root, { recursive: true, force: true }));

	// Declares one genre sourced from genre:test-genre. The fixture is deliberately reused
	// whether or not genre:test-genre is ever written to cacheDir, so the same taxonomy file
	// exercises both "the source resolves" and "the source is missing from this cache" below.
	function taxonomyFixture() {
		return {
			version: 2,
			families: [{ key: "core", label: "Core", order: 0 }],
			genres: [
				{
					id: "local:test-genre",
					name: "Test Genre",
					family: "core",
					published: true,
					sourceSlugs: ["genre:test-genre"],
				},
			],
		};
	}
	async function writeTaxonomy(fixture: unknown): Promise<void> {
		await writeFile(taxonomyPath, JSON.stringify(fixture), "utf8");
	}
	// Materializes an admissible genre:test-genre: linked to genre:test-support (clears the
	// genre-genre quarantine check) and to three artists (clears the 3-neighbour publish floor).
	async function writeAdmissibleTestGenre(): Promise<void> {
		await writeRawNode(
			cacheDir,
			genreNode({
				slug: "genre:test-genre",
				name: "Test Genre",
				related_genres: [{ type: "genre", slug: "genre:test-support", name: "Support" }],
				key_artists: [
					{ type: "artist", slug: "artist:a", name: "A" },
					{ type: "artist", slug: "artist:b", name: "B" },
					{ type: "artist", slug: "artist:c", name: "C" },
				],
			}),
		);
		await writeRawNode(cacheDir, genreNode({ slug: "genre:test-support", name: "Support" }));
		await writeRawNode(cacheDir, artistNode({ slug: "artist:a", name: "A" }));
		await writeRawNode(cacheDir, artistNode({ slug: "artist:b", name: "B" }));
		await writeRawNode(cacheDir, artistNode({ slug: "artist:c", name: "C" }));
	}

	it("attaches the taxonomy projection for an admissible genre while keeping the quarantine policy for unrelated orphans", async () => {
		await writeAdmissibleTestGenre();
		await writeRawNode(cacheDir, genreNode({ slug: "genre:orphan", name: "Orphan" }));
		await writeTaxonomy(taxonomyFixture());

		const graph = await buildGraphFromCache(cacheDir, {
			quarantineOrphanGenres: true,
			scrubQuarantinedRefs: true,
			taxonomy: "strict",
			taxonomyPath,
		});

		expect(graph.quarantine).toEqual([
			{ id: "genre:orphan", name: "Orphan", reason: "no genre-genre edges" },
		]);
		expect(graph.nodes.map((node) => node.id)).not.toContain("genre:orphan");
		expect(graph.taxonomy).toEqual({
			version: 2,
			families: [{ key: "core", label: "Core", order: 0 }],
			genres: [{ id: "local:test-genre", name: "Test Genre", family: "core", slugs: ["genre:test-genre"] }],
			legacySelectionBySlug: { "genre:test-genre": ["local:test-genre"] },
		});
	});

	it("omits a quarantined source from the taxonomy, since taxonomy enrichment runs after quarantine filtering", async () => {
		// No genre-genre edges at all -> quarantined and spliced out of the base projection before
		// projectGenreTaxonomy ever sees it, even though the raw node still exists on disk.
		await writeRawNode(cacheDir, genreNode({ slug: "genre:test-genre", name: "Test Genre" }));
		await writeTaxonomy(taxonomyFixture());

		const graph = await buildGraphFromCache(cacheDir, {
			quarantineOrphanGenres: true,
			scrubQuarantinedRefs: true,
			taxonomy: "strict",
			taxonomyPath,
		});

		expect(graph.quarantine).toEqual([
			{ id: "genre:test-genre", name: "Test Genre", reason: "no genre-genre edges" },
		]);
		expect(graph.taxonomy?.genres).toEqual([]);
		expect(graph.taxonomy?.legacySelectionBySlug["genre:test-genre"]).toBeUndefined();
	});

	it("omits the taxonomy field, without error, when the taxonomy file is absent -- in strict mode too", async () => {
		await writeRawNode(cacheDir, genreNode({ slug: "genre:solo", name: "Solo" }));

		const graph = await buildGraphFromCache(cacheDir, {
			taxonomy: "strict",
			taxonomyPath: join(root, "missing-taxonomy.json"),
		});

		expect(graph.taxonomy).toBeUndefined();
		expect(graph.nodes.map((node) => node.id)).toContain("genre:solo");
	});

	it("wraps an unparseable taxonomy file's error with the file path, in strict mode", async () => {
		await writeFile(taxonomyPath, "{not json", "utf8");

		const failure: unknown = await buildGraphFromCache(cacheDir, { taxonomy: "strict", taxonomyPath }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(taxonomyPath);
		expect((failure as Error).message).toContain("could not be projected");
		expect((failure as Error).message).toMatch(/invalid genre taxonomy json/i);
	});

	it("wraps a well-formed but schema-invalid taxonomy file's raw Zod error with the file path, in strict mode", async () => {
		// Valid JSON, but `genres` must be an array -- fails GenreTaxonomySchema.parse, which
		// throws a bare ZodError (an unadorned array of issues) with no file context on its own.
		await writeFile(
			taxonomyPath,
			JSON.stringify({ version: 2, families: [], genres: "not-an-array" }),
			"utf8",
		);

		const failure: unknown = await buildGraphFromCache(cacheDir, { taxonomy: "strict", taxonomyPath }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(taxonomyPath);
		expect((failure as Error).message).toContain("could not be projected");
	});

	it("fails loudly, in strict mode, when a declared taxonomy source is missing from this cache", async () => {
		// genre:test-genre is declared in the taxonomy but never written to cacheDir -- the exact
		// production scenario the review caught: a live cache lagging the repo's committed cache/.
		await writeRawNode(cacheDir, genreNode({ slug: "genre:solo", name: "Solo" }));
		await writeTaxonomy(taxonomyFixture());

		await expect(buildGraphFromCache(cacheDir, { taxonomy: "strict", taxonomyPath })).rejects.toThrow(
			/genre source slug disappeared/i,
		);
	});

	it("serves the graph without a taxonomy field, logging the failure, in degrade mode with the same missing source", async () => {
		await writeRawNode(cacheDir, genreNode({ slug: "genre:solo", name: "Solo" }));
		await writeTaxonomy(taxonomyFixture());
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		try {
			const graph = await buildGraphFromCache(cacheDir, { taxonomy: "degrade", taxonomyPath });

			expect(graph.taxonomy).toBeUndefined();
			expect(graph.nodes.map((node) => node.id)).toContain("genre:solo");
			expect(errorSpy).toHaveBeenCalledTimes(1);
			const logged = JSON.parse((errorSpy.mock.calls[0] as [string])[0]) as {
				level?: string;
				taxonomyPath?: string;
			};
			expect(logged.level).toBe("error");
			expect(logged.taxonomyPath).toBe(taxonomyPath);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("doesn't attach a taxonomy when the `taxonomy` option isn't set, even if the file is present", async () => {
		await writeRawNode(cacheDir, genreNode({ slug: "genre:solo", name: "Solo" }));
		await writeTaxonomy(taxonomyFixture());

		const graph = await buildGraphFromCache(cacheDir, {});

		expect(graph.taxonomy).toBeUndefined();
	});

	it("produces the same taxonomy from the static build path and the HTTP graph service for the same cache and taxonomy fixture", async () => {
		await writeAdmissibleTestGenre();
		await writeTaxonomy(taxonomyFixture());

		// Reuses the real STATIC_GRAPH_OPTIONS the script ships with (only the fixture path
		// differs), so dropping `taxonomy: "strict"` from the script would turn this red instead
		// of leaving it green -- the gap the previous version of this test had (TRA-134 review).
		const staticGraph = await buildGraphFromCache(cacheDir, { ...STATIC_GRAPH_OPTIONS, taxonomyPath });
		// Real createGraphService, not a hand-copied options object -- same reasoning.
		const serviceGraph = await createGraphService(cacheDir, { taxonomyPath }).getGraph();

		expect(staticGraph.taxonomy?.genres).toEqual([
			{ id: "local:test-genre", name: "Test Genre", family: "core", slugs: ["genre:test-genre"] },
		]);
		expect(serviceGraph.taxonomy).toEqual(staticGraph.taxonomy);
	});
});
