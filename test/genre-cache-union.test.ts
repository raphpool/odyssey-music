import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCacheUnion,
	countUnionProblems,
	decideSameIdentity,
	diffGenreRedirects,
	slugResolves,
	type UnionManifest,
} from "../scripts/prepare-genre-cache-union.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

describe("decideSameIdentity", () => {
	it("decides which side wins on materialized_at (repo wins a tie, flags a qid known on only one side), and refuses a qid conflict or an unusable timestamp", () => {
		const cases: [Record<string, unknown>, Record<string, unknown>, unknown][] = [
			[{ materialized_at: "2026-02-01" }, { materialized_at: "2026-01-01" }, { from: "repo", tie: false }],
			[{ materialized_at: "2026-01-01" }, { materialized_at: "2026-02-01" }, { from: "server", tie: false }],
			[{ materialized_at: "2026-01-01" }, { materialized_at: "2026-01-01" }, { from: "repo", tie: true }],
			[
				{ qid: "Q1", materialized_at: "2026-01-01" },
				{ materialized_at: "2026-01-01" },
				{ from: "repo", tie: true, qidOnlyOn: "repo" },
			],
			[{ qid: "Q1", materialized_at: "x" }, { qid: "Q2", materialized_at: "x" }, { reason: "qid" }],
			[{ materialized_at: "bad" }, { materialized_at: "2026-01-01" }, { reason: "timestamp" }],
		];
		for (const [repo, server, expected] of cases) expect(decideSameIdentity(repo, server)).toEqual(expected);
	});
});

function manifest(overrides: Partial<UnionManifest> = {}): UnionManifest {
	return {
		generatedAt: "x",
		repoCacheDir: "r",
		serverCacheDir: "s",
		entries: [],
		skipped: [],
		migrationPreview: { groupsFound: 0, exitCode: 0, report: "" },
		...overrides,
	};
}

describe("slugResolves", () => {
	it("resolves a live slug directly, a redirect only when its target is live, and nothing else", () => {
		const live = new Set<Slug>(["genre:country"]);
		const redirects = new Map<Slug, Slug>([["genre:country-music", "genre:country"]]);
		expect(slugResolves("genre:country", live, redirects)).toBe(true);
		expect(slugResolves("genre:country-music", live, redirects)).toBe(true);
		expect(slugResolves("genre:never-materialized", live, redirects)).toBe(false);
		const danglingRedirect = new Map<Slug, Slug>([["genre:x", "genre:gone"]]);
		expect(slugResolves("genre:x", live, danglingRedirect)).toBe(false);
	});
});

describe("diffGenreRedirects", () => {
	it("flags a same-source entry that diverges, and an exact reversal, but never an entry present on only one side", () => {
		const repo = new Map<Slug, Slug>([
			["genre:country-music", "genre:country"],
			["genre:electronic-music", "genre:electronic"],
			["genre:idm-alt", "genre:idm"],
			["genre:repo-only", "genre:repo-only-target"],
		]);
		const server = new Map<Slug, Slug>([
			// Same loser, different canonical target than the repo -- the "wrong winner" case.
			["genre:country-music", "genre:country-and-western"],
			// No divergence: identical entry on both sides.
			["genre:electronic-music", "genre:electronic"],
			// Exact reversal of the repo's genre:idm-alt -> genre:idm.
			["genre:idm", "genre:idm-alt"],
			["genre:server-only", "genre:server-only-target"],
		]);

		expect(diffGenreRedirects(repo, server)).toEqual(
			expect.arrayContaining([
				{
					reason: "diverged-target",
					repoFrom: "genre:country-music",
					repoTo: "genre:country",
					serverFrom: "genre:country-music",
					serverTo: "genre:country-and-western",
				},
				{
					reason: "inverted-pair",
					repoFrom: "genre:idm-alt",
					repoTo: "genre:idm",
					serverFrom: "genre:idm",
					serverTo: "genre:idm-alt",
				},
			]),
		);
		expect(diffGenreRedirects(repo, server)).toHaveLength(2);
	});

	it("is empty for identical tables and for two tables with no overlapping keys", () => {
		const table = new Map<Slug, Slug>([["genre:country-music", "genre:country"]]);
		expect(diffGenreRedirects(table, new Map(table))).toEqual([]);
		expect(diffGenreRedirects(table, new Map())).toEqual([]);
		expect(diffGenreRedirects(new Map(), table)).toEqual([]);
	});
});

describe("countUnionProblems", () => {
	it("is 0 for a healthy union and for a qid kept by its own bearer, non-zero for a conflict, a skipped file, or a qid dropped by the losing side", () => {
		expect(countUnionProblems(manifest())).toBe(0);
		expect(
			countUnionProblems(manifest({ entries: [{ decision: "conflict", slug: "genre:x", reason: "qid" }] })),
		).toBeGreaterThan(0);
		expect(
			countUnionProblems(manifest({ skipped: [{ source: "repo", path: "p", error: "e" }] })),
		).toBeGreaterThan(0);
		expect(
			countUnionProblems(
				manifest({
					entries: [{ decision: "kept", from: "repo", slug: "genre:x", tie: false, qidOnlyOn: "repo" }],
				}),
			),
		).toBe(0);
		expect(
			countUnionProblems(
				manifest({
					entries: [{ decision: "kept", from: "repo", slug: "genre:x", tie: false, qidOnlyOn: "server" }],
				}),
			),
		).toBeGreaterThan(0);
	});

	// Isolates referenceRegressions's own contribution: no conflict, no dropped qid, nothing else
	// wrong -- only a non-empty referenceRegressions should make this non-zero.
	it("is non-zero for referenceRegressions alone, with no conflict and a healthy entries list", () => {
		expect(
			countUnionProblems(
				manifest({
					entries: [{ decision: "copied", from: "repo", slug: "genre:x" }],
					referenceRegressions: [{ slug: "genre:gone", resolvedIn: ["server"] }],
				}),
			),
		).toBeGreaterThan(0);
	});

	// Isolates redirectsConflicts's own contribution -- see PR #213 review / diffGenreRedirects.
	it("is non-zero for redirectsConflicts alone, with no conflict and a healthy entries list", () => {
		expect(
			countUnionProblems(
				manifest({
					entries: [{ decision: "copied", from: "repo", slug: "genre:x" }],
					redirectsConflicts: [
						{
							reason: "diverged-target",
							repoFrom: "genre:country-music",
							repoTo: "genre:country",
							serverFrom: "genre:country-music",
							serverTo: "genre:country-and-western",
						},
					],
				}),
			),
		).toBeGreaterThan(0);
	});
});

function node(overrides: Partial<Record<string, unknown>> & { slug: string }): Record<string, unknown> {
	return { type: "genre", name: "Test", materialized_at: "2026-01-01T00:00:00.000Z", ...overrides };
}

function raw(n: Record<string, unknown>): string {
	return JSON.stringify(n);
}

async function seed(dir: string, n: Record<string, unknown>): Promise<void> {
	const { type, body } = parseSlug(n.slug as string);
	const path = join(dir, "nodes", type, `${body}.json`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, raw(n), "utf8");
}

/** Content fingerprint of an entire directory tree -- catches an added/removed/modified file
 * that comparing a few named paths would miss. Entries sorted for a deterministic hash. */
async function fingerprint(dir: string, sub = ""): Promise<string> {
	const hash = createHash("sha256");
	const entries = (await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])).sort((a, b) =>
		a.name < b.name ? -1 : 1,
	);
	for (const e of entries) {
		const rel = sub ? `${sub}/${e.name}` : e.name;
		hash.update(e.isDirectory() ? await fingerprint(dir, rel) : await readFile(join(dir, rel)));
	}
	return hash.digest("hex");
}

describe("buildCacheUnion", () => {
	let repoDir: string;
	let serverDir: string;
	let redirectsPath: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), "odyssey-union-repo-"));
		serverDir = await mkdtemp(join(tmpdir(), "odyssey-union-server-"));
		redirectsPath = join(await mkdtemp(join(tmpdir(), "odyssey-union-data-")), "genre-redirects.json");
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:country-music": "genre:country" } }),
			"utf8",
		);
	});
	afterEach(async () => {
		await rm(repoDir, { recursive: true, force: true });
		await rm(serverDir, { recursive: true, force: true });
	});

	function union(
		extra: { applyMerge?: boolean; onboardingSlugs?: readonly string[]; serverRedirectsPath?: string } = {},
	) {
		return buildCacheUnion(repoDir, serverDir, { redirectsPath, onboardingSlugs: [], ...extra });
	}

	it("copies a slug present on only one side, byte-identical", async () => {
		const onlyRepo = node({ slug: "genre:only-repo" });
		const onlyServer = node({ slug: "genre:only-server" });
		await seed(repoDir, onlyRepo);
		await seed(serverDir, onlyServer);

		const { outputDir, manifest } = await union();
		expect(manifest.entries).toEqual(
			expect.arrayContaining([
				{ decision: "copied", from: "repo", slug: "genre:only-repo" },
				{ decision: "copied", from: "server", slug: "genre:only-server" },
			]),
		);
		expect(await readFile(join(outputDir, "nodes", "genre", "only-repo.json"), "utf8")).toBe(raw(onlyRepo));
	});

	it("keeps the newer materialized_at for an identical slug/qid; repo wins an exact tie", async () => {
		await seed(repoDir, node({ slug: "genre:dup", qid: "Q1", materialized_at: "2026-02-01T00:00:00.000Z" }));
		await seed(
			serverDir,
			node({ slug: "genre:dup", qid: "Q1", materialized_at: "2026-01-01T00:00:00.000Z" }),
		);
		await seed(repoDir, node({ slug: "genre:tie", qid: "Q2" }));
		await seed(serverDir, node({ slug: "genre:tie", qid: "Q2" }));

		const { manifest } = await union();
		expect(manifest.entries).toEqual(
			expect.arrayContaining([
				{ decision: "kept", from: "repo", slug: "genre:dup", tie: false },
				{ decision: "kept", from: "repo", slug: "genre:tie", tie: true },
			]),
		);
	});

	it("refuses a qid conflict: nothing written to the union, both variants archived", async () => {
		await seed(repoDir, node({ slug: "genre:conflict", qid: "Q1" }));
		await seed(serverDir, node({ slug: "genre:conflict", qid: "Q2" }));

		const { outputDir, manifest } = await union();
		expect(manifest.entries).toEqual([{ decision: "conflict", slug: "genre:conflict", reason: "qid" }]);
		await expect(readFile(join(outputDir, "nodes", "genre", "conflict.json"), "utf8")).rejects.toThrow();
		expect(await readFile(join(outputDir, "archive", "repo", "genre", "conflict.json"), "utf8")).toBeTruthy();
		expect(
			await readFile(join(outputDir, "archive", "server", "genre", "conflict.json"), "utf8"),
		).toBeTruthy();
	});

	it("refuses an unusable timestamp rather than guessing", async () => {
		await seed(repoDir, node({ slug: "genre:bad-ts", qid: "Q1", materialized_at: "not-a-date" }));
		await seed(serverDir, node({ slug: "genre:bad-ts", qid: "Q1" }));

		const { manifest } = await union();
		expect(manifest.entries).toEqual([{ decision: "conflict", slug: "genre:bad-ts", reason: "timestamp" }]);
	});

	it("skips an unreadable node file, records it in manifest.skipped, and still unions the rest", async () => {
		await seed(repoDir, node({ slug: "genre:only-repo" }));
		const brokenPath = join(repoDir, "nodes", "genre", "broken.json");
		await mkdir(dirname(brokenPath), { recursive: true });
		await writeFile(brokenPath, "{not valid json", "utf8");

		const { manifest } = await union();
		expect(manifest.skipped).toEqual([{ source: "repo", path: brokenPath, error: expect.any(String) }]);
		expect(manifest.entries).toEqual([{ decision: "copied", from: "repo", slug: "genre:only-repo" }]);
	});

	it("copies genre:country-music and genre:country as two separate slugs, leaving the duplicate-merge migration's PREVIEW to flag the group -- and never touches either source or the source redirects file", async () => {
		await seed(
			repoDir,
			node({ slug: "genre:country-music", qid: "Q1", materialized_at: "2026-01-01T00:00:00.000Z" }),
		);
		await seed(
			serverDir,
			node({ slug: "genre:country", qid: "Q1", materialized_at: "2026-02-01T00:00:00.000Z" }),
		);
		const repoFingerprintBefore = await fingerprint(repoDir);
		const serverFingerprintBefore = await fingerprint(serverDir);
		const redirectsBefore = await readFile(redirectsPath, "utf8");

		const { outputDir, manifest } = await union();
		expect(manifest.entries).toEqual(
			expect.arrayContaining([
				{ decision: "copied", from: "repo", slug: "genre:country-music" },
				{ decision: "copied", from: "server", slug: "genre:country" },
			]),
		);
		expect(manifest.migrationPreview?.groupsFound).toBe(1);
		expect(manifest.migrationPreview?.exitCode).toBe(0);
		// Preview only: neither slug is deleted from the union artifact.
		expect(await readFile(join(outputDir, "nodes", "genre", "country-music.json"), "utf8")).toBeTruthy();
		expect(await readFile(join(outputDir, "nodes", "genre", "country.json"), "utf8")).toBeTruthy();

		expect(await fingerprint(repoDir)).toBe(repoFingerprintBefore);
		expect(await fingerprint(serverDir)).toBe(serverFingerprintBefore);
		expect(await readFile(redirectsPath, "utf8")).toBe(redirectsBefore);
	});

	// PR #213 review (B6a-2): a real duplicate group where the server already elected a
	// different winner than the repo's redirect table must be refused explicitly, not silently
	// resolved by only ever reading the committed table -- see diffGenreRedirects.
	it("refuses when the server's own redirects table diverges from the repo's, with the reason in the manifest -- and never when serverRedirectsPath is omitted", async () => {
		const serverRedirectsPath = join(
			await mkdtemp(join(tmpdir(), "odyssey-union-server-data-")),
			"genre-redirects.json",
		);
		await writeFile(
			serverRedirectsPath,
			// Same loser (genre:country-music) as redirectsPath's table, but a different winner --
			// the server already resolved this duplicate group differently than the repo.
			JSON.stringify({ redirects: { "genre:country-music": "genre:country-and-western" } }),
			"utf8",
		);

		const { manifest } = await union({ serverRedirectsPath });
		expect(manifest.redirectsConflicts).toEqual([
			{
				reason: "diverged-target",
				repoFrom: "genre:country-music",
				repoTo: "genre:country",
				serverFrom: "genre:country-music",
				serverTo: "genre:country-and-western",
			},
		]);
		expect(countUnionProblems(manifest)).toBeGreaterThan(0);

		// Without serverRedirectsPath (existing callers, e.g. the CLI without the new flag), the
		// same repo table never gets flagged against itself.
		const { manifest: withoutServerTable } = await union();
		expect(withoutServerTable.redirectsConflicts).toBeUndefined();
		expect(countUnionProblems(withoutServerTable)).toBe(0);
	});

	describe("--apply-merge", () => {
		it("applies the merge, archives every pre-migration node, and persists the applied report/deletedCount in the manifest -- without touching either source or the source redirects file", async () => {
			await seed(
				repoDir,
				node({ slug: "genre:country-music", qid: "Q1", materialized_at: "2026-01-01T00:00:00.000Z" }),
			);
			await seed(
				serverDir,
				node({ slug: "genre:country", qid: "Q1", materialized_at: "2026-02-01T00:00:00.000Z" }),
			);
			const repoFingerprintBefore = await fingerprint(repoDir);
			const serverFingerprintBefore = await fingerprint(serverDir);
			const redirectsBefore = await readFile(redirectsPath, "utf8");

			const { outputDir, manifest } = await union({ applyMerge: true });

			expect(manifest.migrationApply).toEqual(
				expect.objectContaining({
					applied: true,
					groupsFound: 1,
					deletedCount: 1,
					exitCode: 0,
					archivedNodeCount: 2,
				}),
			);
			expect(manifest.migrationApply?.report.length).toBeGreaterThan(0);
			expect(countUnionProblems(manifest)).toBe(0);
			// The manifest must describe the FINAL state, not the union step's now-stale decision --
			// the loser is no longer "copied", it's removedByMigration, with the winner it redirects to.
			expect(manifest.migrationApply?.removedByMigration).toEqual([
				{ slug: "genre:country-music", redirectsTo: "genre:country" },
			]);

			// The loser (older materialized_at) is gone from nodes/, but both variants survive
			// under archive/pre-migration/ -- the exact B6a review gap this ticket closes.
			await expect(
				readFile(join(outputDir, "nodes", "genre", "country-music.json"), "utf8"),
			).rejects.toThrow();
			expect(await readFile(join(outputDir, "nodes", "genre", "country.json"), "utf8")).toBeTruthy();
			expect(
				await readFile(join(outputDir, "archive", "pre-migration", "genre", "country-music.json"), "utf8"),
			).toBeTruthy();
			expect(
				await readFile(join(outputDir, "archive", "pre-migration", "genre", "country.json"), "utf8"),
			).toBeTruthy();

			expect(await fingerprint(repoDir)).toBe(repoFingerprintBefore);
			expect(await fingerprint(serverDir)).toBe(serverFingerprintBefore);
			expect(await readFile(redirectsPath, "utf8")).toBe(redirectsBefore);
		});

		it("captures the migration's refusal (an onboarding-protected loser) as applied:false + refusalReason, instead of a report indistinguishable from a successful merge", async () => {
			await seed(repoDir, node({ slug: "genre:idm", qid: "Q-IDM" }));
			await seed(
				serverDir,
				node({ slug: "genre:idm-alt", qid: "Q-IDM", materialized_at: "2026-02-01T00:00:00.000Z" }),
			);

			// Both candidate slugs protected, so whichever the election picks as the loser is covered
			// without depending on knowing the election's exact tie-break order.
			const { manifest } = await union({ applyMerge: true, onboardingSlugs: ["genre:idm", "genre:idm-alt"] });

			expect(manifest.migrationApply).toEqual(
				expect.objectContaining({ applied: false, exitCode: 1, deletedCount: 0 }),
			);
			expect(manifest.migrationApply?.refusalReason).toMatch(/onboarding genre slug/);
			expect(countUnionProblems(manifest)).toBeGreaterThan(0);
		});

		it("re-reads the union's post-migration redirects (not the pre-existing source table): a reference to a loser with NO pre-existing redirect must not false-positive as broken", async () => {
			await seed(repoDir, node({ slug: "genre:ambient-techno", qid: "Q-AT" }));
			await seed(
				serverDir,
				node({ slug: "genre:ambient", qid: "Q-AT", materialized_at: "2026-02-01T00:00:00.000Z" }),
			);
			await seed(
				repoDir,
				node({
					slug: "genre:idm-witness",
					related_genres: [{ slug: "genre:ambient-techno", type: "genre", name: "Ambient Techno" }],
				}),
			);

			const { outputDir, manifest } = await union({ applyMerge: true });

			expect(manifest.migrationApply?.deletedCount).toBe(1);
			expect(manifest.referenceRegressions).toEqual([]);

			const [atSurvives, ambSurvives] = await Promise.all(
				["ambient-techno", "ambient"].map((body) =>
					readFile(join(outputDir, "nodes", "genre", `${body}.json`), "utf8").then(
						() => true,
						() => false,
					),
				),
			);
			expect(atSurvives).not.toBe(ambSurvives);
			const loserSlug = atSurvives ? "genre:ambient" : "genre:ambient-techno";
			expect(manifest.migrationApply?.removedByMigration).toEqual([
				expect.objectContaining({ slug: loserSlug, redirectsTo: expect.any(String) }),
			]);
		});

		it("flags references genuinely broken by the union (conflict-excluded slugs), scanning edges from BOTH sources, but not a reference that was never materialized anywhere", async () => {
			await seed(repoDir, node({ slug: "genre:conflict", qid: "Q1" }));
			await seed(serverDir, node({ slug: "genre:conflict", qid: "Q2" }));
			await seed(repoDir, node({ slug: "genre:conflict-2", qid: "QA" }));
			await seed(serverDir, node({ slug: "genre:conflict-2", qid: "QB" }));
			await seed(
				repoDir,
				node({
					slug: "genre:witness",
					related_genres: [
						{ slug: "genre:conflict", type: "genre", name: "Conflict" },
						{ slug: "genre:never-materialized", type: "genre", name: "Nowhere" },
					],
				}),
			);
			// This edge exists ONLY on the server side -- a "repo edges only" mutant would never
			// even consider genre:conflict-2 a candidate reference, missing this regression.
			await seed(
				serverDir,
				node({
					slug: "genre:server-witness",
					related_genres: [{ slug: "genre:conflict-2", type: "genre", name: "Conflict 2" }],
				}),
			);

			const { manifest } = await union({ applyMerge: true });

			expect(manifest.referenceRegressions).toEqual(
				expect.arrayContaining([
					{ slug: "genre:conflict", resolvedIn: expect.arrayContaining(["repo", "server"]) },
					{ slug: "genre:conflict-2", resolvedIn: expect.arrayContaining(["repo", "server"]) },
				]),
			);
			expect(manifest.referenceRegressions).toHaveLength(2);
			expect(countUnionProblems(manifest)).toBeGreaterThan(0);
		});
	});
});
