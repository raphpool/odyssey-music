import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEW_WAVE, runMigration, WAVE } from "../scripts/migrations/2026-09-18-merge-wave-into-new-wave.js";
import { parseSlug } from "../src/slug.js";

// Nodes here are plain records, not typed against src/types.ts -- readCacheNodes reads raw JSON
// (no Zod), and rewriteNodeEdges/the invariant checks skip any edge field that isn't present, so
// only the fields each test actually exercises need to exist.
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

describe("runMigration (disk integration)", () => {
	let dir: string;
	let redirectsPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-wave-merge-"));
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

	// Mirrors the real cache's shape: `wave` and `new-wave` both carry content and share a
	// subgenre; an incoming edge from a third node (a label) carries wave's own, now-stale qid.
	async function seedWaveGroup() {
		const wavePath = await writeNodeFile(
			node({
				slug: WAVE,
				type: "genre",
				name: "Wave",
				qid: "Q106369996",
				subgenres: [{ slug: "genre:dark-wave", type: "genre", name: "Dark wave" }],
				related_genres: [{ slug: "genre:post-punk", type: "genre", name: "Post-punk" }],
			}),
		);
		const newWavePath = await writeNodeFile(
			node({
				slug: NEW_WAVE,
				type: "genre",
				name: "New wave",
				qid: "Q187760",
				subgenres: [{ slug: "genre:synth-pop", type: "genre", name: "Synth-pop" }],
				related_genres: [],
			}),
		);
		const staleLabelPath = await writeNodeFile(
			node({
				slug: "label:some-label",
				type: "label",
				genres: [{ slug: WAVE, type: "genre", name: "Wave", qid: "Q106369996" }],
			}),
		);
		return { wavePath, newWavePath, staleLabelPath };
	}

	it("dry-run computes the plan but leaves every file byte-identical", async () => {
		const { wavePath, newWavePath, staleLabelPath } = await seedWaveGroup();
		const before = await Promise.all([wavePath, newWavePath, staleLabelPath].map((p) => readFile(p, "utf8")));

		const result = await runMigration(dir, false, { redirectsPath });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(false);
		expect(result.report).toContain("DRY RUN");
		const after = await Promise.all([wavePath, newWavePath, staleLabelPath].map((p) => readFile(p, "utf8")));
		expect(after).toEqual(before);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("--apply merges wave into new-wave: union, redirect, incoming edges (including a stale qid) rewritten", async () => {
		const { wavePath, newWavePath, staleLabelPath } = await seedWaveGroup();
		const pendingPath = join(dir, "pending-reverses.json");
		await writeFile(
			pendingPath,
			JSON.stringify({
				[WAVE]: [
					{
						field: "key_labels",
						cardinality: "list",
						edge: { slug: "label:pending-label", type: "label", name: "Pending Label" },
					},
				],
			}),
			"utf8",
		);

		const result = await runMigration(dir, true, { redirectsPath });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(true);
		expect(result.report).not.toContain("DRY RUN");

		await expect(readFile(wavePath, "utf8")).rejects.toThrow();

		const merged = JSON.parse(await readFile(newWavePath, "utf8")) as RawNode;
		expect(merged.slug).toBe(NEW_WAVE);
		// Union of both nodes' subgenres, winner's own entry first, deduplicated by slug.
		expect(merged.subgenres).toEqual([
			{ slug: "genre:synth-pop", type: "genre", name: "Synth-pop" },
			{ slug: "genre:dark-wave", type: "genre", name: "Dark wave" },
		]);
		expect(merged.related_genres).toEqual([{ slug: "genre:post-punk", type: "genre", name: "Post-punk" }]);

		// The incoming edge is rewritten to new-wave, with its stale qid corrected to new-wave's own.
		const label = JSON.parse(await readFile(staleLabelPath, "utf8")) as RawNode;
		expect(label.genres).toEqual([{ slug: NEW_WAVE, type: "genre", name: "Wave", qid: "Q187760" }]);

		const redirects = JSON.parse(await readFile(redirectsPath, "utf8")) as {
			redirects: Record<string, string>;
		};
		expect(redirects.redirects).toEqual({ [WAVE]: NEW_WAVE });

		const pending = JSON.parse(await readFile(pendingPath, "utf8")) as Record<string, unknown>;
		expect(pending[WAVE]).toBeUndefined();
		expect(pending[NEW_WAVE]).toEqual([
			{
				field: "key_labels",
				cardinality: "list",
				edge: { slug: "label:pending-label", type: "label", name: "Pending Label" },
			},
		]);
	});

	// Regression (found in review): a first draft of this migration ran rewriteNodeEdges over
	// every cache node unconditionally. It also dedupes every OTHER list field on whatever node
	// it's given (documented behavior) -- so an unrelated node with its own, pre-existing
	// duplicate slug in some other list field got silently "fixed" as a side effect, well
	// outside this migration's scope.
	it("leaves a node with no reference to wave byte-identical, pre-existing duplicates and all", async () => {
		await seedWaveGroup();
		const unrelatedPath = await writeNodeFile(
			node({
				slug: "artist:unrelated",
				type: "artist",
				discography: [
					{ slug: "project:same-project", type: "project", name: "Same Project" },
					{ slug: "project:same-project", type: "project", name: "Same Project (dup)" },
				],
			}),
		);
		const before = await readFile(unrelatedPath, "utf8");

		const result = await runMigration(dir, true, { redirectsPath });

		expect(result.exitCode).toBe(0);
		expect(await readFile(unrelatedPath, "utf8")).toBe(before);
	});

	it("a second --apply is a no-op (idempotent)", async () => {
		await seedWaveGroup();
		const first = await runMigration(dir, true, { redirectsPath });
		expect(first.exitCode).toBe(0);
		expect(first.applied).toBe(true);

		const newWavePath = join(dir, "nodes", "genre", "new-wave.json");
		const beforeNode = await readFile(newWavePath, "utf8");
		const beforeRedirects = await readFile(redirectsPath, "utf8");

		const second = await runMigration(dir, true, { redirectsPath });

		expect(second.exitCode).toBe(0);
		expect(second.applied).toBe(false);
		expect(second.report).toContain("Already merged");
		expect(await readFile(newWavePath, "utf8")).toBe(beforeNode);
		expect(await readFile(redirectsPath, "utf8")).toBe(beforeRedirects);
	});

	it("refuses when the merge target genre:new-wave is missing", async () => {
		const wavePath = await writeNodeFile(node({ slug: WAVE, type: "genre", name: "Wave" }));
		const before = await readFile(wavePath, "utf8");

		const result = await runMigration(dir, true, { redirectsPath });

		expect(result.exitCode).toBe(1);
		expect(result.applied).toBe(false);
		expect(await readFile(wavePath, "utf8")).toBe(before);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("refuses when genre:wave is absent but no matching redirect exists (unexpected state)", async () => {
		await writeNodeFile(node({ slug: NEW_WAVE, type: "genre", name: "New wave" }));

		const result = await runMigration(dir, true, { redirectsPath });

		expect(result.exitCode).toBe(1);
		expect(result.report).toContain("unexpected state");
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("recognizes a completed prior run (wave absent, new-wave present, matching redirect) as already merged", async () => {
		await writeNodeFile(node({ slug: NEW_WAVE, type: "genre", name: "New wave" }));
		await writeFile(redirectsPath, JSON.stringify({ redirects: { [WAVE]: NEW_WAVE } }), "utf8");

		const result = await runMigration(dir, true, { redirectsPath });

		expect(result.exitCode).toBe(0);
		expect(result.applied).toBe(false);
		expect(result.report).toContain("Already merged");
	});

	// Code review (2026-09-18): a corrupt file on disk used to read exactly like an absent slug,
	// so the idempotence check could mistake it for "already merged" and silently do nothing.
	it("refuses, rather than treating it as absent, when genre:wave's file exists but fails to parse", async () => {
		await writeNodeFile(node({ slug: NEW_WAVE, type: "genre", name: "New wave" }));
		const wavePath = join(dir, "nodes", "genre", "wave.json");
		await mkdir(dirname(wavePath), { recursive: true });
		await writeFile(wavePath, "{ not valid json", "utf8");

		const result = await runMigration(dir, true, { redirectsPath });

		expect(result.exitCode).toBe(1);
		expect(result.report).toContain("failed to read");
		expect(await readFile(wavePath, "utf8")).toBe("{ not valid json");
	});
});
