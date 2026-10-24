import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { nodePayloadSchema } from "../src/schemas.js";
import type { EdgeRef, ProjectNode, Slug, TrackNode } from "../src/types.js";

// TRA-485: the "at least one artist" rule is held by the pipeline when a work is created (see
// test/pipeline-credit-required.test.ts), NOT by the schema. Works written before the rule are still on disk
// with `artists: []`; a migration or an inverse emission that rewrites one goes through this schema and the
// cache, and must keep working. A `.min(1)` in src/schemas.ts would break every one of those rewrites.

const ARTICLE = "A fixture article, long enough to satisfy the node schema. ".repeat(4);
const edge = (type: EdgeRef["type"], slug: string, name: string): EdgeRef => ({
	slug: slug as Slug,
	type,
	name,
});

function project(slug: string, artists: EdgeRef[] = []): ProjectNode {
	return {
		type: "project",
		slug: slug as Slug,
		name: "Legacy Album",
		editorial_article: ARTICLE,
		editorial_pitch: "A fixture album written before the credit rule.",
		citations: [{ url: "https://example.com/legacy-album" }],
		materialized_at: "2026-01-01T00:00:00.000Z",
		artists,
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
	};
}

function track(slug: string, name: string, overrides: Partial<TrackNode> = {}): TrackNode {
	return {
		type: "track",
		slug: slug as Slug,
		name,
		editorial_article: ARTICLE,
		editorial_teaser: "A fixture track.",
		citations: [{ url: `https://example.com/${name.toLowerCase().replace(/\s+/g, "-")}` }],
		materialized_at: "2026-01-01T00:00:00.000Z",
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

describe("works without a credit stay valid for the schema and the cache (TRA-485)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-legacy-uncredited-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("parses a project and a track with artists: []", () => {
		expect(nodePayloadSchema.parse(project("project:legacy-album")).type).toBe("project");
		expect(nodePayloadSchema.parse(track("track:legacy-song", "Legacy Song")).type).toBe("track");
	});

	it("parses the same works once they are credited", () => {
		const credit = edge("artist", "artist:roni-size", "Roni Size");
		expect(nodePayloadSchema.parse(project("project:new-forms--roni-size", [credit]))).toMatchObject({
			artists: [credit],
		});
	});

	it("lets a migration rewrite an uncredited work with replace()", async () => {
		await cache.write(project("project:legacy-album"));

		await cache.replace({ ...project("project:legacy-album"), editorial_pitch: "Reworded by a migration." });

		const stored = (await cache.get("project:legacy-album")) as ProjectNode;
		expect(stored.editorial_pitch).toBe("Reworded by a migration.");
		expect(stored.artists).toEqual([]);
	});

	it("lets an inverse emission rewrite an uncredited work", async () => {
		await cache.write(track("track:legacy-song", "Legacy Song"));

		// Writing a track that samples it makes the cache add `sampled_by` to the uncredited target.
		await cache.write(
			track("track:newer-song--roni-size", "Newer Song", {
				artists: [edge("artist", "artist:roni-size", "Roni Size")],
				samples: [edge("track", "track:legacy-song", "Legacy Song")],
			}),
		);

		const target = (await cache.get("track:legacy-song")) as TrackNode;
		expect(target.sampled_by.map((e) => e.slug)).toEqual(["track:newer-song--roni-size"]);
		expect(target.artists).toEqual([]);
	});
});
