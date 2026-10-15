import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../../src/cache.js";
import type { GenreRedirects } from "../../src/genre-registry.js";
import { createMobileCatalog } from "../../src/mobile/catalog.js";
import { createMobileMedia, MobileProviderUnavailableError } from "../../src/mobile/media.js";
import { createMobileNodeReader, safePublicHttpsUrl } from "../../src/mobile/nodes.js";
import { createMobileRouter } from "../../src/mobile/router.js";
import { createImageService } from "../../src/services/image-service.js";
import type { ResolveLinksInput, StreamingLinks } from "../../src/streaming-links.js";
import type { ArtistNode, GenreNode, LabelNode, Slug } from "../../src/types.js";

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
		similar_artists: [],
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

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
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

describe("mobile media reader", () => {
	let directory: string;
	let cache: NodeCache;
	let redirects: GenreRedirects;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "odyssey-mobile-media-"));
		cache = new NodeCache(directory);
		redirects = new Map();
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	function media(resolveLinks: (input: ResolveLinksInput) => Promise<StreamingLinks>) {
		const nodes = createMobileNodeReader({ cache, redirects });
		return {
			nodes,
			media: createMobileMedia({
				nodes,
				imageService: createImageService({ cache, redirects }),
				resolveLinks,
				cacheDir: directory,
			}),
		};
	}

	it("returns null for a hostile image URL and safely terminates a cyclic image walk", async () => {
		await cache.write(
			artistNode({
				slug: "artist:hostile",
				name: "Hostile",
				photo_url: "https://user:pass@127.0.0.1:444/a.jpg",
			}),
		);
		await cache.write(
			genreNode({
				slug: "genre:a",
				name: "A",
				related_genres: [{ slug: "genre:b", type: "genre", name: "B" }],
			}),
		);
		await cache.write(
			genreNode({
				slug: "genre:b",
				name: "B",
				related_genres: [{ slug: "genre:a", type: "genre", name: "A" }],
			}),
		);
		const { media: reader } = media(async () => ({
			spotify: null,
			apple: null,
			sources: {},
			resolvedAt: "2026-01-01T00:00:00.000Z",
		}));

		await expect(reader.image("artist:hostile")).resolves.toMatchObject({
			image_url: null,
			source: "legacy",
		});
		await expect(reader.image("genre:a")).resolves.toMatchObject({ image_url: null, source: "no-match" });
	});

	it("returns only public exact streaming hosts and avoids resolving genre and label links", async () => {
		await cache.write(artistNode({ slug: "artist:public", name: "Public" }));
		await cache.write(genreNode({ slug: "genre:ambient", name: "Ambient" }));
		await cache.write(labelNode({ slug: "label:quiet", name: "Quiet" }));
		let calls = 0;
		const { media: reader } = media(async (input) => {
			calls += 1;
			expect(input).not.toHaveProperty("force");
			return {
				spotify: "https://user@open.spotify.com:444/artist/x",
				apple: "https://music.apple.com/us/artist/public/1",
				sources: { spotify: "musicbrainz", apple: "itunes" },
				resolvedAt: "2026-01-01T00:00:00.000Z",
			};
		});

		await expect(reader.links("artist:public")).resolves.toEqual({
			slug: "artist:public",
			spotify: null,
			apple: "https://music.apple.com/us/artist/public/1",
			sources: { apple: "itunes" },
			resolvedAt: "2026-01-01T00:00:00.000Z",
		});
		await expect(reader.links("genre:ambient")).resolves.toMatchObject({
			spotify: null,
			apple: null,
			sources: {},
		});
		await expect(reader.links("label:quiet")).resolves.toMatchObject({
			spotify: null,
			apple: null,
			sources: {},
		});
		expect(calls).toBe(1);
	});

	it("rejects IPv4-mapped private IPv6 URLs, including normalized forms", () => {
		expect(safePublicHttpsUrl("https://[::ffff:127.0.0.1]/cover.jpg")).toBeNull();
		expect(safePublicHttpsUrl("https://[::ffff:10.0.0.1]/cover.jpg")).toBeNull();
		expect(safePublicHttpsUrl("https://[0:0:0:0:0:ffff:127.0.0.1]/cover.jpg")).toBeNull();
	});

	it("maps provider failures to a public error without exposing its cause", async () => {
		await cache.write(artistNode({ slug: "artist:offline", name: "Offline" }));
		const { media: reader } = media(async () => {
			throw new Error("upstream key abc123 rejected");
		});

		await expect(reader.links("artist:offline")).rejects.toBeInstanceOf(MobileProviderUnavailableError);
	});

	it("serves node, image, and links routes with private 24-hour caching", async () => {
		await cache.write(
			artistNode({
				slug: "artist:cached",
				name: "Cached",
				photo_url: "https://images.example.com/cached.jpg",
			}),
		);
		const { nodes, media: reader } = media(async () => ({
			spotify: "https://open.spotify.com/artist/cached",
			apple: null,
			sources: { spotify: "musicbrainz" },
			resolvedAt: "2026-01-01T00:00:00.000Z",
		}));
		const router = createMobileRouter({
			catalog: createMobileCatalog({ getGraph: async () => ({ nodes: [], edges: [] }) }),
			nodes,
			media: reader,
		});
		const server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			if (!(await router.handle({ req, res, url }))) res.end();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

		const node = await get(address.port, "/mobile/v1/nodes/artist%3Acached");
		const image = await get(address.port, "/mobile/v1/nodes/artist%3Acached/image");
		const links = await get(address.port, "/mobile/v1/nodes/artist%3Acached/links");

		for (const response of [node, image, links])
			expect(response.headers["cache-control"]).toBe("private, max-age=86400");
		expect(JSON.parse(node.body)).toMatchObject({ source: "cache", node: { id: "artist:cached" } });
		expect(JSON.parse(image.body)).toMatchObject({ image_url: "https://images.example.com/cached.jpg" });
		expect(JSON.parse(links.body)).toMatchObject({ spotify: "https://open.spotify.com/artist/cached" });
	});
});
