import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findCompilationCoverReleaseGroup,
	resolveRecordingDetailed,
	resolveReleaseGroupDetailed,
} from "../src/musicbrainz.js";
import { jsonResponse, routedFetch } from "./images/helpers.js";

// TRA-612. mbFetch memoizes by request for 5 minutes: every test asks for a title of its own.
const KODE9 = "e95a9d7f-fc26-4e56-8032-90cd954deea0";
const SPACEAPE = "88b53a2c-aac3-426d-b179-73f2355fddd8";
const VARIOUS = "89ad4ac3-39f7-470e-963a-56509c546377";
const OTHER = "99999999-0000-4000-8000-000000000001";
const SINE_RG = "1567159c-ea26-3934-a725-77fd4f6eccfb";
const mb = (n: number): string => `22222222-0000-4000-8000-${String(n).padStart(12, "0")}`;

const kode9 = { name: "Kode9", artist: { id: KODE9, name: "Kode9" }, joinphrase: " & " };
const spaceape = { name: "The Space Ape", artist: { id: SPACEAPE, name: "The Spaceape" } };
const various = { name: "Various Artists", artist: { id: VARIOUS, name: "Various Artists" } };

const releaseGroup = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
	id,
	score: 100,
	title,
	"primary-type": "Single",
	"first-release-date": "2004-01-01",
	"artist-credit": [kode9, spaceape],
	...extra,
});

function rgNetwork(hits: unknown[]) {
	const f = routedFetch([
		[
			"musicbrainz.org/ws/2/release-group",
			() => jsonResponse({ count: hits.length, "release-groups": hits }),
		],
	]);
	vi.stubGlobal("fetch", f);
	return f;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("double A-side single (TRA-612)", () => {
	it("gives Kode9's 'Sine of the Dub' the release group MB files as 'Sine of the Dub / Stalker'", async () => {
		const f = rgNetwork([releaseGroup(SINE_RG, "Sine of the Dub / Stalker")]);
		const out = await resolveReleaseGroupDetailed("Sine of the Dub", "Kode9");
		expect(out).toMatchObject({ ambiguous: false, unavailable: false });
		expect(out.identity).toMatchObject({ mbid: SINE_RG, primaryType: "Single" });
		expect(out.identity?.credit.map((c) => c.mbid)).toEqual([KODE9, SPACEAPE]);
		expect(f.calls).toHaveLength(1);
	});

	it("also answers to the other side of the single", async () => {
		rgNetwork([releaseGroup(mb(1), "Pumpkin / Stalker B")]);
		expect((await resolveReleaseGroupDetailed("Stalker B", "Kode9")).identity?.mbid).toBe(mb(1));
	});

	it("refuses a double A-side none of whose segments is the title", async () => {
		rgNetwork([
			releaseGroup(mb(2), "Sine of the Dubs / Stalker"),
			releaseGroup(mb(3), "Sine of the Dub Plate / X"),
		]);
		expect(await resolveReleaseGroupDetailed("Sine of the Dub Two", "Kode9")).toEqual({
			identity: null,
			ambiguous: false,
			unavailable: false,
		});
	});

	it("does not cut a title on a bare slash", async () => {
		rgNetwork([releaseGroup(mb(4), "Dub/Stalker")]);
		expect((await resolveReleaseGroupDetailed("Dub", "Kode9")).identity).toBeNull();
	});

	it("refuses it when the credit does not hold the artist", async () => {
		rgNetwork([
			releaseGroup(mb(5), "Anthem Five / Stalker", {
				"artist-credit": [{ name: "Other", artist: { id: OTHER, name: "Other" } }],
			}),
		]);
		expect(await resolveReleaseGroupDetailed("Anthem Five", "Kode9")).toEqual({
			identity: null,
			ambiguous: false,
			unavailable: false,
		});
	});

	it("accepts it by the artist's MBID when the credit prints another name", async () => {
		rgNetwork([
			releaseGroup(mb(6), "Anthem Six / Stalker", {
				"artist-credit": [{ name: "Kode Nine", artist: { id: KODE9, name: "Kode Nine" } }],
			}),
		]);
		expect((await resolveReleaseGroupDetailed("Anthem Six", "Kode9")).identity).toBeNull();
		rgNetwork([
			releaseGroup(mb(7), "Anthem Seven / Stalker", {
				"artist-credit": [{ name: "Kode Nine", artist: { id: KODE9, name: "Kode Nine" } }],
			}),
		]);
		const out = await resolveReleaseGroupDetailed("Anthem Seven", "Kode9", { requestedArtistMbid: KODE9 });
		expect(out.identity?.mbid).toBe(mb(7));
	});

	it("lets the exact title win over a double A-side", async () => {
		rgNetwork([
			releaseGroup(mb(8), "Anthem Eight / Stalker"),
			releaseGroup(mb(9), "Anthem Eight", { "primary-type": "Album", "first-release-date": "2006-01-01" }),
		]);
		const out = await resolveReleaseGroupDetailed("Anthem Eight", "Kode9");
		expect(out.identity?.mbid).toBe(mb(9));
	});

	it("rejects the double A-side when an exact-title group exists, whoever it is credited to", async () => {
		rgNetwork([
			releaseGroup(mb(10), "Anthem Ten / Stalker"),
			releaseGroup(mb(11), "Anthem Ten", {
				"artist-credit": [{ name: "Other", artist: { id: OTHER, name: "Other" } }],
			}),
		]);
		expect(await resolveReleaseGroupDetailed("Anthem Ten", "Kode9")).toEqual({
			identity: null,
			ambiguous: false,
			unavailable: false,
		});
	});

	it("does not choose between two double A-sides", async () => {
		rgNetwork([
			releaseGroup(mb(12), "Anthem Twelve / Stalker"),
			releaseGroup(mb(13), "Anthem Twelve / Dub Two"),
		]);
		expect((await resolveReleaseGroupDetailed("Anthem Twelve", "Kode9")).identity).toBeNull();
	});

	it("keeps the release type the caller knows: an album is never given a single's group", async () => {
		rgNetwork([releaseGroup(mb(14), "Anthem Fourteen / Stalker")]);
		const asAlbum = await resolveReleaseGroupDetailed("Anthem Fourteen", "Kode9", { releaseType: "album" });
		expect(asAlbum).toEqual({ identity: null, ambiguous: false, unavailable: false });
		rgNetwork([releaseGroup(mb(15), "Anthem Fifteen / Stalker")]);
		const asSingle = await resolveReleaseGroupDetailed("Anthem Fifteen", "Kode9", { releaseType: "single" });
		expect(asSingle.identity?.mbid).toBe(mb(15));
	});

	it("refuses a group with a secondary type, or with no primary type", async () => {
		rgNetwork([releaseGroup(mb(16), "Anthem Sixteen / Stalker", { "secondary-types": ["Remix"] })]);
		expect((await resolveReleaseGroupDetailed("Anthem Sixteen", "Kode9")).identity).toBeNull();
		rgNetwork([releaseGroup(mb(17), "Anthem Seventeen / Stalker", { "primary-type": undefined })]);
		expect((await resolveReleaseGroupDetailed("Anthem Seventeen", "Kode9")).identity).toBeNull();
	});

	it("needs an artist: a title alone never reaches a double A-side", async () => {
		rgNetwork([releaseGroup(mb(18), "Anthem Eighteen / Stalker")]);
		expect((await resolveReleaseGroupDetailed("Anthem Eighteen")).identity).toBeNull();
	});

	it("is for release groups only: a recording is still found by its exact title", async () => {
		const f = routedFetch([
			[
				"musicbrainz.org/ws/2/recording",
				() =>
					jsonResponse({
						count: 1,
						recordings: [
							{ id: mb(19), score: 100, title: "Anthem Nineteen / Stalker", "artist-credit": [kode9] },
						],
					}),
			],
		]);
		vi.stubGlobal("fetch", f);
		expect((await resolveRecordingDetailed("Anthem Nineteen", "Kode9")).identity).toBeNull();
	});
});

describe("findCompilationCoverReleaseGroup (TRA-612)", () => {
	const HYPERDUB = "1de78c85-bbe7-441f-b3a1-9db3c5358e01";
	const release = (rg: string, title: string, extra: Record<string, unknown> = {}) => ({
		id: mb(900),
		title,
		"artist-credit": [various],
		"release-group": {
			id: rg,
			title,
			"primary-type": "Album",
			"secondary-types": ["Compilation"],
		},
		...extra,
	});
	const recording = (releases: unknown[], credit: unknown[] = [kode9]) => ({
		id: mb(901),
		score: 100,
		title: "Pink Sham Pain Down the Drain",
		"artist-credit": credit,
		releases,
	});
	function recNetwork(recordings: unknown[], count = recordings.length) {
		const f = routedFetch([["musicbrainz.org/ws/2/recording", () => jsonResponse({ count, recordings })]]);
		vi.stubGlobal("fetch", f);
		return f;
	}

	it("finds the compilation Kode9's own tracks are on, with a single request", async () => {
		const f = recNetwork([recording([release(HYPERDUB, "Hyperdub 10.3")])]);
		const out = await findCompilationCoverReleaseGroup("Hyperdub 10.3", "Kode9");
		expect(out).toEqual({ kind: "found", releaseGroupMbid: HYPERDUB });
		expect(f.calls).toHaveLength(1);
		const url = new URL(f.calls[0] as string);
		expect(url.pathname).toBe("/ws/2/recording");
		expect(url.searchParams.get("query")).toBe('release:"Hyperdub 10.3" AND artist:"Kode9"');
	});

	it("answers with a release-group MBID and nothing that could pass for an identity or a credit", async () => {
		recNetwork([recording([release(HYPERDUB, "Compilation Alpha")])]);
		const out = await findCompilationCoverReleaseGroup("Compilation Alpha", "Kode9");
		expect(Object.keys(out).sort()).toEqual(["kind", "releaseGroupMbid"]);
	});

	it("refuses an artist the hits do not credit: the track credits are the proof", async () => {
		recNetwork([
			recording(
				[release(HYPERDUB, "Compilation Beta")],
				[{ name: "Other", artist: { id: OTHER, name: "Other" } }],
			),
		]);
		expect(await findCompilationCoverReleaseGroup("Compilation Beta", "Kode9")).toEqual({ kind: "none" });
	});

	it("refuses when no recording of the artist is on a release of that title", async () => {
		recNetwork([recording([release(HYPERDUB, "Some Other Compilation")])]);
		expect(await findCompilationCoverReleaseGroup("Compilation Gamma", "Kode9")).toEqual({ kind: "none" });
		recNetwork([]);
		expect(await findCompilationCoverReleaseGroup("Compilation Delta", "Kode9")).toEqual({ kind: "none" });
	});

	it("is ambiguous when two release groups of that title hold the artist", async () => {
		recNetwork([
			recording([release(HYPERDUB, "Compilation Epsilon")]),
			recording([release(mb(20), "Compilation Epsilon")]),
		]);
		expect(await findCompilationCoverReleaseGroup("Compilation Epsilon", "Kode9")).toEqual({
			kind: "ambiguous",
		});
	});

	it("refuses a group that is not a compilation, or whose releases are credited to a real artist", async () => {
		recNetwork([
			recording([
				release(HYPERDUB, "Compilation Zeta", {
					"release-group": {
						id: HYPERDUB,
						title: "Compilation Zeta",
						"primary-type": "Album",
						"secondary-types": [],
					},
				}),
			]),
		]);
		expect(await findCompilationCoverReleaseGroup("Compilation Zeta", "Kode9")).toEqual({ kind: "none" });
		recNetwork([
			recording([
				release(HYPERDUB, "Compilation Eta", {
					"artist-credit": [{ name: "Other", artist: { id: OTHER, name: "Other" } }],
				}),
			]),
		]);
		expect(await findCompilationCoverReleaseGroup("Compilation Eta", "Kode9")).toEqual({ kind: "none" });
	});

	it("takes the artist's MBID as a credit whatever name it is printed under", async () => {
		recNetwork([
			recording(
				[release(HYPERDUB, "Compilation Theta")],
				[{ name: "Kode Nine", artist: { id: KODE9, name: "Kode Nine" } }],
			),
		]);
		expect(await findCompilationCoverReleaseGroup("Compilation Theta", "Kode9")).toEqual({ kind: "none" });
		recNetwork([
			recording(
				[release(HYPERDUB, "Compilation Iota")],
				[{ name: "Kode Nine", artist: { id: KODE9, name: "Kode Nine" } }],
			),
		]);
		expect(
			await findCompilationCoverReleaseGroup("Compilation Iota", "Kode9", { requestedArtistMbid: KODE9 }),
		).toEqual({ kind: "found", releaseGroupMbid: HYPERDUB });
	});

	it("does not pick from a truncated page, and reports an outage as unavailable", async () => {
		recNetwork([recording([release(HYPERDUB, "Compilation Kappa")])], 250);
		expect(await findCompilationCoverReleaseGroup("Compilation Kappa", "Kode9")).toEqual({
			kind: "ambiguous",
		});
		vi.stubGlobal("fetch", routedFetch([["musicbrainz.org", () => new Response("no", { status: 400 })]]));
		expect(await findCompilationCoverReleaseGroup("Compilation Lambda", "Kode9")).toEqual({
			kind: "unavailable",
		});
	});

	it("asks nothing for a title or an artist that reduces to nothing", async () => {
		const f = recNetwork([]);
		expect(await findCompilationCoverReleaseGroup("!!!", "Kode9")).toEqual({ kind: "none" });
		expect(await findCompilationCoverReleaseGroup("Compilation Mu", "!!!")).toEqual({ kind: "none" });
		expect(f.calls).toEqual([]);
	});
});
