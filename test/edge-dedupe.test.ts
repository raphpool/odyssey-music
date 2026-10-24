import { describe, expect, it } from "vitest";
import { dedupeEdgeList, dedupeNodeListEdges } from "../src/edge-dedupe.js";

// TRA-557: one edge per slug in a list. The rule is the dispatcher's decision of 2026-10-23 (one page per
// title) plus the discography policy for two release groups of one title: album before EP before single, then
// the earliest year; a tie is doubt and the first occurrence stays.

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

function project(slug: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { slug, type: "project", name, artist: "Fixture Artist", ...extra };
}

describe("dedupeEdgeList -- same or missing mbid", () => {
	it("keeps the first occurrence and fills the fields it lacks, without overwriting one it has", () => {
		const first = project("project:x--a", "X", { mbid: A, year: "1992" });
		const later = project("project:x--a", "X (again)", {
			mbid: A.toUpperCase(),
			year: "2001",
			releaseType: "album",
		});

		const { edges, removals } = dedupeEdgeList([first, later]);

		expect(edges).toEqual([{ ...first, releaseType: "album" }]);
		expect(removals).toHaveLength(1);
		expect(removals[0]).toMatchObject({
			slug: "project:x--a",
			reason: "same-or-missing-mbid",
			removed: later,
		});
	});

	it("treats an absent mbid as compatible and takes the one the later entry carries", () => {
		const first = project("project:x--a", "X");
		const later = project("project:x--a", "X", { mbid: B, year: "1999" });

		const { edges, removals } = dedupeEdgeList([first, later]);

		expect(edges).toEqual([{ ...first, mbid: B, year: "1999" }]);
		expect(removals.map((r) => r.reason)).toEqual(["same-or-missing-mbid"]);
	});
});

describe("dedupeEdgeList -- different mbids", () => {
	it("prefers the album over the single, wherever each sits, and keeps the survivors' order", () => {
		const remix = project("project:t--a", "T (remix)", { mbid: A, year: "2023", releaseType: "single" });
		const other = project("project:o--a", "O", { mbid: C, year: "2010" });
		const album = project("project:t--a", "T", { mbid: B, year: "1992", releaseType: "album" });

		const { edges, removals } = dedupeEdgeList([remix, other, album]);

		// The album stays at ITS place: the list was sorted newest first and still is.
		expect(edges).toEqual([other, album]);
		expect(removals).toEqual([{ slug: "project:t--a", reason: "release-type", removed: remix, kept: album }]);
	});

	it("prefers an EP over a single", () => {
		const single = project("project:t--a", "T", { mbid: A, releaseType: "single", year: "2000" });
		const ep = project("project:t--a", "T", { mbid: B, releaseType: "ep", year: "2005" });

		expect(dedupeEdgeList([single, ep]).edges).toEqual([ep]);
	});

	it("prefers the earliest year at equal type, and a known year over an unknown one", () => {
		const late = project("project:t--a", "T", { mbid: A, releaseType: "single", year: "2023" });
		const early = project("project:t--a", "T", { mbid: B, releaseType: "single", year: "1992" });
		const undated = project("project:t--a", "T", { mbid: C, releaseType: "single" });

		const byYear = dedupeEdgeList([late, early]);
		expect(byYear.edges).toEqual([early]);
		expect(byYear.removals[0]?.reason).toBe("earlier-year");
		expect(dedupeEdgeList([undated, late]).edges).toEqual([late]);
		expect(dedupeEdgeList([late, undated]).edges).toEqual([late]);
	});

	it("never merges fields across two mbids: the year of a remix is not the year of the album", () => {
		const album = project("project:t--a", "T", { mbid: A, releaseType: "album" });
		const remix = project("project:t--a", "T (remix)", { mbid: B, releaseType: "single", year: "2023" });

		expect(dedupeEdgeList([album, remix]).edges).toEqual([album]);
	});

	it("keeps the first occurrence on a tie and says so", () => {
		const first = project("project:t--a", "T", { mbid: A, releaseType: "single", year: "1993" });
		const second = project("project:t--a", "T", { mbid: B, releaseType: "single", year: "1993" });

		const { edges, removals } = dedupeEdgeList([first, second]);

		expect(edges).toEqual([first]);
		expect(removals[0]).toMatchObject({ reason: "doubt-first-kept", removed: second });
	});

	it("keeps the first occurrence of tracklist entries, which carry neither type nor year", () => {
		const touch = { slug: "track:touch", type: "track", name: "Touch", mbid: A };
		const part4 = { slug: "track:touch", type: "track", name: "Touch (Part 4)", mbid: B };

		const { edges, removals } = dedupeEdgeList([touch, part4]);

		expect(edges).toEqual([touch]);
		expect(removals.map((r) => r.reason)).toEqual(["doubt-first-kept"]);
	});

	it("collapses three or more entries of one slug to a single one", () => {
		const s1 = project("project:t--a", "T", { mbid: A, releaseType: "single", year: "2004" });
		const s2 = project("project:t--a", "T", { mbid: B, releaseType: "single", year: "2023" });
		const alb = project("project:t--a", "T", { mbid: C, releaseType: "album", year: "1990" });

		const { edges, removals } = dedupeEdgeList([s1, s2, alb]);

		expect(edges).toEqual([alb]);
		expect(removals).toHaveLength(2);
		expect(removals.every((r) => r.kept === alb)).toBe(true);
	});
});

describe("dedupeEdgeList -- invariants", () => {
	it("returns the same entries, in order, when no slug repeats", () => {
		const list = [project("project:a--x", "A"), project("project:b--x", "B")];

		const { edges, removals } = dedupeEdgeList(list);

		expect(removals).toEqual([]);
		expect(edges).toEqual(list);
		expect(edges[0]).toBe(list[0]);
	});

	it("passes through an entry it cannot compare, and mutates no input", () => {
		const first = project("project:t--a", "T", { mbid: A });
		const later = project("project:t--a", "T", { mbid: A, year: "1999" });
		const broken = { name: "no slug" };
		const list = [first, "junk", broken, later];
		const before = structuredClone(list);

		const { edges } = dedupeEdgeList(list);

		expect(edges).toEqual([{ ...first, year: "1999" }, "junk", broken]);
		expect(list).toEqual(before);
	});

	it("is idempotent", () => {
		const list = [
			project("project:t--a", "T", { mbid: A, releaseType: "single", year: "2000" }),
			project("project:t--a", "T", { mbid: B, releaseType: "album", year: "1990" }),
			project("project:u--a", "U", { mbid: C }),
		];

		const once = dedupeEdgeList(list).edges;

		expect(dedupeEdgeList(once)).toEqual({ edges: once, removals: [] });
	});
});

describe("dedupeNodeListEdges", () => {
	it("cleans every list edge field of the node's type, and only those", () => {
		const node: Record<string, unknown> = {
			type: "project",
			slug: "project:p--a",
			name: "P",
			tracklist: [
				{ slug: "track:t--a", type: "track", name: "T", mbid: A },
				{ slug: "track:t--a", type: "track", name: "T (dub)", mbid: B },
			],
			personnel: [
				{ slug: "artist:v", type: "artist", name: "V", mbid: A },
				{ slug: "artist:v", type: "artist", name: "V", mbid: B },
			],
			// Not an edge field of a project: left as it is.
			citations: [{ url: "https://example.com" }, { url: "https://example.com" }],
		};

		const out = dedupeNodeListEdges(node);

		expect(out.map((o) => o.field)).toEqual(["tracklist", "personnel"]);
		expect(node.tracklist).toHaveLength(1);
		expect(node.personnel).toHaveLength(1);
		expect(node.citations).toHaveLength(2);
	});

	it("leaves a node without a known type alone", () => {
		const node = { slug: "x", discography: [{ slug: "a" }, { slug: "a" }] };

		expect(dedupeNodeListEdges(node)).toEqual([]);
		expect(node.discography).toHaveLength(2);
	});
});
