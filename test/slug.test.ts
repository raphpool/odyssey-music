import { describe, expect, test, vi } from "vitest";
import { NODE_TYPES } from "../src/node-spec.js";
import {
	CANONICAL_SLUG_PATTERN,
	isReadableSlug,
	isScopedSlug,
	isValidSlug,
	makeScopedSlug,
	makeSlug,
	normalizeSlugBody,
	normalizeTitleBody,
	parseSlug,
	pickScopeArtistName,
	scopeMatchesArtist,
	scopeOf,
	stripEditionNoise,
	titleLosesLetters,
} from "../src/slug.js";

describe("normalizeSlugBody", () => {
	test("lowercases and dashes", () => {
		expect(normalizeSlugBody("Aphex Twin")).toBe("aphex-twin");
		expect(normalizeSlugBody("aphex twin")).toBe("aphex-twin");
		expect(normalizeSlugBody("APHEX  TWIN ")).toBe("aphex-twin");
	});

	test("strips trailing parenthetical disambiguator", () => {
		expect(normalizeSlugBody("Aphex Twin (musician)")).toBe("aphex-twin");
		expect(normalizeSlugBody("Faust (band)")).toBe("faust");
	});

	test("strips trailing bracket disambiguator", () => {
		expect(normalizeSlugBody("Tendency [Remastered]")).toBe("tendency");
	});

	test("preserves middle parentheticals as plain text", () => {
		expect(normalizeSlugBody("Music (For) Films")).toBe("music-for-films");
	});

	test("expands ampersand", () => {
		expect(normalizeSlugBody("Simon & Garfunkel")).toBe("simon-and-garfunkel");
	});

	test("handles unicode accents", () => {
		// Diacritics are stripped via NFKD
		expect(normalizeSlugBody("Björk")).toBe("bjork");
		expect(normalizeSlugBody("Café Tacvba")).toBe("cafe-tacvba");
	});

	test("keeps distinct entities distinct", () => {
		expect(normalizeSlugBody("AFX")).not.toBe(normalizeSlugBody("Aphex Twin"));
		expect(normalizeSlugBody("Polygon Window")).not.toBe(normalizeSlugBody("Aphex Twin"));
	});

	test("throws on fully empty body", () => {
		expect(() => makeSlug("artist", "()")).toThrow();
		expect(() => makeSlug("artist", "   ")).toThrow();
	});
});

describe("makeSlug", () => {
	test("typed slug includes prefix", () => {
		expect(makeSlug("artist", "Aphex Twin")).toBe("artist:aphex-twin");
		expect(makeSlug("track", "Tendency")).toBe("track:tendency");
		expect(makeSlug("label", "Warp Records")).toBe("label:warp-records");
	});

	test("variants collapse to same slug", () => {
		const a = makeSlug("artist", "Aphex Twin");
		const b = makeSlug("artist", "aphex twin");
		const c = makeSlug("artist", "Aphex Twin (musician)");
		expect(a).toBe(b);
		expect(b).toBe(c);
	});
});

describe("parseSlug", () => {
	test("round-trips", () => {
		const parsed = parseSlug("artist:aphex-twin");
		expect(parsed.type).toBe("artist");
		expect(parsed.body).toBe("aphex-twin");
	});

	test("rejects malformed", () => {
		expect(() => parseSlug("no-colon")).toThrow();
		expect(() => parseSlug("foo:bar")).toThrow();
		expect(() => parseSlug("artist:")).toThrow();
	});
});

describe("isValidSlug (canonical rule, TRA-501)", () => {
	test("accepts the slugs the codebase mints", () => {
		for (const slug of [
			"artist:aphex-twin",
			"track:tendency",
			"track:fitna--rohff",
			"artist:pole--stefan-betke",
			"genre:r-and-b",
			"project:kid-a--radiohead",
			"label:warp-records",
			"genre:2-step",
		]) {
			expect(isValidSlug(slug), slug).toBe(true);
		}
	});
	test("rejects an unknown type or an empty input", () => {
		expect(isValidSlug("foo:bar")).toBe(false);
		expect(isValidSlug("")).toBe(false);
		expect(isValidSlug("artist:")).toBe(false);
		expect(isValidSlug("aphex-twin")).toBe(false);
	});
	test("rejects a body that could break out of an HTML attribute", () => {
		expect(isValidSlug('artist:x" onmouseover="y')).toBe(false);
		expect(isValidSlug("artist:x'><img src=x onerror=alert(1)>")).toBe(false);
		expect(isValidSlug("artist:x&amp;y")).toBe(false);
	});
	test("rejects a body that is not what normalizeSlugBody produces", () => {
		for (const slug of [
			"artist:Aphex-Twin",
			"Artist:aphex-twin",
			"artist:aphex twin",
			"artist:aphex_twin",
			"artist:-aphex",
			"artist:aphex-",
			"artist:aphex---twin",
			"artist:a--b--c",
			"artist:--b",
			"artist:a--",
			"artist:../x",
			"artist:a/b",
			"artist:a%22b",
			"artist:caf\u00e9",
			"artist:a\nb",
			"artist:aphex-twin\n",
		]) {
			expect(isValidSlug(slug), JSON.stringify(slug)).toBe(false);
		}
	});
	test("accepts whatever makeSlug and makeScopedSlug produce", () => {
		expect(isValidSlug(makeSlug("artist", "Aphex Twin (musician)"))).toBe(true);
		expect(isValidSlug(makeSlug("track", "Tendency", "Jan Jelinek"))).toBe(true);
		expect(isValidSlug(makeSlug("genre", "R&B"))).toBe(true);
		const scoped = makeScopedSlug("track", "Fitna (Live) [2004]", "Rohff");
		if (!scoped.ok) throw new Error("expected a slug");
		expect(isValidSlug(scoped.slug)).toBe(true);
	});
	// CI 2026-10-15 (#426): a fixture wrote "project:in-the-møde". The pipeline cannot produce that slug:
	// normalization drops every character outside [a-z0-9] (NFKD leaves ø, æ, ł, ß whole, and they are
	// dropped rather than transliterated), so whatever name goes in, the body is canonical.
	test("makeSlug and makeScopedSlug never emit a non-ASCII body, whatever the name", () => {
		const expected: Record<string, string> = {
			"In the Møde": "in-the-m-de",
			MØ: "m",
			Æther: "ther",
			Łona: "ona",
			"Mötley Crüe": "motley-crue",
			Straße: "stra-e",
		};
		for (const [name, body] of Object.entries(expected)) {
			const slug = makeSlug("artist", name);
			expect(slug, name).toBe(`artist:${body}`);
			expect(isValidSlug(slug), name).toBe(true);
		}
		const scoped = makeScopedSlug("project", "In the Møde", "MØ");
		expect(scoped).toEqual({ ok: true, slug: "project:in-the-m-de--m" });
		if (scoped.ok) expect(isValidSlug(scoped.slug)).toBe(true);
		// no Latin letter or digit at all: an expected failure, not a non-canonical slug
		expect(() => makeSlug("artist", "坂本龍一")).toThrow(/empty name/);
		expect(makeScopedSlug("track", "Song", "坂本龍一")).toEqual({ ok: false, reason: "empty-artist" });
	});

	test("the exported pattern covers every node type, and only those", () => {
		for (const type of NODE_TYPES) expect(CANONICAL_SLUG_PATTERN.test(`${type}:x`), type).toBe(true);
		expect(CANONICAL_SLUG_PATTERN.test("playlist:x")).toBe(false);
		expect(CANONICAL_SLUG_PATTERN.source).toBe(
			"^(genre|label|artist|project|track):[a-z0-9]+(-[a-z0-9]+)*(--[a-z0-9]+(-[a-z0-9]+)*)?$",
		);
	});
});

describe("isReadableSlug (legacy rule kept for reads, TRA-501)", () => {
	test("accepts what parseSlug accepts, canonical or not", () => {
		expect(isReadableSlug("artist:aphex-twin")).toBe(true);
		expect(isReadableSlug('artist:x" onmouseover="y')).toBe(true);
	});
	test("still rejects an unknown type, a missing colon and an empty body", () => {
		expect(isReadableSlug("foo:bar")).toBe(false);
		expect(isReadableSlug("artist")).toBe(false);
		expect(isReadableSlug("artist:")).toBe(false);
		expect(isReadableSlug("")).toBe(false);
	});
});

describe("normalizeTitleBody", () => {
	test("flattens like normalizeSlugBody when there is no parenthetical", () => {
		for (const title of ["New Forms", "Sigur Rós", "Mix & Match", "  Spaced   Out  "]) {
			expect(normalizeTitleBody(title)).toBe(normalizeSlugBody(title));
		}
		expect(normalizeTitleBody("Mix & Match")).toBe("mix-and-match");
	});

	test("keeps a trailing parenthetical or bracket that names the work", () => {
		expect(normalizeTitleBody("Booty La La (Loefah remix)")).toBe("booty-la-la-loefah-remix");
		expect(normalizeTitleBody("Fitna (Live)")).toBe("fitna-live");
		expect(normalizeTitleBody("Get Lucky (Daft Punk Remix)")).toBe("get-lucky-daft-punk-remix");
		expect(normalizeTitleBody("aisatsana [102]")).toBe("aisatsana-102");
		expect(normalizeTitleBody("Phragmal Synthesis (Pt. 3)")).toBe("phragmal-synthesis-pt-3");
		expect(normalizeTitleBody("Song (Radio Version)")).toBe("song-radio-version");
		// ...which is exactly where it differs from normalizeSlugBody.
		expect(normalizeSlugBody("Fitna (Live)")).toBe("fitna");
	});

	test.each([
		"Remaster",
		"Remastered",
		"2019 Remaster",
		"2011 Remastered",
		"remastered",
		"Deluxe",
		"Deluxe Edition",
		"Expanded Edition",
		"Anniversary Edition",
		"Special Edition",
		"Collector's Edition",
		"Collector’s Edition",
		"Bonus Track Edition",
		"Bonus Track",
		"Bonus Tracks",
		"Explicit",
		"Clean",
		"Original Mix",
		"feat. Pharrell Williams",
		"Feat Pharrell Williams",
		"ft. Nile Rodgers",
		"Featuring Nile Rodgers & Pharrell",
	])("drops the edition-noise group %s, in parentheses or brackets", (noise) => {
		expect(normalizeTitleBody(`Some Title (${noise})`)).toBe("some-title");
		expect(normalizeTitleBody(`Some Title [${noise}]`)).toBe("some-title");
	});

	test("drops noise anywhere in the title and several groups at once", () => {
		expect(normalizeTitleBody("Kid A (Deluxe Edition)")).toBe("kid-a");
		expect(normalizeTitleBody("Abbey Road (2019 Remaster)")).toBe("abbey-road");
		expect(normalizeTitleBody("Get Lucky (feat. Pharrell Williams)")).toBe("get-lucky");
		expect(normalizeTitleBody("Title (Explicit) [Remastered] Part Two")).toBe("title-part-two");
		expect(normalizeTitleBody("Title (Deluxe) (Live)")).toBe("title-live");
	});

	test("keeps groups that merely contain a noise word", () => {
		expect(normalizeTitleBody("Title (Deluxe Remix)")).toBe("title-deluxe-remix");
		expect(normalizeTitleBody("Title (Clean Bandit Remix)")).toBe("title-clean-bandit-remix");
		expect(normalizeTitleBody("Title (Remastered Live)")).toBe("title-remastered-live");
		expect(normalizeTitleBody("Title (Original Mix Part 2)")).toBe("title-original-mix-part-2");
	});

	test("is empty for a title made only of noise or punctuation", () => {
		expect(normalizeTitleBody("(Remastered)")).toBe("");
		expect(normalizeTitleBody("[Deluxe Edition] (Explicit)")).toBe("");
		expect(normalizeTitleBody("!!!")).toBe("");
	});
});

describe("stripEditionNoise", () => {
	test("drops noise groups but keeps casing, diacritics and single spacing", () => {
		expect(stripEditionNoise("Kid A (Deluxe Edition)")).toBe("Kid A");
		expect(stripEditionNoise("Sigur Rós (2019 Remaster)")).toBe("Sigur Rós");
		expect(stripEditionNoise("Title (Explicit) [Remastered] Part Two")).toBe("Title Part Two");
	});

	test("keeps every other group", () => {
		expect(stripEditionNoise("Booty La La (Loefah remix)")).toBe("Booty La La (Loefah remix)");
		expect(stripEditionNoise("aisatsana [102]")).toBe("aisatsana [102]");
	});

	test("is empty for a title made only of noise", () => {
		expect(stripEditionNoise("(Remastered)")).toBe("");
	});
});

describe("makeScopedSlug", () => {
	const slugOf = (type: "project" | "track", title: string, artist: string): string => {
		const r = makeScopedSlug(type, title, artist);
		if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
		return r.slug;
	};

	test("builds <type>:<title>--<artist>", () => {
		expect(makeScopedSlug("track", "Fitna", "Rohff")).toEqual({ ok: true, slug: "track:fitna--rohff" });
		expect(slugOf("project", "New Forms", "Roni Size / Reprazent")).toBe(
			"project:new-forms--roni-size-reprazent",
		);
	});

	test("strips diacritics from both title and artist", () => {
		expect(slugOf("track", "Corazón Loco", "Lisa Carbon")).toBe("track:corazon-loco--lisa-carbon");
		expect(slugOf("project", "Dépêche", "Mylène Farmer")).toBe("project:depeche--mylene-farmer");
	});

	test("turns & into and in both parts", () => {
		expect(slugOf("project", "Rock & Roll", "Simon & Garfunkel")).toBe(
			"project:rock-and-roll--simon-and-garfunkel",
		);
	});

	test("agrees with makeSlug's disambiguator form when the title has no parenthetical", () => {
		expect(slugOf("track", "Tendency", "Jan Jelinek")).toBe(makeSlug("track", "Tendency", "Jan Jelinek"));
	});

	test("keeps a title's parenthetical or bracket, so remixes stay distinct works", () => {
		const bare = slugOf("project", "Booty La La", "Bugz in the Attic");
		const loefah = slugOf("project", "Booty La La (Loefah remix)", "Bugz in the Attic");
		const drawTheLine = slugOf("project", "Booty La La (Draw the Line remix)", "Bugz in the Attic");
		expect(bare).toBe("project:booty-la-la--bugz-in-the-attic");
		expect(loefah).toBe("project:booty-la-la-loefah-remix--bugz-in-the-attic");
		expect(new Set([bare, loefah, drawTheLine]).size).toBe(3);
		expect(slugOf("track", "aisatsana [102]", "Aphex Twin")).toBe("track:aisatsana-102--aphex-twin");
		expect(slugOf("track", "Phragmal Synthesis (Pt. 3)", "Aphex Twin")).toBe(
			"track:phragmal-synthesis-pt-3--aphex-twin",
		);
	});

	test("ignores edition noise in the title", () => {
		expect(slugOf("project", "Kid A (Deluxe Edition)", "Radiohead")).toBe("project:kid-a--radiohead");
		expect(slugOf("track", "Get Lucky (feat. Pharrell Williams)", "Daft Punk")).toBe(
			"track:get-lucky--daft-punk",
		);
		expect(slugOf("project", "Abbey Road (2019 Remaster)", "The Beatles")).toBe(
			"project:abbey-road--the-beatles",
		);
	});

	test("returns empty-artist instead of throwing when the artist has no latin body", () => {
		expect(makeScopedSlug("project", "async", "坂本龍一")).toEqual({ ok: false, reason: "empty-artist" });
		expect(makeScopedSlug("track", "Fitna", "")).toEqual({ ok: false, reason: "empty-artist" });
		expect(makeScopedSlug("track", "Fitna", "  ?! ")).toEqual({ ok: false, reason: "empty-artist" });
	});

	test("returns empty-title instead of throwing, including a title made only of noise", () => {
		expect(makeScopedSlug("project", "", "Rohff")).toEqual({ ok: false, reason: "empty-title" });
		expect(makeScopedSlug("project", "...", "Rohff")).toEqual({ ok: false, reason: "empty-title" });
		expect(makeScopedSlug("project", "(Remastered)", "Rohff")).toEqual({ ok: false, reason: "empty-title" });
	});

	test("reports empty-title first when both parts are empty", () => {
		expect(makeScopedSlug("track", "", "")).toEqual({ ok: false, reason: "empty-title" });
	});
});

describe("isScopedSlug / scopeOf", () => {
	test("recognizes a scoped work slug and returns its scope", () => {
		expect(isScopedSlug("track:fitna--rohff")).toBe(true);
		expect(scopeOf("track:fitna--rohff")).toBe("rohff");
		expect(scopeOf("project:new-forms--roni-size-reprazent")).toBe("roni-size-reprazent");
	});

	test("an unscoped slug has no scope", () => {
		expect(isScopedSlug("track:fitna")).toBe(false);
		expect(scopeOf("track:fitna")).toBeNull();
		expect(isScopedSlug("artist:aphex-twin")).toBe(false);
	});

	test("a hyphenated body is not scoped (single dash is not the separator)", () => {
		expect(isScopedSlug("artist:jay-z")).toBe(false);
		expect(scopeOf("artist:jay-z")).toBeNull();
	});

	test("only project and track slugs carry a scope, whatever their separator", () => {
		expect(scopeOf("artist:pole--stefan-betke")).toBeNull();
		expect(isScopedSlug("artist:pole--stefan-betke")).toBe(false);
		expect(scopeOf("label:warp--sheffield")).toBeNull();
		expect(scopeOf("genre:house--chicago")).toBeNull();
	});

	test("is null for malformed input and empty halves instead of throwing", () => {
		expect(scopeOf("no-colon--x")).toBeNull();
		expect(scopeOf("track:fitna--")).toBeNull();
		expect(scopeOf("track:--rohff")).toBeNull();
		expect(scopeOf("")).toBeNull();
	});

	test("round-trips with makeScopedSlug", () => {
		const r = makeScopedSlug("project", "New Forms", "Roni Size / Reprazent");
		expect(r.ok && scopeOf(r.slug)).toBe("roni-size-reprazent");
	});
});

describe("scopeMatchesArtist", () => {
	test("is true when the scope is the normalized artist name", () => {
		expect(scopeMatchesArtist("track:fitna--rohff", "Rohff")).toBe(true);
		expect(scopeMatchesArtist("project:new-forms--roni-size-reprazent", "Roni Size / Reprazent")).toBe(true);
		expect(scopeMatchesArtist("track:corazon-loco--lisa-carbon", "Lisa Carbón")).toBe(true);
	});

	test("rejects a legacy free-text disambiguator that merely shares the separator", () => {
		expect(scopeMatchesArtist("track:the-model--song-by-kraftwerk", "Kraftwerk")).toBe(false);
	});

	test("is false for another artist, an unscoped slug, a non-work slug and an unnormalizable name", () => {
		expect(scopeMatchesArtist("track:fitna--rohff", "Booba")).toBe(false);
		expect(scopeMatchesArtist("track:fitna", "Rohff")).toBe(false);
		expect(scopeMatchesArtist("artist:pole--stefan-betke", "Stefan Betke")).toBe(false);
		expect(scopeMatchesArtist("track:fitna--rohff", "坂本龍一")).toBe(false);
	});
});

describe("pickScopeArtistName", () => {
	test("returns the first candidate whose normalized body is not empty", () => {
		expect(pickScopeArtistName(["坂本龍一", undefined, "Ryuichi Sakamoto"])).toBe("Ryuichi Sakamoto");
		expect(pickScopeArtistName(["Aphex Twin", "AFX"])).toBe("Aphex Twin");
	});

	test("skips empty and punctuation-only candidates", () => {
		expect(pickScopeArtistName(["", "  ?! ", "Rohff"])).toBe("Rohff");
	});

	test("is null when no candidate has a latin body", () => {
		expect(pickScopeArtistName(["坂本龍一", undefined, ""])).toBeNull();
		expect(pickScopeArtistName([])).toBeNull();
	});
});

// TRA-633, measured 2026-10-24 on the cache: 39 discography titles carry letters or digits that the slug body
// drops, 28 of them in a non-Latin script. No two titles of one artist collide on such a slug today, but the body
// of "二ノ国II ..." is "ii" and that of "20才の頃" is "20": a body like that identifies nothing.
describe("non-Latin titles in a work slug (TRA-633)", () => {
	test("a title made only of non-Latin letters gets no slug, instead of an empty or shared one", () => {
		expect(makeScopedSlug("project", "黄昏", "Junko Ohashi")).toEqual({ ok: false, reason: "empty-title" });
		expect(makeScopedSlug("project", "予約座", "Satoshi Tomiie")).toEqual({
			ok: false,
			reason: "empty-title",
		});
		expect(makeScopedSlug("project", "ガラガラ", "BIGBANG")).toEqual({ ok: false, reason: "empty-title" });
	});

	test("a mixed title keeps only its Latin part: the slug is degenerate, and says so through titleLosesLetters", () => {
		const cases: [string, string][] = [
			["20才の頃", "project:20--junko-ohashi"],
			["予約座003", "project:003--junko-ohashi"],
			["二ノ国II レヴァナントキングダム", "project:ii--junko-ohashi"],
			["ハリウッド・カフェ / 8分音符の詩", "project:8--junko-ohashi"],
		];
		for (const [title, slug] of cases) {
			expect(makeScopedSlug("project", title, "Junko Ohashi")).toEqual({ ok: true, slug });
			expect(titleLosesLetters(title), title).toBe(true);
		}
	});

	test("two different non-Latin parts share a degenerate slug: this is why the policy never keys on one", () => {
		const a = makeScopedSlug("project", "20才の頃", "Junko Ohashi");
		const b = makeScopedSlug("project", "20歳の頃", "Junko Ohashi");
		expect(a).toEqual(b);
	});
});

describe("titleLosesLetters (TRA-633)", () => {
	test("is false for a Latin title, whatever its accents, punctuation or edition noise", () => {
		for (const title of ["Kid A (Deluxe Edition)", "Café Tacvba", "Rock & Roll!", "Bahía Blanca 2000"]) {
			expect(titleLosesLetters(title), title).toBe(false);
		}
	});

	test("is true as soon as one letter or digit of the title is not in the body", () => {
		for (const title of [
			"Ψ 847",
			"Σ = a = b = a + b",
			"BADモード",
			"Benz Truck (гелик)",
			"α-Bet-City",
			"化 pt.1",
		]) {
			expect(titleLosesLetters(title), title).toBe(true);
		}
	});

	test("follows the transliteration flag: 'ø' is lost until the flag is on", () => {
		expect(titleLosesLetters("Ørsted")).toBe(true);
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		try {
			expect(titleLosesLetters("Ørsted")).toBe(false);
			expect(titleLosesLetters("Ψ 847")).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("is false for a title with nothing to lose", () => {
		expect(titleLosesLetters("")).toBe(false);
		expect(titleLosesLetters("...")).toBe(false);
	});
});

// TRA-633 changes how two titles are compared (discography-policy), never what slug a title gets: a different slug
// would move an existing node (redirects, incoming edges, prod) and needs its own migration. These are slugs that
// the cache holds today (read 2026-10-24), non-Latin and partial ones included; titleLosesLetters, the only
// addition to this module, must leave every one of them as it is.
describe("slugs of existing cache entries stay frozen (TRA-633)", () => {
	const scoped: [string, string, string][] = [
		["A Song for ××", "Ayumi Hamasaki", "project:a-song-for--ayumi-hamasaki"],
		["봄여름가을겨울 (Still Life)", "BIGBANG", "project:still-life--bigbang"],
		["ガラガラ GO!!", "BIGBANG", "project:go--bigbang"],
		["화양연화 pt.1", "BTS", "project:pt-1--bts"],
		["Ψ 847", "Éliane Radigue", "project:847--eliane-radigue"],
		["拝啓 / A Message for You", "Eriko Toyoda", "project:a-message-for-you--eriko-toyoda"],
		["BADモード", "Hikaru Utada", "project:bad--hikaru-utada"],
		[
			"二ノ国II レヴァナントキングダム オリジナルサウンドトラック",
			"Joe Hisaishi",
			"project:ii--joe-hisaishi",
		],
		["20才の頃", "Junko Ōhashi", "project:20--junko-ohashi"],
		["ハリウッド・カフェ / 8分音符の詩", "Mariya Takeuchi", "project:8--mariya-takeuchi"],
		["予約座003", "Satoshi Tomiie", "project:003--satoshi-tomiie"],
		["高気圧ガール／DARLIN'", "Tatsurō Yamashita", "project:darlin--tatsuro-yamashita"],
		["12 × 5", "The Rolling Stones", "project:12-5--the-rolling-stones"],
		["hα†ε ïš dεαd", "Trippie Redd", "project:h-is-d-d--trippie-redd"],
		[
			"Venetian Snares × Daniel Lanois",
			"Venetian Snares",
			"project:venetian-snares-daniel-lanois--venetian-snares",
		],
		["800% Ndagga", "Mark Ernestus", "project:800-ndagga--mark-ernestus"],
		[
			"Wari Vo Dubwise / Danna Dubwise",
			"Mark Ernestus",
			"project:wari-vo-dubwise-danna-dubwise--mark-ernestus",
		],
		[
			"Avalon Sutra / As Long As I Can Hold My Breath",
			"Harold Budd",
			"project:avalon-sutra-as-long-as-i-can-hold-my-breath--harold-budd",
		],
		[
			"Hailu Mergia & His Classical Instrument",
			"Hailu Mergia",
			"project:hailu-mergia-and-his-classical-instrument--hailu-mergia",
		],
	];
	const legacy: [string, string][] = [
		["800% Ndagga (album)", "project:800-ndagga"],
		["Basic Channel (album)", "project:basic-channel"],
		["Rhythm & Sound (album)", "project:rhythm-and-sound"],
		["Benz Truck (гелик)", "project:benz-truck"],
		["Wake Up!", "project:wake-up"],
	];

	test.each(scoped)("makeScopedSlug('project', %j, %j) is still %s", (title, artist, slug) => {
		expect(makeScopedSlug("project", title, artist)).toEqual({ ok: true, slug });
	});

	test.each(legacy)("makeSlug('project', %j) is still %s", (name, slug) => {
		expect(makeSlug("project", name)).toBe(slug);
	});
});
