import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { GenreRedirects } from "../src/genre-registry.js";
import { createNodeService } from "../src/services/node-service.js";
import type { GenreNode, Slug } from "../src/types.js";

// TRA-30: node-service.getNode applies the flattened genre-redirect table on the read path so
// that a slug merged away by TRA-22's duplicate-merge migration (e.g. "genre:electronic-music")
// still resolves to the canonical node instead of "not found", matching what the materialization
// path (TRA-28's genre registry) already serves for the same identity. Only the redirect table is
// consulted here, never the QID index: a slug that was never materialized under any identity
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

const rejectRunJit = async (): Promise<never> => {
	throw new Error("must not be called");
};

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
	});

	it("leaves an unredirected slug unchanged", async () => {
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
		const getNode = createNodeService({ cache, runJit: rejectRunJit, redirects: new Map() });

		const result = await getNode("genre:electronic" as Slug);

		expect(result?.source).toBe("cache");
		expect(result?.node.slug).toBe("genre:electronic");
	});
});
