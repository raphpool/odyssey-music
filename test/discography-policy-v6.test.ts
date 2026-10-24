import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { musicBrainzConfig } from "../src/config.js";
import {
	classifyRelease,
	DEFAULT_DISCOGRAPHY_CAP,
	DISCOGRAPHY_POLICY_VERSION,
	type DiscographyPolicy,
	type MergeResult,
	MIN_VOTED_FOR_UNRATED_CUT,
	mergeDiscography,
	type ReleaseGroupCandidate,
	selectReleases,
} from "../src/discography-policy.js";
import { fetchArtistDiscographyMb } from "../src/musicbrainz.js";
import type { EdgeRef, Slug } from "../src/types.js";

// TRA-649, policy v6. Every case runs on what MusicBrainz answered on 2026-10-20 for the artist (the release-group
// browse of the backfill, `inc=artist-credits+ratings`; test/fixtures/musicbrainz/<artist>.json, release groups
// verbatim, the list reduced to the title under test and to the voted release groups). Only the network boundary
// is replaced: the client (its parsing of the answer), the selection and the merge are the real ones. The entries
// are the ones of the repo cache (cache/nodes/artist/*.json) that v5 left without mbid.

vi.hoisted(() => {
	// The client memoizes answers per URL for five minutes: a second test would never reach the stub.
	process.env.MB_CACHE_TTL_MS = "0";
});

interface Fixture {
	artist: { mbid: string; name: string };
	"release-groups": {
		id?: string;
		"primary-type"?: string;
		rating?: unknown;
		"artist-credit"?: Record<string, unknown>[];
	}[];
}

const fixtures = new Map<string, Fixture>();
function fixtureOf(slug: string): Fixture {
	let fixture = fixtures.get(slug);
	if (fixture === undefined) {
		const path = new URL(`./fixtures/musicbrainz/${slug}.json`, import.meta.url);
		fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
		fixtures.set(slug, fixture);
	}
	return fixture;
}

// The fixture as MusicBrainz would answer if users had voted for one release group (TRA-653).
function withVotes(fixture: Fixture, id: string, votes: number): Fixture {
	const groups = fixture["release-groups"].map((g) =>
		g.id === id ? { ...g, rating: { "votes-count": votes, value: 4 } } : g,
	);
	expect(groups.find((g) => g.id === id)).toBeDefined();
	return { ...fixture, "release-groups": groups };
}

// The fixture as MusicBrainz would answer if it credited a release group with its first two credits only
// ("Duke Ellington; Buffalo Philharmonic"), the joinphrase of the first one untouched (TRA-654).
function withTwoCredits(fixture: Fixture, id: string): Fixture {
	const groups = fixture["release-groups"].map((g) =>
		g.id === id
			? {
					...g,
					"artist-credit": (g["artist-credit"] ?? [])
						.slice(0, 2)
						.map((c, i) => (i === 1 ? { ...c, joinphrase: "" } : c)),
				}
			: g,
	);
	expect(groups.find((g) => g.id === id)?.["artist-credit"]).toHaveLength(2);
	return { ...fixture, "release-groups": groups };
}

// What the browse answers for one primary type: the three requests of fetchArtistDiscographyMb partition the list.
function browseStub(fixture: Fixture): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const type = url.searchParams.get("type") ?? "";
		const groups = fixture["release-groups"].filter((g) => (g["primary-type"] ?? "").toLowerCase() === type);
		return new Response(JSON.stringify({ "release-group-count": groups.length, "release-groups": groups }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

const suiteInterval = musicBrainzConfig.minIntervalMs;
beforeEach(() => {
	musicBrainzConfig.minIntervalMs = 0;
});
afterEach(() => {
	musicBrainzConfig.minIntervalMs = suiteInterval;
	vi.unstubAllGlobals();
});

const entryOf = (slug: string, name: string, extra: Partial<EdgeRef> = {}): EdgeRef => ({
	slug: slug as Slug,
	type: "project",
	name,
	...extra,
});

// What the migration does for one artist: browse, select, merge.
async function replay(
	artist: string,
	entry: EdgeRef,
	nodeMbid?: string,
	fixture: Fixture = fixtureOf(artist),
): Promise<MergeResult & { entryAfter: EdgeRef | undefined }> {
	vi.stubGlobal("fetch", browseStub(fixture));
	const { releases, unavailable } = await fetchArtistDiscographyMb(fixture.artist.mbid, {
		priority: "background",
	});
	expect(unavailable).toBe(false);
	const policy: DiscographyPolicy = {
		artistMbid: fixture.artist.mbid,
		artistName: fixture.artist.name,
		cap: DEFAULT_DISCOGRAPHY_CAP,
		currentYear: 2026,
		currentDate: "2026-10-24",
	};
	const { kept } = selectReleases(releases, policy);
	const result = mergeDiscography({
		existing: [entry],
		candidates: kept,
		allCredited: releases,
		policy,
		projectIndex: {
			byMbid: new Map(),
			mbidBySlug: new Map(nodeMbid === undefined ? [] : [[entry.slug, nodeMbid]]),
			resolveSlug: (slug) => slug,
		},
	});
	return { ...result, entryAfter: result.edges.find((e) => e.slug === entry.slug) };
}

describe("discography policy v6 (TRA-649)", () => {
	// TRA-653 changed what v6 decides for a voted classical credit, TRA-654 what it decides for a release group
	// that is not out yet and for two credits joined by ";", TRA-633 for a subtitle, a coupling or an "(album)":
	// 9 replays the manifests decided by v6, v7 and v8.
	it("is version 9: a manifest decided by v6, v7 or v8 is not replayed", () => {
		expect(DISCOGRAPHY_POLICY_VERSION).toBe(9);
	});

	// The reduced lists must keep the guard under test in play: an artist that MusicBrainz rates (10 voted release
	// groups among the candidates) is the one v5 held back, and a fixture that lost its votes would pass the cases
	// below through the old, uncautious path.
	it.each([
		"booba",
		"blackpink",
		"chuck-berry",
		"ub40",
		"fats-domino",
		"kraftwerk",
		"frank-zappa",
		"ryuichi-sakamoto",
		"weird-al-yankovic",
		"ornette-coleman",
	])("%s: the fixture keeps the artist rated (10 voted candidates)", async (artist) => {
		const fixture = fixtureOf(artist);
		vi.stubGlobal("fetch", browseStub(fixture));
		const { releases } = await fetchArtistDiscographyMb(fixture.artist.mbid, { priority: "background" });
		const policy: DiscographyPolicy = {
			artistMbid: fixture.artist.mbid,
			artistName: fixture.artist.name,
			cap: DEFAULT_DISCOGRAPHY_CAP,
			currentYear: 2026,
			currentDate: "2026-10-24",
		};
		const voted = selectReleases(releases, policy).kept.filter((c) => c.ratingVotes > 0);
		expect(voted.length).toBeGreaterThanOrEqual(MIN_VOTED_FOR_UNRATED_CUT);
	});

	// The 33 entries v5 held back, replayed on MusicBrainz: 20 are posed.
	describe("poses the release group v5 held back", () => {
		it.each([
			// Unvoted albums of an artist with 10 voted release groups or more (v5 `unrated-pose`).
			["Booba, Lunatic", "booba", "project:lunatic", "Lunatic", "1f422be0-4b9a-4984-adc5-3bef0ee8c100"],
			["Booba, Futur", "booba", "project:futur", "Futur", "aafdf79f-6955-4d93-a989-76627d8adbfb"],
			["Booba, Panthéon", "booba", "project:pantheon", "Panthéon", "a47efde0-ca84-34ee-8ac8-65b475166ade"],
			["Booba, D.U.C", "booba", "project:d-u-c", "D.U.C", "65293bd0-a326-4178-b2fb-8f68d0065223"],
			["Booba, Ultra", "booba", "project:ultra--booba", "Ultra", "442f9666-5f83-4827-8da5-5d5adeaf1850"],
			[
				"Blackpink, Born Pink",
				"blackpink",
				"project:born-pink",
				"Born Pink",
				"350340d1-0121-4881-a6fb-97801e64d261",
			],
			[
				"Chuck Berry, The London Chuck Berry Sessions (Album + Live)",
				"chuck-berry",
				"project:the-london-chuck-berry-sessions",
				"The London Chuck Berry Sessions",
				"6f95c735-02ff-3cd8-897b-d77de5f14e80",
			],
			["Chuck Berry, Chuck", "chuck-berry", "project:chuck", "Chuck", "bcdddc95-613a-4494-ba82-1567ac9f9d7f"],
			[
				"UB40, Promises and Lies",
				"ub40",
				"project:promises-and-lies",
				"Promises and Lies",
				"b250f5c8-33f8-381c-ac5d-a278b5f3abbf",
			],
			[
				"Fats Domino, Live in Europe (Album + Live)",
				"fats-domino",
				"project:live-in-europe",
				"Live in Europe",
				"c0017e88-d7b5-4ce9-8aea-1c90d499355c",
			],
			// A voted release group the artist heads, with more than two credits (v5 `credit`).
			[
				"Asha Bhosle, Dil Padosi Hai (1 vote, with its composer and lyricist)",
				"asha-bhosle",
				"project:dil-padosi-hai",
				"Dil Padosi Hai",
				"5e472e7e-2cb5-3ffe-b63c-65b140a232c6",
			],
			[
				"John Lennon, Some Time in New York City (5 votes, with Yoko Ono and the Plastic Ono Band)",
				"john-lennon",
				"project:some-time-in-new-york-city",
				"Some Time in New York City",
				"e5153705-e798-343c-aeaf-1777db763dd6",
			],
			[
				"Stan Getz, Getz/Gilberto (6 votes, with Gilberto and Jobim)",
				"stan-getz",
				"project:getz-gilberto",
				"Getz/Gilberto",
				"b248d212-aace-3c3e-a23d-e13aaac1f87a",
			],
		])("%s", async (_label, artist, slug, name, mbid) => {
			const entry = entryOf(slug, name);

			const result = await replay(artist, entry);

			expect(result.ambiguous).toEqual([]);
			expect(result.posed.map((p) => [p.slug, p.mbid])).toEqual([[slug, mbid]]);
			expect(result.entryAfter?.mbid).toBe(mbid);
		});

		it("DJ Paul Elstak, Annihilatiøn: an entry that states the release group's year and type, with two guests", async () => {
			const entry = entryOf("project:annihilation--dj-paul-elstak", "Annihilatiøn", {
				artist: "DJ Paul Elstak",
				year: "2025",
				releaseType: "single",
			});

			const result = await replay("dj-paul-elstak", entry);

			expect(result.ambiguous).toEqual([]);
			expect(result.posed.map((p) => [p.slug, p.mbid])).toEqual([
				[entry.slug, "98242d08-bde3-4411-b000-4d2d8c99d0da"],
			]);
		});

		it("DJ Paul Elstak, Annihilatiøn: the same release group is still held for an entry that states less", async () => {
			const entry = entryOf("project:annihilation--dj-paul-elstak", "Annihilatiøn", {
				artist: "DJ Paul Elstak",
				year: "2025",
			});

			const result = await replay("dj-paul-elstak", entry);

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: entry.slug, reason: "credit" }]);
		});
	});

	// The five identities v5 closed, then the three other release groups that must not be posed.
	describe("does not pose the release group that is not the entry's", () => {
		it.each([
			// 1999 promo single "Trans Europe Express", no vote.
			[
				"Kraftwerk, Trans-Europe Express",
				"kraftwerk",
				"project:trans-europe-express",
				"Trans-Europe Express",
			],
			// The single; the album is "Joe's Garage: Act I" (6 votes).
			["Frank Zappa, Joe's Garage", "frank-zappa", "project:joe-s-garage", "Joe's Garage"],
			// 2019 single with Jess Gillam; the album is "Merry Christmas, Mr. Lawrence/Furyo".
			[
				"Ryuichi Sakamoto, Merry Christmas, Mr. Lawrence",
				"ryuichi-sakamoto",
				"project:merry-christmas-mr-lawrence",
				"Merry Christmas, Mr. Lawrence",
			],
			// A Compilation of 2017: not an album of the artist, whatever its title.
			[
				"Weird Al Yankovic, Squeeze Box",
				"weird-al-yankovic",
				"project:squeeze-box-the-complete-works-of-weird-al-yankovic",
				"Squeeze Box: The Complete Works of “Weird Al” Yankovic",
			],
			// The 1996 Compilation; the album of 1961 has another title.
			["Ornette Coleman, Free Jazz (1996)", "ornette-coleman", "project:free-jazz", "Free Jazz"],
			// "Greatest Hits" is a repackaging, not a work.
			["Fats Domino, His Greatest Hits", "fats-domino", "project:his-greatest-hits", "His Greatest Hits"],
		])("%s: held, `unrated-pose`", async (_label, artist, slug, name) => {
			const entry = entryOf(slug, name);

			const result = await replay(artist, entry);

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug, reason: "unrated-pose" }]);
			expect(result.entryAfter?.mbid).toBeUndefined();
		});

		it.each([
			// 2013 recording by the Buffalo Philharmonic and JoAnn Falletta, no vote.
			[
				"Duke Ellington, Black, Brown and Beige",
				"duke-ellington",
				"project:black-brown-and-beige",
				"Black, Brown and Beige",
			],
			// 2018 BBC Symphony Orchestra recording with six credits, no vote.
			["John Adams, Doctor Atomic (BBC)", "john-adams", "project:doctor-atomic", "Doctor Atomic"],
		])("%s: held, `credit`", async (_label, artist, slug, name) => {
			const entry = entryOf(slug, name);

			const result = await replay(artist, entry);

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug, reason: "credit" }]);
			expect(result.entryAfter?.mbid).toBeUndefined();
		});

		// TRA-653. What closes the 2013 recording must be its credits, not the lack of a vote: MusicBrainz users can
		// vote for it any day, and a pose is definitive. "Duke Ellington; Buffalo Philharmonic, JoAnn Falletta".
		describe("Duke Ellington, Black, Brown and Beige: the 2013 recording gets votes (TRA-653)", () => {
			const BBB_2013 = "a6015061-b98e-439a-9de1-51ee60f7f14e";
			const slug = "project:black-brown-and-beige";

			it.each([1, 3, 40])("stays `credit` with %i vote(s)", async (votes) => {
				const entry = entryOf(slug, "Black, Brown and Beige");
				const voted = withVotes(fixtureOf("duke-ellington"), BBB_2013, votes);

				const result = await replay("duke-ellington", entry, undefined, voted);

				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug, reason: "credit" }]);
				expect(result.entryAfter?.mbid).toBeUndefined();
			});

			it("stays `credit` for an entry that states the year and type of the recording", async () => {
				const entry = entryOf(slug, "Black, Brown and Beige", { year: "2013", releaseType: "album" });
				const voted = withVotes(fixtureOf("duke-ellington"), BBB_2013, 2);

				const result = await replay("duke-ellington", entry, undefined, voted);

				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug, reason: "credit" }]);
			});

			it("the fixture carries the ';' joinphrase the rule reads", async () => {
				const fixture = fixtureOf("duke-ellington");
				vi.stubGlobal("fetch", browseStub(fixture));
				const { releases } = await fetchArtistDiscographyMb(fixture.artist.mbid, { priority: "background" });
				const bbb = releases.find((r) => r.mbid === BBB_2013);
				expect(bbb?.artistCredits.map((c) => c.joinphrase)).toEqual(["; ", ", ", undefined]);
			});
		});

		it("Ryuichi Sakamoto, Vrioon: the node holds the 2002 album, the only candidate is the 2022 reMASTER", async () => {
			const entry = entryOf("project:vrioon--ryuichi-sakamoto", "Vrioon", { artist: "Ryuichi Sakamoto" });

			const result = await replay("ryuichi-sakamoto", entry, "91f00d04-f36b-3962-9d5f-d7e79a5a000d");

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: entry.slug, reason: "node-conflict" }]);
			expect(result.entryAfter?.mbid).toBeUndefined();
		});
	});
});

// TRA-654, policy v8. The fixtures above are the recorded answers; the release groups that are not out yet cannot
// be recorded (MusicBrainz announces them, then dates them), so their candidates are written by hand.
describe("discography policy v8 (TRA-654)", () => {
	const HENRY_MBID = "5d3d0d6f-2b0a-4a3e-9c49-111111111111";
	const policy: DiscographyPolicy = {
		artistMbid: HENRY_MBID,
		artistName: "Pierre Henry",
		cap: DEFAULT_DISCOGRAPHY_CAP,
		currentYear: 2026,
		currentDate: "2026-10-24",
	};
	let counter = 0;
	function groupOf(
		title: string,
		firstReleaseDate: string,
		extra: Partial<ReleaseGroupCandidate> = {},
	): ReleaseGroupCandidate {
		counter += 1;
		return {
			mbid: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
			title,
			firstReleaseDate,
			primaryType: "Album",
			secondaryTypes: [],
			artistCredits: [{ mbid: HENRY_MBID, name: "Pierre Henry" }],
			ratingVotes: 0,
			...extra,
		};
	}
	function mergeFor(
		forPolicy: DiscographyPolicy,
		existing: EdgeRef[],
		groups: ReleaseGroupCandidate[],
		nodeMbid?: string,
	): MergeResult {
		return mergeDiscography({
			existing,
			candidates: selectReleases(groups, forPolicy).kept,
			allCredited: groups,
			policy: forPolicy,
			projectIndex: {
				byMbid: new Map(),
				mbidBySlug: new Map(nodeMbid === undefined ? [] : existing.map((e) => [e.slug, nodeMbid])),
				resolveSlug: (slug) => slug,
			},
		});
	}
	const announcedSingle = (): ReleaseGroupCandidate =>
		groupOf("Variance / Duo", "2026-11-20", { primaryType: "Single" });
	const varianceEntry = (): EdgeRef =>
		entryOf("project:variance-duo--pierre-henry", "Variance / Duo", { artist: "Pierre Henry" });

	describe("a release group first released after the date of the run is not added", () => {
		it.each([
			["a full date, Pierre Henry's Variance / Duo", "2026-11-20"],
			["tomorrow", "2026-10-25"],
			["a month that has not begun", "2026-11"],
			["a later year", "2027"],
		])("excludes %s (%s) as `future`", (_label, date) => {
			const announced = groupOf("Variance / Duo", date, { primaryType: "Single" });

			const { kept, excluded } = selectReleases([announced], policy);

			expect(kept).toEqual([]);
			expect(excluded).toEqual([{ mbid: announced.mbid, title: "Variance / Duo", reason: "future" }]);
		});

		it.each([
			["the day of the run", "2026-10-24"],
			["yesterday", "2026-10-23"],
			["the current month, which may have begun", "2026-10"],
			["the current year, which may have begun", "2026"],
			["an unknown date", ""],
		])("keeps a release group of %s (%s)", (_label, date) => {
			const group = groupOf("Out Already", date);

			const { kept, excluded } = selectReleases([group], policy);

			expect(kept).toEqual([group]);
			expect(excluded).toEqual([]);
		});

		it("reads the date of the policy, not the clock", () => {
			const announced = announcedSingle();

			expect(selectReleases([announced], { ...policy, currentDate: "2026-11-19" }).kept).toEqual([]);
			expect(selectReleases([announced], { ...policy, currentDate: "2026-11-20" }).kept).toEqual([announced]);
		});

		it("refuses a policy whose date is not a calendar day: it would call everything future, or nothing", () => {
			const group = groupOf("Out Already", "2001-01-01");

			expect(() => selectReleases([group], { ...policy, currentDate: "" })).toThrow(/currentDate/);
			expect(() => selectReleases([group], { ...policy, currentDate: "2026" })).toThrow(/currentDate/);
		});

		it("does not add it to a discography, and adds it once the date has passed", () => {
			const announced = announcedSingle();

			const before = mergeFor(policy, [], [announced]);
			expect(before.added).toEqual([]);
			expect(before.changed).toBe(false);

			const after = mergeFor({ ...policy, currentDate: "2026-11-21" }, [], [announced]);
			expect(after.added.map((a) => a.mbid)).toEqual([announced.mbid]);
		});

		it("does not pose its mbid on an entry: `future`, and no twin is added next to the entry", () => {
			const entry = varianceEntry();

			const result = mergeFor(policy, [entry], [announcedSingle()]);

			expect(result.posed).toEqual([]);
			expect(result.added).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: entry.slug, reason: "future" }]);
			expect(result.changed).toBe(false);
		});

		it("poses it once the date has passed", () => {
			const announced = announcedSingle();

			const result = mergeFor({ ...policy, currentDate: "2026-11-21" }, [varianceEntry()], [announced]);

			expect(result.ambiguous).toEqual([]);
			expect(result.posed.map((p) => p.mbid)).toEqual([announced.mbid]);
		});

		it("does not pose the mbid its project node already holds either, while that release group is not out", () => {
			const announced = announcedSingle();
			const entry = varianceEntry();

			const result = mergeFor(policy, [entry], [announced], announced.mbid);

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: entry.slug, reason: "future" }]);
		});

		// Review of #614: `future` was filtered before the slug duplicate, so the single "Bloom" (out) took the slug of the
		// album "Bloom" (announced), and the album could never enter once released.
		describe("a single out that shares its title with an album announced", () => {
			const bloomSingle = (): ReleaseGroupCandidate =>
				groupOf("Bloom", "2026-09-12", { primaryType: "Single" });
			const bloomAlbum = (): ReleaseGroupCandidate => groupOf("Bloom", "2026-11-20");

			it("does not let the single take the slug of the album: neither is added before the album is out", () => {
				const single = bloomSingle();
				const album = bloomAlbum();

				const { kept, excluded } = selectReleases([single, album], policy);

				expect(kept).toEqual([]);
				expect(excluded).toEqual([{ mbid: album.mbid, title: "Bloom", reason: "future" }]);
				expect(mergeFor(policy, [], [single, album]).added).toEqual([]);
			});

			it("adds the album once its date has passed, not the single", () => {
				const single = bloomSingle();
				const album = bloomAlbum();
				const later = { ...policy, currentDate: "2026-11-21" };

				const { kept, excluded } = selectReleases([single, album], later);

				expect(kept).toEqual([album]);
				expect(excluded).toEqual([]);
				expect(mergeFor(later, [], [single, album]).added.map((a) => a.mbid)).toEqual([album.mbid]);
			});

			it("still keeps a single out whose slug no announced release group shares", () => {
				const single = groupOf("Other", "2026-09-12", { primaryType: "Single" });
				const album = bloomAlbum();

				expect(selectReleases([single, album], policy).kept).toEqual([single]);
			});
		});

		it("judges the release group the decision picked: the album out is posed, its announced single is not", () => {
			const album = groupOf("Variance", "2025-05-01");
			const single = groupOf("Variance", "2026-11-20", { primaryType: "Single" });
			const entry = entryOf("project:variance--pierre-henry", "Variance", { artist: "Pierre Henry" });

			const result = mergeFor(policy, [entry], [album, single]);

			expect(result.ambiguous).toEqual([]);
			expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
		});
	});

	// The release-group browse is the only request the discography makes per artist and type; it answers no release,
	// so no release status. A release group made only of promos (Utada's "Intentions", a "60s edit") cannot be told
	// from the others without one `inc=releases` request per release group. The limit is documented on
	// selectReleases; this test fails the day the browse changes, so that the documentation is read again.
	it("the browse carries no release status: the promo-only release group is a documented limit", async () => {
		const fixture = fixtureOf("duke-ellington");
		const urls: URL[] = [];
		const stub = browseStub(fixture);
		vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
			urls.push(new URL(input instanceof Request ? input.url : String(input)));
			return stub(input, init);
		}) as typeof fetch);

		await fetchArtistDiscographyMb(fixture.artist.mbid, { priority: "background" });

		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) {
			expect(url.pathname).toBe("/ws/2/release-group");
			expect(url.searchParams.get("inc")).toBe("artist-credits+ratings");
		}
		for (const group of fixture["release-groups"]) {
			expect(Object.keys(group)).not.toContain("releases");
			expect(Object.keys(group)).not.toContain("status");
		}
	});

	// TRA-653 closed the 2013 recording of the Buffalo Philharmonic by its three credits, "Duke Ellington; Buffalo
	// Philharmonic, JoAnn Falletta". The review of that PR found that MusicBrainz could credit the same recording
	// with two names, and the rule let it through, for the selection and for the pose.
	describe("Duke Ellington, Black, Brown and Beige credited with two names: Composer; Orchestra", () => {
		const BBB_2013 = "a6015061-b98e-439a-9de1-51ee60f7f14e";
		const slug = "project:black-brown-and-beige";
		const ellington = (): Fixture => withTwoCredits(fixtureOf("duke-ellington"), BBB_2013);
		const policyFor = (fixture: Fixture): DiscographyPolicy => ({
			artistMbid: fixture.artist.mbid,
			artistName: fixture.artist.name,
			cap: DEFAULT_DISCOGRAPHY_CAP,
			currentYear: 2026,
			currentDate: "2026-10-24",
		});
		async function releasesOf(fixture: Fixture): Promise<ReleaseGroupCandidate[]> {
			vi.stubGlobal("fetch", browseStub(fixture));
			const { releases } = await fetchArtistDiscographyMb(fixture.artist.mbid, { priority: "background" });
			return releases;
		}

		it("the fixture has two credits and the ';' after the first", async () => {
			const bbb = (await releasesOf(ellington())).find((r) => r.mbid === BBB_2013);

			expect(bbb?.artistCredits.map((c) => c.joinphrase)).toEqual(["; ", undefined]);
		});

		it("is excluded from the selection as `credit`", async () => {
			const fixture = ellington();
			const releases = await releasesOf(fixture);

			const { kept, excluded } = selectReleases(releases, policyFor(fixture));

			expect(kept.map((r) => r.mbid)).not.toContain(BBB_2013);
			expect(excluded).toContainEqual({ mbid: BBB_2013, title: "Black, Brown, and Beige", reason: "credit" });
		});

		it("is not added to a discography", async () => {
			const fixture = ellington();
			const releases = await releasesOf(fixture);
			const other = entryOf("project:never-heard-of", "Never Heard Of");

			const result = mergeDiscography({
				existing: [other],
				candidates: selectReleases(releases, policyFor(fixture)).kept,
				allCredited: releases,
				policy: policyFor(fixture),
				projectIndex: { byMbid: new Map(), mbidBySlug: new Map(), resolveSlug: (s) => s },
			});

			expect(result.added.map((a) => a.mbid)).not.toContain(BBB_2013);
		});

		it.each([0, 3, 40])("is not posed on the entry, with %i vote(s)", async (votes) => {
			const entry = entryOf(slug, "Black, Brown and Beige");
			const fixture = votes === 0 ? ellington() : withVotes(ellington(), BBB_2013, votes);

			const result = await replay("duke-ellington", entry, undefined, fixture);

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug, reason: "credit" }]);
			expect(result.entryAfter?.mbid).toBeUndefined();
		});

		it("is not posed on an entry that states the year and type of the recording", async () => {
			const entry = entryOf(slug, "Black, Brown and Beige", { year: "2013", releaseType: "album" });

			const result = await replay("duke-ellington", entry, undefined, withVotes(ellington(), BBB_2013, 2));

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug, reason: "credit" }]);
		});

		it("is held whatever surrounds the ';', and let through with the usual joinphrases", async () => {
			const fixture = ellington();
			const bbb = (await releasesOf(fixture)).find((r) => r.mbid === BBB_2013);
			expect(bbb).toBeDefined();
			const [head, ...rest] = bbb?.artistCredits ?? [];
			const withJoin = (joinphrase: string): ReleaseGroupCandidate => ({
				...(bbb as ReleaseGroupCandidate),
				artistCredits: [{ ...(head as { mbid: string; name: string }), joinphrase }, ...rest],
			});

			for (const joinphrase of ["; ", ";", " ; "]) {
				expect(classifyRelease(withJoin(joinphrase), policyFor(fixture))).toEqual({
					ok: false,
					reason: "credit",
				});
			}
			for (const joinphrase of [" & ", ", ", " / ", " feat. "]) {
				expect(classifyRelease(withJoin(joinphrase), policyFor(fixture))).toEqual({ ok: true });
			}
		});
	});
});

// TRA-654, decision of the dispatcher: votes measure the popularity of the ARTIST on MusicBrainz, not what the policy
// keeps. Excluding a release group for `future` or for a classical ";" credit must not change whether the artist is
// rated. Measured on John Cage: closing his voted "John Cage; performers" recordings took him under the threshold,
// lifted the unrated cut and let 26 unvoted albums in.
describe("the rating of the artist does not move with the v8 exclusions (TRA-654)", () => {
	const ARTIST = "7c1cc8a1-a237-40b6-ab4a-dca495a8f471";
	const ORCHESTRA = "70a803e5-15db-41bb-861d-ec9af670f324";
	const policy: DiscographyPolicy = {
		artistMbid: ARTIST,
		artistName: "Rated Composer",
		cap: DEFAULT_DISCOGRAPHY_CAP,
		currentYear: 2026,
		currentDate: "2026-10-24",
	};
	let counter = 0;
	function group(
		title: string,
		firstReleaseDate: string,
		extra: Partial<ReleaseGroupCandidate> = {},
	): ReleaseGroupCandidate {
		counter += 1;
		return {
			mbid: `00000000-0000-4000-8000-9${String(counter).padStart(11, "0")}`,
			title,
			firstReleaseDate,
			primaryType: "Album",
			secondaryTypes: [],
			artistCredits: [{ mbid: ARTIST, name: "Rated Composer" }],
			ratingVotes: 0,
			...extra,
		};
	}
	const recordings = (): ReleaseGroupCandidate[] =>
		Array.from({ length: MIN_VOTED_FOR_UNRATED_CUT }, (_, i) =>
			group(`Recording ${i}`, `${1990 + i}-01-01`, {
				ratingVotes: 3,
				artistCredits: [
					{ mbid: ARTIST, name: "Rated Composer", joinphrase: "; " },
					{ mbid: ORCHESTRA, name: "Orchestra" },
				],
			}),
		);
	const announced = (): ReleaseGroupCandidate[] =>
		Array.from({ length: MIN_VOTED_FOR_UNRATED_CUT }, (_, i) =>
			group(`Announced ${i}`, `2027-0${(i % 9) + 1}-01`, { ratingVotes: 3 }),
		);

	it.each([
		['credited "Composer; Orchestra"', recordings],
		["not out yet", announced],
	])(
		"stays rated when its voted release groups are excluded (%s): the unrated cut still applies",
		(_label, voted) => {
			const oldUnvoted = group("Old Unvoted", "2001-01-01");
			const recentUnvoted = group("Recent Unvoted", "2025-03-01");

			const { kept, excluded } = selectReleases([...voted(), oldUnvoted, recentUnvoted], policy);

			expect(kept).toEqual([recentUnvoted]);
			expect(excluded.filter((e) => e.reason === "unrated")).toEqual([
				{ mbid: oldUnvoted.mbid, title: "Old Unvoted", reason: "unrated" },
			]);
			expect(excluded.filter((e) => e.reason !== "unrated")).toHaveLength(MIN_VOTED_FOR_UNRATED_CUT);
		},
	);

	it("still counts the votes of what v7 already excluded: a three-credit release group does not rate the artist", () => {
		const threeCredits = Array.from({ length: MIN_VOTED_FOR_UNRATED_CUT }, (_, i) =>
			group(`Collective ${i}`, `${1990 + i}-01-01`, {
				ratingVotes: 3,
				artistCredits: [
					{ mbid: ARTIST, name: "Rated Composer" },
					{ mbid: ORCHESTRA, name: "Orchestra" },
					{ mbid: ARTIST.replace(/.$/, "9"), name: "Guest" },
				],
			}),
		);
		const oldUnvoted = group("Old Unvoted", "2001-01-01");

		expect(selectReleases([...threeCredits, oldUnvoted], policy).kept).toEqual([oldUnvoted]);
	});

	it("keeps the pose cautious for a rated artist whose voted release groups are excluded", () => {
		const oldSingle = group("Old Single", "2001-01-01", { primaryType: "Single" });
		const groups = [...recordings(), oldSingle];
		const entry = entryOf("project:old-single--rated-composer", "Old Single", { artist: "Rated Composer" });

		const result = mergeDiscography({
			existing: [entry],
			candidates: selectReleases(groups, policy).kept,
			allCredited: groups,
			policy,
			projectIndex: { byMbid: new Map(), mbidBySlug: new Map(), resolveSlug: (s) => s },
		});

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([{ slug: entry.slug, reason: "unrated-pose" }]);
	});
});
