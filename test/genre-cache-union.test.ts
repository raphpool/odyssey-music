import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCacheUnion,
	countUnionProblems,
	decideSameIdentity,
	type UnionManifest,
} from "../scripts/prepare-genre-cache-union.js";
import { parseSlug } from "../src/slug.js";

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

	function union() {
		return buildCacheUnion(repoDir, serverDir, { redirectsPath, onboardingSlugs: [] });
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
		expect(manifest.migrationPreview.groupsFound).toBe(1);
		expect(manifest.migrationPreview.exitCode).toBe(0);
		// Preview only: neither slug is deleted from the union artifact.
		expect(await readFile(join(outputDir, "nodes", "genre", "country-music.json"), "utf8")).toBeTruthy();
		expect(await readFile(join(outputDir, "nodes", "genre", "country.json"), "utf8")).toBeTruthy();

		expect(await fingerprint(repoDir)).toBe(repoFingerprintBefore);
		expect(await fingerprint(serverDir)).toBe(serverFingerprintBefore);
		expect(await readFile(redirectsPath, "utf8")).toBe(redirectsBefore);
	});
});
