import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatSummary,
	type Manifest,
	parseCliArgs,
	runMigration,
} from "../scripts/migrations/2026-10-17-backfill-reverse-edges.js";
import { parseSlug } from "../src/slug.js";
import type {
	ArtistNode,
	EdgeRef,
	GenreNode,
	LabelNode,
	NodePayload,
	ProjectNode,
	Slug,
	TrackNode,
} from "../src/types.js";

const ARTICLE = "A real long article about the node, long enough for the cache invariants. ".repeat(4);
const BASE = {
	editorial_article: ARTICLE,
	citations: [{ url: "https://example.com/source", title: "Source" }],
	materialized_at: "2026-10-17T00:00:00.000Z",
};

function ref(slug: Slug, name: string, extra: Partial<EdgeRef> = {}): EdgeRef {
	return { slug, type: parseSlug(slug).type, name, ...extra };
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

function label(slug: Slug, name: string, o: Partial<LabelNode> = {}): LabelNode {
	return {
		...BASE,
		type: "label",
		slug,
		name,
		editorial_description: `${name} description.`,
		genres: [],
		roster: [],
		notable_releases: [],
		...o,
	};
}

function genre(slug: Slug, name: string, o: Partial<GenreNode> = {}): GenreNode {
	return {
		...BASE,
		type: "genre",
		slug,
		name,
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
	dir = await mkdtemp(join(tmpdir(), "reverse-edges-"));
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

async function readPending(): Promise<Record<string, { field: string; edge: EdgeRef }[]>> {
	return JSON.parse(await readFile(join(dir, "pending-reverses.json"), "utf8"));
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

/** scripts/assert-cache.ts is the oracle: it exits 1 on any missing reverse edge between cached nodes. */
function assertCache(nodeCount: number): void {
	execFileSync(join(process.cwd(), "node_modules", ".bin", "tsx"), [
		join(process.cwd(), "scripts", "assert-cache.ts"),
		dir,
		String(nodeCount),
	]);
}

const warp = label("label:warp", "Warp");
const aphex = artist("artist:aphex-twin", "Aphex Twin");

describe("backfill-reverse-edges", () => {
	it("adds the artist to the roster of its label (artist.labels -> label.roster)", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp]);

		const manifest = await run(true);

		const stored = await readNode<LabelNode>("label:warp");
		expect(stored.roster.map((e) => e.slug)).toEqual(["artist:aphex-twin"]);
		expect(stored.roster[0]).toEqual({ slug: "artist:aphex-twin", type: "artist", name: "Aphex Twin" });
		expect(manifest.added["artist.labels→label.roster"]).toBe(1);
		expect(manifest.written).toBe(1);
		expect(manifest.mode).toBe("apply");
		assertCache(2);
	});

	it("never overwrites a singular field already set to another target, and lists it", async () => {
		const other = project("project:other--aphex-twin", "Other", {
			artists: [ref("artist:aphex-twin", "Aphex Twin")],
		});
		const mine = project("project:mine--aphex-twin", "Mine", {
			artists: [ref("artist:aphex-twin", "Aphex Twin")],
			tracklist: [ref("track:x--aphex-twin", "X")],
		});
		const x = track("track:x--aphex-twin", "X", {
			artists: [ref("artist:aphex-twin", "Aphex Twin")],
			project: ref("project:other--aphex-twin", "Other"),
		});
		await writeCache([
			artist("artist:aphex-twin", "Aphex Twin", {
				discography: [ref("project:other--aphex-twin", "Other"), ref("project:mine--aphex-twin", "Mine")],
				notable_tracks: [ref("track:x--aphex-twin", "X")],
			}),
			other,
			mine,
			x,
		]);
		const before = await snapshot();

		const manifest = await run(true);

		const after = await snapshot();
		expect(after["track/x--aphex-twin.json"]).toBe(before["track/x--aphex-twin.json"]);
		expect((await readNode<TrackNode>("track:x--aphex-twin")).project?.slug).toBe(
			"project:other--aphex-twin",
		);
		expect(manifest.conflicts).toEqual([
			{
				source: "project:mine--aphex-twin",
				field: "tracklist",
				target: "track:x--aphex-twin",
				targetField: "project",
				kind: "single-occupied",
				existing: "project:other--aphex-twin",
			},
		]);
		// The other direction is still honoured: the track that names `other` is listed by `other`.
		expect((await readNode<ProjectNode>("project:other--aphex-twin")).tracklist.map((e) => e.slug)).toEqual([
			"track:x--aphex-twin",
		]);
	});

	it("does not graft an artist onto a work credited to someone else, but takes a group's member and an uncredited work", async () => {
		const rohff = artist("artist:rohff", "Rohff", {
			discography: [ref("project:fitna--akuma", "Fitna"), ref("project:new-forms--reprazent", "New Forms")],
			notable_tracks: [ref("track:orphan--rohff", "Orphan")],
		});
		await writeCache([
			rohff,
			artist("artist:akuma", "Akuma"),
			artist("artist:reprazent", "Reprazent", { members: [ref("artist:rohff", "Rohff")] }),
			project("project:fitna--akuma", "Fitna", { artists: [ref("artist:akuma", "Akuma")] }),
			project("project:new-forms--reprazent", "New Forms", {
				artists: [ref("artist:reprazent", "Reprazent")],
			}),
			track("track:orphan--rohff", "Orphan"),
		]);

		const manifest = await run(true);

		expect((await readNode<ProjectNode>("project:fitna--akuma")).artists.map((e) => e.slug)).toEqual([
			"artist:akuma",
		]);
		expect((await readNode<ProjectNode>("project:new-forms--reprazent")).artists.map((e) => e.slug)).toEqual([
			"artist:reprazent",
			"artist:rohff",
		]);
		expect((await readNode<TrackNode>("track:orphan--rohff")).artists.map((e) => e.slug)).toEqual([
			"artist:rohff",
		]);
		expect(manifest.conflicts).toEqual([
			{
				source: "artist:rohff",
				field: "discography",
				target: "project:fitna--akuma",
				targetField: "artists",
				kind: "foreign-credit",
				existing: "artist:akuma",
			},
		]);
	});

	it("credits every artist that lists an uncredited work, not only the first", async () => {
		await writeCache([
			artist("artist:a", "A", { discography: [ref("project:split--a", "Split")] }),
			artist("artist:b", "B", { discography: [ref("project:split--a", "Split")] }),
			project("project:split--a", "Split"),
		]);

		const manifest = await run(true);

		expect((await readNode<ProjectNode>("project:split--a")).artists.map((e) => e.slug)).toEqual([
			"artist:a",
			"artist:b",
		]);
		expect(manifest.conflicts).toEqual([]);
	});

	it("reaches a fixed point: a member seen before the group that credits it is settled in the same run", async () => {
		// artist:a-pete sorts before artist:b-group. Pass one: a-pete is foreign (the credit is c-john, whose
		// members are not a-pete) and b-group is accepted (c-john lists it as a member). Only then does the credit
		// include b-group, which lists a-pete: without a second pass a rerun would add a-pete.
		await writeCache([
			artist("artist:a-pete", "Pete", { discography: [ref("project:album--john", "Album")] }),
			artist("artist:b-group", "Group", {
				members: [ref("artist:a-pete", "Pete")],
				discography: [ref("project:album--john", "Album")],
			}),
			artist("artist:c-john", "John", { members: [ref("artist:b-group", "Group")] }),
			project("project:album--john", "Album", { artists: [ref("artist:c-john", "John")] }),
		]);

		const first = await run(true);
		const second = await run(true);

		expect((await readNode<ProjectNode>("project:album--john")).artists.map((e) => e.slug)).toEqual([
			"artist:c-john",
			"artist:b-group",
			"artist:a-pete",
		]);
		expect(first.added["artist.discography→project.artists"]).toBe(2);
		expect(second.written).toBe(0);
		expect(second.added).toEqual({});
	});

	it("reads group membership both ways, so the members pair added by the run cannot flip the credit test", async () => {
		await writeCache([
			artist("artist:g", "G", { members: [ref("artist:m", "M")], discography: [ref("project:w--m", "W")] }),
			artist("artist:m", "M"),
			project("project:w--m", "W", { artists: [ref("artist:m", "M")] }),
		]);

		await run(true);
		const second = await run(true);

		expect((await readNode<ProjectNode>("project:w--m")).artists.map((e) => e.slug)).toEqual([
			"artist:m",
			"artist:g",
		]);
		expect(second.written).toBe(0);
	});

	it("reports a ref of the wrong type and a malformed target value instead of queueing or replacing", async () => {
		await writeCache([
			{ ...aphex, labels: [ref("artist:other", "Other")] },
			artist("artist:b", "B", { labels: [ref("label:warp", "Warp")] }),
			{ ...warp, roster: "oops" as unknown as EdgeRef[] },
		]);

		const result = await runMigration({ cacheDir: dir, apply: false });

		expect(result.manifest.pendingAdded).toBe(0);
		expect(result.manifest.conflicts.map((c) => [c.source, c.kind])).toEqual([
			["artist:aphex-twin", "target-field"],
			["artist:b", "target-field"],
		]);
		expect(result.manifest.written).toBe(0);
	});

	it("carries the qid of a genre source onto the artist's genres", async () => {
		await writeCache([
			genre("genre:idm", "IDM", { qid: "Q215412", key_artists: [ref("artist:aphex-twin", "Aphex Twin")] }),
			aphex,
		]);

		const manifest = await run(true);

		const stored = await readNode<ArtistNode>("artist:aphex-twin");
		expect(stored.genres).toEqual([{ slug: "genre:idm", type: "genre", name: "IDM", qid: "Q215412" }]);
		expect(manifest.added["genre.key_artists→artist.genres"]).toBe(1);
		assertCache(2);
	});

	it("stamps the primary credit on the edge of a project or track source", async () => {
		await writeCache([
			project("project:syro--aphex-twin", "Syro", { artists: [ref("artist:aphex-twin", "Aphex Twin")] }),
			aphex,
		]);

		await run(true);

		const stored = await readNode<ArtistNode>("artist:aphex-twin");
		expect(stored.discography).toEqual([
			{ slug: "project:syro--aphex-twin", type: "project", name: "Syro", artist: "Aphex Twin" },
		]);
	});

	it("queues a missing target in pending-reverses.json once, keeping the entries already there", async () => {
		const existing = {
			"artist:someone": [{ field: "members", cardinality: "list", edge: ref("artist:band", "Band") }],
		};
		await writeCache([{ ...aphex, labels: [ref("label:ghost", "Ghost")] }], existing);

		const first = await run(true);
		const pending = await readPending();

		expect(first.pendingAdded).toBe(1);
		expect(pending["artist:someone"]).toEqual(existing["artist:someone"]);
		expect(pending["label:ghost"]).toEqual([
			{ field: "roster", cardinality: "list", edge: ref("artist:aphex-twin", "Aphex Twin") },
		]);
		expect(first.written).toBe(0);

		const second = await run(true);
		expect(second.pendingAdded).toBe(0);
		expect(second.unchanged).toBe(1);
		expect(await readPending()).toEqual(pending);
	});

	it("is idempotent: a second apply writes nothing, and the oracle accepts the result", async () => {
		await writeCache([
			{
				...aphex,
				labels: [ref("label:warp", "Warp")],
				discography: [ref("project:syro--aphex-twin", "Syro")],
			},
			warp,
			project("project:syro--aphex-twin", "Syro", {
				artists: [ref("artist:aphex-twin", "Aphex Twin")],
				label: ref("label:warp", "Warp"),
				tracklist: [ref("track:minipops--aphex-twin", "minipops")],
			}),
			track("track:minipops--aphex-twin", "minipops", { artists: [ref("artist:aphex-twin", "Aphex Twin")] }),
			genre("genre:idm", "IDM", { parent_genres: [ref("genre:electronic", "Electronic")] }),
			genre("genre:electronic", "Electronic", { related_genres: [ref("genre:idm", "IDM")] }),
		]);

		const first = await run(true);
		expect(first.written).toBeGreaterThan(0);
		const afterFirst = await snapshot();

		const second = await run(true);

		expect(second.written).toBe(0);
		expect(second.added).toEqual({});
		expect(second.pendingAdded).toBe(0);
		expect(await snapshot()).toEqual(afterFirst);
		assertCache(6);
	});

	it("dry-run writes nothing but reports the same plan as --apply", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp, label("label:x", "X")]);
		const before = await snapshot();

		const dry = await run(false);

		expect(await snapshot()).toEqual(before);
		expect(dry.mode).toBe("dry-run");
		expect(dry.written).toBe(1);
		const applied = await run(true);
		expect({ ...applied, mode: "dry-run" }).toEqual(dry);
	});

	it("only adds: every edge of the cache before the run is still there after it", async () => {
		const nodes: NodePayload[] = [
			{ ...aphex, labels: [ref("label:warp", "Warp")], influences: [ref("artist:other", "Other")] },
			{ ...warp, genres: [ref("genre:idm", "IDM")] },
			genre("genre:idm", "IDM", { key_labels: [ref("label:warp", "Warp")] }),
		];
		await writeCache(nodes);
		const before = await snapshot();

		await run(true);
		const after = await snapshot();

		for (const [file, raw] of Object.entries(before)) {
			const was = JSON.parse(raw) as Record<string, unknown>;
			const now = JSON.parse(after[file] ?? "{}") as Record<string, unknown>;
			for (const [key, value] of Object.entries(was)) {
				if (Array.isArray(value)) {
					expect(now[key], `${file}.${key}`).toEqual(expect.arrayContaining(value));
				} else {
					expect(now[key], `${file}.${key}`).toEqual(value);
				}
			}
		}
	});

	it("does not emit the reverse of a reverse: a roster entry does not make the artist re-list the label", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp]);

		await run(true);

		const stored = await readNode<ArtistNode>("artist:aphex-twin");
		expect(stored.labels).toEqual([ref("label:warp", "Warp")]);
		await expect(readFile(join(dir, "pending-reverses.json"), "utf8")).rejects.toThrow();
	});

	it("refuses to write anything when a node to write fails validation", async () => {
		const broken = { ...warp, citations: [] } as LabelNode;
		await writeCache([
			{ ...aphex, labels: [ref("label:warp", "Warp")] },
			broken,
			artist("artist:b", "B", { labels: [ref("label:b", "B")] }),
			label("label:b", "B"),
		]);
		const before = await snapshot();

		const result = await runMigration({ cacheDir: dir, apply: true });

		expect(result.exitCode).toBe(2);
		expect(result.manifest.written).toBe(0);
		expect(result.manifest.blocked).toBe(true);
		expect(await snapshot()).toEqual(before);
	});

	it("parses the CLI contract", () => {
		expect(parseCliArgs(["cache"])).toEqual({
			cacheDir: "cache",
			apply: false,
			manifestPath: "out/reverse-edges.json",
		});
		expect(parseCliArgs(["cache", "--apply", "--manifest", "m.json"])).toEqual({
			cacheDir: "cache",
			apply: true,
			manifestPath: "m.json",
		});
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["cache", "--apply", "--apply"])).toBeNull();
		expect(parseCliArgs(["cache", "--manifest"])).toBeNull();
		expect(parseCliArgs(["cache", "--bogus"])).toBeNull();
	});

	it("summarizes the plan", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp]);
		const manifest = await run(false);
		expect(formatSummary(manifest, "m.json")).toContain("artist.labels→label.roster");
	});
});
