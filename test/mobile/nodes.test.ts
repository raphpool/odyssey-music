import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../../src/cache.js";
import type { GenreRedirects } from "../../src/genre-registry.js";
import { createMobileNodeReader, MobileNodeInputError } from "../../src/mobile/nodes.js";
import type { ArtistNode, GenreNode, Slug } from "../../src/types.js";

function genreNode(overrides: Partial<GenreNode> & { slug: Slug; name: string }): GenreNode {
	return {
		type: "genre",
		editorial_article: "A real long article about this genre, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_definition: "A short definition.",
		citations: [{ url: "https://example.com/genre" }],
		materialized_at: "2000-01-01T00:00:00.000Z",
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
		editorial_bio: "A short bio.",
		editorial_article: "A real long article about this artist, well past the eighty character floor. ".repeat(
			2,
		),
		citations: [{ url: "https://example.com/artist" }],
		materialized_at: "2000-01-01T00:00:00.000Z",
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

describe("mobile node reader", () => {
	let directory: string;
	let cache: NodeCache;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "odyssey-mobile-nodes-"));
		cache = new NodeCache(directory);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("reads an old cached node through toVizNode without refreshing or requiring a model field", async () => {
		await cache.write(
			genreNode({
				slug: "genre:electronic",
				name: "Electronic",
				qid: "Q9778",
				sonic_markers: "Drum machines",
			}),
		);
		const reader = createMobileNodeReader({ cache, redirects: new Map() });

		const result = await reader.read("genre:electronic");

		expect(result).toEqual({
			node: {
				id: "genre:electronic",
				type: "genre",
				name: "Electronic",
				teaser: "A short definition.",
				article: expect.any(String),
				citations: [{ url: "https://example.com/genre" }],
				edges: {},
				facts: { sonic_markers: "Drum machines" },
				materialized_at: "2000-01-01T00:00:00.000Z",
				qid: "Q9778",
			},
			source: "cache",
		});
	});

	it("projects image_url and image_source of a cached node (TRA-455)", async () => {
		const imageUrl = "https://coverartarchive.org/release-group/6a9b9f3e/front-500";
		await cache.write(
			genreNode({
				slug: "genre:pictured",
				name: "Pictured",
				image_url: imageUrl,
				image_source: "derived-cover",
			}),
		);
		const reader = createMobileNodeReader({ cache, redirects: new Map() });

		const result = await reader.read("genre:pictured");

		expect(result?.node.image_url).toBe(imageUrl);
		expect(result?.node.image_source).toBe("derived-cover");
	});

	// iOS decodes image_url as a validated public https URL and fails the whole node on refusal.
	it.each([
		["http scheme", "http://www.giorgiomoroder.com/photo.jpg"],
		["https with a port", "https://example.com:8443/photo.jpg"],
		["private host", "https://localhost/photo.jpg"],
	])("omits an unsafe photo_url fallback (%s) without hiding the node", async (_label, photoUrl) => {
		await cache.write(artistNode({ slug: "artist:unsafe", name: "Unsafe", photo_url: photoUrl }));
		const reader = createMobileNodeReader({ cache, redirects: new Map() });

		const result = await reader.read("artist:unsafe");

		expect(result?.node.id).toBe("artist:unsafe");
		expect(result ? "image_url" in result.node : true).toBe(false);
		expect(result ? "image_source" in result.node : true).toBe(false);
	});

	it("keeps a safe photo_url fallback and projects no image_source for it", async () => {
		await cache.write(
			artistNode({ slug: "artist:safe", name: "Safe", photo_url: "https://example.com/photo.jpg" }),
		);
		const reader = createMobileNodeReader({ cache, redirects: new Map() });

		const result = await reader.read("artist:safe");

		expect(result?.node.image_url).toBe("https://example.com/photo.jpg");
		expect(result ? "image_source" in result.node : true).toBe(false);
	});

	it("reads a genre alias from the canonical cache node and reports it", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
		const redirects: GenreRedirects = new Map([
			["genre:electronic-music" as Slug, "genre:electronic" as Slug],
		]);
		const reader = createMobileNodeReader({ cache, redirects });

		const result = await reader.read("genre:electronic-music");

		expect(result?.node.id).toBe("genre:electronic");
		expect(result?.redirected_from).toBe("genre:electronic-music");
		expect(result?.source).toBe("cache");
	});

	it("filters non-public citation links from a real cached node without hiding the node", async () => {
		await cache.write(
			genreNode({
				slug: "genre:cited",
				name: "Cited",
				citations: [
					{ url: "https://public.example.com/source", title: "Public source" },
					{ url: "http://legacy.example.com/source", title: "Legacy source" },
					{ url: "https://user@localhost/source", title: "Hostile source" },
				],
			}),
		);
		const reader = createMobileNodeReader({ cache, redirects: new Map() });

		const result = await reader.read("genre:cited");

		expect(result?.node.citations).toEqual([
			{ url: "https://public.example.com/source", title: "Public source" },
		]);
	});

	it("returns null for an absent valid slug and rejects unsafe slugs before cache reads", async () => {
		const reader = createMobileNodeReader({ cache, redirects: new Map() });

		await expect(reader.read("genre:does-not-exist")).resolves.toBeNull();
		await expect(reader.read("artist:../../etc/passwd")).rejects.toBeInstanceOf(MobileNodeInputError);
		await expect(reader.read("article:ignored")).rejects.toThrow("invalid node slug");
	});
});
