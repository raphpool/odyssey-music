import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { loadRedirects, resolveReadSlug } from "../src/genre-registry.js";
import { loadGenreSeeds } from "../src/genre-seeds.js";
import type { Slug } from "../src/types.js";

// TRA-673 (2026-10-23): 8 project/track seed targets still carried the bare slugs from before the
// scoped-slug migration (e.g. project:ride-on-time instead of project:ride-on-time--black-box).
// A seed run reaching them would have created a bare twin next to the scoped node, and the
// top-up-genres run could not reach them at all. This reads the committed cache and the committed
// redirect table, so it fails the day a seed is added with a slug that matches no node.
const CACHE_ROOT = fileURLToPath(new URL("../cache", import.meta.url));

async function projectAndTrackTargets(): Promise<{ qid: string; slug: Slug }[]> {
	const seeds = await loadGenreSeeds();
	return Object.entries(seeds).flatMap(([qid, folder]) =>
		folder.targets
			.filter((target) => target.type !== "artist")
			.map((target) => ({ qid, slug: target.slug as Slug })),
	);
}

describe("genre seed project/track targets (TRA-673)", () => {
	it("every target exists in the cache or resolves by redirect to an existing node", async () => {
		const [targets, redirects] = await Promise.all([projectAndTrackTargets(), loadRedirects()]);
		const cache = new NodeCache(CACHE_ROOT);
		expect(targets.length).toBeGreaterThan(0);
		const dangling: string[] = [];
		for (const { qid, slug } of targets) {
			const resolved = await resolveReadSlug(slug, redirects, cache);
			if (!(await cache.has(resolved))) dangling.push(`${qid} ${slug} -> ${resolved}`);
		}
		expect(dangling).toEqual([]);
	});

	it("no target keeps a stale pre-migration slug that only works through a redirect", async () => {
		const [targets, redirects] = await Promise.all([projectAndTrackTargets(), loadRedirects()]);
		const stale = targets
			.filter(({ slug }) => redirects.has(slug))
			.map(({ qid, slug }) => `${qid} ${slug} -> ${redirects.get(slug)}`);
		expect(stale).toEqual([]);
	});
});
