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
		const calls = [...sources("src"), ...sources("scripts")].flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(/createGenreRegistry\(\{[^}]*\}\)/g)].map((m) => ({
				file,
				text: m[0],
			})),
		);
		// server.ts, crawler.ts, top-up-dangling.ts, top-up-genres.ts
		expect(calls.map((c) => c.file).sort()).toEqual([
			join("scripts", "top-up-dangling.ts"),
			join("scripts", "top-up-genres.ts"),
			join("src", "crawler.ts"),
			join("src", "server.ts"),
		]);
		for (const call of calls) expect(call.text, call.file).toMatch(/\blabels\b/);
	});
});
