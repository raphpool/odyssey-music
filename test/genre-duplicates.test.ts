import { describe, expect, it } from "vitest";
import { buildDuplicateReport } from "../scripts/report-genre-duplicates.js";
import type { ArtistNode, EdgeRef, GenreNode, TrackNode } from "../src/types.js";

// Local factories, same motif as test/cache.test.ts:19-36: fully shaped nodes so tests read
// like real cache content, callers override only what a given case cares about.

function genreNode(overrides: Partial<GenreNode> & Pick<GenreNode, "slug" | "name">): GenreNode {
	return {
		type: "genre",
		editorial_definition: `Test fixture definition for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for duplicate-report coverage. `.repeat(
			4,
		),
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

function artistNode(overrides: Partial<ArtistNode> & Pick<ArtistNode, "slug" | "name">): ArtistNode {
	return {
		type: "artist",
		editorial_bio: `Test bio for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for duplicate-report coverage. `.repeat(
			4,
		),
		citations: [{ url: `https://example.com/${overrides.slug.split(":")[1]}` }],
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

function trackNode(overrides: Partial<TrackNode> & Pick<TrackNode, "slug" | "name">): TrackNode {
	return {
		type: "track",
		editorial_teaser: `Test teaser for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for duplicate-report coverage. `.repeat(
			4,
		),
		citations: [{ url: `https://example.com/${overrides.slug.split(":")[1]}` }],
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

/** A genre edge ref pointing at `node`, for wiring up usages from other node types. */
function genreEdge(node: Pick<GenreNode, "slug" | "name"> & { qid?: string }): EdgeRef {
	return {
		type: "genre",
		slug: node.slug,
		name: node.name,
		...(node.qid !== undefined ? { qid: node.qid } : {}),
	};
}

describe("buildDuplicateReport", () => {
	it("groups two genre nodes sharing a qid, sorted by usages desc, with the right total", () => {
		const heavy = genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q9778" });
		const light = genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q9778" });

		const nodes = [
			heavy,
			light,
			artistNode({ slug: "artist:a", name: "A", genres: [genreEdge(heavy)] }),
			artistNode({ slug: "artist:b", name: "B", genres: [genreEdge(heavy)] }),
			artistNode({ slug: "artist:c", name: "C", genres: [genreEdge(heavy)] }),
			artistNode({ slug: "artist:d", name: "D", genres: [genreEdge(light)] }),
		];

		const report = buildDuplicateReport(nodes);

		expect(report.groups).toHaveLength(1);
		const group = report.groups[0];
		expect(group?.qid).toBe("Q9778");
		expect(group?.members.map((m) => m.slug)).toEqual(["genre:electronic", "genre:electronic-music"]);
		expect(group?.members.map((m) => m.usages)).toEqual([3, 1]);
		expect(group?.totalUsages).toBe(4);
	});

	it("groups three genre nodes sharing a qid into a single group of three, not three pairs", () => {
		const a = genreNode({ slug: "genre:a", name: "A", qid: "Q1" });
		const b = genreNode({ slug: "genre:b", name: "B", qid: "Q1" });
		const c = genreNode({ slug: "genre:c", name: "C", qid: "Q1" });

		const report = buildDuplicateReport([a, b, c]);

		expect(report.groups).toHaveLength(1);
		expect(report.groups[0]?.members).toHaveLength(3);
	});

	it("never groups two genre nodes with different qids", () => {
		const a = genreNode({ slug: "genre:a", name: "A", qid: "Q1" });
		const b = genreNode({ slug: "genre:b", name: "B", qid: "Q2" });

		const report = buildDuplicateReport([a, b]);

		expect(report.groups).toHaveLength(0);
	});

	it("puts a genre node with no qid in unqualified, never in a group, even alongside another unqualified node", () => {
		const a = genreNode({ slug: "genre:a", name: "A" });
		const b = genreNode({ slug: "genre:b", name: "B" });

		const report = buildDuplicateReport([a, b]);

		expect(report.groups).toHaveLength(0);
		expect(report.unqualified.map((u) => u.slug).sort()).toEqual(["genre:a", "genre:b"]);
	});

	it("keeps a genre node with zero usages in the report instead of dropping it", () => {
		const unused = genreNode({ slug: "genre:unused", name: "Unused" });

		const report = buildDuplicateReport([unused]);

		expect(report.unqualified).toHaveLength(1);
		expect(report.unqualified[0]?.usages).toBe(0);
	});

	it("counts usages from edges on every node type, not just artist.genres", () => {
		const target = genreNode({ slug: "genre:dub", name: "Dub" });
		const referrer = genreNode({
			slug: "genre:dub-techno",
			name: "Dub Techno",
			related_genres: [genreEdge(target)],
		});

		const nodes = [
			target,
			referrer,
			artistNode({ slug: "artist:a", name: "A", genres: [genreEdge(target)] }),
			trackNode({ slug: "track:a", name: "A", genres: [genreEdge(target)] }),
		];

		const report = buildDuplicateReport(nodes);

		const dub = report.unqualified.find((u) => u.slug === "genre:dub");
		expect(dub?.usages).toBe(3);
	});

	it("produces an identical report regardless of input array order", () => {
		const a = genreNode({ slug: "genre:a", name: "A", qid: "Q1" });
		const b = genreNode({ slug: "genre:b", name: "B", qid: "Q1" });
		const c = genreNode({ slug: "genre:c", name: "C" });
		const referrer = artistNode({ slug: "artist:a", name: "A", genres: [genreEdge(a), genreEdge(b)] });

		const reportOne = buildDuplicateReport([a, b, c, referrer]);
		const reportTwo = buildDuplicateReport([referrer, c, b, a]);

		expect(reportTwo).toEqual(reportOne);
	});

	it("returns an empty report without throwing when the cache has no genre nodes", () => {
		const nodes = [artistNode({ slug: "artist:a", name: "A" })];

		expect(() => buildDuplicateReport(nodes)).not.toThrow();
		const report = buildDuplicateReport(nodes);
		expect(report.groups).toEqual([]);
		expect(report.unqualified).toEqual([]);
		expect(report.genreNodeCount).toBe(0);
	});
});
