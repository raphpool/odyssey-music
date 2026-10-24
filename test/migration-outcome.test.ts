import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diffOutcomes, type MigrationOutcome, outcomeOf } from "../scripts/migration-outcome.js";

// TRA-610 (PR 3): what the apply of a job must repeat from its preview. The channel test
// (migration-channel-homonym-work-identity.test.ts) runs the whole script; these are the rules of the comparison.

const OLD = "project:wish-you-were-here--american-hot-wax";
const NEW = "project:wish-you-were-here--pink-floyd";

const outcome = (over: Partial<MigrationOutcome> = {}): MigrationOutcome => ({
	renamed: { [OLD]: NEW },
	removed: ["nodes/track/x.json"],
	redirects: { [OLD]: NEW, "project:wish-you-were-here": NEW },
	...over,
});

describe("diffOutcomes", () => {
	it("is empty for the same outcome, whatever the order of the removals", () => {
		expect(diffOutcomes(outcome(), outcome())).toEqual([]);
		expect(
			diffOutcomes(
				outcome({ removed: ["nodes/a/b.json", "nodes/c/d.json"] }),
				outcome({ removed: ["nodes/c/d.json", "nodes/a/b.json"] }),
			),
		).toEqual([]);
	});

	it("names a rename the apply did not redo, and one it added", () => {
		expect(diffOutcomes(outcome(), outcome({ renamed: {} }))).toEqual([
			`renamed ${OLD} -> ${NEW}: in the preview, not in the apply`,
		]);
		expect(diffOutcomes(outcome({ renamed: {} }), outcome())).toEqual([
			`renamed ${OLD} -> ${NEW}: in the apply, not in the preview`,
		]);
	});

	it("names a rename that went to another slug", () => {
		expect(
			diffOutcomes(outcome(), outcome({ renamed: { [OLD]: "project:wish-you-were-here--roger-waters" } })),
		).toEqual([
			`renamed ${OLD}: ${NEW} in the preview, project:wish-you-were-here--roger-waters in the apply`,
		]);
	});

	it("names a removal and a redirect that differ", () => {
		const diff = diffOutcomes(outcome(), outcome({ removed: [], redirects: { [OLD]: NEW } }));
		expect(diff).toEqual([
			"removed nodes/track/x.json: in the preview, not in the apply",
			`redirects project:wish-you-were-here -> ${NEW}: in the preview, not in the apply`,
		]);
	});

	it("counts a removal listed twice as different from one listed once", () => {
		expect(
			diffOutcomes(
				outcome({ removed: ["nodes/a/b.json"] }),
				outcome({ removed: ["nodes/a/b.json", "nodes/a/b.json"] }),
			),
		).toEqual(["removed nodes/a/b.json: listed 1 time(s) in the preview, 2 in the apply"]);
	});

	it("reads a key like `constructor` as a key, not as a member of Object.prototype", () => {
		const parsed = outcomeOf(
			JSON.parse('{"renamed":{"constructor":"project:b"},"removed":[],"redirects":{}}'),
		);
		if (!parsed.ok) throw new Error(parsed.error);
		expect(diffOutcomes(parsed.value, outcome({ renamed: {}, removed: [], redirects: {} }))).toEqual([
			"renamed constructor -> project:b: in the preview, not in the apply",
		]);
		expect(diffOutcomes(outcome({ renamed: {}, removed: [], redirects: {} }), parsed.value)).toEqual([
			"renamed constructor -> project:b: in the apply, not in the preview",
		]);
	});
});

describe("outcomeOf", () => {
	it("reads only the three fields, whatever else the manifest holds (a conflict's reason is not part of it)", () => {
		const preview = {
			...outcome(),
			conflicts: [{ slug: "project:a", to: "project:b", reason: "target-is-renamed" }],
			summary: { fixed: 1 },
		};
		const apply = {
			...outcome(),
			conflicts: [{ slug: "project:a", to: "project:b", reason: "target-is-a-redirect-key" }],
			summary: { fixed: 0 },
		};
		const [a, b] = [outcomeOf(preview), outcomeOf(apply)];
		expect(a.ok && b.ok && diffOutcomes(a.value, b.value)).toEqual([]);
	});

	it.each([
		["not an object", []],
		["renamed missing", { removed: [], redirects: {} }],
		["renamed holding a non-slug", { renamed: { a: 1 }, removed: [], redirects: {} }],
		["removed not a list", { renamed: {}, removed: "x", redirects: {} }],
		["redirects an array", { renamed: {}, removed: [], redirects: [] }],
	])("refuses a manifest with %s", (_label, manifest) => {
		expect(outcomeOf(manifest).ok).toBe(false);
	});
});

describe("validate-migrated-union.ts compare-outcome", () => {
	const dir = mkdtempSync(join(tmpdir(), "migration-outcome-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const tsx = resolve("node_modules/.bin/tsx");
	const write = (name: string, body: unknown): string => {
		const path = join(dir, name);
		writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
		return path;
	};
	const compare = (a: string, b: string) =>
		spawnSync(tsx, [resolve("scripts/validate-migrated-union.ts"), "compare-outcome", a, b], {
			encoding: "utf8",
		});

	it("exits 0 and says nothing when only a conflict's reason differs", () => {
		const result = compare(
			write("p.json", { ...outcome(), conflicts: [{ reason: "target-is-renamed" }] }),
			write("a.json", { ...outcome(), conflicts: [{ reason: "target-is-a-redirect-key" }] }),
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("exits 1 with the difference when the apply lost a rename", () => {
		const result = compare(write("p2.json", outcome()), write("a2.json", outcome({ renamed: {} })));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`renamed ${OLD} -> ${NEW}: in the preview, not in the apply`);
	});

	it("fails closed on a manifest it cannot read", () => {
		const missing = compare(join(dir, "absent.json"), write("a3.json", outcome()));
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain("the preview manifest");
		const broken = compare(write("p4.json", outcome()), write("a4.json", "{not json"));
		expect(broken.status).toBe(1);
		expect(broken.stderr).toContain("the apply manifest");
	});
});
