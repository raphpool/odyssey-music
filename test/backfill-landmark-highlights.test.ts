import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Candidate,
	choose,
	isNonCanonical,
	isPlaceholder,
	isPlaceholderSlug,
	type LandmarkManifest,
	MIGRATION_NAME,
	mentionedIn,
	normalizeText,
	parseCliArgs,
	type Reason,
	runBackfill,
	stripPhrases,
	yearOf,
} from "../scripts/migrations/2026-10-19-backfill-landmark-highlights.js";
import { parseSlug } from "../src/slug.js";
import type { ArtistNode, EdgeRef, NodePayload } from "../src/types.js";
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
		// A second option, so that the choice is not a sole option without support (rule v3).
		const third = edge("track", "eight-miles-high--the-byrds", "Eight Miles High");
		await put(artistNode("the-byrds", "The Byrds", { notable_tracks: [bare, mine, third] }));
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
		await put(
			artistNode("only-own", "Only Own", {
				discography: [edge("project", "ghost", "Ghost"), edge("project", "second", "Second")],
			}),
		);
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
			single: false,
		});
		const picked = choose(
			[c("project:a", { kind: "uncredited" }, 3), c("project:b", { kind: "credited", imaged: false })],
			{ oldestFirst: true, soleSingleUnsupported: true },
		);
		expect(picked).toMatchObject({ kind: "chosen", slug: "project:b", reason: "cached" });
		expect(choose([], { oldestFirst: true, soleSingleUnsupported: true })).toEqual({ kind: "empty" });
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
		// Alone, it has no signal at all: rule v3, nothing is chosen (v2 chose it).
		expect((await read("artist:george")).landmark_project).toBeUndefined();
		expect((await manifestOf()).soleUnsupported).toEqual([
			{ artist: "artist:george", field: "landmark_project", target: "project:the-beatles" },
		]);
	});

	describe("empty credit (TRA-601)", () => {
		/** The target's own text, as it names the artist (or not). */
		const NAMES_APHEX =
			"A record by Aphex, written and produced in a small flat, well past the eighty character floor.";
		const NAMES_ANOTHER =
			"A record by the UK-based electronic producer DFRNT, made well past the eighty character floor.";

		const setup = async (
			article: string | undefined,
			credits: EdgeRef[],
			targetText = NAMES_APHEX,
			targetSlug = "selected-works",
			artistExtra: Partial<ArtistNode> = {},
		) => {
			const saw = edge("project", targetSlug, "Selected Works", { releaseType: "ep" });
			const other = edge("project", "other-work--aphex", "Other Work", { releaseType: "ep" });
			await put(
				artistNode("aphex", "Aphex", {
					discography: [other, saw],
					...(article === undefined ? {} : { editorial_article: article }),
					...artistExtra,
				}),
			);
			await put(
				projectNode(targetSlug, "Selected Works", {
					artists: credits,
					editorial_article: targetText,
					editorial_pitch: targetText,
				}),
			);
			// The other option is cached and credited: when the target is excluded it is not a sole option
			// without support (rule v3).
			await put(album("other-work--aphex", "aphex"));
			return { saw, other };
		};

		it("keeps a cached target with an empty credit when the artist's article quotes it and its own text names the artist", async () => {
			const { saw } = await setup(articleQuoting("Selected Works"), []);

			await run();

			expect((await read("artist:aphex")).landmark_project).toEqual(saw);
			// 50 (mentioned) and no `cached` point: the target was never shown to credit the artist.
			expect(await pickOf("artist:aphex")).toEqual({
				artist: "artist:aphex",
				field: "landmark_project",
				target: "project:selected-works",
				reason: "mentioned",
				score: 50,
				emptyCredit: true,
			});
			expect((await manifestOf()).excluded).toEqual([]);
		});

		it("accepts an alias of the artist in the target's own text, and the pitch or teaser as well as the article", async () => {
			const { saw } = await setup(
				articleQuoting("Selected Works"),
				[],
				"A record signed by Richard D James, made well past the eighty character floor of the schema.",
				"selected-works",
				{ aliases: [edge("artist", "richard-d-james", "Richard D. James")] },
			);

			await run();

			expect((await read("artist:aphex")).landmark_project).toEqual(saw);
		});

		it("excludes a bare target whose own text names ANOTHER artist (a homonym), even when the article quotes it", async () => {
			const { other } = await setup(articleQuoting("Selected Works"), [], NAMES_ANOTHER);

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
		});

		it("excludes a bare target whose slug is scoped on somebody else, even when its text names the artist", async () => {
			const { other } = await setup(
				articleQuoting("Selected Works"),
				[],
				NAMES_APHEX,
				"selected-works--bob-dylan",
			);

			await run();

			expect((await read("artist:aphex")).landmark_project).toEqual(other);
			expect((await manifestOf()).excluded).toMatchObject([
				{ target: "project:selected-works--bob-dylan", reason: "not-credited" },
			]);
		});

		it("excludes the redirect Byrds -> a bare Dylan track, whose scope proves a foreign credit", async () => {
			const bare = edge("track", "mr-tambourine-man", "Mr. Tambourine Man");
			const mine = edge("track", "turn-turn-turn--the-byrds", "Turn! Turn! Turn!");
			const third = edge("track", "eight-miles-high--the-byrds", "Eight Miles High");
			await put(
				artistNode("the-byrds", "The Byrds", {
					notable_tracks: [bare, mine, third],
					editorial_article: articleQuoting("Mr. Tambourine Man"),
				}),
			);
			// Empty credit, quoted, and its own text names the Byrds: only the scope on Dylan blocks it.
			await put(
				trackNode("mr-tambourine-man--bob-dylan", "Mr. Tambourine Man", {
					artists: [],
					editorial_teaser: "The Byrds turned it into a hit, well past the floor of the schema.",
				}),
			);
			await writeRedirects({ "track:mr-tambourine-man": "track:mr-tambourine-man--bob-dylan" });

			await run();

			expect((await read("artist:the-byrds")).reference_track).toEqual(mine);
			expect((await manifestOf()).excluded).toContainEqual({
				artist: "artist:the-byrds",
				field: "reference_track",
				target: "track:mr-tambourine-man",
				reason: "not-credited",
			});
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

	describe("fortuitous quotations (review of 2026-10-17)", () => {
		/** `title` is listed second, `Other Thing` first: a title that does not count leaves the list order. */
		const chosenOver = async (
			artistName: string,
			article: string,
			title: string,
			field: "landmark_project" | "reference_track" = "landmark_project",
		) => {
			const type = field === "landmark_project" ? "project" : "track";
			const list = field === "landmark_project" ? "discography" : "notable_tracks";
			const other = edge(type, "other-thing", "Other Thing");
			const target = edge(type, "the-target", title);
			await put(artistNode("subject", artistName, { [list]: [other, target], editorial_article: article }));
			await run();
			return {
				other,
				target,
				pick: await pickOf("artist:subject", field),
				node: await read("artist:subject"),
			};
		};

		it("does not take the artist's own name for a quoted title (Chuck Berry -> Chuck)", async () => {
			const { pick } = await chosenOver("Chuck Berry", articleQuoting("Chuck Berry"), "Chuck");
			expect(pick).toMatchObject({ target: "project:other-thing", reason: "first" });
		});

		it("still counts a title that contains the artist's name (Chuck Berry Is on Top)", async () => {
			const { pick } = await chosenOver(
				"Chuck Berry",
				articleQuoting("Chuck Berry Is on Top"),
				"Chuck Berry Is on Top",
			);
			expect(pick).toMatchObject({ target: "project:the-target", reason: "mentioned" });
		});

		it("does not take a genre's name for a quoted title (Carlos Gardel -> Tango, Dougal -> Acid)", async () => {
			await put(genreNode("argentine-tango", "Argentine Tango"));
			await put(genreNode("acid-house", "Acid House"));
			const tango = await chosenOver(
				"Carlos Gardel",
				"The king of the argentine tango, a singer well past the eighty character floor of the schema.",
				"Tango",
			);
			expect(tango.pick).toMatchObject({ target: "project:other-thing", reason: "first" });

			const acid = await chosenOver(
				"Dougal",
				"A leading acid house DJ, well past the eighty character floor of the schema, in the UK.",
				"Acid",
			);
			expect(acid.pick).toMatchObject({ target: "project:other-thing", reason: "first" });
		});

		it("never counts a title that is exactly a genre's name, nor an artist's name", async () => {
			await put(genreNode("tango", "Tango"));
			const { pick } = await chosenOver("Gardel", articleQuoting("Tango"), "Tango");
			expect(pick).toMatchObject({ target: "project:other-thing", reason: "first" });
		});

		it("ignores a title made of a year (Earl Sweatshirt -> 2010)", async () => {
			const { pick } = await chosenOver(
				"Earl Sweatshirt",
				"A rapper from Chicago whose first record, released in 2010, was a surprise, well past the floor.",
				"2010",
				"reference_track",
			);
			expect(pick).toMatchObject({ target: "track:other-thing", reason: "first" });
		});

		it("strips phrases as whole expressions only, and all their occurrences", () => {
			expect(stripPhrases("an acid house night and acid house again", ["acid house"])).toBe(
				"an night and again",
			);
			expect(stripPhrases("acid house acid house", ["acid house"])).toBe("");
			expect(stripPhrases("a houseboat", ["house"])).toBe("a houseboat");
			expect(stripPhrases("dance hall", ["dance", "dance hall"])).toBe("");
		});
	});

	describe("works named after an artist, and ties (review of 2026-10-17)", () => {
		it("keeps a work named like the artist when its slug is scoped on that artist (Skream!, Inside)", async () => {
			const own = edge("project", "skream--skream", "Skream!");
			const other = edge("project", "outside-the-box--skream", "Outside the Box");
			await put(artistNode("skream", "Skream", { discography: [other, own] }));
			await put(album("skream--skream", "skream"));
			await put(album("outside-the-box--skream", "skream"));
			await put(genreNode("dubstep", "Dubstep", { landmark_projects: [own] }));
			const horn = edge("project", "inside--paul-horn", "Inside");
			const second = edge("project", "second--paul-horn", "Second");
			await put(artistNode("paul-horn", "Paul Horn", { discography: [second, horn] }));
			await put(artistNode("inside", "Inside"));
			await put(album("inside--paul-horn", "paul-horn"));
			await put(album("second--paul-horn", "paul-horn"));
			await put(genreNode("new-age", "New Age", { landmark_projects: [horn] }));

			await run();

			expect((await read("artist:skream")).landmark_project).toEqual(own);
			expect((await read("artist:paul-horn")).landmark_project).toEqual(horn);
			expect(await pickOf("artist:skream")).toMatchObject({ reason: "genreLandmark", score: 101 });
		});

		it("on a tie, an entry named after an artist loses to any other, whatever the list order", async () => {
			// Both uncached, no year, no signal: only the name downgrade can order them (not the score).
			const band = edge("project", "the-beatles", "The Beatles");
			const plain = edge("project", "plain-record", "Plain Record");
			await put(artistNode("the-beatles", "The Beatles"));
			await put(artistNode("fan", "Fan", { discography: [band, plain] }));

			await run();

			expect((await read("artist:fan")).landmark_project).toEqual(plain);
		});

		it("an entry without a year comes after those that have one, whatever the list order", async () => {
			const dated = edge("project", "dated", "Dated", { year: "2010", releaseType: "ep" });
			const undated = edge("project", "undated", "Undated", { releaseType: "ep" });
			await put(artistNode("before", "Before", { discography: [undated, dated] }));
			await put(artistNode("after", "After", { discography: [dated, undated] }));

			await run();

			expect((await read("artist:before")).landmark_project).toEqual(dated);
			expect((await read("artist:after")).landmark_project).toEqual(dated);
		});

		it("never gives the `album` signal to a track, even when its edge says album", async () => {
			const first = edge("track", "first-song", "First Song");
			const second = edge("track", "second-song", "Second Song", { releaseType: "album" });
			await put(artistNode("songs", "Songs", { notable_tracks: [first, second] }));

			await run();

			expect((await read("artist:songs")).reference_track).toEqual(first);
			expect(await pickOf("artist:songs", "reference_track")).toMatchObject({ reason: "first", score: 0 });
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

describe("rule v3 (TRA-601)", () => {
	const pickOf = async (artist: string, field = "landmark_project") =>
		(await manifestOf()).picks.find((p) => p.artist === artist && p.field === field);

	describe("non-canonical releases", () => {
		it("recognises remixes, mixes, best-ofs, bootlegs, live recordings and soundtracks by their title", () => {
			for (const title of [
				"Saturday Night Fever (soundtrack)",
				"Saturday Night Fever: The Original Movie Soundtrack",
				"Dune (Original Motion Picture Soundtrack)",
				"Shaft [OST]",
				"Shaft (OST) Part 1", // in parentheses, but not at the end
				"Soundtrack to My Life (Soundtrack) Deluxe",
				"Shaft OST",
				"Anthologie",
				"Anthology 1",
				"The Very Best of Someone",
				"The Best Of",
				"The Best of Two Worlds", // accepted false positive
				"Greatest Hits Vol. 2",
				"DISCO ARABICA - Beppe Loda Rmx",
				"Maru (Skee Mask Remix)",
				"The Remixes",
				"Remixed",
				"Nazira DJ set - Miller Mix: Almaty 2024",
				"Club Night (DJ Mix)",
				"Mixed by Somebody",
				"Megamix",
				"Medley",
				"Bootleg Series Vol. 1",
			]) {
				expect(isNonCanonical(title), title).toBe(true);
			}
		});

		it("does not take for non-canonical a studio record that merely looks like one", () => {
			for (const title of [
				"Mix-Up", // Cabaret Voltaire: `mix` alone is not in the list
				"Mixed Emotions",
				"Remixology", // not a whole expression
				"Soundtrack to My Life", // a soundtrack marker counts at the end or in parentheses only
				"Ostrich",
				"The Best Is Yet to Come",
				"Alive at Last",
				"Live and Let Die",
				"Anthem",
				"Best Of Both Worlds", // Opolopo: "best of" counts at the head of the title only
				"Live at the Apollo", // live recordings are landmarks
				"Live at the Paradise Garage",
				"The Very Best", // only "the (very) best of"
				"The Best Offer", // a whole expression, not a prefix
				"Homework",
				"",
			]) {
				expect(isNonCanonical(title), title).toBe(false);
			}
		});

		it("excludes such an entry from the choice, for both fields, with the reason non-canonical", async () => {
			const remix = edge("project", "club-remix", "Maru (Skee Mask Remix)", {
				releaseType: "album",
				year: "1990",
			});
			const studio = edge("project", "studio-one", "Studio One", { year: "2001" });
			const studio2 = edge("project", "studio-two", "Studio Two", { year: "2002" });
			const rt = edge("track", "maru-remix", "Maru (Skee Mask Remix)");
			const t1 = edge("track", "wondergan", "Wondergan");
			const t2 = edge("track", "other", "Other Song");
			await put(
				artistNode("plaid", "Plaid", {
					discography: [remix, studio, studio2],
					notable_tracks: [rt, t1, t2],
				}),
			);

			await run();

			// The remix has the `album` signal and the oldest year: it would win without the exclusion.
			expect((await read("artist:plaid")).landmark_project).toEqual(studio);
			expect((await read("artist:plaid")).reference_track).toEqual(t1);
			expect((await manifestOf()).excluded).toEqual([
				{
					artist: "artist:plaid",
					field: "landmark_project",
					target: "project:club-remix",
					reason: "non-canonical",
				},
				{
					artist: "artist:plaid",
					field: "reference_track",
					target: "track:maru-remix",
					reason: "non-canonical",
				},
			]);
		});

		it("keeps Mix-Up: `mix` alone does not exclude it", async () => {
			const mixUp = edge("project", "mix-up", "Mix-Up", { releaseType: "album", year: "1979" });
			const other = edge("project", "other-record", "Other Record", { year: "1981" });
			await put(artistNode("cabaret", "Cabaret", { discography: [other, mixUp] }));

			await run();

			expect((await read("artist:cabaret")).landmark_project).toEqual(mixUp);
			expect((await manifestOf()).excluded).toEqual([]);
		});

		it("leaves the identity reason first: a remix that does not credit the artist is not-credited", async () => {
			const remix = edge("project", "club-remix", "Club Remix");
			const studio = edge("project", "studio-one", "Studio One");
			const studio2 = edge("project", "studio-two", "Studio Two");
			await put(artistNode("dj", "DJ", { discography: [remix, studio, studio2] }));
			await put(album("club-remix", "somebody-else"));

			await run();

			expect((await manifestOf()).excluded).toEqual([
				{
					artist: "artist:dj",
					field: "landmark_project",
					target: "project:club-remix",
					reason: "not-credited",
				},
			]);
		});

		it("skips the artist whose only entries are non-canonical", async () => {
			await put(
				artistNode("only-mixes", "Only Mixes", {
					discography: [edge("project", "m1", "Night Megamix"), edge("project", "m2", "Day Medley")],
				}),
			);

			await run();

			const m = await manifestOf();
			expect(m.skipped.landmark_project).toEqual(["artist:only-mixes"]);
			expect(m.soleUnsupported).toEqual([]);
			expect(m.excluded.map((e) => e.reason)).toEqual(["non-canonical", "non-canonical"]);
		});
	});

	describe("a sole option without support", () => {
		it("chooses no album when the only option is a lone single, and no track when it is named after an artist", async () => {
			await put(artistNode("emperor", "Emperor"));
			await put(
				artistNode("killer-kau", "Killer Kau", {
					discography: [
						edge("project", "amaneighbour", "Amaneighbour", { year: "2021", releaseType: "single" }),
					],
				}),
			);
			await put(
				artistNode("the-band", "The Band", {
					notable_tracks: [edge("track", "the-band", "The Band")],
				}),
			);
			const before = await readFile(pathOf(cacheDir, "artist:killer-kau"), "utf8");

			await run();

			expect(await readFile(pathOf(cacheDir, "artist:killer-kau"), "utf8")).toBe(before);
			const m = await manifestOf();
			expect(m.skipped.landmark_project).toContain("artist:killer-kau");
			expect(m.skipped.reference_track).toContain("artist:the-band");
			expect(m.soleUnsupported).toEqual([
				{ artist: "artist:killer-kau", field: "landmark_project", target: "project:amaneighbour" },
				{ artist: "artist:the-band", field: "reference_track", target: "track:the-band" },
			]);
			expect(m.written).toEqual({ landmark_project: 0, reference_track: 0 });
		});

		it("also applies when the other entries were excluded: one eligible lone single is left", async () => {
			const foreign = edge("project", "foreign--other", "Foreign");
			const lone = edge("project", "lone", "Lone", { releaseType: "single" });
			await put(artistNode("left", "Left", { discography: [foreign, lone] }));
			await put(album("foreign--other", "other"));

			await run();

			const m = await manifestOf();
			expect(m.soleUnsupported).toEqual([
				{ artist: "artist:left", field: "landmark_project", target: "project:lone" },
			]);
			expect(m.excluded).toHaveLength(1);
		});

		it("does not apply to a sole entry without signal that is legitimate: Enter, Plasticity", async () => {
			// An uncached album with no type and no year, and a track: unverifiable, not unsupported.
			const enter = edge("project", "enter--juan-atkins", "Enter");
			const plasticity = edge("track", "plasticity", "Plasticity");
			await put(artistNode("juan-atkins", "Juan Atkins", { discography: [enter] }));
			await put(artistNode("richie-hawtin", "Richie Hawtin", { notable_tracks: [plasticity] }));
			// A sole single for a REFERENCE TRACK is not concerned either: the single rule is for albums.
			const song = edge("track", "song", "Song", { releaseType: "single" });
			await put(artistNode("songwriter", "Songwriter", { notable_tracks: [song] }));

			await run();

			expect((await read("artist:juan-atkins")).landmark_project).toEqual(enter);
			expect((await read("artist:richie-hawtin")).reference_track).toEqual(plasticity);
			expect((await read("artist:songwriter")).reference_track).toEqual(song);
			expect((await manifestOf()).soleUnsupported).toEqual([]);
		});

		it("does not apply to a sole single that has a signal (quoted, cached)", async () => {
			const quoted = edge("project", "quoted", "Quoted Work", { releaseType: "single" });
			const cached = edge("project", "cached--cached-artist", "Cached Work", { releaseType: "single" });
			await put(
				artistNode("q", "Q", { discography: [quoted], editorial_article: articleQuoting("Quoted Work") }),
			);
			await put(artistNode("cached-artist", "Cached Artist", { discography: [cached] }));
			await put(album("cached--cached-artist", "cached-artist"));

			await run();

			expect((await read("artist:q")).landmark_project).toEqual(quoted);
			expect((await read("artist:cached-artist")).landmark_project).toEqual(cached);
			expect((await manifestOf()).soleUnsupported).toEqual([]);
		});

		it("does not apply to two entries, even two lone singles: the tie rules choose", async () => {
			const a = edge("project", "a-work", "A Work", { releaseType: "single" });
			const b = edge("project", "b-work", "B Work", { releaseType: "single" });
			await put(artistNode("two", "Two", { discography: [a, b] }));

			await run();

			expect((await read("artist:two")).landmark_project).toEqual(a);
			expect((await manifestOf()).soleUnsupported).toEqual([]);
		});

		it("choose() is pure: only a downgraded entry, or a lone single when asked, gives sole-unsupported", () => {
			const c = (slug: string, extra: Partial<Candidate> = {}): Candidate => ({
				edge: { slug, type: "project", name: slug },
				slug,
				state: { kind: "absent" },
				genres: 0,
				mentioned: false,
				album: false,
				namedAfterArtist: false,
				emptyCredit: false,
				year: null,
				single: false,
				...extra,
			});
			const albums = { oldestFirst: true, soleSingleUnsupported: true };
			const tracks = { oldestFirst: false, soleSingleUnsupported: false };
			expect(choose([c("project:a", { namedAfterArtist: true })], albums)).toMatchObject({
				kind: "sole-unsupported",
				slug: "project:a",
			});
			expect(choose([c("project:a", { namedAfterArtist: true })], tracks)).toMatchObject({
				kind: "sole-unsupported",
			});
			expect(choose([c("project:a", { single: true })], albums)).toMatchObject({ kind: "sole-unsupported" });
			expect(choose([c("project:a", { single: true })], tracks)).toMatchObject({ kind: "chosen" });
			expect(choose([c("project:a")], albums)).toMatchObject({ kind: "chosen", slug: "project:a" });
			expect(choose([c("project:a", { single: true, mentioned: true })], albums)).toMatchObject({
				kind: "chosen",
			});
			expect(
				choose([c("project:a", { single: true }), c("project:b", { single: true })], albums),
			).toMatchObject({ kind: "chosen", slug: "project:a" });
		});
	});

	describe("a verified self-titled record", () => {
		it("is not downgraded when it is in the cache and credits the artist (Suprême NTM)", async () => {
			const best = edge("project", "anthologie", "Anthologie");
			const own = edge("project", "supreme-ntm", "Suprême NTM", { year: "1998" });
			await put(artistNode("supreme-ntm", "Suprême NTM", { discography: [best, own] }));
			await put(album("supreme-ntm", "supreme-ntm"));

			await run();

			expect((await read("artist:supreme-ntm")).landmark_project).toEqual(own);
			// `cached` only: the title is the artist's name, so it is never "quoted".
			expect(await pickOf("artist:supreme-ntm")).toMatchObject({
				target: "project:supreme-ntm",
				reason: "cached",
				score: 1,
			});
		});

		it("wins alone as well, and beats an unsupported entry listed before it", async () => {
			const other = edge("project", "other-work", "Other Work");
			const own = edge("project", "the-band", "The Band");
			await put(artistNode("the-band", "The Band", { discography: [other, own] }));
			await put(album("the-band", "the-band"));
			await put(
				artistNode("solo-band", "Solo Band", { discography: [edge("project", "solo-band", "Solo Band")] }),
			);
			await put(album("solo-band", "solo-band"));

			await run();

			expect((await read("artist:the-band")).landmark_project).toEqual(own);
			expect((await read("artist:solo-band")).landmark_project).toEqual(
				edge("project", "solo-band", "Solo Band"),
			);
		});

		it("is still downgraded when it cannot be verified (not in the cache)", async () => {
			const own = edge("project", "ghost-band", "Ghost Band");
			const other = edge("project", "other-work", "Other Work");
			await put(artistNode("ghost-band", "Ghost Band", { discography: [own, other] }));

			await run();

			// Both are uncached with no signal: the self-titled one is listed first but loses the tie.
			expect((await read("artist:ghost-band")).landmark_project).toEqual(other);
		});

		it("is still downgraded for the name of ANOTHER artist, even when it is cached and credits the artist", async () => {
			const band = edge("project", "the-beatles", "The Beatles");
			const solo = edge("project", "solo-record--lennon", "Solo Record");
			await put(artistNode("the-beatles", "The Beatles"));
			await put(artistNode("lennon", "Lennon", { discography: [band, solo] }));
			await put(album("the-beatles", "lennon"));
			await put(album("solo-record--lennon", "lennon"));

			await run();

			// Both are cached and credited (score 1 each): only the downgrade puts the band after the solo record.
			expect((await read("artist:lennon")).landmark_project).toEqual(solo);
		});
	});
});

describe("placeholder titles (TRA-606)", () => {
	it("recognises a filler title exactly, never a real title that contains the word", () => {
		for (const title of [
			"Unknown",
			"UNKNOWN",
			"Untitled",
			"N/A",
			"n.a.",
			"TBD",
			"None",
			"null",
			"Various",
			"Unknown Album",
			"Unknown Track",
			"  Unknown! ",
		]) {
			expect(isPlaceholder(title), title).toBe(true);
		}
		for (const title of [
			"Unknown Pleasures", // Joy Division
			"Untitled Unmastered", // Kendrick Lamar
			"Unknown Mortal Orchestra",
			"Various Positions", // Leonard Cohen
			"None but the Righteous",
			"Nonexistent",
			"Null Island",
			"Untitled 1",
			"",
		]) {
			expect(isPlaceholder(title), title).toBe(false);
		}
		expect(isPlaceholderSlug("project:unknown")).toBe(true);
		expect(isPlaceholderSlug("track:unknown")).toBe(true);
		expect(isPlaceholderSlug("project:unknown-pleasures")).toBe(false);
		expect(isPlaceholderSlug("project:unknown--someone")).toBe(false);
	});

	it("excludes project:unknown and track:unknown, and leaves the artist skipped when they are the only entries", async () => {
		await put(
			artistNode("nes", "Nes", {
				discography: [edge("project", "unknown", "Unknown")],
				notable_tracks: [edge("track", "unknown", "Unknown")],
			}),
		);
		const before = await readFile(pathOf(cacheDir, "artist:nes"), "utf8");

		await run();

		expect(await readFile(pathOf(cacheDir, "artist:nes"), "utf8")).toBe(before);
		const m = await manifestOf();
		expect(m.excluded).toEqual([
			{ artist: "artist:nes", field: "landmark_project", target: "project:unknown", reason: "placeholder" },
			{ artist: "artist:nes", field: "reference_track", target: "track:unknown", reason: "placeholder" },
		]);
		expect(m.skipped).toEqual({ landmark_project: ["artist:nes"], reference_track: ["artist:nes"] });
		expect(m.soleUnsupported).toEqual([]);
		expect(m.written).toEqual({ landmark_project: 0, reference_track: 0 });
	});

	it("excludes the bare slug whatever the name of the entry, and a filler name under any slug", async () => {
		const bare = edge("project", "unknown", "Debut Album", { releaseType: "album", year: "1990" });
		const filler = edge("project", "n-a--filler", "N/A", { releaseType: "album", year: "1991" });
		const real = edge("project", "real-one", "Real One", { year: "2000" });
		const real2 = edge("project", "real-two", "Real Two", { year: "2001" });
		await put(artistNode("filler", "Filler", { discography: [bare, filler, real, real2] }));

		await run();

		// The two fillers are older albums: they would win without the exclusion.
		expect((await read("artist:filler")).landmark_project).toEqual(real);
		expect((await manifestOf()).excluded).toEqual([
			{
				artist: "artist:filler",
				field: "landmark_project",
				target: "project:n-a--filler",
				reason: "placeholder",
			},
			{
				artist: "artist:filler",
				field: "landmark_project",
				target: "project:unknown",
				reason: "placeholder",
			},
		]);
	});

	it("keeps a real title that contains the word (Unknown Pleasures, Untitled Unmastered)", async () => {
		const pleasures = edge("project", "unknown-pleasures", "Unknown Pleasures", {
			releaseType: "album",
			year: "1979",
		});
		const unmastered = edge("project", "untitled-unmastered", "Untitled Unmastered", {
			releaseType: "album",
			year: "2016",
		});
		await put(artistNode("joy", "Joy", { discography: [unmastered, pleasures] }));

		await run();

		expect((await read("artist:joy")).landmark_project).toEqual(pleasures);
		expect((await manifestOf()).excluded).toEqual([]);
	});

	it("leaves the identity reason first: a cached project:unknown that credits somebody else is not-credited", async () => {
		const bare = edge("project", "unknown", "Unknown");
		const real = edge("project", "real-one", "Real One");
		const real2 = edge("project", "real-two", "Real Two");
		await put(artistNode("homonym", "Homonym", { discography: [bare, real, real2] }));
		await put(album("unknown", "somebody-else"));

		await run();

		expect((await manifestOf()).excluded).toEqual([
			{
				artist: "artist:homonym",
				field: "landmark_project",
				target: "project:unknown",
				reason: "not-credited",
			},
		]);
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
