import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { createGenreResolver, type GenreCatalogEntry, type GenreResolver } from "../src/genre-identity.js";
import {
	createGenreRegistry,
	type GenreRedirects,
	type GenreRegistry,
	loadGenreRedirects,
	parseGenreRedirects,
} from "../src/genre-registry.js";
import type { ArtistNode, EdgeRef, GenreNode, Slug } from "../src/types.js";

// The real "trap" MBID -> QID mapping (data/genre-qid-map.json) and its catalog entry
// (data/genre-catalog.json), reproduced in-memory per test convention.
const TRAP_MBID = "9a339aa8-a0e5-450c-95a7-b11517bb508f";
const TRAP_QID = "Q2913982";

let dir: string;
let cache: NodeCache;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-genre-registry-"));
	cache = new NodeCache(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function resolverFor(
	catalog: readonly GenreCatalogEntry[],
	mbidToQid: ReadonlyMap<string, string> = new Map(),
): GenreResolver {
	return createGenreResolver({ catalog, mbidToQid, aliases: new Map() });
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

	it("follows a redirect (rule 3) over the qid index (rule 4) even with a real resolver in play", async () => {
		// The qid index would send this ref to genre:electronic (same qid), but the redirect
		// table -- checked first -- sends it to a third, unrelated slug instead.
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
		const redirects: GenreRedirects = new Map([["genre:electronic-music", "genre:electro"]]);
		const resolver = resolverFor([
			{ slug: "electronic-music", name: "Electronic music", wikidata_qid: "Q9778" },
		]);

		const registry = registryFor({ resolver, redirects });
		const result = await registry.canonicalSlugFor({
			slug: "genre:electronic-music",
			name: "Electronic music",
		});

		expect(result).toEqual({ slug: "genre:electro", qid: "Q9778" });
	});

	it("never overwrites a ref's pre-existing qid with a fresh resolver lookup", async () => {
		// The resolver would say Q222 for this name; the ref already carries Q111 and must keep it.
		const resolver = resolverFor([{ slug: "bar", name: "Bar", wikidata_qid: "Q222" }]);

		const registry = registryFor({ resolver });
		const result = await registry.canonicalSlugFor({
			slug: "genre:bar",
			name: "Bar",
			qid: "Q111",
		});

		expect(result).toEqual({ slug: "genre:bar", qid: "Q111" });
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

	it("keeps two edges that each already have their own cache node, even though they share a qid", async () => {
		// Pre-merge duplicate state: two genre nodes already exist for the same qid. Rule 2 fires
		// independently for each ref, so they don't collapse into one edge -- that's TRA-22's job.
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
		await cache.write(genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q9778" }));

		const registry = registryFor({});
		const result = await registry.canonicalizeGenreEdges([
			genreRef({ slug: "genre:electronic", name: "Electronic" }),
			genreRef({ slug: "genre:electronic-music", name: "Electronic music" }),
		]);

		expect(result).toHaveLength(2);
		expect(result.map((r) => r.slug)).toEqual(["genre:electronic", "genre:electronic-music"]);
	});

	it("resolves a known mbid to its qid, mbid winning over a mismatched name", async () => {
		const resolver = resolverFor(
			[{ slug: "trap-music", name: "trap music", wikidata_qid: TRAP_QID }],
			new Map([[TRAP_MBID, TRAP_QID]]),
		);

		const registry = registryFor({ resolver });
		const result = await registry.canonicalizeGenreEdges([
			genreRef({ slug: "genre:trap", name: "irrelevant name", mbid: TRAP_MBID }),
		]);

		expect(result).toEqual([
			{ type: "genre", slug: "genre:trap", name: "irrelevant name", mbid: TRAP_MBID, qid: TRAP_QID },
		]);
	});

	it("stamps a resolved qid via mbid even when rule 2 keeps the slug, though it may contradict the node's own qid (trap case, TRA-35)", async () => {
		// genre:trap already exists but was minted with a different qid than what a fresh
		// mbid-based resolution says today -- rule 2 still wins on the slug, but the qid returned
		// is the freshly resolved one, not the node's persisted one.
		await cache.write(genreNode({ slug: "genre:trap", name: "Trap", qid: "Q999999" }));
		const resolver = resolverFor(
			[{ slug: "trap-music", name: "trap music", wikidata_qid: TRAP_QID }],
			new Map([[TRAP_MBID, TRAP_QID]]),
		);

		const registry = registryFor({ resolver });
		const result = await registry.canonicalizeGenreEdges([
			genreRef({ slug: "genre:trap", name: "Trap", mbid: TRAP_MBID }),
		]);

		expect(result).toEqual([
			{ type: "genre", slug: "genre:trap", name: "Trap", mbid: TRAP_MBID, qid: TRAP_QID },
		]);
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

	it("shares a single batchMemo across all genre-bearing fields of the same node (TRA-36)", async () => {
		// Reproduces TRA-36: a genre node's Gemini draft names the same new genre differently in
		// two fields ("Electronic Music" in parent_genres, "Electronic" in related_genres). Both
		// resolve to the same qid; neither slug has a cache node nor a redirect. Before the fix,
		// each field's canonicalizeGenreEdges call got its own empty batchMemo, so the two fields
		// minted two different slugs for the same qid. Field order matches declaration order in
		// node-spec.ts's EDGE_FIELDS_BY_TYPE (parent_genres before related_genres for "genre"), so
		// the first-encountered field's slug ("genre:electronic-music") must win in both fields.
		const resolver = resolverFor([
			{ slug: "electronic-music", name: "Electronic Music", wikidata_qid: "Q9778" },
			{ slug: "electronic", name: "Electronic", wikidata_qid: "Q9778" },
		]);
		const registry = registryFor({ resolver });

		const node = genreNode({
			slug: "genre:techno",
			name: "Techno",
			parent_genres: [genreRef({ slug: "genre:electronic-music", name: "Electronic Music" })],
			related_genres: [genreRef({ slug: "genre:electronic", name: "Electronic" })],
		});

		await registry.canonicalizeNodeEdges(node);

		expect(node.parent_genres).toEqual([
			{ type: "genre", slug: "genre:electronic-music", name: "Electronic Music", qid: "Q9778" },
		]);
		expect(node.related_genres).toEqual([
			{ type: "genre", slug: "genre:electronic-music", name: "Electronic", qid: "Q9778" },
		]);
	});

	it("still drops a self-loop when it only arises via the shared batchMemo (not a same-field or cache-based one)", async () => {
		// A first field ("parent_genres") lists the node's own slug/name outright (bad upstream
		// data), which mints unchanged and seeds the shared batchMemo with qid -> ownSlug. A later
		// field ("related_genres") names a *different*, uncached variant that resolves to the same
		// qid: rule 4 now finds ownSlug via the shared batchMemo (there is no cache node and no
		// redirect to catch this any other way), and the self-loop filter must still drop it.
		const resolver = resolverFor([
			{ slug: "techno", name: "Techno", wikidata_qid: "Q170611" },
			{ slug: "techno-music", name: "Techno Music", wikidata_qid: "Q170611" },
		]);
		const registry = registryFor({ resolver });

		const node = genreNode({
			slug: "genre:techno",
			name: "Techno",
			parent_genres: [genreRef({ slug: "genre:techno", name: "Techno" })],
			related_genres: [genreRef({ slug: "genre:techno-music", name: "Techno Music" })],
		});

		await registry.canonicalizeNodeEdges(node);

		expect(node.related_genres).toEqual([]);
	});

	it("drops a genre edge that canonicalizes back onto the node's own slug (self-loop after a name-derived fallback)", async () => {
		// genre:techno already exists with Q170611. Its related_genres references a name-derived
		// variant of itself ("techno-music") that isn't cached under its own slug: it resolves to
		// the same qid, and the qid index (rule 4) sends it straight back to genre:techno itself.
		await cache.write(genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170611" }));
		const resolver = resolverFor([{ slug: "techno-music", name: "Techno music", wikidata_qid: "Q170611" }]);
		const registry = registryFor({ resolver });

		const node = genreNode({
			slug: "genre:techno",
			name: "Techno",
			qid: "Q170611",
			related_genres: [genreRef({ slug: "genre:techno-music", name: "Techno music" })],
		});

		await registry.canonicalizeNodeEdges(node);

		expect(node.related_genres).toEqual([]);
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
	it("resolves to an empty map when the file is absent, and to its parsed content once written", async () => {
		const path = join(dir, "genre-redirects.json");

		const absent = await loadGenreRedirects(path);
		expect(absent.size).toBe(0);

		await writeFile(
			path,
			JSON.stringify({ redirects: { "genre:electronic-music": "genre:electronic" } }),
			"utf8",
		);
		const present = await loadGenreRedirects(path);
		expect(present).toEqual(new Map([["genre:electronic-music", "genre:electronic"]]));
	});
});
