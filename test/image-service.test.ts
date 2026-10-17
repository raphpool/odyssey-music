import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import { onDemandImagesEnabled } from "../src/flags.js";
import type { GenreRedirects } from "../src/genre-registry.js";
import type { EnqueueOutcome, ImageQueue } from "../src/images/image-queue.js";
import { type ImageSidecarEntry, writeImageSidecar } from "../src/images/image-sidecar.js";
import type { WorkImageHint } from "../src/images/resolve-work-hint.js";
import { createImageService } from "../src/services/image-service.js";
import { makeScopedSlug } from "../src/slug.js";
import type {
	ArtistNode,
	EdgeRef,
	GenreNode,
	LabelNode,
	NodePayload,
	ProjectNode,
	Slug,
	TrackNode,
} from "../src/types.js";

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

		expect(result).toEqual({
			slug: "genre:house",
			image_url: CAA_URL,
			source: "derived-cover",
			state: "found",
		});
		expect(getSpy).toHaveBeenCalledTimes(1);
	});

	// 2026-10-16 (TRA-592): GET /image still served the unverified photo_url / cover_url, which is where
	// Grandmaster Flash got an Earth, Wind & Fire cover and Gat Decor a Wikipedia icon.
	it("does not serve a legacy mzstatic cover_url: Grandmaster Flash has no image (TRA-592)", async () => {
		await cache.write(
			artistNode({
				slug: "artist:grandmaster-flash",
				name: "Grandmaster Flash",
				photo_url: "https://is1-ssl.mzstatic.com/image/thumb/Music/ewf/600x600bb.jpg",
			}),
		);
		await cache.write(
			projectNode({
				slug: "project:ewf-compilation",
				name: "Earth, Wind & Fire compilation",
				cover_url: "https://is1-ssl.mzstatic.com/image/thumb/Music/ewf/600x600bb.jpg",
			}),
		);

		const artist = await service().resolveDisplayImage("artist:grandmaster-flash" as Slug);
		const project = await service().resolveDisplayImage("project:ewf-compilation" as Slug);

		expect(artist).toEqual({
			slug: "artist:grandmaster-flash",
			image_url: null,
			source: "no-match",
			state: "none",
		});
		expect(project).toEqual({
			slug: "project:ewf-compilation",
			image_url: null,
			source: "no-match",
			state: "none",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not serve a Wikipedia icon held in photo_url: Gat Decor has no image (TRA-592)", async () => {
		await cache.write(
			artistNode({
				slug: "artist:gat-decor",
				name: "Gat Decor",
				photo_url:
					"https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/Wikipedia-logo-v2.svg/200px.png",
			}),
		);

		const result = await service().resolveDisplayImage("artist:gat-decor" as Slug);

		expect(result).toEqual({ slug: "artist:gat-decor", image_url: null, source: "no-match", state: "none" });
	});

	it("ignores a stored image_url off the host allowlist and does not fall back to the legacy field", async () => {
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

		expect(result).toEqual({ slug: "project:hostile", image_url: null, source: "no-match", state: "none" });
	});

	it("prefers the stored image_url over a legacy cover_url on the same node", async () => {
		await cache.write(
			projectNode({
				slug: "project:both",
				name: "Both",
				cover_url: "https://img.example.com/legacy.jpg",
				image_url: CAA_URL,
				image_source: "caa",
			}),
		);

		const result = await service().resolveDisplayImage("project:both" as Slug);

		expect(result).toEqual({ slug: "project:both", image_url: CAA_URL, source: "caa", state: "found" });
	});

	it("borrows the first notable release's image for a label, as related:<slug>, without writing", async () => {
		const imprint: EdgeRef = { type: "label", slug: "label:imprint", name: "Imprint" };
		await cache.write(
			projectNode({
				slug: "project:release-b",
				name: "Release B",
				image_url: CAA_URL,
				image_source: "caa",
				label: imprint,
			}),
		);
		await cache.write(projectNode({ slug: "project:release-a", name: "Release A", label: imprint }));
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
			state: "found",
		});
		expect(writeSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	describe("borrowing only from a work that points back (TRA-592)", () => {
		const mp: EdgeRef = { type: "label", slug: "label:mille-plateaux", name: "Mille Plateaux" };

		it("label:mille-plateaux does not get Electric Ladyland, a Reprise release", async () => {
			await cache.write(
				projectNode({
					slug: "project:electric-ladyland",
					name: "Electric Ladyland",
					image_url: CAA_URL,
					image_source: "caa",
					label: { type: "label", slug: "label:reprise", name: "Reprise" },
				}),
			);
			await cache.write(
				labelNode({
					slug: "label:mille-plateaux",
					name: "Mille Plateaux",
					notable_releases: [
						{ type: "project", slug: "project:electric-ladyland", name: "Electric Ladyland" },
					],
				}),
			);

			const result = await service().resolveDisplayImage("label:mille-plateaux" as Slug);

			expect(result).toEqual({
				slug: "label:mille-plateaux",
				image_url: null,
				source: "no-match",
				state: "none",
			});
		});

		it("skips a work that does not point back and borrows the next one that does", async () => {
			await cache.write(
				projectNode({ slug: "project:electric-ladyland", name: "Electric Ladyland", image_url: CAA_URL }),
			);
			await cache.write(
				projectNode({
					slug: "project:oval",
					name: "Systemisch",
					image_url: "https://coverartarchive.org/release/def/front-500.jpg",
					image_source: "caa",
					label: mp,
				}),
			);
			await cache.write(
				labelNode({
					slug: "label:mille-plateaux",
					name: "Mille Plateaux",
					notable_releases: [
						{ type: "project", slug: "project:electric-ladyland", name: "Electric Ladyland" },
						{ type: "project", slug: "project:oval", name: "Systemisch" },
					],
				}),
			);

			const result = await service().resolveDisplayImage("label:mille-plateaux" as Slug);

			expect(result).toMatchObject({
				image_url: "https://coverartarchive.org/release/def/front-500.jpg",
				source: "related:project:oval",
				state: "found",
			});
		});

		it("an artist borrows only a work that credits it (a band member does not borrow the band's cover)", async () => {
			await cache.write(
				projectNode({
					slug: "project:band-album",
					name: "Band Album",
					image_url: CAA_URL,
					image_source: "caa",
					artists: [{ type: "artist", slug: "artist:the-band", name: "The Band" }],
				}),
			);
			await cache.write(
				artistNode({
					slug: "artist:member",
					name: "Member",
					discography: [{ type: "project", slug: "project:band-album", name: "Band Album" }],
				}),
			);
			await cache.write(
				artistNode({
					slug: "artist:the-band",
					name: "The Band",
					discography: [{ type: "project", slug: "project:band-album", name: "Band Album" }],
				}),
			);

			expect((await service().resolveDisplayImage("artist:member" as Slug)).state).toBe("none");
			expect(await service().resolveDisplayImage("artist:the-band" as Slug)).toMatchObject({
				image_url: CAA_URL,
				source: "related:project:band-album",
				state: "found",
			});
		});

		it("a genre borrows only a landmark that carries the genre", async () => {
			await cache.write(
				projectNode({
					slug: "project:other-genre",
					name: "Other",
					image_url: CAA_URL,
					genres: [{ type: "genre", slug: "genre:jazz", name: "Jazz" }],
				}),
			);
			await cache.write(
				genreNode({
					slug: "genre:techno",
					name: "Techno",
					landmark_projects: [{ type: "project", slug: "project:other-genre", name: "Other" }],
				}),
			);

			expect((await service().resolveDisplayImage("genre:techno" as Slug)).state).toBe("none");
		});

		it("a genre borrows a landmark carrying its direct parent, not its grandparent (TRA-597)", async () => {
			await cache.write(
				projectNode({
					slug: "project:dnb-album",
					name: "DnB Album",
					image_url: CAA_URL,
					genres: [{ type: "genre", slug: "genre:drum-and-bass", name: "Drum and bass" }],
				}),
			);
			await cache.write(
				projectNode({
					slug: "project:breakbeat-album",
					name: "Breakbeat Album",
					image_url: CAA_URL,
					genres: [{ type: "genre", slug: "genre:breakbeat", name: "Breakbeat" }],
				}),
			);
			const landmarks = (...slugs: string[]) =>
				slugs.map((s) => ({ type: "project" as const, slug: s as Slug, name: s }));
			await cache.write(
				genreNode({
					slug: "genre:drum-and-bass",
					name: "Drum and bass",
					parent_genres: [{ type: "genre", slug: "genre:breakbeat", name: "Breakbeat" }],
				}),
			);
			// jungle's landmark carries breakbeat, a grandparent (drum-and-bass's parent): refused.
			await cache.write(
				genreNode({
					slug: "genre:jungle",
					name: "Jungle",
					parent_genres: [{ type: "genre", slug: "genre:drum-and-bass", name: "Drum and bass" }],
					landmark_projects: landmarks("project:breakbeat-album"),
				}),
			);
			expect((await service().resolveDisplayImage("genre:jungle" as Slug)).state).toBe("none");

			// The same genre listing a drum-and-bass album, its direct parent: borrowed.
			await cache.write(
				genreNode({
					slug: "genre:jungle",
					name: "Jungle",
					parent_genres: [{ type: "genre", slug: "genre:drum-and-bass", name: "Drum and bass" }],
					landmark_projects: landmarks("project:dnb-album"),
				}),
			);
			const result = await service().resolveDisplayImage("genre:jungle" as Slug);
			expect(result.state).not.toBe("none");
			expect(result.image_url).toBe(CAA_URL);
		});

		it("a track still borrows its own project's image, as the resolver does", async () => {
			await cache.write(
				projectNode({ slug: "project:lp", name: "LP", image_url: CAA_URL, image_source: "caa" }),
			);
			await cache.write(
				trackNode({
					slug: "track:song",
					name: "Song",
					project: { type: "project", slug: "project:lp", name: "LP" },
				}),
			);

			expect(await service().resolveDisplayImage("track:song" as Slug)).toMatchObject({
				image_url: CAA_URL,
				source: "related:project:lp",
				state: "found",
			});
		});

		it("lends only the image a work stores, not one it would itself borrow", async () => {
			await cache.write(projectNode({ slug: "project:lp", name: "LP", image_url: CAA_URL }));
			await cache.write(
				trackNode({
					slug: "track:song",
					name: "Song",
					project: { type: "project", slug: "project:lp", name: "LP" },
					genres: [{ type: "genre", slug: "genre:techno", name: "Techno" }],
				}),
			);
			await cache.write(
				genreNode({
					slug: "genre:techno",
					name: "Techno",
					landmark_tracks: [{ type: "track", slug: "track:song", name: "Song" }],
				}),
			);

			expect((await service().resolveDisplayImage("genre:techno" as Slug)).state).toBe("none");
		});
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

		expect(result).toEqual({ slug: "project:bare", image_url: null, source: "no-match", state: "none" });
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

		expect(again).toEqual({ slug: "project:bare", image_url: null, source: "no-match", state: "none" });
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
			state: "found",
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

		expect(result).toEqual({ slug: "artist:a", image_url: null, source: "no-match", state: "none" });
	});

	describe("genre redirects (TRA-39)", () => {
		it("serves the canonical node's image for a slug redirected away from it", async () => {
			await cache.write(
				projectNode({
					slug: "project:landmark",
					name: "Landmark",
					image_url: CAA_URL,
					image_source: "caa",
					genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic" }],
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
				image_url: CAA_URL,
				source: "related:project:landmark",
				state: "found",
			});
		});

		it("still reports not-cached for a slug with neither a live node nor a redirect entry", async () => {
			const imageService = createImageService({ cache, redirects: new Map() });

			const result = await imageService.resolveDisplayImage("genre:does-not-exist" as Slug);

			expect(result).toEqual({
				slug: "genre:does-not-exist",
				image_url: null,
				source: "not-cached",
				state: "none",
			});
		});
	});
});

// TRA-582 (3b.5): three states, page warming and the ODYSSEY_ON_DEMAND_IMAGES kill switch. The queue is
// a small in-memory double (its real behaviour is covered by image-queue.test.ts); the sidecar is real,
// in a temporary folder. No network: fetch is spied and must never be called.
describe("on-demand images (TRA-582)", () => {
	const ENV = ["ODYSSEY_ON_DEMAND_IMAGES", "ODYSSEY_SCOPED_RELEASE_SLUGS"] as const;
	const MIN_MS = 60 * 1000;
	let dir: string;
	let sidecarDir: string;
	let cache: NodeCache;
	let clock: number;
	let fetchSpy: MockInstance<typeof fetch>;
	let saved: Record<string, string | undefined>;

	beforeEach(async () => {
		saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
		for (const k of ENV) delete process.env[k];
		dir = await mkdtemp(join(tmpdir(), "odyssey-image-service-"));
		sidecarDir = await mkdtemp(join(tmpdir(), "odyssey-image-sidecar-"));
		cache = new NodeCache(dir);
		clock = 1_000_000;
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const k of ENV) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		await rm(dir, { recursive: true, force: true });
		await rm(sidecarDir, { recursive: true, force: true });
	});

	function fakeQueue() {
		const pending = new Set<Slug>();
		const aliases = new Map<Slug, Slug | "conflict">();
		const queue = {
			enqueueNode: vi.fn((node: NodePayload): EnqueueOutcome => {
				pending.add(node.slug);
				return { accepted: true, key: node.slug };
			}),
			enqueueHint: vi.fn((hint: WorkImageHint): EnqueueOutcome => {
				const scoped = makeScopedSlug(hint.type, hint.title, hint.artist);
				if (!scoped.ok) return { accepted: false, reason: "unscopable" };
				if (hint.slug !== scoped.slug && !aliases.has(hint.slug)) aliases.set(hint.slug, scoped.slug);
				pending.add(scoped.slug);
				return { accepted: true, key: scoped.slug };
			}),
			stateOf: vi.fn((key: Slug) => (pending.has(key) ? ("pending" as const) : ("idle" as const))),
			aliasOf: vi.fn((slug: Slug) => aliases.get(slug) ?? null),
			stats: vi.fn(),
			stop: vi.fn(),
		};
		return { queue, pending, aliases, asQueue: queue as unknown as ImageQueue };
	}

	function setup(redirects: GenreRedirects = new Map()) {
		const q = fakeQueue();
		const imageService = createImageService({
			cache,
			redirects,
			now: () => clock,
			onDemand: { queue: q.asQueue, cacheDir: sidecarDir },
		});
		return { ...q, imageService };
	}

	function putSidecar(
		key: Slug,
		state: "found" | "missing" | "unavailable" | "conflict",
		extra: Partial<ImageSidecarEntry> = {},
	): Promise<void> {
		const found = state === "found" ? { url: CAA_URL, source: "caa" as const } : {};
		return writeImageSidecar(sidecarDir, {
			key,
			state,
			...found,
			hint: { title: "Title", artist: "Artist" },
			resolvedAt: new Date(clock).toISOString(),
			...extra,
		});
	}

	const edge = (type: EdgeRef["type"], slug: string, name: string, more: Partial<EdgeRef> = {}): EdgeRef => ({
		type,
		slug: slug as Slug,
		name,
		...more,
	});

	describe("onDemandImagesEnabled", () => {
		it.each([
			[undefined, true],
			["1", true],
			["true", true],
			["TRUE", true],
			[" true ", true],
			["0", false],
			["false", false],
			["FALSE", false],
			[" 0 ", false],
		])("ODYSSEY_ON_DEMAND_IMAGES=%j gives %s", (raw, expected) => {
			if (raw === undefined) delete process.env.ODYSSEY_ON_DEMAND_IMAGES;
			else process.env.ODYSSEY_ON_DEMAND_IMAGES = raw;
			expect(onDemandImagesEnabled()).toBe(expected);
		});
	});

	describe("without onDemand", () => {
		it("answers none for an unknown slug and found for a stored image, each with its state", async () => {
			await cache.write(
				projectNode({ slug: "project:has", name: "Has", image_url: CAA_URL, image_source: "caa" }),
			);
			const imageService = createImageService({ cache, redirects: new Map(), now: () => clock });

			expect(await imageService.resolveDisplayImage("project:has" as Slug)).toMatchObject({ state: "found" });
			expect(await imageService.resolveDisplayImage("project:nope--nobody" as Slug)).toEqual({
				slug: "project:nope--nobody",
				image_url: null,
				source: "not-cached",
				state: "none",
			});
		});

		it("warm is a no-op", () => {
			const imageService = createImageService({ cache, redirects: new Map(), now: () => clock });
			expect(() => imageService.warm(artistNode({ slug: "artist:a", name: "A" }))).not.toThrow();
		});
	});

	describe("a node that exists", () => {
		it("serves its image_url without touching the queue", async () => {
			await cache.write(
				projectNode({ slug: "project:has", name: "Has", image_url: CAA_URL, image_source: "caa" }),
			);
			const { imageService, queue } = setup();

			const result = await imageService.resolveDisplayImage("project:has" as Slug);

			expect(result).toEqual({ slug: "project:has", image_url: CAA_URL, source: "caa", state: "found" });
			expect(queue.enqueueNode).not.toHaveBeenCalled();
			expect(queue.enqueueHint).not.toHaveBeenCalled();
			expect(queue.stateOf).not.toHaveBeenCalled();
		});

		it("serves the sidecar entry found under its slug, with the entry's source, without walking edges", async () => {
			await cache.write(
				projectNode({ slug: "project:later", name: "Later", tracklist: [edge("track", "track:x--y", "X")] }),
			);
			await putSidecar("project:later" as Slug, "found", { source: "itunes-verified" });
			const { imageService, queue } = setup();
			const getSpy = vi.spyOn(cache, "get");

			const result = await imageService.resolveDisplayImage("project:later" as Slug);

			expect(result).toEqual({
				slug: "project:later",
				image_url: CAA_URL,
				source: "itunes-verified",
				state: "found",
			});
			expect(getSpy).toHaveBeenCalledTimes(1);
			expect(queue.enqueueNode).not.toHaveBeenCalled();
		});

		it("borrows an edge's image AND enqueues its own job", async () => {
			await cache.write(
				projectNode({
					slug: "project:release-b",
					name: "B",
					image_url: CAA_URL,
					image_source: "caa",
					label: edge("label", "label:imprint", "Imprint"),
				}),
			);
			await cache.write(
				labelNode({
					slug: "label:imprint",
					name: "Imprint",
					notable_releases: [edge("project", "project:release-b", "B")],
				}),
			);
			const { imageService, queue } = setup();

			const result = await imageService.resolveDisplayImage("label:imprint" as Slug);

			expect(result).toEqual({
				slug: "label:imprint",
				image_url: CAA_URL,
				source: "related:project:release-b",
				state: "found",
			});
			expect(queue.enqueueNode).toHaveBeenCalledTimes(1);
			expect(queue.enqueueNode.mock.calls[0]?.[0].slug).toBe("label:imprint");
		});

		it("is pending, with a retry hint, when nothing is known yet: its own job is enqueued", async () => {
			await cache.write(projectNode({ slug: "project:bare", name: "Bare" }));
			const { imageService, queue } = setup();

			const result = await imageService.resolveDisplayImage("project:bare" as Slug);

			expect(result).toEqual({
				slug: "project:bare",
				image_url: null,
				source: "pending",
				state: "pending",
				retry_after_seconds: 5,
			});
			expect(queue.enqueueNode).toHaveBeenCalledTimes(1);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("does not enqueue, and does not stay pending, when the sidecar already holds a verdict", async () => {
			await cache.write(projectNode({ slug: "project:none", name: "None" }));
			await cache.write(projectNode({ slug: "project:vague", name: "Vague" }));
			await putSidecar("project:none" as Slug, "missing", { reason: "no-match" });
			await putSidecar("project:vague" as Slug, "missing", { reason: "ambiguous" });
			const { imageService, queue } = setup();

			expect(await imageService.resolveDisplayImage("project:none" as Slug)).toMatchObject({
				state: "none",
				source: "no-match",
			});
			expect(await imageService.resolveDisplayImage("project:vague" as Slug)).toMatchObject({
				state: "none",
				source: "ambiguous",
			});
			expect(queue.enqueueNode).not.toHaveBeenCalled();
		});

		it("is none/unavailable, not remembered as a miss, when the queue refuses for lack of room", async () => {
			await cache.write(projectNode({ slug: "project:bare", name: "Bare" }));
			const { imageService, queue } = setup();
			queue.enqueueNode.mockReturnValueOnce({ accepted: false, reason: "full" });

			expect(await imageService.resolveDisplayImage("project:bare" as Slug)).toMatchObject({
				state: "none",
				source: "unavailable",
			});
			expect(await imageService.resolveDisplayImage("project:bare" as Slug)).toMatchObject({
				state: "pending",
			});
		});
	});

	describe("a slug with no node", () => {
		it("serves the sidecar entry of a scoped slug", async () => {
			await putSidecar("project:ghost--someone" as Slug, "found", { source: "itunes-verified" });
			const { imageService } = setup();

			expect(await imageService.resolveDisplayImage("project:ghost--someone" as Slug)).toEqual({
				slug: "project:ghost--someone",
				image_url: CAA_URL,
				source: "itunes-verified",
				state: "found",
			});
		});

		it("reports a missing/ambiguous sidecar as none/ambiguous", async () => {
			await putSidecar("project:ghost--someone" as Slug, "missing", { reason: "ambiguous" });
			const { imageService } = setup();

			expect(await imageService.resolveDisplayImage("project:ghost--someone" as Slug)).toEqual({
				slug: "project:ghost--someone",
				image_url: null,
				source: "ambiguous",
				state: "none",
			});
		});

		it("maps an unavailable sidecar to none/unavailable", async () => {
			await putSidecar("project:ghost--someone" as Slug, "unavailable");
			const { imageService } = setup();

			expect(await imageService.resolveDisplayImage("project:ghost--someone" as Slug)).toMatchObject({
				state: "none",
				source: "unavailable",
			});
		});

		it("is pending while the queue works on a scoped slug", async () => {
			const { imageService, pending } = setup();
			pending.add("project:ghost--someone" as Slug);

			expect(await imageService.resolveDisplayImage("project:ghost--someone" as Slug)).toMatchObject({
				state: "pending",
				retry_after_seconds: 5,
			});
		});

		it("follows a bare slug's alias to the key whose sidecar was found", async () => {
			await putSidecar("project:ghost--someone" as Slug, "found");
			const { imageService, aliases } = setup();
			aliases.set("project:ghost" as Slug, "project:ghost--someone" as Slug);

			expect(await imageService.resolveDisplayImage("project:ghost" as Slug)).toEqual({
				slug: "project:ghost",
				image_url: CAA_URL,
				source: "caa",
				state: "found",
			});
		});

		it("is none/conflict when the alias says conflict, or a conflict sidecar sits under the bare slug", async () => {
			const { imageService, aliases } = setup();
			aliases.set("project:shared" as Slug, "conflict");
			await putSidecar("project:persisted" as Slug, "conflict");

			expect(await imageService.resolveDisplayImage("project:shared" as Slug)).toMatchObject({
				state: "none",
				source: "conflict",
			});
			expect(await imageService.resolveDisplayImage("project:persisted" as Slug)).toMatchObject({
				state: "none",
				source: "conflict",
			});
		});

		it("is pending when the alias key is queued", async () => {
			const { imageService, aliases, pending } = setup();
			aliases.set("project:ghost" as Slug, "project:ghost--someone" as Slug);
			pending.add("project:ghost--someone" as Slug);

			expect(await imageService.resolveDisplayImage("project:ghost" as Slug)).toMatchObject({
				state: "pending",
			});
		});

		it("warms `from` for an unknown bare slug, with the artist's name, then is pending", async () => {
			await cache.write(
				artistNode({
					slug: "artist:roni-size",
					name: "Roni Size",
					discography: [edge("project", "project:new-forms", "New Forms")],
				}),
			);
			const { imageService, queue } = setup();

			const result = await imageService.resolveDisplayImage("project:new-forms" as Slug, {
				from: "artist:roni-size" as Slug,
			});

			expect(queue.enqueueHint).toHaveBeenCalledWith(
				expect.objectContaining({ title: "New Forms", artist: "Roni Size", type: "project" }),
			);
			expect(result).toMatchObject({ state: "pending", retry_after_seconds: 5 });
		});

		it("is none/no-context without `from` or with a `from` outside the cache, and does not remember it", async () => {
			await cache.write(
				artistNode({
					slug: "artist:roni-size",
					name: "Roni Size",
					discography: [edge("project", "project:new-forms", "New Forms")],
				}),
			);
			const { imageService } = setup();
			const slug = "project:new-forms" as Slug;

			for (const opts of [undefined, { from: "artist:unknown" as Slug }]) {
				expect(await imageService.resolveDisplayImage(slug, opts)).toEqual({
					slug,
					image_url: null,
					source: "no-context",
					state: "none",
				});
			}
			expect(
				await imageService.resolveDisplayImage(slug, { from: "artist:roni-size" as Slug }),
			).toMatchObject({
				state: "pending",
			});
		});
	});

	describe("warm", () => {
		const artist = () =>
			artistNode({
				slug: "artist:roni-size",
				name: "Roni Size",
				discography: [edge("project", "project:new-forms", "New Forms")],
			});

		it("enqueues the page's own job when it has no image, then its works; once per 10 minutes", () => {
			const { imageService, queue } = setup();

			imageService.warm(artist());
			imageService.warm(artist());
			expect(queue.enqueueNode).toHaveBeenCalledTimes(1);
			expect(queue.enqueueHint).toHaveBeenCalledTimes(1);

			clock += 10 * MIN_MS - 1;
			imageService.warm(artist());
			expect(queue.enqueueHint).toHaveBeenCalledTimes(1);

			clock += 1;
			imageService.warm(artist());
			expect(queue.enqueueNode).toHaveBeenCalledTimes(2);
			expect(queue.enqueueHint).toHaveBeenCalledTimes(2);
		});

		it("clearNegativeCache resets the memo", () => {
			const { imageService, queue } = setup();
			imageService.warm(artist());
			imageService.clearNegativeCache();
			imageService.warm(artist());
			expect(queue.enqueueHint).toHaveBeenCalledTimes(2);
		});

		it("skips its own job when the page has an allowed image, and enqueues it when the host is refused", () => {
			const { imageService, queue } = setup();
			imageService.warm({ ...artist(), image_url: CAA_URL, image_source: "caa" });
			expect(queue.enqueueNode).not.toHaveBeenCalled();

			imageService.warm({
				...artist(),
				slug: "artist:other" as Slug,
				image_url: "https://evil.example.com/x.jpg",
			});
			expect(queue.enqueueNode).toHaveBeenCalledTimes(1);
		});

		it("does not count a page as warmed when the queue was full, so the next open retries", () => {
			const { imageService, queue } = setup();
			queue.enqueueHint.mockReturnValueOnce({ accepted: false, reason: "full" });

			imageService.warm(artist());
			imageService.warm(artist());

			expect(queue.enqueueHint).toHaveBeenCalledTimes(2);
		});

		it("ignores what the queue answers (conflict, unscopable, full)", () => {
			const { imageService, queue } = setup();
			queue.enqueueHint.mockReturnValue({ accepted: false, reason: "conflict" });
			queue.enqueueNode.mockReturnValue({ accepted: false, reason: "full" });
			expect(() => imageService.warm(artist())).not.toThrow();
		});

		it("warmSlug resolves a genre redirect, reads once per 10 minutes, and ignores an unknown slug", async () => {
			await cache.write(
				genreNode({
					slug: "genre:electronic",
					name: "Electronic",
					landmark_projects: [edge("project", "project:x--y", "X", { artist: "Y" })],
				}),
			);
			const { imageService, queue } = setup(new Map([["genre:electronic-music", "genre:electronic"]]));
			const getSpy = vi.spyOn(cache, "get");

			await imageService.warmSlug("genre:electronic-music" as Slug);
			expect(queue.enqueueHint).toHaveBeenCalledTimes(1);
			getSpy.mockClear();
			await imageService.warmSlug("genre:electronic-music" as Slug);
			expect(getSpy).not.toHaveBeenCalled();

			await imageService.warmSlug("artist:nobody" as Slug);
			expect(queue.enqueueNode).toHaveBeenCalledTimes(1);
		});

		it("does not warm a work whose names the scoped-slug flag would flatten while it is off (MØ vs M)", () => {
			const { imageService, queue } = setup();
			const node = artistNode({
				slug: "artist:mo",
				name: "MØ",
				discography: [edge("project", "project:no-mythologies-to-follow--m", "No Mythologies to Follow")],
			});

			imageService.warm(node);
			expect(queue.enqueueNode).toHaveBeenCalledTimes(1);
			expect(queue.enqueueHint).not.toHaveBeenCalled();

			process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = "1";
			imageService.clearNegativeCache();
			imageService.warm(node);
			expect(queue.enqueueHint).toHaveBeenCalledTimes(1);
		});
	});

	describe("workHintsOf", () => {
		const { imageService } = {
			imageService: createImageService({ cache: {} as NodeCache, redirects: new Map() }),
		};

		it("lists an artist's projects before its tracks, with the artist's name, mbid and releaseType", () => {
			const hints = imageService.workHintsOf(
				artistNode({
					slug: "artist:a",
					name: "Aphex Twin",
					discography: [
						edge("project", "project:p1", "P1", { mbid: "mb-1", releaseType: "album" }),
						edge("project", "project:p2", "P2"),
					],
					notable_tracks: [edge("track", "track:t1", "T1", { mbid: "mb-t" })],
				}),
			);

			expect(hints).toEqual([
				{
					slug: "project:p1",
					type: "project",
					title: "P1",
					artist: "Aphex Twin",
					mbid: "mb-1",
					releaseType: "album",
				},
				{ slug: "project:p2", type: "project", title: "P2", artist: "Aphex Twin" },
				{ slug: "track:t1", type: "track", title: "T1", artist: "Aphex Twin", mbid: "mb-t" },
			]);
		});

		it("gives a track of a tracklist its parent project", () => {
			const hints = imageService.workHintsOf(
				projectNode({
					slug: "project:album--someone",
					name: "Album",
					mbid: "mb-album",
					artists: [edge("artist", "artist:someone", "Someone")],
					tracklist: [edge("track", "track:song--someone", "Song")],
				}),
			);

			expect(hints).toEqual([
				{
					slug: "track:song--someone",
					type: "track",
					title: "Song",
					artist: "Someone",
					parentProject: { title: "Album", artist: "Someone", mbid: "mb-album" },
				},
			]);
		});

		it("takes a track's project, with the edge's artist over the track's first artist", () => {
			const base = {
				slug: "track:song" as Slug,
				name: "Song",
				editorial_teaser: "t",
				editorial_article: "x".repeat(200),
				citations: [{ url: "https://example.com" }],
				materialized_at: new Date().toISOString(),
				genres: [],
				artists: [edge("artist", "artist:first", "First")],
			};
			const track = (project: EdgeRef): NodePayload =>
				({ ...base, type: "track", project }) as unknown as NodePayload;

			expect(imageService.workHintsOf(track(edge("project", "project:p", "P")))).toMatchObject([
				{ type: "project", title: "P", artist: "First" },
			]);
			expect(
				imageService.workHintsOf(track(edge("project", "project:p", "P", { artist: "Edge" }))),
			).toMatchObject([{ artist: "Edge" }]);
		});

		it("drops a genre edge without artist, an edge of another type, and a nameless edge", () => {
			expect(
				imageService.workHintsOf(
					genreNode({
						slug: "genre:house",
						name: "House",
						landmark_projects: [
							edge("project", "project:no-artist", "No Artist"),
							edge("project", "project:ok--dj", "Ok", { artist: "DJ" }),
							edge("artist", "artist:dj", "DJ", { artist: "DJ" }),
						],
						landmark_tracks: [edge("track", "track:nameless", "", { artist: "DJ" })],
					}),
				),
			).toEqual([{ slug: "project:ok--dj", type: "project", title: "Ok", artist: "DJ" }]);
			expect(
				imageService.workHintsOf(
					artistNode({
						slug: "artist:a",
						name: "A",
						discography: [edge("artist", "artist:b", "B")],
					}),
				),
			).toEqual([]);
		});

		it("reads a label's notable releases with the edge's artist only", () => {
			expect(
				imageService.workHintsOf(
					labelNode({
						slug: "label:l",
						name: "L",
						notable_releases: [
							edge("project", "project:r1--x", "R1", { artist: "X" }),
							edge("project", "project:r2", "R2"),
						],
					}),
				),
			).toEqual([{ slug: "project:r1--x", type: "project", title: "R1", artist: "X" }]);
		});
	});

	describe("the kill switch", () => {
		it.each(["0", "false"])(
			"ODYSSEY_ON_DEMAND_IMAGES=%s: no sidecar read, no queue call, same answers as without onDemand",
			async (raw) => {
				process.env.ODYSSEY_ON_DEMAND_IMAGES = raw;
				await cache.write(projectNode({ slug: "project:bare", name: "Bare" }));
				await cache.write(
					artistNode({ slug: "artist:a", name: "A", discography: [edge("project", "project:d--a", "D")] }),
				);
				await putSidecar("project:ghost--someone" as Slug, "found");
				await putSidecar("project:bare" as Slug, "found");
				const { imageService, queue } = setup();
				const plain = createImageService({ cache, redirects: new Map(), now: () => clock });

				for (const slug of [
					"project:bare",
					"project:ghost--someone",
					"project:ghost",
					"artist:a",
				] as Slug[]) {
					expect(await imageService.resolveDisplayImage(slug, { from: "artist:a" as Slug })).toEqual(
						await plain.resolveDisplayImage(slug),
					);
				}
				imageService.warm(
					artistNode({ slug: "artist:b", name: "B", discography: [edge("project", "project:e--b", "E")] }),
				);
				await imageService.warmSlug("artist:a" as Slug);

				expect(queue.enqueueNode).not.toHaveBeenCalled();
				expect(queue.enqueueHint).not.toHaveBeenCalled();
				expect(queue.stateOf).not.toHaveBeenCalled();
				expect(queue.aliasOf).not.toHaveBeenCalled();
			},
		);

		it("a miss remembered while it was off does not hide the pending answer once it is on", async () => {
			await cache.write(projectNode({ slug: "project:bare", name: "Bare" }));
			const { imageService, queue } = setup();
			process.env.ODYSSEY_ON_DEMAND_IMAGES = "0";
			expect(await imageService.resolveDisplayImage("project:bare" as Slug)).toMatchObject({
				source: "no-match",
			});

			delete process.env.ODYSSEY_ON_DEMAND_IMAGES;
			expect(await imageService.resolveDisplayImage("project:bare" as Slug)).toMatchObject({
				state: "pending",
			});
			expect(queue.enqueueNode).toHaveBeenCalledTimes(1);
		});

		it("is read at each call: switching it off takes effect without a new service", async () => {
			await putSidecar("project:ghost--someone" as Slug, "found");
			const { imageService } = setup();
			expect(await imageService.resolveDisplayImage("project:ghost--someone" as Slug)).toMatchObject({
				state: "found",
			});

			process.env.ODYSSEY_ON_DEMAND_IMAGES = "0";
			expect(await imageService.resolveDisplayImage("project:ghost--someone" as Slug)).toMatchObject({
				state: "none",
				source: "not-cached",
			});
		});
	});

	it("never fetches and never writes a node, on any path", async () => {
		await cache.write(projectNode({ slug: "project:bare", name: "Bare" }));
		await cache.write(
			artistNode({ slug: "artist:a", name: "A", discography: [edge("project", "project:d--a", "D")] }),
		);
		const writeSpy = vi.spyOn(cache, "write");
		const updateSpy = vi.spyOn(cache, "update");
		const { imageService } = setup();

		await imageService.resolveDisplayImage("project:bare" as Slug);
		await imageService.resolveDisplayImage("project:d" as Slug, { from: "artist:a" as Slug });
		await imageService.resolveDisplayImage("project:ghost--x" as Slug);
		await imageService.warmSlug("artist:a" as Slug);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(writeSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
	});
});
