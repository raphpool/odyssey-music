import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coverArtUrl } from "../../src/images/coverart.js";
import { resolveWorkImageByHint, type WorkImageHint } from "../../src/images/resolve-work-hint.js";
import { lookupVerifiedAlbumArt } from "../../src/itunes.js";
import { resolveRecordingDetailed, resolveReleaseGroupDetailed } from "../../src/musicbrainz.js";
import type { Slug } from "../../src/types.js";
import { jsonResponse, redirectResponse, routedFetch } from "./helpers.js";

// The real MusicBrainz resolvers run (and decide identity, as in the pipeline) over a faked network;
// the wrappers only record how they were called.
vi.mock("../../src/musicbrainz.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/musicbrainz.js")>();
	return {
		...actual,
		resolveReleaseGroupDetailed: vi.fn(actual.resolveReleaseGroupDetailed),
		resolveRecordingDetailed: vi.fn(actual.resolveRecordingDetailed),
	};
});
vi.mock("../../src/itunes.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/itunes.js")>();
	return { ...actual, lookupVerifiedAlbumArt: vi.fn(actual.lookupVerifiedAlbumArt) };
});
vi.mock("../../src/images/coverart.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/images/coverart.js")>();
	return { ...actual, coverArtUrl: vi.fn(actual.coverArtUrl) };
});

// mbFetch memoizes by request for 5 minutes: every test uses titles and MBIDs of its own.
const mb = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COVER = (n: number): string => `https://coverartarchive.org/release-group/${mb(n)}/front-500`;
const ARCHIVE = "https://ia800000.us.archive.org/1/items/x/x.jpg";
const ITUNES_100 = "https://is1-ssl.mzstatic.com/image/thumb/Music/x/source/100x100bb.jpg";
const ITUNES_600 = "https://is1-ssl.mzstatic.com/image/thumb/Music/x/source/600x600bb.jpg";

const ARTIST = "Squarepusher";
const ARTIST_MBID = mb(9000);
const OTHER_ARTIST = "Someone Else";

const credit = (name: string, id = ARTIST_MBID) => [{ name, artist: { id, name } }];
const releaseGroup = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
	id: mb(n),
	score: 100,
	title,
	"artist-credit": credit(ARTIST),
	"first-release-date": "2001-05-14",
	...extra,
});
const recording = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
	id: mb(n),
	score: 100,
	title,
	"artist-credit": credit(ARTIST),
	"first-release-date": "2001-05-14",
	...extra,
});

const mbSearch = (kind: "release-group" | "recording", hits: unknown[]): [string, () => Response] => [
	`musicbrainz.org/ws/2/${kind}`,
	() => jsonResponse({ count: hits.length, [kind === "recording" ? "recordings" : "release-groups"]: hits }),
];
const mbDown: [string, () => Response] = ["musicbrainz.org", () => new Response("no", { status: 400 })];
const caaFound = (n: number): [string, () => Response] => [
	`release-group/${mb(n)}/front-500`,
	() => redirectResponse(ARCHIVE),
];
const caaMissing: [string, () => Response] = ["coverartarchive.org", () => new Response("", { status: 404 })];
const itunesWith = (results: unknown[]): [string, () => Response] => [
	"itunes.apple.com",
	() => jsonResponse({ results }),
];
const itunesAlbum = (collectionName: string, artistName = ARTIST) => ({
	artworkUrl100: ITUNES_100,
	collectionName,
	artistName,
});

const mbCalls = (f: { calls: string[] }): string[] => f.calls.filter((c) => c.includes("musicbrainz.org"));
const caaCalls = (f: { calls: string[] }): string[] => f.calls.filter((c) => c.includes("coverartarchive"));
const itunesCalls = (f: { calls: string[] }): string[] => f.calls.filter((c) => c.includes("itunes"));

const project = (title: string, extra: Partial<WorkImageHint> = {}): WorkImageHint => ({
	slug: `project:${title.toLowerCase().replace(/\W+/g, "-")}` as Slug,
	type: "project",
	title,
	artist: ARTIST,
	...extra,
});
const track = (title: string, extra: Partial<WorkImageHint> = {}): WorkImageHint => ({
	slug: `track:${title.toLowerCase().replace(/\W+/g, "-")}` as Slug,
	type: "track",
	title,
	artist: ARTIST,
	...extra,
});

/** Serves `routes` to MusicBrainz (global fetch) and, as `deps.fetch`, to CAA and iTunes. */
function network(...routes: Array<[string, () => Response]>) {
	const f = routedFetch(routes);
	vi.stubGlobal("fetch", f);
	return f;
}

beforeEach(() => {
	vi.mocked(resolveReleaseGroupDetailed).mockReset(); // back to the wrapped original, queued once-values dropped
	vi.mocked(resolveRecordingDetailed).mockReset(); // back to the wrapped original, queued once-values dropped
	vi.mocked(lookupVerifiedAlbumArt).mockReset(); // back to the wrapped original, queued once-values dropped
	vi.mocked(coverArtUrl).mockReset(); // back to the wrapped original, queued once-values dropped
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveWorkImageByHint: project", () => {
	it("takes the Cover Art Archive cover of a known release group without asking MusicBrainz", async () => {
		const f = network(caaFound(1));
		const out = await resolveWorkImageByHint(project("Hard Normal Daddy", { mbid: mb(1) }), { fetch: f });
		expect(out).toEqual({ kind: "found", url: COVER(1), source: "caa", mbid: mb(1) });
		expect(mbCalls(f)).toEqual([]);
		expect(itunesCalls(f)).toEqual([]);
	});

	it("lets MusicBrainz name the release group when the edge carries no mbid, then asks CAA for it", async () => {
		const f = network(mbSearch("release-group", [releaseGroup(2, "Feed Me Weird Things")]), caaFound(2));
		const out = await resolveWorkImageByHint(project("Feed Me Weird Things"), { fetch: f });
		expect(out).toEqual({ kind: "found", url: COVER(2), source: "caa", mbid: mb(2) });
		expect(mbCalls(f)).toHaveLength(1);
		expect(itunesCalls(f)).toEqual([]);
	});

	it("gives nothing when the only candidate is credited to another artist and iTunes knows no such album", async () => {
		const f = network(
			mbSearch("release-group", [
				releaseGroup(3, "Music Is Rotted One Note", { "artist-credit": credit(OTHER_ARTIST, mb(9001)) }),
			]),
			caaMissing,
			itunesWith([]),
		);
		const out = await resolveWorkImageByHint(project("Music Is Rotted One Note"), { fetch: f });
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
		expect(mbCalls(f)).toHaveLength(1);
		expect(caaCalls(f)).toEqual([]);
	});

	it("stops on two release groups of one title and one credit: no CAA, no iTunes", async () => {
		const f = network(
			mbSearch("release-group", [releaseGroup(4, "Go Plastic"), releaseGroup(5, "Go Plastic")]),
			caaFound(4),
			itunesWith([itunesAlbum("Go Plastic")]),
		);
		const out = await resolveWorkImageByHint(project("Go Plastic"), { fetch: f });
		expect(out).toEqual({ kind: "missing", reason: "ambiguous" });
		expect(caaCalls(f)).toEqual([]);
		expect(itunesCalls(f)).toEqual([]);
		expect(mbCalls(f)).toHaveLength(1);
	});

	it("keeps the Album among look-alikes once the edge says it is one (TRA-560 rule)", async () => {
		const both = [
			releaseGroup(6, "Ultravisitor", { "primary-type": "Single" }),
			releaseGroup(7, "Ultravisitor", { "primary-type": "Album" }),
		];
		const withoutType = network(mbSearch("release-group", both), caaFound(7), itunesWith([]));
		const unknown = await resolveWorkImageByHint(project("Ultravisitor", { artist: "squarepusher" }), {
			fetch: withoutType,
		});
		expect(unknown).toEqual({ kind: "missing", reason: "ambiguous" });

		const f = network(mbSearch("release-group", both), caaFound(7), caaMissing);
		const out = await resolveWorkImageByHint(project("Ultravisitor", { releaseType: "album" }), {
			fetch: f,
		});
		expect(out).toEqual({ kind: "found", url: COVER(7), source: "caa", mbid: mb(7) });
		expect(vi.mocked(resolveReleaseGroupDetailed)).toHaveBeenLastCalledWith("Ultravisitor", ARTIST, {
			releaseType: "album",
		});
		expect(mbCalls(f)).toHaveLength(1);
	});

	it("reports unavailable, and calls neither CAA nor iTunes, when MusicBrainz gives no usable answer", async () => {
		const f = network(mbDown, caaFound(8), itunesWith([itunesAlbum("Shobaleader One")]));
		const out = await resolveWorkImageByHint(project("Shobaleader One"), { fetch: f });
		expect(out).toEqual({ kind: "unavailable" });
		expect(caaCalls(f)).toEqual([]);
		expect(itunesCalls(f)).toEqual([]);
	});

	it("hands deps.mbOptions to the resolver untouched, next to the release type", async () => {
		const f = network(mbSearch("release-group", []), itunesWith([]));
		const mbOptions = { acceptCreditMbids: [mb(9100)], requestedArtistMbid: ARTIST_MBID };
		await resolveWorkImageByHint(project("Selection Sixteen", { releaseType: "EP" }), {
			fetch: f,
			mbOptions,
		});
		expect(vi.mocked(resolveReleaseGroupDetailed)).toHaveBeenCalledWith("Selection Sixteen", ARTIST, {
			...mbOptions,
			releaseType: "EP",
		});
	});

	it("falls back to a verified iTunes match, upscaled, when CAA has no front cover", async () => {
		const f = network(
			mbSearch("release-group", [releaseGroup(10, "Big Loada")]),
			caaMissing,
			itunesWith([itunesAlbum("Big Loada")]),
		);
		const out = await resolveWorkImageByHint(project("Big Loada"), { fetch: f });
		expect(out).toEqual({ kind: "found", url: ITUNES_600, source: "itunes-verified" });
		expect(mbCalls(f)).toHaveLength(1);
	});

	it("falls back to iTunes when MusicBrainz knows no such work", async () => {
		const f = network(mbSearch("release-group", []), itunesWith([itunesAlbum("Do You Know Squarepusher")]));
		const out = await resolveWorkImageByHint(project("Do You Know Squarepusher"), { fetch: f });
		expect(out).toEqual({ kind: "found", url: ITUNES_600, source: "itunes-verified" });
		expect(caaCalls(f)).toEqual([]);
	});

	it("gives no-match when iTunes answers with a different album or artist", async () => {
		const f = network(
			caaMissing,
			itunesWith([itunesAlbum("Another Record Entirely"), itunesAlbum("Damogen Furies", OTHER_ARTIST)]),
		);
		const out = await resolveWorkImageByHint(project("Damogen Furies", { mbid: mb(11) }), { fetch: f });
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
	});

	it("treats an iTunes artwork URL off the allowed hosts as absent", async () => {
		const f = network(
			caaMissing,
			itunesWith([{ ...itunesAlbum("Venus No. 17"), artworkUrl100: "https://evil.example/x/100x100bb.jpg" }]),
		);
		const out = await resolveWorkImageByHint(project("Venus No. 17", { mbid: mb(12) }), { fetch: f });
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
	});
});

describe("resolveWorkImageByHint: URL gate and failing rungs", () => {
	it("drops a URL that a rung hands back off the allowed hosts, whichever rung it came from", async () => {
		vi.mocked(coverArtUrl).mockResolvedValueOnce("https://evil.example/cover.jpg");
		vi.mocked(lookupVerifiedAlbumArt).mockResolvedValueOnce("http://is1-ssl.mzstatic.com/x/600x600bb.jpg");
		const out = await resolveWorkImageByHint(project("Hello Everything", { mbid: mb(13) }));
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
	});

	it("counts a CAA rung that throws as a miss and goes on to iTunes", async () => {
		vi.mocked(coverArtUrl).mockRejectedValueOnce(new Error("boom"));
		vi.mocked(lookupVerifiedAlbumArt).mockResolvedValueOnce(ITUNES_600);
		const out = await resolveWorkImageByHint(project("Just a Souvenir", { mbid: mb(14) }));
		expect(out).toEqual({ kind: "found", url: ITUNES_600, source: "itunes-verified" });
	});

	it("counts a MusicBrainz rung that throws as a miss and goes on to iTunes", async () => {
		vi.mocked(resolveReleaseGroupDetailed).mockRejectedValueOnce(new Error("boom"));
		vi.mocked(lookupVerifiedAlbumArt).mockResolvedValueOnce(null);
		const out = await resolveWorkImageByHint(project("Solo Electric Bass 1"));
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
		expect(vi.mocked(lookupVerifiedAlbumArt)).toHaveBeenCalledTimes(1);
	});

	it("counts an iTunes rung that throws as a miss, not a crash", async () => {
		vi.mocked(coverArtUrl).mockResolvedValueOnce(null);
		vi.mocked(lookupVerifiedAlbumArt).mockRejectedValueOnce(new Error("boom"));
		const out = await resolveWorkImageByHint(project("Ufabulum", { mbid: mb(15) }));
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
	});
});

describe("resolveWorkImageByHint: track", () => {
	it("asks CAA for the release group of the recording's Album release", async () => {
		const f = network(
			mbSearch("recording", [
				recording(20, "My Red Hot Car", {
					releases: [
						{ id: mb(900), "release-group": { id: mb(21), "primary-type": "Single" } },
						{ id: mb(901), "release-group": { id: mb(22), "primary-type": "Album" } },
					],
				}),
			]),
			caaFound(22),
		);
		const out = await resolveWorkImageByHint(track("My Red Hot Car"), { fetch: f });
		expect(out).toEqual({ kind: "found", url: COVER(22), source: "caa", mbid: mb(22) });
		expect(mbCalls(f)).toHaveLength(1);
		expect(vi.mocked(resolveReleaseGroupDetailed)).not.toHaveBeenCalled();
	});

	it("falls back to iTunes, under the track's own title, when the recording hit names no release group", async () => {
		const f = network(
			mbSearch("recording", [recording(23, "Tommib")]),
			caaFound(23),
			itunesWith([itunesAlbum("Tommib")]),
		);
		const out = await resolveWorkImageByHint(track("Tommib"), { fetch: f });
		expect(out).toEqual({ kind: "found", url: ITUNES_600, source: "itunes-verified" });
		expect(caaCalls(f)).toEqual([]);
		expect(mbCalls(f)).toHaveLength(1);
	});

	it("stops on two look-alike recordings: no CAA, no iTunes", async () => {
		const f = network(
			mbSearch("recording", [recording(24, "Dark Steering"), recording(25, "Dark Steering")]),
			itunesWith([itunesAlbum("Dark Steering")]),
		);
		const out = await resolveWorkImageByHint(track("Dark Steering"), { fetch: f });
		expect(out).toEqual({ kind: "missing", reason: "ambiguous" });
		expect(caaCalls(f)).toEqual([]);
		expect(itunesCalls(f)).toEqual([]);
	});

	it("reports unavailable when MusicBrainz does not answer for a recording", async () => {
		const f = network(mbDown, itunesWith([itunesAlbum("Iambic 9 Poetry")]));
		const out = await resolveWorkImageByHint(track("Iambic 9 Poetry"), { fetch: f });
		expect(out).toEqual({ kind: "unavailable" });
		expect(itunesCalls(f)).toEqual([]);
	});

	it("resolves the parent project, never the recording, and names the parent to iTunes", async () => {
		const f = network(
			mbSearch("release-group", [releaseGroup(26, "Hard Normal Daddy Parent")]),
			mbSearch("recording", [recording(27, "Papalon")]),
			caaMissing,
			itunesWith([itunesAlbum("Hard Normal Daddy Parent")]),
		);
		const out = await resolveWorkImageByHint(
			track("Papalon", { parentProject: { title: "Hard Normal Daddy Parent", artist: ARTIST } }),
			{ fetch: f },
		);
		expect(out).toEqual({ kind: "found", url: ITUNES_600, source: "itunes-verified" });
		expect(vi.mocked(resolveRecordingDetailed)).not.toHaveBeenCalled();
		expect(mbCalls(f)).toHaveLength(1);
		expect(decodeURIComponent(itunesCalls(f)[0] ?? "")).toContain("Hard Normal Daddy Parent");
	});

	it("goes straight to CAA with the parent's mbid when the tracklist gave one", async () => {
		const f = network(caaFound(28));
		const out = await resolveWorkImageByHint(
			track("Beep Street", { parentProject: { title: "Go Plastic Parent", artist: ARTIST, mbid: mb(28) } }),
			{ fetch: f },
		);
		expect(out).toEqual({ kind: "found", url: COVER(28), source: "caa", mbid: mb(28) });
		expect(mbCalls(f)).toEqual([]);
		expect(vi.mocked(resolveRecordingDetailed)).not.toHaveBeenCalled();
	});

	it("gives nothing for a parent that is named but blank, rather than guessing from the track", async () => {
		const f = network(mbSearch("recording", [recording(29, "Tundra")]), itunesWith([itunesAlbum("Tundra")]));
		const out = await resolveWorkImageByHint(
			track("Tundra", { parentProject: { title: "  ", artist: ARTIST } }),
			{ fetch: f },
		);
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
		expect(f.calls).toEqual([]);
	});
});

describe("resolveWorkImageByHint: empty hint", () => {
	it.each([
		["title", { title: "   " }],
		["artist", { artist: "" }],
	])("makes no call at all for a blank %s", async (_label, patch) => {
		const f = network(mbSearch("release-group", [releaseGroup(30, "Blank")]), caaFound(30), itunesWith([]));
		for (const hint of [
			project("Blank", patch),
			track("Blank", patch),
			project("Blank", { ...patch, mbid: mb(30) }),
		]) {
			expect(await resolveWorkImageByHint(hint, { fetch: f })).toEqual({
				kind: "missing",
				reason: "no-match",
			});
		}
		expect(f.calls).toEqual([]);
		expect(vi.mocked(coverArtUrl)).not.toHaveBeenCalled();
		expect(vi.mocked(lookupVerifiedAlbumArt)).not.toHaveBeenCalled();
	});
});
