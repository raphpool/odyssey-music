import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	findCollisions,
	type IdentityManifest,
	onlyAddsSchemaDefaults,
	parseCliArgs,
	type ResolvedArtist,
	runBackfill,
	withIdentity,
} from "../scripts/migrations/2026-10-15-backfill-artist-identity.js";
import { fetchArtistProfileMb, resolveArtist, resolveArtistDetailed } from "../src/musicbrainz.js";
import { nodePayloadSchema } from "../src/schemas.js";
import type { ArtistNode } from "../src/types.js";

/** An artist as stored on disk: no node has `similar_artists` (TRA-456) until it is rewritten. */
type StoredArtist = Omit<ArtistNode, "similar_artists">;

// The three MusicBrainz entry points the migration uses stay real (they run against the fake below);
// they are spied on only so tests can count what the migration asks for. mbFetch memoizes by URL for
// the whole file, so counting fetch calls would hide requests.
vi.mock("../src/musicbrainz.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/musicbrainz.js")>();
	return {
		...actual,
		resolveArtistDetailed: vi.fn(actual.resolveArtistDetailed),
		fetchArtistProfileMb: vi.fn(actual.fetchArtistProfileMb),
	};
});

// --- A fake MusicBrainz, behind fetch (the external boundary) ---

interface FakeArtist {
	id: string;
	name: string;
	type?: string;
	score?: number;
	disambiguation?: string;
	area?: string;
	/** MB's area type; "Country" areas never separate homonyms (TRA-508). Defaults to "City". */
	areaType?: string;
	beginArea?: string;
	beginAreaType?: string;
	aliases?: string[];
	/** Asking for this (merged-away) MBID answers with the artist under its live `id`. */
	mergedFrom?: string;
	/** [direction, type, mbid, name] */
	relations?: [string, string, string, string][];
}

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

/**
 * Answers MB's artist search (names and aliases containing the phrase) and the `?inc=artist-rels`
 * lookup from `artists`; collects every requested URL. `down` makes every request fail.
 * Note mbFetch memoizes by URL for the whole file: each test uses names and MBIDs of its own.
 */
function stubMb(
	artists: FakeArtist[],
	options: {
		down?: string[];
		badGateway?: string[];
		/** The `count` MB reports for a search, when larger than the artists the fake holds. */
		count?: number;
		/** Search offsets (as MB gets them) that answer with a failure. */
		failOffsets?: number[];
	} = {},
): URL[] {
	const urls: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			urls.push(input);
			const [, , , kind, id] = input.pathname.split("/");
			if (kind !== "artist")
				return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
			if (id) {
				const artist = artists.find((a) => a.id === id || a.mergedFrom === id);
				if (!artist || options.down?.includes(id)) {
					return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
				}
				if (options.badGateway?.includes(id)) {
					return { ok: false, status: 502, headers: new Headers(), json: async () => ({}) } as Response;
				}
				return jsonResponse({
					id: artist.id,
					name: artist.name,
					...(artist.type ? { type: artist.type } : {}),
					...(artist.disambiguation ? { disambiguation: artist.disambiguation } : {}),
					...(artist.area ? { area: { name: artist.area } } : {}),
					relations: (artist.relations ?? []).map(([direction, type, mbid, name]) => ({
						direction,
						type,
						artist: { id: mbid, name },
					})),
				});
			}
			// Like MB: `artist:` matches canonical names, `alias:` matches aliases.
			const [, field = "artist", phrase = ""] =
				/^(artist|alias):"(.*)"$/.exec(input.searchParams.get("query") ?? "") ?? [];
			const indexed = (a: FakeArtist) => (field === "alias" ? (a.aliases ?? []) : [a.name]);
			const matching = artists.filter((a) =>
				indexed(a).some((n) => n.toLowerCase().includes(phrase.toLowerCase())),
			);
			const limit = Number(input.searchParams.get("limit") ?? "25");
			const offset = Number(input.searchParams.get("offset") ?? "0");
			if (options.failOffsets?.includes(offset))
				return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) } as Response;
			return jsonResponse({
				count: field === "artist" ? Math.max(options.count ?? 0, matching.length) : matching.length,
				offset,
				artists: matching.slice(offset, offset + limit).map((a) => ({
					id: a.id,
					name: a.name,
					score: a.score ?? 100,
					...(a.type ? { type: a.type } : {}),
					...(a.disambiguation ? { disambiguation: a.disambiguation } : {}),
					...(a.area ? { area: { name: a.area, type: a.areaType ?? "City" } } : {}),
					...(a.beginArea ? { "begin-area": { name: a.beginArea, type: a.beginAreaType ?? "City" } } : {}),
					...(a.aliases ? { aliases: a.aliases.map((name) => ({ name })) } : {}),
				})),
			});
		}),
	);
	return urls;
}

/** How many artists the migration sent to MusicBrainz: searches and profile lookups. */
const calls = () => ({
	searches: vi.mocked(resolveArtistDetailed).mock.calls.length,
	profiles: vi.mocked(fetchArtistProfileMb).mock.calls.length,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// --- resolveArtist ---

describe("resolveArtist", () => {
	it("returns the exact-name artist, not a higher-ranked near-name", async () => {
		stubMb([
			{ id: "a1a1a1a1-0000-4000-8000-000000000001", name: "Ibex Position", type: "Group" },
			{
				id: "a1a1a1a1-0000-4000-8000-000000000002",
				name: "Ibex",
				type: "Person",
				disambiguation: "German producer",
				area: "Germany",
			},
		]);
		expect(await resolveArtist("Ibex")).toEqual({
			mbid: "a1a1a1a1-0000-4000-8000-000000000002",
			name: "Ibex",
			kind: "person",
			disambiguation: "German producer",
			area: "Germany",
		});
	});

	it("takes an exact name whatever its search score: the right 'Earth' scores 89", async () => {
		stubMb([
			{
				id: "a2a2a2a2-0000-4000-8000-000000000001",
				name: "Earthen",
				score: 100,
				disambiguation: "US experimental metal/rock group",
			},
			{
				id: "a2a2a2a2-0000-4000-8000-000000000002",
				name: "Earthen",
				score: 89,
				type: "Group",
				disambiguation: "US experimental metal/rock group",
				area: "Seattle",
				beginArea: "Olympia",
			},
		]);
		// Two exact homonyms (100 and 89): the begin-area Olympia makes the 89 one the better fit.
		expect((await resolveArtist("Earthen", { origin: "Olympia, Washington, U.S." }))?.mbid).toBe(
			"a2a2a2a2-0000-4000-8000-000000000002",
		);

		stubMb([
			{
				id: "a2a2a2a2-0000-4000-8000-000000000003",
				name: "Earth Alone",
				score: 89,
				type: "Group",
				disambiguation: "US experimental metal/rock group",
				area: "Seattle",
				beginArea: "Olympia",
			},
			{ id: "a2a2a2a2-0000-4000-8000-000000000004", name: "Earth Alone Band", score: 100 },
		]);
		const out = await resolveArtist("Earth Alone", { origin: "Olympia, Washington, U.S." });
		expect(out?.mbid).toBe("a2a2a2a2-0000-4000-8000-000000000003");
	});

	it("is null with the candidate count when two exact homonyms cannot be told apart", async () => {
		stubMb([
			{ id: "a3a3a3a3-0000-4000-8000-000000000001", name: "Homonym", disambiguation: "UK band" },
			{ id: "a3a3a3a3-0000-4000-8000-000000000002", name: "Homonym", disambiguation: "US singer" },
		]);
		expect(await resolveArtistDetailed("Homonym")).toEqual({
			artist: null,
			candidates: 2,
			path: "name",
			unavailable: false,
			matchedWords: [],
		});
		// A hint that matches neither is no hint.
		expect(await resolveArtist("Homonym", { origin: "Reykjavik, Iceland" })).toBeNull();
	});

	it("separates homonyms by the city in MB's area, not by MB's disambiguation (TRA-508)", async () => {
		stubMb([
			{
				id: "a4a4a4a4-0000-4000-8000-000000000001",
				name: "Prismic",
				disambiguation: "noise producer",
				area: "Tokyo",
			},
			{
				id: "a4a4a4a4-0000-4000-8000-000000000002",
				name: "Prismic",
				disambiguation: "rock band",
				area: "Canada",
			},
		]);
		expect((await resolveArtist("Prismic", { origin: "Tokyo, Japan" }))?.mbid).toBe(
			"a4a4a4a4-0000-4000-8000-000000000001",
		);
		// "rock band" is in the disambiguation of the second one only, which no longer separates them.
		expect(await resolveArtist("Prismic", { disambiguator: "Canadian rock band" })).toBeNull();
		expect(await resolveArtist("Prismic", { disambiguator: "noise producer from Tokyo" })).toBeNull();
	});

	// TRA-506, reproduced on 2026-10-15 against the real MB: the real Aphex Twin (area London, begin-area
	// Limerick, no disambiguation) has no country word in its context, the impostor "UK experimental
	// electronic artist" has one, so "Cornwall, England" made the impostor win on "gbr" alone.
	describe("a country token never separates homonyms (TRA-506)", () => {
		const real = "f22942a1-0000-4000-8000-000000000001";
		const impostor = "65016d2c-0000-4000-8000-000000000001";
		const aphex: FakeArtist[] = [
			{ id: real, name: "Aphex Twin", type: "Person", area: "London", beginArea: "Limerick" },
			{
				id: impostor,
				name: "Aphex Twin",
				type: "Person",
				disambiguation: "UK experimental electronic artist",
			},
		];

		it("leaves Aphex Twin unresolved when only the country distinguishes the candidates", async () => {
			stubMb(aphex);
			expect(await resolveArtistDetailed("Aphex Twin", { origin: "Cornwall, England" })).toEqual({
				artist: null,
				candidates: 2,
				path: "name",
				unavailable: false,
				matchedWords: [],
			});
		});

		it("does not let a demonym or a country name decide either", async () => {
			stubMb(aphex);
			expect(await resolveArtist("Aphex Twin", { origin: "Cornwall, United Kingdom" })).toBeNull();
			expect(await resolveArtist("Aphex Twin", { disambiguator: "British" })).toBeNull();
		});

		// TRA-508 F3: "electronic" is in the impostor's disambiguation, not in any place: a generic word of
		// a free-text `disambiguator` (JIT nodes persist one) says nothing about which artist is meant.
		it("does not let a generic word of the node's disambiguator decide (electronic musician)", async () => {
			stubMb(aphex);
			expect(await resolveArtistDetailed("Aphex Twin", { disambiguator: "electronic musician" })).toEqual({
				artist: null,
				candidates: 2,
				path: "name",
				unavailable: false,
				matchedWords: [],
			});
			expect(
				await resolveArtist("Aphex Twin", {
					disambiguator: "electronic musician",
					origin: "Cornwall, England",
				}),
			).toBeNull();
		});

		it("resolves on the candidate sharing the city of the hint (Leeds)", async () => {
			const leeds = "b1b1b1b1-0000-4000-8000-000000000001";
			stubMb([
				{ id: leeds, name: "Leedsish", area: "Leeds", disambiguation: "post-punk band" },
				{
					id: "b1b1b1b1-0000-4000-8000-000000000002",
					name: "Leedsish",
					area: "United Kingdom",
					areaType: "Country",
				},
			]);
			expect((await resolveArtist("Leedsish", { origin: "Leeds, England" }))?.mbid).toBe(leeds);
			expect(await resolveArtistDetailed("Leedsish", { origin: "Leeds, England" })).toMatchObject({
				matchedWords: ["leeds"],
			});
		});

		it("lets the city win even when the other candidate also shares the country", async () => {
			const leeds = "b2b2b2b2-0000-4000-8000-000000000001";
			stubMb([
				{ id: leeds, name: "Leedsish Two", area: "Leeds", disambiguation: "band" },
				{ id: "b2b2b2b2-0000-4000-8000-000000000002", name: "Leedsish Two", disambiguation: "UK band" },
			]);
			expect((await resolveArtist("Leedsish Two", { origin: "Leeds, England" }))?.mbid).toBe(leeds);
		});

		it("still uses a country to refuse a lone candidate it contradicts", async () => {
			stubMb([
				{
					id: "b3b3b3b3-0000-4000-8000-000000000001",
					name: "Lone Test",
					area: "France",
					areaType: "Country",
				},
			]);
			expect(await resolveArtist("Lone Test", { origin: "Leeds, England" })).toBeNull();
		});
	});

	// TRA-508 F1: the search used to read 25 results and never look at `count`, so a sole exact homonym
	// in the first page was taken for the only one. Real case: "Guy", count 1602, one exact "Guy" in the
	// first 25, accepted on "usa" alone; seven exact ones in the first 500.
	describe("a pool read in full, or a strict tiebreak (TRA-508 F1)", () => {
		const mbid = (prefix: string, n: number) =>
			`${prefix}${n.toString(16).padStart(7, "0")}-0000-4000-8000-000000000f00`;
		/** `n` artists whose name contains `name` without being it: they fill the pages, they are not homonyms. */
		const crowd = (prefix: string, name: string, n: number): FakeArtist[] =>
			Array.from({ length: n }, (_, i) => ({ id: mbid(prefix, i), name: `${name} Filler ${i}` }));
		/** Offsets of the `artist:` search pages requested (the `alias:` search is a separate one). */
		const offsets = (urls: URL[]) =>
			urls
				.filter((u) => u.pathname.endsWith("/artist") && u.searchParams.get("query")?.startsWith("artist:"))
				.map((u) => u.searchParams.get("offset"));

		it("leaves the artist unresolved when an exact homonym sits on page 2 (Guy)", async () => {
			const guy = (id: string, area: string, areaType: string): FakeArtist => ({
				id,
				name: "Guyone",
				area,
				areaType,
			});
			const urls = stubMb([
				...crowd("a0", "Guyone", 40),
				guy("a1a1a1a1-0000-4000-8000-000000000f01", "United States", "Country"),
				...crowd("a2", "Guyone", 59),
				// The 101st result: page 2.
				guy("a1a1a1a1-0000-4000-8000-000000000f02", "Texas", "Subdivision"),
			]);
			const out = await resolveArtistDetailed("Guyone", { origin: "Dallas, USA" });
			expect(out).toMatchObject({ artist: null, candidates: 2, unavailable: false });
			expect(offsets(urls)).toEqual(["0", "100"]);
			expect(urls[0]?.searchParams.get("limit")).toBe("100");
		});

		it("does not accept a lone exact homonym on a country when MB holds more results than it returned", async () => {
			const lone: FakeArtist = {
				id: "a3a3a3a3-0000-4000-8000-000000000f01",
				name: "Guytwo",
				area: "United States",
				areaType: "Country",
			};
			const urls = stubMb([...crowd("a4", "Guytwo", 250), lone, ...crowd("a5", "Guytwo", 249)], {
				count: 1602,
			});
			const out = await resolveArtistDetailed("Guytwo", { origin: "Dallas, USA" });
			expect(out).toMatchObject({ artist: null, candidates: 1 });
			// MB caps the offset: 5 pages of 100, never offset=500 (HTTP 400).
			expect(offsets(urls)).toEqual(["0", "100", "200", "300", "400"]);
		});

		it("accepts that lone homonym when its city is the node's city, even from a partial pool", async () => {
			const lone: FakeArtist = {
				id: "a6a6a6a6-0000-4000-8000-000000000f01",
				name: "Guythree",
				area: "United States",
				areaType: "Country",
				beginArea: "Dallas",
			};
			stubMb([...crowd("a7", "Guythree", 250), lone, ...crowd("a8", "Guythree", 249)], { count: 1602 });
			const out = await resolveArtistDetailed("Guythree", { origin: "Dallas, USA" });
			expect(out.artist?.mbid).toBe(lone.id);
			expect(out.matchedWords).toEqual(["dallas"]);
		});

		it("keeps accepting a lone homonym when the pool is complete and nothing contradicts it", async () => {
			const lone: FakeArtist = {
				id: "a9a9a9a9-0000-4000-8000-000000000f01",
				name: "Guyfour",
				area: "United States",
				areaType: "Country",
			};
			stubMb([lone]);
			const out = await resolveArtistDetailed("Guyfour", { origin: "Dallas, USA" });
			expect(out.artist?.mbid).toBe(lone.id);
			expect(out.matchedWords).toEqual(["usa"]);
		});

		it("does not let a complete alias pool hide that the name search left results unread", async () => {
			const alias = (id: string, extra: Partial<FakeArtist>): FakeArtist => ({
				id,
				name: "Someone Real",
				aliases: ["Aliasfoo"],
				...extra,
			});
			stubMb([...crowd("ae", "Aliasfoo", 500), alias("afafafaf-0000-4000-8000-000000000f01", {})], {
				count: 600,
			});
			expect(await resolveArtistDetailed("Aliasfoo", { origin: "Dallas, USA" })).toMatchObject({
				artist: null,
				path: "alias",
				candidates: 1,
			});
			stubMb(
				[
					...crowd("b0", "Aliasbar", 500),
					alias("b1b1b1b1-0000-4000-8000-000000000f01", { aliases: ["Aliasbar"], beginArea: "Dallas" }),
				],
				{ count: 600 },
			);
			expect((await resolveArtistDetailed("Aliasbar", { origin: "Dallas, USA" })).matchedWords).toEqual([
				"dallas",
			]);
		});

		it("stops paging at the count: 250 results are 3 requests", async () => {
			const urls = stubMb(crowd("aa", "Guyfive", 250));
			expect(await resolveArtistDetailed("Guyfive")).toMatchObject({ artist: null, candidates: 0 });
			expect(offsets(urls)).toEqual(["0", "100", "200"]);
		});

		it("reads a failed later page as MB being unavailable, not as a smaller pool", async () => {
			const lone: FakeArtist = { id: "abababab-0000-4000-8000-000000000f01", name: "Guysix", area: "Dallas" };
			stubMb([lone, ...crowd("ac", "Guysix", 149)], { failOffsets: [100] });
			expect(await resolveArtistDetailed("Guysix")).toMatchObject({ artist: null, unavailable: true });
		});

		it("treats a search answer without a count as unusable", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({ artists: [{ id: "adadadad-0000-4000-8000-000000000f01", name: "Nocount" }] }),
				),
			);
			expect(await resolveArtistDetailed("Nocount")).toMatchObject({ artist: null, unavailable: true });
		});
	});

	// TRA-508 F2: only MB's `Country` areas are ignored, whatever the country (no list to keep up to date).
	describe("an MB area of type Country never separates homonyms (TRA-508 F2)", () => {
		it.each([
			["Kazakhstan", "Kazbek", "Almaty, Kazakhstan"],
			["Georgia", "Tbilisian", "Atlanta, Georgia"],
			["Czech Republic", "Moravian", "Brno, Czech Republic"],
			["Congo", "Kongoan", "Kinshasa, Congo"],
			["Puerto Rico", "Boricua", "San Juan, Puerto Rico"],
		])("%s: the impostor sharing only the country is not chosen", async (country, name, origin) => {
			const id = (n: number) =>
				`c${n}c${n}c${n}c${n}-0000-4000-8000-${name.length.toString(16).padStart(12, "0")}`;
			stubMb([
				{ id: id(1), name, type: "Group" },
				{
					id: id(3),
					name,
					type: "Group",
					area: country,
					areaType: "Country",
				},
			]);
			expect(await resolveArtistDetailed(name, { origin })).toMatchObject({ artist: null, candidates: 2 });
		});

		it("still lets the city decide when the impostor's area is the country", async () => {
			const real = "c4c4c4c4-0000-4000-8000-000000000f01";
			stubMb([
				{
					id: real,
					name: "Peachtree Test",
					beginArea: "Atlanta",
					area: "United States",
					areaType: "Country",
				},
				{
					id: "c4c4c4c4-0000-4000-8000-000000000f02",
					name: "Peachtree Test",
					area: "Georgia",
					areaType: "Country",
				},
			]);
			const out = await resolveArtistDetailed("Peachtree Test", { origin: "Atlanta, Georgia" });
			expect(out.artist?.mbid).toBe(real);
			expect(out.matchedWords).toEqual(["atlanta"]);
		});

		it("does count a Georgia that is not a country (a US state)", async () => {
			const state = "c5c5c5c5-0000-4000-8000-000000000f01";
			stubMb([
				{ id: state, name: "Peach State Test", area: "Georgia", areaType: "Subdivision" },
				{ id: "c5c5c5c5-0000-4000-8000-000000000f02", name: "Peach State Test", area: "Tbilisi" },
			]);
			expect((await resolveArtist("Peach State Test", { origin: "Atlanta, Georgia" }))?.mbid).toBe(state);
		});

		it("does not use an area whose type MB does not give", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({
						count: 2,
						artists: [
							{ id: "c6c6c6c6-0000-4000-8000-000000000f01", name: "Untyped Test", area: { name: "Leeds" } },
							{ id: "c6c6c6c6-0000-4000-8000-000000000f02", name: "Untyped Test" },
						],
					}),
				),
			);
			expect(await resolveArtist("Untyped Test", { origin: "Leeds, England" })).toBeNull();
		});
	});

	it("still lets a node's own disambiguator refuse a lone candidate it contradicts", async () => {
		stubMb([
			{
				id: "c7c7c7c7-0000-4000-8000-000000000f01",
				name: "Lone Disamb",
				disambiguation: "French rapper",
			},
		]);
		expect(await resolveArtist("Lone Disamb", { disambiguator: "British drummer" })).toBeNull();
		expect((await resolveArtist("Lone Disamb", { disambiguator: "rapper from Paris" }))?.mbid).toBe(
			"c7c7c7c7-0000-4000-8000-000000000f01",
		);
	});

	it("is null when the hints fit both homonyms equally", async () => {
		stubMb([
			{ id: "a5a5a5a5-0000-4000-8000-000000000001", name: "Twinned", area: "Japan" },
			{ id: "a5a5a5a5-0000-4000-8000-000000000002", name: "Twinned", area: "Japan" },
		]);
		expect(await resolveArtist("Twinned", { origin: "Japan" })).toBeNull();
	});

	// Both reproduced against the real cache on 2026-10-15 (TRA-463 review): a sole exact-name hit was
	// accepted though MB's context contradicted the node.
	it("refuses a sole candidate whose MB context shares nothing with the node's hints (113)", async () => {
		stubMb([
			{
				id: "a9a9a9a9-0000-4000-8000-000000000001",
				name: "113 Leeds",
				type: "Group",
				disambiguation: "French hip hop group",
				area: "France",
			},
		]);
		expect(await resolveArtistDetailed("113 Leeds", { origin: "Leeds, England" })).toMatchObject({
			artist: null,
			candidates: 1,
		});
		// Same candidate, a node that says nothing: nothing contradicts it.
		expect((await resolveArtist("113 Leeds"))?.mbid).toBe("a9a9a9a9-0000-4000-8000-000000000001");
	});

	it("leaves an artist with many exact homonyms unresolved when the hints fit several (Jaguar)", async () => {
		const jaguar = (n: number, extra: Partial<FakeArtist>): FakeArtist => ({
			id: `aaaaaaa${n}-0000-4000-8000-000000000001`,
			name: "Jaguar Bingham Test",
			...extra,
		});
		stubMb([
			jaguar(1, {
				type: "Group",
				score: 100,
				disambiguation: "80s UK heavy metal band",
				area: "United Kingdom",
			}),
			jaguar(2, { type: "Person", score: 90, disambiguation: "German techno producer", area: "Germany" }),
			jaguar(3, {
				type: "Person",
				score: 88,
				disambiguation: "UK breakbeat producer",
				area: "United Kingdom",
			}),
			jaguar(4, { type: "Person", score: 87, disambiguation: "UK DJ", area: "London" }),
		]);
		const out = await resolveArtistDetailed("Jaguar Bingham Test", { origin: "United Kingdom" });
		expect(out).toMatchObject({ artist: null, candidates: 4 });
	});

	it("folds country spellings so an obvious match is not lost", async () => {
		const only = (n: number, area: string, disambiguation: string): FakeArtist => ({
			id: `bbbbbbb${n}-0000-4000-8000-000000000001`,
			name: `Folded ${n}`,
			area,
			disambiguation,
		});
		stubMb([
			only(1, "Türkiye", "Turkish producer"),
			only(2, "United Kingdom", "producer"),
			only(3, "United States", "producer"),
			only(4, "Germany", "German IDM producer"),
			only(5, "United States", "producer"),
		]);
		expect(await resolveArtist("Folded 1", { origin: "Istanbul, Turkey" })).not.toBeNull();
		expect(await resolveArtist("Folded 2", { origin: "Leeds, England" })).not.toBeNull();
		expect(await resolveArtist("Folded 3", { origin: "Detroit, Michigan, U.S." })).not.toBeNull();
		expect(await resolveArtist("Folded 4", { origin: "Düsseldorf, Germany" })).not.toBeNull();
		// "United Kingdom" and "United States" share the word "united" and nothing else.
		expect(await resolveArtist("Folded 5", { origin: "London, United Kingdom" })).toBeNull();
	});

	it("matches a Latin name to an original-script artist through its alias (a Japanese one)", async () => {
		stubMb([
			{
				id: "a6a6a6a6-0000-4000-8000-000000000001",
				name: "坂本龍一",
				type: "Person",
				disambiguation: "Japanese composer, pianist",
				area: "Japan",
				aliases: ["Ryuichi Sakamotoh"],
			},
		]);
		const out = await resolveArtistDetailed("Ryuichi Sakamotoh", { origin: "Tokyo, Japan" });
		expect(out.artist?.name).toBe("坂本龍一");
		expect(out.artist?.kind).toBe("person");
		expect(out.path).toBe("alias");
	});

	it("uses aliases only when no canonical name matches, whatever the canonical match scores", async () => {
		stubMb([
			{ id: "a6a6a6a6-0000-4000-8000-000000000002", name: "Someone Else", aliases: ["Aliasonly"] },
			{ id: "a6a6a6a6-0000-4000-8000-000000000003", name: "Aliasonly", score: 50 },
		]);
		const out = await resolveArtistDetailed("Aliasonly");
		expect(out.artist?.mbid).toBe("a6a6a6a6-0000-4000-8000-000000000003");
		expect(out.path).toBe("name");
	});

	it("never equates names that normalize to the same Latin remainder across scripts", async () => {
		stubMb([{ id: "a7a7a7a7-0000-4000-8000-000000000001", name: "Группа Zyx" }]);
		expect(await resolveArtist("Rock Zyx")).toBeNull();
		expect(await resolveArtist("Группа Zyx")).not.toBeNull();
		// "ø" has no accent decomposition: slug normalization would turn "Mø" into "m".
		stubMb([{ id: "a7a7a7a7-0000-4000-8000-000000000002", name: "Mq" }]);
		expect(await resolveArtist("Mø")).toBeNull();
	});

	it("is null on a network failure and on a name with nothing to search", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		expect(await resolveArtistDetailed("Unreachable Act")).toEqual({
			artist: null,
			candidates: 0,
			path: null,
			unavailable: true,
			matchedWords: [],
		});
		const urls = stubMb([]);
		expect(await resolveArtist('"\\')).toBeNull();
		expect(urls).toHaveLength(0);
	});

	it("skips special-purpose artists and malformed entries one by one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					count: 3,
					artists: [
						{ id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists", score: 100 },
						{ id: "not-an-mbid", name: "Brokenid", score: 100 },
						{ id: "a8a8a8a8-0000-4000-8000-000000000001", name: "Brokenid", score: 100 },
					],
				}),
			),
		);
		expect((await resolveArtist("Brokenid"))?.mbid).toBe("a8a8a8a8-0000-4000-8000-000000000001");
		expect(await resolveArtist("Various Artists")).toBeNull();
	});
});

describe("fetchArtistProfileMb", () => {
	it("returns identity and bands from one request, and the live MBID after a merge", async () => {
		const urls = stubMb([
			{
				id: "ababab01-0000-4000-8000-000000000001",
				mergedFrom: "ababab01-0000-4000-8000-000000000009",
				name: "Merged Away",
				type: "Group",
				disambiguation: "d",
				area: "Japan",
				relations: [["forward", "member of band", "ababab01-0000-4000-8000-000000000002", "A Group"]],
			},
		]);
		const out = await fetchArtistProfileMb("ababab01-0000-4000-8000-000000000009");
		expect(out).toEqual({
			mbid: "ababab01-0000-4000-8000-000000000001",
			name: "Merged Away",
			kind: "group",
			disambiguation: "d",
			area: "Japan",
			groups: [{ mbid: "ababab01-0000-4000-8000-000000000002", name: "A Group" }],
		});
		expect(urls).toHaveLength(1);
	});

	it("is null, not an empty profile, on a failed or unusable answer and on a non-MBID", async () => {
		const urls = stubMb([{ id: "ababab02-0000-4000-8000-000000000001", name: "Down" }], {
			badGateway: ["ababab02-0000-4000-8000-000000000001"],
		});
		expect(await fetchArtistProfileMb("ababab02-0000-4000-8000-000000000001")).toBeNull();
		expect(await fetchArtistProfileMb("../label/x")).toBeNull();
		expect(urls.every((u) => u.pathname.endsWith("ababab02-0000-4000-8000-000000000001"))).toBe(true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ id: "ababab02-0000-4000-8000-000000000002", name: "No Relations" })),
		);
		expect(await fetchArtistProfileMb("ababab02-0000-4000-8000-000000000002")).toBeNull();
	});
});

// --- The migration ---

function artistNode(slug: string, overrides: Record<string, unknown> = {}): StoredArtist {
	const body = slug.replace(/^artist:/, "");
	return {
		type: "artist",
		slug,
		name: body,
		editorial_bio: "A test artist bio.",
		editorial_article: "A real long article about the test artist. ".repeat(4),
		citations: [{ url: "https://example.com/artist", title: "Artist" }],
		materialized_at: "2026-10-01T00:00:00.000Z",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		...overrides,
	} as StoredArtist;
}

let root: string;
let manifestPath: string;

beforeEach(async () => {
	vi.mocked(resolveArtistDetailed).mockClear();
	vi.mocked(fetchArtistProfileMb).mockClear();
	root = await mkdtemp(join(tmpdir(), "artist-identity-"));
	manifestPath = join(root, "out", "artist-identity.json");
	await mkdir(join(root, "cache", "nodes", "artist"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const cacheDir = () => join(root, "cache");
const nodePath = (slug: string) =>
	join(cacheDir(), "nodes", "artist", `${slug.replace(/^artist:/, "")}.json`);

async function seed(node: StoredArtist): Promise<void> {
	await writeFile(nodePath(node.slug), `${JSON.stringify(node, null, 2)}\n`, "utf8");
}

async function readNode(slug: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(nodePath(slug), "utf8")) as Record<string, unknown>;
}

async function readManifestFile(): Promise<IdentityManifest> {
	return JSON.parse(await readFile(manifestPath, "utf8")) as IdentityManifest;
}

const run = (options: Partial<Parameters<typeof runBackfill>[0]> = {}) =>
	runBackfill({ cacheDir: cacheDir(), apply: false, manifestPath, ...options });

describe("runBackfill", () => {
	const POLE = "b1b1b1b1-0000-4000-8000-000000000001";
	const RONI = "b2b2b2b2-0000-4000-8000-000000000001";
	const REPRAZENT = "b2b2b2b2-0000-4000-8000-000000000002";

	it("reports two slugs resolved on one MBID as a collision and changes only mbid / artist_kind", async () => {
		stubMb([
			{
				id: POLE,
				name: "Pole",
				type: "Person",
				disambiguation: "German IDM/electronic producer/mastering Stefan Betke",
				area: "Germany",
				beginArea: "Düsseldorf",
			},
		]);
		const a = artistNode("artist:pole", { name: "Pole", origin: "Düsseldorf, Germany" });
		const b = artistNode("artist:pole--stefan-betke", { name: "Pole", disambiguator: "Stefan Betke" });
		await seed(a);
		await seed(b);

		const result = await run({ apply: true });

		expect(result.exitCode).toBe(0);
		expect(result.manifest.collisions).toEqual([
			{ mbid: POLE, slugs: ["artist:pole", "artist:pole--stefan-betke"] },
		]);
		// Validation adds the schema's default `similar_artists: []`, nothing else.
		expect(await readNode(a.slug)).toEqual({ ...a, mbid: POLE, artist_kind: "person", similar_artists: [] });
		expect(await readNode(b.slug)).toEqual({ ...b, mbid: POLE, artist_kind: "person", similar_artists: [] });
		expect(await readManifestFile()).toEqual({ ...result.manifest });
	});

	it("records the person kind and the bands of Roni Size, and leaves an ambiguous artist intact", async () => {
		stubMb([
			{
				id: RONI,
				name: "Roni Size",
				type: "Person",
				relations: [
					["forward", "member of band", REPRAZENT, "Roni Size / Reprazent"],
					["forward", "collaboration", "b2b2b2b2-0000-4000-8000-000000000003", "Not A Band"],
				],
			},
			{ id: "b3b3b3b3-0000-4000-8000-000000000001", name: "Dupe", disambiguation: "UK band" },
			{ id: "b3b3b3b3-0000-4000-8000-000000000002", name: "Dupe", disambiguation: "US singer" },
		]);
		const roni = artistNode("artist:roni-size", { name: "Roni Size" });
		const dupe = artistNode("artist:dupe", { name: "Dupe" });
		await seed(roni);
		await seed(dupe);
		const dupeBefore = await readFile(nodePath(dupe.slug), "utf8");

		const result = await run({ apply: true });

		expect(result.manifest.resolved["artist:roni-size"]).toEqual({
			mbid: RONI,
			kind: "person",
			groups: [{ mbid: REPRAZENT, name: "Roni Size / Reprazent" }],
			mb_name: "Roni Size",
			disambiguation: null,
			area: null,
			path: "name",
			homonyms_discarded: 0,
			matched_words: [],
		});
		expect((await readNode(roni.slug)).artist_kind).toBe("person");
		expect(result.manifest.unresolved).toEqual([{ slug: "artist:dupe", name: "Dupe", candidates: 2 }]);
		expect(result.manifest.resolved["artist:dupe"]).toBeUndefined();
		expect(await readFile(nodePath(dupe.slug), "utf8")).toBe(dupeBefore);
		expect(result.exitCode).toBe(0);
	});

	it("dry-run writes the manifest and no node; --apply twice writes nothing the second time", async () => {
		stubMb([{ id: "b4b4b4b4-0000-4000-8000-000000000001", name: "Idem", type: "Group" }]);
		await seed(artistNode("artist:idem", { name: "Idem" }));
		const before = await readFile(nodePath("artist:idem"), "utf8");

		const dry = await run();
		expect(dry.written).toEqual([]);
		expect(await readFile(nodePath("artist:idem"), "utf8")).toBe(before);
		expect((await readManifestFile()).resolved["artist:idem"]?.kind).toBe("group");

		const first = await run({ apply: true });
		expect(first.written).toEqual([nodePath("artist:idem")]);
		const afterFirst = await readFile(nodePath("artist:idem"), "utf8");
		const mtime = (await stat(nodePath("artist:idem"))).mtimeMs;

		const second = await run({ apply: true });
		expect(second.written).toEqual([]);
		expect(await readFile(nodePath("artist:idem"), "utf8")).toBe(afterFirst);
		expect((await stat(nodePath("artist:idem"))).mtimeMs).toBe(mtime);
		expect(nodePayloadSchema.parse(await readNode("artist:idem"))).toMatchObject({
			mbid: "b4b4b4b4-0000-4000-8000-000000000001",
			artist_kind: "group",
		});
	});

	it("only writes nodes that still pass nodePayloadSchema, and refuses one that does not", async () => {
		stubMb([
			{ id: "b5b5b5b5-0000-4000-8000-000000000001", name: "Valid One", type: "Person" },
			{ id: "b5b5b5b5-0000-4000-8000-000000000002", name: "Invalid One", type: "Person" },
		]);
		await seed(artistNode("artist:valid-one", { name: "Valid One" }));
		await seed(artistNode("artist:invalid-one", { name: "Invalid One", editorial_article: "too short" }));
		const invalidBefore = await readFile(nodePath("artist:invalid-one"), "utf8");

		const result = await run({ apply: true });

		expect(result.written).toEqual([nodePath("artist:valid-one")]);
		expect(result.failed.map((f) => f.slug)).toEqual(["artist:invalid-one"]);
		expect(result.exitCode).toBe(1);
		expect(await readFile(nodePath("artist:invalid-one"), "utf8")).toBe(invalidBefore);
		expect(() => nodePayloadSchema.parse(JSON.parse(invalidBefore))).toThrow();
		expect(nodePayloadSchema.parse(await readNode("artist:valid-one"))).toMatchObject({
			mbid: "b5b5b5b5-0000-4000-8000-000000000001",
			artist_kind: "person",
		});
	});

	it("reports a failed search as a failure, not as an unknown artist", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => ({}) })),
		);
		await seed(artistNode("artist:search-outage", { name: "Search Outage" }));

		const result = await run({ apply: true });

		expect(result.failed).toEqual([
			{ slug: "artist:search-outage", reason: "MusicBrainz search unavailable" },
		]);
		expect(result.manifest.unresolved).toEqual([]);
		expect(result.exitCode).toBe(1);
	});

	// TRA-508 F5: with 25 results Death showed 2 homonyms (1 discarded); MB has homonyms at ranks 121-141.
	it("counts the homonyms of the whole pool and records the words that decided (Death)", async () => {
		const orlando = "bfbf0003-0000-4000-8000-000000000001";
		const death = (n: number, extra: Partial<FakeArtist> = {}): FakeArtist => ({
			id: `bfbf0003-0000-4000-8000-0000000001${n.toString().padStart(2, "0")}`,
			name: "Deathmetalish",
			...extra,
		});
		stubMb([
			// 120 near-names push the homonyms past the first page, as in MB.
			...Array.from({ length: 120 }, (_, i) => ({
				id: `bfbf0004-0000-4000-8000-${i.toString().padStart(12, "0")}`,
				name: `Deathmetalish Filler ${i}`,
			})),
			{ ...death(0), id: orlando, type: "Group", beginArea: "Orlando", disambiguation: "US death metal" },
			...Array.from({ length: 11 }, (_, i) => death(i + 1, { area: `Place ${i}` })),
		]);
		await seed(
			artistNode("artist:deathmetalish", { name: "Deathmetalish", origin: "Orlando, Florida, U.S." }),
		);

		const { manifest } = await run();

		expect(manifest.resolved["artist:deathmetalish"]).toMatchObject({
			mbid: orlando,
			homonyms_discarded: 11,
			matched_words: ["orlando"],
		});
	});

	it("keeps the audit trail of every identity in the manifest", async () => {
		stubMb([
			{
				id: "bfbf0001-0000-4000-8000-000000000001",
				name: "Audited Twin",
				type: "Person",
				disambiguation: "Japanese noise producer",
				area: "Tokyo",
			},
			{
				id: "bfbf0001-0000-4000-8000-000000000002",
				name: "Audited Twin",
				disambiguation: "rock band",
				area: "Canada",
			},
			{
				id: "bfbf0001-0000-4000-8000-000000000003",
				name: "音名",
				type: "Group",
				disambiguation: "Japanese band",
				area: "Japan",
				aliases: ["Audited Alias"],
			},
			{ id: "bfbf0001-0000-4000-8000-000000000004", name: "Audited Stored", type: "Person" },
		]);
		await seed(artistNode("artist:audited-twin", { name: "Audited Twin", origin: "Tokyo, Japan" }));
		await seed(artistNode("artist:audited-alias", { name: "Audited Alias", origin: "Osaka, Japan" }));
		await seed(
			artistNode("artist:audited-stored", {
				name: "Audited Stored",
				mbid: "bfbf0001-0000-4000-8000-000000000004",
			}),
		);

		const { resolved } = (await run()).manifest;

		expect(resolved["artist:audited-twin"]).toMatchObject({
			mb_name: "Audited Twin",
			disambiguation: "Japanese noise producer",
			area: "Tokyo",
			path: "name",
			homonyms_discarded: 1,
			matched_words: ["tokyo"],
		});
		expect(resolved["artist:audited-alias"]).toMatchObject({
			mb_name: "音名",
			path: "alias",
			homonyms_discarded: 0,
			matched_words: ["japan"],
		});
		expect(resolved["artist:audited-stored"]).toMatchObject({
			path: "stored-mbid",
			homonyms_discarded: 0,
			matched_words: [],
		});
	});

	// 2026-10-15 (TRA-463 review): a 502 on ?inc=artist-rels used to be read as "no bands", stored as
	// groups: [] with exit 0, and --resume would never have fetched them again.
	it("treats a 502 on the artist-rels lookup as a failure, retried by --resume, never as no bands", async () => {
		const id = "bfbf0002-0000-4000-8000-000000000001";
		const world: FakeArtist[] = [
			{
				id,
				name: "Gateway Trouble",
				type: "Person",
				relations: [["forward", "member of band", "bfbf0002-0000-4000-8000-000000000002", "Gateway Band"]],
			},
		];
		stubMb(world, { badGateway: [id] });
		await seed(artistNode("artist:gateway-trouble", { name: "Gateway Trouble" }));
		const before = await readFile(nodePath("artist:gateway-trouble"), "utf8");

		const failedRun = await run({ apply: true });

		expect(failedRun.exitCode).toBe(1);
		expect(failedRun.failed.map((f) => f.slug)).toEqual(["artist:gateway-trouble"]);
		expect(failedRun.manifest.resolved).toEqual({});
		expect(failedRun.manifest.unresolved).toEqual([]);
		expect(await readFile(nodePath("artist:gateway-trouble"), "utf8")).toBe(before);

		stubMb(world);
		const retry = await run({ apply: true, resume: true });

		expect(retry.exitCode).toBe(0);
		expect(retry.manifest.resolved["artist:gateway-trouble"]?.groups).toEqual([
			{ mbid: "bfbf0002-0000-4000-8000-000000000002", name: "Gateway Band" },
		]);
	});

	it("writes the live MBID when the stored one was merged away, and flags the collision on it", async () => {
		const live = "bfbf0003-0000-4000-8000-000000000001";
		const old = "bfbf0003-0000-4000-8000-000000000009";
		stubMb([{ id: live, mergedFrom: old, name: "Merged Name", type: "Person" }]);
		await seed(artistNode("artist:merged-name", { name: "Merged Name", mbid: old }));
		await seed(artistNode("artist:merged-name--twin", { name: "Merged Name", mbid: live }));

		const result = await run({ apply: true });

		expect((await readNode("artist:merged-name")).mbid).toBe(live);
		expect(result.manifest.resolved["artist:merged-name"]).toMatchObject({ mbid: live, path: "stored-mbid" });
		expect(result.manifest.collisions).toEqual([
			{ mbid: live, slugs: ["artist:merged-name", "artist:merged-name--twin"] },
		]);
	});

	it("writes a node that has no similar_artists with mbid, artist_kind and similar_artists: [] only", async () => {
		stubMb([{ id: "bfbf0004-0000-4000-8000-000000000001", name: "Legacy Shape", type: "Group" }]);
		const legacy = artistNode("artist:legacy-shape", { name: "Legacy Shape" });
		expect("similar_artists" in legacy).toBe(false);
		await seed(legacy);

		const result = await run({ apply: true });

		expect(result.failed).toEqual([]);
		expect(await readNode(legacy.slug)).toEqual({
			...legacy,
			mbid: "bfbf0004-0000-4000-8000-000000000001",
			artist_kind: "group",
			similar_artists: [],
		});
		expect((await run({ apply: true })).written).toEqual([]);
	});

	it("refuses a write the schema would turn into more than the two new fields", async () => {
		stubMb([{ id: "b5b5b5b5-0000-4000-8000-000000000003", name: "Edge Extra", type: "Person" }]);
		const edge = { slug: "genre:techno", type: "genre", name: "Techno", undeclared_field: "kept on disk" };
		await seed(artistNode("artist:edge-extra", { name: "Edge Extra", genres: [edge] }));
		const before = await readFile(nodePath("artist:edge-extra"), "utf8");

		const result = await run({ apply: true });

		expect(result.written).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(await readFile(nodePath("artist:edge-extra"), "utf8")).toBe(before);
	});

	it("--resume reuses the manifest: a dry-run followed by --apply --resume asks MusicBrainz nothing", async () => {
		stubMb([
			{ id: "b6b6b6b6-0000-4000-8000-000000000001", name: "Resumable One", type: "Person" },
			{ id: "b6b6b6b6-0000-4000-8000-000000000002", name: "Resumable Two", type: "Group" },
		]);
		await seed(artistNode("artist:resumable-one", { name: "Resumable One" }));
		await seed(artistNode("artist:resumable-two", { name: "Resumable Two" }));
		await run();
		expect(calls()).toEqual({ searches: 2, profiles: 2 });

		const result = await run({ apply: true, resume: true });

		expect(calls()).toEqual({ searches: 2, profiles: 2 });
		expect(result.written).toHaveLength(2);
		expect((await readNode("artist:resumable-two")).artist_kind).toBe("group");
		expect(Object.keys(result.manifest.resolved)).toEqual(["artist:resumable-one", "artist:resumable-two"]);
	});

	it("--resume skips resolved slugs but retries unresolved ones", async () => {
		stubMb([
			{ id: "b7b7b7b7-0000-4000-8000-000000000001", name: "Retry Done", type: "Person" },
			{ id: "b7b7b7b7-0000-4000-8000-000000000002", name: "Retry Pending", area: "Elsewhere" },
			{ id: "b7b7b7b7-0000-4000-8000-000000000003", name: "Retry Pending", area: "Retryland", type: "Group" },
		]);
		await seed(artistNode("artist:retry-done", { name: "Retry Done" }));
		await seed(artistNode("artist:retry-pending", { name: "Retry Pending" }));
		await run();
		expect((await readManifestFile()).unresolved).toHaveLength(1);
		vi.mocked(resolveArtistDetailed).mockClear();

		// The node now carries a hint, as if it had been enriched in between.
		await seed(artistNode("artist:retry-pending", { name: "Retry Pending", origin: "Retryland" }));
		const result = await run({ resume: true });

		expect(vi.mocked(resolveArtistDetailed).mock.calls.map((c) => c[0])).toEqual(["Retry Pending"]);
		expect(result.manifest.unresolved).toEqual([]);
		expect(result.manifest.resolved["artist:retry-pending"]?.kind).toBe("group");
		expect(result.manifest.resolved["artist:retry-done"]?.mbid).toBe("b7b7b7b7-0000-4000-8000-000000000001");
	});

	it("re-queries an artist whose stored mbid disagrees with a reused manifest entry", async () => {
		const stored = "b8b8b8b8-0000-4000-8000-000000000009";
		stubMb([
			{ id: "b8b8b8b8-0000-4000-8000-000000000001", name: "Stale Entry", type: "Person" },
			{ id: stored, name: "Stale Other", type: "Group" },
		]);
		await seed(artistNode("artist:stale-entry", { name: "Stale Entry" }));
		await run();
		await seed(artistNode("artist:stale-entry", { name: "Stale Entry", mbid: stored }));

		const result = await run({ resume: true });

		expect(result.manifest.resolved["artist:stale-entry"]?.mbid).toBe(stored);
		expect(result.manifest.resolved["artist:stale-entry"]?.kind).toBe("group");
	});

	// TRA-508: a manifest written before matched_words existed holds identities chosen by looser rules.
	it("--resume re-queries a legacy manifest entry that searched, and reuses one that did not", async () => {
		const stored = "b8b8b8b8-0000-4000-8000-0000000000a1";
		stubMb([{ id: "b8b8b8b8-0000-4000-8000-0000000000a2", name: "Legacy Searched", type: "Person" }]);
		await seed(artistNode("artist:legacy-stored", { name: "Legacy Stored", mbid: stored }));
		await seed(artistNode("artist:legacy-searched", { name: "Legacy Searched" }));
		const legacy = (mbid: string, path: string) => ({
			mbid,
			kind: "person",
			groups: [],
			mb_name: "Legacy",
			disambiguation: null,
			area: null,
			path,
			homonyms_discarded: 0,
		});
		await mkdir(join(root, "out"), { recursive: true });
		await writeFile(
			manifestPath,
			JSON.stringify({
				generated_at: "2026-10-14T00:00:00.000Z",
				resolved: {
					"artist:legacy-stored": legacy(stored, "stored-mbid"),
					"artist:legacy-searched": legacy("b8b8b8b8-0000-4000-8000-0000000000ff", "name"),
				},
				unresolved: [],
				collisions: [],
			}),
			"utf8",
		);

		const result = await run({ resume: true });

		expect(calls()).toEqual({ searches: 1, profiles: 1 });
		expect(result.manifest.resolved["artist:legacy-stored"]).toMatchObject({ matched_words: [] });
		expect(result.manifest.resolved["artist:legacy-searched"]?.mbid).toBe(
			"b8b8b8b8-0000-4000-8000-0000000000a2",
		);
	});

	it("does not search for an artist that already has an mbid, and completes its missing kind", async () => {
		const mbid = "b9b9b9b9-0000-4000-8000-000000000001";
		stubMb([{ id: mbid, name: "Already Known", type: "Person" }]);
		await seed(artistNode("artist:already-known", { name: "Already Known", mbid }));

		const result = await run({ apply: true });

		expect(calls()).toEqual({ searches: 0, profiles: 1 });
		expect(await readNode("artist:already-known")).toMatchObject({ mbid, artist_kind: "person" });
		expect(result.written).toHaveLength(1);
	});

	it("also detects a collision with an artist that already carries the mbid", async () => {
		const mbid = "bababaca-0000-4000-8000-000000000001";
		stubMb([{ id: mbid, name: "Twin Name", type: "Person" }]);
		await seed(artistNode("artist:twin-name", { name: "Twin Name", mbid }));
		await seed(artistNode("artist:twin-name--b", { name: "Twin Name" }));

		const result = await run();

		expect(result.manifest.collisions).toEqual([
			{ mbid, slugs: ["artist:twin-name", "artist:twin-name--b"] },
		]);
	});

	it("leaves an artist whose MusicBrainz lookup fails untouched, out of the manifest, with exit code 1", async () => {
		const down = "bcbcbcbc-0000-4000-8000-000000000001";
		stubMb([{ id: down, name: "Flaky Entity", type: "Person" }], { down: [down] });
		await seed(artistNode("artist:flaky-entity", { name: "Flaky Entity" }));
		const before = await readFile(nodePath("artist:flaky-entity"), "utf8");

		const result = await run({ apply: true });

		expect(result.failed).toHaveLength(1);
		expect(result.exitCode).toBe(1);
		expect(result.manifest.resolved).toEqual({});
		expect(result.manifest.unresolved).toEqual([]);
		expect(await readFile(nodePath("artist:flaky-entity"), "utf8")).toBe(before);
	});

	it("--limit caps the artists sent to MusicBrainz, and --resume carries on with the next ones", async () => {
		stubMb([
			{ id: "bdbdbdbd-0000-4000-8000-000000000001", name: "Limit A", type: "Person" },
			{ id: "bdbdbdbd-0000-4000-8000-000000000002", name: "Limit B", type: "Person" },
			{ id: "bdbdbdbd-0000-4000-8000-000000000003", name: "Limit C", type: "Person" },
		]);
		for (const n of ["a", "b", "c"])
			await seed(artistNode(`artist:limit-${n}`, { name: `Limit ${n.toUpperCase()}` }));

		const first = await run({ limit: 2 });
		expect(Object.keys(first.manifest.resolved)).toEqual(["artist:limit-a", "artist:limit-b"]);
		expect(calls().searches).toBe(2);

		const second = await run({ limit: 2, resume: true });
		expect(calls().searches).toBe(3);
		expect(Object.keys(second.manifest.resolved)).toEqual([
			"artist:limit-a",
			"artist:limit-b",
			"artist:limit-c",
		]);
	});

	it("ignores non-artist nodes and refuses to overwrite a manifest it cannot read on --resume", async () => {
		stubMb([]);
		await mkdir(join(cacheDir(), "nodes", "genre"), { recursive: true });
		await writeFile(
			join(cacheDir(), "nodes", "genre", "techno.json"),
			JSON.stringify({ slug: "genre:techno" }),
		);
		await mkdir(join(root, "out"), { recursive: true });
		await writeFile(manifestPath, "{ not json", "utf8");

		await expect(run({ resume: true })).rejects.toThrow();
		expect(await readFile(manifestPath, "utf8")).toBe("{ not json");
		expect((await run()).manifest.resolved).toEqual({});
	});

	it("prints the request budget before the first request", async () => {
		stubMb([{ id: "bebebebe-0000-4000-8000-000000000001", name: "Budgeted", type: "Person" }]);
		await seed(artistNode("artist:budgeted", { name: "Budgeted" }));
		const lines: string[] = [];
		await run({ log: (line) => lines.push(line) });
		expect(lines[0]).toContain("1 artists");
		expect(lines[0]).toContain("3 MusicBrainz requests");
	});
});

const manifestEntry = (mbid: string, kind: ResolvedArtist["kind"] = null): ResolvedArtist => ({
	mbid,
	kind,
	groups: [],
	mb_name: "Whoever",
	disambiguation: null,
	area: null,
	path: "name",
	homonyms_discarded: 0,
	matched_words: [],
});

describe("withIdentity", () => {
	const entry = manifestEntry("c1c1c1c1-0000-4000-8000-000000000001");

	it("never erases a kind already stored when MB gives none", () => {
		const node = { slug: "artist:x", artist_kind: "group" };
		expect(withIdentity(node, entry)).toEqual({ ...node, mbid: entry.mbid });
	});

	it("returns null when the node already carries both fields", () => {
		const node = { slug: "artist:x", mbid: entry.mbid, artist_kind: "person" };
		expect(withIdentity(node, { ...entry, kind: "person" })).toBeNull();
	});
});

describe("onlyAddsSchemaDefaults", () => {
	const written = { slug: "artist:x", name: "X", genres: [{ slug: "genre:a", type: "genre", name: "A" }] };

	it("accepts a missing list filled in at its empty default", () => {
		expect(onlyAddsSchemaDefaults(written, { ...written, similar_artists: [] })).toBe(true);
	});

	it("refuses a missing field filled in with anything but an empty list", () => {
		expect(onlyAddsSchemaDefaults(written, { ...written, similar_artists: [{ slug: "artist:y" }] })).toBe(
			false,
		);
		expect(onlyAddsSchemaDefaults(written, { ...written, era: "" })).toBe(false);
	});

	it("refuses a field removed, rewritten or stripped inside an edge", () => {
		expect(onlyAddsSchemaDefaults(written, { slug: "artist:x", genres: written.genres })).toBe(false);
		expect(onlyAddsSchemaDefaults(written, { ...written, name: "Y" })).toBe(false);
		const withExtra = { ...written, genres: [{ ...written.genres[0], extra: 1 }] };
		expect(onlyAddsSchemaDefaults(withExtra, written)).toBe(false);
		expect(onlyAddsSchemaDefaults(written, null)).toBe(false);
	});
});

describe("findCollisions", () => {
	it("lists only MBIDs shared by two slugs or more, sorted", () => {
		const one = manifestEntry("c2c2c2c2-0000-4000-8000-000000000001");
		const two = manifestEntry("c2c2c2c2-0000-4000-8000-000000000002");
		expect(findCollisions({ "artist:z": one, "artist:a": one, "artist:m": two })).toEqual([
			{ mbid: one.mbid, slugs: ["artist:a", "artist:z"] },
		]);
	});
});

describe("parseCliArgs", () => {
	it("defaults to a dry-run writing out/artist-identity.json", () => {
		expect(parseCliArgs(["cache"])).toEqual({
			cacheDir: "cache",
			apply: false,
			resume: false,
			manifestPath: DEFAULT_MANIFEST_PATH,
		});
	});

	it("reads every flag", () => {
		expect(parseCliArgs(["cache", "--apply", "--resume", "--limit", "5", "--manifest", "m.json"])).toEqual({
			cacheDir: "cache",
			apply: true,
			resume: true,
			limit: 5,
			manifestPath: "m.json",
		});
	});

	it.each([
		[[]],
		[["--apply"]],
		[["cache", "--aply"]],
		[["cache", "stray"]],
		[["cache", "--limit"]],
		[["cache", "--limit", "0"]],
		[["cache", "--limit", "abc"]],
		[["cache", "--limit", "5", "--limit", "6"]],
		[["cache", "--manifest", "--apply"]],
		[["cache", "--apply", "--apply"]],
	])("refuses %j", (argv) => {
		expect(parseCliArgs(argv)).toBeNull();
	});
});
