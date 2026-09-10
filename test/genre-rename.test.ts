import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs, runRename } from "../scripts/migrations/2026-09-10-rename-genre-node.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

// Nodes here are plain records, not typed against src/types.ts: readCacheNodes reads raw JSON
// (no Zod), and rewriteNodeEdges/the invariant checks skip any edge field that isn't present
// -- so only the fields each test actually exercises need to exist, same latitude the pure
// functions themselves rely on.
type RawNode = Record<string, unknown>;

function node(overrides: RawNode & { slug: string; type: string }): RawNode {
	return {
		name: "Test",
		editorial_article: "An article.",
		citations: [],
		materialized_at: new Date().toISOString(),
		...overrides,
	};
}

const FROM = "genre:trap" as Slug;
const TO = "genre:edm-trap" as Slug;

describe("runRename (disk integration)", () => {
	let dir: string;
	let redirectsPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-genre-rename-"));
		redirectsPath = join(dir, "genre-redirects.json");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeNodeFile(n: RawNode): Promise<string> {
		const { type, body } = parseSlug(n.slug as string);
		const path = join(dir, "nodes", type, `${body}.json`);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(n, null, 2)}\n`, "utf8");
		return path;
	}

	// Mirrors the real cache's incoming genre:trap edges (per the ticket): a label and a
	// project still denormalize the stale pre-TRA-33 qid, an artist carries no qid at all and
	// must be left that way rather than backfilled.
	async function seedTrapGroup() {
		const fromPath = await writeNodeFile(
			node({ slug: FROM, type: "genre", name: "Trap (EDM)", qid: "Q47781397", related_genres: [] }),
		);
		const staleLabelPath = await writeNodeFile(
			node({
				slug: "label:never-say-die",
				type: "label",
				genres: [{ slug: FROM, type: "genre", name: "Trap", qid: "Q2913982" }],
			}),
		);
		const staleProjectPath = await writeNodeFile(
			node({
				slug: "project:every-dog-has-its-day",
				type: "project",
				genres: [{ slug: FROM, type: "genre", name: "Trap", qid: "Q2913982" }],
			}),
		);
		const noQidPath = await writeNodeFile(
			node({
				slug: "artist:skrillex",
				type: "artist",
				genres: [{ slug: FROM, type: "genre", name: "Trap (EDM)" }],
			}),
		);
		return { fromPath, staleLabelPath, staleProjectPath, noQidPath };
	}

	it("dry-run computes the plan but leaves every file byte-identical", async () => {
		const paths = await seedTrapGroup();
		const before = await Promise.all(Object.values(paths).map((p) => readFile(p, "utf8")));

		const result = await runRename(dir, FROM, TO, false, { redirectsPath, onboardingSlugs: [] });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(false);
		expect(result.report).toContain("DRY RUN");
		const after = await Promise.all(Object.values(paths).map((p) => readFile(p, "utf8")));
		expect(after).toEqual(before);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("--apply moves the node, rewrites incoming edges with an aligned qid, pending-reverses, and the redirect", async () => {
		const { fromPath, staleLabelPath, staleProjectPath, noQidPath } = await seedTrapGroup();
		const pendingPath = join(dir, "pending-reverses.json");
		await writeFile(
			pendingPath,
			JSON.stringify({
				[FROM]: [
					{
						field: "key_labels",
						cardinality: "list",
						edge: { slug: "label:pending-label", type: "label", name: "Pending Label" },
					},
				],
			}),
			"utf8",
		);

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [] });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(true);
		expect(result.report).not.toContain("DRY RUN");
		expect(result.report).toContain("Denormalized qids fixed:2");

		await expect(readFile(fromPath, "utf8")).rejects.toThrow();
		const toPath = join(dir, "nodes", "genre", "edm-trap.json");
		const moved = JSON.parse(await readFile(toPath, "utf8")) as RawNode;
		expect(moved.slug).toBe(TO);
		expect(moved.name).toBe("Trap (EDM)");
		expect(moved.qid).toBe("Q47781397");

		// Both stale qids get corrected to the node's own qid.
		for (const path of [staleLabelPath, staleProjectPath]) {
			const n = JSON.parse(await readFile(path, "utf8")) as RawNode;
			expect(n.genres).toEqual([{ slug: TO, type: "genre", name: "Trap", qid: "Q47781397" }]);
		}
		// An edge that never carried a qid is rewritten (slug only) but not backfilled with one.
		const noQid = JSON.parse(await readFile(noQidPath, "utf8")) as RawNode;
		expect(noQid.genres).toEqual([{ slug: TO, type: "genre", name: "Trap (EDM)" }]);

		const pending = JSON.parse(await readFile(pendingPath, "utf8")) as Record<string, unknown>;
		expect(pending[FROM]).toBeUndefined();
		expect(pending[TO]).toBeDefined();

		const redirects = JSON.parse(await readFile(redirectsPath, "utf8")) as {
			redirects: Record<string, string>;
		};
		expect(redirects.redirects).toEqual({ [FROM]: TO });
	});

	it("flattens a chain when `from` is already the target of an existing redirect", async () => {
		await seedTrapGroup();
		await writeFile(redirectsPath, JSON.stringify({ redirects: { "genre:trap-edm-alt": FROM } }), "utf8");

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [] });

		expect(result.exitCode).toBe(0);
		const redirects = JSON.parse(await readFile(redirectsPath, "utf8")) as {
			redirects: Record<string, string>;
		};
		expect(redirects.redirects).toEqual({ "genre:trap-edm-alt": TO, [FROM]: TO });
	});

	it("`to` already existing exits 1 without writing anything", async () => {
		const { fromPath } = await seedTrapGroup();
		const toPath = await writeNodeFile(node({ slug: TO, type: "genre", name: "EDM Trap" }));
		const before = { from: await readFile(fromPath, "utf8"), to: await readFile(toPath, "utf8") };

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [] });

		expect(result.exitCode).toBe(1);
		expect(await readFile(fromPath, "utf8")).toBe(before.from);
		expect(await readFile(toPath, "utf8")).toBe(before.to);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("a second --apply is a no-op (idempotent)", async () => {
		await seedTrapGroup();
		const first = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [] });
		expect(first.exitCode).toBe(0);
		expect(first.applied).toBe(true);

		const toPath = join(dir, "nodes", "genre", "edm-trap.json");
		const before = await readFile(toPath, "utf8");
		const redirectsBefore = await readFile(redirectsPath, "utf8");

		const second = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [] });

		expect(second.exitCode).toBe(0);
		expect(second.applied).toBe(false);
		expect(await readFile(toPath, "utf8")).toBe(before);
		expect(await readFile(redirectsPath, "utf8")).toBe(redirectsBefore);
	});

	it("exits 1 when the source doesn't exist, and passes the onboarding check when it does (redirect target alive)", async () => {
		const missing = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [] });
		expect(missing.exitCode).toBe(1);

		await seedTrapGroup();
		const ok = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [FROM] });
		expect(ok.exitCode).toBe(0);
	});
});

describe("parseCliArgs", () => {
	it("rejects a missing positional", () => {
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["cache"])).toBeNull();
		expect(parseCliArgs(["cache", "genre:trap"])).toBeNull();
	});

	it("rejects a flag standing in for any positional", () => {
		expect(parseCliArgs(["--apply", "genre:trap", "genre:edm-trap"])).toBeNull();
		expect(parseCliArgs(["cache", "--apply", "genre:edm-trap"])).toBeNull();
	});

	it("parses the three positionals, --apply, and an optional --redirects path", () => {
		expect(parseCliArgs(["cache", "genre:trap", "genre:edm-trap"])).toEqual({
			cacheDir: "cache",
			from: "genre:trap",
			to: "genre:edm-trap",
			apply: false,
		});
		expect(parseCliArgs(["cache", "genre:trap", "genre:edm-trap", "--apply"])).toEqual({
			cacheDir: "cache",
			from: "genre:trap",
			to: "genre:edm-trap",
			apply: true,
		});
		expect(
			parseCliArgs(["cache", "genre:trap", "genre:edm-trap", "--redirects", "data/genre-redirects.json"]),
		).toEqual({
			cacheDir: "cache",
			from: "genre:trap",
			to: "genre:edm-trap",
			apply: false,
			redirectsPath: "data/genre-redirects.json",
		});
	});

	it("rejects --redirects with no path, a path that's actually another flag, an unrecognized flag, a stray extra positional, or a repeated flag", () => {
		expect(parseCliArgs(["cache", "genre:trap", "genre:edm-trap", "--redirects"])).toBeNull();
		expect(parseCliArgs(["cache", "genre:trap", "genre:edm-trap", "--redirects", "--apply"])).toBeNull();
		expect(parseCliArgs(["cache", "genre:trap", "genre:edm-trap", "--dry-run"])).toBeNull();
		expect(
			parseCliArgs(["cache", "genre:trap", "genre:edm-trap", "data/genre-redirects.json", "--apply"]),
		).toBeNull();
		expect(
			parseCliArgs([
				"cache",
				"genre:trap",
				"genre:edm-trap",
				"--redirects",
				"a.json",
				"--redirects",
				"b.json",
			]),
		).toBeNull();
	});
});
