import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// TRA-607: `labels` is an optional field of createGenreRegistry, and leaving it out silently brings label
// duplicates back (the review of this ticket found scripts/top-up-genres.ts doing exactly that). Every
// production call must pass it, from loadLabelRegistry.
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "migrations" ? [] : sources(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("label registry wiring (TRA-607)", () => {
	it("passes `labels` at every createGenreRegistry call of src/ and scripts/", () => {
		const files = [...sources("src"), ...sources("scripts")].filter(
			(f) => f !== join("src", "genre-registry.ts"),
		);
		const found = files.flatMap((file) => {
			const source = readFileSync(file, "utf8");
			// Every call, whatever its argument: one that is not an object literal cannot be checked, so it fails.
			const all = [...source.matchAll(/createGenreRegistry\(/g)];
			const literal = [...source.matchAll(/createGenreRegistry\(\{[^}]*\}\)/g)].map((m) => m[0]);
			return all.length === 0 ? [] : [{ file, calls: all.length, literal }];
		});
		// server.ts, crawler.ts, top-up-dangling.ts, top-up-genres.ts
		expect(found.map((f) => f.file).sort()).toEqual([
			join("scripts", "top-up-dangling.ts"),
			join("scripts", "top-up-genres.ts"),
			join("src", "crawler.ts"),
			join("src", "server.ts"),
		]);
		for (const { file, calls, literal } of found) {
			expect(literal.length, `${file}: a createGenreRegistry call is not an object literal`).toBe(calls);
			// `labels` as a shorthand or a value, never `labels: undefined`.
			for (const text of literal) expect(text, file).toMatch(/\blabels\b(?!\s*:\s*undefined)/);
		}
	});
});
