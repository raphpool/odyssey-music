import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findLostTaxonomyResolutions,
	parseCliArgs,
	runRename,
} from "../scripts/migrations/2026-09-10-rename-genre-node.js";
import type { GenreTaxonomy, GenreTaxonomyEntry } from "../src/genre-taxonomy.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

// A minimal, schema-valid v2 taxonomy wrapping a single genre entry -- used by the D6b tests
// below. Kept to one family/one genre so assertUnique (ids, family keys/orders, qids) never
// collides across tests, each of which builds its own independent taxonomy.
function taxonomyOf(genre: GenreTaxonomyEntry): GenreTaxonomy {
	return {
		version: 2,
		families: [{ key: "test-family", label: "Test Family", order: 0 }],
		genres: [genre],
	};
}

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
	// Deliberately never written unless a test says so: loadTaxonomyOrStatus then reports
	// "absent", so pre-existing tests (which don't care about the D6b taxonomy guard) keep
	// exercising only the v1 ONBOARDING_GENRES guard, exactly as before this ticket.
	let taxonomyPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-genre-rename-"));
		redirectsPath = join(dir, "genre-redirects.json");
		taxonomyPath = join(dir, "genre-taxonomy.json");
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

		const result = await runRename(dir, FROM, TO, false, {
			redirectsPath,
			onboardingSlugs: [],
			taxonomyPath,
		});

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

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

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

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

		expect(result.exitCode).toBe(0);
		const redirects = JSON.parse(await readFile(redirectsPath, "utf8")) as {
			redirects: Record<string, string>;
		};
		expect(redirects.redirects).toEqual({ "genre:trap-edm-alt": TO, [FROM]: TO });
	});

	it("`to` already existing -- as a node, or as a live redirect source -- exits 1 without writing", async () => {
		const { fromPath } = await seedTrapGroup();
		const toPath = await writeNodeFile(node({ slug: TO, type: "genre", name: "EDM Trap" }));
		const before = { from: await readFile(fromPath, "utf8"), to: await readFile(toPath, "utf8") };

		const nodeConflict = await runRename(dir, FROM, TO, true, {
			redirectsPath,
			onboardingSlugs: [],
			taxonomyPath,
		});
		expect(nodeConflict.exitCode).toBe(1);
		expect(await readFile(fromPath, "utf8")).toBe(before.from);
		expect(await readFile(toPath, "utf8")).toBe(before.to);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();

		// `to` as a redirect *source* (not a node) is just as broken: applying would leave a
		// live node at `to` while the table still says `to` itself redirects elsewhere.
		await rm(toPath);
		await writeFile(redirectsPath, JSON.stringify({ redirects: { [TO]: "genre:gone" } }), "utf8");
		const redirectConflict = await runRename(dir, FROM, TO, true, {
			redirectsPath,
			onboardingSlugs: [],
			taxonomyPath,
		});
		expect(redirectConflict.exitCode).toBe(1);
		expect(await readFile(fromPath, "utf8")).toBe(before.from);
	});

	it("a second --apply is a no-op (idempotent)", async () => {
		await seedTrapGroup();
		const first = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });
		expect(first.exitCode).toBe(0);
		expect(first.applied).toBe(true);

		const toPath = join(dir, "nodes", "genre", "edm-trap.json");
		const before = await readFile(toPath, "utf8");
		const redirectsBefore = await readFile(redirectsPath, "utf8");

		const second = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

		expect(second.exitCode).toBe(0);
		expect(second.applied).toBe(false);
		expect(await readFile(toPath, "utf8")).toBe(before);
		expect(await readFile(redirectsPath, "utf8")).toBe(redirectsBefore);
	});

	it("a missing source exits 1; an ONBOARDING_GENRES slug is refused outright, tree unchanged", async () => {
		const missing = await runRename(dir, FROM, TO, true, {
			redirectsPath,
			onboardingSlugs: [],
			taxonomyPath,
		});
		expect(missing.exitCode).toBe(1);

		const paths = await seedTrapGroup();
		const before = await Promise.all(Object.values(paths).map((p) => readFile(p, "utf8")));

		const result = await runRename(dir, FROM, TO, true, {
			redirectsPath,
			onboardingSlugs: [FROM],
			taxonomyPath,
		});

		expect(result.exitCode).toBe(1);
		expect(result.applied).toBe(false);
		const after = await Promise.all(Object.values(paths).map((p) => readFile(p, "utf8")));
		expect(after).toEqual(before);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});
});

// TRA-139/D6b: the taxonomy (v2) guard, additive to (and eventually a replacement for) the
// ONBOARDING_GENRES (v1) check exercised above.
describe("runRename -- genre-taxonomy protection (D6b)", () => {
	let dir: string;
	let redirectsPath: string;
	let taxonomyPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-genre-rename-taxonomy-"));
		redirectsPath = join(dir, "genre-redirects.json");
		taxonomyPath = join(dir, "genre-taxonomy.json");
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

	async function seedTrapNode(): Promise<void> {
		await writeNodeFile(
			node({ slug: FROM, type: "genre", name: "Trap (EDM)", qid: "Q47781397", related_genres: [] }),
		);
	}

	it("admits a safe rename: a published genre's explicit source still resolves via the redirect", async () => {
		await seedTrapNode();
		await writeFile(
			taxonomyPath,
			JSON.stringify(
				taxonomyOf({
					id: "Q47781397",
					qid: "Q47781397",
					name: "Trap (EDM)",
					family: "test-family",
					sourceSlugs: [FROM],
					published: true,
				}),
			),
			"utf8",
		);

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(true);
	});

	it("refuses a rename that would lose resolution for a published genre's source", async () => {
		await seedTrapNode();
		await writeFile(
			taxonomyPath,
			JSON.stringify(
				taxonomyOf({
					id: "local:ghost-genre",
					name: "Ghost Genre",
					family: "test-family",
					sourceSlugs: ["genre:ghost" as Slug],
					published: true,
				}),
			),
			"utf8",
		);

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

		expect(result.exitCode).toBe(1);
		expect(result.applied).toBe(false);
		await expect(readFile(join(dir, "nodes", "genre", "edm-trap.json"), "utf8")).rejects.toThrow();
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("keeps a family-umbrella genre resolved by qid (no explicit sourceSlugs) findable after the rename", async () => {
		await seedTrapNode();
		await writeFile(
			taxonomyPath,
			JSON.stringify(
				taxonomyOf({
					id: "Q47781397",
					qid: "Q47781397",
					name: "Trap (EDM) Umbrella",
					family: "test-family",
					published: true,
				}),
			),
			"utf8",
		);

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(true);
	});

	it("resolves a local-id entry whose sourceSlugs point at the renamed slug", async () => {
		await seedTrapNode();
		await writeFile(
			taxonomyPath,
			JSON.stringify(
				taxonomyOf({
					id: "local:something-local",
					name: "Something Local",
					family: "test-family",
					sourceSlugs: [FROM],
					published: true,
				}),
			),
			"utf8",
		);

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(true);
	});

	it("refuses outright when neither the taxonomy nor ONBOARDING_GENRES is available", async () => {
		await seedTrapNode();
		// taxonomyPath and webIndexPath both point at files that don't exist -- onboardingSlugs
		// is left undefined so the real (in this run, unread) web/index.html is never consulted.
		const result = await runRename(dir, FROM, TO, true, {
			redirectsPath,
			taxonomyPath,
			webIndexPath: join(dir, "no-such-index.html"),
		});

		expect(result.exitCode).toBe(1);
		expect(result.applied).toBe(false);
		expect(result.report).not.toContain("DRY RUN"); // (an applied=false run, but not the empty-check silently passing)
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("refuses outright on an invalid taxonomy, even with ONBOARDING_GENRES present", async () => {
		await seedTrapNode();
		await writeFile(
			taxonomyPath,
			JSON.stringify({ version: 2, families: [], genres: "not-an-array" }),
			"utf8",
		);

		const result = await runRename(dir, FROM, TO, true, { redirectsPath, onboardingSlugs: [], taxonomyPath });

		expect(result.exitCode).toBe(1);
		expect(result.applied).toBe(false);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});
});

describe("findLostTaxonomyResolutions (pure)", () => {
	it("flags a published entry whose source neither exists nor redirects anywhere", () => {
		const taxonomy = taxonomyOf({
			id: "local:ghost-genre",
			name: "Ghost Genre",
			family: "test-family",
			sourceSlugs: ["genre:ghost" as Slug],
			published: true,
		});
		const errors = findLostTaxonomyResolutions(taxonomy, [], new Map());
		expect(errors).toHaveLength(1);
		expect(errors[0]?.genreId).toBe("local:ghost-genre");
	});

	it("ignores an unpublished (reserve) entry with the same dangling source", () => {
		const taxonomy = taxonomyOf({
			id: "local:ghost-genre",
			name: "Ghost Genre",
			family: "test-family",
			sourceSlugs: ["genre:ghost" as Slug],
			published: false,
		});
		expect(findLostTaxonomyResolutions(taxonomy, [], new Map())).toEqual([]);
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
