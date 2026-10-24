import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafePendingEntry } from "../scripts/migrations/2026-10-16-scope-release-slugs.js";
import {
	formatSummary,
	type Manifest,
	parseCliArgs,
	runMigration,
	SAFE_BACKFILL_PAIRS,
} from "../scripts/migrations/2026-10-17-backfill-reverse-edges.js";
import {
	checkPendingReversesAfterMigration,
	parsePendingReverses,
} from "../scripts/pending-reverses-union.js";
import { NodeCache } from "../src/cache.js";
import { REVERSE_EDGE_PAIRS } from "../src/node-spec.js";
import { isEmittedPendingReverse } from "../src/reverse-edges.js";
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

describe("backfill-reverse-edges: the four safe pairs", () => {
	it("adds the artist to the roster of its label (artist.labels -> label.roster)", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp]);

		const manifest = await run(true);

		const stored = await readNode<LabelNode>("label:warp");
		expect(stored.roster).toEqual([{ slug: "artist:aphex-twin", type: "artist", name: "Aphex Twin" }]);
		expect(manifest.added).toEqual({ "artist.labels→label.roster": 1 });
		expect(manifest.written).toBe(1);
		expect(manifest.mode).toBe("apply");
		assertCache(2);
	});

	it("lists a project in its credited artist's discography, with the primary credit on the edge", async () => {
		await writeCache([
			project("project:syro--aphex-twin", "Syro", { artists: [ref("artist:aphex-twin", "Aphex Twin")] }),
			aphex,
		]);

		const manifest = await run(true);

		expect((await readNode<ArtistNode>("artist:aphex-twin")).discography).toEqual([
			{ slug: "project:syro--aphex-twin", type: "project", name: "Syro", artist: "Aphex Twin" },
		]);
		expect(manifest.added).toEqual({ "project.artists→artist.discography": 1 });
		assertCache(2);
	});

	it("lists a track in its credited artist's notable_tracks", async () => {
		await writeCache([
			track("track:minipops--aphex-twin", "minipops", { artists: [ref("artist:aphex-twin", "Aphex Twin")] }),
			aphex,
		]);

		const manifest = await run(true);

		expect((await readNode<ArtistNode>("artist:aphex-twin")).notable_tracks.map((e) => e.slug)).toEqual([
			"track:minipops--aphex-twin",
		]);
		expect(manifest.added).toEqual({ "track.artists→artist.notable_tracks": 1 });
		assertCache(2);
	});

	it("lists a project in the notable_releases of its label", async () => {
		await writeCache([
			project("project:syro--aphex-twin", "Syro", {
				artists: [ref("artist:aphex-twin", "Aphex Twin")],
				label: ref("label:warp", "Warp"),
			}),
			{ ...aphex, discography: [ref("project:syro--aphex-twin", "Syro", { artist: "Aphex Twin" })] },
			warp,
		]);

		const manifest = await run(true);

		expect((await readNode<LabelNode>("label:warp")).notable_releases.map((e) => e.slug)).toEqual([
			"project:syro--aphex-twin",
		]);
		expect(manifest.added).toEqual({ "project.label→label.notable_releases": 1 });
		assertCache(3);
	});

	it("is idempotent, never removes or reorders an edge, and does not emit the reverse of a reverse", async () => {
		const nodes: NodePayload[] = [
			{
				...aphex,
				labels: [ref("label:warp", "Warp")],
				collaborators: [ref("artist:other", "Other")],
				discography: [ref("project:old--aphex-twin", "Old")],
			},
			{ ...warp, roster: [ref("artist:someone", "Someone")] },
			project("project:syro--aphex-twin", "Syro", { artists: [ref("artist:aphex-twin", "Aphex Twin")] }),
			artist("artist:other", "Other"),
			artist("artist:someone", "Someone"),
		];
		await writeCache(nodes);
		const before = await snapshot();

		const first = await run(true);
		const afterFirst = await snapshot();
		const second = await run(true);

		expect(first.written).toBe(2);
		expect(second.written).toBe(0);
		expect(second.added).toEqual({});
		expect(second.pendingAdded).toBe(0);
		expect(await snapshot()).toEqual(afterFirst);
		for (const [file, raw] of Object.entries(before)) {
			const was = JSON.parse(raw) as Record<string, unknown>;
			const now = JSON.parse(afterFirst[file] ?? "{}") as Record<string, unknown>;
			for (const [key, value] of Object.entries(was)) {
				if (Array.isArray(value)) expect(now[key], `${file}.${key}`).toEqual(expect.arrayContaining(value));
				else expect(now[key], `${file}.${key}`).toEqual(value);
			}
		}
		// The label's new roster entry did not make the artist list the label twice.
		expect((await readNode<ArtistNode>("artist:aphex-twin")).labels).toEqual([ref("label:warp", "Warp")]);
	});

	it("dry-run writes nothing but reports the same plan as --apply", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp]);
		const before = await snapshot();

		const dry = await run(false);

		expect(await snapshot()).toEqual(before);
		expect(dry.mode).toBe("dry-run");
		expect(dry.written).toBe(1);
		const applied = await run(true);
		expect({ ...applied, mode: "dry-run" }).toEqual(dry);
	});
});

describe("backfill-reverse-edges: pending", () => {
	it("queues a missing artist or label target once, keeping the entries already there", async () => {
		const existing = {
			"artist:someone": [{ field: "members", cardinality: "list", edge: ref("artist:band", "Band") }],
		};
		await writeCache([{ ...aphex, labels: [ref("label:ghost", "Ghost")] }], existing);

		const first = await run(true);
		const pending = await readPending();

		expect(first.pendingAdded).toBe(1);
		expect(first.written).toBe(0);
		expect(pending["artist:someone"]).toEqual(existing["artist:someone"]);
		expect(pending["label:ghost"]).toEqual([
			{ field: "roster", cardinality: "list", edge: ref("artist:aphex-twin", "Aphex Twin") },
		]);

		const second = await run(true);
		expect(second.pendingAdded).toBe(0);
		expect(second.unchanged).toBe(1);
		expect(await readPending()).toEqual(pending);
	});

	it("never queues a credit, a project, a label or a genre on a missing work", async () => {
		await writeCache([
			artist("artist:two-unlimited", "2 Unlimited", {
				discography: [ref("project:ii", "II")],
				notable_tracks: [ref("track:no-limit", "No Limit")],
			}),
			{ ...warp, roster: [ref("artist:ghost", "Ghost")], notable_releases: [ref("project:ghost", "Ghost")] },
			genre("genre:idm", "IDM", {
				key_artists: [ref("artist:ghost", "Ghost")],
				landmark_projects: [ref("project:ii", "II")],
			}),
			track("track:x", "X", { project: ref("project:ii", "II") }),
			project("project:y", "Y", { tracklist: [ref("track:no-limit", "No Limit")] }),
		]);

		const manifest = await run(true);

		expect(manifest.pendingAdded).toBe(0);
		await expect(readFile(join(dir, "pending-reverses.json"), "utf8")).rejects.toThrow();
	});
});

describe("backfill-reverse-edges: what the deep review of PR #484 reproduced", () => {
	// Reproductions from the review (scratchpad/rv484). The backfill must graft nothing of this on any node.
	it("grafts no credit, tracklist, project, label or genre from another node's list", async () => {
		const nodes: NodePayload[] = [
			// Moderat's "II" and 2 Unlimited's "II" are two works; the artist side lists a namesake.
			artist("artist:moderat", "Moderat", { discography: [ref("project:ii", "II")] }),
			artist("artist:two-unlimited", "2 Unlimited", { discography: [ref("project:ii", "II")] }),
			project("project:ii", "II", { artists: [ref("artist:moderat", "Moderat")] }),
			// Touch Me, credited to Rui da Silva, listed by three namesakes.
			artist("artist:49ers", "49ers", { discography: [ref("project:touch-me", "Touch Me")] }),
			artist("artist:oakenfold", "Paul Oakenfold", { discography: [ref("project:touch-me", "Touch Me")] }),
			project("project:touch-me", "Touch Me", { artists: [ref("artist:rui-da-silva", "Rui da Silva")] }),
			artist("artist:rui-da-silva", "Rui da Silva", { discography: [ref("project:touch-me", "Touch Me")] }),
			// Deep Space has no credit: two artists list other works of that name.
			artist("artist:juan-atkins", "Juan Atkins", { discography: [ref("project:deep-space", "Deep Space")] }),
			artist("artist:oakenfold-2", "Paul Oakenfold 2", {
				discography: [ref("project:deep-space", "Deep Space")],
			}),
			project("project:deep-space", "Deep Space"),
			// A producer is not an artist of the work.
			artist("artist:chris-thomas", "Chris Thomas", {
				discography: [ref("project:nevermind", "Never Mind")],
			}),
			project("project:nevermind", "Never Mind", {
				artists: [ref("artist:sex-pistols", "Sex Pistols")],
				producers: [ref("artist:chris-thomas", "Chris Thomas")],
			}),
			artist("artist:sex-pistols", "Sex Pistols", { discography: [ref("project:nevermind", "Never Mind")] }),
			// A homonym's tracklist and genre milestones are not copied onto the work.
			project("project:tempus", "Tempus", { tracklist: [ref("track:stechmuck", "Stechmuck")] }),
			track("track:stechmuck", "Stechmuck"),
			genre("genre:italo-disco", "Italo disco", { landmark_tracks: [ref("track:call-me", "Call Me")] }),
			track("track:call-me", "Call Me", { project: ref("project:tempus", "Tempus") }),
			artist("artist:blondie", "Blondie", { genres: [ref("genre:italo-disco", "Italo disco")] }),
			genre("genre:rock", "Rock", { key_artists: [ref("artist:blondie", "Blondie")] }),
		];
		await writeCache(nodes);
		const before = await snapshot();

		await run(true);
		const after = await snapshot();

		const changed = Object.keys(after).filter((f) => after[f] !== before[f]);
		// Only the artist-side lists the safe pairs fill may change: Sex Pistols (its album), Moderat (II).
		for (const file of changed) expect(file.startsWith("artist/"), file).toBe(true);
		expect((await readNode<ProjectNode>("project:ii")).artists.map((e) => e.slug)).toEqual([
			"artist:moderat",
		]);
		expect((await readNode<ProjectNode>("project:touch-me")).artists.map((e) => e.slug)).toEqual([
			"artist:rui-da-silva",
		]);
		expect((await readNode<ProjectNode>("project:deep-space")).artists).toEqual([]);
		expect((await readNode<ProjectNode>("project:nevermind")).artists.map((e) => e.slug)).toEqual([
			"artist:sex-pistols",
		]);
		expect((await readNode<ProjectNode>("project:tempus")).tracklist.map((e) => e.slug)).toEqual([
			"track:stechmuck",
		]);
		expect((await readNode<TrackNode>("track:stechmuck")).project).toBeUndefined();
		expect((await readNode<TrackNode>("track:call-me")).genres).toEqual([]);
		expect((await readNode<ArtistNode>("artist:blondie")).genres.map((e) => e.slug)).toEqual([
			"genre:italo-disco",
		]);
		expect((await readNode<ArtistNode>("artist:chris-thomas")).discography.map((e) => e.slug)).toEqual([
			"project:nevermind",
		]);
	});

	it("leaves nothing in pending that a later write could turn into a credit (Moderat's II through NodeCache.write)", async () => {
		await writeCache([
			artist("artist:two-unlimited", "2 Unlimited", { discography: [ref("project:ii", "II")] }),
			artist("artist:moderat", "Moderat"),
		]);

		await run(true);
		await new NodeCache(dir).write(
			project("project:ii", "II", { artists: [ref("artist:moderat", "Moderat")] }) as NodePayload,
		);

		expect((await readNode<ProjectNode>("project:ii")).artists.map((e) => e.slug)).toEqual([
			"artist:moderat",
		]);
	});

	it("lists every pair it skips, with a reason, and none of the four safe ones", async () => {
		await writeCache([aphex]);

		const { skippedPairs } = await run(false);

		const skipped = skippedPairs.map((p) => p.pair);
		expect(skipped.length).toBe(REVERSE_EDGE_PAIRS.length - SAFE_BACKFILL_PAIRS.size);
		for (const safe of SAFE_BACKFILL_PAIRS) expect(skipped).not.toContain(safe);
		expect(skipped).toContain("artist.discography→project.artists");
		expect(skipped).toContain("label.roster→artist.labels");
		expect(skippedPairs.every((p) => p.reason.length > 0)).toBe(true);
		expect([...SAFE_BACKFILL_PAIRS].sort()).toEqual([
			"artist.labels→label.roster",
			"project.artists→artist.discography",
			"project.label→label.notable_releases",
			"track.artists→artist.notable_tracks",
		]);
	});
});

describe("backfill-reverse-edges: refusals and CLI", () => {
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
		expect(result.manifest.errors.length).toBeGreaterThan(0);
		expect(result.manifest.blocked).toBe(true);
		expect(await snapshot()).toEqual(before);
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

	it("accepts the migration channel's --data-dir and ignores it (TRA-488)", () => {
		expect(parseCliArgs(["cache", "--apply", "--manifest", "m.json", "--data-dir", "scratch"])).toEqual({
			cacheDir: "cache",
			apply: true,
			manifestPath: "m.json",
		});
		expect(parseCliArgs(["cache", "--data-dir", "scratch"])).toEqual({
			cacheDir: "cache",
			apply: false,
			manifestPath: "out/reverse-edges.json",
		});
		expect(parseCliArgs(["cache", "--data-dir"])).toBeNull();
		expect(parseCliArgs(["cache", "--data-dir", "--apply"])).toBeNull();
		expect(parseCliArgs(["cache", "--data-dir", "a", "--data-dir", "b"])).toBeNull();
	});

	it("summarizes the plan", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp]);
		const manifest = await run(false);
		expect(formatSummary(manifest, "m.json")).toContain("artist.labels→label.roster");
	});
});

describe("backfill-reverse-edges: migration channel contract (TRA-488)", () => {
	it("declares nothing removed, renamed or redirected, and carries no timestamp", async () => {
		await writeCache([{ ...aphex, labels: [ref("label:warp", "Warp")] }, warp]);
		const first = await run(true);
		expect(first).toMatchObject({
			migration: "2026-10-17-backfill-reverse-edges",
			removed: [],
			renamed: {},
			redirects: {},
		});
		expect(JSON.stringify(first)).not.toMatch(/generated_at|\d{4}-\d{2}-\d{2}T/);
	});

	it("only queues pending entries that the scope migration and the runtime both accept, and the channel validates", async () => {
		await writeCache([
			{ ...aphex, labels: [ref("label:ghost", "Ghost")] },
			project("project:syro", "Syro", {
				artists: [ref("artist:nobody", "Nobody")],
				label: ref("label:phantom", "Phantom"),
			}),
			track("track:minipops", "minipops", { artists: [ref("artist:ghost-artist", "Ghost Artist")] }),
		]);
		const { pendingAdded } = await run(true);
		const pending = await readPending();

		expect(pendingAdded).toBe(4);
		const keys = Object.keys(pending).sort();
		expect(keys).toEqual(["artist:ghost-artist", "artist:nobody", "label:ghost", "label:phantom"]);
		for (const [key, entries] of Object.entries(pending)) {
			for (const entry of entries) {
				expect(isSafePendingEntry(key, entry), `${key} ${entry.field}`).toBe(true);
				expect(isEmittedPendingReverse(parseSlug(key).type, entry), `${key} ${entry.field}`).toBe(true);
			}
		}
		// The channel's own checks on the file it would ship: shape, then the edge schema of the target field.
		const parsed = parsePendingReverses(JSON.stringify(pending));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(checkPendingReversesAfterMigration(parsed.value, new Set())).toEqual([]);
	});
});

// TRA-624 (2026-10-24): the backfill built its own source edge and did not carry the project's mbid, while
// NodeCache.emitReverses did (TRA-623). Both now call reverseEdgeFor.
describe("backfill-reverse-edges: the edge is the one the runtime emits (TRA-624)", () => {
	const projectMbid = "5b4f8a1e-6c1d-4c47-9c2e-0d3a7f5b9e21";
	const syro = (o: Partial<ProjectNode> = {}) =>
		project("project:syro--aphex-twin", "Syro", {
			artists: [ref("artist:aphex-twin", "Aphex Twin")],
			...o,
		});

	it("stamps the project's mbid on the discography edge", async () => {
		await writeCache([syro({ mbid: projectMbid }), aphex]);

		await run(true);

		expect((await readNode<ArtistNode>("artist:aphex-twin")).discography).toEqual([
			{
				slug: "project:syro--aphex-twin",
				type: "project",
				name: "Syro",
				artist: "Aphex Twin",
				mbid: projectMbid,
			},
		]);
	});

	it("produces the same discography edge as NodeCache.write, for the same project and artist", async () => {
		await writeCache([syro({ mbid: projectMbid }), aphex]);
		await run(true);
		const backfilled = (await readNode<ArtistNode>("artist:aphex-twin")).discography;

		const runtimeDir = await mkdtemp(join(tmpdir(), "reverse-edges-runtime-"));
		try {
			const cache = new NodeCache(runtimeDir);
			await cache.write(aphex);
			await cache.write(syro({ mbid: projectMbid }));
			const emitted = ((await cache.get("artist:aphex-twin")) as ArtistNode).discography;

			expect(emitted).toEqual(backfilled);
			expect(emitted).toHaveLength(1);
		} finally {
			await rm(runtimeDir, { recursive: true, force: true });
		}
	});

	it("adds no mbid key when the project has none, or one that is not a uuid, and the run still succeeds", async () => {
		await writeCache([syro({ mbid: "not-a-uuid" }), aphex]);

		const manifest = await run(true);

		const [edge] = (await readNode<ArtistNode>("artist:aphex-twin")).discography;
		expect(edge).toEqual({
			slug: "project:syro--aphex-twin",
			type: "project",
			name: "Syro",
			artist: "Aphex Twin",
		});
		expect(edge && "mbid" in edge).toBe(false);
		expect(manifest.errors).toEqual([]);
	});

	it("propagates the mbid of no other pair (track.artists, project.label, artist.labels)", async () => {
		const mbid = "0a9c2f77-3d58-4e0b-8a61-b7e4c1d2f390";
		await writeCache([
			track("track:minipops--aphex-twin", "minipops", {
				mbid,
				artists: [ref("artist:aphex-twin", "Aphex Twin")],
			}),
			syro({ mbid: projectMbid, label: ref("label:warp", "Warp") }),
			{ ...artist("artist:squarepusher", "Squarepusher", { mbid }), labels: [ref("label:warp", "Warp")] },
			aphex,
			warp,
		]);

		await run(true);

		const stored = await readNode<ArtistNode>("artist:aphex-twin");
		expect(stored.notable_tracks.every((e) => !("mbid" in e))).toBe(true);
		const storedLabel = await readNode<LabelNode>("label:warp");
		expect(storedLabel.notable_releases.every((e) => !("mbid" in e))).toBe(true);
		expect(storedLabel.roster.every((e) => !("mbid" in e))).toBe(true);
	});

	it("leaves an edge already on the artist as it is: the backfill adds, the runtime enriches", async () => {
		const existing = ref("project:syro--aphex-twin", "Syro", { artist: "Aphex Twin" });
		await writeCache([syro({ mbid: projectMbid }), { ...aphex, discography: [existing] }]);

		const manifest = await run(true);

		expect((await readNode<ArtistNode>("artist:aphex-twin")).discography).toEqual([existing]);
		expect(manifest.written).toBe(0);
		expect(manifest.unchanged).toBe(1);
	});
});
