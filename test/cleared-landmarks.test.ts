import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSED_LIST } from "../scripts/migrations/2026-10-24-fix-weak-landmarks.js";
import { clearedKey, loadClearedLandmarks } from "../src/cleared-landmarks.js";

// TRA-674: data/cleared-landmarks.json is the exclusion list read by the pipeline and the 2026-10-19 backfill.
// TRA-605's closed list (the migration that emptied the fields) is the source of truth for what was emptied.

describe("data/cleared-landmarks.json", () => {
	it("holds exactly the pairs TRA-605 emptied, with the pick it removed", () => {
		const emptied = CLOSED_LIST.filter((d) => d.action === "clear");
		const fromMigration = emptied.map((d) => [clearedKey(d.artist, d.field), d.expected]).sort();
		const fromData = [...loadClearedLandmarks()].map(([key, entry]) => [key, entry.rejected]).sort();
		expect(fromData).toEqual(fromMigration);
		expect(fromData).toHaveLength(7);
	});

	it("does not withhold a pair TRA-605 replaced (Caspa now holds a proven album)", () => {
		const replaced = CLOSED_LIST.filter((d) => d.action === "replace");
		expect(replaced.length).toBeGreaterThan(0);
		for (const d of replaced) expect(loadClearedLandmarks().has(clearedKey(d.artist, d.field))).toBe(false);
	});

	it("refuses an invalid file rather than turning the guard off", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cleared-"));
		try {
			const bad = join(dir, "bad.json");
			await writeFile(bad, JSON.stringify({ "artist:a": { landmark_project: { rejected: "" } } }));
			expect(() => loadClearedLandmarks(bad)).toThrow();
			const typo = join(dir, "typo.json");
			await writeFile(
				typo,
				JSON.stringify({ "artist:a": { landmark_projet: { rejected: "x", reason: "y" } } }),
			);
			expect(() => loadClearedLandmarks(typo)).toThrow();
			expect(() => loadClearedLandmarks(join(dir, "missing.json"))).toThrow();
			// A track slug on a project field would never match: refused at load, not silently void.
			const wrongType = join(dir, "wrong-type.json");
			await writeFile(
				wrongType,
				JSON.stringify({ "artist:a": { landmark_project: { rejected: "track:x", reason: "y" } } }),
			);
			expect(() => loadClearedLandmarks(wrongType)).toThrow(/not a project: slug/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
