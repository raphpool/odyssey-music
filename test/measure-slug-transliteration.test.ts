import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	formatReport,
	measureSlugTransliteration,
	type RawNode,
	readNodes,
	readPendingReverses,
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

	test("a reference that cannot re-derive a slug does not hide a later one that can", () => {
		const bare = ref("project:in-the-m-de--m", "project", "In the Møde"); // no artist
		const full = ref("project:in-the-m-de--m", "project", "In the Møde", "MØ");
		for (const order of [
			[bare, full],
			[full, bare],
		]) {
			const r = measureSlugTransliteration([{ slug: "artist:x", name: "X", discography: order }]);
			expect(r.mapping, JSON.stringify(order)).toEqual({
				"project:in-the-m-de--m": "project:in-the-mode--mo",
			});
			expect(r.unresolved).toEqual([]);
		}
	});

	test("tries every credited artist of a node for its scope", () => {
		const r = measureSlugTransliteration([
			{
				slug: "track:song--m",
				name: "Song",
				artists: [ref("artist:other", "artist", "Other"), ref("artist:m", "artist", "MØ")],
			},
		]);
		expect(r.mapping["track:song--m"]).toBe("track:song--mo");
	});

	test("flags a new slug that edges already point at, without a node of its own", () => {
		const r = measureSlugTransliteration([
			{ slug: "artist:m", name: "MØ" },
			{ slug: "artist:x", name: "X", collaborators: [ref("artist:mo", "artist", "Mo")] },
		]);
		expect(r.collisions).toHaveLength(1);
		expect(r.collisions[0]?.with).toContain("dangling edge target artist:mo");
	});

	test("prints old and new slug, and the collisions", () => {
		const text = formatReport(report);
		expect(text).toContain("artist:m -> artist:mo");
		expect(text).toContain("collisions: 1");
	});

	test("exposes the old -> new table the migration consumes", () => {
		expect(report.mapping).toEqual({
			"artist:l-titia-sadier": "artist:laetitia-sadier",
			"artist:m": "artist:mo",
			"project:in-the-m-de--m": "project:in-the-mode--mo",
			"project:void": "project:oo-void",
		});
	});

	test("two references that name one old slug differently are a conflict, not a mapping", () => {
		const r = measureSlugTransliteration([
			{ slug: "artist:m", name: "MØ" },
			{ slug: "artist:x", name: "X", collaborators: [ref("artist:m", "artist", "M")] },
		]);
		expect(r.mapping).toEqual({});
		expect(r.conflicts).toEqual([
			{
				slug: "artist:m",
				candidates: [
					{ to: "artist:mo", name: "MØ" },
					{ to: "artist:m", name: "M" },
				],
			},
		]);
	});

	test("reports the keys of pending-reverses.json that the migration must rename", () => {
		const pending = {
			"artist:l-titia-sadier": [{ field: "members", edge: ref("artist:oval", "artist", "Oval") }],
			"artist:oval": [{ field: "members", edge: ref("artist:l-titia-sadier", "artist", "Lætitia Sadier") }],
		};
		const r = measureSlugTransliteration([], pending);
		expect(r.pendingReverses).toEqual([
			{ from: "artist:l-titia-sadier", to: "artist:laetitia-sadier", entries: 1 },
		]);
	});
});

describe("reading the cache", () => {
	test("a missing or empty cache directory is an error, not an empty report", async () => {
		await expect(readNodes(join(tmpdir(), "does-not-exist-tra-528"))).rejects.toThrow(/not a readable/);
		const empty = await mkdtemp(join(tmpdir(), "tra528-"));
		await mkdir(join(empty, "nodes"));
		await expect(readNodes(empty)).rejects.toThrow(/no node found/);
	});

	test("an invalid node file is named in the error; an absent pending-reverses.json is fine", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tra528-"));
		await mkdir(join(dir, "nodes", "artist"), { recursive: true });
		await writeFile(join(dir, "nodes", "artist", "bad.json"), "{nope");
		await expect(readNodes(dir)).rejects.toThrow(/bad\.json/);
		await expect(readPendingReverses(dir)).resolves.toEqual({});
	});
});
