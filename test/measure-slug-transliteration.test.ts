import { describe, expect, test } from "vitest";
import {
	formatReport,
	measureSlugTransliteration,
	type RawNode,
} from "../scripts/measure-slug-transliteration.js";

const ref = (slug: string, type: string, name: string, artist?: string): RawNode => ({
	slug,
	type,
	name,
	...(artist ? { artist } : {}),
});

describe("measureSlugTransliteration (TRA-528)", () => {
	const nodes: RawNode[] = [
		{
			slug: "artist:m",
			name: "MØ",
			discography: [ref("project:in-the-m-de--m", "project", "In the Møde", "MØ")],
			collaborators: [ref("artist:l-titia-sadier", "artist", "Lætitia Sadier")],
		},
		{ slug: "artist:laetitia-sadier", name: "Laetitia Sadier" },
		{
			slug: "project:void",
			name: "ØØ Void",
			artists: [ref("artist:m", "artist", "MØ")],
		},
		{ slug: "artist:bjork", name: "Björk", collaborators: [ref("artist:m", "artist", "MØ")] },
	];
	const report = measureSlugTransliteration(nodes);

	test("lists the nodes whose slug changes", () => {
		expect(report.nodeChanges.map((c) => [c.from, c.to])).toEqual([
			["artist:m", "artist:mo"],
			["project:void", "project:oo-void"],
		]);
	});

	test("lists the edge targets whose slug changes, with the number of edges and dangling targets", () => {
		expect(report.edgeChanges.map((c) => [c.from, c.to, c.edges, c.dangling])).toEqual([
			["artist:l-titia-sadier", "artist:laetitia-sadier", 1, true],
			["artist:m", "artist:mo", 2, false],
			["project:in-the-m-de--m", "project:in-the-mode--mo", 1, true],
		]);
	});

	test("flags a new slug that is already another node's slug", () => {
		expect(report.collisions).toHaveLength(1);
		expect(report.collisions[0]).toMatchObject({
			from: "artist:l-titia-sadier",
			to: "artist:laetitia-sadier",
		});
	});

	test("flags two old slugs mapping to the same new slug", () => {
		// "Mœ" (artist:m) and "Møe" (artist:m-e) both become artist:moe
		const r = measureSlugTransliteration([
			{ slug: "artist:m", name: "Mœ" },
			{ slug: "artist:m-e", name: "Møe" },
		]);
		expect(r.collisions).toEqual([
			{ from: "artist:m-e", to: "artist:moe", with: "also the target of artist:m" },
		]);
	});

	test("a slug that is not derived from its name is reported, not mapped", () => {
		const r = measureSlugTransliteration([
			{ slug: "artist:ona", name: "Łona" },
			{ slug: "artist:o-na", name: "Łona" },
		]);
		expect(r.mapping).toEqual({ "artist:ona": "artist:lona" });
		expect(r.unresolved.map((u) => u.slug)).toEqual(["artist:o-na"]);
	});

	test("exposes the old -> new table the migration consumes", () => {
		expect(report.mapping).toEqual({
			"artist:l-titia-sadier": "artist:laetitia-sadier",
			"artist:m": "artist:mo",
			"project:in-the-m-de--m": "project:in-the-mode--mo",
			"project:void": "project:oo-void",
		});
	});

	test("prints a report and leaves untouched nodes alone", () => {
		const text = formatReport(report);
		expect(text).toContain("artist:m -> artist:mo");
		expect(text).toContain("collisions: 1");
		expect(text).not.toContain("artist:bjork ->");
	});
});
