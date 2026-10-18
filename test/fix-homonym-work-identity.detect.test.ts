import { describe, expect, it } from "vitest";
import {
	buildIndex,
	detectHomonymWorks,
	nameForms,
} from "../scripts/migrations/2026-10-20-fix-homonym-work-identity.js";

// TRA-604: the detector reads the cache as plain objects (offline, no clock), so every case here is a handful
// of nodes. The fixtures mirror the prod nodes of 2026-10-17 (wish-you-were-here--american-hot-wax, around-the-
// world--stanley-black-and-his-orchestra) and the three legitimate shapes the ticket names, where the group or
// the artist the article talks about is NOT a homonym of the credit.

type Obj = Record<string, unknown>;

const MBID = {
	hotWax: "ec0201ac-50e2-47ba-8736-d9bffe48852e",
	stanley: "981aa60f-7cc0-4b0a-abab-808107deeac9",
	huetter: "11111111-1111-4111-8111-111111111111",
	eoin: "22222222-2222-4222-8222-222222222222",
	moroder: "33333333-3333-4333-8333-333333333333",
};

const edge = (slug: string, name: string, extra: Obj = {}): Obj => ({
	slug,
	type: slug.slice(0, slug.indexOf(":")),
	name,
	...extra,
});

function artist(slug: string, name: string, fields: Obj = {}): [string, Obj] {
	return [
		slug,
		{
			slug,
			type: "artist",
			name,
			editorial_article: `${name} is an artist.`,
			discography: [],
			notable_tracks: [],
			members: [],
			aliases: [],
			...fields,
		},
	];
}

function project(slug: string, name: string, fields: Obj = {}): [string, Obj] {
	return [slug, { slug, type: "project", name, artists: [], producers: [], ...fields }];
}

function track(slug: string, name: string, fields: Obj = {}): [string, Obj] {
	return [slug, { slug, type: "track", name, artists: [], producers: [], ...fields }];
}

const detect = (entries: [string, Obj][], redirects: [string, string][] = []) =>
	detectHomonymWorks(buildIndex(new Map(entries), new Map(redirects)));

const WYWH = "project:wish-you-were-here--american-hot-wax";
const wishYouWereHere = (): [string, Obj][] => [
	project(WYWH, "Wish You Were Here", {
		mbid: "217d2789-9121-3407-be70-73b0e3c5826e",
		editorial_article:
			"Pink Floyd's ninth studio album, Wish You Were Here, was released on September 12, 1975, through Harvest Records.",
		editorial_pitch: "Released in 1975, this concept album is a tribute to Syd Barrett.",
		artists: [edge("artist:american-hot-wax", "American Hot Wax", { mbid: MBID.hotWax })],
		producers: [edge("artist:pink-floyd", "Pink Floyd")],
	}),
	artist("artist:american-hot-wax", "American Hot Wax", {
		mbid: MBID.hotWax,
		editorial_article: "American Hot Wax is a band that released a few records in 2001.",
		discography: [edge(WYWH, "Wish You Were Here")],
	}),
	artist("artist:pink-floyd", "Pink Floyd", {
		editorial_article: "Pink Floyd were an English rock band formed in London in 1965.",
		discography: [edge(WYWH, "Wish You Were Here", { releaseType: "album", year: "1975" })],
	}),
];

describe("detectHomonymWorks: the two cases of the ticket are flagged", () => {
	it("flags Wish You Were Here credited to American Hot Wax, whose article is Pink Floyd's", () => {
		const { suspects } = detect(wishYouWereHere());
		expect(suspects).toHaveLength(1);
		const [suspect] = suspects;
		expect(suspect?.slug).toBe(WYWH);
		expect(suspect?.credited.map((c) => c.slug)).toEqual(["artist:american-hot-wax"]);
		expect(suspect?.articleArtists.map((a) => a.slug)).toEqual(["artist:pink-floyd"]);
		expect(suspect?.articleArtists[0]?.evidence).toEqual(["lists", "producer"]);
	});

	it("flags Around the World credited to Stanley Black, whose article is Daft Punk's (listed through a redirect)", () => {
		const slug = "track:around-the-world--stanley-black-and-his-orchestra";
		const { suspects } = detect(
			[
				track(slug, "Around the World", {
					mbid: "e2d089d2-7ae7-4614-b5fa-c65c3f18db56",
					editorial_article: "Released in 1997, Around the World is a single by Daft Punk, from Homework.",
					editorial_teaser: "A definitive French house classic.",
					artists: [
						edge("artist:stanley-black-and-his-orchestra", "Stanley Black & His Orchestra", {
							mbid: MBID.stanley,
						}),
					],
					producers: [edge("artist:daft-punk", "Daft Punk")],
				}),
				artist("artist:stanley-black-and-his-orchestra", "Stanley Black & His Orchestra", {
					mbid: MBID.stanley,
				}),
				// Daft Punk lists the BARE slug; the global table sends it to the homonym's node (TRA-602).
				artist("artist:daft-punk", "Daft Punk", {
					notable_tracks: [edge("track:around-the-world", "Around the World")],
				}),
			],
			[["track:around-the-world", slug]],
		);
		expect(suspects.map((s) => s.slug)).toEqual([slug]);
		expect(suspects[0]?.articleArtists[0]).toMatchObject({
			slug: "artist:daft-punk",
			evidence: ["lists", "producer"],
		});
	});

	it("flags a work with no producer when the artist lists it and is named in its article", () => {
		const entries = wishYouWereHere().map(([slug, node]): [string, Obj] =>
			slug === WYWH ? [slug, { ...node, producers: [] }] : [slug, node],
		);
		expect(detect(entries).suspects[0]?.articleArtists[0]?.evidence).toEqual(["lists"]);
	});

	it("flags a work whose only link to the article's artist is its producers", () => {
		const entries = wishYouWereHere().map(([slug, node]): [string, Obj] =>
			slug === "artist:pink-floyd" ? [slug, { ...node, discography: [] }] : [slug, node],
		);
		expect(detect(entries).suspects[0]?.articleArtists[0]?.evidence).toEqual(["producer"]);
	});

	it("reads the pitch as well as the article", () => {
		const entries = wishYouWereHere().map(([slug, node]): [string, Obj] =>
			slug === WYWH
				? [
						slug,
						{
							...node,
							editorial_article: "A long article that names nobody.",
							editorial_pitch: "Pink Floyd's 1975 concept album.",
						},
					]
				: [slug, node],
		);
		expect(detect(entries).suspects).toHaveLength(1);
	});
});

describe("detectHomonymWorks: the legitimate credits are left alone", () => {
	it("keeps a work credited to Ralf Hutter when Kraftwerk, named in the article, lists him as a member", () => {
		const slug = "project:autobahn--ralf-hutter";
		const { suspects, exempted } = detect([
			project(slug, "Autobahn", {
				editorial_article: "Autobahn is the fourth album by Kraftwerk, released in 1974.",
				artists: [edge("artist:ralf-hutter", "Ralf Hütter", { mbid: MBID.huetter })],
			}),
			artist("artist:ralf-hutter", "Ralf Hütter", { mbid: MBID.huetter }),
			artist("artist:kraftwerk", "Kraftwerk", {
				members: [edge("artist:ralf-hutter", "Ralf Hütter")],
				discography: [edge(slug, "Autobahn")],
			}),
		]);
		expect(suspects).toEqual([]);
		expect(exempted).toEqual([{ work: slug, artist: "artist:kraftwerk", reason: "relative" }]);
	});

	it("keeps it too when the cache links the two only through their prose (Kraftwerk has no members edge in prod)", () => {
		const slug = "project:autobahn--ralf-hutter";
		const { suspects, exempted } = detect([
			project(slug, "Autobahn", {
				editorial_article: "Autobahn is the fourth album by Kraftwerk, released in 1974.",
				artists: [edge("artist:ralf-hutter", "Ralf Hütter", { mbid: MBID.huetter })],
			}),
			artist("artist:ralf-hutter", "Ralf Hütter", {
				mbid: MBID.huetter,
				editorial_article: "Ralf Hütter is the singer and a co-founder of Kraftwerk.",
			}),
			artist("artist:kraftwerk", "Kraftwerk", { discography: [edge(slug, "Autobahn")] }),
		]);
		expect(suspects).toEqual([]);
		expect(exempted[0]).toMatchObject({ artist: "artist:kraftwerk", reason: "mutual-naming" });
	});

	it("keeps a work credited to Marcus Eoin when Boards of Canada, named in the article, has him as a member", () => {
		const slug = "track:roygbiv--marcus-eoin";
		const { suspects } = detect([
			track(slug, "Roygbiv", {
				editorial_article: "Roygbiv is a track by Boards of Canada, from Music Has the Right to Children.",
				artists: [edge("artist:marcus-eoin", "Marcus Eoin", { mbid: MBID.eoin })],
			}),
			artist("artist:marcus-eoin", "Marcus Eoin", { mbid: MBID.eoin }),
			artist("artist:boards-of-canada", "Boards of Canada", {
				members: [edge("artist:marcus-eoin", "Marcus Eoin")],
				notable_tracks: [edge(slug, "Roygbiv")],
			}),
		]);
		expect(suspects).toEqual([]);
	});

	it("keeps it when it is the member who lists the band (the edge goes the other way)", () => {
		const slug = "track:roygbiv--marcus-eoin";
		const { suspects } = detect([
			track(slug, "Roygbiv", {
				editorial_article: "Roygbiv is a track by Boards of Canada.",
				artists: [edge("artist:marcus-eoin", "Marcus Eoin", { mbid: MBID.eoin })],
			}),
			artist("artist:marcus-eoin", "Marcus Eoin", {
				mbid: MBID.eoin,
				aliases: [edge("artist:boards-of-canada", "Boards of Canada")],
			}),
			artist("artist:boards-of-canada", "Boards of Canada", { notable_tracks: [edge(slug, "Roygbiv")] }),
		]);
		expect(suspects).toEqual([]);
	});

	it("keeps a work credited to Giorgio Moroder, who also produced it, when Donna Summer is the one named", () => {
		const slug = "track:i-feel-love--giorgio-moroder";
		const { suspects, kept } = detect([
			track(slug, "I Feel Love", {
				editorial_article: "I Feel Love is a 1977 single by Donna Summer, a landmark of electronic disco.",
				artists: [edge("artist:giorgio-moroder", "Giorgio Moroder", { mbid: MBID.moroder })],
				producers: [
					edge("artist:giorgio-moroder", "Giorgio Moroder"),
					edge("artist:donna-summer", "Donna Summer"),
				],
			}),
			artist("artist:giorgio-moroder", "Giorgio Moroder", { mbid: MBID.moroder }),
			artist("artist:donna-summer", "Donna Summer", { notable_tracks: [edge(slug, "I Feel Love")] }),
		]);
		expect(suspects).toEqual([]);
		// The article never names Moroder: what keeps the work is that he produced it.
		expect(kept["credit-produces"]).toBe(1);
	});

	it("keeps a work whose article names its credited artist", () => {
		const slug = "project:animals--pink-floyd";
		const { suspects, kept } = detect([
			project(slug, "Animals", {
				editorial_article: "Animals is the tenth studio album by Pink Floyd (1977).",
				artists: [edge("artist:pink-floyd", "Pink Floyd", { mbid: MBID.hotWax })],
			}),
			artist("artist:pink-floyd", "Pink Floyd", { discography: [edge(slug, "Animals")] }),
		]);
		expect(suspects).toEqual([]);
		expect(kept["credit-named"]).toBe(1);
	});

	it("matches a credit through its cached name, its aliases, '&' / 'and' and a leading 'The'", () => {
		const slug = "project:wasted--the-artist";
		const base = (artistName: string, node: Obj = {}): [string, Obj][] => [
			project(slug, "Wasted", {
				editorial_article: `Wasted is a record by ${artistName}, reissued by Pink Floyd's label.`,
				artists: [edge("artist:the-artist", "The Artist", { mbid: MBID.eoin })],
			}),
			artist("artist:the-artist", "The Artist", { mbid: MBID.eoin, ...node }),
			artist("artist:pink-floyd", "Pink Floyd", { discography: [edge(slug, "Wasted")] }),
		];
		expect(detect(base("The Artist")).suspects).toEqual([]);
		expect(detect(base("Artist")).suspects).toEqual([]);
		expect(detect(base("Prince", { aliases: [edge("artist:prince", "Prince")] })).suspects).toEqual([]);
		expect(detect(base("Somebody Else")).suspects).toHaveLength(1);
		expect(nameForms("Simon & Garfunkel")).toEqual(
			expect.arrayContaining(["simon garfunkel", "simon and garfunkel"]),
		);
	});
});

describe("detectHomonymWorks: what it cannot judge it does not flag", () => {
	const mutate = (fields: (node: Obj) => Obj): [string, Obj][] =>
		wishYouWereHere().map(([slug, node]): [string, Obj] =>
			slug === WYWH ? [slug, fields(node)] : [slug, node],
		);

	it("does not flag a work with no prose", () => {
		const { suspects, kept } = detect(
			mutate((n) => ({ ...n, editorial_article: undefined, editorial_pitch: undefined })),
		);
		expect(suspects).toEqual([]);
		expect(kept["no-text"]).toBe(1);
	});

	it("does not flag a credit that did not come from MusicBrainz (no mbid on the work nor on the edge)", () => {
		const { suspects, kept } = detect(
			mutate((n) => ({
				...n,
				mbid: undefined,
				artists: [edge("artist:american-hot-wax", "American Hot Wax")],
			})),
		);
		expect(suspects).toEqual([]);
		expect(kept["no-musicbrainz-credit"]).toBe(1);
	});

	it("does not flag a work with no credit at all", () => {
		expect(detect(mutate((n) => ({ ...n, artists: [] }))).suspects).toEqual([]);
	});

	it("does not flag a credit in a script the name comparison cannot read, nor 'Various Artists'", () => {
		const script = detect(
			mutate((n) => ({ ...n, artists: [edge("artist:sakamoto", "坂本龍一", { mbid: MBID.eoin })] })),
		);
		expect(script.suspects).toEqual([]);
		expect(script.kept["unjudgeable-credit"]).toBe(1);
		const various = detect(
			mutate((n) => ({
				...n,
				artists: [edge("artist:various-artists", "Various Artists", { mbid: MBID.eoin })],
			})),
		);
		expect(various.suspects).toEqual([]);
	});

	it("does not take an artist's name that is part of the work's own title for an article artist", () => {
		const slug = "project:pink-floyd-the-wall--somebody";
		const { suspects } = detect([
			project(slug, "Pink Floyd: The Wall", {
				editorial_article: "A tribute record titled Pink Floyd: The Wall, recorded in a garage.",
				artists: [edge("artist:somebody", "Somebody", { mbid: MBID.eoin })],
			}),
			artist("artist:somebody", "Somebody", { mbid: MBID.eoin }),
			artist("artist:pink-floyd", "Pink Floyd", { discography: [edge(slug, "Pink Floyd: The Wall")] }),
		]);
		expect(suspects).toEqual([]);
	});

	it("does not take a name of 3 letters or less for an article artist", () => {
		const entries = mutate((n) => ({
			...n,
			editorial_article: "A record by Pi, released in 1975.",
			editorial_pitch: "",
		})).map(([slug, node]): [string, Obj] =>
			slug === "artist:pink-floyd" ? [slug, { ...node, name: "Pi" }] : [slug, node],
		);
		expect(detect(entries).suspects).toEqual([]);
	});

	it("does not flag a work whose listers are not named in its article", () => {
		const entries = wishYouWereHere().map(([slug, node]): [string, Obj] =>
			slug === WYWH
				? [slug, { ...node, editorial_article: "A long article that names nobody.", editorial_pitch: "" }]
				: [slug, node],
		);
		expect(detect(entries).suspects).toEqual([]);
	});

	it("reports every artist the article names, so that the migration can refuse to guess", () => {
		const entries: [string, Obj][] = [
			...wishYouWereHere().map(([slug, node]): [string, Obj] =>
				slug === WYWH
					? [slug, { ...node, editorial_article: "Pink Floyd's album, covered by Genesis later." }]
					: [slug, node],
			),
			artist("artist:genesis", "Genesis", { discography: [edge(WYWH, "Wish You Were Here")] }),
		];
		const { suspects } = detect(entries);
		expect(suspects[0]?.articleArtists.map((a) => a.slug)).toEqual(["artist:genesis", "artist:pink-floyd"]);
	});
});
