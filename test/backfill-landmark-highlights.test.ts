import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	choose,
	type LandmarkManifest,
	MIGRATION_NAME,
	parseCliArgs,
	runBackfill,
} from "../scripts/migrations/2026-10-19-backfill-landmark-highlights.js";
import { parseSlug } from "../src/slug.js";
import type { EdgeRef, NodePayload } from "../src/types.js";
import { artistNode, edge, genreNode, projectNode, trackNode } from "./images/helpers.js";

// TRA-491: the deterministic flagship / reference-track backfill, offline. Nothing is mocked: the cache is
// real files in a temp dir, the schema and the credit rule (src/images/reciprocity.ts) are the real ones.

const IMG = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Cover.jpg";
const MBID_A = "00000000-0000-4000-8000-0000000000a1";

let root: string;
let cacheDir: string;
let manifestPath: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "landmark-"));
	cacheDir = join(root, "cache");
	manifestPath = join(root, "out", "landmark.json");
	await mkdir(join(cacheDir, "nodes"), { recursive: true });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const pathOf = (dir: string, slug: string): string => {
	const { type, body } = parseSlug(slug);
	return join(dir, "nodes", type, `${body}.json`);
};

async function put(node: NodePayload | Record<string, unknown>, dir = cacheDir): Promise<void> {
	const path = pathOf(dir, node.slug as string);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(node));
}

const read = async (slug: string, dir = cacheDir): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(pathOf(dir, slug), "utf8")) as Record<string, unknown>;

const manifestOf = async (path = manifestPath): Promise<LandmarkManifest> =>
	JSON.parse(await readFile(path, "utf8")) as LandmarkManifest;

/** A project credited to `artist` (slug without type), cached with the given extras. */
const album = (slug: string, artist: string, extra: Record<string, unknown> = {}) =>
	projectNode(slug, slug, { artists: [edge("artist", artist, artist)], ...extra });

const run = (apply = true, dir = cacheDir, manifest = manifestPath) =>
	runBackfill({ cacheDir: dir, apply, manifestPath: manifest });

describe("landmark_project (TRA-491)", () => {
	it("picks the album a genre lists as a landmark, whatever its position, reason genreLandmark", async () => {
		const discography: EdgeRef[] = ["a1", "a2", "a3"].map((s) => edge("project", `${s}--roni`, s));
		await put(artistNode("roni", "Roni", { discography }));
		for (const s of ["a1", "a2", "a3"]) await put(album(`${s}--roni`, "roni"));
		await put(
			genreNode("drum-and-bass", "Drum and bass", { landmark_projects: [discography[2] as EdgeRef] }),
		);

		const result = await run();

		expect(result.exitCode).toBe(0);
		expect((await read("artist:roni")).landmark_project).toEqual(discography[2]);
		const m = await manifestOf();
		expect(m.byReason.landmark_project).toEqual({ genreLandmark: 1, imaged: 0, cached: 0, first: 0 });
		expect(m.picks).toContainEqual({
			artist: "artist:roni",
			field: "landmark_project",
			target: "project:a3--roni",
			reason: "genreLandmark",
			score: 101,
		});
	});

	it("without a genre reference, picks the imaged album (imaged), else the cached one, else the first", async () => {
		const list = (names: string[], artist: string): EdgeRef[] =>
			names.map((s) => edge("project", `${s}--${artist}`, s));
		const imagedList = list(["a1", "a2", "a3"], "imaged");
		await put(artistNode("imaged", "Imaged", { discography: imagedList }));
		await put(album("a1--imaged", "imaged"));
		await put(album("a2--imaged", "imaged", { image_url: IMG, image_source: "caa" }));
		await put(album("a3--imaged", "imaged"));

		const cachedList = list(["b1", "b2"], "cached");
		await put(artistNode("cached", "Cached", { discography: cachedList }));
		await put(album("b2--cached", "cached")); // only the 2nd is in the cache

		const firstList = list(["c1", "c2"], "first");
		await put(artistNode("first", "First", { discography: firstList })); // nothing in the cache

		await put(artistNode("empty", "Empty"));

		await run();

		expect((await read("artist:imaged")).landmark_project).toEqual(imagedList[1]);
		expect((await read("artist:cached")).landmark_project).toEqual(cachedList[1]);
		expect((await read("artist:first")).landmark_project).toEqual(firstList[0]);
		expect((await read("artist:empty")).landmark_project).toBeUndefined();
		const m = await manifestOf();
		expect(m.byReason.landmark_project).toEqual({ genreLandmark: 0, imaged: 1, cached: 1, first: 1 });
		expect(m.skipped.landmark_project).toEqual(["artist:empty"]);
		expect(m.skipped.reference_track).toEqual([
			"artist:cached",
			"artist:empty",
			"artist:first",
			"artist:imaged",
		]);
	});

	it("breaks a tie by list order and copies the edge as is (mbid, year, releaseType, artist)", async () => {
		const first = edge("project", "t1--tie", "T1", {
			mbid: MBID_A,
			year: "1997",
			releaseType: "album",
			artist: "Tie",
		});
		const second = edge("project", "t2--tie", "T2");
		await put(artistNode("tie", "Tie", { discography: [first, second] }));
		await put(album("t1--tie", "tie"));
		await put(album("t2--tie", "tie"));

		await run();

		expect((await read("artist:tie")).landmark_project).toEqual(first);
	});

	it("leaves an artist that already has a landmark_project untouched", async () => {
		const mine = edge("project", "keep--has", "Keep");
		const other = edge("project", "other--has", "Other");
		await put(artistNode("has", "Has", { discography: [mine, other], landmark_project: other }));
		await put(album("keep--has", "has", { image_url: IMG, image_source: "caa" }));
		const before = await readFile(pathOf(cacheDir, "artist:has"), "utf8");

		await run();

		expect(await readFile(pathOf(cacheDir, "artist:has"), "utf8")).toBe(before);
		expect((await manifestOf()).skipped.landmark_project).toEqual([]);
	});
});

describe("reference_track (TRA-491)", () => {
	it("applies the same rule to notable_tracks with the genres' landmark_tracks", async () => {
		const tracks: EdgeRef[] = ["t1", "t2", "t3"].map((s) => edge("track", `${s}--dj`, s));
		await put(artistNode("dj", "DJ", { notable_tracks: tracks }));
		for (const s of ["t1", "t2", "t3"]) {
			await put(trackNode(`${s}--dj`, s, { artists: [edge("artist", "dj", "DJ")] }));
		}
		await put(genreNode("jungle", "Jungle", { landmark_tracks: [tracks[1] as EdgeRef] }));

		await run();

		expect((await read("artist:dj")).reference_track).toEqual(tracks[1]);
		const m = await manifestOf();
		expect(m.byReason.reference_track.genreLandmark).toBe(1);
		expect(m.written).toEqual({ landmark_project: 0, reference_track: 1 });
	});
});

describe("identity: a target that does not credit the artist is never chosen", () => {
	it("excludes it even when it is the first, genre-referenced and imaged, and takes the credited one", async () => {
		// "Reprazent" by a homonym is listed first in OUR artist's discography, referenced by a genre and
		// imaged: it would win on every signal. It credits another artist, so it is out.
		const foreign = edge("project", "reprazent--other", "Reprazent");
		const mine = edge("project", "mine--roni", "Mine");
		await put(artistNode("roni", "Roni", { discography: [foreign, mine] }));
		await put(album("reprazent--other", "other", { image_url: IMG, image_source: "caa" }));
		await put(album("mine--roni", "roni"));
		await put(genreNode("drum-and-bass", "Drum and bass", { landmark_projects: [foreign] }));

		await run();

		expect((await read("artist:roni")).landmark_project).toEqual(mine);
		const m = await manifestOf();
		expect(m.excluded).toEqual([
			{
				artist: "artist:roni",
				field: "landmark_project",
				target: "project:reprazent--other",
				reason: "not-credited",
			},
		]);
		expect(m.byReason.landmark_project).toEqual({ genreLandmark: 0, imaged: 0, cached: 1, first: 0 });
	});

	it("skips the artist when every entry is excluded (no field written, file unchanged)", async () => {
		const foreign = edge("track", "song--other", "Song");
		await put(artistNode("solo", "Solo", { notable_tracks: [foreign] }));
		await put(trackNode("song--other", "Song", { artists: [edge("artist", "other", "Other")] }));
		const before = await readFile(pathOf(cacheDir, "artist:solo"), "utf8");

		await run();

		expect(await readFile(pathOf(cacheDir, "artist:solo"), "utf8")).toBe(before);
		const m = await manifestOf();
		expect(m.skipped.reference_track).toEqual(["artist:solo"]);
		expect(m.excluded).toHaveLength(1);
		expect(m.written.reference_track).toBe(0);
	});

	it("accepts a target that credits the artist by mbid under another slug, and keeps an uncached one eligible", async () => {
		const byMbid = edge("project", "viaid--x", "ViaId");
		const uncached = edge("project", "ghost--x", "Ghost");
		await put(artistNode("x", "X", { mbid: MBID_A, discography: [uncached, byMbid] }));
		await put(album("viaid--x", "x", { artists: [edge("artist", "x-renamed", "X", { mbid: MBID_A })] }));

		await run();

		// byMbid is cached and credited (score 1): it beats the uncached first entry (score 0).
		expect((await read("artist:x")).landmark_project).toEqual(byMbid);
		expect((await manifestOf()).excluded).toEqual([]);
	});

	it("excludes a target whose file cannot be read", async () => {
		const broken = edge("project", "broken--y", "Broken");
		await put(artistNode("y", "Y", { discography: [broken] }));
		await put({ slug: "project:broken--y" });

		await run();

		const m = await manifestOf();
		expect(m.excluded).toEqual([
			{ artist: "artist:y", field: "landmark_project", target: "project:broken--y", reason: "unreadable" },
		]);
		expect(m.skipped.landmark_project).toEqual(["artist:y"]);
	});

	it("excludes a target whose file is not even valid JSON, once, and ignores an unrelated corrupt file", async () => {
		const broken = edge("project", "trunc--z", "Trunc");
		const ok = edge("project", "ok--z", "Ok");
		// The same slug listed twice must be one candidate (one exclusion row).
		await put(artistNode("z", "Z", { discography: [broken, broken, ok] }));
		await put(album("ok--z", "z"));
		await mkdir(join(cacheDir, "nodes", "project"), { recursive: true });
		await writeFile(pathOf(cacheDir, "project:trunc--z"), '{"slug": "project:trunc--z", "na');
		await mkdir(join(cacheDir, "nodes", "label"), { recursive: true });
		await writeFile(pathOf(cacheDir, "label:corrupt"), "not json");

		const result = await run();

		expect(result.exitCode).toBe(0);
		expect((await read("artist:z")).landmark_project).toEqual(ok);
		expect((await manifestOf()).excluded).toEqual([
			{ artist: "artist:z", field: "landmark_project", target: "project:trunc--z", reason: "unreadable" },
		]);
	});

	it("fails the run (exit 1) on an unreadable artist file and writes nothing for it", async () => {
		await mkdir(join(cacheDir, "nodes", "artist"), { recursive: true });
		await writeFile(pathOf(cacheDir, "artist:bad"), "{");

		const result = await run();

		expect(result.exitCode).toBe(1);
		expect((await manifestOf()).failed.map((f) => f.slug)).toEqual(["artist:bad"]);
	});

	it("choose() is pure: the signals count only for a credited target", () => {
		const e = (slug: string) => ({ slug, type: "project", name: slug });
		const picked = choose([
			{ edge: e("project:a"), slug: "project:a", state: { kind: "uncredited" }, genres: 3 },
			{ edge: e("project:b"), slug: "project:b", state: { kind: "credited", imaged: false }, genres: 0 },
		]);
		expect(picked).toMatchObject({ kind: "chosen", slug: "project:b", reason: "cached" });
		expect(choose([])).toEqual({ kind: "empty" });
	});
});

describe("run contract", () => {
	async function fixture(dir: string): Promise<void> {
		const d: EdgeRef[] = ["a1", "a2"].map((s) => edge("project", `${s}--idem`, s));
		const t: EdgeRef[] = [edge("track", "t1--idem", "t1")];
		await put(artistNode("idem", "Idem", { discography: d, notable_tracks: t }), dir);
		await put(album("a2--idem", "idem", { image_url: IMG, image_source: "caa" }), dir);
		await put(trackNode("t1--idem", "t1", { artists: [edge("artist", "idem", "Idem")] }), dir);
		await put(genreNode("g", "G"), dir);
	}

	it("is idempotent: a second apply changes no byte and writes nothing", async () => {
		await fixture(cacheDir);
		await run();
		const after = await readFile(pathOf(cacheDir, "artist:idem"), "utf8");
		expect((await manifestOf()).written).toEqual({ landmark_project: 1, reference_track: 1 });

		const second = await run();

		expect(await readFile(pathOf(cacheDir, "artist:idem"), "utf8")).toBe(after);
		expect(second.written).toEqual([]);
		expect((await manifestOf()).written).toEqual({ landmark_project: 0, reference_track: 0 });
	});

	it("adds only landmark_project and reference_track", async () => {
		await fixture(cacheDir);
		const before = await read("artist:idem");
		await run();
		const { landmark_project, reference_track, ...rest } = await read("artist:idem");
		expect(rest).toEqual(before);
		expect(landmark_project).toBeDefined();
		expect(reference_track).toBeDefined();
	});

	it("dry-run writes no node and gives the manifest of an apply, byte for byte, with the channel's constants", async () => {
		await fixture(cacheDir);
		const copy = join(root, "copy");
		await cp(cacheDir, copy, { recursive: true });
		const before = await readFile(pathOf(cacheDir, "artist:idem"), "utf8");

		await run(false, cacheDir, manifestPath);
		expect(await readFile(pathOf(cacheDir, "artist:idem"), "utf8")).toBe(before);
		await run(true, copy, join(root, "out", "apply.json"));

		const dry = await readFile(manifestPath, "utf8");
		expect(dry).toBe(await readFile(join(root, "out", "apply.json"), "utf8"));
		expect(JSON.parse(dry)).toMatchObject({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
		});
	});

	it("parses the channel's flags and ignores --data-dir", () => {
		expect(parseCliArgs(["c", "--apply", "--manifest", "m.json", "--data-dir", "d"])).toEqual({
			cacheDir: "c",
			apply: true,
			manifestPath: "m.json",
		});
		expect(parseCliArgs(["c"])?.manifestPath).toBe("out/landmark.json");
		expect(parseCliArgs(["c", "--manifest"])).toBeNull();
		expect(parseCliArgs(["c", "--unknown"])).toBeNull();
		expect(parseCliArgs([])).toBeNull();
	});
});
