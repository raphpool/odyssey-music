import { describe, expect, it } from "vitest";
import { formatReport, planBackfill } from "../scripts/migrations/2026-09-04-backfill-genre-qid.js";
import { createGenreResolver, type GenreResolver } from "../src/genre-identity.js";
import type { ArtistNode, EdgeRef, GenreNode, Slug } from "../src/types.js";

function fakeResolver(): GenreResolver {
	return createGenreResolver({
		catalog: [
			{ slug: "techno", name: "Techno", wikidata_qid: "Q170611" },
			{ slug: "acid", name: "Acid", wikidata_qid: "Q106528337" },
		],
		mbidToQid: new Map(),
		aliases: new Map(),
	});
}

function artistNode(overrides: Partial<ArtistNode> = {}): ArtistNode {
	return {
		type: "artist",
		slug: "artist:test-artist",
		name: "Test Artist",
		editorial_bio: "A test artist bio.",
		editorial_article: "A real long article about the test artist. ".repeat(4),
		citations: [{ url: "https://example.com/test-artist", title: "Test Artist" }],
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

function genreNode(overrides: Partial<GenreNode> = {}): GenreNode {
	return {
		type: "genre",
		slug: "genre:test-genre",
		name: "Test Genre",
		editorial_definition: "A test genre definition.",
		editorial_article: "A real long article about the test genre. ".repeat(4),
		citations: [{ url: "https://example.com/test-genre", title: "Test Genre" }],
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

describe("planBackfill", () => {
	it("stamps a resolvable genre edge, leaves the unresolvable one strictly intact", () => {
		const resolvable: EdgeRef = { slug: "genre:techno", type: "genre", name: "Techno" };
		const unresolvable: EdgeRef = { slug: "genre:not-a-real-genre", type: "genre", name: "Not A Real Genre" };
		const node = artistNode({ genres: [resolvable, unresolvable] });

		const plan = planBackfill([{ path: "/a.json", node }], fakeResolver());

		expect(plan.writes.size).toBe(1);
		const written = plan.writes.get("/a.json") as ArtistNode;
		expect(written.genres[0]).toEqual({ ...resolvable, qid: "Q170611" });
		expect(written.genres[1]).toEqual(unresolvable);
		expect(plan.stats.newlyResolved).toBe(1);
		expect(plan.stats.unresolvedEdges).toBe(1);
		expect(plan.unresolved).toEqual([{ name: "Not A Real Genre", count: 1 }]);
	});

	it("leaves a node with no genre edges out of writes", () => {
		const node = artistNode();
		const plan = planBackfill([{ path: "/a.json", node }], fakeResolver());
		expect(plan.writes.size).toBe(0);
		expect(plan.stats.genreEdgeOccurrences).toBe(0);
	});

	it("doesn't rewrite an edge that already carries the resolved qid", () => {
		const edge: EdgeRef = { slug: "genre:techno", type: "genre", name: "Techno", qid: "Q170611" };
		const node = artistNode({ genres: [edge] });
		const plan = planBackfill([{ path: "/a.json", node }], fakeResolver());
		expect(plan.writes.size).toBe(0);
		expect(plan.stats.alreadyStamped).toBe(1);
		expect(plan.stats.newlyResolved).toBe(0);
	});

	it("leaves a conflicting qid untouched and reports it", () => {
		const edge: EdgeRef = { slug: "genre:techno", type: "genre", name: "Techno", qid: "Q999999" };
		const node = artistNode({ genres: [edge] });
		const plan = planBackfill([{ path: "/a.json", node }], fakeResolver());
		expect(plan.writes.size).toBe(0);
		expect(plan.stats.conflictEdges).toBe(1);
		expect(plan.conflicts).toEqual([
			{
				slug: "artist:test-artist",
				field: "genres",
				name: "Techno",
				existing: "Q999999",
				resolved: "Q170611",
			},
		]);
	});

	it("stamps a genre node's own qid, including via the slug-body fallback", () => {
		const direct = genreNode({ slug: "genre:techno", name: "Techno" });
		const viaSlug = genreNode({ slug: "genre:acid", name: "Not The Catalog Name" });

		const plan = planBackfill(
			[
				{ path: "/direct.json", node: direct },
				{ path: "/via-slug.json", node: viaSlug },
			],
			fakeResolver(),
		);

		expect((plan.writes.get("/direct.json") as GenreNode).qid).toBe("Q170611");
		expect((plan.writes.get("/via-slug.json") as GenreNode).qid).toBe("Q106528337");
		expect(plan.stats.genreNodesStamped).toBe(2);
		expect(plan.stats.genreNodesUnresolved).toBe(0);
	});

	it("feeds a genre node's own unresolved name into the alias-curation queue", () => {
		const node = genreNode({ slug: "genre:not-a-real-genre", name: "Not A Real Genre" });
		const plan = planBackfill([{ path: "/g.json", node }], fakeResolver());

		expect(plan.writes.has("/g.json")).toBe(false);
		expect(plan.stats.genreNodesUnresolved).toBe(1);
		expect(plan.unresolved).toEqual([{ name: "Not A Real Genre", count: 1 }]);
	});

	it("leaves a genre node's conflicting own qid untouched and reports it", () => {
		const node = genreNode({ slug: "genre:techno", name: "Techno", qid: "Q999999" });
		const plan = planBackfill([{ path: "/g.json", node }], fakeResolver());

		expect(plan.writes.has("/g.json")).toBe(false);
		expect(plan.stats.genreNodesStamped).toBe(0);
		expect(plan.conflicts).toEqual([
			{ slug: "genre:techno", field: "qid", name: "Techno", existing: "Q999999", resolved: "Q170611" },
		]);
	});

	it("sorts unresolved genres by frequency descending, then by name", () => {
		const mkEdge = (name: string): EdgeRef => ({
			slug: `genre:${name.toLowerCase()}` as Slug,
			type: "genre",
			name,
		});
		const nodes = [
			artistNode({ slug: "artist:a", genres: [mkEdge("Zeta")] }),
			artistNode({ slug: "artist:b", genres: [mkEdge("Alpha"), mkEdge("Beta")] }),
			artistNode({ slug: "artist:c", genres: [mkEdge("Beta"), mkEdge("Alpha")] }),
		];
		const plan = planBackfill(
			nodes.map((node, i) => ({ path: `/n${i}.json`, node })),
			fakeResolver(),
		);
		expect(plan.unresolved).toEqual([
			{ name: "Alpha", count: 2 },
			{ name: "Beta", count: 2 },
			{ name: "Zeta", count: 1 },
		]);
	});
});

describe("formatReport", () => {
	it("produces the === Section === format, with (DRY RUN) only when dryRun is true", () => {
		const resolvable: EdgeRef = { slug: "genre:techno", type: "genre", name: "Techno" };
		const unresolvable: EdgeRef = { slug: "genre:not-a-real-genre", type: "genre", name: "Not A Real Genre" };
		const conflicting: EdgeRef = { slug: "genre:acid", type: "genre", name: "Acid", qid: "Q999999" };
		const node = artistNode({ genres: [resolvable, unresolvable, conflicting] });
		const genre = genreNode({ slug: "genre:techno", name: "Techno" });

		const plan = planBackfill(
			[
				{ path: "/a.json", node },
				{ path: "/g.json", node: genre },
			],
			fakeResolver(),
		);

		const dryRunReport = formatReport(plan, true);
		expect(dryRunReport).toContain("=== Genre QID backfill (DRY RUN) ===");
		expect(dryRunReport).toContain("Node files scanned:        2");
		expect(dryRunReport).toContain("Genre edge occurrences:    3");
		expect(dryRunReport).toContain("  newly resolved:          1  (33.3%)");
		expect(dryRunReport).toContain("  unresolved:              1  (33.3%)");
		expect(dryRunReport).toContain("  conflicts (kept as-is):  1");
		expect(dryRunReport).toContain("Genre nodes:               1");
		expect(dryRunReport).toContain("  stamped:                 1");
		expect(dryRunReport).toContain("=== Resolution strategy ===");
		expect(dryRunReport).toContain("  name       2");
		expect(dryRunReport).toContain("=== Unresolved genres by frequency ===");
		expect(dryRunReport).toContain("    1  Not A Real Genre");
		expect(dryRunReport).toContain("=== Conflicts ===");
		expect(dryRunReport).toContain("artist:test-artist  genres  Acid  existing=Q999999  resolved=Q106528337");

		const appliedReport = formatReport(plan, false);
		expect(appliedReport).toContain("=== Genre QID backfill ===");
		expect(appliedReport).not.toContain("DRY RUN");
	});

	it("prints (none) placeholders when there are no unresolved genres or conflicts", () => {
		const edge: EdgeRef = { slug: "genre:techno", type: "genre", name: "Techno" };
		const plan = planBackfill([{ path: "/a.json", node: artistNode({ genres: [edge] }) }], fakeResolver());
		const report = formatReport(plan, true);
		expect(report).toContain("=== Unresolved genres by frequency ===\n  (none)");
		expect(report).toContain("=== Conflicts ===\n  (none)");
	});
});
