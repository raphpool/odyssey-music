import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { musicBrainzConfig } from "../src/config.js";
import {
	DEFAULT_DISCOGRAPHY_CAP,
	DISCOGRAPHY_POLICY_VERSION,
	type DiscographyPolicy,
	type MergeResult,
	MIN_VOTED_FOR_UNRATED_CUT,
	mergeDiscography,
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
	"release-groups": { "primary-type"?: string }[];
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
): Promise<MergeResult & { entryAfter: EdgeRef | undefined }> {
	const fixture = fixtureOf(artist);
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
	it("is version 6: a manifest decided by v5 is not replayed", () => {
		expect(DISCOGRAPHY_POLICY_VERSION).toBe(6);
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

		it("Ryuichi Sakamoto, Vrioon: the node holds the 2002 album, the only candidate is the 2022 reMASTER", async () => {
			const entry = entryOf("project:vrioon--ryuichi-sakamoto", "Vrioon", { artist: "Ryuichi Sakamoto" });

			const result = await replay("ryuichi-sakamoto", entry, "91f00d04-f36b-3962-9d5f-d7e79a5a000d");

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: entry.slug, reason: "node-conflict" }]);
			expect(result.entryAfter?.mbid).toBeUndefined();
		});
	});
});
