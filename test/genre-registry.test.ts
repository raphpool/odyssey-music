import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { createGenreResolver, type GenreCatalogEntry, type GenreResolver } from "../src/genre-identity.js";
import {
	createGenreRegistry,
	type GenreRedirects,
	type GenreRegistry,
	parseGenreRedirects,
} from "../src/genre-registry.js";
import type { ArtistNode, EdgeRef, GenreNode, Slug } from "../src/types.js";

let dir: string;
let cache: NodeCache;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-genre-registry-"));
	cache = new NodeCache(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function resolverFor(catalog: readonly GenreCatalogEntry[]): GenreResolver {
	return createGenreResolver({ catalog, mbidToQid: new Map(), aliases: new Map() });
}

function noopResolver(): GenreResolver {
	return { resolve: () => null };
}

function registryFor(deps: { resolver?: GenreResolver; redirects?: GenreRedirects }): GenreRegistry {
	return createGenreRegistry({
		cache,
		resolver: deps.resolver ?? noopResolver(),
		redirects: deps.redirects ?? new Map(),
	});
}

function genreNode(overrides: Partial<GenreNode> & { slug: Slug; name: string }): GenreNode {
	return {
		type: "genre",
		editorial_article: "A real long article about this genre, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_definition: "A short definition.",
		citations: [{ url: "https://example.com/genre" }],
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

function artistNode(overrides: Partial<ArtistNode> & { slug: Slug; name: string }): ArtistNode {
	return {
		type: "artist",
		editorial_article: "A real long article about this artist, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_bio: "A short bio.",
		citations: [{ url: "https://example.com/artist" }],
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

function genreRef(overrides: Partial<EdgeRef> & { slug: Slug; name: string }): EdgeRef {
	return { type: "genre", ...overrides };
}

describe("canonicalSlugFor", () => {
	it("keeps a slug unchanged when it already has a cache node, even if the qid index would say otherwise", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
		await cache.write(genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q9778" }));

		const registry = registryFor({});
		const result = await registry.canonicalSlugFor({
			slug: "genre:electronic-music",
			name: "Electronic music",
			qid: "Q9778",
		});

		expect(result).toEqual({ slug: "genre:electronic-music", qid: "Q9778" });
	});

	it("follows a redirect when the slug has no cache node of its own", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
		const redirects: GenreRedirects = new Map([["genre:electronic-music", "genre:electronic"]]);

		const registry = registryFor({ redirects });
		const result = await registry.canonicalSlugFor({
			slug: "genre:electronic-music",
			name: "Electronic music",
		});

		expect(result.slug).toBe("genre:electronic");
	});

	it("resolves and stamps a qid, then points at the slug the cache's qid index already knows", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
		const resolver = resolverFor([
			{ slug: "electronic-music", name: "Electronic music", wikidata_qid: "Q9778" },
		]);

		const registry = registryFor({ resolver });
		const result = await registry.canonicalSlugFor({
			slug: "genre:electronic-music",
			name: "Electronic music",
		});

		expect(result).toEqual({ slug: "genre:electronic", qid: "Q9778" });
	});

	it("leaves an unresolvable name's slug unchanged and carries no qid", async () => {
		const registry = registryFor({});
		const result = await registry.canonicalSlugFor({
			slug: "genre:some-obscure-microgenre",
			name: "Some obscure microgenre",
		});

		expect(result).toEqual({ slug: "genre:some-obscure-microgenre" });
		expect("qid" in result).toBe(false);
	});
});

describe("canonicalizeGenreEdges", () => {
	it("collapses two new refs sharing a qid within the same batch to the first ref's slug", async () => {
		// Mirrors the real "club" / "dance" MusicBrainz tags, both mapped to Q11787389 in
		// data/genre-qid-map.json — reproduced here with an in-memory catalog per test convention.
		const resolver = resolverFor([
			{ slug: "club", name: "club", wikidata_qid: "Q11787389" },
			{ slug: "dance", name: "dance", wikidata_qid: "Q11787389" },
		]);
		const registry = registryFor({ resolver });

		const result = await registry.canonicalizeGenreEdges([
			genreRef({ slug: "genre:club", name: "club" }),
			genreRef({ slug: "genre:dance", name: "dance" }),
		]);

		expect(result).toEqual([{ type: "genre", slug: "genre:club", name: "club", qid: "Q11787389" }]);
	});
});

describe("canonicalizeNodeEdges", () => {
	it("canonicalizes genre refs on an artist node's genres field, leaving other fields byte-identical", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
		const redirects: GenreRedirects = new Map([["genre:electronic-music", "genre:electronic"]]);
		const registry = registryFor({ redirects });

		const node = artistNode({
			slug: "artist:some-artist",
			name: "Some Artist",
			genres: [genreRef({ slug: "genre:electronic-music", name: "Electronic music" })],
			labels: [{ type: "label", slug: "label:some-label", name: "Some Label" }],
		});
		const before = structuredClone(node);

		await registry.canonicalizeNodeEdges(node);

		expect(node.genres).toEqual([{ type: "genre", slug: "genre:electronic", name: "Electronic music" }]);
		// Everything besides `genres` is untouched.
		const { genres: _beforeGenres, ...beforeRest } = before;
		const { genres: _afterGenres, ...afterRest } = node;
		expect(afterRest).toEqual(beforeRest);
	});

	it("canonicalizes genre refs on a genre node's parent_genres/subgenres/related_genres fields", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
		const redirects: GenreRedirects = new Map([["genre:electronic-music", "genre:electronic"]]);
		const registry = registryFor({ redirects });

		const node = genreNode({
			slug: "genre:techno",
			name: "Techno",
			parent_genres: [genreRef({ slug: "genre:electronic-music", name: "Electronic music" })],
			subgenres: [genreRef({ slug: "genre:electronic-music", name: "Electronic music" })],
			related_genres: [genreRef({ slug: "genre:electronic-music", name: "Electronic music" })],
			key_artists: [{ type: "artist", slug: "artist:some-artist", name: "Some Artist" }],
		});
		const before = structuredClone(node);

		await registry.canonicalizeNodeEdges(node);

		expect(node.parent_genres).toEqual([
			{ type: "genre", slug: "genre:electronic", name: "Electronic music" },
		]);
		expect(node.subgenres).toEqual([{ type: "genre", slug: "genre:electronic", name: "Electronic music" }]);
		expect(node.related_genres).toEqual([
			{ type: "genre", slug: "genre:electronic", name: "Electronic music" },
		]);
		expect(node.key_artists).toEqual(before.key_artists);
		expect(node.slug).toBe(before.slug);
		expect(node.name).toBe(before.name);
	});

	it("is a no-op for a non-object or a node without a type", async () => {
		const registry = registryFor({});
		await expect(registry.canonicalizeNodeEdges(null)).resolves.toBeUndefined();
		await expect(registry.canonicalizeNodeEdges("not an object")).resolves.toBeUndefined();
		await expect(registry.canonicalizeNodeEdges({ genres: [] })).resolves.toBeUndefined();
	});
});

describe("parseGenreRedirects", () => {
	it("parses a well-formed redirects table, ignoring extra provenance fields", () => {
		const result = parseGenreRedirects({
			redirects: { "genre:electronic-music": "genre:electronic" },
			source: "scripts/migrations/2026-09-04-merge-genre-duplicates.ts",
			generated_at: "2026-09-04T00:00:00.000Z",
		});

		expect(result).toEqual(new Map([["genre:electronic-music", "genre:electronic"]]));
	});

	it("rejects a key or value that isn't a valid genre slug", () => {
		expect(() => parseGenreRedirects({ redirects: { "not-a-slug": "genre:electronic" } })).toThrow();
		expect(() => parseGenreRedirects({ redirects: { "genre:electronic-music": "not-a-slug" } })).toThrow();
		expect(() => parseGenreRedirects({ redirects: { "artist:some-artist": "genre:electronic" } })).toThrow();
	});

	it("rejects a table where a value is also a key (not flattened)", () => {
		expect(() =>
			parseGenreRedirects({
				redirects: {
					"genre:a": "genre:b",
					"genre:b": "genre:c",
				},
			}),
		).toThrow();
	});
});

describe("loadGenreRedirects", () => {
	it("resolves to an empty map when data/genre-redirects.json doesn't exist yet", async () => {
		const { loadGenreRedirects } = await import("../src/genre-registry.js");
		const result = await loadGenreRedirects();
		expect(result.size).toBe(0);
	});
});
