import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
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
		similar_artists: [],
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
			similar_artists: [],
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

describe("NodeCache — transactional replacement (TRA-215)", () => {
	it("counts a successful replacement as one write", async () => {
		const replacementDir = await mkdtemp(join(tmpdir(), "odyssey-cache-replace-"));
		const replacementCache = new NodeCache(replacementDir);
		try {
			await replacementCache.write(genreNode({ slug: "genre:acid", name: "Acid", qid: "Q1" }));
			const before = replacementCache.stats.written;

			await replacementCache.replace(
				genreNode({
					slug: "genre:acid",
					name: "Acid",
					qid: "Q1",
					editorial_definition: "Replacement definition.",
				}),
			);

			expect(replacementCache.stats.written).toBe(before + 1);
			expect(await replacementCache.get("genre:acid")).toMatchObject({
				editorial_definition: "Replacement definition.",
			});
		} finally {
			await rm(replacementDir, { recursive: true, force: true });
		}
	});

	it("keeps the source readable and serializes a later same-slug write", async () => {
		const replacementDir = await mkdtemp(join(tmpdir(), "odyssey-cache-replace-"));
		const replacementCache = new NodeCache(replacementDir);
		const cacheInternals = replacementCache as unknown as {
			emitReverses: (source: NodePayload, delta: { written: number; revUpdates: number }) => Promise<void>;
		};
		const originalEmitReverses = cacheInternals.emitReverses;
		let resumeReplacement: (() => void) | undefined;
		const replacementPaused = new Promise<void>((resolve) => {
			resumeReplacement = resolve;
		});
		let replacementVisible: (() => void) | undefined;
		const replacementStarted = new Promise<void>((resolve) => {
			replacementVisible = resolve;
		});
		try {
			await replacementCache.write(genreNode({ slug: "genre:acid", name: "Acid", qid: "Q1" }));
			const emitSpy = vi
				.spyOn(cacheInternals, "emitReverses")
				.mockImplementationOnce(async (source, delta) => {
					replacementVisible?.();
					await replacementPaused;
					await originalEmitReverses.call(replacementCache, source, delta);
				});
			const replacing = replacementCache.replace(
				genreNode({
					slug: "genre:acid",
					name: "Acid",
					qid: "Q1",
					editorial_definition: "Replacement visible while its effects are pending.",
				}),
			);
			await replacementStarted;
			const laterWrite = replacementCache.write(
				genreNode({
					slug: "genre:acid",
					name: "Acid",
					qid: "Q1",
					editorial_definition: "Later write after replacement.",
				}),
			);

			const visible = await replacementCache.get("genre:acid");
			if (visible.type !== "genre") throw new Error("expected a visible genre source");
			expect(visible.editorial_definition).toBe("Replacement visible while its effects are pending.");

			resumeReplacement?.();
			await replacing;
			await laterWrite;
			const final = await replacementCache.get("genre:acid");
			if (final.type !== "genre") throw new Error("expected final genre source");
			expect(final.editorial_definition).toBe("Later write after replacement.");
			emitSpy.mockRestore();
		} finally {
			await rm(replacementDir, { recursive: true, force: true });
		}
	});

	it("restores the source and counters after a late reverse-edge failure", async () => {
		const replacementDir = await mkdtemp(join(tmpdir(), "odyssey-cache-replace-"));
		const replacementCache = new NodeCache(replacementDir);
		try {
			const original = genreNode({
				slug: "genre:acid",
				name: "Acid",
				qid: "Q1",
				editorial_definition: "The source that must survive a failed replacement.",
			});
			await replacementCache.write(original);
			const before = { ...replacementCache.stats };
			const genreDir = join(replacementDir, "nodes", "genre");
			await mkdir(genreDir, { recursive: true });
			await writeFile(join(genreDir, "invalid-target.json"), JSON.stringify({ type: "genre" }), "utf8");

			await expect(
				replacementCache.replace(
					genreNode({
						slug: "genre:acid",
						name: "Acid",
						qid: "Q1",
						editorial_definition: "Replacement that must be rolled back.",
						parent_genres: [{ type: "genre", slug: "genre:invalid-target", name: "Invalid target" }],
					}),
				),
			).rejects.toThrow();

			expect(await replacementCache.get("genre:acid")).toEqual(original);
			expect(replacementCache.stats).toEqual(before);
		} finally {
			await rm(replacementDir, { recursive: true, force: true });
		}
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

	it("ignores an invalid genre node while building the index, logs a warning, and still resolves the rest", async () => {
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await qidCache.write(genreNode({ slug: "genre:good", name: "Good", qid: "Q1" }));
			// Sneak in a genre file that fails schema validation without going through write().
			const genreDir = join(qidDir, "nodes", "genre");
			await mkdir(genreDir, { recursive: true });
			await writeFile(join(genreDir, "broken.json"), JSON.stringify({ type: "genre" }), "utf8");

			// The corrupt file must not fail the whole build: Q1 still resolves.
			expect(await qidCache.findGenreSlugByQid("Q1")).toBe("genre:good");
			// ...and the skip is logged, naming the offending slug.
			const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(logged).toContain("genre:broken");
		} finally {
			warnSpy.mockRestore();
			await rm(qidDir, { recursive: true, force: true });
		}
	});

	it("resolves concurrent lookups racing the first build to the same result without error, sharing one build", async () => {
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		try {
			await qidCache.write(genreNode({ slug: "genre:concurrent", name: "Concurrent", qid: "Q42" }));
			const buildSpy = vi.spyOn(
				qidCache as unknown as { buildGenreQidIndex: () => Promise<Map<string, Slug>> },
				"buildGenreQidIndex",
			);
			const [a, b] = await Promise.all([
				qidCache.findGenreSlugByQid("Q42"),
				qidCache.findGenreSlugByQid("Q42"),
			]);
			expect(a).toBe("genre:concurrent");
			expect(b).toBe("genre:concurrent");
			expect(buildSpy).toHaveBeenCalledTimes(1);
			buildSpy.mockRestore();
		} finally {
			await rm(qidDir, { recursive: true, force: true });
		}
	});

	it("does not memoize a stale index once a genre write it raced has fully landed, whichever call starts first (regression)", async () => {
		const qidDir1 = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const cache1 = new NodeCache(qidDir1);
		const qidDir2 = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const cache2 = new NodeCache(qidDir2);
		try {
			// The write starts first; the lookup (and the build it triggers) races it.
			await cache1.write(genreNode({ slug: "genre:a", name: "A", qid: "Q1" }));
			const w1 = cache1.write(genreNode({ slug: "genre:c", name: "C", qid: "Q2" })); // not awaited
			await cache1.findGenreSlugByQid("Q2"); // undefined here is fine: genuinely concurrent
			await w1; // the write has now fully landed on disk
			expect(await cache1.has("genre:c")).toBe(true);
			expect(await cache1.findGenreSlugByQid("Q2")).toBe("genre:c");

			// Same interleaving, but the lookup (and its build) starts first this time.
			await cache2.write(genreNode({ slug: "genre:a", name: "A", qid: "Q1" }));
			const lookup2 = cache2.findGenreSlugByQid("Q2"); // not awaited
			const w2 = cache2.write(genreNode({ slug: "genre:c", name: "C", qid: "Q2" })); // not awaited
			await lookup2; // undefined here is fine: genuinely concurrent
			await w2; // the write has now fully landed on disk
			expect(await cache2.has("genre:c")).toBe(true);
			expect(await cache2.findGenreSlugByQid("Q2")).toBe("genre:c");
		} finally {
			await rm(qidDir1, { recursive: true, force: true });
			await rm(qidDir2, { recursive: true, force: true });
		}
	});

	it("still runs the second invalidation when write() throws after the source node landed (regression, review round 2)", async () => {
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		try {
			await qidCache.write(genreNode({ slug: "genre:a", name: "A", qid: "Q1" }));
			// A genre file that exists on disk but fails schema validation: in production this
			// is exactly what happens when emitReverses tries to materialize a reverse edge onto
			// a corrupt target and get() throws ValidationError (not NotFoundError) in
			// applyReverseToTarget, so write() fails AFTER the source node has already landed.
			const genreDir = join(qidDir, "nodes", "genre");
			await mkdir(genreDir, { recursive: true });
			await writeFile(join(genreDir, "target.json"), JSON.stringify({ type: "genre" }), "utf8");

			// Pin the interleaving explicitly instead of racing real fs timing: freeze the
			// directory listing a build would see to the pre-write state (no genre:c yet), so
			// the lookup below is guaranteed to build and memoize a stale (Q2-less) index —
			// deterministically simulating a build that started in the window before genre:c
			// landed, regardless of how fast the write below actually completes on disk.
			const staleListing = await qidCache.listSlugs();
			const listSlugsSpy = vi.spyOn(qidCache, "listSlugs").mockImplementation(async () => staleListing);

			const w = qidCache.write(
				genreNode({
					slug: "genre:c",
					name: "C",
					qid: "Q2",
					parent_genres: [{ type: "genre", slug: "genre:target", name: "Target" }],
				}),
			); // not awaited: its entry invalidation has already run synchronously by this point

			expect(await qidCache.findGenreSlugByQid("Q2")).toBeUndefined(); // built off the stale listing, now memoized
			listSlugsSpy.mockRestore();

			await expect(w).rejects.toThrow(); // genre:c is on disk, but emitReverses fails on the corrupt target
			expect(await qidCache.has("genre:c")).toBe(true);

			// The second invalidation (in write()'s finally) must have busted the stale memo
			// above even though write() threw, so this rebuilds from the real, current disk.
			expect(await qidCache.findGenreSlugByQid("Q2")).toBe("genre:c");
		} finally {
			await rm(qidDir, { recursive: true, force: true });
		}
	});

	it("retries instead of returning a build its own call raced a write into (regression, TRA-28 review B4)", async () => {
		// The commit guard (write()'s two invalidations vs. genreQidIndexVersion) protects the
		// MEMO from a stale write, but getOrBuildGenreQidIndex used to still hand the vetoed
		// snapshot straight back to whichever caller's own lookup had started that build --
		// e.g. one crawler worker's findGenreSlugByQid triggers a build, another worker's write
		// lands mid-build and bumps the version; the commit is correctly vetoed so the memo
		// stays clean, but the FIRST worker's own call still resolved with the pre-write
		// snapshot, missing the new node, sending the genre registry down rule 5 (mint) for a
		// target that had in fact just landed.
		const qidDir = await mkdtemp(join(tmpdir(), "odyssey-cache-qid-"));
		const qidCache = new NodeCache(qidDir);
		try {
			await qidCache.write(genreNode({ slug: "genre:a", name: "A", qid: "Q1" }));
			await qidCache.write(genreNode({ slug: "genre:c", name: "C", qid: "Q2" }));

			// The FIRST listSlugs() call (the one build this test's lookup triggers) simulates a
			// concurrent write landing while the build is in flight -- bumping the version itself,
			// deterministically, right after this build's startedAtVersion snapshot was already
			// taken -- then returns a listing frozen to before that write ("genre:c" missing.)
			// The real listSlugs() (used by any retry) sees both nodes, already on disk above.
			const staleListing: Slug[] = ["genre:a"];
			const listSlugsSpy = vi.spyOn(qidCache, "listSlugs").mockImplementationOnce(async () => {
				(qidCache as unknown as { genreQidIndexVersion: number }).genreQidIndexVersion++;
				return staleListing;
			});

			// Without the fix: resolves with the vetoed, Q2-less snapshot (undefined). With the
			// fix: retries once the veto is detected and returns the correct, current answer.
			expect(await qidCache.findGenreSlugByQid("Q2")).toBe("genre:c");
			listSlugsSpy.mockRestore();
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

describe("NodeCache — cross-type reverse edges (TRA-454)", () => {
	let crossDir: string;
	let crossCache: NodeCache;

	beforeEach(async () => {
		crossDir = await mkdtemp(join(tmpdir(), "odyssey-cache-cross-"));
		crossCache = new NodeCache(crossDir);
	});
	afterEach(async () => {
		await rm(crossDir, { recursive: true, force: true });
	});

	const ref = (slug: Slug, name: string): EdgeRef => ({
		type: slug.split(":")[0] as EdgeRef["type"],
		slug,
		name,
	});
	const bodyOf = (slug: string) => slug.split(":")[1] ?? "x";
	const article = (name: string) =>
		`A real long article about ${name} for cross-type reverse coverage. `.repeat(4);

	function artist(overrides: Partial<ArtistNode> & Pick<ArtistNode, "slug" | "name">): ArtistNode {
		return {
			type: "artist",
			editorial_bio: `Fixture bio for ${overrides.name}.`,
			editorial_article: article(overrides.name),
			citations: [{ url: `https://example.com/${bodyOf(overrides.slug)}` }],
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

	function label(overrides: Partial<LabelNode> & Pick<LabelNode, "slug" | "name">): LabelNode {
		return {
			type: "label",
			editorial_description: `Fixture description for ${overrides.name}.`,
			editorial_article: article(overrides.name),
			citations: [{ url: `https://example.com/${bodyOf(overrides.slug)}` }],
			materialized_at: new Date().toISOString(),
			genres: [],
			roster: [],
			notable_releases: [],
			...overrides,
		};
	}

	function project(overrides: Partial<ProjectNode> & Pick<ProjectNode, "slug" | "name">): ProjectNode {
		return {
			type: "project",
			editorial_pitch: `Fixture pitch for ${overrides.name}.`,
			editorial_article: article(overrides.name),
			citations: [{ url: `https://example.com/${bodyOf(overrides.slug)}` }],
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

	function track(overrides: Partial<TrackNode> & Pick<TrackNode, "slug" | "name">): TrackNode {
		return {
			type: "track",
			editorial_teaser: `Fixture teaser for ${overrides.name}.`,
			editorial_article: article(overrides.name),
			citations: [{ url: `https://example.com/${bodyOf(overrides.slug)}` }],
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

	async function readPending(): Promise<Record<string, unknown[]>> {
		const raw = await readFile(join(crossDir, "pending-reverses.json"), "utf8");
		return JSON.parse(raw) as Record<string, unknown[]>;
	}

	const slugsOf = (edges: EdgeRef[]) => edges.map((e) => e.slug);
	const warpRef = ref("label:warp", "Warp");
	const aphexRef = ref("artist:aphex-twin", "Aphex Twin");

	it("adds the artist to label.roster when the label is cached", async () => {
		await crossCache.write(label({ slug: "label:warp", name: "Warp" }));
		await crossCache.write(artist({ slug: "artist:aphex-twin", name: "Aphex Twin", labels: [warpRef] }));

		const warp = (await crossCache.get("label:warp")) as LabelNode;
		expect(slugsOf(warp.roster)).toEqual(["artist:aphex-twin"]);
	});

	it("queues the reverse in pending-reverses.json when the label is absent, then applies it on write", async () => {
		await crossCache.write(artist({ slug: "artist:aphex-twin", name: "Aphex Twin", labels: [warpRef] }));

		const pending = await readPending();
		expect(pending["label:warp"]).toEqual([{ field: "roster", cardinality: "list", edge: aphexRef }]);

		await crossCache.write(label({ slug: "label:warp", name: "Warp" }));
		const warp = (await crossCache.get("label:warp")) as LabelNode;
		expect(slugsOf(warp.roster)).toEqual(["artist:aphex-twin"]);
	});

	it("reflects label.roster into artist.labels", async () => {
		await crossCache.write(artist({ slug: "artist:aphex-twin", name: "Aphex Twin" }));
		await crossCache.write(label({ slug: "label:warp", name: "Warp", roster: [aphexRef] }));

		const aphex = (await crossCache.get("artist:aphex-twin")) as ArtistNode;
		expect(slugsOf(aphex.labels)).toEqual(["label:warp"]);
	});

	it("sets track.project from project.tracklist when the track has none", async () => {
		await crossCache.write(track({ slug: "track:x", name: "X" }));
		await crossCache.write(
			project({ slug: "project:album", name: "Album", tracklist: [ref("track:x", "X")] }),
		);

		const x = (await crossCache.get("track:x")) as TrackNode;
		expect(x.project?.slug).toBe("project:album");
	});

	it("keeps track.project untouched when it is already set", async () => {
		await crossCache.write(track({ slug: "track:x", name: "X", project: ref("project:first", "First") }));
		await crossCache.write(
			project({ slug: "project:album", name: "Album", tracklist: [ref("track:x", "X")] }),
		);

		const x = (await crossCache.get("track:x")) as TrackNode;
		expect(x.project?.slug).toBe("project:first");
	});

	it("appends the track to project.tracklist from track.project", async () => {
		await crossCache.write(project({ slug: "project:album", name: "Album" }));
		await crossCache.write(track({ slug: "track:x", name: "X", project: ref("project:album", "Album") }));

		const album = (await crossCache.get("project:album")) as ProjectNode;
		expect(slugsOf(album.tracklist)).toEqual(["track:x"]);
	});

	it("covers the remaining pairs between artist, label, project and track", async () => {
		await crossCache.write(artist({ slug: "artist:aphex-twin", name: "Aphex Twin" }));
		await crossCache.write(project({ slug: "project:album", name: "Album" }));
		await crossCache.write(track({ slug: "track:x", name: "X" }));
		await crossCache.write(label({ slug: "label:warp", name: "Warp" }));

		// artist.discography -> project.artists, artist.notable_tracks -> track.artists
		await crossCache.write(
			artist({
				slug: "artist:aphex-twin",
				name: "Aphex Twin",
				discography: [ref("project:album", "Album")],
				notable_tracks: [ref("track:x", "X")],
			}),
		);
		// label.notable_releases -> project.label (single)
		await crossCache.write(
			label({ slug: "label:warp", name: "Warp", notable_releases: [ref("project:album", "Album")] }),
		);

		const album = (await crossCache.get("project:album")) as ProjectNode;
		expect(slugsOf(album.artists)).toEqual(["artist:aphex-twin"]);
		expect(album.label?.slug).toBe("label:warp");
		expect(slugsOf(((await crossCache.get("track:x")) as TrackNode).artists)).toEqual(["artist:aphex-twin"]);

		// project.artists -> artist.discography, project.label -> label.notable_releases (list)
		await crossCache.write(
			project({ slug: "project:other", name: "Other", artists: [aphexRef], label: warpRef }),
		);
		const aphex = (await crossCache.get("artist:aphex-twin")) as ArtistNode;
		expect(slugsOf(aphex.discography)).toEqual(["project:album", "project:other"]);
		const warp = (await crossCache.get("label:warp")) as LabelNode;
		expect(slugsOf(warp.notable_releases)).toEqual(["project:album", "project:other"]);

		// track.artists -> artist.notable_tracks
		await crossCache.write(track({ slug: "track:y", name: "Y", artists: [aphexRef] }));
		const aphexAfter = (await crossCache.get("artist:aphex-twin")) as ArtistNode;
		expect(slugsOf(aphexAfter.notable_tracks)).toEqual(["track:x", "track:y"]);
	});

	it("stamps the genre qid onto artist.genres when genre.key_artists points at a cached artist", async () => {
		await crossCache.write(artist({ slug: "artist:a", name: "A" }));
		await crossCache.write(
			genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170", key_artists: [ref("artist:a", "A")] }),
		);

		const a = (await crossCache.get("artist:a")) as ArtistNode;
		expect(a.genres).toEqual([{ type: "genre", slug: "genre:techno", name: "Techno", qid: "Q170" }]);
	});

	it("mirrors genre.key_labels, landmark_projects and landmark_tracks into their genres field", async () => {
		await crossCache.write(label({ slug: "label:warp", name: "Warp" }));
		await crossCache.write(project({ slug: "project:album", name: "Album" }));
		await crossCache.write(track({ slug: "track:x", name: "X" }));
		await crossCache.write(
			genreNode({
				slug: "genre:idm",
				name: "IDM",
				key_labels: [warpRef],
				landmark_projects: [ref("project:album", "Album")],
				landmark_tracks: [ref("track:x", "X")],
			}),
		);

		expect(slugsOf(((await crossCache.get("label:warp")) as LabelNode).genres)).toEqual(["genre:idm"]);
		expect(slugsOf(((await crossCache.get("project:album")) as ProjectNode).genres)).toEqual(["genre:idm"]);
		expect(slugsOf(((await crossCache.get("track:x")) as TrackNode).genres)).toEqual(["genre:idm"]);
	});

	it("does not add anything to genre.key_artists when an artist lists the genre", async () => {
		await crossCache.write(genreNode({ slug: "genre:techno", name: "Techno" }));
		await crossCache.write(
			artist({
				slug: "artist:a",
				name: "A",
				genres: [{ type: "genre", slug: "genre:techno", name: "Techno" }],
			}),
		);

		const techno = (await crossCache.get("genre:techno")) as GenreNode;
		expect(techno.key_artists).toEqual([]);
		await expect(readPending()).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("emits cross-type reverses on replace() as well", async () => {
		await crossCache.write(label({ slug: "label:warp", name: "Warp" }));
		await crossCache.write(artist({ slug: "artist:aphex-twin", name: "Aphex Twin" }));

		await crossCache.replace(artist({ slug: "artist:aphex-twin", name: "Aphex Twin", labels: [warpRef] }));

		const warp = (await crossCache.get("label:warp")) as LabelNode;
		expect(slugsOf(warp.roster)).toEqual(["artist:aphex-twin"]);
	});
});

describe("NodeCache.update — locked read-modify-write (TRA-535)", () => {
	let updDir: string;
	let updCache: NodeCache;

	beforeEach(async () => {
		updDir = await mkdtemp(join(tmpdir(), "odyssey-cache-update-"));
		updCache = new NodeCache(updDir);
	});
	afterEach(async () => {
		await rm(updDir, { recursive: true, force: true });
	});

	const ref = (slug: Slug, name: string): EdgeRef => ({
		type: slug.split(":")[0] as EdgeRef["type"],
		slug,
		name,
	});
	const article = (name: string) => `A real long article about ${name} for update coverage. `.repeat(4);
	const APHEX = "artist:aphex-twin" as Slug;
	const WARP = "label:warp" as Slug;
	const warpRef = ref(WARP, "Warp");

	function artist(overrides: Partial<ArtistNode> = {}): ArtistNode {
		return {
			type: "artist",
			slug: APHEX,
			name: "Aphex Twin",
			editorial_bio: "Fixture bio for Aphex Twin.",
			editorial_article: article("Aphex Twin"),
			citations: [{ url: "https://example.com/aphex-twin" }],
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

	function warp(overrides: Partial<LabelNode> = {}): LabelNode {
		return {
			type: "label",
			slug: WARP,
			name: "Warp",
			editorial_description: "Fixture description for Warp.",
			editorial_article: article("Warp"),
			citations: [{ url: "https://example.com/warp" }],
			materialized_at: new Date().toISOString(),
			genres: [],
			roster: [],
			notable_releases: [],
			...overrides,
		};
	}

	/** A promise whose resolution the test controls (no timers: ordering is driven by the test). */
	function deferred() {
		let release: () => void = () => undefined;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { promise, release };
	}

	const withCollaborator = (node: NodePayload, edge: EdgeRef): NodePayload => {
		const a = node as ArtistNode;
		return { ...a, collaborators: [...a.collaborators, edge] };
	};
	const slugsOf = (edges: EdgeRef[]) => edges.map((e) => e.slug);

	it("keeps both modifications of two concurrent updates of the same node", async () => {
		await updCache.write(artist());
		const entered = deferred();
		const gate = deferred();

		// The first update holds the node, blocked in `fn`, before it has written anything.
		const first = updCache.update(APHEX, async (node) => {
			entered.release();
			await gate.promise;
			return withCollaborator(node, ref("artist:richard-d-james", "Richard D. James"));
		});
		await entered.promise;
		const second = updCache.update(APHEX, (node) =>
			withCollaborator(node, ref("artist:squarepusher", "Squarepusher")),
		);
		gate.release();
		await Promise.all([first, second]);

		const aphex = (await updCache.get(APHEX)) as ArtistNode;
		expect(slugsOf(aphex.collaborators).sort()).toEqual(["artist:richard-d-james", "artist:squarepusher"]);
	});

	it("keeps 4 concurrent rewrites of different edges of the same node", async () => {
		const olds = [1, 2, 3, 4].map((n) => ref(`artist:old-${n}` as Slug, `Old ${n}`));
		await updCache.write(artist({ collaborators: olds }));
		let active = 0;
		let maxActive = 0;

		await Promise.all(
			olds.map((old, i) =>
				updCache.update(APHEX, async (node) => {
					active++;
					maxActive = Math.max(maxActive, active);
					// Yield to the event loop so an unlocked implementation would interleave here.
					await new Promise<void>((resolve) => setImmediate(resolve));
					active--;
					const a = node as ArtistNode;
					return {
						...a,
						collaborators: a.collaborators.map((c) =>
							c.slug === old.slug ? ref(`artist:new-${i + 1}` as Slug, `New ${i + 1}`) : c,
						),
					};
				}),
			),
		);

		const aphex = (await updCache.get(APHEX)) as ArtistNode;
		expect(slugsOf(aphex.collaborators)).toEqual([
			"artist:new-1",
			"artist:new-2",
			"artist:new-3",
			"artist:new-4",
		]);
		expect(maxActive).toBe(1);
	});

	it("keeps both an update and a reverse edge applied to the node meanwhile", async () => {
		await updCache.write(artist());
		const reachedReverse = deferred();
		const labelFile = join(updDir, "nodes", "label", "warp.json");

		const update = updCache.update(APHEX, async (node) => {
			reachedReverse.release();
			// Hold the lock until the label is on disk: its reverse edge (label.roster -> artist.labels)
			// is then queued on this node's lock, and must apply after this update, not be overwritten.
			await vi.waitFor(async () => readFile(labelFile, "utf8"), { interval: 1, timeout: 5000 });
			await new Promise<void>((resolve) => setImmediate(resolve));
			return withCollaborator(node, ref("artist:squarepusher", "Squarepusher"));
		});
		await reachedReverse.promise;
		const labelWrite = updCache.write(warp({ roster: [ref(APHEX, "Aphex Twin")] }));
		await Promise.all([update, labelWrite]);

		const aphex = (await updCache.get(APHEX)) as ArtistNode;
		expect(slugsOf(aphex.collaborators)).toEqual(["artist:squarepusher"]);
		expect(slugsOf(aphex.labels)).toEqual([WARP]);
	});

	it("applies the reverse edges pending for the node and clears them", async () => {
		await updCache.write(artist());
		await writeFile(
			join(updDir, "pending-reverses.json"),
			JSON.stringify({ [APHEX]: [{ field: "labels", cardinality: "list", edge: warpRef }] }),
			"utf8",
		);
		const fresh = new NodeCache(updDir);

		const written = await fresh.update(APHEX, (node) =>
			withCollaborator(node, ref("artist:squarepusher", "Squarepusher")),
		);

		expect(written).toBe(true);
		const aphex = (await fresh.get(APHEX)) as ArtistNode;
		expect(slugsOf(aphex.collaborators)).toEqual(["artist:squarepusher"]);
		expect(slugsOf(aphex.labels)).toEqual([WARP]);
		const pending = JSON.parse(await readFile(join(updDir, "pending-reverses.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(pending[APHEX]).toBeUndefined();
	});

	it("writes nothing when fn reports no change", async () => {
		await updCache.write(artist());
		const file = join(updDir, "nodes", "artist", "aphex-twin.json");
		const before = await readFile(file, "utf8");
		const writtenBefore = updCache.stats.written;

		expect(await updCache.update(APHEX, () => null)).toBe(false);

		expect(await readFile(file, "utf8")).toBe(before);
		expect(updCache.stats.written).toBe(writtenBefore);
	});

	it("leaves the file intact, and releases the lock, when fn throws or validation fails", async () => {
		await updCache.write(artist());
		const file = join(updDir, "nodes", "artist", "aphex-twin.json");
		const before = await readFile(file, "utf8");

		await expect(
			updCache.update(APHEX, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(
			updCache.update(APHEX, (node) => ({ ...node, citations: [] }) as unknown as NodePayload),
		).rejects.toThrow();
		await expect(
			updCache.update(APHEX, (node) => ({ ...node, slug: "artist:other" }) as NodePayload),
		).rejects.toThrow(/must not change the slug/);

		expect(await readFile(file, "utf8")).toBe(before);
		expect(await readdir(join(updDir, "nodes", "artist"))).toEqual(["aphex-twin.json"]);
		// The failures did not wedge the node: a later update still goes through.
		expect(await updCache.update(APHEX, (node) => withCollaborator(node, ref("artist:x", "X")))).toBe(true);
	});

	it("throws NotFoundError for a node that is not cached", async () => {
		await expect(updCache.update(APHEX, (node) => node)).rejects.toMatchObject({ name: "NotFoundError" });
		await expect(updCache.update("artist:../../outside" as Slug, (node) => node)).rejects.toMatchObject({
			name: "ValidationError",
		});
	});
});
