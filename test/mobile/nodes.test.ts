import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../../src/cache.js";
import type { GenreRedirects } from "../../src/genre-registry.js";
import { createMobileNodeReader, MobileNodeInputError, safePublicHttpsUrl } from "../../src/mobile/nodes.js";
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
		similar_artists: [],
		...overrides,
	};
}

// Same case table as ios/Track1Core/Tests/Track1CoreTests/API/URLValidationTests.swift (TRA-496).
describe("safePublicHttpsUrl", () => {
	it.each([
		["plain http", "http://example.com/"],
		["loopback IPv4", "https://127.0.0.1/"],
		["IPv4-mapped loopback (hex words)", "https://[::ffff:7f00:1]/"],
		["IPv4-mapped loopback (dotted)", "https://[::ffff:127.0.0.1]/"],
		["decimal integer IPv4", "https://2130706433/"],
		["hexadecimal IPv4", "https://0x7f000001/"],
		["shortened IPv4", "https://127.1/"],
		["octal IPv4", "https://0177.0.0.1/"],
		["unique-local IPv6 literal", "https://[fd00::1]/x"],
		["link-local IPv6 literal", "https://[fe80::1]/x"],
		["hex 10.0.0.1", "https://0xa000001/"],
		["decimal 192.168.1.1", "https://3232235777/"],
		["decimal 169.254.169.254", "https://2852039166/"],
		["uppercase hexadecimal IPv4", "https://0X7F000001/"],
		["trailing-dot loopback", "https://127.0.0.1./"],
		["full-width digits loopback", "https://１２７.０.０.１/"],
		["invalid octal numeric host", "https://08.8.8.8/"],
		["private IPv4", "https://10.0.0.1/x"],
		["localhost", "https://localhost/x"],
		["trailing-dot localhost", "https://localhost./x"],
		["explicit port", "https://example.com:8443/"],
	])("refuses %s", (_label, url) => {
		expect(safePublicHttpsUrl(url)).toBeNull();
	});

	// 2026-10-14 (TRA-496): the IPv6 prefix checks ran on every host, so fdroid.org was refused.
	it.each([
		"https://fdroid.org/x",
		"https://fcbayern.com/",
		"https://feb.example/",
		"https://fe80.example/",
		"https://8.8.8.8/",
	])("accepts %s", (url) => {
		expect(safePublicHttpsUrl(url)).toBe(new URL(url).toString());
	});

	it("still pins the provider host", () => {
		expect(safePublicHttpsUrl("https://open.spotify.com/track/1", "open.spotify.com")).not.toBeNull();
		expect(safePublicHttpsUrl("https://evil.example/track/1", "open.spotify.com")).toBeNull();
	});
});

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

	// TRA-594: legacy photo_url / cover_url are never promoted to image_url, whatever their shape.
	it.each([
		["http scheme", "http://www.giorgiomoroder.com/photo.jpg"],
		["https with a port", "https://example.com:8443/photo.jpg"],
		["private host", "https://localhost/photo.jpg"],
		["safe https", "https://example.com/photo.jpg"],
		["mzstatic", "https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg"],
	])("projects no image from a legacy photo_url (%s) and keeps the node", async (_label, photoUrl) => {
		await cache.write(artistNode({ slug: "artist:legacy", name: "Legacy", photo_url: photoUrl }));
		const reader = createMobileNodeReader({ cache, redirects: new Map() });

		const result = await reader.read("artist:legacy");

		expect(result?.node.id).toBe("artist:legacy");
		expect(result ? "image_url" in result.node : true).toBe(false);
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
