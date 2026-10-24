import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// TRA-570 acceptance, on the committed cache: the 1993 UK EP is no longer credited to the Long Island band,
// and the band no longer lists it (discography, landmark). TRA-485 then removed the EP, which had no other credit.

type Obj = Record<string, unknown>;
const read = (path: string): Obj =>
	JSON.parse(readFileSync(join(resolve("cache"), "nodes", path), "utf8")) as Obj;
const slugs = (value: unknown): string[] =>
	(Array.isArray(value) ? value : value ? [value] : []).map((e) => (e as Obj).slug as string);

describe("artist:inside and project:the-ep--inside in the committed cache", () => {
	it("the band no longer lists the EP, as discography entry or as landmark", () => {
		const band = read("artist/inside.json");
		expect(slugs(band.discography)).not.toContain("project:the-ep--inside");
		expect(slugs(band.notable_tracks)).not.toContain("project:the-ep--inside");
		expect(slugs(band.landmark_project)).toEqual([]);
	});

	it("the EP is gone: it kept no credit once the band's was detached, and TRA-485 removed it (nothing links to it)", () => {
		expect(() => read("project/the-ep--inside.json")).toThrow(/ENOENT/);
	});
});
