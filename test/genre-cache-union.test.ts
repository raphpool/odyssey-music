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
	parseUnionCliArgs,
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
		droppedEdges: [],
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

describe("parseUnionCliArgs", () => {
	it("parses the two positional dirs plus both optional flags", () => {
		expect(parseUnionCliArgs(["r", "s", "--apply-merge", "--server-redirects-path", "p.json"])).toEqual({
			repoCacheDir: "r",
			serverCacheDir: "s",
			applyMerge: true,
			serverRedirectsPath: "p.json",
		});
		expect(parseUnionCliArgs(["r", "s"])).toEqual({
			repoCacheDir: "r",
			serverCacheDir: "s",
			applyMerge: false,
		});
	});

	// Finding 4: a malformed CLI invocation must never fall through to a silent guess.
	it("refuses --server-redirects-path repeated, missing its value, or followed by another flag", () => {
		expect(() =>
			parseUnionCliArgs(["r", "s", "--server-redirects-path", "p", "--server-redirects-path", "q"]),
		).toThrow(/only be given once/);
		expect(() => parseUnionCliArgs(["r", "s", "--server-redirects-path"])).toThrow(/requires a value/);
		expect(() => parseUnionCliArgs(["r", "s", "--server-redirects-path", "--apply-merge"])).toThrow(
			/requires a value/,
		);
	});

	it("refuses an unrecognized flag and anything but exactly two positional arguments", () => {
		expect(() => parseUnionCliArgs(["r", "s", "--dry-run"])).toThrow(/unknown argument/);
		expect(() => parseUnionCliArgs(["r"])).toThrow(/usage:/);
		expect(() => parseUnionCliArgs(["r", "s", "t"])).toThrow(/usage:/);
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

// Full genreSchema shape (B6a-3 / TRA-268): a "kept" (same-slug-both-sides) node is now
// reconstructed and validated against nodePayloadSchema before it's written (writeValidatedNode),
// so every fixture that can end up "kept" must satisfy the schema, not just carry the couple of
// fields a byte-identical copy never inspected.
function node(overrides: Partial<Record<string, unknown>> & { slug: string }): Record<string, unknown> {
	return {
		type: "genre",
		name: "Test",
		materialized_at: "2026-01-01T00:00:00.000Z",
		editorial_article: "x".repeat(80),
		editorial_definition: "A test genre.",
		citations: [{ url: "https://example.com" }],
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
		...overrides,
	};
}

// Full artistSchema shape, for an edge target that must resolve to a LIVE node -- readCacheNodes
// never validates it (raw JSON.parse), but a self-union (see the idempotence test below) can
// still elect it "kept" once its own slug lands on both sides, at which point it goes through
// writeValidatedNode like any other kept node.
function artistNode(overrides: Partial<Record<string, unknown>> & { slug: string }): Record<string, unknown> {
	return {
		type: "artist",
		name: "Test Artist",
		materialized_at: "2026-01-01T00:00:00.000Z",
		editorial_article: "x".repeat(80),
		editorial_bio: "A test artist.",
		citations: [{ url: "https://example.com" }],
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		...overrides,
	};
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

async function writeServerRedirects(redirects: Record<string, string>): Promise<string> {
	const path = join(await mkdtemp(join(tmpdir(), "odyssey-union-server-data-")), "genre-redirects.json");
	await writeFile(path, JSON.stringify({ redirects }), "utf8");
	return path;
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
		// Same loser (genre:country-music) as redirectsPath's table, but a different winner -- the
		// server already resolved this duplicate group differently than the repo.
		const serverRedirectsPath = await writeServerRedirects({
			"genre:country-music": "genre:country-and-western",
		});

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

	// Finding 2: a 4-entry cycle split across the two tables has no same-key divergence and no
	// exact reversal, so diffGenreRedirects alone reports it clean.
	it("refuses a cycle that only appears once the two tables are combined, even though pairwise diffing finds nothing", async () => {
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:a": "genre:b", "genre:c": "genre:d" } }),
			"utf8",
		);
		const serverRedirectsPath = await writeServerRedirects({ "genre:b": "genre:c", "genre:d": "genre:a" });

		const { manifest } = await union({ serverRedirectsPath });
		expect(manifest.redirectsConflicts).toEqual([{ reason: "cycle", message: expect.any(String) }]);
		expect(countUnionProblems(manifest)).toBeGreaterThan(0);
	});

	// Finding 4: a given-but-missing path must fail loudly, before anything is written.
	it("refuses a --server-redirects-path that does not exist, naming the path, before writing anything", async () => {
		const outputRoot = await mkdtemp(join(tmpdir(), "odyssey-union-out-"));
		const missingPath = join(outputRoot, "does-not-exist.json");
		await expect(
			buildCacheUnion(repoDir, serverDir, { redirectsPath, serverRedirectsPath: missingPath, outputRoot }),
		).rejects.toThrow(missingPath);
		// Nothing was written under outputRoot -- the union's own mkdtemp never ran.
		expect(await readdir(outputRoot)).toEqual([]);
	});

	it("refuses a --server-redirects-path with broken JSON, naming the path", async () => {
		const serverRedirectsPath = join(await mkdtemp(join(tmpdir(), "odyssey-union-server-data-")), "bad.json");
		await writeFile(serverRedirectsPath, "{not valid json", "utf8");
		await expect(union({ serverRedirectsPath })).rejects.toThrow(/is not valid JSON/);
	});

	// Finding 4: an explicit "" must be validated too, never treated as "option omitted".
	it("refuses an empty-string --server-redirects-path instead of silently skipping validation", async () => {
		await expect(union({ serverRedirectsPath: "" })).rejects.toThrow();
	});

	// Finding 2: a slug the migration actually deletes must redirect to a live target -- scoped
	// to what THIS run deletes, so an untouched stale entry (e.g. real production data) is fine.
	it("marks the result untrusted when a slug the migration deletes redirects nowhere live", async () => {
		await writeFile(redirectsPath, JSON.stringify({ redirects: {} }), "utf8");
		await seed(repoDir, node({ slug: "genre:a", qid: "Q-DANGLE" }));
		await seed(repoDir, node({ slug: "genre:cc", qid: "Q-DANGLE" }));
		const serverRedirectsPath = await writeServerRedirects({ "genre:a": "genre:nowhere" });

		const { outputDir, manifest } = await union({ applyMerge: true, serverRedirectsPath });

		expect(manifest.redirectsConflicts).toEqual([expect.objectContaining({ reason: "dangling" })]);
		// cc really was deleted from the union's disposable copy -- only `applied` is forced
		// false; deletedCount stays honest.
		expect(manifest.migrationApply).toEqual(expect.objectContaining({ applied: false, deletedCount: 1 }));
		expect(await readFile(join(outputDir, "nodes", "genre", "a.json"), "utf8")).toBeTruthy();
		await expect(readFile(join(outputDir, "nodes", "genre", "cc.json"), "utf8")).rejects.toThrow();
	});

	// TRA-245 acceptance criterion: the real committed cache, unioned against itself with the
	// real committed redirects table on both sides, must never false-flag a conflict.
	it("unions the real committed cache against itself with the real data/genre-redirects.json on both sides, cleanly", async () => {
		const { manifest } = await buildCacheUnion("cache", "cache", {
			redirectsPath: "data/genre-redirects.json",
			serverRedirectsPath: "data/genre-redirects.json",
			onboardingSlugs: [],
		});
		expect(manifest.redirectsConflicts).toBeUndefined();
		expect(countUnionProblems(manifest)).toBe(0);
	});

	// B6a-3 / TRA-268: a "kept" (same-slug-both-sides) node used to be written as a byte-identical
	// copy of whichever side won on materialized_at -- silently dropping every list edge unique to
	// the OTHER side, notably a server-only reverse edge from applyReverseToTarget (independent
	// review of #221, 2026-09-17). These tests cover the fix: list edges are unioned and
	// deduplicated by slug, an edge that no longer resolves in the union is dropped and reported,
	// and the written file goes through real schema validation instead of a raw copy.
	describe("edge union for a kept slug", () => {
		it("keeps a server-only edge (the exact verified bug: edge lost, text from the newer repo side)", async () => {
			await seed(
				repoDir,
				node({
					slug: "genre:shared",
					qid: "Q1",
					materialized_at: "2026-09-01T00:00:00.000Z",
					name: "Shared (repo)",
				}),
			);
			await seed(
				serverDir,
				node({
					slug: "genre:shared",
					qid: "Q1",
					materialized_at: "2026-08-01T00:00:00.000Z",
					name: "Shared (server)",
					key_artists: [{ slug: "artist:server-only", type: "artist", name: "Server Only" }],
				}),
			);
			// Only needs to exist on disk (readCacheNodes never validates it) so it's live in the
			// union -- an edge to a slug with no live node anywhere would be dropped (see below).
			await seed(serverDir, artistNode({ slug: "artist:server-only" }));

			const { outputDir, manifest } = await union();

			const written = JSON.parse(
				await readFile(join(outputDir, "nodes", "genre", "shared.json"), "utf8"),
			) as Record<string, unknown>;
			expect(written.name).toBe("Shared (repo)");
			expect(written.key_artists).toEqual([
				{ slug: "artist:server-only", type: "artist", name: "Server Only" },
			]);
			expect(manifest.entries).toEqual(
				expect.arrayContaining([
					{ decision: "kept", from: "repo", slug: "genre:shared", tie: false, mergedEdgeCount: 1 },
				]),
			);
			expect(manifest.droppedEdges).toEqual([]);
		});

		it("does not duplicate an edge present on both sides", async () => {
			const edge = { slug: "artist:both", type: "artist", name: "Both" };
			await seed(
				repoDir,
				node({
					slug: "genre:shared",
					qid: "Q1",
					materialized_at: "2026-09-01T00:00:00.000Z",
					key_artists: [edge],
				}),
			);
			await seed(
				serverDir,
				node({
					slug: "genre:shared",
					qid: "Q1",
					materialized_at: "2026-08-01T00:00:00.000Z",
					key_artists: [edge],
				}),
			);
			await seed(serverDir, artistNode({ slug: "artist:both" }));

			const { outputDir, manifest } = await union();

			const written = JSON.parse(
				await readFile(join(outputDir, "nodes", "genre", "shared.json"), "utf8"),
			) as Record<string, unknown>;
			expect(written.key_artists).toEqual([edge]);
			const kept = manifest.entries.find((e) => e.slug === "genre:shared");
			expect(kept && "mergedEdgeCount" in kept ? kept.mergedEdgeCount : undefined).toBeUndefined();
		});

		it("drops an edge from the losing side that no longer resolves in the union, and lists it in the manifest", async () => {
			await seed(
				repoDir,
				node({ slug: "genre:shared", qid: "Q1", materialized_at: "2026-09-01T00:00:00.000Z" }),
			);
			await seed(
				serverDir,
				node({
					slug: "genre:shared",
					qid: "Q1",
					materialized_at: "2026-08-01T00:00:00.000Z",
					key_artists: [{ slug: "artist:ghost", type: "artist", name: "Ghost" }],
				}),
			);
			// artist:ghost is never seeded anywhere -- unresolvable in the union.

			const { outputDir, manifest } = await union();

			const written = JSON.parse(
				await readFile(join(outputDir, "nodes", "genre", "shared.json"), "utf8"),
			) as Record<string, unknown>;
			expect(written.key_artists).toEqual([]);
			expect(manifest.droppedEdges).toEqual([
				{ slug: "genre:shared", field: "key_artists", target: "artist:ghost" },
			]);
			// A dropped edge is the same tolerated baseline as any other never-materialized edge --
			// it must not, on its own, mark the union as needing attention.
			expect(countUnionProblems(manifest)).toBe(0);
		});

		it("still refuses a qid conflict even when the losing side carries edges", async () => {
			await seed(
				repoDir,
				node({
					slug: "genre:conflict",
					qid: "Q1",
					key_artists: [{ slug: "artist:a", type: "artist", name: "A" }],
				}),
			);
			await seed(
				serverDir,
				node({
					slug: "genre:conflict",
					qid: "Q2",
					key_artists: [{ slug: "artist:b", type: "artist", name: "B" }],
				}),
			);

			const { outputDir, manifest } = await union();

			expect(manifest.entries).toEqual([{ decision: "conflict", slug: "genre:conflict", reason: "qid" }]);
			await expect(readFile(join(outputDir, "nodes", "genre", "conflict.json"), "utf8")).rejects.toThrow();
		});

		it("is idempotent: re-running the union on its own output changes nothing", async () => {
			// Both sides identical from the start (like the "real cache against itself" test above)
			// so every slug is already "kept" -- and validated/reformatted -- on the FIRST run. Seeding
			// an asymmetric edge here (present on only one side going in) would make that edge's own
			// node transition from "copied" (byte-identical) to "kept" (schema-reformatted) between
			// generation 1 and 2, a real but unrelated formatting difference this test isn't about.
			const shared = node({
				slug: "genre:shared",
				qid: "Q1",
				key_artists: [{ slug: "artist:x", type: "artist", name: "X" }],
			});
			const artist = artistNode({ slug: "artist:x" });
			await seed(repoDir, shared);
			await seed(serverDir, shared);
			await seed(repoDir, artist);
			await seed(serverDir, artist);

			const first = await union();
			const firstNodes = await fingerprint(first.outputDir, "nodes");

			const second = await buildCacheUnion(first.outputDir, first.outputDir, {
				redirectsPath: join(first.outputDir, "genre-redirects.json"),
				onboardingSlugs: [],
			});
			const secondNodes = await fingerprint(second.outputDir, "nodes");

			expect(secondNodes).toBe(firstNodes);
			expect(second.manifest.droppedEdges).toEqual([]);
			for (const entry of second.manifest.entries) {
				expect(entry.decision).toBe("kept");
				expect("mergedEdgeCount" in entry ? entry.mergedEdgeCount : undefined).toBeUndefined();
			}
		});
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

		// Finding 1 (S4 repro): the repo hasn't caught up to a merge the server already did --
		// seeding the union's copy with the COMBINED table lets election follow the server's winner.
		it("elects the server's already-chosen winner when the repo's own table has no entry for it yet", async () => {
			await writeFile(redirectsPath, JSON.stringify({ redirects: {} }), "utf8");
			await seed(repoDir, node({ slug: "genre:aa", qid: "Q54" }));
			await seed(repoDir, node({ slug: "genre:bbbb", qid: "Q54" }));
			await seed(serverDir, node({ slug: "genre:bbbb", qid: "Q54" }));
			const serverRedirectsPath = await writeServerRedirects({ "genre:aa": "genre:bbbb" });

			const { outputDir, manifest } = await union({ applyMerge: true, serverRedirectsPath });

			expect(manifest.redirectsConflicts).toBeUndefined();
			expect(manifest.migrationApply).toEqual(expect.objectContaining({ applied: true, deletedCount: 1 }));
			const finalRedirects = JSON.parse(
				await readFile(join(outputDir, "genre-redirects.json"), "utf8"),
			).redirects;
			expect(finalRedirects).toEqual({ "genre:aa": "genre:bbbb" });
		});

		// Finding 1+2 (S2 repro): a merge chain split across both tables, with no shared key or
		// reversal for diffGenreRedirects to catch -- the old code would elect the wrong side.
		it("elects the server's winner across a merge chain split over both tables, without producing a cycle", async () => {
			await writeFile(redirectsPath, JSON.stringify({ redirects: { "genre:aaaaaa": "genre:bb" } }), "utf8");
			await seed(repoDir, node({ slug: "genre:bb", qid: "Q-S2" }));
			await seed(serverDir, node({ slug: "genre:cccc", qid: "Q-S2" }));
			const serverRedirectsPath = await writeServerRedirects({ "genre:bb": "genre:cccc" });

			const { outputDir, manifest } = await union({ applyMerge: true, serverRedirectsPath });

			expect(manifest.redirectsConflicts).toBeUndefined();
			expect(manifest.migrationApply).toEqual(expect.objectContaining({ applied: true, deletedCount: 1 }));
			const finalRedirects = JSON.parse(
				await readFile(join(outputDir, "genre-redirects.json"), "utf8"),
			).redirects;
			expect(finalRedirects).toEqual({ "genre:aaaaaa": "genre:cccc", "genre:bb": "genre:cccc" });
		});

		// Finding 3: a redirects conflict must block the APPLY too, not just get reported alongside
		// a migration that ran anyway.
		it("never applies the migration when the redirects tables conflict, leaving both duplicate-group members on disk", async () => {
			// Diverges from the shared beforeEach table -- unrelated to the duplicate-QID pair below.
			const serverRedirectsPath = await writeServerRedirects({
				"genre:country-music": "genre:country-and-western",
			});
			await seed(repoDir, node({ slug: "genre:idm", qid: "Q-F3" }));
			await seed(
				serverDir,
				node({ slug: "genre:idm-alt", qid: "Q-F3", materialized_at: "2026-02-01T00:00:00.000Z" }),
			);

			const { outputDir, manifest } = await union({ applyMerge: true, serverRedirectsPath });

			expect(manifest.redirectsConflicts).toEqual([expect.objectContaining({ reason: "diverged-target" })]);
			expect(manifest.migrationApply).toEqual(expect.objectContaining({ applied: false, deletedCount: 0 }));
			expect(await readFile(join(outputDir, "nodes", "genre", "idm.json"), "utf8")).toBeTruthy();
			expect(await readFile(join(outputDir, "nodes", "genre", "idm-alt.json"), "utf8")).toBeTruthy();
		});

		// B6a-3 / TRA-268: a merged (unioned) edge must be the migration's INPUT, not bypassed by it
		// -- an edge added to genre:shared by the union, pointing at a slug the QID-duplicate merge
		// elects to delete, must come out the other side rewritten to the survivor, exactly like any
		// edge that was already there before this ticket.
		it("rewrites a merged edge the same way as any other when its target is itself merged away", async () => {
			// existing-redirect (criterion 0) makes the election deterministic regardless of usage.
			await writeFile(redirectsPath, JSON.stringify({ redirects: { "genre:bb": "genre:aa" } }), "utf8");
			await seed(repoDir, node({ slug: "genre:aa", qid: "Q9" }));
			await seed(repoDir, node({ slug: "genre:bb", qid: "Q9" }));
			await seed(
				repoDir,
				node({ slug: "genre:shared", qid: "Q1", materialized_at: "2026-09-01T00:00:00.000Z" }),
			);
			await seed(
				serverDir,
				node({
					slug: "genre:shared",
					qid: "Q1",
					materialized_at: "2026-08-01T00:00:00.000Z",
					related_genres: [{ slug: "genre:bb", type: "genre", name: "BB" }],
				}),
			);

			const { outputDir, manifest } = await union({ applyMerge: true });

			expect(manifest.migrationApply).toEqual(expect.objectContaining({ applied: true, deletedCount: 1 }));
			const written = JSON.parse(
				await readFile(join(outputDir, "nodes", "genre", "shared.json"), "utf8"),
			) as Record<string, unknown>;
			expect(written.related_genres).toEqual([{ slug: "genre:aa", type: "genre", name: "BB" }]);
		});
	});
});
