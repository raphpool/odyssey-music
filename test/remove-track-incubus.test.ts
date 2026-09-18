import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dropEdgesToSlug,
	dropPendingReversesForSlug,
	runMigration,
	TARGET_SLUG,
} from "../scripts/migrations/2026-09-18-remove-track-incubus.js";
import type { PendingReverse } from "../src/cache.js";
import { parseSlug } from "../src/slug.js";

// Raw records, not typed against src/types.ts: readCacheNodes reads unchecked JSON (see its own
// docstring), and dropEdgesToSlug only looks at the edge fields a given test actually wires up --
// same latitude test/genre-rename.test.ts:25-29 relies on for the same reason.
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

describe("dropEdgesToSlug", () => {
	it("drops a matching entry from a list field, keeps everything else, and counts the hit", () => {
		const trackNode = {
			slug: "track:some-song",
			genres: [
				{ slug: "genre:death-metal", type: "genre", name: "Death Metal" },
				{ slug: TARGET_SLUG, type: "track", name: "Incubus" },
			],
			samples: [{ slug: TARGET_SLUG, type: "track", name: "Incubus" }],
		};

		const { node: result, hits } = dropEdgesToSlug(trackNode, "track", TARGET_SLUG);

		expect(hits).toBe(2);
		expect(result.genres).toEqual([{ slug: "genre:death-metal", type: "genre", name: "Death Metal" }]);
		expect(result.samples).toEqual([]);
	});

	it("clears a matching singular field to undefined", () => {
		const trackNode = {
			slug: "track:a-remix",
			remix_of: { slug: TARGET_SLUG, type: "track", name: "Incubus" },
		};

		const { node: result, hits } = dropEdgesToSlug(trackNode, "track", TARGET_SLUG);

		expect(hits).toBe(1);
		expect(result.remix_of).toBeUndefined();
	});

	it("leaves a node with no reference to the target completely unchanged (zero hits)", () => {
		const trackNode = {
			slug: "track:unrelated",
			genres: [{ slug: "genre:house", type: "genre", name: "House" }],
		};

		const { node: result, hits } = dropEdgesToSlug(trackNode, "track", TARGET_SLUG);

		expect(hits).toBe(0);
		expect(result).toEqual(trackNode);
	});
});

describe("dropPendingReversesForSlug", () => {
	const otherEdge: PendingReverse = {
		field: "genres",
		cardinality: "list",
		edge: { slug: "artist:someone", type: "artist", name: "Someone" },
	};
	const targetEdge: PendingReverse = {
		field: "notable_tracks",
		cardinality: "list",
		edge: { slug: TARGET_SLUG, type: "track", name: "Incubus" },
	};

	it("drops the target's own key entirely", () => {
		const { result, changed } = dropPendingReversesForSlug({ [TARGET_SLUG]: [otherEdge] }, TARGET_SLUG);
		expect(changed).toBe(true);
		expect(result).toEqual({});
	});

	it("drops only the matching entries from another key's list, keeping the rest", () => {
		const { result, changed } = dropPendingReversesForSlug(
			{ "artist:incubus-fan": [otherEdge, targetEdge] },
			TARGET_SLUG,
		);
		expect(changed).toBe(true);
		expect(result).toEqual({ "artist:incubus-fan": [otherEdge] });
	});

	it("drops a key entirely once filtering empties its list, rather than leaving []", () => {
		const { result, changed } = dropPendingReversesForSlug(
			{ "artist:incubus-fan": [targetEdge] },
			TARGET_SLUG,
		);
		expect(changed).toBe(true);
		expect(result).toEqual({});
	});

	it("is a no-op when nothing references the target", () => {
		const pending = { "artist:someone-else": [otherEdge] };
		const { result, changed } = dropPendingReversesForSlug(pending, TARGET_SLUG);
		expect(changed).toBe(false);
		expect(result).toEqual(pending);
	});
});

describe("runMigration (disk integration)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-remove-track-incubus-"));
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

	// Mirrors the real cache: the target itself, plus other nodes wired up to it the way a
	// genuine incoming edge would be -- a genre's landmark_tracks (list), and another track's
	// remix_of (single), so both cardinalities are exercised end-to-end.
	async function seedTargetGroup() {
		const targetPath = await writeNodeFile(
			node({ slug: TARGET_SLUG, type: "track", name: "Incubus", genres: [], artists: [] }),
		);
		const genrePath = await writeNodeFile(
			node({
				slug: "genre:death-metal",
				type: "genre",
				name: "Death Metal",
				landmark_tracks: [{ slug: TARGET_SLUG, type: "track", name: "Incubus" }],
			}),
		);
		const remixPath = await writeNodeFile(
			node({
				slug: "track:some-remix",
				type: "track",
				name: "Some Remix",
				remix_of: { slug: TARGET_SLUG, type: "track", name: "Incubus" },
			}),
		);
		const unrelatedPath = await writeNodeFile(
			node({ slug: "artist:unrelated", type: "artist", name: "Unrelated", genres: [] }),
		);
		return { targetPath, genrePath, remixPath, unrelatedPath };
	}

	it("dry-run computes the plan but leaves every file byte-identical", async () => {
		const paths = await seedTargetGroup();
		const before = await Promise.all(Object.values(paths).map((p) => readFile(p, "utf8")));

		const result = await runMigration(dir, false);

		expect(result.exitCode).toBe(0);
		expect(result.deletedCount).toBe(0);
		expect(result.report).toContain("DRY RUN");
		const after = await Promise.all(Object.values(paths).map((p) => readFile(p, "utf8")));
		expect(after).toEqual(before);
	});

	it("--apply drops the dangling list and singular edges, updates pending-reverses, and deletes the target last", async () => {
		const { targetPath, genrePath, remixPath, unrelatedPath } = await seedTargetGroup();
		const pendingPath = join(dir, "pending-reverses.json");
		await writeFile(
			pendingPath,
			JSON.stringify({
				[TARGET_SLUG]: [
					{
						field: "notable_tracks",
						cardinality: "list",
						edge: { slug: "artist:incubus", type: "artist", name: "Incubus" },
					},
				],
				"artist:some-fan": [
					{
						field: "notable_tracks",
						cardinality: "list",
						edge: { slug: TARGET_SLUG, type: "track", name: "Incubus" },
					},
				],
			}),
			"utf8",
		);
		const unrelatedBefore = await readFile(unrelatedPath, "utf8");

		const result = await runMigration(dir, true);

		expect(result.exitCode).toBe(0);
		expect(result.deletedCount).toBe(1);
		expect(result.report).not.toContain("DRY RUN");

		await expect(readFile(targetPath, "utf8")).rejects.toThrow();

		const genre = JSON.parse(await readFile(genrePath, "utf8")) as RawNode;
		expect(genre.landmark_tracks).toEqual([]);

		const remix = JSON.parse(await readFile(remixPath, "utf8")) as RawNode;
		expect(remix.remix_of).toBeUndefined();

		// A node with no reference to the target is left completely untouched.
		expect(await readFile(unrelatedPath, "utf8")).toBe(unrelatedBefore);

		const pending = JSON.parse(await readFile(pendingPath, "utf8")) as Record<string, unknown>;
		expect(pending[TARGET_SLUG]).toBeUndefined();
		expect(pending["artist:some-fan"]).toBeUndefined();
	});

	it("a second --apply is idempotent: reports already-removed and writes nothing further", async () => {
		await seedTargetGroup();
		const first = await runMigration(dir, true);
		expect(first.exitCode).toBe(0);
		expect(first.deletedCount).toBe(1);

		const genrePath = join(dir, "nodes", "genre", "death-metal.json");
		const before = await readFile(genrePath, "utf8");

		const second = await runMigration(dir, true);

		expect(second.exitCode).toBe(0);
		expect(second.deletedCount).toBe(0);
		expect(second.report).toContain("already removed");
		expect(await readFile(genrePath, "utf8")).toBe(before);
	});

	it("the target already absent (nothing ever seeded) is a clean no-op, not a refusal", async () => {
		const result = await runMigration(dir, true);
		expect(result.exitCode).toBe(0);
		expect(result.deletedCount).toBe(0);
		expect(result.report).toContain("already removed");
	});

	it("refuses on a truncated pending-reverses.json, writing nothing (crash-safety)", async () => {
		const { targetPath, genrePath } = await seedTargetGroup();
		const pendingPath = join(dir, "pending-reverses.json");
		await writeFile(pendingPath, '{"artist:x": [', "utf8");
		const before = {
			target: await readFile(targetPath, "utf8"),
			genre: await readFile(genrePath, "utf8"),
			pending: await readFile(pendingPath, "utf8"),
		};

		const result = await runMigration(dir, true);

		expect(result.exitCode).toBe(1);
		expect(await readFile(targetPath, "utf8")).toBe(before.target);
		expect(await readFile(genrePath, "utf8")).toBe(before.genre);
		expect(await readFile(pendingPath, "utf8")).toBe(before.pending);
	});

	it("a corrupted target file refuses outright -- never treated as already removed", async () => {
		const targetDir = join(dir, "nodes", "track");
		await mkdir(targetDir, { recursive: true });
		const targetPath = join(targetDir, `${parseSlug(TARGET_SLUG).body}.json`);
		await writeFile(targetPath, "{ not valid json", "utf8");

		const result = await runMigration(dir, true);

		expect(result.exitCode).toBe(1);
		expect(result.report).toContain("refusing");
		expect(result.report).toContain("failed to parse");
		await expect(readFile(targetPath, "utf8")).resolves.toBe("{ not valid json");
	});

	it("refuses when the on-disk node's slug or type has drifted from what this migration targets", async () => {
		await writeNodeFile(node({ slug: TARGET_SLUG, type: "genre", name: "Drifted" }));

		const result = await runMigration(dir, true);

		expect(result.exitCode).toBe(1);
		await expect(
			readFile(join(dir, "nodes", "track", `${parseSlug(TARGET_SLUG).body}.json`), "utf8"),
		).resolves.toBeTruthy();
	});
});
