import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Candidate,
	choose,
	type LandmarkManifest,
	MIGRATION_NAME,
	mentionedIn,
	normalizeText,
	parseCliArgs,
	type Reason,
	runBackfill,
	yearOf,
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
	dataDir = join(root, "data");
	await writeRedirects({});
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

/** The redirect tables of a run: a temp data dir (the channel's --data-dir), empty unless a test fills it. */
let dataDir: string;
const writeRedirects = async (slugs: Record<string, string>, genres: Record<string, string> = {}) => {
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects: slugs }));
	await writeFile(join(dataDir, "genre-redirects.json"), JSON.stringify({ redirects: genres }));
};

const run = (apply = true, dir = cacheDir, manifest = manifestPath) =>
	runBackfill({ cacheDir: dir, apply, manifestPath: manifest, dataDir });

/** The per-reason counters of a manifest, zero unless given. */
const reasons = (given: Partial<Record<Reason, number>>): Record<Reason, number> => ({
	genreLandmark: 0,
	mentioned: 0,
	album: 0,
	imaged: 0,
	cached: 0,
	first: 0,
	...given,
});

/** An article that quotes `titles` (the default fixture article quotes nothing). */
const articleQuoting = (...titles: string[]): string =>
	`A long article that talks about the artist, well past the eighty character floor. Known for ${titles.map((t) => `"${t}"`).join(" and ")}.`;

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
		expect(m.byReason.landmark_project).toEqual(reasons({ genreLandmark: 1 }));
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
		expect(m.byReason.landmark_project).toEqual(reasons({ imaged: 1, cached: 1, first: 1 }));
		expect(m.skipped.landmark_project).toEqual(["artist:empty"]);
		expect(m.skipped.reference_track).toEqual([
			"artist:cached",
			"artist:empty",
			"artist:first",
			"artist:imaged",
		]);
	});

	it("breaks a tie without any year by list order and copies the edge as is (mbid, releaseType, artist)", async () => {
		// TRA-601: the tie went to the first of the list only; it now goes to the oldest year first, so this
		// case has no year (an `ep`, to stay out of the `album` signal) and the list order decides.
		const first = edge("project", "t1--tie", "T1", { mbid: MBID_A, releaseType: "ep", artist: "Tie" });
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
		expect(m.byReason.landmark_project).toEqual(reasons({ cached: 1 }));
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

	it("excludes an absent target that a redirect sends to another artist's work (Byrds -> Dylan)", async () => {
		const bare = edge("track", "mr-tambourine-man", "Mr. Tambourine Man");
		const mine = edge("track", "turn-turn-turn--the-byrds", "Turn! Turn! Turn!");
		await put(artistNode("the-byrds", "The Byrds", { notable_tracks: [bare, mine] }));
		// The bare slug is no node: the reads open the Dylan track it redirects to, which is in the cache.
		await put(
			trackNode("mr-tambourine-man--bob-dylan", "Mr. Tambourine Man", {
				artists: [edge("artist", "bob-dylan", "Bob Dylan")],
			}),
		);
		// `mine` is not in the cache: eligible with a score of 0, and listed AFTER the bare slug, which would
		// win as `first` if the redirect were not followed.
		await writeRedirects({ "track:mr-tambourine-man": "track:mr-tambourine-man--bob-dylan" });

		await run();

		expect((await read("artist:the-byrds")).reference_track).toEqual(mine);
		expect((await manifestOf()).excluded).toEqual([
			{
				artist: "artist:the-byrds",
				field: "reference_track",
				target: "track:mr-tambourine-man",
				reason: "not-credited",
			},
		]);
	});

	it("excludes a redirected target whose destination is not in the cache, unless it is scoped on the artist", async () => {
		const foreign = edge("project", "incunabula", "Incunabula");
		await put(artistNode("sean-booth", "Sean Booth", { discography: [foreign] }));
		await put(artistNode("only-own", "Only Own", { discography: [edge("project", "ghost", "Ghost")] }));
		await writeRedirects({
			"project:incunabula": "project:incunabula--method-of-defiance", // not in the cache: prod-only
			"project:ghost": "project:ghost--only-own", // lands on a slug scoped on the artist
		});

		await run();

		const m = await manifestOf();
		expect(m.excluded).toContainEqual({
			artist: "artist:sean-booth",
			field: "landmark_project",
			target: "project:incunabula",
			reason: "redirected",
		});
		expect(m.skipped.landmark_project).toContain("artist:sean-booth");
		expect((await read("artist:sean-booth")).landmark_project).toBeUndefined();
		// Scoped on the artist itself: eligible (score 0), copied with the slug of the list.
		expect((await read("artist:only-own")).landmark_project).toEqual(edge("project", "ghost", "Ghost"));
	});

	it("accepts a redirected target whose destination credits the artist, keeps the list's slug, reads the signals on the destination", async () => {
		const oldSlug = edge("project", "old-name", "New Name");
		const filler = edge("project", "filler--acc", "Filler");
		await put(artistNode("acc", "Acc", { discography: [filler, oldSlug] }));
		await put(album("filler--acc", "acc"));
		await put(album("new-name--acc", "acc", { image_url: IMG, image_source: "caa" }));
		await put(genreNode("g", "G", { landmark_projects: [edge("project", "new-name--acc", "New Name")] }));
		await writeRedirects({ "project:old-name": "project:new-name--acc" });

		await run();

		// genreLandmark (+100) and imaged (+10) are read on the destination; the pick keeps the artist's slug.
		expect((await read("artist:acc")).landmark_project).toEqual(oldSlug);
		expect((await manifestOf()).picks).toContainEqual({
			artist: "artist:acc",
			field: "landmark_project",
			target: "project:old-name",
			reason: "genreLandmark",
			score: 111,
		});
	});

	it("lets a live node win over a redirect keyed on its own slug (the reads' rule)", async () => {
		const live = edge("project", "live--liv", "Live");
		await put(artistNode("liv", "Liv", { discography: [live] }));
		await put(album("live--liv", "liv"));
		await writeRedirects({ "project:live--liv": "project:elsewhere--other" });

		await run();

		expect((await read("artist:liv")).landmark_project).toEqual(live);
		expect((await manifestOf()).excluded).toEqual([]);
	});

	it("refuses the run, writing nothing, when a redirect table is unreadable or missing", async () => {
		await put(artistNode("t", "T", { discography: [edge("project", "p--t", "P")] }));
		const before = await readFile(pathOf(cacheDir, "artist:t"), "utf8");

		await writeFile(join(dataDir, "slug-redirects.json"), "{ not json");
		await expect(run()).rejects.toThrow();
		await writeFile(
			join(dataDir, "slug-redirects.json"),
			JSON.stringify({ redirects: { "track:a": "project:b" } }),
		);
		await expect(run()).rejects.toThrow(/type mismatch/);
		await rm(join(dataDir, "slug-redirects.json"));
		await expect(run()).rejects.toThrow(/redirect table not found/);

		expect(await readFile(pathOf(cacheDir, "artist:t"), "utf8")).toBe(before);
	});

	it("choose() is pure: the signals count only for a credited target", () => {
		const e = (slug: string) => ({ slug, type: "project", name: slug });
		const c = (slug: string, state: Candidate["state"], genres = 0): Candidate => ({
			edge: e(slug),
			slug,
			state,
			genres,
			mentioned: false,
			album: false,
			namedAfterArtist: false,
			emptyCredit: false,
			year: null,
		});
		const picked = choose(
			[c("project:a", { kind: "uncredited" }, 3), c("project:b", { kind: "credited", imaged: false })],
			{ oldestFirst: true },
		);
		expect(picked).toMatchObject({ kind: "chosen", slug: "project:b", reason: "cached" });
		expect(choose([], { oldestFirst: true })).toEqual({ kind: "empty" });
	});
});

describe("rule v2 (TRA-601)", () => {
	const pickOf = async (artist: string, field = "landmark_project") =>
		(await manifestOf()).picks.find((p) => p.artist === artist && p.field === field);

	it("takes the older album quoted in the article over the recent single listed first, reason mentioned", async () => {
		const single = edge("project", "fresh-single", "Fresh Single", { year: "2024", releaseType: "single" });
		const old = edge("project", "old-record", "Old Record", { year: "1997", releaseType: "album" });
		await put(
			artistNode("daft", "Daft", {
				discography: [single, old],
				editorial_article: articleQuoting("Old Record"),
			}),
		);

		await run();

		expect((await read("artist:daft")).landmark_project).toEqual(old);
		expect(await pickOf("artist:daft")).toMatchObject({ target: "project:old-record", reason: "mentioned" });
		// 50 (mentioned) + 20 (album): the target is not in the cache, so no cached / imaged point.
		expect((await pickOf("artist:daft"))?.score).toBe(70);
	});

	it("without any signal but the release type, takes the 1997 album over the 2024 single listed first", async () => {
		const single = edge("project", "fresh-single", "Fresh Single", { year: "2024", releaseType: "single" });
		const old = edge("project", "old-record", "Old Record", { year: "1997", releaseType: "album" });
		await put(artistNode("plain", "Plain", { discography: [single, old] }));

		await run();

		expect((await read("artist:plain")).landmark_project).toEqual(old);
		expect(await pickOf("artist:plain")).toMatchObject({ reason: "album", score: 20 });
	});

	it("reads the release type of a cached target when the edge has none", async () => {
		const bare = edge("project", "bare--typed", "Bare");
		const other = edge("project", "other--typed", "Other");
		await put(artistNode("typed", "Typed", { discography: [other, bare] }));
		await put(album("other--typed", "typed", { release_type: "single" }));
		await put(album("bare--typed", "typed", { release_type: "album" }));

		await run();

		expect((await read("artist:typed")).landmark_project).toEqual(bare);
		expect(await pickOf("artist:typed")).toMatchObject({ reason: "album", score: 21 });
	});

	it("breaks a tie by the oldest year, an entry without a year coming after those that have one", async () => {
		const noYear = edge("project", "a-undated", "Undated");
		const recent = edge("project", "b-recent", "Recent", { year: "2010", releaseType: "ep" });
		const oldest = edge("project", "c-oldest", "Oldest", { year: "1999", releaseType: "ep" });
		await put(artistNode("ties", "Ties", { discography: [noYear, recent, oldest] }));
		await put(artistNode("undated", "Undated Artist", { discography: [noYear, recent] }));

		await run();

		expect((await read("artist:ties")).landmark_project).toEqual(oldest);
		expect((await read("artist:undated")).landmark_project).toEqual(recent);
		expect(await pickOf("artist:ties")).toMatchObject({ reason: "first", score: 0 });
	});

	it("keeps the list order for equal years, and for the tracks whatever their years", async () => {
		const a = edge("project", "a-same", "Same A", { year: "2001", releaseType: "ep" });
		const b = edge("project", "b-same", "Same B", { year: "2001", releaseType: "ep" });
		const young = edge("track", "young", "Young Song", { year: "2020" });
		const old = edge("track", "old", "Old Song", { year: "1980" });
		await put(artistNode("list", "List", { discography: [a, b], notable_tracks: [young, old] }));

		await run();

		expect((await read("artist:list")).landmark_project).toEqual(a);
		// reference_track: "ties go to the list order, unchanged": the year does not count there.
		expect((await read("artist:list")).reference_track).toEqual(young);
	});

	it("excludes a cached work that credits 3 artists without a scope on the artist, reason compilation", async () => {
		const kob = edge("project", "kind-of-blue--miles-davis", "Kind of Blue", { year: "1959" });
		const own = edge("project", "giant-steps--john-coltrane", "Giant Steps", { year: "1960" });
		const credits = ["miles-davis", "john-coltrane", "cannonball-adderley"].map((s) => edge("artist", s, s));
		await put(artistNode("john-coltrane", "John Coltrane", { discography: [kob, own] }));
		await put(artistNode("miles-davis", "Miles Davis", { discography: [kob] }));
		await put(
			projectNode("kind-of-blue--miles-davis", "Kind of Blue", {
				artists: credits,
				image_url: IMG,
				image_source: "caa",
			}),
		);
		await put(album("giant-steps--john-coltrane", "john-coltrane"));

		await run();

		// Imaged and older, yet out for the sideman; scoped on Miles Davis, so it stays his.
		expect((await read("artist:john-coltrane")).landmark_project).toEqual(own);
		expect((await read("artist:miles-davis")).landmark_project).toEqual(kob);
		expect((await manifestOf()).excluded).toEqual([
			{
				artist: "artist:john-coltrane",
				field: "landmark_project",
				target: "project:kind-of-blue--miles-davis",
				reason: "compilation",
			},
		]);
	});

	it("does not exclude a work with 2 credits, nor the same work for a reference track", async () => {
		const duo = edge("project", "duo-album", "Duo Album");
		const song = edge("track", "comp-song", "Comp Song");
		await put(artistNode("duo", "Duo", { discography: [duo], notable_tracks: [song] }));
		await put(
			projectNode("duo-album", "Duo Album", {
				artists: [edge("artist", "duo", "Duo"), edge("artist", "mate", "Mate")],
			}),
		);
		const three = [edge("artist", "duo", "Duo"), edge("artist", "m1", "M1"), edge("artist", "m2", "M2")];
		await put(trackNode("comp-song", "Comp Song", { artists: three }));

		await run();

		expect((await read("artist:duo")).landmark_project).toEqual(duo);
		expect((await read("artist:duo")).reference_track).toEqual(song);
		expect((await manifestOf()).excluded).toEqual([]);
	});

	it("skips an artist whose only entry is a compilation, and the identity rules still come first", async () => {
		const comp = edge("project", "various-comp", "Various Comp");
		const foreign = edge("project", "elsewhere--other", "Elsewhere");
		await put(artistNode("lonely", "Lonely", { discography: [comp, foreign] }));
		const three = [
			edge("artist", "lonely", "Lonely"),
			edge("artist", "m1", "M1"),
			edge("artist", "m2", "M2"),
		];
		await put(projectNode("various-comp", "Various Comp", { artists: three }));
		// Does not credit the artist AND has 3 credits: `not-credited`, not `compilation`.
		await put(projectNode("elsewhere--other", "Elsewhere", { artists: three.slice(1) }));

		await run();

		const m = await manifestOf();
		expect(m.skipped.landmark_project).toEqual(["artist:lonely"]);
		expect(m.excluded.map((x) => [x.target, x.reason])).toEqual([
			["project:elsewhere--other", "not-credited"],
			["project:various-comp", "compilation"],
		]);
	});

	it("gives no signal to an entry named like an artist of the cache: it loses to any other, wins alone", async () => {
		const band = edge("project", "the-beatles", "The Beatles");
		const solo = edge("project", "solo-record--paul", "Solo Record");
		// The Beatles' own node carries every signal (imaged, genre landmark, quoted in the article).
		await put(artistNode("the-beatles", "The Beatles", { discography: [] }));
		await put(
			artistNode("paul", "Paul", {
				discography: [band, solo],
				editorial_article: articleQuoting("The Beatles"),
			}),
		);
		await put(
			artistNode("george", "George", {
				discography: [band],
				editorial_article: articleQuoting("The Beatles"),
			}),
		);
		await put(
			album("the-beatles", "paul", {
				artists: [edge("artist", "paul", "Paul"), edge("artist", "george", "George")],
				image_url: IMG,
				image_source: "caa",
			}),
		);
		await put(album("solo-record--paul", "paul"));
		await put(genreNode("rock", "Rock", { landmark_projects: [band] }));

		await run();

		expect((await read("artist:paul")).landmark_project).toEqual(solo);
		expect((await read("artist:george")).landmark_project).toEqual(band);
		// Alone, it is chosen with no signal at all.
		expect(await pickOf("artist:george")).toMatchObject({
			target: "project:the-beatles",
			reason: "first",
			score: 0,
		});
	});

	describe("empty credit (TRA-601)", () => {
		const setup = async (article: string | undefined, credits: EdgeRef[]) => {
			const saw = edge("project", "selected-works", "Selected Works", { releaseType: "ep" });
			const other = edge("project", "other-work--aphex", "Other Work", { releaseType: "ep" });
			await put(
				artistNode("aphex", "Aphex", {
					discography: [other, saw],
					...(article === undefined ? {} : { editorial_article: article }),
				}),
			);
			await put(projectNode("selected-works", "Selected Works", { artists: credits }));
			return { saw, other };
		};

		it("keeps a cached target with an empty credit when the article quotes its title, with its signals", async () => {
			const { saw } = await setup(articleQuoting("Selected Works"), []);

			await run();

			expect((await read("artist:aphex")).landmark_project).toEqual(saw);
			// 50 (mentioned) + 1 (cached): it is eligible with all its signals, and flagged in the manifest.
			expect(await pickOf("artist:aphex")).toEqual({
				artist: "artist:aphex",
				field: "landmark_project",
				target: "project:selected-works",
				reason: "mentioned",
				score: 51,
				emptyCredit: true,
			});
			expect((await manifestOf()).excluded).toEqual([]);
		});

		it("still excludes a cached target with an empty credit that the article does not quote", async () => {
			const { other } = await setup(undefined, []);

			await run();

			expect((await read("artist:aphex")).landmark_project).toEqual(other);
			expect((await manifestOf()).excluded).toEqual([
				{
					artist: "artist:aphex",
					field: "landmark_project",
					target: "project:selected-works",
					reason: "not-credited",
				},
			]);
			expect((await pickOf("artist:aphex"))?.emptyCredit).toBeUndefined();
		});

		it("still excludes a quoted target that credits another artist", async () => {
			const { other } = await setup(articleQuoting("Selected Works"), [
				edge("artist", "somebody-else", "Somebody Else"),
			]);

			await run();

			expect((await read("artist:aphex")).landmark_project).toEqual(other);
			expect((await manifestOf()).excluded).toMatchObject([
				{ target: "project:selected-works", reason: "not-credited" },
			]);
		});
	});

	it("does not flag a non-ASCII title as named after an artist whose name has no ASCII character", async () => {
		// "久石譲" normalizes to "": it must not make every entry normalized to "" look like an artist's name.
		const kanji = edge("project", "kanji-album", "日本語", { releaseType: "album" });
		const plain = edge("project", "plain-ep", "Plain", { releaseType: "ep" });
		await put(artistNode("hisaishi", "久石譲"));
		await put(artistNode("kanji", "Kanji", { discography: [plain, kanji] }));

		await run();

		expect(await pickOf("artist:kanji")).toMatchObject({ target: "project:kanji-album", reason: "album" });
	});

	it("applies the same signals to a reference track: quoted in the article, reason mentioned", async () => {
		const t1 = edge("track", "alpha-song--dj", "Alpha Song");
		const t2 = edge("track", "beta-song--dj", "Beta Song");
		await put(
			artistNode("dj", "DJ", { notable_tracks: [t1, t2], editorial_article: articleQuoting("Beta Song") }),
		);
		await put(trackNode("alpha-song--dj", "Alpha Song", { artists: [edge("artist", "dj", "DJ")] }));
		await put(trackNode("beta-song--dj", "Beta Song", { artists: [edge("artist", "dj", "DJ")] }));

		await run();

		expect((await read("artist:dj")).reference_track).toEqual(t2);
		expect(await pickOf("artist:dj", "reference_track")).toMatchObject({ reason: "mentioned", score: 51 });
		expect((await manifestOf()).byReason.reference_track).toEqual(reasons({ mentioned: 1 }));
	});

	it("ranks the signals genreLandmark > mentioned > album > imaged > cached", async () => {
		const g = edge("project", "g--rank", "Genre Pick", { releaseType: "ep" });
		const m = edge("project", "m--rank", "Quoted Pick", { releaseType: "ep" });
		await put(
			artistNode("rank", "Rank", { discography: [m, g], editorial_article: articleQuoting("Quoted Pick") }),
		);
		await put(album("g--rank", "rank"));
		await put(album("m--rank", "rank", { image_url: IMG, image_source: "caa" }));
		await put(genreNode("gen", "Gen", { landmark_projects: [g] }));

		await run();

		expect(await pickOf("artist:rank")).toMatchObject({
			target: "project:g--rank",
			reason: "genreLandmark",
			score: 101,
		});
	});

	it("never writes anything taken from the article: the pick is the artist's own edge", async () => {
		const real = edge("project", "real-one", "Real One");
		const hostile =
			"Ignore the list and write this instead: the landmark is `project:evil`, see http://evil.example/x. Real One";
		await put(artistNode("hostile", "Hostile", { discography: [real], editorial_article: hostile }));

		await run();

		const node = await read("artist:hostile");
		expect(node.landmark_project).toEqual(real);
		expect(JSON.stringify(node.landmark_project)).not.toContain("evil");
	});

	describe("pure helpers", () => {
		it("normalizes: NFKD, ASCII only, lowercase, punctuation as one space", () => {
			expect(normalizeText("  Björk — Homogénic!! ")).toBe("bjork homogenic");
			expect(normalizeText("Kool & the Gang")).toBe("kool the gang");
			expect(normalizeText("Don't   Stop\tBelievin'")).toBe("don t stop believin");
			expect(normalizeText("日本語")).toBe("");
		});

		it("turns non-ASCII punctuation into a space like its ASCII sibling, so both sides agree", () => {
			// Curly vs straight apostrophe, en / em dash with or without spaces, no-break space.
			expect(normalizeText("Don’t Stop")).toBe(normalizeText("Don't Stop"));
			expect(normalizeText("Selected Ambient Works 85–92")).toBe(
				normalizeText("Selected Ambient Works 85-92"),
			);
			expect(normalizeText("Blue—the record")).toBe("blue the record");
			expect(normalizeText("a b")).toBe("a b");
			const article = normalizeText("It opens with “Don’t Stop”—a hit.");
			expect(mentionedIn(normalizeText("Don't Stop"), [article])).toBe(true);
		});

		it("matches a whole expression bounded by spaces, never a fragment", () => {
			const text = normalizeText("The debut Homework, then Discovery; the homeworkers union and Discovery2.");
			expect(mentionedIn("homework", [text])).toBe(true);
			expect(mentionedIn("discovery", [text])).toBe(true);
			expect(mentionedIn("work", [text])).toBe(false);
			expect(mentionedIn("then discovery", [text])).toBe(true);
			expect(mentionedIn("homework then", [text])).toBe(true);
			expect(mentionedIn("discovery2", [text])).toBe(true);
			expect(mentionedIn("disc", [text])).toBe(false);
		});

		it("ignores a normalized title shorter than 3 characters", () => {
			expect(mentionedIn("ab", ["xx ab yy"])).toBe(false);
			expect(mentionedIn("abc", ["xx abc yy"])).toBe(true);
			expect(mentionedIn("", ["xx yy"])).toBe(false);
		});

		it("reads a year from the first four digits only", () => {
			expect(yearOf("1997")).toBe(1997);
			expect(yearOf("1997-05-01")).toBe(1997);
			expect(yearOf("circa 1997")).toBeNull();
			expect(yearOf(undefined)).toBeNull();
			expect(yearOf("")).toBeNull();
		});
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

	it("parses the channel's flags, --data-dir included", () => {
		expect(parseCliArgs(["c", "--apply", "--manifest", "m.json", "--data-dir", "d"])).toEqual({
			cacheDir: "c",
			apply: true,
			manifestPath: "m.json",
			dataDir: "d",
		});
		expect(parseCliArgs(["c"])?.manifestPath).toBe("out/landmark.json");
		expect(parseCliArgs(["c", "--manifest"])).toBeNull();
		expect(parseCliArgs(["c", "--unknown"])).toBeNull();
		expect(parseCliArgs([])).toBeNull();
	});
});
