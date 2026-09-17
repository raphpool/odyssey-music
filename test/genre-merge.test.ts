import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ElectionCandidate,
	electCanonical,
	loadOnboardingGenreSlugs,
	looksLikeCacheDir,
	mergeGenreEdges,
	mergeRedirects,
	parseCliArgs,
	readCacheNodes,
	rewriteNodeEdges,
	rewritePendingReverses,
	runMigration,
	stillResolves,
	unionListField,
	unionSingularField,
} from "../scripts/migrations/2026-09-04-merge-genre-duplicates.js";
import type { PendingReverse } from "../src/cache.js";
import type { GenreTaxonomy } from "../src/genre-taxonomy.js";
import { parseSlug } from "../src/slug.js";
import type { ArtistNode, EdgeRef, GenreNode } from "../src/types.js";

function artistNode(overrides: Partial<ArtistNode> = {}): ArtistNode {
	return {
		type: "artist",
		slug: "artist:test-artist",
		name: "Test Artist",
		editorial_bio: "A test artist bio.",
		editorial_article: "A real long article about the test artist. ".repeat(4),
		citations: [{ url: "https://example.com/test-artist", title: "Test Artist" }],
		materialized_at: new Date().toISOString(),
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

function genreNode(overrides: Partial<GenreNode> = {}): GenreNode {
	return {
		type: "genre",
		slug: "genre:test-genre",
		name: "Test Genre",
		editorial_definition: "A test genre definition.",
		editorial_article: "A real long article about the test genre. ".repeat(4),
		citations: [{ url: "https://example.com/test-genre", title: "Test Genre" }],
		materialized_at: new Date().toISOString(),
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

describe("electCanonical", () => {
	it("elects by usage count outright, even when the other member carries the catalog name (2026-09-10 reversal)", () => {
		const members: ElectionCandidate[] = [
			{ slug: "genre:electronic", name: "Electronic", usages: 179 },
			{ slug: "genre:electronic-music", name: "Electronic music", usages: 61 },
		];
		const result = electCanonical(members, "electronic music");
		expect(result.winner.slug).toBe("genre:electronic");
		expect(result.criterion).toBe("usage-count");
		expect(result.losers).toEqual([members[1]]);
	});

	it("at a tied usage count, the catalog name tiebreaks; then the shortest slug; then lex order", () => {
		const tiedByUsage: ElectionCandidate[] = [
			{ slug: "genre:foo", name: "Foo", usages: 5 },
			{ slug: "genre:bar", name: "Bar", usages: 5 },
		];
		// Catalog name targets "foo", which is lexicographically LATER than "bar" -- if lex
		// order (not the catalog name) had decided, "bar" would win instead, so this isolates
		// the catalog-name criterion from the lex-order one.
		expect(electCanonical(tiedByUsage, "foo").winner.slug).toBe("genre:foo");
		expect(electCanonical(tiedByUsage, "foo").criterion).toBe("catalog-name");

		const tiedByUsageAndName: ElectionCandidate[] = [
			{ slug: "genre:longer-slug", name: "A", usages: 5 },
			{ slug: "genre:short", name: "B", usages: 5 },
		];
		expect(electCanonical(tiedByUsageAndName, undefined).winner.slug).toBe("genre:short");
		expect(electCanonical(tiedByUsageAndName, undefined).criterion).toBe("slug-length");

		const tiedByEverything: ElectionCandidate[] = [
			{ slug: "genre:zzz", name: "A", usages: 5 },
			{ slug: "genre:aaa", name: "B", usages: 5 },
		];
		expect(electCanonical(tiedByEverything, undefined).winner.slug).toBe("genre:aaa");
		expect(electCanonical(tiedByEverything, undefined).criterion).toBe("slug-lex-order");
	});

	it("is deterministic: the same group in a different order elects the same winner", () => {
		const members: ElectionCandidate[] = [
			{ slug: "genre:electronic", name: "Electronic", usages: 179 },
			{ slug: "genre:electronic-music", name: "Electronic music", usages: 61 },
		];
		const forward = electCanonical(members, "electronic music");
		const reversed = electCanonical([...members].reverse(), "electronic music");
		expect(forward.winner.slug).toBe(reversed.winner.slug);
		expect(forward.criterion).toBe(reversed.criterion);

		// A true tie (same usages, no catalog match, same slug length) is the only case where
		// input order could actually matter -- order-independence must hold here too.
		const tied: ElectionCandidate[] = [
			{ slug: "genre:zzz", name: "A", usages: 5 },
			{ slug: "genre:aaa", name: "B", usages: 5 },
		];
		expect(electCanonical(tied, undefined).winner.slug).toBe("genre:aaa");
		expect(electCanonical([...tied].reverse(), undefined).winner.slug).toBe("genre:aaa");
	});

	// TRA-48: an existing redirect between two members wins outright, even against usages.
	it("criterion 0: an existing redirect to a group member wins even though usages favor the other member", () => {
		const members: ElectionCandidate[] = [
			{ slug: "genre:minimal", name: "Minimal", usages: 40 },
			{ slug: "genre:minimal-music", name: "Minimal music", usages: 2 },
		];
		const redirects = new Map([["genre:minimal", "genre:minimal-music"]]);
		const result = electCanonical(members, undefined, redirects);
		expect(result.winner.slug).toBe("genre:minimal-music");
		expect(result.criterion).toBe("existing-redirect");
		expect(result.losers).toEqual([members[0]]);
	});

	// Empty/absent table (default parameter): every pre-TRA-48 call site, this module's own
	// tests included, keeps behaving exactly as before.
	it("an empty (or absent) redirects table changes nothing -- usage-count still decides", () => {
		const members: ElectionCandidate[] = [
			{ slug: "genre:electronic", name: "Electronic", usages: 179 },
			{ slug: "genre:electronic-music", name: "Electronic music", usages: 61 },
		];
		expect(electCanonical(members, undefined, new Map()).criterion).toBe("usage-count");
		expect(electCanonical(members, undefined).winner.slug).toBe("genre:electronic");
	});

	it("throws an invariant error naming the conflicting targets when a group has two distinct existing-redirect targets", () => {
		const members: ElectionCandidate[] = [
			{ slug: "genre:a", name: "A", usages: 1 },
			{ slug: "genre:b", name: "B", usages: 1 },
			{ slug: "genre:c", name: "C", usages: 1 },
			{ slug: "genre:d", name: "D", usages: 1 },
		];
		const redirects = new Map([
			["genre:a", "genre:b"],
			["genre:c", "genre:d"],
		]);
		expect(() => electCanonical(members, undefined, redirects)).toThrow(
			/conflicting existing-redirect targets/,
		);
	});
});

describe("unionListField", () => {
	it("merges the winner's and loser's edges, deduplicated by slug, first occurrence wins", () => {
		const winnerList: EdgeRef[] = [{ slug: "genre:house", type: "genre", name: "House" }];
		const loserList: EdgeRef[] = [
			{ slug: "genre:house", type: "genre", name: "House (stale copy)" },
			{ slug: "genre:techno", type: "genre", name: "Techno" },
		];
		const merged = unionListField(winnerList, [loserList]);
		expect(merged).toEqual([
			{ slug: "genre:house", type: "genre", name: "House" },
			{ slug: "genre:techno", type: "genre", name: "Techno" },
		]);
	});
});

describe("unionSingularField", () => {
	it("keeps the canonical's value when present", () => {
		expect(unionSingularField("canonical-value", ["loser-value"])).toBe("canonical-value");
	});

	it("falls back to the first non-empty loser value when the canonical's is empty", () => {
		expect(unionSingularField(undefined, [undefined, "loser-value"])).toBe("loser-value");
	});
});

describe("mergeGenreEdges", () => {
	it("unions edge fields but keeps the canonical's editorial body untouched, never concatenated", () => {
		const winner = genreNode({
			slug: "genre:electronic-music",
			editorial_article: "Canonical article.",
			editorial_definition: "Canonical definition.",
			subgenres: [{ slug: "genre:house", type: "genre", name: "House" }],
		});
		const loser = genreNode({
			slug: "genre:electronic",
			editorial_article: "Loser article.",
			editorial_definition: "Loser definition.",
			subgenres: [
				{ slug: "genre:house", type: "genre", name: "House" },
				{ slug: "genre:techno", type: "genre", name: "Techno" },
			],
		});

		const merged = mergeGenreEdges(winner as unknown as Record<string, unknown>, [
			loser as unknown as Record<string, unknown>,
		]);

		expect(merged.editorial_article).toBe("Canonical article.");
		expect(merged.editorial_definition).toBe("Canonical definition.");
		expect(merged.subgenres).toEqual([
			{ slug: "genre:house", type: "genre", name: "House" },
			{ slug: "genre:techno", type: "genre", name: "Techno" },
		]);
	});

	it("drops a self-loop: a loser's edge pointing at the canonical itself doesn't survive the union", () => {
		const winner = genreNode({ slug: "genre:electronic", related_genres: [] });
		const loser = genreNode({
			slug: "genre:electronic-music",
			related_genres: [{ slug: "genre:electronic", type: "genre", name: "Electronic" }],
		});

		const merged = mergeGenreEdges(winner as unknown as Record<string, unknown>, [
			loser as unknown as Record<string, unknown>,
		]);

		expect(merged.related_genres).toEqual([]);
	});
});

describe("rewriteNodeEdges", () => {
	it("collapses a third-party node's references to both group members into one canonical reference", () => {
		const thirdParty = artistNode({
			genres: [
				{ slug: "genre:electronic", type: "genre", name: "Electronic" },
				{ slug: "genre:electronic-music", type: "genre", name: "Electronic music" },
			],
		});
		const rewriteMap = new Map([["genre:electronic", "genre:electronic-music"]]);

		const { node, hits } = rewriteNodeEdges(
			thirdParty as unknown as Record<string, unknown>,
			"artist",
			rewriteMap,
		);

		// Only the slug is rewritten (per contract); the first occurrence in the list wins the
		// dedupe, so the surviving entry keeps the first edge's own `name`.
		expect(node.genres).toEqual([{ slug: "genre:electronic-music", type: "genre", name: "Electronic" }]);
		expect(hits.get("genre:electronic")).toBe(1);
	});

	it("drops a self-loop: an edge that rewrites to the node's own slug doesn't survive", () => {
		const node = genreNode({
			slug: "genre:electronic",
			related_genres: [{ slug: "genre:electronic-music", type: "genre", name: "Electronic music" }],
		});
		const rewriteMap = new Map([["genre:electronic-music", "genre:electronic"]]);

		const { node: rewritten } = rewriteNodeEdges(
			node as unknown as Record<string, unknown>,
			"genre",
			rewriteMap,
		);

		expect(rewritten.related_genres).toEqual([]);
	});
});

describe("mergeRedirects", () => {
	it("flattens a chain: a -> b then b -> c becomes a -> c and b -> c", () => {
		const existing = { "genre:a": "genre:b" };
		const additions = { "genre:b": "genre:c" };
		const merged = mergeRedirects(existing, additions);
		expect(merged).toEqual({ "genre:a": "genre:c", "genre:b": "genre:c" });
	});

	it("never amputates a preexisting table when there are no new redirects", () => {
		const existing = { "genre:x": "genre:y", "genre:p": "genre:q" };
		const merged = mergeRedirects(existing, {});
		expect(merged).toEqual(existing);
	});

	it("never stores a value that is also a key", () => {
		const existing = { "genre:a": "genre:b" };
		const additions = { "genre:b": "genre:c", "genre:d": "genre:c" };
		const merged = mergeRedirects(existing, additions);
		const keys = new Set(Object.keys(merged));
		for (const value of Object.values(merged)) {
			expect(keys.has(value)).toBe(false);
		}
	});
});

describe("stillResolves", () => {
	it("a slug that is not a redirect key resolves to itself", () => {
		expect(stillResolves("genre:x", {}, new Set(["genre:x"]))).toBe(true);
		expect(stillResolves("genre:x", {}, new Set(["genre:y"]))).toBe(false);
	});

	it("follows a single redirect hop to its target when the key itself is no longer a live node", () => {
		const redirects = { "genre:old": "genre:new" };
		expect(stillResolves("genre:old", redirects, new Set(["genre:new"]))).toBe(true);
		expect(stillResolves("genre:old", redirects, new Set(["genre:unrelated"]))).toBe(false);
	});

	it("an existing node wins over a stale redirect entry (resolveReadSlug's rule 2)", () => {
		// A crash between writing redirects.json and deleting losers can leave a slug with both
		// its own file and a redirect to a now-vanished target -- the file must still win.
		const redirects = { "genre:old": "genre:gone" };
		expect(stillResolves("genre:old", redirects, new Set(["genre:old"]))).toBe(true);
	});
});

describe("rewritePendingReverses", () => {
	it("rewrites a loser key to its canonical, merging with any list already there, and rewrites edge.slug too", () => {
		const pending = {
			"genre:electronic": [
				{
					field: "genres",
					cardinality: "list" as const,
					edge: { slug: "artist:someone" as const, type: "artist" as const, name: "Someone" },
				},
			],
			"genre:electronic-music": [
				{
					field: "genres",
					cardinality: "list" as const,
					edge: { slug: "artist:someone-else" as const, type: "artist" as const, name: "Someone Else" },
				},
			],
			"artist:third-party": [
				{
					field: "genres",
					cardinality: "list" as const,
					// This entry's own edge points at a loser too -- both key and edge.slug rewrites
					// must apply independently in the same pass.
					edge: { slug: "genre:electronic" as const, type: "genre" as const, name: "Electronic" },
				},
			],
		} satisfies Record<string, PendingReverse[]>;
		const rewriteMap = new Map([["genre:electronic", "genre:electronic-music"]]);

		const { result, changed } = rewritePendingReverses(pending, rewriteMap);

		expect(changed).toBe(true);
		expect(result["genre:electronic"]).toBeUndefined();
		expect(result["genre:electronic-music"]).toHaveLength(2);
		expect(result["artist:third-party"]?.[0]?.edge.slug).toBe("genre:electronic-music");
	});

	it("reports no change when nothing in the table touches a loser slug", () => {
		const pending = {
			"artist:untouched": [
				{
					field: "genres",
					cardinality: "list" as const,
					edge: { slug: "genre:techno" as const, type: "genre" as const, name: "Techno" },
				},
			],
		} satisfies Record<string, PendingReverse[]>;
		const { changed } = rewritePendingReverses(
			pending,
			new Map([["genre:electronic", "genre:electronic-music"]]),
		);
		expect(changed).toBe(false);
	});
});

describe("loadOnboardingGenreSlugs", () => {
	it("extracts exactly the 34 slugs from the real web/index.html, all present in cache/nodes/genre", async () => {
		const slugs = await loadOnboardingGenreSlugs();
		expect(slugs).toHaveLength(34);
		expect(new Set(slugs).size).toBe(34);
		for (const slug of slugs) {
			await expect(
				readFile(`cache/nodes/genre/${slug.slice("genre:".length)}.json`, "utf8"),
			).resolves.toBeTruthy();
		}
	});

	it("throws instead of returning an empty list when the regex no longer matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "odyssey-onboarding-"));
		const path = join(dir, "index.html");
		try {
			await writeFile(path, 'const ONBOARDING_GENRES = Object.freeze(["genre:electronic"]);', "utf8");
			await expect(loadOnboardingGenreSlugs(path)).rejects.toThrow(/no ONBOARDING_GENRES slugs found/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("runMigration (disk integration)", () => {
	let dir: string;
	let redirectsPath: string;
	const catalogNames = new Map([["Q1", "electronic music"]]);

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-genre-merge-"));
		redirectsPath = join(dir, "genre-redirects.json");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeNodeFile(node: GenreNode | ArtistNode): Promise<string> {
		const { type, body } = parseSlug(node.slug);
		const path = join(dir, "nodes", type, `${body}.json`);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(node, null, 2)}\n`, "utf8");
		return path;
	}

	async function writePendingReversesFile(content: Record<string, unknown>): Promise<string> {
		const path = join(dir, "pending-reverses.json");
		await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, "utf8");
		return path;
	}

	// "genre:electronic" wins by usage count alone (2 referrers vs. 0 for the loser).
	async function seedElectronicGroup(): Promise<{ loserPath: string; artistPath: string }> {
		await writeNodeFile(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q1" }));
		const loserPath = await writeNodeFile(
			genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q1" }),
		);
		await writeNodeFile(
			artistNode({
				slug: "artist:booster-1",
				genres: [{ slug: "genre:electronic", type: "genre", name: "Electronic" }],
			}),
		);
		await writeNodeFile(
			artistNode({
				slug: "artist:booster-2",
				genres: [{ slug: "genre:electronic", type: "genre", name: "Electronic" }],
			}),
		);
		const artistPath = await writeNodeFile(
			artistNode({ genres: [{ slug: "genre:electronic-music", type: "genre", name: "Electronic music" }] }),
		);
		return { loserPath, artistPath };
	}

	it("dry-run computes the plan but leaves every file byte-identical, including a preexisting redirects table", async () => {
		const { loserPath, artistPath } = await seedElectronicGroup();
		await writeFile(redirectsPath, JSON.stringify({ redirects: {} }), "utf8");
		const before = {
			loser: await readFile(loserPath, "utf8"),
			artist: await readFile(artistPath, "utf8"),
			redirects: await readFile(redirectsPath, "utf8"),
		};

		const result = await runMigration(dir, false, { catalogNames, redirectsPath });

		expect(result.exitCode).toBe(0);
		expect(result.groupsFound).toBe(1);
		expect(result.report).toContain("DRY RUN");
		expect(await readFile(loserPath, "utf8")).toBe(before.loser);
		expect(await readFile(artistPath, "utf8")).toBe(before.artist);
		expect(await readFile(redirectsPath, "utf8")).toBe(before.redirects);
	});

	it("--apply deletes the loser, rewrites incoming edges (list and singular) and pending-reverses, and a second --apply is a no-op", async () => {
		const { loserPath, artistPath } = await seedElectronicGroup();
		const pendingPath = await writePendingReversesFile({
			"genre:electronic-music": [
				{
					field: "genres",
					cardinality: "list",
					edge: { slug: "artist:pending-someone", type: "artist", name: "Pending Someone" },
				},
			],
		});

		const first = await runMigration(dir, true, { catalogNames, redirectsPath });
		expect(first.exitCode).toBe(0);
		expect(first.deletedCount).toBe(1);
		expect(first.report).not.toContain("DRY RUN");
		expect(first.report).toContain("artist");

		await expect(readFile(loserPath, "utf8")).rejects.toThrow();

		const artistRaw = JSON.parse(await readFile(artistPath, "utf8")) as ArtistNode;
		expect(artistRaw.genres.map((e) => e.slug)).toEqual(["genre:electronic"]);

		const pending = JSON.parse(await readFile(pendingPath, "utf8")) as Record<string, unknown>;
		expect(pending["genre:electronic-music"]).toBeUndefined();
		expect(pending["genre:electronic"]).toBeDefined();

		const redirectsAfterFirst = JSON.parse(await readFile(redirectsPath, "utf8")) as {
			redirects: Record<string, string>;
		};
		expect(redirectsAfterFirst.redirects).toEqual({ "genre:electronic-music": "genre:electronic" });

		const second = await runMigration(dir, true, { catalogNames, redirectsPath });
		expect(second.exitCode).toBe(0);
		expect(second.deletedCount).toBe(0);
		expect(second.groupsFound).toBe(0);

		const redirectsAfterSecond = JSON.parse(await readFile(redirectsPath, "utf8")) as {
			redirects: Record<string, string>;
		};
		expect(redirectsAfterSecond.redirects).toEqual({ "genre:electronic-music": "genre:electronic" });
	});

	it("invariant: after a real --apply, no edge.slug anywhere in the cache points at a deleted file", async () => {
		// End-to-end confirmation of rewriteNodeEdges's own guarantee (unit-tested above): no
		// black-box fixture can violate this without a bug in that function itself.
		const { loserPath } = await seedElectronicGroup();
		const result = await runMigration(dir, true, { catalogNames, redirectsPath });
		expect(result.exitCode).toBe(0);

		const { nodes } = await readCacheNodes(dir);
		const remainingSlugs = new Set(nodes.map((n) => n.slug));
		const edgeFields = ["genres", "parent_genres", "subgenres", "related_genres"];
		for (const file of nodes) {
			for (const field of edgeFields) {
				const list = file.node[field];
				if (!Array.isArray(list)) continue;
				for (const edge of list) {
					const slug = edge && typeof edge === "object" ? (edge as Record<string, unknown>).slug : undefined;
					if (typeof slug === "string") expect(remainingSlugs.has(slug)).toBe(true);
				}
			}
		}
		await expect(readFile(loserPath, "utf8")).rejects.toThrow();
	});

	it("invariant: a corrupted existing redirects table (fails parseGenreRedirects) exits 1 without writing", async () => {
		// A table that already violates the flatten invariant on its own (a value that is also
		// a key) fails at load time, unrelated to any group's own election. (TRA-48: the old
		// fixture here seeded a redirect directly between the seeded group's own members,
		// expecting it to combine into a cycle -- the existing-redirect criterion now makes
		// election converge to such a table instead, so it no longer reproduces this failure.)
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:foo": "genre:bar", "genre:bar": "genre:baz" } }),
			"utf8",
		);
		const { loserPath } = await seedElectronicGroup();

		const result = await runMigration(dir, true, { catalogNames, redirectsPath });

		expect(result.exitCode).toBe(1);
		await expect(readFile(loserPath, "utf8")).resolves.toBeTruthy();
	});

	it("TRA-48: an existing redirect converges the election on --apply, and leaves the table unchanged", async () => {
		// The prod regression, reproduced: "electronic" has the higher usage count (2 vs. 1),
		// but the table already redirects it to "electronic-music" -- apply must elect
		// "electronic-music", delete "electronic", and add no new redirect entry.
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:electronic": "genre:electronic-music" } }),
			"utf8",
		);
		const { loserPath: survivorPath } = await seedElectronicGroup();
		const nowDeletedPath = join(dir, "nodes", "genre", "electronic.json");

		// "genre:electronic" is a real ONBOARDING_GENRES entry -- irrelevant here, so pass an
		// empty list rather than trip that unrelated invariant now that it's the one deleted.
		const result = await runMigration(dir, true, { catalogNames, redirectsPath, onboardingSlugs: [] });

		expect(result.exitCode).toBe(0);
		expect(result.report).toContain("winner=genre:electronic-music");
		expect(result.report).toContain("criterion=existing-redirect");
		await expect(readFile(nowDeletedPath, "utf8")).rejects.toThrow();
		await expect(readFile(survivorPath, "utf8")).resolves.toBeTruthy();

		const after = JSON.parse(await readFile(redirectsPath, "utf8")) as { redirects: Record<string, string> };
		expect(after.redirects).toEqual({ "genre:electronic": "genre:electronic-music" });
		const counts = result.report.match(/Redirects \(new\/total\):\s*(\d+)\/(\d+)/);
		expect(counts?.slice(1)).toEqual(["1", "1"]);
	});

	it("invariant: two distinct existing-redirect targets in one group exits 1 without writing anything", async () => {
		for (const slug of ["genre:a", "genre:b", "genre:c", "genre:d"] as const) {
			await writeNodeFile(genreNode({ slug, name: slug, qid: "Q99" }));
		}
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:a": "genre:b", "genre:c": "genre:d" } }),
			"utf8",
		);
		const before = new Map<string, string>();
		for (const slug of ["a", "b", "c", "d"]) {
			before.set(slug, await readFile(join(dir, "nodes", "genre", `${slug}.json`), "utf8"));
		}
		const redirectsBefore = await readFile(redirectsPath, "utf8");

		const result = await runMigration(dir, true, { catalogNames: new Map(), redirectsPath });

		expect(result.exitCode).toBe(1);
		for (const slug of ["a", "b", "c", "d"]) {
			expect(await readFile(join(dir, "nodes", "genre", `${slug}.json`), "utf8")).toBe(before.get(slug));
		}
		expect(await readFile(redirectsPath, "utf8")).toBe(redirectsBefore);
	});

	it("invariant: a truncated pending-reverses.json exits 1 without writing anything (crash-safety)", async () => {
		// Regression: pending-reverses.json used to be parsed AFTER the losers were deleted.
		const { loserPath, artistPath } = await seedElectronicGroup();
		const pendingPath = await writePendingReversesFile({ "artist:x": [] });
		await writeFile(pendingPath, '{"artist:x": [', "utf8");
		const before = {
			loser: await readFile(loserPath, "utf8"),
			artist: await readFile(artistPath, "utf8"),
			pending: await readFile(pendingPath, "utf8"),
		};

		const result = await runMigration(dir, true, { catalogNames, redirectsPath });

		expect(result.exitCode).toBe(1);
		expect(await readFile(loserPath, "utf8")).toBe(before.loser);
		expect(await readFile(artistPath, "utf8")).toBe(before.artist);
		expect(await readFile(pendingPath, "utf8")).toBe(before.pending);
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("invariant: an onboarding slug that would be the loser exits 1 without writing (2026-09-10 regression)", async () => {
		await writeNodeFile(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q1" }));
		const loserPath = await writeNodeFile(
			genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q1" }),
		);
		// One referrer is enough to give "electronic-music" more usages than "electronic" (0).
		await writeNodeFile(
			artistNode({ genres: [{ slug: "genre:electronic-music", type: "genre", name: "Electronic music" }] }),
		);

		const result = await runMigration(dir, true, {
			catalogNames: new Map(),
			redirectsPath,
			onboardingSlugs: ["genre:electronic"],
		});

		expect(result.exitCode).toBe(1);
		await expect(readFile(loserPath, "utf8")).resolves.toBeTruthy();
		await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
	});

	it("keeps every ONBOARDING_GENRES slug alive across the groups it belongs to (happy path)", async () => {
		const onboardingSlugs = ["genre:electronic", "genre:idm", "genre:ambient"];
		for (const [short, long, qid] of [
			["genre:electronic", "genre:electronic-music", "Q1"],
			["genre:idm", "genre:intelligent-dance-music", "Q2"],
			["genre:ambient", "genre:ambient-music", "Q3"],
		] as const) {
			await writeNodeFile(genreNode({ slug: short, name: "Short", qid }));
			await writeNodeFile(genreNode({ slug: long, name: "Long", qid }));
			await writeNodeFile(
				artistNode({
					slug: `artist:booster-${qid}`,
					genres: [{ slug: short, type: "genre", name: "Short" }],
				}),
			);
		}

		const result = await runMigration(dir, true, { catalogNames: new Map(), redirectsPath, onboardingSlugs });

		expect(result.exitCode).toBe(0);
		expect(result.groupsFound).toBe(3);
		const { nodes } = await readCacheNodes(dir);
		const remainingSlugs = new Set(nodes.map((n) => n.slug));
		for (const slug of onboardingSlugs) expect(remainingSlugs.has(slug)).toBe(true);
	});

	describe("taxonomy protection (TRA-138, D6a)", () => {
		function publishedTaxonomy(sourceSlugs: GenreTaxonomy["genres"][number]["sourceSlugs"]): GenreTaxonomy {
			return {
				version: 2,
				families: [{ key: "electronic", label: "Electronic", order: 0 }],
				genres: [
					{ id: "local:test-genre", name: "Test Genre", family: "electronic", published: true, sourceSlugs },
				],
			};
		}

		it("refuses a merge that would lose a published source with no redirect covering it", async () => {
			const { loserPath } = await seedElectronicGroup();
			// "genre:phantom" is declared as a source but was never written to this cache -- it
			// can never resolve, with or without this merge (taxonomy/cache drift).
			const taxonomy = publishedTaxonomy(["genre:phantom"]);

			const result = await runMigration(dir, true, { catalogNames, redirectsPath, taxonomy });

			expect(result.exitCode).toBe(1);
			await expect(readFile(loserPath, "utf8")).resolves.toBeTruthy();
		});

		it("accepts a safe merge where the published source becomes a loser but redirects to the winner", async () => {
			const { loserPath } = await seedElectronicGroup();
			const taxonomy = publishedTaxonomy(["genre:electronic-music"]);

			const result = await runMigration(dir, true, { catalogNames, redirectsPath, taxonomy });

			expect(result.exitCode).toBe(0);
			await expect(readFile(loserPath, "utf8")).rejects.toThrow();
		});

		it("refuses when this run's redirect table leaves an already-protected old slug unresolved", async () => {
			// Corruption/drift case: a prior merge's redirect key survives in the table, but its
			// target was never written to this cache -- the merge under test doesn't touch it,
			// so nothing else in runMigration would otherwise notice.
			await writeFile(
				redirectsPath,
				JSON.stringify({ redirects: { "genre:stale": "genre:vanished" } }),
				"utf8",
			);
			await seedElectronicGroup();
			const taxonomy: GenreTaxonomy = { version: 2, families: [], genres: [] };

			const result = await runMigration(dir, true, { catalogNames, redirectsPath, taxonomy });

			expect(result.exitCode).toBe(1);
		});

		it("keeps v1's stricter literal rule in force even with a valid, non-conflicting taxonomy present", async () => {
			await writeNodeFile(genreNode({ slug: "genre:electronic", name: "Electronic", qid: "Q1" }));
			const loserPath = await writeNodeFile(
				genreNode({ slug: "genre:electronic-music", name: "Electronic music", qid: "Q1" }),
			);
			await writeNodeFile(
				artistNode({ genres: [{ slug: "genre:electronic-music", type: "genre", name: "Electronic music" }] }),
			);
			// Untouched by this merge, and present on disk, so the taxonomy check stays silent --
			// isolating v1's own refusal below from the taxonomy-era one.
			await writeNodeFile(genreNode({ slug: "genre:unrelated", name: "Unrelated", qid: "Q99" }));
			const taxonomy = publishedTaxonomy(["genre:unrelated"]);

			const result = await runMigration(dir, true, {
				catalogNames: new Map(),
				redirectsPath,
				onboardingSlugs: ["genre:electronic"],
				taxonomy,
			});

			expect(result.exitCode).toBe(1);
			await expect(readFile(loserPath, "utf8")).resolves.toBeTruthy();
		});

		it("refuses explicitly when both ONBOARDING_GENRES and the genre taxonomy are unavailable", async () => {
			const { loserPath } = await seedElectronicGroup();
			// A file that exists but no longer declares ONBOARDING_GENRES as a plain array literal
			// (D3, TRA-211) -- the "retired on purpose" shape, not a missing/unreadable file.
			const webIndexPath = join(dir, "no-onboarding.html");
			await writeFile(webIndexPath, 'const ONBOARDING_GENRES = Object.freeze(["genre:electronic"]);', "utf8");

			const result = await runMigration(dir, true, {
				catalogNames,
				redirectsPath,
				webIndexPath,
				taxonomyPath: join(dir, "no-such-taxonomy.json"),
			});

			expect(result.exitCode).toBe(1);
			await expect(readFile(loserPath, "utf8")).resolves.toBeTruthy();
			await expect(readFile(redirectsPath, "utf8")).rejects.toThrow();
		});

		it("still fails loudly on an unexpected ONBOARDING_GENRES load error, not just a retired constant", async () => {
			await seedElectronicGroup();
			// A directory where a file is expected -- readFile rejects with EISDIR, a shape
			// distinct from loadOnboardingGenreSlugs's own "no slugs found" retirement signal.
			await expect(
				runMigration(dir, true, { catalogNames, redirectsPath, webIndexPath: dir }),
			).rejects.toThrow();
		});

		it("refuses explicitly when the taxonomy file exists but is invalid, via the real loader", async () => {
			const { loserPath } = await seedElectronicGroup();
			const taxonomyPath = join(dir, "bad-taxonomy.json");
			await writeFile(
				taxonomyPath,
				JSON.stringify({
					version: 2,
					families: [
						{ key: "dup", label: "Dup", order: 0 },
						{ key: "dup", label: "Dup 2", order: 1 },
					],
					genres: [],
				}),
				"utf8",
			);

			const result = await runMigration(dir, true, { catalogNames, redirectsPath, taxonomyPath });

			expect(result.exitCode).toBe(1);
			await expect(readFile(loserPath, "utf8")).resolves.toBeTruthy();
		});
	});
});

describe("parseCliArgs", () => {
	it("rejects a missing cache-dir instead of defaulting", () => {
		expect(parseCliArgs([])).toBeNull();
	});

	it("rejects a flag standing in for the positional cache-dir", () => {
		expect(parseCliArgs(["--apply"])).toBeNull();
	});

	it("parses the positional cache-dir, the --apply flag, and an optional --redirects path", () => {
		expect(parseCliArgs(["cache"])).toEqual({ cacheDir: "cache", apply: false });
		expect(parseCliArgs(["cache", "--apply"])).toEqual({ cacheDir: "cache", apply: true });
		expect(parseCliArgs(["cache", "--redirects", "data/genre-redirects.json"])).toEqual({
			cacheDir: "cache",
			apply: false,
			redirectsPath: "data/genre-redirects.json",
		});
	});

	it("rejects --redirects with no path, or a path that's actually another flag", () => {
		expect(parseCliArgs(["cache", "--redirects"])).toBeNull();
		expect(parseCliArgs(["cache", "--redirects", "--apply"])).toBeNull();
	});

	it("rejects any unrecognized flag", () => {
		expect(parseCliArgs(["cache", "--dry-run"])).toBeNull();
		expect(parseCliArgs(["cache", "--aply"])).toBeNull();
	});

	it("rejects a stray extra positional (e.g. a redirects path typed without --redirects)", () => {
		// Regression: this used to silently become { cacheDir: "cache", apply: true },
		// discarding "data/genre-redirects.json" and applying with the default redirects path.
		expect(parseCliArgs(["cache", "data/genre-redirects.json", "--apply"])).toBeNull();
	});

	it("rejects a repeated --redirects flag instead of silently using the first", () => {
		expect(parseCliArgs(["cache", "--redirects", "a.json", "--redirects", "b.json"])).toBeNull();
	});
});

describe("looksLikeCacheDir", () => {
	it("discriminates a real (even if empty) cache directory from a missing or malformed one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "odyssey-cachedir-check-"));
		try {
			// Regression: main() used to let a missing/typo'd cache-dir through to runMigration,
			// which reported "0 groups" -- indistinguishable from a genuinely idempotent rerun.
			expect(await looksLikeCacheDir(join(dir, "does-not-exist"))).toBe(false);
			await mkdir(join(dir, "empty-cache", "nodes"), { recursive: true });
			expect(await looksLikeCacheDir(join(dir, "empty-cache"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
