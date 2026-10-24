import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// TRA-485 (data PR) acceptance, on the committed cache: the works no credit could be proven for are gone with every
// edge to them, the ones MusicBrainz proved are credited, and the ceiling of `empty-artists` is the measure.

type Obj = Record<string, unknown>;
const cache = resolve("cache");
const slugsFile = JSON.parse(
	readFileSync(resolve("scripts/migrations/2026-10-24-remove-uncredited-releases.slugs.json"), "utf8"),
) as { slugs: { slug: string }[] };
const removed = slugsFile.slugs.map((s) => s.slug);
const nodePath = (slug: string) => {
	const i = slug.indexOf(":");
	return join(cache, "nodes", slug.slice(0, i), `${slug.slice(i + 1)}.json`);
};
const readAll = (type: string): Obj[] =>
	readdirSync(join(cache, "nodes", type)).map(
		(f) => JSON.parse(readFileSync(join(cache, "nodes", type, f), "utf8")) as Obj,
	);

describe("the committed cache after the removal of the uncredited works", () => {
	it("holds none of the removed works, and no edge to one", () => {
		for (const slug of removed) expect(() => readFileSync(nodePath(slug), "utf8"), slug).toThrow();
		const gone = new Set(removed);
		const all = ["artist", "project", "track", "genre", "label"].flatMap(readAll);
		const dangling = all.flatMap((node) =>
			Object.entries(node).flatMap(([field, value]) =>
				(Array.isArray(value) ? value : [value])
					.filter((e): e is Obj => typeof e === "object" && e !== null && gone.has(String((e as Obj).slug)))
					.map((e) => `${String(node.slug)}.${field} -> ${String((e as Obj).slug)}`),
			),
		);
		expect(dangling).toEqual([]);
	});

	it("credits Blues for the Red Sun to Kyuss, as MusicBrainz does, with the work's mbid", () => {
		const work = JSON.parse(readFileSync(nodePath("project:blues-for-the-red-sun"), "utf8")) as Obj;
		expect((work.artists as Obj[]).map((a) => a.name)).toEqual(["Kyuss"]);
		expect(work.mbid).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("has exactly as many uncredited works as the ceiling of the audit says", () => {
		const thresholds = JSON.parse(readFileSync(resolve("data/integrity-thresholds.json"), "utf8")) as {
			"empty-artists": Record<string, number>;
		};
		for (const type of ["project", "track"]) {
			const empty = readAll(type).filter((n) => Array.isArray(n.artists) && n.artists.length === 0);
			expect(empty.length, type).toBe(thresholds["empty-artists"][type]);
		}
	});
});
