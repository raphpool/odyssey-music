import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { pipelineConfig } from "../src/config.js";
import { type GenreRedirects, loadRedirects } from "../src/genre-registry.js";
import type { MaterializeRequest } from "../src/services/materialize-service.js";
import { createNodeService } from "../src/services/node-service.js";
import type { ArtistNode, GenreNode, NodePayload, Slug, TrackNode } from "../src/types.js";

// TRA-30: node-service.getNode applies the flattened genre-redirect table on the read path so
// that a slug merged away by TRA-22's duplicate-merge migration (e.g. "genre:electronic-music")
// still resolves to the canonical node instead of "not found", matching what the materialization
// path (TRA-29's materialize guard) already serves for the same identity. Only the redirect table
// is consulted here, never the QID index: a slug that was never materialized under any identity
// stays null.
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

// Older than pipelineConfig.nodeTtlMs, so getNode treats the cached node as stale and attempts a
// JIT refresh instead of serving it straight from the cache.
const STALE_MATERIALIZED_AT = new Date(Date.now() - pipelineConfig.nodeTtlMs - 60_000).toISOString();

const rejectRunJit = async (): Promise<never> => {
	throw new Error("must not be called");
};

// A fake runJit that captures the opts it was called with, rather than a mock of code this
// project owns -- runJit is a dependency injected across the createNodeService boundary by
// contract, exactly like rejectRunJit above.
function capturingRunJit(node: NodePayload): {
	runJit: (body: MaterializeRequest, opts?: { fresh?: boolean; slug?: Slug }) => Promise<NodePayload>;
	calls: Array<{ body: MaterializeRequest; opts?: { fresh?: boolean; slug?: Slug } }>;
} {
	const calls: Array<{ body: MaterializeRequest; opts?: { fresh?: boolean; slug?: Slug } }> = [];
	return {
		calls,
		runJit: async (body, opts) => {
			calls.push(opts === undefined ? { body } : { body, opts });
			return node;
		},
	};
}

describe("node-service getNode genre redirects (TRA-30)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-node-service-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("resolves a redirected slug to the canonical node", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
		const redirects: GenreRedirects = new Map([
			["genre:electronic-music" as Slug, "genre:electronic" as Slug],
		]);
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects });

		const result = await getNode("genre:electronic-music" as Slug);

		expect(result?.source).toBe("cache");
		expect(result?.node.slug).toBe("genre:electronic");
		expect(result?.redirected_from).toBe("genre:electronic-music");
	});

	it("returns null for an unknown slug absent from the redirect table", async () => {
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects: new Map() });

		const result = await getNode("genre:does-not-exist" as Slug);

		expect(result).toBeNull();
	});

	it("returns null for a slug redirected to a node that was never materialized", async () => {
		const redirects: GenreRedirects = new Map([
			["genre:electronic-music" as Slug, "genre:electronic" as Slug],
		]);
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects });

		const result = await getNode("genre:electronic-music" as Slug);

		expect(result).toBeNull();
	});

	it("serves a live node as-is even if it also appears as a redirect key", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
		await cache.write(genreNode({ slug: "genre:electronic-music", name: "Electronic Music" }));
		const redirects: GenreRedirects = new Map([
			["genre:electronic-music" as Slug, "genre:electronic" as Slug],
		]);
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects });

		const result = await getNode("genre:electronic-music" as Slug);

		expect(result?.source).toBe("cache");
		expect(result?.node.slug).toBe("genre:electronic-music");
		expect(result?.redirected_from).toBeUndefined();
	});

	it("leaves an unredirected slug unchanged", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects: new Map() });

		const result = await getNode("genre:electronic" as Slug);

		expect(result?.source).toBe("cache");
		expect(result?.node.slug).toBe("genre:electronic");
		expect(result?.redirected_from).toBeUndefined();
	});

	it("pins a stale redirected node's JIT refresh to the canonical slug", async () => {
		// Regression (review round 1, PR #31): runJit/canonicalizeDraft re-derives a slug from
		// the LLM draft's own name when not pinned, which can resurrect the losing slug of a
		// genre redirect on refresh. The stale node lives under the canonical slug; the request
		// comes in on the redirected (losing) slug.
		await cache.write(genreNode({ slug: "genre:idm", name: "IDM", materialized_at: STALE_MATERIALIZED_AT }));
		const redirects: GenreRedirects = new Map([
			["genre:intelligent-dance-music" as Slug, "genre:idm" as Slug],
		]);
		const refreshed = genreNode({ slug: "genre:idm", name: "IDM" });
		const { runJit, calls } = capturingRunJit(refreshed);
		const getNode = createNodeService({ cache, runJit, redirects });

		const result = await getNode("genre:intelligent-dance-music" as Slug);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.opts).toMatchObject({ fresh: true, slug: "genre:idm" });
		expect(result?.source).toBe("jit-refreshed");
		expect(result?.node).toBe(refreshed);
		expect(result?.redirected_from).toBe("genre:intelligent-dance-music");
	});

	it("pins a stale non-redirected node's JIT refresh to the requested slug, for any node type", async () => {
		// Same pinning guarantee applies outside genre nodes: node-service has no notion of
		// "genre" here, so an artist node exercises it without relying on redirect-table shape.
		await cache.write(
			artistNode({ slug: "artist:fixture", name: "Fixture Artist", materialized_at: STALE_MATERIALIZED_AT }),
		);
		const refreshed = artistNode({ slug: "artist:fixture", name: "Fixture Artist" });
		const { runJit, calls } = capturingRunJit(refreshed);
		const getNode = createNodeService({ cache, runJit, redirects: new Map() });

		const result = await getNode("artist:fixture" as Slug);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.opts).toMatchObject({ fresh: true, slug: "artist:fixture" });
		expect(result?.source).toBe("jit-refreshed");
		expect(result?.redirected_from).toBeUndefined();
	});
});

describe("node-service getNode slug redirects for non-genre types (TRA-453)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-node-service-slug-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("serves the scoped track for an old track slug listed in slug-redirects.json", async () => {
		await cache.write(trackNode({ slug: "track:fitna--rohff", name: "Fitna" }));
		const slugPath = join(dir, "slug-redirects.json");
		await writeFile(slugPath, JSON.stringify({ redirects: { "track:fitna": "track:fitna--rohff" } }), "utf8");
		const redirects = await loadRedirects({ genre: join(dir, "absent.json"), slug: slugPath });
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects });

		const result = await getNode("track:fitna" as Slug);

		expect(result?.source).toBe("cache");
		expect(result?.node.slug).toBe("track:fitna--rohff");
		expect(result?.redirected_from).toBe("track:fitna");
	});

	it("serves a live track as-is when it is also a redirect key", async () => {
		await cache.write(trackNode({ slug: "track:fitna", name: "Fitna" }));
		await cache.write(trackNode({ slug: "track:fitna--rohff", name: "Fitna" }));
		const redirects: GenreRedirects = new Map([["track:fitna" as Slug, "track:fitna--rohff" as Slug]]);
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects });

		const result = await getNode("track:fitna" as Slug);

		expect(result?.node.slug).toBe("track:fitna");
		expect(result?.redirected_from).toBeUndefined();
	});
});
