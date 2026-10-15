import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { GenreRedirects } from "../src/genre-registry.js";
import { createImageService } from "../src/services/image-service.js";
import type { ArtistNode, GenreNode, LabelNode, ProjectNode, Slug } from "../src/types.js";

// TRA-39: image-service.resolveDisplayImage must apply the same "live node wins, else follow the
// flattened genre-redirect table" rule node-service.getNode already applies (TRA-30). Before this,
// GET /image/genre:electronic-music served { image_url: null, source: "not-cached" } forever, even
// though genre:electronic (and its landmark covers) exist and GET /node/genre:electronic-music
// already serves the canonical node for the same slug.
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

const CAA_URL = "https://coverartarchive.org/release/abc/front-500.jpg";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveDisplayImage (TRA-475)", () => {
	let dir: string;
	let cache: NodeCache;
	let clock: number;
	let fetchSpy: MockInstance<typeof fetch>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-image-service-"));
		cache = new NodeCache(dir);
		clock = 1_000_000;
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(dir, { recursive: true, force: true });
	});

	function service(redirects: GenreRedirects = new Map()) {
		return createImageService({ cache, redirects, now: () => clock });
	}

	it("serves a genre's stored image_url with its stored source, without reading any edge", async () => {
		await cache.write(
			genreNode({
				slug: "genre:house",
				name: "House",
				image_url: CAA_URL,
				image_source: "derived-cover",
				landmark_projects: [{ type: "project", slug: "project:landmark", name: "Landmark" }],
			}),
		);
		const getSpy = vi.spyOn(cache, "get");

		const result = await service().resolveDisplayImage("genre:house" as Slug);

		expect(result).toEqual({ slug: "genre:house", image_url: CAA_URL, source: "derived-cover" });
		expect(getSpy).toHaveBeenCalledTimes(1);
	});

	it("serves a legacy cover_url as source legacy when there is no image_url", async () => {
		await cache.write(
			projectNode({ slug: "project:old", name: "Old", cover_url: "https://img.example.com/old.jpg" }),
		);

		const result = await service().resolveDisplayImage("project:old" as Slug);

		expect(result).toEqual({
			slug: "project:old",
			image_url: "https://img.example.com/old.jpg",
			source: "legacy",
		});
	});

	it("serves an artist's legacy photo_url as source legacy", async () => {
		await cache.write(
			artistNode({ slug: "artist:someone", name: "Someone", photo_url: "https://img.example.com/p.jpg" }),
		);

		const result = await service().resolveDisplayImage("artist:someone" as Slug);

		expect(result).toEqual({
			slug: "artist:someone",
			image_url: "https://img.example.com/p.jpg",
			source: "legacy",
		});
	});

	it("ignores a stored image_url off the host allowlist and falls back to the legacy field", async () => {
		const cacheWithHostile = {
			get: async () => ({
				...projectNode({
					slug: "project:hostile",
					name: "Hostile",
					cover_url: "https://img.example.com/ok.jpg",
				}),
				image_url: "https://evil.example.com/x.jpg",
				image_source: "caa",
			}),
		} as unknown as NodeCache;
		const imageService = createImageService({ cache: cacheWithHostile, redirects: new Map() });

		const result = await imageService.resolveDisplayImage("project:hostile" as Slug);

		expect(result).toEqual({
			slug: "project:hostile",
			image_url: "https://img.example.com/ok.jpg",
			source: "legacy",
		});
	});

	it("borrows the first notable release's image for a label, as related:<slug>, without writing", async () => {
		await cache.write(
			projectNode({ slug: "project:release-b", name: "Release B", image_url: CAA_URL, image_source: "caa" }),
		);
		await cache.write(projectNode({ slug: "project:release-a", name: "Release A" }));
		await cache.write(
			labelNode({
				slug: "label:imprint",
				name: "Imprint",
				notable_releases: [
					{ type: "project", slug: "project:release-a", name: "Release A" },
					{ type: "project", slug: "project:release-b", name: "Release B" },
				],
			}),
		);
		const writeSpy = vi.spyOn(cache, "write");

		const result = await service().resolveDisplayImage("label:imprint" as Slug);

		expect(result).toEqual({
			slug: "label:imprint",
			image_url: CAA_URL,
			source: "related:project:release-b",
		});
		expect(writeSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not borrow an iTunes cover for a project without image: no-match, no fetch, no write", async () => {
		await cache.write(
			projectNode({
				slug: "project:bare",
				name: "Bare",
				artists: [{ type: "artist", slug: "artist:nobody", name: "Nobody" }],
			}),
		);
		const writeSpy = vi.spyOn(cache, "write");

		const result = await service().resolveDisplayImage("project:bare" as Slug);

		expect(result).toEqual({ slug: "project:bare", image_url: null, source: "no-match" });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("negative-caches no-match for 24h: the second call does not read the cache", async () => {
		await cache.write(projectNode({ slug: "project:bare", name: "Bare" }));
		const imageService = service();
		await imageService.resolveDisplayImage("project:bare" as Slug);
		const getSpy = vi.spyOn(cache, "get");

		clock += DAY_MS - 1;
		const again = await imageService.resolveDisplayImage("project:bare" as Slug);

		expect(again).toEqual({ slug: "project:bare", image_url: null, source: "no-match" });
		expect(getSpy).not.toHaveBeenCalled();

		clock += 2;
		await imageService.resolveDisplayImage("project:bare" as Slug);
		expect(getSpy).toHaveBeenCalled();
	});

	it("clearNegativeCache lets a newly materialized image show up immediately", async () => {
		await cache.write(projectNode({ slug: "project:later", name: "Later" }));
		const imageService = service();
		expect((await imageService.resolveDisplayImage("project:later" as Slug)).source).toBe("no-match");

		await cache.write(
			projectNode({ slug: "project:later", name: "Later", image_url: CAA_URL, image_source: "caa" }),
		);
		imageService.clearNegativeCache();

		expect(await imageService.resolveDisplayImage("project:later" as Slug)).toEqual({
			slug: "project:later",
			image_url: CAA_URL,
			source: "caa",
		});
	});

	it("does not negative-cache an uncached slug (unbounded input) nor a positive answer", async () => {
		const imageService = service();
		await imageService.resolveDisplayImage("project:ghost" as Slug);
		await cache.write(
			projectNode({ slug: "project:ghost", name: "Ghost", image_url: CAA_URL, image_source: "caa" }),
		);

		const result = await imageService.resolveDisplayImage("project:ghost" as Slug);

		expect(result.source).toBe("caa");
	});

	it("terminates on a cyclic edge walk", async () => {
		// The schema cannot produce a cycle (edge types are constrained), so a hand-made cache stands in
		// for hostile or hand-edited data: each node points at the other.
		const nodes: Record<string, ArtistNode> = {
			"artist:a": artistNode({
				slug: "artist:a",
				name: "A",
				discography: [{ type: "project", slug: "artist:b", name: "B" }],
			}),
			"artist:b": artistNode({
				slug: "artist:b",
				name: "B",
				discography: [{ type: "project", slug: "artist:a", name: "A" }],
			}),
		};
		const cyclic = { get: async (slug: string) => nodes[slug] } as unknown as NodeCache;
		const imageService = createImageService({ cache: cyclic, redirects: new Map() });

		const result = await imageService.resolveDisplayImage("artist:a" as Slug);

		expect(result).toEqual({ slug: "artist:a", image_url: null, source: "no-match" });
	});

	describe("genre redirects (TRA-39)", () => {
		it("serves the canonical node's image for a slug redirected away from it", async () => {
			await cache.write(
				projectNode({
					slug: "project:landmark",
					name: "Landmark",
					cover_url: "https://img.example.com/a.jpg",
				}),
			);
			await cache.write(
				genreNode({
					slug: "genre:electronic",
					name: "Electronic",
					landmark_projects: [{ type: "project", slug: "project:landmark", name: "Landmark" }],
				}),
			);
			const redirects: GenreRedirects = new Map([["genre:electronic-music", "genre:electronic"]]);
			const imageService = createImageService({ cache, redirects });

			const result = await imageService.resolveDisplayImage("genre:electronic-music" as Slug);

			expect(result).toEqual({
				slug: "genre:electronic-music",
				image_url: "https://img.example.com/a.jpg",
				source: "related:project:landmark",
			});
		});

		it("still reports not-cached for a slug with neither a live node nor a redirect entry", async () => {
			const imageService = createImageService({ cache, redirects: new Map() });

			const result = await imageService.resolveDisplayImage("genre:does-not-exist" as Slug);

			expect(result).toEqual({ slug: "genre:does-not-exist", image_url: null, source: "not-cached" });
		});
	});
});
