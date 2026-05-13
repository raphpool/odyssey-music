import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ArtistNode, NodePayload, TrackNode } from "../src/types.js";

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
		editorial_article: "An article about Windowlicker.",
		citations: [],
		materialized_at: new Date().toISOString(),
		artists: [{ type: "artist", slug: "artist:aphex-twin", name: "Aphex Twin" }],
		genres: [],
		producers: [],
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
		editorial_article: "An article about Funky Drummer.",
		citations: [],
		materialized_at: new Date().toISOString(),
		artists: [{ type: "artist", slug: "artist:james-brown", name: "James Brown" }],
		genres: [],
		producers: [],
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
		editorial_article: "Long-form on Brian Eno.",
		citations: [],
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
			editorial_article: "Long-form on Aphex Twin.",
			citations: [],
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
