import { describe, expect, it } from "vitest";
import {
	classifyRelease,
	DEFAULT_DISCOGRAPHY_CAP,
	type DiscographyPolicy,
	isNonCanonicalReleaseTitle,
	MIN_VOTED_FOR_UNRATED_CUT,
	orderDiscography,
	type ReleaseGroupCandidate,
	selectReleases,
	toDiscographyEdge,
	VARIOUS_ARTISTS_MBID,
} from "../src/discography-policy.js";
import type { EdgeRef } from "../src/types.js";

const ARTIST_MBID = "11111111-1111-4111-8111-111111111111";
const OTHER_MBID = "22222222-2222-4222-8222-222222222222";
const THIRD_MBID = "33333333-3333-4333-8333-333333333333";

const policy: DiscographyPolicy = {
	artistMbid: ARTIST_MBID,
	artistName: "Daft Punk",
	cap: DEFAULT_DISCOGRAPHY_CAP,
	currentYear: 2026,
	currentDate: "2026-10-24",
};

let counter = 0;
function release(overrides: Partial<ReleaseGroupCandidate> = {}): ReleaseGroupCandidate {
	counter += 1;
	return {
		mbid: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
		title: `Title ${counter}`,
		firstReleaseDate: "2001-03-12",
		primaryType: "Album",
		secondaryTypes: [],
		artistCredits: [{ mbid: ARTIST_MBID, name: "Daft Punk" }],
		ratingVotes: 0,
		...overrides,
	};
}

function edge(name: string, year?: string): EdgeRef {
	const base: EdgeRef = { slug: `project:${name.toLowerCase()}--x`, type: "project", name };
	return year === undefined ? base : { ...base, year };
}

describe("isNonCanonicalReleaseTitle", () => {
	it.each([
		"Control Your Body (Hardwell edit)",
		"No Limit (Remixes, Pt. 3)",
		"Megamix",
		"The Remix Album",
		"Essence (4 Track Album Sampler)",
		"Body Mind & Soul (Original Mix)",
		"The Very Best of X",
		"Greatest Hits",
	])("flags %s as non-canonical", (title) => {
		expect(isNonCanonicalReleaseTitle(title)).toBe(true);
	});

	it.each([
		"Discovery",
		"Random Access Memories",
		"Da Funk",
		"Selected Ambient Works 85–92",
		"Live at the Apollo",
		"Apostrophe (')",
	])("keeps %s", (title) => {
		expect(isNonCanonicalReleaseTitle(title)).toBe(false);
	});

	it("keeps Fearless (Taylor's Version) and excludes Madvillainy (Instrumentals)", () => {
		expect(isNonCanonicalReleaseTitle("Fearless (Taylor's Version)")).toBe(false);
		expect(isNonCanonicalReleaseTitle("Madvillainy (Instrumentals)")).toBe(true);
	});

	it("treats version as a variant only next to a qualifier", () => {
		expect(isNonCanonicalReleaseTitle("Track (Radio Version)")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Track [Extended Version]")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Track - Live Version")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Album (Deluxe Version)")).toBe(false);
		expect(isNonCanonicalReleaseTitle("Album (Original Version)")).toBe(false);
	});

	it("applies the same rule to a dash suffix: Track - Radio Edit, Song - Extended Mix", () => {
		expect(isNonCanonicalReleaseTitle("Track - Radio Edit")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Song - Extended Mix")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Song \u2013 Club Mix")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Selected Ambient Works 85\u201392")).toBe(false);
		expect(isNonCanonicalReleaseTitle("Live - Life")).toBe(false);
		expect(isNonCanonicalReleaseTitle("Radio Edit - Part One")).toBe(false);
	});

	it("matches whole words and bracket qualifiers only", () => {
		expect(isNonCanonicalReleaseTitle("Remixed")).toBe(false);
		expect(isNonCanonicalReleaseTitle("Abbey Road (Deluxe Edition)")).toBe(false);
		expect(isNonCanonicalReleaseTitle("Mash-Up Nation")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Booty La La [Loefah Dub]")).toBe(true);
		expect(isNonCanonicalReleaseTitle("THE BEST OF Something")).toBe(true);
		expect(isNonCanonicalReleaseTitle("Best of Nothing")).toBe(false);
	});
});

describe("classifyRelease", () => {
	const kode9: DiscographyPolicy = {
		artistMbid: ARTIST_MBID,
		artistName: "Kode9",
		cap: 40,
		currentYear: 2026,
		currentDate: "2026-10-24",
	};
	const kode9Credit = { mbid: ARTIST_MBID, name: "Kode9" };
	const spaceape = { mbid: OTHER_MBID, name: "Spaceape" };

	it("rejects a release whose first credit is another artist, keeps the artist first", () => {
		expect(classifyRelease(release({ artistCredits: [spaceape, kode9Credit] }), kode9)).toEqual({
			ok: false,
			reason: "credit",
		});
		expect(classifyRelease(release({ artistCredits: [kode9Credit, spaceape] }), kode9)).toEqual({ ok: true });
	});

	it("rejects more than two credits, and a missing credit list", () => {
		const three = [kode9Credit, spaceape, { mbid: THIRD_MBID, name: "Third" }];
		expect(classifyRelease(release({ artistCredits: three }), kode9)).toEqual({
			ok: false,
			reason: "credit",
		});
		expect(classifyRelease(release({ artistCredits: [] }), kode9)).toEqual({ ok: false, reason: "credit" });
	});

	it("reports Various Artists as various-artists", () => {
		const various = { mbid: VARIOUS_ARTISTS_MBID, name: "Various Artists" };
		expect(classifyRelease(release({ artistCredits: [various] }), kode9)).toEqual({
			ok: false,
			reason: "various-artists",
		});
		expect(classifyRelease(release({ artistCredits: [kode9Credit, various] }), kode9)).toEqual({
			ok: false,
			reason: "various-artists",
		});
	});

	it("compares mbids case-insensitively", () => {
		const upper = { mbid: ARTIST_MBID.toUpperCase(), name: "Kode9" };
		expect(classifyRelease(release({ artistCredits: [upper] }), kode9)).toEqual({ ok: true });
		const various = { mbid: VARIOUS_ARTISTS_MBID.toUpperCase(), name: "Various Artists" };
		expect(classifyRelease(release({ artistCredits: [kode9Credit, various] }), kode9)).toEqual({
			ok: false,
			reason: "various-artists",
		});
	});

	it("rejects a secondary type that is not admitted", () => {
		expect(classifyRelease(release({ secondaryTypes: ["Compilation"] }), policy)).toEqual({
			ok: false,
			reason: "secondary-type",
		});
	});

	it("Help!: keeps an Album + Soundtrack (TRA-625)", () => {
		const help = release({ title: "Help!", secondaryTypes: ["Soundtrack"] });
		expect(classifyRelease(help, policy)).toEqual({ ok: true });
	});

	it("So Far Gone: keeps a Mixtape/Street", () => {
		const mixtape = release({ title: "So Far Gone", secondaryTypes: ["Mixtape/Street"] });
		expect(classifyRelease(mixtape, policy)).toEqual({ ok: true });
	});

	it("Live at the BBC: excludes a Live album", () => {
		const live = release({ title: "Live at the BBC", secondaryTypes: ["Live"] });
		expect(classifyRelease(live, policy)).toEqual({ ok: false, reason: "secondary-type" });
	});

	it("1: excludes a Compilation", () => {
		const one = release({ title: "1", secondaryTypes: ["Compilation"] });
		expect(classifyRelease(one, policy)).toEqual({ ok: false, reason: "secondary-type" });
	});

	it("excludes Soundtrack + Live: one non-admitted type anywhere is enough", () => {
		for (const secondaryTypes of [
			["Soundtrack", "Live"],
			["Live", "Soundtrack"],
			["Mixtape/Street", "Compilation"],
		]) {
			expect(classifyRelease(release({ secondaryTypes }), policy)).toEqual({
				ok: false,
				reason: "secondary-type",
			});
		}
	});

	it.each([
		"Compilation",
		"Live",
		"Remix",
		"DJ-mix",
		"Demo",
		"Spokenword",
		"Interview",
		"Audiobook",
		"Audio drama",
		"Field recording",
	])("excludes %s alone", (type) => {
		expect(classifyRelease(release({ secondaryTypes: [type] }), policy)).toEqual({
			ok: false,
			reason: "secondary-type",
		});
	});

	it("admits Soundtrack + Mixtape/Street together", () => {
		const both = release({ secondaryTypes: ["Soundtrack", "Mixtape/Street"] });
		expect(classifyRelease(both, policy)).toEqual({ ok: true });
	});

	it("rejects a primary type outside Album / EP / Single", () => {
		expect(classifyRelease(release({ primaryType: "Broadcast" }), policy)).toEqual({
			ok: false,
			reason: "primary-type",
		});
	});

	it("rejects a non-canonical title", () => {
		expect(classifyRelease(release({ title: "Megamix" }), policy)).toEqual({
			ok: false,
			reason: "non-canonical",
		});
	});

	it("keeps a plain album, EP and single, including a live album without secondary type", () => {
		for (const primaryType of ["Album", "EP", "Single"]) {
			expect(classifyRelease(release({ primaryType, title: "Live at the Apollo" }), policy)).toEqual({
				ok: true,
			});
		}
	});
});

describe("selectReleases", () => {
	function many(count: number, primaryType: string, firstYear: number): ReleaseGroupCandidate[] {
		// Distinct years, so "most recent" is unambiguous.
		return Array.from({ length: count }, (_, i) =>
			release({ primaryType, title: `${primaryType} ${i}`, firstReleaseDate: `${firstYear + i}-01-01` }),
		);
	}

	it("keeps 5 albums and the 35 oldest of 90 singles at equal votes, ordered by year descending", () => {
		const albums = many(5, "Album", 1990);
		const singles = many(90, "Single", 1920);
		const { kept } = selectReleases([...singles, ...albums], policy);
		expect(kept).toHaveLength(40);
		expect(kept.filter((c) => c.primaryType === "Album")).toHaveLength(5);
		const keptSingles = kept.filter((c) => c.primaryType === "Single");
		expect(keptSingles.map((c) => c.title)).toEqual(
			singles
				.slice(0, 35)
				.reverse()
				.map((c) => c.title),
		);
		const dates = kept.map((c) => c.firstReleaseDate);
		expect(dates).toEqual([...dates].sort().reverse());
	});

	it("keeps the 40 oldest of 45 albums at equal votes and no single", () => {
		const albums = many(45, "Album", 1970);
		const { kept } = selectReleases([...many(10, "Single", 2000), ...albums], policy);
		expect(kept.map((c) => c.title)).toEqual(
			albums
				.slice(0, 40)
				.reverse()
				.map((c) => c.title),
		);
	});

	it("keeps the candidate with the most votes first, the oldest among equal votes (TRA-625)", () => {
		const popular = release({ title: "Popular", firstReleaseDate: "2020-01-01", ratingVotes: 9 });
		const oldA = release({ title: "Old A", firstReleaseDate: "1960-01-01", ratingVotes: 3 });
		const oldB = release({ title: "Old B", firstReleaseDate: "1961-01-01", ratingVotes: 3 });
		const newer = release({ title: "Newer", firstReleaseDate: "1999-01-01", ratingVotes: 3 });
		const unknownDate = release({ title: "Unknown date", firstReleaseDate: "", ratingVotes: 3 });
		const small = { ...policy, cap: 3 };
		const { kept } = selectReleases([unknownDate, newer, oldB, oldA, popular], small);
		expect(kept.map((c) => c.title).sort()).toEqual(["Old A", "Old B", "Popular"]);
		// Votes tie, same date: title then mbid decide, whatever the input order.
		const twinB = release({ title: "Twin B", firstReleaseDate: "1970-01-01", ratingVotes: 1 });
		const twinA = release({ title: "Twin A", firstReleaseDate: "1970-01-01", ratingVotes: 1 });
		const one = { ...policy, cap: 1 };
		expect(selectReleases([twinB, twinA], one).kept.map((c) => c.title)).toEqual(["Twin A"]);
		expect(selectReleases([twinA, twinB], one).kept.map((c) => c.title)).toEqual(["Twin A"]);
	});

	// TRA-628: with 13 voted (>= MIN_VOTED_FOR_UNRATED_CUT) the 60 unvoted ones no longer fill the 27 free places.
	it("Beatles: the 13 voted canonical albums all survive 60 newer albums with no vote, which are cut", () => {
		const canon = [
			["Please Please Me", "1963-03-22", 50],
			["With the Beatles", "1963-11-22", 30],
			["A Hard Day's Night", "1964-07-10", 40],
			["Beatles for Sale", "1964-12-04", 20],
			["Help!", "1965-08-06", 35],
			["Rubber Soul", "1965-12-03", 56],
			["Revolver", "1966-08-05", 61],
			["Sgt. Pepper's Lonely Hearts Club Band", "1967-06-01", 73],
			["Magical Mystery Tour", "1967-11-27", 25],
			["The Beatles", "1968-11-22", 60],
			["Yellow Submarine", "1969-01-13", 15],
			["Abbey Road", "1969-09-26", 71],
			["Let It Be", "1970-05-08", 43],
		] as const;
		const canonical = canon.map(([title, date, votes]) =>
			release({ title, firstReleaseDate: date, ratingVotes: votes }),
		);
		const archives = Array.from({ length: 60 }, (_, i) =>
			release({ title: `Lost Tapes ${i}`, firstReleaseDate: `${1990 + (i % 30)}-0${1 + (i % 9)}-01` }),
		);
		const { kept, excluded } = selectReleases([...archives, ...canonical], policy);
		expect(kept).toHaveLength(13);
		expect(excluded).toHaveLength(60);
		const keptTitles = new Set(kept.map((c) => c.title));
		for (const c of canonical) expect(keptTitles.has(c.title)).toBe(true);
		expect(keptTitles.has("Abbey Road")).toBe(true);
		// Display order is unchanged: newest first, whatever got the places.
		const dates = kept.map((c) => c.firstReleaseDate);
		expect(dates).toEqual([...dates].sort().reverse());
	});

	it("Beatles: 19 voted albums and 30 voted singles go before 60 unvoted albums, cap 40", () => {
		const votedAlbums = Array.from({ length: 19 }, (_, i) =>
			release({ title: `Canon ${i}`, firstReleaseDate: `${1963 + (i % 8)}-01-01`, ratingVotes: 20 + i }),
		);
		const votedSingles = Array.from({ length: 30 }, (_, i) =>
			release({
				title: `Hit ${String(i).padStart(2, "0")}`,
				primaryType: "Single",
				firstReleaseDate: `${1962 + (i % 9)}-01-01`,
				ratingVotes: 1 + i,
			}),
		);
		const archives = Array.from({ length: 60 }, (_, i) =>
			release({ title: `Archive ${i}`, firstReleaseDate: `${1985 + (i % 30)}-01-01` }),
		);
		const { kept } = selectReleases([...archives, ...votedSingles, ...votedAlbums], policy);
		expect(kept).toHaveLength(40);
		expect(kept.filter((c) => c.ratingVotes === 0)).toEqual([]);
		expect(kept.filter((c) => c.primaryType === "Album")).toHaveLength(19);
		// Among the voted singles, the 21 most voted take the remaining places.
		const keptSingles = kept.filter((c) => c.primaryType === "Single").map((c) => c.ratingVotes);
		expect(keptSingles.sort((a, b) => a - b)).toEqual(Array.from({ length: 21 }, (_, i) => 10 + i));
	});

	it("keeps a voted single before an unvoted album, an album before an EP before a single at equal votes", () => {
		const hey = release({ title: "Hey Jude", primaryType: "Single", ratingVotes: 12 });
		const bootleg = release({ title: "Bootleg", ratingVotes: 0 });
		const ep = release({ title: "Long Tall Sally", primaryType: "EP", ratingVotes: 12 });
		const album = release({ title: "Album", ratingVotes: 12 });
		expect(selectReleases([bootleg, hey], { ...policy, cap: 1 }).kept).toEqual([hey]);
		const order = selectReleases([hey, ep, album], { ...policy, cap: 2 }).kept.map((c) => c.title);
		expect(order.sort()).toEqual(["Album", "Long Tall Sally"]);
	});

	it("small artist with no vote at all: albums first, oldest to newest, then EPs, then singles", () => {
		const albums = many(30, "Album", 1980);
		const eps = many(5, "EP", 1990);
		const singles = many(30, "Single", 1970);
		const { kept } = selectReleases([...singles, ...eps, ...albums], policy);
		expect(kept).toHaveLength(40);
		expect(kept.filter((c) => c.primaryType === "Album")).toHaveLength(30);
		expect(kept.filter((c) => c.primaryType === "EP")).toHaveLength(5);
		expect(
			kept
				.filter((c) => c.primaryType === "Single")
				.map((c) => c.title)
				.sort(),
		).toEqual(
			singles
				.slice(0, 5)
				.map((c) => c.title)
				.sort(),
		);
	});

	it("Lennon: Lost Lennon Tapes at 0 votes come after Imagine and Plastic Ono Band", () => {
		const imagine = release({ title: "Imagine", firstReleaseDate: "1971-09-09", ratingVotes: 40 });
		const plastic = release({
			title: "John Lennon/Plastic Ono Band",
			firstReleaseDate: "1970-12-11",
			ratingVotes: 28,
		});
		const tapes = Array.from({ length: 25 }, (_, i) =>
			release({ title: `The Lost Lennon Tapes, Volume ${i + 1}`, firstReleaseDate: `${1992 + i}-01-01` }),
		);
		const { kept } = selectReleases([...tapes, imagine, plastic], { ...policy, cap: 5 });
		const titles = kept.map((c) => c.title);
		expect(titles).toContain("Imagine");
		expect(titles).toContain("John Lennon/Plastic Ono Band");
		// The 3 other places go to the oldest tapes, not the newest.
		expect(titles.filter((t) => t.startsWith("The Lost Lennon Tapes"))).toEqual([
			"The Lost Lennon Tapes, Volume 3",
			"The Lost Lennon Tapes, Volume 2",
			"The Lost Lennon Tapes, Volume 1",
		]);
	});

	it("fills with 3 albums, 2 EPs then 35 singles out of 100", () => {
		const { kept } = selectReleases(
			[...many(100, "Single", 1900), ...many(2, "EP", 2000), ...many(3, "Album", 2010)],
			policy,
		);
		expect(kept.filter((c) => c.primaryType === "Album")).toHaveLength(3);
		expect(kept.filter((c) => c.primaryType === "EP")).toHaveLength(2);
		expect(kept.filter((c) => c.primaryType === "Single")).toHaveLength(35);
	});

	it("sorts releases without a date last and breaks date ties deterministically", () => {
		const undated = release({ title: "Undated", firstReleaseDate: "" });
		const tieB = release({ title: "B", firstReleaseDate: "2020-01-01" });
		const tieA = release({ title: "A", firstReleaseDate: "2020-01-01" });
		const forward = selectReleases([undated, tieB, tieA], policy).kept;
		const backward = selectReleases([tieA, tieB, undated], policy).kept;
		expect(forward.map((c) => c.title)).toEqual(["A", "B", "Undated"]);
		expect(backward).toEqual(forward);
	});

	it("collapses an album and a single of the same title: Black Sun keeps the album", () => {
		const album = release({ title: "Black Sun", primaryType: "Album", firstReleaseDate: "2011-05-01" });
		const single = release({ title: "Black Sun", primaryType: "Single", firstReleaseDate: "2010-09-01" });
		for (const input of [
			[album, single],
			[single, album],
		]) {
			const { kept } = selectReleases(input, policy);
			expect(kept).toEqual([album]);
		}
	});

	it("keeps the stronger type then the earliest date among duplicates, and frees cap room", () => {
		const ep = release({ title: "Echo", primaryType: "EP", firstReleaseDate: "2005-01-01" });
		const singleLate = release({ title: "Echo", primaryType: "Single", firstReleaseDate: "2004-01-01" });
		expect(selectReleases([singleLate, ep], policy).kept).toEqual([ep]);

		const early = release({ title: "Twin", primaryType: "Single", firstReleaseDate: "2001-01-01" });
		const late = release({ title: "Twin", primaryType: "Single", firstReleaseDate: "2003-01-01" });
		const undated = release({ title: "Twin", primaryType: "Single", firstReleaseDate: "" });
		expect(selectReleases([undated, late, early], policy).kept).toEqual([early]);

		const other = release({ title: "Other", primaryType: "Single", firstReleaseDate: "2000-01-01" });
		expect(selectReleases([late, early, other], { ...policy, cap: 2 }).kept).toEqual(
			[early, other].sort((a, b) => b.firstReleaseDate.localeCompare(a.firstReleaseDate)),
		);
	});

	it("reports policy rejections with their reason and honours a custom cap", () => {
		const remix = release({ title: "The Remix Album" });
		const compilation = release({ secondaryTypes: ["Compilation"] });
		const { kept, excluded } = selectReleases([remix, compilation, ...many(3, "Album", 2000)], {
			...policy,
			cap: 2,
		});
		expect(kept).toHaveLength(2);
		expect(excluded).toEqual([
			{ mbid: remix.mbid, title: remix.title, reason: "non-canonical" },
			{ mbid: compilation.mbid, title: compilation.title, reason: "secondary-type" },
		]);
	});

	describe("unrated cut (TRA-628)", () => {
		// Distinct titles and years, so nothing collapses as a duplicate.
		function voted(count: number, firstYear: number): ReleaseGroupCandidate[] {
			return Array.from({ length: count }, (_, i) =>
				release({
					title: `Voted ${i}`,
					firstReleaseDate: `${firstYear + i}-01-01`,
					ratingVotes: 20 - i,
				}),
			);
		}
		function unvoted(count: number, firstYear: number, prefix = "Archive"): ReleaseGroupCandidate[] {
			return Array.from({ length: count }, (_, i) =>
				release({ title: `${prefix} ${i}`, firstReleaseDate: `${firstYear + (i % 18)}-01-01` }),
			);
		}

		it("Lennon: 14 voted and 55 unvoted from 1988 to 2005 -> the 55 are excluded as unrated, the 14 kept", () => {
			const rated = voted(14, 1970);
			const bootlegs = unvoted(55, 1988);
			const { kept, excluded } = selectReleases([...bootlegs, ...rated], policy);
			expect(kept.map((c) => c.mbid).sort()).toEqual(rated.map((c) => c.mbid).sort());
			expect(excluded).toHaveLength(55);
			expect(excluded.every((e) => e.reason === "unrated")).toBe(true);
			expect(new Set(excluded.map((e) => e.mbid))).toEqual(new Set(bootlegs.map((c) => c.mbid)));
		});

		it("Kode9: 24 candidates, none voted -> nothing is cut", () => {
			const all = unvoted(24, 1995, "Release");
			const { kept, excluded } = selectReleases(all, policy);
			expect(kept).toHaveLength(24);
			expect(excluded).toEqual([]);
		});

		it("cuts from exactly MIN_VOTED_FOR_UNRATED_CUT voted, not from one fewer", () => {
			expect(MIN_VOTED_FOR_UNRATED_CUT).toBe(10);
			const stray = release({ title: "Stray", firstReleaseDate: "1999-01-01" });
			const atThreshold = selectReleases([stray, ...voted(10, 1970)], policy);
			expect(atThreshold.kept).toHaveLength(10);
			expect(atThreshold.excluded).toEqual([{ mbid: stray.mbid, title: "Stray", reason: "unrated" }]);
			const below = selectReleases([stray, ...voted(9, 1970)], policy);
			expect(below.kept).toHaveLength(10);
			expect(below.excluded).toEqual([]);
		});

		it("counts the voted after dedupe: an album and a single of one title count once", () => {
			const rated = voted(9, 1970);
			const album = release({
				title: "Twice",
				primaryType: "Album",
				firstReleaseDate: "1990-01-01",
				ratingVotes: 5,
			});
			const single = release({
				title: "Twice",
				primaryType: "Single",
				firstReleaseDate: "1989-01-01",
				ratingVotes: 3,
			});
			const stray = release({ title: "Stray", firstReleaseDate: "1999-01-01" });
			// 9 + "Twice" = 10 distinct voted: the cut applies.
			expect(selectReleases([stray, album, single, ...rated], policy).excluded).toHaveLength(1);
			// 8 + "Twice" = 9 distinct voted (10 voted before dedupe would have cut): nothing is cut.
			expect(selectReleases([stray, album, single, ...rated.slice(1)], policy).excluded).toEqual([]);
		});

		it("spares a release from last year or this year, 12 voted around it", () => {
			const rated = voted(12, 1970);
			const thisYear = release({ title: "This year", firstReleaseDate: "2026-02-01" });
			const lastYear = release({ title: "Last year", firstReleaseDate: "2025-01-01" });
			const twoYearsAgo = release({ title: "Two years ago", firstReleaseDate: "2024-12-31" });
			const undated = release({ title: "Undated", firstReleaseDate: "" });
			const { kept, excluded } = selectReleases([...rated, thisYear, lastYear, twoYearsAgo, undated], policy);
			expect(kept.map((c) => c.title)).toEqual(expect.arrayContaining(["This year", "Last year"]));
			expect(excluded.map((e) => [e.title, e.reason]).sort()).toEqual([
				["Two years ago", "unrated"],
				["Undated", "unrated"],
			]);
		});

		it("takes currentYear from the policy, not from the clock", () => {
			const rated = voted(12, 1970);
			const album2025 = release({ title: "Recent", firstReleaseDate: "2025-01-01" });
			expect(selectReleases([...rated, album2025], { ...policy, currentYear: 2026 }).excluded).toEqual([]);
			expect(selectReleases([...rated, album2025], { ...policy, currentYear: 2030 }).excluded).toEqual([
				{ mbid: album2025.mbid, title: "Recent", reason: "unrated" },
			]);
		});

		it("does not let a policy rejection count as voted or as unrated", () => {
			const rated = voted(9, 1970);
			const liveVoted = release({ title: "Live", secondaryTypes: ["Live"], ratingVotes: 50 });
			const stray = release({ title: "Stray", firstReleaseDate: "1999-01-01" });
			const { excluded } = selectReleases([stray, liveVoted, ...rated], policy);
			// The Live album is rejected first, so only 9 voted remain: no unrated cut.
			expect(excluded).toEqual([{ mbid: liveVoted.mbid, title: "Live", reason: "secondary-type" }]);
		});
	});
});

describe("orderDiscography", () => {
	it("sorts by year descending, then name ascending", () => {
		const ordered = orderDiscography([edge("B", "1999"), edge("Z", "2001"), edge("A", "2001")]);
		expect(ordered.map((e) => e.name)).toEqual(["A", "Z", "B"]);
	});

	it("is stable on an already sorted list and leaves entries without year last, in order", () => {
		const sorted = [edge("A", "2001"), edge("B", "1999")];
		expect(orderDiscography(sorted)).toEqual(sorted);

		const mixed = [edge("U2"), edge("X", "1990"), edge("U1"), edge("Y", "2020")];
		expect(orderDiscography(mixed).map((e) => e.name)).toEqual(["Y", "X", "U2", "U1"]);
	});

	it("does not modify its input or its entries", () => {
		const input = [edge("A", "1990"), edge("B", "2000"), edge("C")];
		const snapshot = structuredClone(input);
		const output = orderDiscography(input);
		expect(input).toEqual(snapshot);
		expect(output[0]).toBe(input[1]);
		expect(output).not.toBe(input);
	});
});

describe("toDiscographyEdge", () => {
	it("builds the Discovery project edge", () => {
		const discovery = release({ title: "Discovery", firstReleaseDate: "2001-03-12" });
		expect(toDiscographyEdge(discovery, policy)).toEqual({
			slug: "project:discovery--daft-punk",
			type: "project",
			name: "Discovery",
			artist: "Daft Punk",
			mbid: discovery.mbid,
			year: "2001",
			releaseType: "album",
		});
	});

	it("has the exact shape scopedWorkEdge gives the MusicBrainz discography override today", () => {
		// Mirrors scopedWorkEdge (src/pipeline.ts, scoped-slug branch): trimmed name, `artist` stamped with the
		// trimmed scope name, mbid / year / releaseType only when present, no other key. TRA-615 replaces that
		// block with this helper, so the edge written to the cache must not change.
		const padded = release({ title: "  Discovery ", firstReleaseDate: "2001-03-12" });
		const edgeForPaddedInput = toDiscographyEdge(padded, { ...policy, artistName: " Daft Punk " });
		expect(edgeForPaddedInput).toStrictEqual({
			slug: "project:discovery--daft-punk",
			type: "project",
			name: "Discovery",
			artist: "Daft Punk",
			mbid: padded.mbid,
			year: "2001",
			releaseType: "album",
		});

		const bare = release({ mbid: "", title: "Da Funk", firstReleaseDate: "", primaryType: "Single" });
		expect(toDiscographyEdge(bare, policy)).toStrictEqual({
			slug: "project:da-funk--daft-punk",
			type: "project",
			name: "Da Funk",
			artist: "Daft Punk",
			releaseType: "single",
		});
	});

	it("returns null for an artist name that cannot scope a slug", () => {
		expect(toDiscographyEdge(release({ title: "Discovery" }), { ...policy, artistName: "  " })).toBeNull();
	});

	it("omits the year when MusicBrainz has no date", () => {
		const result = toDiscographyEdge(release({ title: "Discovery", firstReleaseDate: "" }), policy);
		expect(result).not.toBeNull();
		expect(result).not.toHaveProperty("year");
	});

	it("lowercases the release type and returns null when no slug can be built", () => {
		expect(toDiscographyEdge(release({ title: "Da Funk", primaryType: "EP" }), policy)?.releaseType).toBe(
			"ep",
		);
		expect(toDiscographyEdge(release({ title: "!!!" }), policy)).toBeNull();
	});
});
