import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	DETACH,
	formatSummary,
	MIGRATION_NAME,
	parseCliArgs,
	planFix,
	REWRITE,
	runMigration,
} from "../scripts/migrations/2026-10-24-rewrite-artist-redirect-key-edges.js";
import { LIST_EDGES_BY_TYPE } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";

// TRA-672: detach Mulligan -> Birth of the Cool and rewrite the eleven artist edges that sit on a redirect
// key. Each acceptance criterion of the ticket is a test here; the migration runs on small fixtures only.

type Obj = Record<string, unknown>;

const dirs: string[] = [];
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const edge = (slug: string, name: string, extra: Obj = {}): Obj => ({
	slug,
	type: parseSlug(slug).type,
	name,
	...extra,
});

function artist(slug: string, fields: Obj = {}): Obj {
	return {
		slug,
		name: slug.slice("artist:".length),
		type: "artist",
		editorial_article: "x".repeat(100),
		citations: [{ url: "https://example.com/a", title: "a" }],
		materialized_at: "2026-10-16T00:00:00.000Z",
		editorial_bio: "bio",
		...Object.fromEntries(LIST_EDGES_BY_TYPE.artist.map((f) => [f, []])),
		...fields,
	};
}

function writeNode(cacheDir: string, n: Obj): string {
	const { type, body } = parseSlug(n.slug as string);
	const path = join(cacheDir, "nodes", type, `${body}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(n, null, 2)}\n`);
	return path;
}

const readNode = (path: string): Obj => JSON.parse(readFileSync(path, "utf8")) as Obj;

/** The committed table: the pairs of the migration are checked against it, as the channel does. */
const committed = (
	JSON.parse(readFileSync(resolve("data/slug-redirects.json"), "utf8")) as {
		redirects: Record<string, string>;
	}
).redirects;
const table = new Map<string, string>(REWRITE.map((r) => [r.from, r.to]));

function dataDirWith(redirects: Record<string, string>): string {
	const dir = tmp("redirect-table-");
	writeFileSync(join(dir, "slug-redirects.json"), JSON.stringify({ redirects }));
	return dir;
}

/** A cache with every artist of the list in the state main has today (edges on the keys). */
function repoLikeCache(): { dir: string; paths: Map<string, string> } {
	const dir = join(tmp("rewrite-edges-"), "cache");
	const paths = new Map<string, string>();
	const byArtist = new Map<string, Obj>();
	for (const r of REWRITE) {
		const node = byArtist.get(r.artist) ?? artist(r.artist);
		const e = edge(r.from, r.from.split(":")[1] ?? "", { mbid: "00000000-0000-0000-0000-000000000000" });
		if (Array.isArray(node[r.field])) (node[r.field] as Obj[]).push(e);
		else node[r.field] = e;
		byArtist.set(r.artist, node);
	}
	const mulligan = byArtist.get("artist:gerry-mulligan") ?? artist("artist:gerry-mulligan");
	mulligan.discography = [
		edge("project:re-birth-of-the-cool--gerry-mulligan", "Re-Birth of the Cool", { year: "1992" }),
		edge("project:birth-of-the-cool", "Birth of the Cool"),
		edge("project:mullenium--gerry-mulligan", "Mullenium", { year: "1998" }),
	];
	byArtist.set("artist:gerry-mulligan", mulligan);
	byArtist.set(
		"artist:bystander",
		artist("artist:bystander", { discography: [edge("project:heresy", "Heresy")] }),
	);
	for (const [slug, node] of byArtist) paths.set(slug, writeNode(dir, node));
	return { dir, paths };
}

async function load(dir: string) {
	const { readCacheNodes } = await import("../scripts/migrations/2026-09-04-merge-genre-duplicates.js");
	return (await readCacheNodes(dir)).nodes;
}

describe("the closed list (criterion: the 12 edges of TRA-598)", () => {
	it("detaches exactly one edge and rewrites eleven", () => {
		expect(DETACH).toHaveLength(1);
		expect(REWRITE).toHaveLength(11);
	});

	it("every rewrite goes where the committed slug-redirects.json sends its key", () => {
		for (const r of REWRITE) expect(committed[r.from], `${r.artist} ${r.field}`).toBe(r.to);
	});

	it("the detached key is a redirect key of the committed table (it is the misdirected case)", () => {
		expect(committed["project:birth-of-the-cool"]).toBe("project:birth-of-the-cool--miles-davis");
	});
});

describe("thresholds (criterion: the ceiling falls from 1 to 0)", () => {
	it("artist-edge-to-redirect-key has no allowance left on any of its four fields", () => {
		const thresholds = JSON.parse(readFileSync(resolve("data/integrity-thresholds.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(thresholds["artist-edge-to-redirect-key"]).toEqual({
			discography: 0,
			notable_tracks: 0,
			landmark_project: 0,
			reference_track: 0,
		});
	});
});

describe("planFix", () => {
	it("detaches the Mulligan edge and keeps his other releases, in order", async () => {
		const { dir, paths } = repoLikeCache();
		const plan = planFix(await load(dir), table);
		const next = plan.writes.get(paths.get("artist:gerry-mulligan") as string) as Obj;
		expect((next.discography as Obj[]).map((e) => e.slug)).toEqual([
			"project:re-birth-of-the-cool--gerry-mulligan",
			"project:mullenium--gerry-mulligan",
		]);
	});

	it("rewrites a list edge and a single edge to the canonical slug, nothing else of the edge changes", async () => {
		const { dir, paths } = repoLikeCache();
		const plan = planFix(await load(dir), table);
		const lustmord = plan.writes.get(paths.get("artist:lustmord") as string) as Obj;
		expect(lustmord.discography).toEqual([
			edge("project:heresy--lustmord", "heresy", { mbid: "00000000-0000-0000-0000-000000000000" }),
		]);
		expect(lustmord.landmark_project).toEqual(
			edge("project:heresy--lustmord", "heresy", { mbid: "00000000-0000-0000-0000-000000000000" }),
		);
		const hawtin = plan.writes.get(paths.get("artist:richie-hawtin") as string) as Obj;
		expect((hawtin.notable_tracks as Obj[]).map((e) => e.slug)).toEqual(["track:spastik--plastikman"]);
	});

	it("writes the 8 artists of the list and not the bystander, even if it holds the same key", async () => {
		const { dir, paths } = repoLikeCache();
		const plan = planFix(await load(dir), table);
		expect(plan.manifest.written).toBe(8);
		expect(plan.writes.has(paths.get("artist:bystander") as string)).toBe(false);
		expect(plan.manifest.counts).toEqual({ done: 12, merged: 0, "already-done": 0, flagged: 0 });
	});

	it("writes nothing when the edge no longer holds exactly the expected key, and says so", async () => {
		const { dir, paths } = repoLikeCache();
		// Someone already scoped the edge on another slug: not the key, not the canonical slug either.
		writeNode(
			dir,
			artist("artist:lustmord", {
				discography: [edge("project:heresy--1990-ambient-album-by-lustmord", "Heresy")],
				landmark_project: edge("project:heresy--lustmord", "Heresy"),
			}),
		);
		const plan = planFix(await load(dir), table);
		expect(plan.writes.has(paths.get("artist:lustmord") as string)).toBe(false);
		const flagged = plan.manifest.flagged.map((a) => `${a.artist} ${a.field}`);
		expect(flagged).toEqual(["artist:lustmord discography"]);
		expect(plan.manifest.counts["already-done"]).toBe(1);
	});

	it("does not touch an edge whose slug merely contains the key", async () => {
		const { dir, paths } = repoLikeCache();
		writeNode(
			dir,
			artist("artist:basic-channel", {
				discography: [edge("project:bcd-2--compilation-album-by-basic-channel-2008", "BCD-2")],
			}),
		);
		const plan = planFix(await load(dir), table);
		expect(plan.writes.has(paths.get("artist:basic-channel") as string)).toBe(false);
		expect(plan.manifest.flagged.map((a) => a.artist)).toEqual(["artist:basic-channel"]);
	});

	it("drops the stale edge instead of duplicating when the canonical slug is already there", async () => {
		const { dir, paths } = repoLikeCache();
		writeNode(
			dir,
			artist("artist:ub40", {
				discography: [
					edge("project:promises-and-lies", "Promises and Lies"),
					edge("project:promises-and-lies--ub40", "Promises and Lies"),
					edge("project:labour-of-love", "Labour of Love"),
				],
			}),
		);
		const plan = planFix(await load(dir), table);
		const ub40 = plan.writes.get(paths.get("artist:ub40") as string) as Obj;
		expect((ub40.discography as Obj[]).map((e) => e.slug)).toEqual([
			"project:promises-and-lies--ub40",
			"project:labour-of-love--ub40",
		]);
		expect(plan.manifest.counts.merged).toBe(1);
	});

	it("flags a key that is a live node of the cache (it wins over the redirect), for a rewrite and for the detach", async () => {
		const { dir, paths } = repoLikeCache();
		writeNode(dir, { ...artist("artist:x"), slug: "project:heresy", type: "project", name: "Heresy" });
		writeNode(dir, {
			...artist("artist:y"),
			slug: "project:birth-of-the-cool",
			type: "project",
			name: "BotC",
		});
		const plan = planFix(await load(dir), table);
		expect(plan.writes.has(paths.get("artist:lustmord") as string)).toBe(false);
		expect(plan.writes.has(paths.get("artist:gerry-mulligan") as string)).toBe(false);
		expect(plan.manifest.flagged.map((a) => `${a.artist} ${a.field}`)).toEqual([
			"artist:gerry-mulligan discography",
			"artist:lustmord discography",
			"artist:lustmord landmark_project",
		]);
	});

	it("flags a key held twice and writes nothing for it", async () => {
		const { dir, paths } = repoLikeCache();
		writeNode(
			dir,
			artist("artist:jan-jelinek", {
				discography: [edge("project:tierbeobachtungen", "T"), edge("project:tierbeobachtungen", "T")],
			}),
		);
		const plan = planFix(await load(dir), table);
		expect(plan.writes.has(paths.get("artist:jan-jelinek") as string)).toBe(false);
		expect(plan.manifest.flagged).toHaveLength(1);
	});

	it("flags an entry when the redirect table no longer sends the key to the expected target", async () => {
		const { dir, paths } = repoLikeCache();
		const drifted = new Map(table);
		drifted.set("project:heresy", "project:heresy--someone-else");
		const plan = planFix(await load(dir), drifted);
		expect(plan.writes.has(paths.get("artist:lustmord") as string)).toBe(false);
		expect(plan.manifest.flagged.map((a) => `${a.field}`)).toEqual(["discography", "landmark_project"]);
	});

	it("flags an artist missing from the cache instead of failing", async () => {
		const { dir } = repoLikeCache();
		rmSync(join(dir, "nodes", "artist", "ub40.json"));
		const plan = planFix(await load(dir), table);
		expect(plan.manifest.flagged.map((a) => a.artist)).toEqual(["artist:ub40", "artist:ub40"]);
		expect(plan.manifest.errors).toEqual([]);
	});

	it("refuses the whole run when a node to write would no longer be valid", async () => {
		const { dir } = repoLikeCache();
		writeNode(
			dir,
			artist("artist:lustmord", {
				editorial_article: "too short",
				discography: [edge("project:heresy", "H")],
			}),
		);
		const plan = planFix(await load(dir), table);
		expect(plan.manifest.errors.some((e) => e.startsWith("artist:lustmord: refusing"))).toBe(true);
		expect(plan.writes.has(join(dir, "nodes", "artist", "lustmord.json"))).toBe(false);
	});
});

describe("runMigration", () => {
	it("a dry-run reports and writes nothing", async () => {
		const { dir, paths } = repoLikeCache();
		const before = [...paths.values()].map((p) => readFileSync(p, "utf8"));
		const { manifest, exitCode } = await runMigration({
			cacheDir: dir,
			apply: false,
			dataDir: dataDirWith(committedFor()),
		});
		expect(exitCode).toBe(0);
		expect(manifest.mode).toBe("dry-run");
		expect(manifest.written).toBe(8);
		expect([...paths.values()].map((p) => readFileSync(p, "utf8"))).toEqual(before);
	});

	it("--apply writes, and a second run is idempotent (written === 0, nothing flagged)", async () => {
		const { dir, paths } = repoLikeCache();
		const dataDir = dataDirWith(committedFor());
		const first = await runMigration({ cacheDir: dir, apply: true, dataDir });
		expect(first.manifest.written).toBe(8);
		const after = [...paths.values()].map((p) => readFileSync(p, "utf8"));
		const second = await runMigration({ cacheDir: dir, apply: true, dataDir });
		expect(second.manifest.written).toBe(0);
		expect(second.manifest.flagged).toEqual([]);
		expect(second.manifest.counts["already-done"]).toBe(12);
		expect([...paths.values()].map((p) => readFileSync(p, "utf8"))).toEqual(after);
	});

	it("the diff of a node is its edges: every other key and its order survive", async () => {
		const { dir, paths } = repoLikeCache();
		const path = paths.get("artist:ub40") as string;
		const before = readNode(path);
		await runMigration({ cacheDir: dir, apply: true, dataDir: dataDirWith(committedFor()) });
		const after = readNode(path);
		expect(Object.keys(after)).toEqual(Object.keys(before));
		const { discography: a, ...restAfter } = after;
		const { discography: b, ...restBefore } = before;
		expect(restAfter).toEqual(restBefore);
		expect(a).not.toEqual(b);
	});

	it("refuses an explicit data dir without its slug table", async () => {
		const { dir } = repoLikeCache();
		await expect(runMigration({ cacheDir: dir, apply: false, dataDir: tmp("empty-data-") })).rejects.toThrow(
			/redirect table not found/,
		);
	});

	it("the manifest honours the channel contract and the summary names what was flagged", async () => {
		const { dir } = repoLikeCache();
		const manifestPath = join(tmp("manifest-"), "m.json");
		const { manifest } = await runMigration({
			cacheDir: dir,
			apply: true,
			manifestPath,
			dataDir: dataDirWith({}),
		});
		const written = JSON.parse(readFileSync(manifestPath, "utf8")) as Obj;
		expect(written.migration).toBe(MIGRATION_NAME);
		expect(written.removed).toEqual([]);
		expect(written.renamed).toEqual({});
		expect(written.redirects).toEqual({});
		// An empty table agrees with no pair: the 11 rewrites are flagged, only the detach applies.
		expect(manifest.counts).toMatchObject({ done: 1, flagged: 11 });
		expect(formatSummary(manifest, manifestPath)).toContain("flagged: artist:lustmord");
	});
});

/** The table of the fixtures: the committed pairs of the migration. */
function committedFor(): Record<string, string> {
	return Object.fromEntries(REWRITE.map((r) => [r.from, r.to]));
}

describe("CLI and channel", () => {
	it("parses the channel's flags and refuses anything else", () => {
		expect(parseCliArgs(["c", "--apply", "--manifest", "m", "--data-dir", "d"])).toEqual({
			cacheDir: "c",
			apply: true,
			manifestPath: "m",
			dataDir: "d",
		});
		expect(parseCliArgs(["c"])).toMatchObject({ apply: false, dataDir: undefined });
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["c", "--bogus"])).toBeNull();
		expect(parseCliArgs(["c", "--manifest"])).toBeNull();
	});

	it("the name is accepted by deploy/sync-genre-cache.sh and its file exists where the channel looks", () => {
		const script = readFileSync(resolve("deploy/sync-genre-cache.sh"), "utf8");
		const pattern = /MIGRATION_NAME_PATTERN='([^']+)'/.exec(script)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(() => readFileSync(resolve("scripts/migrations", `${MIGRATION_NAME}.ts`))).not.toThrow();
	});

	it("runs as the channel runs it: tsx <cache> --apply --manifest --data-dir", () => {
		const { dir } = repoLikeCache();
		const manifestPath = join(tmp("channel-manifest-"), "m.json");
		const dataDir = dataDirWith(committedFor());
		execFileSync(
			"npx",
			[
				"tsx",
				resolve("scripts/migrations", `${MIGRATION_NAME}.ts`),
				dir,
				"--apply",
				"--manifest",
				manifestPath,
				"--data-dir",
				dataDir,
			],
			{ encoding: "utf8" },
		);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { written: number; blocked: boolean };
		expect(manifest).toMatchObject({ written: 8, blocked: false });
	}, 60_000);
});
