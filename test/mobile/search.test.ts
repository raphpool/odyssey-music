import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../../src/cache.js";
import { buildCacheIndex } from "../../src/cache-index.js";
import { createMobileCatalog } from "../../src/mobile/catalog.js";
import { createMobileRouter } from "../../src/mobile/router.js";
import {
	createMobileSearch,
	MobileSearchInputError,
	MobileSearchProviderUnavailableError,
} from "../../src/mobile/search.js";
import { type CatalogIndex, type CatalogResult, createMusicBrainzCatalog } from "../../src/musicbrainz.js";
import type { ArtistNode, GenreNode, LabelNode, ProjectNode, Slug, TrackNode } from "../../src/types.js";

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

function projectNode(overrides: Partial<ProjectNode> & { slug: Slug; name: string }): ProjectNode {
	return {
		type: "project",
		editorial_article:
			"A real long article about this project, well past the eighty character floor. ".repeat(2),
		editorial_pitch: "A short pitch.",
		citations: [{ url: "https://example.com/project" }],
		materialized_at: new Date().toISOString(),
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
		...overrides,
	};
}

function trackNode(overrides: Partial<TrackNode> & { slug: Slug; name: string }): TrackNode {
	return {
		type: "track",
		editorial_article: "A real long article about this track, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_teaser: "A short teaser.",
		citations: [{ url: "https://example.com/track" }],
		materialized_at: new Date().toISOString(),
		artists: [],
		genres: [],
		producers: [],
		personnel: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
		...overrides,
	};
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

function labelNode(overrides: Partial<LabelNode> & { slug: Slug; name: string }): LabelNode {
	return {
		type: "label",
		editorial_article: "A real long article about this label, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_description: "A short description.",
		citations: [{ url: "https://example.com/label" }],
		materialized_at: new Date().toISOString(),
		genres: [],
		roster: [],
		notable_releases: [],
		...overrides,
	};
}

function catalog(results: CatalogResult[], fail = false): CatalogIndex {
	return {
		async search() {
			if (fail) throw new Error("MusicBrainz unavailable");
			return results;
		},
		async searchByType(type) {
			if (fail) throw new Error("MusicBrainz unavailable");
			return results.filter((result) => result.type === type);
		},
		close() {},
	};
}

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(
		servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

async function get(
	port: number,
	path: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("mobile search", () => {
	let directory: string;
	let cache: NodeCache;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "odyssey-mobile-search-"));
		cache = new NodeCache(directory);
		await cache.write(
			artistNode({
				slug: "artist:ambient-artist",
				name: "Ambient Artist",
				mbid: "ABCDEFAB-0000-4000-8000-000000000001",
			}),
		);
		await cache.write(projectNode({ slug: "project:ambient-project", name: "Ambient Project" }));
		await cache.write(trackNode({ slug: "track:ambient-track", name: "Ambient Track" }));
		await cache.write(genreNode({ slug: "genre:ambient", name: "Ambient" }));
		await cache.write(labelNode({ slug: "label:ambient-label", name: "Ambient Label" }));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	function search(results: CatalogResult[] = [], fail = false) {
		return createMobileSearch({
			buildIndex: () => buildCacheIndex(directory),
			catalogIndex: catalog(results, fail),
		});
	}

	it("searches every supported filter and keeps genre and label results cache-only", async () => {
		const reader = search([
			{
				type: "artist",
				mbid: "00000000-0000-4000-8000-000000000002",
				name: "Ambient External",
				subtitle: "Artist",
			},
			{
				type: "project",
				mbid: "00000000-0000-4000-8000-000000000003",
				name: "Ambient External",
				subtitle: "Album",
			},
			{
				type: "track",
				mbid: "00000000-0000-4000-8000-000000000004",
				name: "Ambient External",
				subtitle: "Track",
			},
		]);

		for (const type of ["artist", "project", "track", "genre", "label"] as const) {
			const result = await reader.search({ q: " ambient ", type, limit: 8 });
			expect(result.q).toBe("ambient");
			expect(result.hits.some((hit) => hit.type === type && hit.source === "cache" && hit.slug)).toBe(true);
			if (type === "genre" || type === "label") expect(result.sources.catalog).toBe(0);
		}
	});

	it("deduplicates by MBID and always gives cache hits their slug", async () => {
		const reader = search([
			{
				type: "artist",
				mbid: "abcdefab-0000-4000-8000-000000000001",
				name: "Ambient Artist",
				subtitle: "Duplicate cache",
			},
			{
				type: "artist",
				mbid: "00000000-0000-4000-8000-000000000005",
				name: "Ambient External",
				subtitle: "First",
			},
			{
				type: "artist",
				mbid: "00000000-0000-4000-8000-000000000005",
				name: "Ambient External Copy",
				subtitle: "Duplicate",
			},
		]);

		const result = await reader.search({ q: "ambient", type: "artist", limit: 8 });

		const mixedCaseMbidHits = result.hits.filter(
			(hit) => hit.mbid?.toLowerCase() === "abcdefab-0000-4000-8000-000000000001",
		);
		expect(mixedCaseMbidHits).toHaveLength(1);
		expect(mixedCaseMbidHits[0]).toMatchObject({
			source: "cache",
			slug: "artist:ambient-artist",
			mbid: "ABCDEFAB-0000-4000-8000-000000000001",
		});
		expect(mixedCaseMbidHits.some((hit) => hit.source === "catalog")).toBe(false);
		expect(result.hits.filter((hit) => hit.mbid === "00000000-0000-4000-8000-000000000005")).toHaveLength(1);
		for (const hit of result.hits.filter((hit) => hit.source === "cache")) expect(hit.slug).toBeTruthy();
	});

	it("rejects invalid query, type, and limit values", async () => {
		const reader = search();

		await expect(reader.search({ q: " x ", type: null, limit: 8 })).rejects.toBeInstanceOf(
			MobileSearchInputError,
		);
		await expect(reader.search({ q: "a".repeat(121), type: null, limit: 8 })).rejects.toThrow(
			"q must contain 2 to 120 characters",
		);
		await expect(reader.search({ q: "ambient", type: "article", limit: 8 })).rejects.toThrow(
			"unsupported search type",
		);
		await expect(reader.search({ q: "ambient", type: "", limit: 8 })).rejects.toThrow(
			"unsupported search type",
		);
		await expect(reader.search({ q: "ambient", type: null, limit: 0 })).rejects.toThrow(
			"limit must be an integer from 1 to 25",
		);
		await expect(reader.search({ q: "ambient", type: null, limit: 1.5 })).rejects.toThrow(
			"limit must be an integer from 1 to 25",
		);
	});

	it("maps an unavailable external catalog to a typed provider error", async () => {
		const reader = search([], true);

		await expect(reader.search({ q: "ambient", type: "artist", limit: 8 })).rejects.toBeInstanceOf(
			MobileSearchProviderUnavailableError,
		);
	});

	it("maps a real MusicBrainz transport outage to 503 while preserving a true zero result", async () => {
		let unavailable = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				if (unavailable) throw new Error("network down");
				return new Response(JSON.stringify({ artists: [] }), { status: 200 });
			}),
		);
		const reader = createMobileSearch({
			buildIndex: () => buildCacheIndex(directory),
			catalogIndex: createMusicBrainzCatalog({ failOnUnavailable: true }),
		});

		expect(await reader.search({ q: "zero result", type: "artist", limit: 8 })).toMatchObject({
			hits: [],
			sources: { cache: 0, catalog: 0 },
		});

		unavailable = true;
		const router = createMobileRouter({
			catalog: createMobileCatalog({ getGraph: async () => ({ nodes: [], edges: [] }) }),
			search: reader,
		});
		const server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			if (!(await router.handle({ req, res, url }))) res.end();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

		const response = await get(address.port, "/mobile/v1/search?q=transport-outage&type=artist");
		expect(response).toMatchObject({
			status: 503,
			body: JSON.stringify({
				error: { code: "provider_unavailable", message: "mobile search provider is temporarily unavailable" },
			}),
		});
	});

	it.each([
		["artist", { artists: [{ id: "", name: "Valid name" }] }],
		["artist", { artists: [{ id: "not-an-mbid", name: "Valid name" }] }],
		["artist", { artists: [{ id: "00000000-0000-4000-8000-000000000101", name: " " }] }],
		["project", { "release-groups": [{ id: "", title: "Valid title" }] }],
		["track", { recordings: [{ id: "00000000-0000-4000-8000-000000000102", title: " " }] }],
	] as const)("rejects a malformed MusicBrainz %s payload as unavailable", async (type, payload) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
		);
		const reader = createMobileSearch({
			buildIndex: () => buildCacheIndex(directory),
			catalogIndex: createMusicBrainzCatalog({ failOnUnavailable: true }),
		});

		await expect(reader.search({ q: `malformed ${type}`, type, limit: 8 })).rejects.toBeInstanceOf(
			MobileSearchProviderUnavailableError,
		);
	});

	it("rebuilds its real cache index only after explicit invalidation", async () => {
		const reader = search();

		expect((await reader.search({ q: "new", type: "artist", limit: 8 })).hits).toEqual([]);
		await cache.write(artistNode({ slug: "artist:new-ambient", name: "New Ambient" }));
		expect((await reader.search({ q: "new", type: "artist", limit: 8 })).hits).toEqual([]);
		reader.invalidateIndex();
		expect((await reader.search({ q: "new", type: "artist", limit: 8 })).hits).toMatchObject([
			{ source: "cache", slug: "artist:new-ambient" },
		]);
	});

	it("serves no-store HTTP search responses and public typed errors", async () => {
		const reader = search([], true);
		const router = createMobileRouter({
			catalog: createMobileCatalog({ getGraph: async () => ({ nodes: [], edges: [] }) }),
			search: reader,
		});
		const server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			if (!(await router.handle({ req, res, url }))) res.end();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

		const unavailable = await get(address.port, "/mobile/v1/search?q=ambient&type=artist&limit=8");
		const invalid = await get(address.port, "/mobile/v1/search?q=x");
		const emptyType = await get(address.port, "/mobile/v1/search?q=ambient&type=&limit=8");

		expect(unavailable).toMatchObject({
			status: 503,
			headers: { "cache-control": "no-store" },
			body: JSON.stringify({
				error: { code: "provider_unavailable", message: "mobile search provider is temporarily unavailable" },
			}),
		});
		expect(invalid).toMatchObject({
			status: 400,
			body: JSON.stringify({
				error: { code: "invalid_request", message: "q must contain 2 to 120 characters" },
			}),
		});
		expect(emptyType).toMatchObject({
			status: 400,
			body: JSON.stringify({ error: { code: "invalid_request", message: "unsupported search type" } }),
		});
	});
});
