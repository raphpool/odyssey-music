import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ArtistNode, GenreNode, NodePayload, TrackNode } from "../src/types.js";

let dir: string;
let cache: NodeCache;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-cache-"));
	cache = new NodeCache(dir);
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function trackA(): TrackNode {
	return {
		type: "track",
		slug: "track:windowlicker",
		name: "Windowlicker",
		editorial_teaser: "A 1999 Aphex Twin single.",
		editorial_article: "A real long article about Windowlicker the Aphex Twin single. ".repeat(6),
		citations: [{ url: "https://example.com/windowlicker", title: "Windowlicker" }],
		materialized_at: new Date().toISOString(),
		artists: [{ type: "artist", slug: "artist:aphex-twin", name: "Aphex Twin" }],
		genres: [],
		producers: [],
		personnel: [],
		samples: [{ type: "track", slug: "track:funky-drummer", name: "Funky Drummer" }],
		sampled_by: [],
		remixed_by: [],
	};
}

function trackB(): TrackNode {
	return {
		type: "track",
		slug: "track:funky-drummer",
		name: "Funky Drummer",
		editorial_teaser: "James Brown's most-sampled break.",
		editorial_article: "A real long article about James Brown's Funky Drummer break. ".repeat(6),
		citations: [{ url: "https://example.com/funky-drummer", title: "Funky Drummer" }],
		materialized_at: new Date().toISOString(),
		artists: [{ type: "artist", slug: "artist:james-brown", name: "James Brown" }],
		genres: [],
		producers: [],
		personnel: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
	};
}

function artistA(): ArtistNode {
	return {
		type: "artist",
		slug: "artist:brian-eno",
		name: "Brian Eno",
		editorial_bio: "British producer and ambient pioneer.",
		editorial_article: "A real long article about Brian Eno's ambient legacy. ".repeat(6),
		citations: [{ url: "https://example.com/brian-eno", title: "Brian Eno" }],
		materialized_at: new Date().toISOString(),
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [{ type: "artist", slug: "artist:aphex-twin", name: "Aphex Twin" }],
		collaborators: [],
		aliases: [],
		members: [],
	};
}

// Shared minimal-genre-node fixture (TRA-18); callers override only what varies per test.
function genreNode(overrides: Partial<GenreNode> & Pick<GenreNode, "slug" | "name">): GenreNode {
	return {
		type: "genre",
		editorial_definition: `Test fixture definition for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for reverse-edge coverage. `.repeat(4),
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

describe("NodeCache", () => {
	it("writes a node and reads it back", async () => {
		await cache.write(trackB());
		const back = await cache.get("track:funky-drummer");
		expect(back?.name).toBe("Funky Drummer");
	});

	it("materializes the reverse edge on an already-cached target", async () => {
		// trackB already exists. Now write trackA which samples B.
		await cache.write(trackA());
		const b = (await cache.get("track:funky-drummer")) as TrackNode | null;
		expect(b).not.toBeNull();
		expect(b?.sampled_by.some((e) => e.slug === "track:windowlicker")).toBe(true);
	});

	it("queues reverse edges for not-yet-cached targets and merges them on later write", async () => {
		await cache.write(artistA());
		const eno = (await cache.get("artist:brian-eno")) as ArtistNode | null;
		expect(eno).not.toBeNull();
		// Aphex Twin doesn't exist yet. The pending should fire when we write him.
		const aphex: ArtistNode = {
			type: "artist",
			slug: "artist:aphex-twin",
			name: "Aphex Twin",
			editorial_bio: "Cornish electronic musician.",
			editorial_article: "A real long article about Aphex Twin and his cultural significance. ".repeat(6),
			citations: [{ url: "https://example.com/aphex-twin", title: "Aphex Twin" }],
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
		await cache.write(aphex);
		const aphexBack = (await cache.get("artist:aphex-twin")) as ArtistNode | null;
		expect(aphexBack?.influences.some((e) => e.slug === "artist:brian-eno")).toBe(true);
	});

	it("does not double-add a reverse edge if it already exists", async () => {
		const t = trackA();
		// Re-writing: should merge cleanly (cache.write does parse+write; duplicate sampled_by should not grow).
		await cache.write(t);
		const b = (await cache.get("track:funky-drummer")) as TrackNode | null;
		const matches = (b?.sampled_by ?? []).filter((e) => e.slug === "track:windowlicker");
		expect(matches.length).toBe(1);
	});

	it("lists all materialized slugs", async () => {
		const slugs = await cache.listSlugs();
		expect(slugs.length).toBeGreaterThanOrEqual(3);
		expect(slugs).toContain("track:windowlicker" as NodePayload["slug"]);
	});
});

describe("NodeCache — findGenreSlugByQid (TRA-24)", () => {
	it("resolves a slug by qid, ignores nodes without a qid, and returns undefined for unknown/empty qids", async () => {
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		try {
			await qidCache.write(genreNode({ slug: "genre:a", name: "A", qid: "Q1" }));
			await qidCache.write(genreNode({ slug: "genre:b", name: "B" }));

			expect(await qidCache.findGenreSlugByQid("Q1")).toBe("genre:a");
			expect(await qidCache.findGenreSlugByQid("Q2")).toBeUndefined();
			expect(await qidCache.findGenreSlugByQid("")).toBeUndefined();
		} finally {
			await rm(qidDir, { recursive: true, force: true });
		}
	});

	it("invalidates the memo on a genre write so a later lookup sees the new node", async () => {
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		try {
			await qidCache.write(genreNode({ slug: "genre:a", name: "A", qid: "Q1" }));
			// Prime the memo before the node we're looking for even exists.
			expect(await qidCache.findGenreSlugByQid("Q2")).toBeUndefined();

			await qidCache.write(genreNode({ slug: "genre:c", name: "C", qid: "Q2" }));
			expect(await qidCache.findGenreSlugByQid("Q2")).toBe("genre:c");
		} finally {
			await rm(qidDir, { recursive: true, force: true });
		}
	});

	it("resolves a qid collision deterministically: shortest slug, then lexicographic, order-independent", async () => {
		const qidDir1 = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const cache1 = new NodeCache(qidDir1);
		const qidDir2 = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const cache2 = new NodeCache(qidDir2);
		try {
			await cache1.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
			await cache1.write(
				genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q9778" }),
			);
			expect(await cache1.findGenreSlugByQid("Q9778")).toBe("genre:electronic");

			// Reversed creation order must resolve to the same winner.
			await cache2.write(
				genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q9778" }),
			);
			await cache2.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" }));
			expect(await cache2.findGenreSlugByQid("Q9778")).toBe("genre:electronic");
		} finally {
			await rm(qidDir1, { recursive: true, force: true });
			await rm(qidDir2, { recursive: true, force: true });
		}
	});

	it("retries the build on a later call after a corrupt cache file failed the first one", async () => {
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		try {
			await qidCache.write(genreNode({ slug: "genre:good", name: "Good", qid: "Q1" }));
			// Sneak in a genre file that fails schema validation without going through write().
			const genreDir = join(qidDir, "nodes", "genre");
			await mkdir(genreDir, { recursive: true });
			await writeFile(join(genreDir, "broken.json"), JSON.stringify({ type: "genre" }), "utf8");

			await expect(qidCache.findGenreSlugByQid("Q1")).rejects.toThrow();

			// Fix the corrupt file, then the memo must retry rather than stay poisoned.
			await rm(join(genreDir, "broken.json"));
			expect(await qidCache.findGenreSlugByQid("Q1")).toBe("genre:good");
		} finally {
			await rm(qidDir, { recursive: true, force: true });
		}
	});

	it("resolves concurrent lookups racing the first build to the same result without error", async () => {
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		try {
			await qidCache.write(genreNode({ slug: "genre:concurrent", name: "Concurrent", qid: "Q42" }));
			const [a, b] = await Promise.all([
				qidCache.findGenreSlugByQid("Q42"),
				qidCache.findGenreSlugByQid("Q42"),
			]);
			expect(a).toBe("genre:concurrent");
			expect(b).toBe("genre:concurrent");
		} finally {
			await rm(qidDir, { recursive: true, force: true });
		}
	});
});

describe("NodeCache — genre qid propagation on reverse edges (TRA-18)", () => {
	it("stamps the source genre's qid onto the reverse edge it emits on the target", async () => {
		await cache.write(genreNode({ slug: "genre:acid", name: "Acid" }));
		await cache.write(
			genreNode({
				slug: "genre:acid-techno",
				name: "Acid Techno",
				qid: "Q341395",
				parent_genres: [{ type: "genre", slug: "genre:acid", name: "Acid" }],
			}),
		);
		const acid = (await cache.get("genre:acid")) as GenreNode;
		const reverse = acid.subgenres.find((e) => e.slug === "genre:acid-techno");
		expect(reverse?.qid).toBe("Q341395");
	});

	it("omits the qid key on the reverse edge when the source genre has none", async () => {
		await cache.write(
			genreNode({
				slug: "genre:dub-techno",
				name: "Dub Techno",
				parent_genres: [{ type: "genre", slug: "genre:acid", name: "Acid" }],
			}),
		);
		const acid = (await cache.get("genre:acid")) as GenreNode;
		const reverse = acid.subgenres.find((e) => e.slug === "genre:dub-techno");
		expect(reverse).toBeDefined();
		expect(reverse && "qid" in reverse).toBe(false);
	});
});
