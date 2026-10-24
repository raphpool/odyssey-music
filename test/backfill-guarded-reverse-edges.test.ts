import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	formatSummary,
	GUARDED_PAIRS,
	type Manifest,
	MIGRATION_NAME,
	parseCliArgs,
	runMigration,
	sameQid,
} from "../scripts/migrations/2026-10-24-backfill-guarded-reverse-edges.js";
import { NodeCache } from "../src/cache.js";
import { REVERSE_EDGE_PAIRS } from "../src/node-spec.js";
import { isEmittedReversePair, SAFE_BACKFILL_PAIRS } from "../src/reverse-edges.js";
import { parseSlug } from "../src/slug.js";
import type {
	ArtistNode,
	EdgeRef,
	GenreNode,
	NodePayload,
	ProjectNode,
	Slug,
	TrackNode,
} from "../src/types.js";

// TRA-564, first pair: genre.related_genres→genre.related_genres behind the Wikidata id. The cache is real
// files in a temp dir; the schema, the edge builder and the runtime (NodeCache) are the real ones.

const ARTICLE = "A real long article about the node, long enough for the cache invariants. ".repeat(4);
const BASE = {
	editorial_article: ARTICLE,
	citations: [{ url: "https://example.com/source", title: "Source" }],
	materialized_at: "2026-10-24T00:00:00.000Z",
};

function ref(slug: Slug, name: string, extra: Partial<EdgeRef> = {}): EdgeRef {
	return { slug, type: parseSlug(slug).type, name, ...extra };
}

function genre(slug: Slug, name: string, qid: string | undefined, o: Partial<GenreNode> = {}): GenreNode {
	return {
		...BASE,
		type: "genre",
		slug,
		name,
		...(qid ? { qid } : {}),
		editorial_definition: `${name} definition.`,
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
		...o,
	};
}

function artist(slug: Slug, name: string, o: Partial<ArtistNode> = {}): ArtistNode {
	return {
		...BASE,
		type: "artist",
		slug,
		name,
		editorial_bio: `${name} bio.`,
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...o,
	};
}

function project(slug: Slug, name: string, o: Partial<ProjectNode> = {}): ProjectNode {
	return {
		...BASE,
		type: "project",
		slug,
		name,
		editorial_pitch: `${name} pitch.`,
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
		...o,
	};
}

function track(slug: Slug, name: string, o: Partial<TrackNode> = {}): TrackNode {
	return {
		...BASE,
		type: "track",
		slug,
		name,
		editorial_teaser: `${name} teaser.`,
		artists: [],
		genres: [],
		producers: [],
		personnel: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
		...o,
	};
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "guarded-reverse-edges-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeCache(nodes: readonly NodePayload[], pending?: unknown): Promise<void> {
	for (const node of nodes) {
		const { type, body } = parseSlug(node.slug);
		const file = join(dir, "nodes", type, `${body}.json`);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
	if (pending !== undefined) await writeFile(join(dir, "pending-reverses.json"), JSON.stringify(pending));
}

async function readNode<T extends NodePayload>(slug: Slug): Promise<T> {
	const { type, body } = parseSlug(slug);
	return JSON.parse(await readFile(join(dir, "nodes", type, `${body}.json`), "utf8")) as T;
}

async function snapshot(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const type of await readdir(join(dir, "nodes"))) {
		for (const f of await readdir(join(dir, "nodes", type))) {
			out[`${type}/${f}`] = await readFile(join(dir, "nodes", type, f), "utf8");
		}
	}
	return out;
}

async function run(apply: boolean): Promise<Manifest> {
	const result = await runMigration({ cacheDir: dir, apply });
	expect(result.exitCode).toBe(0);
	return result.manifest;
}

const PAIR = "genre.related_genres→genre.related_genres";
const dubstep = genre("genre:dubstep", "Dubstep", "Q20474");
const garage = (o: Partial<GenreNode> = {}) => genre("genre:2-step-garage", "2-step garage", "Q1165777", o);

describe("guarded backfill: genre.related_genres, proven by the Wikidata id", () => {
	it("adds the reverse edge, with the genre's qid, when the edge and the target carry the same qid", async () => {
		await writeCache([
			garage({ related_genres: [ref("genre:dubstep", "dubstep", { qid: "Q20474" })] }),
			dubstep,
		]);

		const manifest = await run(true);

		expect((await readNode<GenreNode>("genre:dubstep")).related_genres).toEqual([
			{ slug: "genre:2-step-garage", type: "genre", name: "2-step garage", qid: "Q1165777" },
		]);
		expect(manifest.added).toEqual({ [PAIR]: 1 });
		expect(manifest.written).toBe(1);
		expect(manifest.doubtful).toEqual([]);
		expect(manifest.mode).toBe("apply");
	});

	it("does not graft a namesake: an edge whose qid is not the target's is listed, not written", async () => {
		// "house" (Q10 here) and another genre filed under the same slug: the edge was resolved against the
		// other one. The slug matches, the identity does not.
		await writeCache([
			garage({ related_genres: [ref("genre:house", "house", { qid: "Q999" })] }),
			genre("genre:house", "House", "Q10"),
		]);
		const before = await snapshot();

		const manifest = await run(true);

		expect(await snapshot()).toEqual(before);
		expect(manifest.written).toBe(0);
		expect(manifest.doubtful).toEqual([
			{ pair: PAIR, source: "genre:2-step-garage", target: "genre:house", reason: "qid-mismatch" },
		]);
		expect(manifest.doubtfulByReason).toEqual({ [PAIR]: { "qid-mismatch": 1 } });
	});

	it("does not graft an edge that carries no qid, nor onto a genre that has none", async () => {
		await writeCache([
			garage({
				related_genres: [ref("genre:dubstep", "dubstep"), ref("genre:grime", "grime", { qid: "Q1166726" })],
			}),
			dubstep,
			genre("genre:grime", "Grime", undefined),
		]);
		const before = await snapshot();

		const manifest = await run(true);

		expect(await snapshot()).toEqual(before);
		expect(manifest.doubtful.map((d) => [d.target, d.reason])).toEqual([
			["genre:dubstep", "edge-without-qid"],
			["genre:grime", "target-without-qid"],
		]);
	});

	it("skips a self-edge and a target that is not in the cache, and queues no pending entry for either", async () => {
		await writeCache([
			garage({
				related_genres: [
					ref("genre:2-step-garage", "2-step garage", { qid: "Q1165777" }),
					ref("genre:gone", "gone", { qid: "Q1" }),
				],
			}),
		]);

		const manifest = await run(true);

		expect(manifest.written).toBe(0);
		expect(manifest.targetNotCached).toBe(1);
		expect(manifest.doubtful.map((d) => d.reason)).toEqual(["self-edge"]);
		await expect(readFile(join(dir, "pending-reverses.json"), "utf8")).rejects.toThrow(/ENOENT/);
	});

	it("is idempotent, and never removes, modifies or reorders an edge already there", async () => {
		const held = ref("genre:grime", "Grime (old spelling)", { qid: "Q1166726" });
		await writeCache([
			garage({
				related_genres: [
					ref("genre:dubstep", "dubstep", { qid: "Q20474" }),
					ref("genre:grime", "grime", { qid: "Q1166726" }),
				],
			}),
			{ ...dubstep, related_genres: [held] },
			genre("genre:grime", "Grime", "Q1166726", {
				related_genres: [ref("genre:2-step-garage", "2-step garage", { qid: "Q1165777" })],
			}),
		]);

		const first = await run(true);
		const afterFirst = await snapshot();
		const second = await run(true);

		expect((await readNode<GenreNode>("genre:dubstep")).related_genres.map((e) => e.slug)).toEqual([
			"genre:grime",
			"genre:2-step-garage",
		]);
		expect((await readNode<GenreNode>("genre:dubstep")).related_genres[0]).toEqual(held);
		// garage->dubstep and dubstep->grime are missing on the other side; garage<->grime is already both ways.
		expect(first.added).toEqual({ [PAIR]: 2 });
		expect(first.unchanged).toBe(2);
		expect(second.written).toBe(0);
		expect(second.added).toEqual({});
		expect(await snapshot()).toEqual(afterFirst);
	});

	it("dry-run writes nothing but reports the same plan as --apply", async () => {
		await writeCache([
			garage({ related_genres: [ref("genre:dubstep", "dubstep", { qid: "Q20474" })] }),
			dubstep,
		]);
		const before = await snapshot();

		const dry = await run(false);

		expect(await snapshot()).toEqual(before);
		const applied = await run(true);
		expect({ ...dry, mode: applied.mode }).toEqual(applied);
	});
});

describe("guarded backfill: what the deep review of PR #484 reproduced stays ungrafted", () => {
	// The reproductions of the review (Deep Space, Chris Thomas, Moderat's II, Spiritual High, Call Me): every
	// one of them is a cross-type pair, which this script does not touch. The whole cache must come out as it went in.
	it("changes no file of a cache holding those cases", async () => {
		await writeCache([
			artist("artist:moderat", "Moderat", { discography: [ref("project:ii", "II")] }),
			artist("artist:two-unlimited", "2 Unlimited", { discography: [ref("project:ii", "II")] }),
			project("project:ii", "II", { artists: [ref("artist:moderat", "Moderat")] }),
			artist("artist:juan-atkins", "Juan Atkins", { discography: [ref("project:deep-space", "Deep Space")] }),
			project("project:deep-space", "Deep Space"),
			artist("artist:chris-thomas", "Chris Thomas", {
				discography: [ref("project:nevermind", "Never Mind")],
			}),
			project("project:nevermind", "Never Mind", {
				artists: [ref("artist:sex-pistols", "Sex Pistols")],
				producers: [ref("artist:chris-thomas", "Chris Thomas")],
			}),
			project("project:spiritual-high", "Spiritual High", {
				tracklist: [ref("track:spiritual-high-state-of-independence", "Spiritual High")],
			}),
			track("track:spiritual-high-state-of-independence", "Spiritual High"),
			genre("genre:italo-disco", "Italo disco", "Q1", { landmark_tracks: [ref("track:call-me", "Call Me")] }),
			track("track:call-me", "Call Me"),
			// And a legitimate genre pair, so that the run does something.
			garage({ related_genres: [ref("genre:dubstep", "dubstep", { qid: "Q20474" })] }),
			dubstep,
		]);
		const before = await snapshot();

		const manifest = await run(true);

		const after = await snapshot();
		const changed = Object.keys(after).filter((f) => after[f] !== before[f]);
		expect(changed).toEqual(["genre/dubstep.json"]);
		expect(manifest.added).toEqual({ [PAIR]: 1 });
	});

	it("leaves nothing in pending that a later write could turn into a credit (Moderat's II through NodeCache.write)", async () => {
		// A pending credit queued on a bare work key, the shape TRA-563 stopped emitting. The runtime ignores it.
		const stale = [
			{
				field: "artists",
				cardinality: "list",
				edge: { slug: "artist:two-unlimited", type: "artist", name: "2 Unlimited" },
			},
		];
		await writeCache([artist("artist:moderat", "Moderat"), garage(), dubstep], { "project:ii": stale });
		const pendingBefore = await readFile(join(dir, "pending-reverses.json"), "utf8");

		await run(true);
		await new NodeCache(dir).write(
			project("project:ii", "II", { artists: [ref("artist:moderat", "Moderat")] }) as NodePayload,
		);

		expect(await readFile(join(dir, "pending-reverses.json"), "utf8")).toBe(pendingBefore);
		expect((await readNode<ProjectNode>("project:ii")).artists.map((e) => e.slug)).toEqual([
			"artist:moderat",
		]);
	});
});

describe("guarded backfill: the runtime is not widened", () => {
	it("guards only declared list pairs, and none of them enters SAFE_BACKFILL_PAIRS", () => {
		expect(GUARDED_PAIRS).toEqual([PAIR]);
		for (const pair of GUARDED_PAIRS) expect(SAFE_BACKFILL_PAIRS.has(pair)).toBe(false);
		expect(
			REVERSE_EDGE_PAIRS.some((p) => p.sourceType === "genre" && p.sourceField === "related_genres"),
		).toBe(true);
		// The runtime already emits it (a same-kind pair, symmetric by construction): nothing new is emitted.
		expect(isEmittedReversePair("genre", "related_genres", "related_genres")).toBe(true);
		// And the cross-type pairs stay as TRA-563 left them.
		expect(isEmittedReversePair("artist", "discography", "artists")).toBe(false);
		expect(isEmittedReversePair("project", "tracklist", "project")).toBe(false);
	});
});

describe("guarded backfill: sameQid", () => {
	const input = (ref: Record<string, unknown>, target: Record<string, unknown>) => ({
		source: {},
		ref,
		target,
	});

	it("proves only an equal, non-empty qid on both sides", () => {
		expect(sameQid(input({ qid: "Q1" }, { qid: "Q1" }))).toEqual({ proven: true });
		expect(sameQid(input({ qid: " Q1 " }, { qid: "Q1" }))).toEqual({ proven: true });
		expect(sameQid(input({ qid: "Q1" }, { qid: "Q2" }))).toEqual({ proven: false, reason: "qid-mismatch" });
		expect(sameQid(input({}, { qid: "Q1" }))).toEqual({ proven: false, reason: "edge-without-qid" });
		expect(sameQid(input({ qid: "" }, { qid: "Q1" }))).toEqual({ proven: false, reason: "edge-without-qid" });
		expect(sameQid(input({ qid: "Q1" }, {}))).toEqual({ proven: false, reason: "target-without-qid" });
		expect(sameQid(input({ qid: 1 }, { qid: 1 }))).toEqual({ proven: false, reason: "edge-without-qid" });
	});
});

describe("guarded backfill: refusals, CLI and migration channel contract", () => {
	it("refuses to write anything when a node to write fails validation", async () => {
		const broken = { ...dubstep, citations: [] } as GenreNode;
		await writeCache([
			garage({ related_genres: [ref("genre:dubstep", "dubstep", { qid: "Q20474" })] }),
			broken,
			genre("genre:b", "B", "Q2", { related_genres: [ref("genre:c", "C", { qid: "Q3" })] }),
			genre("genre:c", "C", "Q3"),
		]);
		const before = await snapshot();

		const result = await runMigration({ cacheDir: dir, apply: true });

		expect(result.exitCode).toBe(2);
		expect(result.manifest.errors.length).toBeGreaterThan(0);
		expect(result.manifest.blocked).toBe(true);
		expect(await snapshot()).toEqual(before);
	});

	it("reports a malformed target value as a conflict instead of replacing it", async () => {
		const malformed = { ...dubstep, related_genres: "oops" } as unknown as GenreNode;
		await writeCache([
			garage({ related_genres: [ref("genre:dubstep", "dubstep", { qid: "Q20474" })] }),
			malformed,
		]);

		const manifest = await run(true);

		expect(manifest.conflicts).toEqual([
			{
				source: "genre:2-step-garage",
				field: "related_genres",
				target: "genre:dubstep",
				targetField: "related_genres",
				kind: "target-field",
			},
		]);
		expect(manifest.written).toBe(0);
	});

	it("parses the CLI contract of the channel, with its own default manifest path", () => {
		expect(parseCliArgs(["cache"])).toEqual({
			cacheDir: "cache",
			apply: false,
			manifestPath: DEFAULT_MANIFEST_PATH,
		});
		expect(DEFAULT_MANIFEST_PATH).not.toBe("out/reverse-edges.json");
		expect(parseCliArgs(["cache", "--apply", "--manifest", "m.json", "--data-dir", "d"])).toEqual({
			cacheDir: "cache",
			apply: true,
			manifestPath: "m.json",
		});
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["cache", "--bogus"])).toBeNull();
	});

	it("declares nothing removed, renamed or redirected, and carries no timestamp", async () => {
		await writeCache([
			garage({ related_genres: [ref("genre:dubstep", "dubstep", { qid: "Q20474" })] }),
			dubstep,
		]);

		const manifest = await run(true);

		expect(manifest).toMatchObject({ migration: MIGRATION_NAME, removed: [], renamed: {}, redirects: {} });
		expect(JSON.stringify(manifest)).not.toMatch(/generated_at|\d{4}-\d{2}-\d{2}T/);
	});

	it("summarizes the plan, the pairs and why edges were not written", async () => {
		await writeCache([
			garage({
				related_genres: [ref("genre:dubstep", "dubstep", { qid: "Q20474" }), ref("genre:house", "house")],
			}),
			dubstep,
			genre("genre:house", "House", "Q10"),
		]);

		const summary = formatSummary(await run(false), "m.json");

		expect(summary).toContain(PAIR);
		expect(summary).toContain("not written, edge-without-qid: 1");
		expect(summary).toContain("dry-run");
	});
});
