import { describe, expect, it } from "vitest";
import {
	classifyRelease,
	DEFAULT_DISCOGRAPHY_CAP,
	type DiscographyPolicy,
	isNonCanonicalReleaseTitle,
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
	const kode9: DiscographyPolicy = { artistMbid: ARTIST_MBID, artistName: "Kode9", cap: 40 };
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

	it("rejects any secondary type", () => {
		expect(classifyRelease(release({ secondaryTypes: ["Compilation"] }), policy)).toEqual({
			ok: false,
			reason: "secondary-type",
		});
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

	it("keeps 5 albums and the 35 most recent of 90 singles, ordered by year descending", () => {
		const albums = many(5, "Album", 1990);
		const singles = many(90, "Single", 1920);
		const { kept } = selectReleases([...singles, ...albums], policy);
		expect(kept).toHaveLength(40);
		expect(kept.filter((c) => c.primaryType === "Album")).toHaveLength(5);
		const keptSingles = kept.filter((c) => c.primaryType === "Single");
		expect(keptSingles.map((c) => c.title)).toEqual(
			singles
				.slice(-35)
				.reverse()
				.map((c) => c.title),
		);
		const dates = kept.map((c) => c.firstReleaseDate);
		expect(dates).toEqual([...dates].sort().reverse());
	});

	it("keeps the 40 most recent of 45 albums and no single", () => {
		const albums = many(45, "Album", 1970);
		const { kept } = selectReleases([...many(10, "Single", 2000), ...albums], policy);
		expect(kept.map((c) => c.title)).toEqual(
			albums
				.slice(-40)
				.reverse()
				.map((c) => c.title),
		);
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
