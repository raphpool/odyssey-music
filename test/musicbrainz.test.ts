import { afterEach, describe, expect, it, vi } from "vitest";
import { musicBrainzConfig } from "../src/config.js";
import {
	createMusicBrainzCatalog,
	fetchArtistDiscographyMb,
	fetchArtistEntityMb,
	fetchArtistMembershipsMb,
	fetchEntityGenresMb,
	fetchLabelMetaMb,
	fetchProjectMetaDetailedMb,
	fetchProjectMetaMb,
	fetchTrackMetaDetailedMb,
	fetchTrackMetaMb,
	fetchWikidataUrlRelMb,
	resolveRecording,
	resolveRecordingDetailed,
	resolveReleaseGroup,
	resolveReleaseGroupDetailed,
} from "../src/musicbrainz.js";

function jsonResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as Response;
}

function failedResponse(status: number, retryAfter?: string): Response {
	return {
		ok: false,
		status,
		headers: new Headers(retryAfter ? { "Retry-After": retryAfter } : undefined),
		json: async () => ({}),
	} as Response;
}

// vitest.config.ts sets MB_MIN_INTERVAL_MS=0 for the whole suite; the spacing tests below opt in
// by mutating the config object, which mbFetch reads at call time.
const suiteMinIntervalMs = musicBrainzConfig.minIntervalMs;

afterEach(() => {
	musicBrainzConfig.minIntervalMs = suiteMinIntervalMs;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("fetchEntityGenresMb", () => {
	it("carries the MBID of each genre entry through to the returned tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000001" },
						{ name: "House", count: 8, id: "aaaaaaaa-0000-0000-0000-000000000002" },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "11111111-1111-1111-1111-111111111111");
		expect(out).toEqual([
			{ name: "techno", mbid: "aaaaaaaa-0000-0000-0000-000000000001" },
			{ name: "house", mbid: "aaaaaaaa-0000-0000-0000-000000000002" },
		]);
	});

	it("falls back to tags when genres is empty, without an mbid on any entry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [],
					tags: [
						{ name: "Deep House", count: 5 },
						{ name: "Minimal", count: 3 },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "22222222-2222-2222-2222-222222222222");
		expect(out).toEqual([{ name: "deep house" }, { name: "minimal" }]);
		expect(out.every((g) => !("mbid" in g))).toBe(true);
	});

	it("keeps a genres entry without an id, omitting mbid rather than dropping it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000003" },
						{ name: "Ambient", count: 6 },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "33333333-3333-3333-3333-333333333333");
		expect(out).toEqual([
			{ name: "techno", mbid: "aaaaaaaa-0000-0000-0000-000000000003" },
			{ name: "ambient" },
		]);
		const [, ambient] = out;
		expect(ambient && "mbid" in ambient).toBe(false);
	});

	it("dedupes by name, keeping the first occurrence's mbid in sort order", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000004" },
						{ name: "Techno", count: 10, id: "aaaaaaaa-0000-0000-0000-000000000005" },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "44444444-4444-4444-4444-444444444444");
		expect(out).toEqual([{ name: "techno", mbid: "aaaaaaaa-0000-0000-0000-000000000004" }]);
	});

	it("preserves the minCount filter and max cap on the resulting name sequence", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000006" },
						{ name: "House", count: 9, id: "aaaaaaaa-0000-0000-0000-000000000007" },
						{ name: "Electro", count: 7, id: "aaaaaaaa-0000-0000-0000-000000000008" },
						{ name: "Trance", count: 4, id: "aaaaaaaa-0000-0000-0000-000000000009" },
						{ name: "Rare Tag", count: 1, id: "aaaaaaaa-0000-0000-0000-000000000010" },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "55555555-5555-5555-5555-555555555555", {
			minCount: 2,
			max: 3,
		});
		expect(out.map((g) => g.name)).toEqual(["techno", "house", "electro"]);
	});

	it("returns an empty array when the MB request fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => failedResponse(500)),
		);
		const out = await fetchEntityGenresMb("artist", "66666666-6666-6666-6666-666666666666");
		expect(out).toEqual([]);
	});

	// TRA-573: exponential backoff 1, 2, 4, 8, 16 s; 3 attempts by default, up to 8 with MB_MAX_ATTEMPTS.
	// Cumulative request offsets (ms) with six attempts:
	const BACKOFF_OFFSETS_MS = [0, 1_000, 3_000, 7_000, 15_000, 31_000];

	it("defaults to three attempts, backed off by 1 s then 2 s, without throwing", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-13T00:00:00.000Z"));
		const t0 = Date.now();
		const requestTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestTimes.push(Date.now());
				return failedResponse(503);
			}),
		);

		const pending = fetchEntityGenresMb("artist", "77777777-7777-7777-7777-777777777776");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(await pending).toEqual([]);
		expect(requestTimes.map((t) => t - t0)).toEqual([0, 1_000, 3_000]);
	});

	it("backs off exponentially and stops after six attempts when MB_MAX_ATTEMPTS=6", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "6");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
		const t0 = Date.now();
		const requestTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestTimes.push(Date.now());
				return failedResponse(503);
			}),
		);

		const pending = fetchEntityGenresMb("artist", "77777777-7777-7777-7777-777777777777");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(await pending).toEqual([]);
		expect(requestTimes.map((t) => t - t0)).toEqual(BACKOFF_OFFSETS_MS);
	});

	it("succeeds when the sixth attempt answers after five 503 with MB_MAX_ATTEMPTS=6", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "6");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
		const t0 = Date.now();
		const requestTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestTimes.push(Date.now());
				return requestTimes.length < 6
					? failedResponse(503)
					: jsonResponse({ genres: [{ name: "Techno", count: 5, id: "g1" }] });
			}),
		);

		const pending = fetchEntityGenresMb("artist", "77777777-7777-7777-7777-777777777778");
		await vi.advanceTimersByTimeAsync(31_000);

		expect(await pending).toEqual([{ name: "techno", mbid: "g1" }]);
		expect(requestTimes.map((t) => t - t0)).toEqual(BACKOFF_OFFSETS_MS);
	});

	it("flags a resolver unavailable (fail-closed) after six 503, without throwing", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "6");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
		const fetchMock = vi.fn(async () => failedResponse(503));
		vi.stubGlobal("fetch", fetchMock);

		const pending = resolveReleaseGroupDetailed("Backoff Exhausted Album", "Anyone");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(await pending).toEqual({ identity: null, ambiguous: false, unavailable: true });
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("keeps the longer of the backoff and Retry-After for each wait", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "6");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-17T00:00:00.000Z"));
		const t0 = Date.now();
		const requestTimes: number[] = [];
		// Waits after attempts 0..3: Retry-After 10 s beats the 1 s backoff, 1 s loses to 2 s,
		// a 4 s backoff is kept for an absent header, and 3 s loses to the 8 s backoff.
		const retryAfters = ["10", "1", undefined, "3"];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const call = requestTimes.length;
				requestTimes.push(Date.now());
				return call < 4 ? failedResponse(503, retryAfters[call]) : jsonResponse({ genres: [] });
			}),
		);

		const pending = fetchEntityGenresMb("artist", "77777777-7777-7777-7777-777777777779");
		await vi.advanceTimersByTimeAsync(24_000);

		expect(await pending).toEqual([]);
		expect(requestTimes.map((t) => t - t0)).toEqual([0, 10_000, 12_000, 16_000, 24_000]);
	});

	it.each([
		["abc", 3],
		["", 3],
		["2.5", 3],
		["0", 1],
		["-4", 1],
		["99", 8],
		["4", 4],
	])(
		"reads MB_MAX_ATTEMPTS=%j as %i attempts (invalid: default, out of range: clamped)",
		async (raw, expected) => {
			vi.stubEnv("MB_MAX_ATTEMPTS", raw);
			vi.useFakeTimers();
			const fetchMock = vi.fn(async () => failedResponse(503));
			vi.stubGlobal("fetch", fetchMock);

			const pending = fetchEntityGenresMb(
				"artist",
				`77777777-7777-7777-7777-7777777777b${expected}${raw.length}`,
			);
			await vi.advanceTimersByTimeAsync(300_000);

			expect(await pending).toEqual([]);
			expect(fetchMock).toHaveBeenCalledTimes(expected);
		},
	);

	it("caps every wait at 30 s, whether Retry-After is in seconds or an HTTP date", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
		const t0 = Date.now();
		const requestTimes: number[] = [];
		const retryAfters = ["86400", "Fri, 01 Jan 2100 00:00:00 GMT"];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const call = requestTimes.length;
				requestTimes.push(Date.now());
				return call < 2 ? failedResponse(429, retryAfters[call]) : jsonResponse({ genres: [] });
			}),
		);

		const pending = fetchEntityGenresMb("artist", "77777777-7777-7777-7777-77777777777a");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(await pending).toEqual([]);
		expect(requestTimes.map((t) => t - t0)).toEqual([0, 30_000, 60_000]);
	});

	it.each([500, 502, 504])("retries a transient %i like a 503, one second apart", async (status) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
		const requestTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestTimes.push(Date.now());
				return requestTimes.length === 1 ? failedResponse(status) : jsonResponse({ genres: [] });
			}),
		);

		const pending = fetchEntityGenresMb("artist", `1000000${status}-7777-7777-7777-777777777777`);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(await pending).toEqual([]);
		expect(requestTimes).toEqual([
			new Date("2026-10-15T00:00:00.000Z").getTime(),
			new Date("2026-10-15T00:00:01.000Z").getTime(),
		]);
	});

	it("does not retry a 404", async () => {
		const fetchMock = vi.fn(async () => failedResponse(404));
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchEntityGenresMb("artist", "10000404-7777-7777-7777-777777777777")).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("honors a valid Retry-After delay before retrying a 503", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
		const requestTimes: number[] = [];
		const fetchMock = vi.fn(async () => {
			requestTimes.push(Date.now());
			return requestTimes.length === 1 ? failedResponse(503, "3") : jsonResponse({ genres: [] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const pending = fetchEntityGenresMb("artist", "88888888-8888-8888-8888-888888888888");
		await vi.advanceTimersByTimeAsync(3_000);

		expect(await pending).toEqual([]);
		expect(requestTimes).toEqual([
			new Date("2026-09-14T00:00:00.000Z").getTime(),
			new Date("2026-09-14T00:00:03.000Z").getTime(),
		]);
	});

	it("serializes concurrent retries to avoid a retry burst", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
		const requestTimes: number[] = [];
		const attempts = new Map<string, number>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				const key = input.pathname;
				const attempt = attempts.get(key) ?? 0;
				attempts.set(key, attempt + 1);
				requestTimes.push(Date.now());
				return attempt === 0 ? failedResponse(503) : jsonResponse({ genres: [] });
			}),
		);

		const requests = [
			"99999999-9999-9999-9999-999999999991",
			"99999999-9999-9999-9999-999999999992",
			"99999999-9999-9999-9999-999999999993",
		].map((mbid) => fetchEntityGenresMb("artist", mbid));
		await vi.advanceTimersByTimeAsync(3_000);

		expect(await Promise.all(requests)).toEqual([[], [], []]);
		expect(requestTimes.slice(3)).toEqual([
			new Date("2026-09-14T00:00:01.000Z").getTime(),
			new Date("2026-09-14T00:00:02.000Z").getTime(),
			new Date("2026-09-14T00:00:03.000Z").getTime(),
		]);
	});
});

// TRA-452: credit-aware resolution. mbFetch memoizes by URL, so every test below uses titles,
// hints and MBIDs that no other test in this file requests.

const RONI_SIZE = "2eeba1d4-f67d-45be-a22e-ab73e925aa43";
const REPRAZENT = "45e00f0f-f52b-4db8-a480-cf87b71c4800";
const NEW_FORMS_RG = "70fe8c14-6a76-33d5-a4f4-e2cb5556611f";

function hit(id: string, title: string, credits: [mbid: string, name: string][], extra = {}) {
	return {
		id,
		score: 100,
		title,
		"artist-credit": credits.map(([artistId, name]) => ({ name, artist: { id: artistId, name } })),
		...extra,
	};
}

/** Stubs fetch to answer every request with `body`; the returned array collects requested URLs. */
function stubMb(body: unknown): URL[] {
	const urls: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			urls.push(input);
			return jsonResponse(body);
		}),
	);
	return urls;
}

function stubMbNetworkError(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("fetch failed");
		}),
	);
}

describe("resolveReleaseGroup", () => {
	it("skips a higher-ranked near-title and returns the exact-title release group with its credit", async () => {
		const urls = stubMb({
			"release-groups": [
				hit("11111111-aaaa-4aaa-8aaa-000000000001", "New Forms²", [[REPRAZENT, "Roni Size / Reprazent"]], {
					"primary-type": "Album",
				}),
				hit(NEW_FORMS_RG, "New Forms", [[REPRAZENT, "Roni Size / Reprazent"]], {
					"primary-type": "Album",
					"first-release-date": "1997-06-23",
				}),
			],
		});

		const out = await resolveReleaseGroup("New Forms", "Roni Size / Reprazent");

		expect(out).toEqual({
			mbid: NEW_FORMS_RG,
			title: "New Forms",
			credit: [{ mbid: REPRAZENT, name: "Roni Size / Reprazent" }],
			primaryType: "Album",
			firstReleaseDate: "1997-06-23",
			releaseGroupMbid: null,
		});
		expect(out?.credit[0]?.name).toBe("Roni Size / Reprazent");
		expect(urls).toHaveLength(1);
		expect(urls[0]?.pathname).toBe("/ws/2/release-group");
		expect(urls[0]?.searchParams.get("query")).toBe(
			'releasegroup:"New Forms" AND artist:"Roni Size / Reprazent"',
		);
		expect(urls[0]?.searchParams.get("limit")).toBe("100");
	});

	it("never falls back to the first result when no title matches exactly", async () => {
		stubMb({
			"release-groups": [hit("11111111-aaaa-4aaa-8aaa-000000000002", "Mirrors²", [[REPRAZENT, "Reprazent"]])],
		});
		expect(await resolveReleaseGroup("Mirrors", "Reprazent")).toBeNull();
	});

	it("prefers the exact-title result whose credit matches the hint among several", async () => {
		stubMb({
			"release-groups": [
				hit("22222222-aaaa-4aaa-8aaa-000000000001", "Dusk", [
					["99999999-0000-4000-8000-000000000001", "Other Act"],
				]),
				hit("22222222-aaaa-4aaa-8aaa-000000000002", "Dusk", [
					["99999999-0000-4000-8000-000000000002", "Wanted Act"],
				]),
			],
		});
		const out = await resolveReleaseGroup("Dusk", "Wanted Act");
		expect(out?.mbid).toBe("22222222-aaaa-4aaa-8aaa-000000000002");
	});

	it("matches the hint at word boundaries only, on the canonical or the credited-as name", async () => {
		stubMb({
			"release-groups": [
				hit("33333333-aaaa-4aaa-8aaa-000000000001", "Glow", [
					["99999999-0000-4000-8000-000000000003", "Alice"],
				]),
				hit("33333333-aaaa-4aaa-8aaa-000000000002", "Glow", [
					["99999999-0000-4000-8000-000000000004", "Ice"],
				]),
			],
		});
		// "ice" is a substring of "alice" but not a whole word of it.
		expect((await resolveReleaseGroup("Glow", "Ice"))?.mbid).toBe("33333333-aaaa-4aaa-8aaa-000000000002");

		stubMb({
			"release-groups": [
				{
					id: "33333333-aaaa-4aaa-8aaa-000000000003",
					title: "Sign",
					"artist-credit": [
						{ name: "The Artist", artist: { id: "99999999-0000-4000-8000-000000000005", name: "Prince" } },
					],
				},
				hit("33333333-aaaa-4aaa-8aaa-000000000004", "Sign", [
					["99999999-0000-4000-8000-000000000006", "Somebody"],
				]),
			],
		});
		const out = await resolveReleaseGroup("Sign", "Prince");
		expect(out?.mbid).toBe("33333333-aaaa-4aaa-8aaa-000000000003");
		expect(out?.credit).toEqual([{ mbid: "99999999-0000-4000-8000-000000000005", name: "Prince" }]);

		stubMb({
			"release-groups": [
				{
					id: "33333333-aaaa-4aaa-8aaa-000000000005",
					title: "Sign Two",
					"artist-credit": [
						{ name: "The Artist", artist: { id: "99999999-0000-4000-8000-000000000005", name: "Prince" } },
					],
				},
				hit("33333333-aaaa-4aaa-8aaa-000000000006", "Sign Two", [
					["99999999-0000-4000-8000-000000000006", "Somebody"],
				]),
			],
		});
		// The hint may also name the credited-as spelling rather than the canonical artist.
		expect((await resolveReleaseGroup("Sign Two", "The Artist"))?.mbid).toBe(
			"33333333-aaaa-4aaa-8aaa-000000000005",
		);
	});

	// TRA-537 (2026-10-15): this test used to expect the lone exact-title result to be taken whatever its
	// credit. That fallback is what resolved "Prince" to a work credited to "Prince Buster", and the
	// pipeline has no second gate behind the resolver. Safety before resolution rate: no credit equals
	// the hint, so MB knows no such work credited to that artist.
	it("returns null when the only exact-title result is credited to someone else than the hint", async () => {
		stubMb({
			"release-groups": [
				hit("44444444-aaaa-4aaa-8aaa-000000000001", "Lone Title", [
					["99999999-0000-4000-8000-000000000007", "Spelled Differently"],
				]),
				hit("44444444-aaaa-4aaa-8aaa-000000000002", "Lone Title Part II", [
					["99999999-0000-4000-8000-000000000008", "Spelled Differently"],
				]),
			],
		});
		expect(await resolveReleaseGroup("Lone Title", "Totally Unrelated Hint")).toBeNull();
	});

	it("returns null when several exact titles remain and the hint settles none of them", async () => {
		stubMb({
			"release-groups": [
				hit("55555555-aaaa-4aaa-8aaa-000000000001", "Ambiguous", [
					["99999999-0000-4000-8000-000000000009", "Act One"],
				]),
				hit("55555555-aaaa-4aaa-8aaa-000000000002", "Ambiguous", [
					["99999999-0000-4000-8000-000000000010", "Act Two"],
				]),
			],
		});
		expect(await resolveReleaseGroup("Ambiguous", "Act Three")).toBeNull();
	});

	it("without a hint, returns a unique exact title and omits the artist clause from the query", async () => {
		const urls = stubMb({
			"release-groups": [
				hit("66666666-aaaa-4aaa-8aaa-000000000001", "Solo Hit", [
					["99999999-0000-4000-8000-000000000011", "Solo"],
				]),
			],
		});
		const out = await resolveReleaseGroup("Solo Hit");
		expect(out?.mbid).toBe("66666666-aaaa-4aaa-8aaa-000000000001");
		expect(urls[0]?.searchParams.get("query")).toBe('releasegroup:"Solo Hit"');
	});

	it("without a hint, returns null when two release groups share the exact title", async () => {
		stubMb({
			"release-groups": [
				hit("77777777-aaaa-4aaa-8aaa-000000000001", "Twice Named", [
					["99999999-0000-4000-8000-000000000012", "A"],
				]),
				hit("77777777-aaaa-4aaa-8aaa-000000000002", "Twice Named", [
					["99999999-0000-4000-8000-000000000013", "B"],
				]),
			],
		});
		expect(await resolveReleaseGroup("Twice Named")).toBeNull();
	});

	it("keeps a Various Artists credit, drops credit entries without an artist id, and nulls absent fields", async () => {
		stubMb({
			"release-groups": [
				{
					id: "88888888-aaaa-4aaa-8aaa-000000000001",
					title: "Now Compilation",
					"artist-credit": [
						{
							name: "Various Artists",
							artist: { id: "89ce39a8-ae2b-4d24-8cd3-1c9ed7f1a5e1", name: "Various Artists" },
						},
						{ name: "No Id Credit" },
					],
				},
			],
		});
		const out = await resolveReleaseGroup("Now Compilation");
		expect(out).toEqual({
			mbid: "88888888-aaaa-4aaa-8aaa-000000000001",
			title: "Now Compilation",
			credit: [{ mbid: "89ce39a8-ae2b-4d24-8cd3-1c9ed7f1a5e1", name: "Various Artists" }],
			primaryType: null,
			firstReleaseDate: null,
			releaseGroupMbid: null,
		});
	});

	it("strips quotes and backslashes from title and hint before building the Lucene query", async () => {
		const urls = stubMb({ "release-groups": [] });
		await resolveReleaseGroup('Say "Hi"\\', 'The "Band"');
		expect(urls[0]?.searchParams.get("query")).toBe('releasegroup:"Say Hi" AND artist:"The Band"');
	});

	it("leaves a punctuation-only hint out of the query instead of narrowing the search to nothing", async () => {
		const urls = stubMb({ "release-groups": [] });
		await resolveReleaseGroup("Plain Title", "???");
		expect(urls[0]?.searchParams.get("query")).toBe('releasegroup:"Plain Title"');
	});

	it("returns null without calling MB when the title has nothing left to match on", async () => {
		const urls = stubMb({ "release-groups": [] });
		expect(await resolveReleaseGroup("!!!", "Someone")).toBeNull();
		expect(urls).toHaveLength(0);
	});

	it("resolves each release group of a title and its remixes to its own MBID", async () => {
		const bugz = "99999999-0000-4000-8000-0000000000b1";
		const bare = hit("99999999-aaaa-4aaa-8aaa-000000000001", "Booty La La", [[bugz, "Bugz in the Attic"]]);
		const loefah = hit("99999999-aaaa-4aaa-8aaa-000000000002", "Booty La La (Loefah remix)", [
			[bugz, "Bugz in the Attic"],
		]);
		stubMb({ "release-groups": [loefah, bare] });
		expect((await resolveReleaseGroup("Booty La La", "Bugz in the Attic"))?.mbid).toBe(bare.id);
		stubMb({ "release-groups": [bare, loefah] });
		expect((await resolveReleaseGroup("Booty La La (Loefah remix)", "Bugz in the Attic"))?.mbid).toBe(
			loefah.id,
		);
	});

	// Edition noise is deliberately NOT part of a release group's identity: MB files "Kid A" once,
	// whatever edition a source names, so a "(Deluxe Edition)" title must still find it.
	it("treats edition noise in the requested title as the same work", async () => {
		const urls = stubMb({
			"release-groups": [
				hit("99999999-aaaa-4aaa-8aaa-000000000003", "Kid A", [
					["99999999-0000-4000-8000-0000000000b2", "Radiohead"],
				]),
				hit("99999999-aaaa-4aaa-8aaa-000000000004", "Kid A Mnesia", [
					["99999999-0000-4000-8000-0000000000b2", "Radiohead"],
				]),
			],
		});
		const out = await resolveReleaseGroup("Kid A (Deluxe Edition)", "Radiohead");
		expect(out?.mbid).toBe("99999999-aaaa-4aaa-8aaa-000000000003");
		// ...and the search itself asks for the bare title, so MB can return "Kid A" at all.
		expect(urls[0]?.searchParams.get("query")).toBe('releasegroup:"Kid A" AND artist:"Radiohead"');
	});

	it("queries MB with the title minus its edition noise, keeping case and meaningful groups", async () => {
		// Titles are unique to this test: mbFetch caches by URL for the whole run.
		const urls = stubMb({ "release-groups": [] });
		await resolveReleaseGroup("Amnesiac (Deluxe Edition)", "Radiohead");
		await resolveReleaseGroup("Dusk Light (Loefah remix) [Remastered]", "Some Band");
		expect(urls[0]?.searchParams.get("query")).toBe('releasegroup:"Amnesiac" AND artist:"Radiohead"');
		expect(urls[1]?.searchParams.get("query")).toBe(
			'releasegroup:"Dusk Light (Loefah remix)" AND artist:"Some Band"',
		);
	});

	it("returns null for a title made only of edition noise, without calling MB", async () => {
		const urls = stubMb({ "release-groups": [] });
		expect(await resolveReleaseGroup("(Remastered)", "Someone")).toBeNull();
		expect(urls).toHaveLength(0);
	});

	it("returns null on a network error, an HTTP error and a malformed response", async () => {
		stubMbNetworkError();
		expect(await resolveReleaseGroup("Network Down", "Anyone")).toBeNull();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => failedResponse(500)),
		);
		expect(await resolveReleaseGroup("Server Down", "Anyone")).toBeNull();

		// Third-party payload: an id that is not an MBID invalidates the whole response.
		stubMb({ "release-groups": [{ id: "not-an-mbid", title: "Malformed Id" }] });
		expect(await resolveReleaseGroup("Malformed Id")).toBeNull();
	});
});

describe("resolveRecording", () => {
	const AKUMA_FITNA = "aaaaaaaa-1111-4111-8111-000000000001";
	const ROHFF_FITNA = "aaaaaaaa-1111-4111-8111-000000000002";
	const fitna = {
		recordings: [
			hit(AKUMA_FITNA, "Fitna", [["bbbbbbbb-2222-4222-8222-000000000001", "Akuma"]]),
			hit(ROHFF_FITNA, "Fitna", [["bbbbbbbb-2222-4222-8222-000000000002", "Rohff"]], {
				"first-release-date": "2008-05-12",
			}),
		],
	};

	it("returns the recording credited to the hinted artist when two share the exact title", async () => {
		const urls = stubMb(fitna);
		const out = await resolveRecording("Fitna", "Rohff");
		expect(out).toEqual({
			mbid: ROHFF_FITNA,
			title: "Fitna",
			credit: [{ mbid: "bbbbbbbb-2222-4222-8222-000000000002", name: "Rohff" }],
			primaryType: null,
			firstReleaseDate: "2008-05-12",
			releaseGroupMbid: null,
		});
		expect(urls[0]?.pathname).toBe("/ws/2/recording");
		expect(urls[0]?.searchParams.get("query")).toBe('recording:"Fitna" AND artist:"Rohff"');
		expect(urls[0]?.searchParams.get("limit")).toBe("100");
	});

	it("returns null without a hint when two recordings share the exact title", async () => {
		const urls = stubMb(fitna);
		expect(await resolveRecording("Fitna")).toBeNull();
		expect(urls[0]?.searchParams.get("query")).toBe('recording:"Fitna"');
	});

	it("never returns a remix or tribute whose title merely starts like the request", async () => {
		stubMb({
			recordings: [
				hit("aaaaaaaa-1111-4111-8111-000000000003", "Get Lucky Original Mix", [
					["bbbbbbbb-2222-4222-8222-000000000003", "Daft Punk"],
				]),
				hit("aaaaaaaa-1111-4111-8111-000000000004", "Get Lucky Original Tribute", [
					["bbbbbbbb-2222-4222-8222-000000000004", "Covers Band"],
				]),
			],
		});
		expect(await resolveRecording("Get Lucky Original", "Daft Punk")).toBeNull();
	});

	// Regression, TRA-452 review 2026-10-15: normalizeSlugBody dropped a trailing "(...)", so the
	// live version, listed first, was an "exact" match for the studio title and won on credit.
	it("keeps a parenthesised version distinct from the bare title, in both directions", async () => {
		const live = hit("aaaaaaaa-1111-4111-8111-000000000010", "Fitna (Live)", [
			["bbbbbbbb-2222-4222-8222-000000000010", "Rohff"],
		]);
		const studio = hit("aaaaaaaa-1111-4111-8111-000000000011", "Fitna", [
			["bbbbbbbb-2222-4222-8222-000000000010", "Rohff"],
		]);
		stubMb({ recordings: [live, studio] });
		// Hint spelled "ROHFF" only so the request differs from the memoized one of the "Fitna" test above.
		expect((await resolveRecording("Fitna", "ROHFF"))?.mbid).toBe("aaaaaaaa-1111-4111-8111-000000000011");
		// The live title is a different query, so it is a different (uncached) request.
		stubMb({ recordings: [live, studio] });
		expect((await resolveRecording("Fitna (Live)", "ROHFF"))?.mbid).toBe(
			"aaaaaaaa-1111-4111-8111-000000000010",
		);
	});

	it("does not treat a remix as the original title", async () => {
		stubMb({
			recordings: [
				hit("aaaaaaaa-1111-4111-8111-000000000012", "Get Lucky (Daft Punk Remix)", [
					["bbbbbbbb-2222-4222-8222-000000000012", "Daft Punk"],
				]),
			],
		});
		expect(await resolveRecording("Get Lucky", "Daft Punk")).toBeNull();
	});

	it("ignores edition noise: a featuring credit in the title is the same recording", async () => {
		stubMb({
			recordings: [
				hit("aaaaaaaa-1111-4111-8111-000000000013", "Lose Yourself to Dance", [
					["bbbbbbbb-2222-4222-8222-000000000013", "Daft Punk"],
				]),
			],
		});
		// Title distinct from the "Get Lucky" tests above: the cleaned query is cached per URL.
		const out = await resolveRecording("Lose Yourself to Dance (feat. Pharrell Williams)", "Daft Punk");
		expect(out?.mbid).toBe("aaaaaaaa-1111-4111-8111-000000000013");
	});

	it("queries MB with the recording title minus a featuring credit", async () => {
		// mbFetch caches by URL for the whole run: the title here is unique to this test, otherwise an
		// earlier test's cached answer for the same cleaned query would shadow this stub.
		const urls = stubMb({ recordings: [] });
		await resolveRecording("Instant Crush (feat. Julian Casablancas)", "Daft Punk");
		expect(urls[0]?.searchParams.get("query")).toBe('recording:"Instant Crush" AND artist:"Daft Punk"');
	});

	it("returns null when MB is unreachable", async () => {
		stubMbNetworkError();
		expect(await resolveRecording("Offline Song", "Offline Artist")).toBeNull();
	});
});

describe("fetchArtistMembershipsMb", () => {
	const rel = (type: string, direction: string, id: string, name: string) => ({
		type,
		direction,
		artist: { id, name },
	});

	it("lists the bands a person belongs to from forward member-of-band relations", async () => {
		const urls = stubMb({
			id: RONI_SIZE,
			relations: [
				rel("member of band", "forward", REPRAZENT, "Roni Size / Reprazent"),
				rel("collaboration", "forward", "cccccccc-3333-4333-8333-000000000001", "Not A Band"),
			],
		});
		const out = await fetchArtistMembershipsMb(RONI_SIZE);
		expect(out).toEqual({ groups: [{ mbid: REPRAZENT, name: "Roni Size / Reprazent" }], members: [] });
		expect(urls[0]?.pathname).toBe(`/ws/2/artist/${RONI_SIZE}`);
		expect(urls[0]?.searchParams.get("inc")).toBe("artist-rels");
	});

	it("lists the members of a group from backward member-of-band relations, deduplicated", async () => {
		stubMb({
			id: REPRAZENT,
			relations: [
				rel("member of band", "backward", RONI_SIZE, "Roni Size"),
				rel("member of band", "backward", "cccccccc-3333-4333-8333-000000000002", "DJ Krust"),
				rel("member of band", "backward", RONI_SIZE, "Roni Size"),
			],
		});
		const out = await fetchArtistMembershipsMb(REPRAZENT);
		expect(out.groups).toEqual([]);
		expect(out.members).toEqual([
			{ mbid: RONI_SIZE, name: "Roni Size" },
			{ mbid: "cccccccc-3333-4333-8333-000000000002", name: "DJ Krust" },
		]);
	});

	it("skips malformed relations without discarding the valid ones", async () => {
		stubMb({
			relations: [
				rel("member of band", "forward", "not-an-mbid", "Bad Id"),
				rel("member of band", "sideways", "cccccccc-3333-4333-8333-000000000003", "Bad Direction"),
				{ type: "member of band", direction: "forward" },
				"garbage",
				rel("member of band", "forward", "cccccccc-3333-4333-8333-000000000004", "Good Band"),
			],
		});
		const out = await fetchArtistMembershipsMb("dddddddd-4444-4444-8444-000000000001");
		expect(out).toEqual({
			groups: [{ mbid: "cccccccc-3333-4333-8333-000000000004", name: "Good Band" }],
			members: [],
		});
	});

	it("returns empty lists on a network error, a missing relations array and a non-MBID argument", async () => {
		const empty = { groups: [], members: [] };

		stubMbNetworkError();
		expect(await fetchArtistMembershipsMb("dddddddd-4444-4444-8444-000000000002")).toEqual(empty);

		stubMb({ id: "dddddddd-4444-4444-8444-000000000003" });
		expect(await fetchArtistMembershipsMb("dddddddd-4444-4444-8444-000000000003")).toEqual(empty);

		const urls = stubMb({ relations: [] });
		expect(await fetchArtistMembershipsMb("../label/anything")).toEqual(empty);
		expect(urls).toHaveLength(0);
	});
});

describe("fetchArtistEntityMb kind", () => {
	it.each([
		["Person", "person", "eeeeeeee-5555-4555-8555-000000000001"],
		["Group", "group", "eeeeeeee-5555-4555-8555-000000000002"],
		["Orchestra", "group", "eeeeeeee-5555-4555-8555-000000000003"],
		["Choir", "group", "eeeeeeee-5555-4555-8555-000000000004"],
		["Character", null, "eeeeeeee-5555-4555-8555-000000000005"],
		["Other", null, "eeeeeeee-5555-4555-8555-000000000006"],
		[undefined, null, "eeeeeeee-5555-4555-8555-000000000007"],
	] as const)("maps MB type %s to kind %s", async (type, kind, mbid) => {
		stubMb({ id: mbid, name: "Whoever", ...(type ? { type } : {}) });
		const out = await fetchArtistEntityMb(mbid);
		expect(out?.kind).toBe(kind);
		expect(out?.name).toBe("Whoever");
	});
});

describe("fetchLabelMetaMb notable release credits", () => {
	const LABEL = "ffffffff-6666-4666-8666-000000000001";

	it("carries each release group's artist credit and asks MB for it", async () => {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				urls.push(input);
				if (input.pathname.endsWith("/artist")) return jsonResponse({ artists: [] });
				return jsonResponse({
					"release-groups": [
						hit(NEW_FORMS_RG, "New Forms", [[REPRAZENT, "Roni Size / Reprazent"]], {
							"first-release-date": "1997-06-23",
						}),
						{
							id: "ffffffff-6666-4666-8666-000000000002",
							title: "Credit-less",
							"first-release-date": "1990",
						},
						{
							id: "ffffffff-6666-4666-8666-000000000003",
							title: "Junk Credit",
							"first-release-date": "1980",
							"artist-credit": [{ artist: { id: "nope", name: "Bad" } }, "junk"],
						},
					],
				});
			}),
		);

		const meta = await fetchLabelMetaMb(LABEL);

		expect(meta.notableReleases).toEqual([
			{
				mbid: NEW_FORMS_RG,
				title: "New Forms",
				firstReleaseDate: "1997-06-23",
				credit: [{ mbid: REPRAZENT, name: "Roni Size / Reprazent" }],
			},
			{
				mbid: "ffffffff-6666-4666-8666-000000000002",
				title: "Credit-less",
				firstReleaseDate: "1990",
				credit: [],
			},
			{
				mbid: "ffffffff-6666-4666-8666-000000000003",
				title: "Junk Credit",
				firstReleaseDate: "1980",
				credit: [],
			},
		]);
		const rgRequest = urls.find((u) => u.pathname.endsWith("/release-group"));
		expect(rgRequest?.searchParams.get("inc")).toBe("artist-credits");
		expect(rgRequest?.searchParams.get("label")).toBe(LABEL);
	});
});

describe("mbFetch request spacing", () => {
	// The scheduler is module-level state: each test starts at a later fake date than the
	// previous one so a slot reserved by an earlier test is always in the past.
	function startAt(isoDate: string): number {
		musicBrainzConfig.minIntervalMs = 1_000;
		vi.useFakeTimers();
		vi.setSystemTime(new Date(isoDate));
		return Date.now();
	}

	it("defaults to one second, and MB_MIN_INTERVAL_MS=0 disables spacing", async () => {
		const load = async (value: string) => {
			vi.stubEnv("MB_MIN_INTERVAL_MS", value);
			vi.resetModules();
			return (await import("../src/config.js")).musicBrainzConfig.minIntervalMs;
		};
		try {
			expect(await load("")).toBe(1_000);
			expect(await load("0")).toBe(0);
			expect(await load("2500")).toBe(2_500);
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});

	it("emits three concurrent uncached requests at least one second apart, in arrival order", async () => {
		const t0 = startAt("2027-01-01T00:00:00.000Z");
		const requests: { at: number; mbid: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				requests.push({ at: Date.now(), mbid: input.pathname.split("/").at(-1) ?? "" });
				return jsonResponse({ genres: [] });
			}),
		);

		const mbids = ["a1", "a2", "a3"].map((id) => `${id}000000-0000-0000-0000-000000000000`);
		const pending = mbids.map((mbid) => fetchEntityGenresMb("artist", mbid));
		await vi.advanceTimersByTimeAsync(2_000);
		await Promise.all(pending);

		expect(requests.map((r) => r.mbid)).toEqual(mbids);
		expect(requests.map((r) => r.at - t0)).toEqual([0, 1_000, 2_000]);
	});

	it("does not delay or count a cached call, and emits no fetch for it", async () => {
		const t0 = startAt("2028-01-01T00:00:00.000Z");
		const requestTimes: number[] = [];
		const fetchMock = vi.fn(async () => {
			requestTimes.push(Date.now());
			return jsonResponse({ genres: [{ name: "Techno", count: 5, id: "g1" }] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const cachedMbid = "c1000000-0000-0000-0000-000000000000";
		const first = fetchEntityGenresMb("artist", cachedMbid);
		await vi.advanceTimersByTimeAsync(0);
		await first;
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Cached call resolves immediately (no timer advance), then a fresh call is only
		// spaced from the first real request, not from the cache hit.
		const cached = await fetchEntityGenresMb("artist", cachedMbid);
		expect(cached).toEqual([{ name: "techno", mbid: "g1" }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const fresh = fetchEntityGenresMb("artist", "c2000000-0000-0000-0000-000000000000");
		await vi.advanceTimersByTimeAsync(1_000);
		await fresh;
		expect(requestTimes.map((t) => t - t0)).toEqual([0, 1_000]);
	});

	it("applies the interval to a retry when Retry-After is shorter, and honors Retry-After when longer", async () => {
		const t0 = startAt("2029-01-01T00:00:00.000Z");
		const requestTimes: number[] = [];
		const retryAfterByCall = ["1", "5", undefined];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const call = requestTimes.length;
				requestTimes.push(Date.now());
				return call < 2 ? failedResponse(503, retryAfterByCall[call]) : jsonResponse({ genres: [] });
			}),
		);

		const pending = fetchEntityGenresMb("artist", "d1000000-0000-0000-0000-000000000000");
		await vi.advanceTimersByTimeAsync(6_000);
		await pending;

		expect(requestTimes.map((t) => t - t0)).toEqual([0, 1_000, 6_000]);
	});

	it("spaces a retry from other callers' requests as well as from its own", async () => {
		const t0 = startAt("2030-01-01T00:00:00.000Z");
		const requests: { at: number; mbid: string }[] = [];
		const seen = new Set<string>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				const mbid = input.pathname.split("/").at(-1) ?? "";
				requests.push({ at: Date.now(), mbid });
				const firstTime = !seen.has(mbid);
				seen.add(mbid);
				return mbid.startsWith("e1") && firstTime ? failedResponse(503) : jsonResponse({ genres: [] });
			}),
		);

		const pending = ["e1", "e2"].map((id) =>
			fetchEntityGenresMb("artist", `${id}000000-0000-0000-0000-000000000000`),
		);
		await vi.advanceTimersByTimeAsync(3_000);
		await Promise.all(pending);

		const gaps = requests.slice(1).map((r, i) => r.at - (requests[i]?.at ?? 0));
		expect(requests).toHaveLength(3);
		expect(gaps.every((gap) => gap >= 1_000)).toBe(true);
		expect(requests.map((r) => r.at - t0)).toEqual([0, 1_000, 2_000]);
	});

	it("adds the backoff to the interval instead of replacing it", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "6");
		const t0 = startAt("2031-01-01T00:00:00.000Z");
		const requestTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestTimes.push(Date.now());
				return requestTimes.length < 4 ? failedResponse(503) : jsonResponse({ genres: [] });
			}),
		);

		const pending = fetchEntityGenresMb("artist", "d2000000-0000-0000-0000-000000000000");
		await vi.advanceTimersByTimeAsync(7_000);
		await pending;

		const offsets = requestTimes.map((t) => t - t0);
		expect(offsets).toEqual([0, 1_000, 3_000, 7_000]);
		expect(offsets.slice(1).every((at, i) => at - (offsets[i] ?? 0) >= 1_000)).toBe(true);
	});

	it("does not space requests when MB_MIN_INTERVAL_MS is 0", async () => {
		musicBrainzConfig.minIntervalMs = 0;
		const fetchMock = vi.fn(async () => jsonResponse({ genres: [] }));
		vi.stubGlobal("fetch", fetchMock);

		await Promise.all(
			["f1", "f2", "f3"].map((id) =>
				fetchEntityGenresMb("artist", `${id}000000-0000-0000-0000-000000000000`),
			),
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	// TRA-579: `background` yields to every interactive reservation still waiting for its slot.
	describe("background priority", () => {
		const id = (tag: string) => `${tag}000000-0000-0000-0000-000000000000`;
		const interactive = (tag: string) => fetchEntityGenresMb("artist", id(tag));
		const background = (tag: string) =>
			fetchWikidataUrlRelMb("artist", id(tag), undefined, { priority: "background" });

		// Records "<last path segment> @ offset" of every request, answering 200 unless `fail` says 503.
		function stubRecording(t0: number, fail = new Set<string>()): string[] {
			const log: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: URL) => {
					const name = input.pathname.split("/").at(-1) ?? "";
					log.push(`${name.slice(0, 2)}@${Date.now() - t0}`);
					const first = fail.delete(name);
					return first ? failedResponse(503) : jsonResponse({ genres: [], relations: [] });
				}),
			);
			return log;
		}

		it("gives slots 0 s, 1 s, 2 s to two interactive requests then a background one started together", async () => {
			const t0 = startAt("2032-01-01T00:00:00.000Z");
			const log = stubRecording(t0);

			const pending = [interactive("a1"), interactive("a2"), background("b1")];
			await vi.advanceTimersByTimeAsync(2_000);
			await Promise.all(pending);

			expect(log).toEqual(["a1@0", "a2@1000", "b1@2000"]);
		});

		it("sends a background request issued during a burst of five interactive ones after the fifth", async () => {
			const t0 = startAt("2033-01-01T00:00:00.000Z");
			const log = stubRecording(t0);

			const pending: Promise<unknown>[] = ["a1", "a2", "a3", "a4", "a5"].map(interactive);
			pending.push(background("b1"));
			await vi.advanceTimersByTimeAsync(5_000);
			await Promise.all(pending);

			expect(log).toEqual(["a1@0", "a2@1000", "a3@2000", "a4@3000", "a5@4000", "b1@5000"]);
		});

		it("lets an interactive request issued while a background one waits go first", async () => {
			const t0 = startAt("2034-01-01T00:00:00.000Z");
			const log = stubRecording(t0);

			const pending: Promise<unknown>[] = [interactive("a1"), interactive("a2"), background("b1")];
			await vi.advanceTimersByTimeAsync(500);
			pending.push(interactive("a3"));
			await vi.advanceTimersByTimeAsync(3_000);
			await Promise.all(pending);

			expect(log).toEqual(["a1@0", "a2@1000", "a3@2000", "b1@3000"]);
		});

		it("spaces two background requests by one second when nothing interactive is pending", async () => {
			const t0 = startAt("2035-01-01T00:00:00.000Z");
			const log = stubRecording(t0);

			const pending = [background("b1"), background("b2")];
			await vi.advanceTimersByTimeAsync(1_000);
			await Promise.all(pending);

			expect(log).toEqual(["b1@0", "b2@1000"]);
		});

		it("holds at most one slot for background requests, so a late interactive one waits behind one at most", async () => {
			const t0 = startAt("2036-01-01T00:00:00.000Z");
			const log = stubRecording(t0);

			const pending: Promise<unknown>[] = ["b1", "b2", "b3"].map(background);
			await vi.advanceTimersByTimeAsync(0);
			pending.push(interactive("a1"));
			await vi.advanceTimersByTimeAsync(3_000);
			await Promise.all(pending);

			// b2 reserved slot 1 000 as soon as b1's slot was reached; b3 then waits for a1 (slot 2 000), so
			// a1 never stands behind more than one background request.
			expect(log).toEqual(["b1@0", "b2@1000", "a1@2000", "b3@3000"]);
		});

		it("keeps the background priority on the retry of a first attempt that failed with a 503", async () => {
			const t0 = startAt("2037-01-01T00:00:00.000Z");
			const log = stubRecording(t0, new Set([id("b1")]));

			const pending: Promise<unknown>[] = [background("b1")];
			await vi.advanceTimersByTimeAsync(500);
			pending.push(interactive("a1"), interactive("a2"));
			await vi.advanceTimersByTimeAsync(700);
			pending.push(interactive("a3"));
			await vi.advanceTimersByTimeAsync(4_000);
			await Promise.all(pending);

			// The retry wakes at 1 000 ms while a1 and a2 still wait for their slots: it queues behind a3 too.
			expect(log).toEqual(["b1@0", "a1@1000", "a2@2000", "a3@3000", "b1@4000"]);
		});

		it.each([
			["resolveReleaseGroupDetailed", resolveReleaseGroupDetailed, "release-group", "2038-01-01"],
			["resolveRecordingDetailed", resolveRecordingDetailed, "recording", "2039-01-01"],
		] as const)("is carried by the priority option of %s", async (_name, resolve, path, date) => {
			const t0 = startAt(`${date}T00:00:00.000Z`);
			const log = stubRecording(t0);

			const pending: Promise<unknown>[] = [interactive("a1"), interactive("a2")];
			pending.push(resolve(`Title ${path}`, "Artist", { priority: "background" }));
			await vi.advanceTimersByTimeAsync(500);
			pending.push(interactive("a3"));
			await vi.advanceTimersByTimeAsync(3_000);
			await Promise.all(pending);

			// Without the option, the resolver is interactive and takes the third slot (FIFO).
			expect(log).toHaveLength(4);
			expect(log.at(-1)).toBe(`${path.slice(0, 2)}@3000`);
		});

		it("resolveReleaseGroupDetailed without an option keeps its place in the FIFO", async () => {
			const t0 = startAt("2040-01-01T00:00:00.000Z");
			const log = stubRecording(t0);

			const pending: Promise<unknown>[] = [interactive("a1"), interactive("a2")];
			pending.push(resolveReleaseGroupDetailed("Title default", "Artist"));
			await vi.advanceTimersByTimeAsync(500);
			pending.push(interactive("a3"));
			await vi.advanceTimersByTimeAsync(3_000);
			await Promise.all(pending);

			expect(log.map((entry) => entry.slice(0, 2))).toEqual(["a1", "a2", "re", "a3"]);
		});

		it("neither spaces nor yields when MB_MIN_INTERVAL_MS is 0", async () => {
			musicBrainzConfig.minIntervalMs = 0;
			const fetchMock = vi.fn(async () => jsonResponse({ relations: [] }));
			vi.stubGlobal("fetch", fetchMock);

			await Promise.all([background("c1"), background("c2"), interactive("c3")]);

			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});
});

// TRA-474 review (2026-10-15): look-alike candidates and undated editions.

describe("resolveRecordingDetailed / resolveReleaseGroupDetailed", () => {
	const KRAFTWERK = "cccccccc-3333-4333-8333-000000000001";
	const credit: [string, string][] = [[KRAFTWERK, "Kraftwerk"]];

	it("sets aside recordings with a disambiguation (live, DJ-mix) and takes the one that remains", async () => {
		stubMb({
			recordings: [
				hit("dddddddd-4444-4444-8444-000000000001", "Trans Europe Express", credit, {
					disambiguation: "live, Detroit 1998",
				}),
				hit("dddddddd-4444-4444-8444-000000000002", "Trans Europe Express", credit, {
					disambiguation: "DJ-mix",
				}),
				hit("dddddddd-4444-4444-8444-000000000003", "Trans Europe Express", credit, { disambiguation: "" }),
			],
		});
		const out = await resolveRecording("Trans Europe Express", "Kraftwerk");
		expect(out?.mbid).toBe("dddddddd-4444-4444-8444-000000000003");
	});

	it("refuses to choose between two studio recordings of one title and one credit, and says why", async () => {
		stubMb({
			recordings: [
				hit("dddddddd-4444-4444-8444-000000000011", "Radioactivity", credit),
				hit("dddddddd-4444-4444-8444-000000000012", "Radioactivity", credit),
			],
		});
		expect(await resolveRecordingDetailed("Radioactivity", "Kraftwerk")).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
	});

	// TRA-504 (2026-10-15): MB does not order tied hits stably, and `track:booty-la-la` resolved to a
	// different recording (and parent project) from one run to the next. Whatever the order, a tie
	// between look-alikes must give the same answer: none, flagged ambiguous, never the first of them.
	it("answers the same whichever way MB orders two identical recordings (Booty La La, TRA-504)", async () => {
		const bugz = "cccccccc-3333-4333-8333-0000000000b1";
		const a = hit("dddddddd-4444-4444-8444-0000000000a1", "Booty La La", [[bugz, "Bugz in the Attic"]], {
			"first-release-date": "2004",
		});
		const b = hit("dddddddd-4444-4444-8444-0000000000a2", "Booty La La", [[bugz, "Bugz in the Attic"]], {
			"first-release-date": "2004",
		});
		// mbFetch caches by URL for 5 minutes: each order needs its own query (the hint's case changes
		// the URL, not the matching) or the second pass would replay the first response.
		for (const [hint, recordings] of [
			["Bugz in the Attic", [a, b]],
			["bugz in the attic", [b, a]],
		] as const) {
			stubMb({ count: 2, recordings });
			expect(await resolveRecordingDetailed("Booty La La", hint)).toEqual({
				identity: null,
				ambiguous: true,
				unavailable: false,
			});
			expect(await resolveRecording("Booty La La", hint)).toBeNull();
		}
	});

	it("answers the same whichever way MB orders two release groups tied on title, credit and date", async () => {
		const bugz = "cccccccc-3333-4333-8333-0000000000b1";
		const a = hit("dddddddd-4444-4444-8444-0000000000b1", "Got the Bug", [[bugz, "Bugz in the Attic"]], {
			"first-release-date": "2004-06-07",
		});
		const b = hit("dddddddd-4444-4444-8444-0000000000b2", "Got the Bug", [[bugz, "Bugz in the Attic"]], {
			"first-release-date": "2004-06-07",
		});
		// Distinct hint case per order: see the mbFetch cache note above.
		for (const [hint, releaseGroups] of [
			["Bugz in the Attic", [a, b]],
			["bugz in the attic", [b, a]],
		] as const) {
			stubMb({ count: 2, "release-groups": releaseGroups });
			expect(await resolveReleaseGroupDetailed("Got the Bug", hint)).toEqual({
				identity: null,
				ambiguous: true,
				unavailable: false,
			});
		}
	});

	// TRA-578 (3b.1): a track's cover is its release group's; the search hit already lists the releases.
	describe("releaseGroupMbid", () => {
		const album = "eeeeeeee-5555-4555-8555-000000000001";
		const single = "eeeeeeee-5555-4555-8555-000000000002";
		const release = (id: string, primaryType: string | undefined, secondaryTypes: string[] = []) => ({
			id: "ffffffff-6666-4666-8666-000000000000",
			"release-group": {
				id,
				...(primaryType ? { "primary-type": primaryType } : {}),
				...(secondaryTypes.length > 0 ? { "secondary-types": secondaryTypes } : {}),
			},
		});
		const identityFor = async (title: string, releases: unknown) => {
			stubMb({
				recordings: [hit("dddddddd-4444-4444-8444-000000000041", title, credit, { releases })],
			});
			return (await resolveRecordingDetailed(title, "Kraftwerk")).identity;
		};

		it("prefers the release group of an Album-primary release over an earlier-listed single", async () => {
			const out = await identityFor("Pocket Calculator", [
				release(single, "Single"),
				release(album, "album"),
			]);
			expect(out?.releaseGroupMbid).toBe(album);
		});

		it("prefers a studio Album over a compilation or live Album listed before it", async () => {
			const out = await identityFor("Computer Love", [
				release(single, "Album", ["Live"]),
				release(album, "Album"),
			]);
			expect(out?.releaseGroupMbid).toBe(album);
		});

		it("still names an Album with secondary types when no studio Album is listed", async () => {
			const out = await identityFor("The Model", [
				release(single, "Single"),
				release(album, "Album", ["Compilation"]),
			]);
			expect(out?.releaseGroupMbid).toBe(album);
		});

		it("falls back to the first release group listed when none is an Album", async () => {
			const out = await identityFor("Numbers", [release(single, "Single"), release(album, "EP")]);
			expect(out?.releaseGroupMbid).toBe(single);
		});

		it("is null when the hit lists no release, or none with a valid release-group id", async () => {
			expect((await identityFor("Metropolis", undefined))?.releaseGroupMbid).toBeNull();
			expect((await identityFor("Neon Lights", []))?.releaseGroupMbid).toBeNull();
			expect(
				(await identityFor("Spacelab", [release("not-an-mbid", "Album"), { "release-group": "x" }]))
					?.releaseGroupMbid,
			).toBeNull();
		});

		it("is null for a release group: its own mbid is the release group", async () => {
			stubMb({
				"release-groups": [
					hit("dddddddd-4444-4444-8444-000000000042", "Computer World", credit, {
						"primary-type": "Album",
					}),
				],
			});
			const out = await resolveReleaseGroupDetailed("Computer World", "Kraftwerk");
			expect(out.identity?.mbid).toBe("dddddddd-4444-4444-8444-000000000042");
			expect(out.identity?.releaseGroupMbid).toBeNull();
		});
	});

	it("finds nothing, not an ambiguity, when the only exact recording is a live one", async () => {
		stubMb({
			recordings: [
				hit("dddddddd-4444-4444-8444-000000000021", "Autobahn", credit, { disambiguation: "live" }),
			],
		});
		expect(await resolveRecordingDetailed("Autobahn", "Kraftwerk")).toEqual({
			identity: null,
			ambiguous: false,
			unavailable: false,
		});
	});

	it("takes the release group with the strictly earliest first release over a later one", async () => {
		const single = "dddddddd-4444-4444-8444-000000000031";
		stubMb({
			"release-groups": [
				hit(
					"dddddddd-4444-4444-8444-000000000032",
					"Windowlicker",
					[["cccccccc-3333-4333-8333-000000000002", "Aphex Twin"]],
					{
						"first-release-date": "2026-01-09",
					},
				),
				hit(single, "Windowlicker", [["cccccccc-3333-4333-8333-000000000003", "Aphex Twin"]], {
					"first-release-date": "1999-03-22",
				}),
			],
		});
		expect((await resolveReleaseGroup("Windowlicker", "Aphex Twin"))?.mbid).toBe(single);
	});

	it("is ambiguous when two release groups share the earliest date, or none is dated", async () => {
		stubMb({
			"release-groups": [
				hit("dddddddd-4444-4444-8444-000000000041", "Tie Break", credit, {
					"first-release-date": "2001-05-01",
				}),
				hit("dddddddd-4444-4444-8444-000000000042", "Tie Break", credit, { "first-release-date": "2001" }),
			],
		});
		expect(await resolveReleaseGroupDetailed("Tie Break", "Kraftwerk")).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
		stubMb({
			"release-groups": [
				hit("dddddddd-4444-4444-8444-000000000043", "No Dates", credit),
				hit("dddddddd-4444-4444-8444-000000000044", "No Dates", credit),
			],
		});
		expect((await resolveReleaseGroupDetailed("No Dates", "Kraftwerk")).ambiguous).toBe(true);
	});
});

describe("an undated edition sorts last, not first", () => {
	const ORIGINAL = "eeeeeeee-5555-4555-8555-000000000001";
	const REISSUE = "eeeeeeee-5555-4555-8555-000000000002";
	const label = { id: "eeeeeeee-5555-4555-8555-0000000000a1", name: "Talkin' Loud" };

	/** Answers by path: the undated reissue (`"date": ""`) is listed first, as MB does. */
	function stubEditions(): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				const [, , , kind, id] = input.pathname.split("/");
				if (kind === "release-group") {
					return jsonResponse({
						"primary-type": "Album",
						releases: [
							{ id: REISSUE, date: "" },
							{ id: ORIGINAL, date: "1997-06-23" },
						],
					});
				}
				if (kind === "recording") {
					const group = (title: string) => ({ id: `${title}-rg`, title, "primary-type": "Album" });
					return jsonResponse({
						releases: [
							{ id: REISSUE, date: "", "release-group": group("New Forms (reissue)") },
							{ id: ORIGINAL, date: "1997-06-23", "release-group": group("New Forms") },
						],
					});
				}
				return jsonResponse(
					id === ORIGINAL
						? {
								date: "1997-06-23",
								"label-info": [{ label }],
								media: [{ tracks: [{ id: "t1", recording: { id: "t1", title: "Brown Paper Bag" } }] }],
							}
						: {
								date: "",
								"label-info": [],
								media: [{ tracks: [{ id: "t9", recording: { id: "t9", title: "Reissue Bonus" } }] }],
							},
				);
			}),
		);
	}

	it("gives a project the tracklist and label of its dated first edition", async () => {
		stubEditions();
		const meta = await fetchProjectMetaMb("eeeeeeee-5555-4555-8555-00000000000a");
		expect(meta.tracks.map((t) => t.title)).toEqual(["Brown Paper Bag"]);
		expect(meta.label).toEqual({ mbid: label.id, name: label.name });
	});

	it("gives a track the release group and label of its dated first edition", async () => {
		stubEditions();
		const meta = await fetchTrackMetaMb("eeeeeeee-5555-4555-8555-00000000000b");
		expect(meta.project?.name).toBe("New Forms");
		expect(meta.label).toEqual({ mbid: label.id, name: label.name });
	});
});

describe("a truncated search page decides nothing", () => {
	const MCLUSKY = "ffffffff-6666-4666-8666-000000000001";
	const credit: [string, string][] = [[MCLUSKY, "mclusky"]];

	it("is ambiguous when MB announces more matches than it sent, even if one candidate looks unique", async () => {
		stubMb({
			count: 13,
			recordings: [
				hit("ffffffff-6666-4666-8666-000000000011", "To Hell with Good Intentions", credit),
				...Array.from({ length: 7 }, (_, i) =>
					hit(`ffffffff-6666-4666-8666-0000000001${i}2`, "To Hell with Good Intentions", credit, {
						disambiguation: "live",
					}),
				),
			],
		});
		expect(await resolveRecordingDetailed("To Hell with Good Intentions", "mclusky")).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
	});

	it("is ambiguous for the whole mclusky case: an album recording and a compilation recording", async () => {
		stubMb({
			count: 2,
			recordings: [
				hit("ffffffff-6666-4666-8666-000000000021", "Icct Hedral", credit),
				hit("ffffffff-6666-4666-8666-000000000022", "Icct Hedral", credit),
			],
		});
		expect(await resolveRecordingDetailed("Icct Hedral", "mclusky")).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
	});

	it("is ambiguous for release groups too, and asks for the whole result set", async () => {
		const urls = stubMb({
			count: 11,
			"release-groups": [
				hit("ffffffff-6666-4666-8666-000000000031", "Truncated Title", credit, {
					"first-release-date": "2002",
				}),
			],
		});
		expect(await resolveReleaseGroupDetailed("Truncated Title", "mclusky")).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
		expect(urls[0]?.searchParams.get("limit")).toBe("100");
	});

	it("resolves normally when every match was received", async () => {
		stubMb({
			count: 1,
			recordings: [hit("ffffffff-6666-4666-8666-000000000041", "Complete Page", credit)],
		});
		expect((await resolveRecordingDetailed("Complete Page", "mclusky")).identity?.mbid).toBe(
			"ffffffff-6666-4666-8666-000000000041",
		);
	});
});

// TRA-505 (2026-10-15): the migration could not tell "MusicBrainz knows no such work" from "MusicBrainz
// did not answer", and mistook an outage for a verdict.

describe("an unanswered search is flagged unavailable, a verdict is not", () => {
	const CASES = [
		{ label: "release group", resolve: resolveReleaseGroupDetailed, key: "release-groups" },
		{ label: "recording", resolve: resolveRecordingDetailed, key: "recordings" },
	] as const;
	const down = { identity: null, ambiguous: false, unavailable: true };
	const KRAFTWERK = "cccccccc-3333-4333-8333-0000000000a1";

	for (const { label, resolve, key } of CASES) {
		describe(label, () => {
			it("is unavailable on an HTTP error", async () => {
				vi.stubGlobal(
					"fetch",
					vi.fn(async () => failedResponse(404)),
				);
				expect(await resolve(`Http Error ${label}`, "Anyone")).toEqual(down);
			});

			it("is unavailable on a network error", async () => {
				stubMbNetworkError();
				expect(await resolve(`Network Error ${label}`, "Anyone")).toEqual(down);
			});

			it("is unavailable on a 200 whose body is not JSON", async () => {
				vi.stubGlobal(
					"fetch",
					vi.fn(
						async () =>
							({
								ok: true,
								status: 200,
								json: async () => {
									throw new SyntaxError("Unexpected token < in JSON at position 0");
								},
							}) as unknown as Response,
					),
				);
				expect(await resolve(`Html Page ${label}`, "Anyone")).toEqual(down);
			});

			it("is unavailable on a 200 whose JSON is off schema", async () => {
				stubMb({ [key]: [{ id: "not-an-mbid", title: `Bad Id ${label}` }] });
				expect(await resolve(`Bad Id ${label}`, "Anyone")).toEqual(down);
				stubMb({ unexpected: true });
				expect(await resolve(`No List ${label}`, "Anyone")).toEqual(down);
				stubMb([]);
				expect(await resolve(`Array Body ${label}`, "Anyone")).toEqual(down);
				stubMb(null);
				expect(await resolve(`Null Body ${label}`, "Anyone")).toEqual(down);
			});

			it("is not unavailable when MB answers with no candidate", async () => {
				stubMb({ [key]: [] });
				expect(await resolve(`Unknown To MB ${label}`, "Anyone")).toEqual({
					identity: null,
					ambiguous: false,
					unavailable: false,
				});
			});

			it("is not unavailable when MB answers with look-alikes only", async () => {
				const credit: [string, string][] = [[KRAFTWERK, "Kraftwerk"]];
				stubMb({
					[key]: [
						hit("cccccccc-3333-4333-8333-0000000000b1", `Twins ${label}`, credit),
						hit("cccccccc-3333-4333-8333-0000000000b2", `Twins ${label}`, credit),
					],
				});
				expect(await resolve(`Twins ${label}`, "Kraftwerk")).toEqual({
					identity: null,
					ambiguous: true,
					unavailable: false,
				});
			});

			it("is not unavailable when MB answers but nothing credited matches", async () => {
				stubMb({
					[key]: [hit("cccccccc-3333-4333-8333-0000000000c1", `Other ${label}`, [[KRAFTWERK, "Kraftwerk"]])],
				});
				expect((await resolve(`Wanted ${label}`, "Kraftwerk")).unavailable).toBe(false);
			});
		});
	}

	it("keeps the null-returning wrappers null when MB is down", async () => {
		stubMbNetworkError();
		expect(await resolveReleaseGroup("Wrapped Down", "Anyone")).toBeNull();
		expect(await resolveRecording("Wrapped Down", "Anyone")).toBeNull();
	});
});

describe("a metadata lookup without an answer is flagged unavailable", () => {
	const RG = "dddddddd-5555-4555-8555-0000000000a1";
	const REC = "dddddddd-5555-4555-8555-0000000000a2";
	const label = { id: "dddddddd-5555-4555-8555-0000000000a4", name: "Warp" };
	// mbFetch memoizes successful answers by URL for the whole file: every case reads releases of its own.
	let nextRelease = 0;
	const freshRelease = () => `dddddddd-5555-4555-8555-${String(++nextRelease).padStart(12, "0")}`;

	/** Answers by entity kind; a kind mapped to a function fails (or answers) as that function says. */
	function stubKinds(answers: Record<string, () => Response>): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				const answer = answers[input.pathname.split("/")[3] ?? ""];
				return answer ? answer() : failedResponse(404);
			}),
		);
	}

	const releaseGroupAnswer = (release: string) => () =>
		jsonResponse({ "primary-type": "Album", releases: [{ id: release, date: "2001-01-01" }] });
	const recordingAnswer = (release: string) => () =>
		jsonResponse({
			releases: [
				{
					id: release,
					date: "2001-01-01",
					"release-group": { id: RG, title: "Album", "primary-type": "Album" },
				},
			],
		});
	const releaseAnswer = () =>
		jsonResponse({
			date: "2001-01-01",
			"label-info": [{ label }],
			media: [{ tracks: [{ id: "t1", recording: { id: REC, title: "Opener" } }] }],
		});
	const unreadable = () =>
		({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected end of JSON input");
			},
		}) as unknown as Response;

	it("answers a complete project lookup as available, with the data", async () => {
		stubKinds({ "release-group": releaseGroupAnswer(freshRelease()), release: releaseAnswer });
		const out = await fetchProjectMetaDetailedMb(`${RG}-ok`);
		expect(out.unavailable).toBe(false);
		expect(out.meta.tracks.map((t) => t.title)).toEqual(["Opener"]);
		expect(out.meta.label).toEqual({ mbid: label.id, name: label.name });
	});

	it("flags a project whose release group or release did not answer, whatever the failure", async () => {
		for (const failing of [
			() => failedResponse(404),
			unreadable,
			() => jsonResponse(null),
			() => jsonResponse([]),
			() => jsonResponse({}),
		]) {
			vi.unstubAllGlobals();
			stubKinds({ "release-group": failing, release: releaseAnswer });
			expect((await fetchProjectMetaDetailedMb(freshRelease())).unavailable).toBe(true);
			vi.unstubAllGlobals();
			stubKinds({ "release-group": releaseGroupAnswer(freshRelease()), release: failing });
			expect((await fetchProjectMetaDetailedMb(freshRelease())).unavailable).toBe(true);
		}
	});

	it("does not flag a release group MB knows to have no release: that is an answer", async () => {
		stubKinds({ "release-group": () => jsonResponse({ "primary-type": "Album", releases: [] }) });
		const out = await fetchProjectMetaDetailedMb(freshRelease());
		expect(out.unavailable).toBe(false);
		expect(out.meta.tracks).toEqual([]);
	});

	it("answers a complete track lookup as available, with the data", async () => {
		stubKinds({ recording: recordingAnswer(freshRelease()), release: releaseAnswer });
		const out = await fetchTrackMetaDetailedMb(`${REC}-ok`);
		expect(out.unavailable).toBe(false);
		expect(out.meta.project).toEqual({ mbid: RG, name: "Album" });
		expect(out.meta.label).toEqual({ mbid: label.id, name: label.name });
	});

	it("flags a track whose recording or label lookup did not answer, whatever the failure", async () => {
		for (const failing of [
			() => failedResponse(404),
			unreadable,
			() => jsonResponse(null),
			() => jsonResponse({}),
		]) {
			vi.unstubAllGlobals();
			stubKinds({ recording: failing, release: releaseAnswer });
			expect((await fetchTrackMetaDetailedMb(freshRelease())).unavailable).toBe(true);
			vi.unstubAllGlobals();
			stubKinds({ recording: recordingAnswer(freshRelease()), release: failing });
			const labelDown = await fetchTrackMetaDetailedMb(freshRelease());
			expect(labelDown.unavailable).toBe(true);
			// What was found is still handed over: the caller decides whether a part is enough.
			expect(labelDown.meta.project).toEqual({ mbid: RG, name: "Album" });
		}
	});

	it("does not flag a recording on no release: that is an answer", async () => {
		stubKinds({ recording: () => jsonResponse({ releases: [] }) });
		const out = await fetchTrackMetaDetailedMb(freshRelease());
		expect(out.unavailable).toBe(false);
		expect(out.meta.project).toBeNull();
	});

	it("leaves fetchProjectMetaMb and fetchTrackMetaMb returning the bare metadata", async () => {
		stubKinds({ "release-group": () => failedResponse(404) });
		expect((await fetchProjectMetaMb(freshRelease())).tracks).toEqual([]);
		expect((await fetchTrackMetaMb(freshRelease())).project).toBeNull();
	});
});

// TRA-537: the credit must EQUAL the requested artist, not contain it. Titles, hints and MBIDs are unique
// to this block (mbFetch memoizes by URL).
describe("pickByTitleAndCredit: credit equals the hint", () => {
	const PRINCE = "bbbbbbbb-0000-4000-8000-000000000001";
	const BUSTER = "bbbbbbbb-0000-4000-8000-000000000002";
	const REVOLUTION = "bbbbbbbb-0000-4000-8000-000000000003";
	const PRINCE_AND_REVOLUTION = "bbbbbbbb-0000-4000-8000-000000000004";

	it("does not resolve a work credited to 'Prince Buster' for 'Prince' (sole candidate)", async () => {
		stubMb({
			"release-groups": [
				hit("bbbbbbbb-1111-4111-8111-000000000001", "Judge Dread", [[BUSTER, "Prince Buster"]]),
			],
		});
		const out = await resolveReleaseGroupDetailed("Judge Dread", "Prince");
		expect(out).toEqual({ identity: null, ambiguous: false, unavailable: false });
	});

	it("does not resolve a recording credited to 'Prince Buster' for 'Prince'", async () => {
		stubMb({
			recordings: [hit("bbbbbbbb-1111-4111-8111-000000000002", "Al Capone", [[BUSTER, "Prince Buster"]])],
		});
		expect(await resolveRecording("Al Capone", "Prince")).toBeNull();
	});

	it("picks the work credited to 'Prince' even when a 'Prince Buster' one is older", async () => {
		stubMb({
			"release-groups": [
				hit("bbbbbbbb-1111-4111-8111-000000000003", "Wasted Days", [[BUSTER, "Prince Buster"]], {
					"first-release-date": "1963",
				}),
				hit("bbbbbbbb-1111-4111-8111-000000000004", "Wasted Days", [[PRINCE, "Prince"]], {
					"first-release-date": "1987",
				}),
			],
		});
		expect((await resolveReleaseGroup("Wasted Days", "Prince"))?.mbid).toBe(
			"bbbbbbbb-1111-4111-8111-000000000004",
		);
	});

	it("keeps the tolerance: case, diacritics, '&' / 'and', 'The', credited-as or canonical name", async () => {
		const cases: [title: string, hint: string, name: string, canonical: string][] = [
			["Tolerance Case", "BEYONCE", "Beyoncé", "Beyoncé"],
			["Tolerance And", "Simon and Garfunkel", "Simon & Garfunkel", "Simon & Garfunkel"],
			["Tolerance The One", "Beatles", "The Beatles", "The Beatles"],
			["Tolerance The Two", "The Beatles", "Beatles", "Beatles"],
			["Tolerance Credited As", "The Artist", "The Artist", "Prince"],
			["Tolerance Canonical", "Prince", "The Artist", "Prince"],
		];
		for (const [i, [title, hint, name, canonical]] of cases.entries()) {
			const id = `bbbbbbbb-2222-4222-8222-00000000000${i}`;
			stubMb({
				"release-groups": [
					{ id, title, "artist-credit": [{ name, artist: { id: PRINCE, name: canonical } }] },
				],
			});
			expect((await resolveReleaseGroup(title, hint))?.mbid, `${title} / ${hint}`).toBe(id);
		}
	});

	// Decision (TRA-537): a joint credit is one credited artist per entry, so 'Prince' is credited on a
	// work MB credits to [Prince][The Revolution]. A joint name MB files as ONE artist is another artist
	// ('Prince and the Revolution' has its own MBID): it is not 'Prince', and is refused.
	const jointCredit = [
		{ name: "Prince", joinphrase: " & ", artist: { id: PRINCE, name: "Prince" } },
		{ name: "The Revolution", artist: { id: REVOLUTION, name: "The Revolution" } },
	];

	it("accepts 'Prince' on a joint credit of two entries (Prince + The Revolution)", async () => {
		const id = "bbbbbbbb-3333-4333-8333-000000000001";
		stubMb({ "release-groups": [{ id, title: "Purple Joint", "artist-credit": jointCredit }] });
		const out = await resolveReleaseGroup("Purple Joint", "Prince");
		expect(out?.mbid).toBe(id);
		expect(out?.credit.map((c) => c.mbid)).toEqual([PRINCE, REVOLUTION]);
	});

	it("refuses 'Prince' on a single artist named 'Prince & The Revolution', and accepts that name itself", async () => {
		const id = "bbbbbbbb-3333-4333-8333-000000000002";
		const body = {
			"release-groups": [hit(id, "Purple Single", [[PRINCE_AND_REVOLUTION, "Prince & The Revolution"]])],
		};
		stubMb(body);
		expect(await resolveReleaseGroup("Purple Single", "Prince")).toBeNull();
		stubMb(body);
		expect((await resolveReleaseGroup("Purple Single", "Prince and the Revolution"))?.mbid).toBe(id);
	});

	it("accepts the joint name asked as a whole over two credit entries", async () => {
		const id = "bbbbbbbb-3333-4333-8333-000000000003";
		stubMb({ "release-groups": [{ id, title: "Purple Whole", "artist-credit": jointCredit }] });
		expect((await resolveReleaseGroup("Purple Whole", "Prince & The Revolution"))?.mbid).toBe(id);
	});

	it("refuses a hint that is only a word of a credit ('Fire' on 'Earth, Wind & Fire')", async () => {
		stubMb({
			"release-groups": [
				hit("bbbbbbbb-3333-4333-8333-000000000004", "September Mix", [[BUSTER, "Earth, Wind & Fire"]]),
			],
		});
		expect(await resolveReleaseGroup("September Mix", "Fire")).toBeNull();
	});

	it("no longer resolves a member to its group credit ('Roni Size' on 'Roni Size / Reprazent')", async () => {
		stubMb({
			"release-groups": [
				hit("bbbbbbbb-3333-4333-8333-000000000005", "Group Only", [[REPRAZENT, "Roni Size / Reprazent"]]),
			],
		});
		expect(await resolveReleaseGroup("Group Only", "Roni Size")).toBeNull();
	});
});

// TRA-537, code-review findings: the equality gate must not open for hints it cannot compare.
describe("pickByTitleAndCredit: hints that cannot be compared", () => {
	const OTHER = "cccccccc-0000-4000-8000-000000000001";

	it("never reads a punctuation-only hint as 'no hint': a lone foreign credit is refused", async () => {
		stubMb({
			"release-groups": [hit("cccccccc-1111-4111-8111-000000000001", "Bang Title", [[OTHER, "Somebody"]])],
		});
		expect(await resolveReleaseGroup("Bang Title", "!!!")).toBeNull();
	});

	it("compares a name with letters slug normalization would erase literally ('Mø' is not 'M')", async () => {
		stubMb({
			"release-groups": [hit("cccccccc-1111-4111-8111-000000000002", "Letter Title", [[OTHER, "M"]])],
		});
		expect(await resolveReleaseGroup("Letter Title", "Mø")).toBeNull();
		const id = "cccccccc-1111-4111-8111-000000000003";
		stubMb({ "release-groups": [hit(id, "Letter Title Two", [[OTHER, "Mø"]])] });
		expect((await resolveReleaseGroup("Letter Title Two", "MØ"))?.mbid).toBe(id);
		const sakamoto = "cccccccc-1111-4111-8111-000000000004";
		stubMb({ "release-groups": [hit(sakamoto, "Letter Title Three", [[OTHER, "坂本龍一"]])] });
		expect((await resolveReleaseGroup("Letter Title Three", "坂本龍一"))?.mbid).toBe(sakamoto);
		stubMb({
			"release-groups": [hit("cccccccc-1111-4111-8111-000000000005", "Letter Title Four", [[OTHER, "X"]])],
		});
		expect(await resolveReleaseGroup("Letter Title Four", "Группа X")).toBeNull();
	});

	it("says 'no match', not 'ambiguous', when several look-alikes are all credited to others", async () => {
		stubMb({
			"release-groups": [
				hit("cccccccc-1111-4111-8111-000000000006", "Crowd Title", [[OTHER, "Act One"]]),
				hit("cccccccc-1111-4111-8111-000000000007", "Crowd Title", [[OTHER, "Act Two"]]),
			],
		});
		expect(await resolveReleaseGroupDetailed("Crowd Title", "Act Three")).toEqual({
			identity: null,
			ambiguous: false,
			unavailable: false,
		});
	});

	it("counts a featured artist as credited ('Jay-Z' on 'Beyoncé feat. Jay-Z'), the credit says who", async () => {
		const id = "cccccccc-1111-4111-8111-000000000008";
		stubMb({
			recordings: [
				{
					id,
					title: "Feat Title",
					"artist-credit": [
						{ name: "Beyoncé", joinphrase: " feat. ", artist: { id: OTHER, name: "Beyoncé" } },
						{ name: "Jay-Z", artist: { id: "cccccccc-0000-4000-8000-000000000002", name: "Jay-Z" } },
					],
				},
			],
		});
		const out = await resolveRecording("Feat Title", "Jay-Z");
		expect(out?.mbid).toBe(id);
		expect(out?.credit.map((c) => c.name)).toEqual(["Beyoncé", "Jay-Z"]);
	});
});

describe("pickByTitleAndCredit: aliases of the credited artist", () => {
	const ARTIST = "dddddddd-0000-4000-8000-000000000001";
	const credit = (aliases: unknown) => [
		{ name: "Sasha & John Digweed", artist: { id: ARTIST, name: "Sasha & John Digweed", aliases } },
	];

	it("accepts a hint spelled as an alias of the credited artist", async () => {
		const id = "dddddddd-1111-4111-8111-000000000001";
		stubMb({
			"release-groups": [
				{ id, title: "Alias Title", "artist-credit": credit([{ name: "Sasha + John Digweed" }]) },
			],
		});
		expect((await resolveReleaseGroup("Alias Title", "Sasha + John Digweed"))?.mbid).toBe(id);
	});

	it("ignores malformed aliases and never takes an alias word for a match", async () => {
		stubMb({
			"release-groups": [
				{
					id: "dddddddd-1111-4111-8111-000000000002",
					title: "Alias Title Two",
					"artist-credit": credit([{ name: 42 }, "junk", null, { name: "Sasha + John Digweed" }]),
				},
			],
		});
		expect(await resolveReleaseGroup("Alias Title Two", "John Digweed")).toBeNull();
	});
});

// TRA-537 deep review (B1, N1): a set-aside candidate that names the artist in a joint credit is doubt, not noise.
describe("pickByTitleAndCredit: set-aside joint credits and truncated aliases", () => {
	const ALVA = "eeeeeeee-0000-4000-8000-000000000001";
	const SAKAMOTO = "eeeeeeee-0000-4000-8000-000000000002";
	const DUO = "eeeeeeee-0000-4000-8000-000000000003";
	const RS = "eeeeeeee-0000-4000-8000-000000000004";
	const REPRAZ = "eeeeeeee-0000-4000-8000-000000000005";
	const GROUP = "eeeeeeee-0000-4000-8000-000000000006";

	it("is ambiguous, not the duplicate, when the canonical recording is credited to a duo naming the artist (Uoon II)", async () => {
		stubMb({
			recordings: [
				hit("eeeeeeee-1111-4111-8111-000000000001", "Uoon II Test", [[DUO, "Alva Noto + Ryuichi Sakamoto"]], {
					"first-release-date": "2002",
				}),
				hit(
					"eeeeeeee-1111-4111-8111-000000000002",
					"Uoon II Test",
					[
						[SAKAMOTO, "坂本龍一"],
						[ALVA, "Alva Noto"],
					],
					{ "first-release-date": "2022" },
				),
			],
		});
		expect(await resolveRecordingDetailed("Uoon II Test", "Alva Noto")).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
	});

	it("is ambiguous, not the reissue, when the original is credited to a group naming the artist", async () => {
		stubMb({
			"release-groups": [
				hit("eeeeeeee-1111-4111-8111-000000000003", "Reissue Test", [[GROUP, "Roni Size / Reprazent"]], {
					"first-release-date": "1997",
				}),
				hit(
					"eeeeeeee-1111-4111-8111-000000000004",
					"Reissue Test",
					[
						[RS, "Roni Size"],
						[REPRAZ, "Reprazent"],
					],
					{ "first-release-date": "2008" },
				),
			],
		});
		expect(await resolveReleaseGroupDetailed("Reissue Test", "Roni Size")).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
	});

	it("ignores an alias that is a truncation of the printed name ('Cam' for 'DJ Cam')", async () => {
		const withAlias = (name: string) => [
			{ name: "DJ Cam", artist: { id: DUO, name: "DJ Cam", aliases: [{ name }] } },
		];
		stubMb({
			"release-groups": [
				{ id: "eeeeeeee-1111-4111-8111-000000000005", title: "Cam Test", "artist-credit": withAlias("Cam") },
			],
		});
		expect(await resolveReleaseGroup("Cam Test", "Cam")).toBeNull();
		const id = "eeeeeeee-1111-4111-8111-000000000006";
		stubMb({ "release-groups": [{ id, title: "Cam Test Two", "artist-credit": withAlias("Camille D") }] });
		expect((await resolveReleaseGroup("Cam Test Two", "Camille D"))?.mbid).toBe(id);
	});
});

describe("work resolvers: credits accepted by MBID (TRA-539)", () => {
	const RONI = "ffffffff-0000-4000-8000-000000000001";
	const REPRAZENT_BAND = "ffffffff-0000-4000-8000-000000000002";
	const OTHER_BAND = "ffffffff-0000-4000-8000-000000000003";
	const NEW_FORMS = "ffffffff-1111-4111-8111-000000000001";
	const none = { identity: null, ambiguous: false, unavailable: false };
	const ambiguous = { identity: null, ambiguous: true, unavailable: false };

	it("resolves a work credited to a band whose MBID is listed", async () => {
		stubMb({
			"release-groups": [
				hit(NEW_FORMS, "New Forms", [[REPRAZENT_BAND, "Roni Size / Reprazent"]], {
					"first-release-date": "1997-06-23",
					"primary-type": "Album",
				}),
			],
		});
		const out = await resolveReleaseGroupDetailed("New Forms", "Roni Size", {
			acceptCreditMbids: [REPRAZENT_BAND],
		});
		expect(out.identity?.mbid).toBe(NEW_FORMS);
		expect(out.identity?.credit).toEqual([{ mbid: REPRAZENT_BAND, name: "Roni Size / Reprazent" }]);
	});

	it("compares the MBIDs without regard to case", async () => {
		stubMb({ recordings: [hit(NEW_FORMS, "Heroes", [[REPRAZENT_BAND, "Roni Size / Reprazent"]])] });
		const out = await resolveRecordingDetailed("Heroes", "Roni Size", {
			acceptCreditMbids: [REPRAZENT_BAND.toUpperCase()],
		});
		expect(out.identity?.mbid).toBe(NEW_FORMS);
	});

	it("does not accept the band by name: without the option, or with another band's MBID", async () => {
		stubMb({ "release-groups": [hit(NEW_FORMS, "New Forms", [[REPRAZENT_BAND, "Roni Size / Reprazent"]])] });
		expect(await resolveReleaseGroupDetailed("New Forms", "Roni Size")).toEqual(none);
		expect(await resolveReleaseGroupDetailed("New Forms", "Roni Size", { acceptCreditMbids: [] })).toEqual(
			none,
		);
		expect(
			await resolveReleaseGroupDetailed("New Forms", "Roni Size", { acceptCreditMbids: [OTHER_BAND] }),
		).toEqual(none);
	});

	it("never accepts a credit that merely contains the artist's name (Prince / Prince Buster)", async () => {
		const buster = "ffffffff-0000-4000-8000-000000000004";
		stubMb({ recordings: [hit(NEW_FORMS, "One Step Beyond", [[buster, "Prince Buster"]])] });
		const out = await resolveRecordingDetailed("One Step Beyond", "Prince", {
			acceptCreditMbids: [OTHER_BAND],
		});
		expect(out).toEqual(none);
	});

	it("is ambiguous when one candidate is credited to the artist and another to the band (Uoon II)", async () => {
		stubMb({
			recordings: [
				hit(
					"ffffffff-1111-4111-8111-000000000002",
					"Uoon II Test",
					[[REPRAZENT_BAND, "Alva Noto + Ryuichi Sakamoto"]],
					{ "first-release-date": "2002" },
				),
				hit(
					"ffffffff-1111-4111-8111-000000000003",
					"Uoon II Test",
					[
						[OTHER_BAND, "坂本龍一"],
						[RONI, "Alva Noto"],
					],
					{ "first-release-date": "2022" },
				),
			],
		});
		expect(
			await resolveRecordingDetailed("Uoon II Test", "Alva Noto", { acceptCreditMbids: [REPRAZENT_BAND] }),
		).toEqual(ambiguous);
	});

	it("is ambiguous, not the earlier original, for a release group with a direct and a band-credited candidate", async () => {
		stubMb({
			"release-groups": [
				hit(
					"ffffffff-1111-4111-8111-000000000004",
					"Reissue Test",
					[[REPRAZENT_BAND, "Roni Size / Reprazent"]],
					{ "first-release-date": "1997" },
				),
				hit(
					"ffffffff-1111-4111-8111-000000000005",
					"Reissue Test",
					[
						[RONI, "Roni Size"],
						[OTHER_BAND, "Reprazent"],
					],
					{ "first-release-date": "2008" },
				),
			],
		});
		expect(
			await resolveReleaseGroupDetailed("Reissue Test", "Roni Size", { acceptCreditMbids: [REPRAZENT_BAND] }),
		).toEqual(ambiguous);
	});

	describe("requestedArtistMbid and two bands (TRA-552)", () => {
		const PRESENTS = "ffffffff-1111-4111-8111-0000000000a1";
		const BAND_WORK = "ffffffff-1111-4111-8111-0000000000a2";
		const OLDER = "ffffffff-1111-4111-8111-0000000000a3";
		const NEWER = "ffffffff-1111-4111-8111-0000000000a4";

		// "Roni Size Presents" is not the hint and no segment of it either: by name alone the artist's own
		// work vanished and the band's work of the same title won.
		const fixture = () =>
			stubMb({
				recordings: [
					hit(PRESENTS, "X Test", [[RONI, "Roni Size Presents"]], { "first-release-date": "2000" }),
					hit(BAND_WORK, "X Test", [[REPRAZENT_BAND, "Roni Size / Reprazent"]], {
						"first-release-date": "1999",
					}),
				],
			});

		it("documents the gap: without the artist's MBID the band's work wins", async () => {
			fixture();
			const out = await resolveRecordingDetailed("X Test", "Roni Size", {
				acceptCreditMbids: [REPRAZENT_BAND],
			});
			expect(out.identity?.mbid).toBe(BAND_WORK);
		});

		it("is ambiguous, not the band's work, when the artist's own work is printed under another name", async () => {
			fixture();
			expect(
				await resolveRecordingDetailed("X Test", "Roni Size", {
					acceptCreditMbids: [REPRAZENT_BAND],
					requestedArtistMbid: RONI,
				}),
			).toEqual(ambiguous);
		});

		it("compares the requested MBID without regard to case, on release groups too", async () => {
			stubMb({
				"release-groups": [
					hit(PRESENTS, "X Test", [[RONI, "Roni Size Presents"]]),
					hit(BAND_WORK, "X Test", [[REPRAZENT_BAND, "Roni Size / Reprazent"]]),
				],
			});
			expect(
				await resolveReleaseGroupDetailed("X Test", "Roni Size", {
					acceptCreditMbids: [REPRAZENT_BAND],
					requestedArtistMbid: RONI.toUpperCase(),
				}),
			).toEqual(ambiguous);
		});

		it("resolves the artist's own work printed under another name when no band competes", async () => {
			stubMb({ recordings: [hit(PRESENTS, "Y Test", [[RONI, "Roni Size Presents"]])] });
			expect(
				(await resolveRecordingDetailed("Y Test", "Roni Size", { requestedArtistMbid: RONI })).identity?.mbid,
			).toBe(PRESENTS);
			expect(await resolveRecordingDetailed("Y Test", "Roni Size")).toEqual(none);
		});

		it("never reads another artist's MBID as the requested one", async () => {
			stubMb({ recordings: [hit(PRESENTS, "Z Test", [[RONI, "Roni Size Presents"]])] });
			expect(
				await resolveRecordingDetailed("Z Test", "Roni Size", { requestedArtistMbid: OTHER_BAND }),
			).toEqual(none);
		});

		it("is ambiguous when two different accepted bands each have a work of the title (recording)", async () => {
			stubMb({
				recordings: [
					hit(OLDER, "Twin Test", [[REPRAZENT_BAND, "Roni Size / Reprazent"]], {
						"first-release-date": "1997",
					}),
					hit(NEWER, "Twin Test", [[OTHER_BAND, "Another Band"]], { "first-release-date": "2005" }),
				],
			});
			expect(
				await resolveRecordingDetailed("Twin Test", "Roni Size", {
					acceptCreditMbids: [REPRAZENT_BAND, OTHER_BAND],
				}),
			).toEqual(ambiguous);
		});

		it("is ambiguous, not the oldest, when two different accepted bands each have a release group of the title", async () => {
			stubMb({
				"release-groups": [
					hit(OLDER, "Twin Test", [[REPRAZENT_BAND, "Roni Size / Reprazent"]], {
						"first-release-date": "1997",
					}),
					hit(NEWER, "Twin Test", [[OTHER_BAND, "Another Band"]], { "first-release-date": "2005" }),
				],
			});
			expect(
				await resolveReleaseGroupDetailed("Twin Test", "Roni Size", {
					acceptCreditMbids: [REPRAZENT_BAND, OTHER_BAND],
				}),
			).toEqual(ambiguous);
		});

		it("still takes the earliest release group when both candidates belong to the same accepted band", async () => {
			stubMb({
				"release-groups": [
					hit(OLDER, "Twin Same Band", [[REPRAZENT_BAND, "Roni Size / Reprazent"]], {
						"first-release-date": "1997",
					}),
					hit(NEWER, "Twin Same Band", [[REPRAZENT_BAND, "Reprazent"]], { "first-release-date": "2005" }),
				],
			});
			const out = await resolveReleaseGroupDetailed("Twin Same Band", "Roni Size", {
				acceptCreditMbids: [REPRAZENT_BAND, OTHER_BAND],
			});
			expect(out.identity?.mbid).toBe(OLDER);
		});

		it("resolves when only one of the listed bands has a work of the title", async () => {
			stubMb({ "release-groups": [hit(OLDER, "Twin Lone", [[REPRAZENT_BAND, "Roni Size / Reprazent"]])] });
			const out = await resolveReleaseGroupDetailed("Twin Lone", "Roni Size", {
				acceptCreditMbids: [REPRAZENT_BAND, OTHER_BAND],
			});
			expect(out.identity?.mbid).toBe(OLDER);
		});
	});

	it("still picks the one direct candidate when no band-credited candidate exists", async () => {
		const id = "ffffffff-1111-4111-8111-000000000006";
		stubMb({
			"release-groups": [
				hit(id, "Solo", [[RONI, "Roni Size"]]),
				hit("ffffffff-1111-4111-8111-000000000007", "Solo", [[OTHER_BAND, "Elsewhere"]]),
			],
		});
		const out = await resolveReleaseGroupDetailed("Solo", "Roni Size", {
			acceptCreditMbids: [REPRAZENT_BAND],
		});
		expect(out.identity?.mbid).toBe(id);
	});
});

// TRA-560: a single released before the album of the same name must not give the album its MBID.
// The MBIDs keep the prefix of the two real cases found in the TRA-483 deep review; the rest is made up.
describe("pickByTitleAndCredit: release groups of different primary types", () => {
	const INTER_ARMA = "abababab-0560-4560-8560-000000000001";
	const ARETHA = "abababab-0560-4560-8560-000000000002";
	const NEW_HEAVEN_SINGLE = "2da5680f-0560-4560-8560-000000000001";
	const NEW_HEAVEN_ALBUM = "763aa505-0560-4560-8560-000000000001";
	const NEVER_LOVED_SINGLE = "c1efa6b7-0560-4560-8560-000000000001";
	const NEVER_LOVED_ALBUM = "7d8f07a7-0560-4560-8560-000000000001";
	const NEVER_LOVED = "I Never Loved a Man the Way I Love You";
	const none = { identity: null, ambiguous: false, unavailable: false };
	const ambiguous = { identity: null, ambiguous: true, unavailable: false };

	const newHeaven = () =>
		stubMb({
			"release-groups": [
				hit(NEW_HEAVEN_SINGLE, "New Heaven", [[INTER_ARMA, "Inter Arma"]], {
					"primary-type": "Single",
					"first-release-date": "2024-02-27",
				}),
				hit(NEW_HEAVEN_ALBUM, "New Heaven", [[INTER_ARMA, "Inter Arma"]], {
					"primary-type": "Album",
					"first-release-date": "2024-04-26",
				}),
			],
		});
	const neverLoved = () =>
		stubMb({
			"release-groups": [
				hit(NEVER_LOVED_ALBUM, NEVER_LOVED, [[ARETHA, "Aretha Franklin"]], {
					"primary-type": "Album",
					"first-release-date": "1967-03-10",
				}),
				hit(NEVER_LOVED_SINGLE, NEVER_LOVED, [[ARETHA, "Aretha Franklin"]], {
					"primary-type": "Single",
					"first-release-date": "1967-02-10",
				}),
			],
		});

	it("gives the album its own MBID, not its older single's, when the node says it is an album", async () => {
		newHeaven();
		const first = await resolveReleaseGroupDetailed("New Heaven", "Inter Arma", { releaseType: "album" });
		expect(first.identity?.mbid).toBe(NEW_HEAVEN_ALBUM);
		expect(first.identity?.primaryType).toBe("Album");
		neverLoved();
		const second = await resolveReleaseGroupDetailed(NEVER_LOVED, "Aretha Franklin", {
			releaseType: "album",
		});
		expect(second.identity?.mbid).toBe(NEVER_LOVED_ALBUM);
	});

	it("keeps the single's MBID for a work requested as a single", async () => {
		newHeaven();
		expect(
			(await resolveReleaseGroupDetailed("New Heaven", "Inter Arma", { releaseType: "single" })).identity
				?.mbid,
		).toBe(NEW_HEAVEN_SINGLE);
		neverLoved();
		expect(
			(await resolveReleaseGroupDetailed(NEVER_LOVED, "Aretha Franklin", { releaseType: "Single" })).identity
				?.mbid,
		).toBe(NEVER_LOVED_SINGLE);
	});

	it("is ambiguous, never the older one, when the release type is not known", async () => {
		newHeaven();
		expect(await resolveReleaseGroupDetailed("New Heaven", "Inter Arma")).toEqual(ambiguous);
		neverLoved();
		expect(await resolveReleaseGroupDetailed(NEVER_LOVED, "Aretha Franklin")).toEqual(ambiguous);
		// A blank type is not a type.
		newHeaven();
		expect(await resolveReleaseGroupDetailed("New Heaven", "Inter Arma", { releaseType: " " })).toEqual(
			ambiguous,
		);
	});

	it("is ambiguous when the type the node knows is none of the candidates' types", async () => {
		newHeaven();
		expect(await resolveReleaseGroupDetailed("New Heaven", "Inter Arma", { releaseType: "ep" })).toEqual(
			ambiguous,
		);
	});

	it("takes the node's type even when another type is older or the node's own is undated", async () => {
		stubMb({
			"release-groups": [
				hit(NEW_HEAVEN_SINGLE, "Typed Pick", [[INTER_ARMA, "Inter Arma"]], { "primary-type": "Single" }),
				hit("763aa505-0560-4560-8560-000000000002", "Typed Pick", [[INTER_ARMA, "Inter Arma"]], {
					"primary-type": "EP",
					"first-release-date": "2001-01-01",
				}),
				hit(NEW_HEAVEN_ALBUM, "Typed Pick", [[INTER_ARMA, "Inter Arma"]], { "primary-type": "Album" }),
			],
		});
		expect(
			(await resolveReleaseGroupDetailed("Typed Pick", "Inter Arma", { releaseType: "album" })).identity
				?.mbid,
		).toBe(NEW_HEAVEN_ALBUM);
	});

	it("still tells an original from its reissue by date when both have the node's type", async () => {
		const reissue = "763aa505-0560-4560-8560-000000000003";
		stubMb({
			"release-groups": [
				hit(reissue, "New Heaven", [[INTER_ARMA, "Inter Arma"]], {
					"primary-type": "Album",
					"first-release-date": "2019-01-01",
				}),
				hit(NEW_HEAVEN_SINGLE, "New Heaven", [[INTER_ARMA, "Inter Arma"]], {
					"primary-type": "Single",
					"first-release-date": "2018-01-01",
				}),
				hit(NEW_HEAVEN_ALBUM, "New Heaven", [[INTER_ARMA, "Inter Arma"]], {
					"primary-type": "Album",
					"first-release-date": "2018-06-01",
				}),
			],
		});
		// With the type: the oldest ALBUM, not the older single.
		expect(
			(await resolveReleaseGroupDetailed("New Heaven", "Inter Arma", { releaseType: "album" })).identity
				?.mbid,
		).toBe(NEW_HEAVEN_ALBUM);
		// Without it the types differ: no date decides.
		expect((await resolveReleaseGroupDetailed("New Heaven", "Inter Arma")).ambiguous).toBe(true);
	});

	it("keeps the oldest-wins rule among candidates of one type, whatever the node says", async () => {
		const original = "763aa505-0560-4560-8560-000000000004";
		const reissue = "763aa505-0560-4560-8560-000000000005";
		const stub = () =>
			stubMb({
				"release-groups": [
					hit(reissue, "Same Type", [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"first-release-date": "2012-05-05",
					}),
					hit(original, "Same Type", [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"first-release-date": "1999-05-05",
					}),
				],
			});
		stub();
		expect((await resolveReleaseGroupDetailed("Same Type", "Inter Arma")).identity?.mbid).toBe(original);
		stub();
		expect(
			(await resolveReleaseGroupDetailed("Same Type", "Inter Arma", { releaseType: "album" })).identity?.mbid,
		).toBe(original);
		// A node known as a single never takes an album, even when the albums agree among themselves.
		stub();
		expect(await resolveReleaseGroupDetailed("Same Type", "Inter Arma", { releaseType: "single" })).toEqual(
			ambiguous,
		);
	});

	it("never gives a node of a known type the MBID of another type, a lone candidate included", async () => {
		const lone = (title: string, type: string) =>
			stubMb({
				"release-groups": [
					hit("763aa505-0560-4560-8560-000000000010", title, [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": type,
						"first-release-date": "2024-02-27",
					}),
				],
			});
		// An album node whose only candidate is a single.
		lone("Lone Single", "Single");
		expect(await resolveReleaseGroupDetailed("Lone Single", "Inter Arma", { releaseType: "album" })).toEqual(
			ambiguous,
		);
		// The same candidate for a node that agrees, or that knows nothing, is still taken.
		lone("Lone Single", "Single");
		expect(
			(await resolveReleaseGroupDetailed("Lone Single", "Inter Arma", { releaseType: "Single" })).identity
				?.mbid,
		).toBe("763aa505-0560-4560-8560-000000000010");
		lone("Lone Single Two", "Single");
		expect((await resolveReleaseGroupDetailed("Lone Single Two", "Inter Arma")).identity?.mbid).toBe(
			"763aa505-0560-4560-8560-000000000010",
		);
		// A candidate with no primary type has no type to agree with the node's.
		stubMb({
			"release-groups": [
				hit("763aa505-0560-4560-8560-000000000011", "Untyped Lone", [[INTER_ARMA, "Inter Arma"]]),
			],
		});
		expect(await resolveReleaseGroupDetailed("Untyped Lone", "Inter Arma", { releaseType: "album" })).toEqual(
			ambiguous,
		);
	});

	// MB files a compilation (or a live album, a soundtrack...) as primary "Album" plus a secondary type;
	// there is no "Compilation" primary type.
	describe("secondary types", () => {
		const compilation = "763aa505-0560-4560-8560-000000000020";
		const album = "763aa505-0560-4560-8560-000000000021";
		const stubCompilation = (title: string) =>
			stubMb({
				"release-groups": [
					hit(compilation, title, [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"secondary-types": ["Compilation"],
						"first-release-date": "2001-01-01",
					}),
					hit(album, title, [[INTER_ARMA, "Inter Arma"]], { "primary-type": "Album" }),
				],
			});

		it("does not let a dated compilation beat an undated album of the same primary type", async () => {
			stubCompilation("Best Of Nothing");
			expect(await resolveReleaseGroupDetailed("Best Of Nothing", "Inter Arma")).toEqual(ambiguous);
		});

		it("stays ambiguous when the node names a primary type only", async () => {
			stubCompilation("Best Of Nothing Two");
			expect(
				await resolveReleaseGroupDetailed("Best Of Nothing Two", "Inter Arma", { releaseType: "album" }),
			).toEqual(ambiguous);
		});

		it("is ambiguous between a live album and a studio album, whatever their dates", async () => {
			stubMb({
				"release-groups": [
					hit(album, "Live Or Not", [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"secondary-types": [],
						"first-release-date": "1999-01-01",
					}),
					hit(compilation, "Live Or Not", [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"secondary-types": ["Live"],
						"first-release-date": "1998-01-01",
					}),
				],
			});
			expect(await resolveReleaseGroupDetailed("Live Or Not", "Inter Arma")).toEqual(ambiguous);
		});

		it("still tells an original from its reissue when the secondary types agree", async () => {
			stubMb({
				"release-groups": [
					hit(album, "Same Secondary", [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"secondary-types": ["Live"],
						"first-release-date": "2005-01-01",
					}),
					hit(compilation, "Same Secondary", [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"secondary-types": ["live"],
						"first-release-date": "1999-01-01",
					}),
				],
			});
			expect((await resolveReleaseGroupDetailed("Same Secondary", "Inter Arma")).identity?.mbid).toBe(
				compilation,
			);
		});

		// MB always sends an array. Anything else is off schema: like a malformed primary-type, it makes the
		// whole answer unusable (an outage, not a verdict) instead of being read as "no secondary type", which
		// let a live album marked `"secondary-types": "Live"` pass for a studio one (TRA-566).
		it.each([
			["a string", "Live"],
			["an object", { 0: "Live" }],
			["an array holding a non-string", [null, 3]],
			["an array mixing strings and a non-string", ["Live", 3]],
			["null", null],
			["an array holding a blank name", [""]],
			["an array holding an untrimmed name", [" Live "]],
		])("never keeps a release group whose secondary-types is %s", async (shape, secondaryTypes) => {
			const title = `Odd Shape ${shape}`;
			stubMb({
				"release-groups": [
					hit(album, title, [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"secondary-types": secondaryTypes,
						"first-release-date": "1999-01-01",
					}),
					hit(compilation, title, [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"first-release-date": "2005-01-01",
					}),
				],
			});
			expect(await resolveReleaseGroupDetailed(title, "Inter Arma")).toEqual({
				identity: null,
				ambiguous: false,
				unavailable: true,
			});
		});

		// Same all-or-nothing rule as a malformed primary-type: the autocomplete shares the parser, so it
		// answers nothing rather than a list that holds an unreadable hit.
		it("blanks the project autocomplete on an off-shape secondary-types, like on an off-shape primary-type", async () => {
			stubMb({
				"release-groups": [
					hit(album, "Odd Autocomplete", [[INTER_ARMA, "Inter Arma"]], { "secondary-types": "Live" }),
				],
			});
			expect(await createMusicBrainzCatalog().searchByType("project", "Odd Autocomplete", 5)).toEqual([]);
		});

		it("still takes a release group whose secondary-types is absent or an empty array", async () => {
			stubMb({
				"release-groups": [
					hit(album, "Well Formed", [[INTER_ARMA, "Inter Arma"]], {
						"primary-type": "Album",
						"secondary-types": [],
					}),
				],
			});
			expect((await resolveReleaseGroupDetailed("Well Formed", "Inter Arma")).identity?.mbid).toBe(album);
		});
	});

	it("does not take a candidate with no primary type for the same type as a typed one", async () => {
		stubMb({
			"release-groups": [
				hit(NEW_HEAVEN_SINGLE, "New Heaven", [[INTER_ARMA, "Inter Arma"]], {
					"first-release-date": "2024-02-27",
				}),
				hit(NEW_HEAVEN_ALBUM, "New Heaven", [[INTER_ARMA, "Inter Arma"]], {
					"primary-type": "Album",
					"first-release-date": "2024-04-26",
				}),
			],
		});
		expect(await resolveReleaseGroupDetailed("New Heaven", "Inter Arma")).toEqual(ambiguous);
	});

	it("leaves recordings alone: the release type is a release-group notion", async () => {
		stubMb({
			recordings: [hit("dddddddd-0560-4560-8560-000000000001", "New Heaven", [[INTER_ARMA, "Inter Arma"]])],
		});
		const out = await resolveRecordingDetailed("New Heaven", "Inter Arma", { releaseType: "album" });
		expect(out.identity?.mbid).toBe("dddddddd-0560-4560-8560-000000000001");
		stubMb({ "release-groups": [] });
		expect(await resolveReleaseGroupDetailed("Nothing Here", "Inter Arma", { releaseType: "album" })).toEqual(
			none,
		);
	});
});

// TRA-604: `project:wish-you-were-here--american-hot-wax` carried the MBID of a 2001 release by American Hot Wax
// although its article is Pink Floyd's album, and `track:around-the-world--stanley-black-and-his-orchestra` the one
// of a 1958 recording. The identity backfill had picked the release on the title. The resolver now has to ask for
// the artist's credit: a look-alike of the same title credited to somebody else is never an answer.
describe("work resolvers: a homonym's work of the same title is never the answer (TRA-604)", () => {
	const PINK_FLOYD = "cccccccc-0604-4604-8604-000000000001";
	const AMERICAN_HOT_WAX = "cccccccc-0604-4604-8604-000000000002";
	const DAFT_PUNK = "cccccccc-0604-4604-8604-000000000003";
	const STANLEY_BLACK = "cccccccc-0604-4604-8604-000000000004";
	const HOT_WAX_RG = "217d2789-9121-3407-be70-73b0e3c5826e";
	const FLOYD_RG = "cccccccc-0604-4604-8604-000000000011";
	const BLACK_REC = "cccccccc-0604-4604-8604-000000000021";
	const DAFT_REC = "cccccccc-0604-4604-8604-000000000022";
	const none = { identity: null, ambiguous: false, unavailable: false };
	const hotWaxRelease = () =>
		hit(HOT_WAX_RG, "Wish You Were Here", [[AMERICAN_HOT_WAX, "American Hot Wax"]], {
			"primary-type": "EP",
			"first-release-date": "2001-05-01",
		});
	const blackRecording = () =>
		hit(BLACK_REC, "Around the World", [[STANLEY_BLACK, "Stanley Black & His Orchestra"]], {
			"first-release-date": "1958",
		});

	it("does not give 'Wish You Were Here' by Pink Floyd the release of American Hot Wax", async () => {
		// MB answered with the homonym's release only: for Pink Floyd that is no work at all, not the work.
		stubMb({ "release-groups": [hotWaxRelease()] });
		expect(await resolveReleaseGroupDetailed("Wish You Were Here", "Pink Floyd")).toEqual(none);
		expect(
			await resolveReleaseGroupDetailed("Wish You Were Here", "Pink Floyd", {
				requestedArtistMbid: PINK_FLOYD,
				releaseType: "album",
			}),
		).toEqual(none);
	});

	it("picks Pink Floyd's own release when both are in the answer, and each artist gets its own", async () => {
		stubMb({
			"release-groups": [
				{ ...hotWaxRelease(), "first-release-date": "1999-01-01" },
				hit(FLOYD_RG, "Wish You Were Here", [[PINK_FLOYD, "Pink Floyd"]], {
					"primary-type": "Album",
					"first-release-date": "1975-09-12",
				}),
			],
		});
		// mbFetch memoizes by URL for the whole file: another spelling of the hint (the credit comparison ignores
		// case) is another request, so the answer stubbed above is the one this test gets.
		const floyd = await resolveReleaseGroupDetailed("Wish You Were Here", "PINK FLOYD", {
			requestedArtistMbid: PINK_FLOYD,
		});
		expect(floyd.identity?.mbid).toBe(FLOYD_RG);
		expect(floyd.identity?.credit).toEqual([{ mbid: PINK_FLOYD, name: "Pink Floyd" }]);
		const hotWax = await resolveReleaseGroupDetailed("Wish You Were Here", "American Hot Wax");
		expect(hotWax.identity?.mbid).toBe(HOT_WAX_RG);
	});

	it("takes the studio album over its compilation, live and singles only when asked to (preferPlainRelease)", async () => {
		// The shape MB answers for Pink Floyd on 2026-10-18: one plain Album, a 2013 compilation, two singles.
		const releases = () => ({
			"release-groups": [
				hit(FLOYD_RG, "Wish You Were Here", [[PINK_FLOYD, "Pink Floyd"]], {
					"primary-type": "Album",
					"first-release-date": "1975-09-12",
				}),
				hit("cccccccc-0604-4604-8604-000000000031", "Wish You Were Here", [[PINK_FLOYD, "Pink Floyd"]], {
					"primary-type": "Album",
					"secondary-types": ["Compilation"],
					"first-release-date": "2013",
				}),
				hit("cccccccc-0604-4604-8604-000000000032", "Wish You Were Here", [[PINK_FLOYD, "Pink Floyd"]], {
					"primary-type": "Single",
					"first-release-date": "2013-06-14",
				}),
			],
		});
		stubMb(releases());
		// Default: look-alikes of the same type that differ in secondary types stay a doubt (TRA-560).
		expect(
			await resolveReleaseGroupDetailed("Wish You Were Here", "pink floyd", { releaseType: "album" }),
		).toEqual({
			identity: null,
			ambiguous: true,
			unavailable: false,
		});
		stubMb(releases());
		const plain = await resolveReleaseGroupDetailed("Wish You Were Here", "PiNk FlOyD", {
			releaseType: "album",
			preferPlainRelease: true,
		});
		expect(plain.identity?.mbid).toBe(FLOYD_RG);
		// Without a known type the option decides nothing: an album and a single are still told apart by the caller.
		stubMb(releases());
		expect(
			(await resolveReleaseGroupDetailed("Wish You Were Here", "PINK floyd", { preferPlainRelease: true }))
				.ambiguous,
		).toBe(true);
	});

	it("does not give Daft Punk's 'Around the World' the recording of Stanley Black and His Orchestra", async () => {
		stubMb({ recordings: [blackRecording()] });
		expect(await resolveRecordingDetailed("Around the World", "Daft Punk")).toEqual(none);
		stubMb({
			recordings: [
				blackRecording(),
				hit(DAFT_REC, "Around the World", [[DAFT_PUNK, "Daft Punk"]], { "first-release-date": "1997-01-20" }),
			],
		});
		expect((await resolveRecordingDetailed("Around the World", "DAFT PUNK")).identity?.mbid).toBe(DAFT_REC);
	});
});

// TRA-614 (plan 8-D2): the discography reads the artist credits and says when a page got no answer.
describe("fetchArtistDiscographyMb: credits and unavailability", () => {
	const KODE9 = "aaaaaaaa-6666-4666-8666-000000000001";
	const SPACEAPE = "aaaaaaaa-6666-4666-8666-000000000002";
	// mbFetch memoizes successful answers by URL for the whole file: every case browses an artist of its own.
	let nextArtist = 0;
	const freshArtist = () => `bbbbbbbb-6666-4666-8666-${String(++nextArtist).padStart(12, "0")}`;
	const rgId = (n: number) => `cccccccc-6666-4666-8666-${String(n).padStart(12, "0")}`;
	const credit = (mbid: string, name: string) => ({ name, artist: { id: mbid, name } });
	const rg = (n: number, extra: Record<string, unknown> = {}) => ({
		id: rgId(n),
		title: `Record ${n}`,
		"primary-type": "Album",
		"first-release-date": "2010-01-01",
		...extra,
	});

	interface Browse {
		type: string;
		offset: number;
		url: URL;
	}
	/** Answers every browse page with `answer(browse)`; returns the browses seen, in request order. */
	function stubBrowse(answer: (browse: Browse) => Response): Browse[] {
		const seen: Browse[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				const browse = {
					type: input.searchParams.get("type") ?? "",
					offset: Number(input.searchParams.get("offset")),
					url: input,
				};
				seen.push(browse);
				return answer(browse);
			}),
		);
		return seen;
	}
	const page = (groups: unknown[], count = groups.length) =>
		jsonResponse({ "release-group-count": count, "release-groups": groups });

	it("asks every page for the artist credits and the ratings of the artist, for album, ep and single", async () => {
		const artist = freshArtist();
		const seen = stubBrowse(() => page([]));

		const result = await fetchArtistDiscographyMb(artist);

		expect(result).toEqual({ releases: [], unavailable: false });
		expect(seen.map((b) => b.type).sort()).toEqual(["album", "ep", "single"]);
		for (const { url } of seen) {
			expect(url.pathname).toBe("/ws/2/release-group");
			expect(url.searchParams.get("artist")).toBe(artist);
			expect(url.searchParams.get("inc")).toBe("artist-credits+ratings");
		}
	});

	it("reads three pages (offsets 0, 100, 200) for a total of 250, and never more than four", async () => {
		const albums = stubBrowse(({ type }) =>
			page(type === "album" ? [rg(1)] : [], type === "album" ? 250 : 0),
		);
		await fetchArtistDiscographyMb(freshArtist());
		expect(albums.filter((b) => b.type === "album").map((b) => b.offset)).toEqual([0, 100, 200]);

		const huge = stubBrowse(({ type }) =>
			page(type === "single" ? [rg(2)] : [], type === "single" ? 5_000 : 0),
		);
		await fetchArtistDiscographyMb(freshArtist());
		expect(huge.filter((b) => b.type === "single").map((b) => b.offset)).toEqual([0, 100, 200, 300]);
	});

	it("keeps the credits in MusicBrainz order, with the other fields of the release group", async () => {
		stubBrowse(({ type }) =>
			page(
				type === "album"
					? [
							rg(1, {
								title: "Memories of the Future",
								"secondary-types": ["Live"],
								"artist-credit": [credit(KODE9, "Kode9"), credit(SPACEAPE, "The Spaceape")],
								rating: { "votes-count": 12, value: 4.2 },
							}),
						]
					: [],
			),
		);

		const { releases } = await fetchArtistDiscographyMb(freshArtist());

		expect(releases).toEqual([
			{
				mbid: rgId(1),
				title: "Memories of the Future",
				firstReleaseDate: "2010-01-01",
				primaryType: "Album",
				secondaryTypes: ["Live"],
				artistCredits: [
					{ mbid: KODE9, name: "Kode9" },
					{ mbid: SPACEAPE, name: "The Spaceape" },
				],
				ratingVotes: 12,
			},
		]);
	});

	it("reads rating votes-count as ratingVotes; an absent or invalid value is 0 (TRA-625)", async () => {
		const bad: [string, unknown][] = [
			["no rating", undefined],
			["null rating", null],
			["rating without votes-count", { value: null }],
			["string votes", { "votes-count": "73" }],
			["negative votes", { "votes-count": -4 }],
			["fractional votes", { "votes-count": 2.5 }],
			["unsafe integer votes", { "votes-count": Number.MAX_VALUE }],
			["array rating", [73]],
		];
		const groups = [
			rg(10, { rating: { "votes-count": 73, value: 4.5 } }),
			...bad.map(([, rating], i) => rg(11 + i, rating === undefined ? {} : { rating })),
		];
		stubBrowse(({ type }) => page(type === "album" ? groups : []));

		const { releases } = await fetchArtistDiscographyMb(freshArtist());

		const votes = new Map(releases.map((r) => [r.mbid, r.ratingVotes]));
		expect(votes.get(rgId(10))).toBe(73);
		for (const [i, [label]] of bad.entries()) {
			expect(votes.get(rgId(11 + i)), label).toBe(0);
		}
	});

	it("falls back to empty fields when the optional ones are absent", async () => {
		stubBrowse(({ type }) => page(type === "ep" ? [{ id: rgId(3), title: "Bare" }] : []));

		const { releases, unavailable } = await fetchArtistDiscographyMb(freshArtist());

		expect(unavailable).toBe(false);
		expect(releases).toEqual([
			{
				mbid: rgId(3),
				title: "Bare",
				firstReleaseDate: "",
				primaryType: "",
				secondaryTypes: [],
				artistCredits: [],
				ratingVotes: 0,
			},
		]);
	});

	it("skips an entry without an id or a title, and a credit without an artist id, without throwing", async () => {
		stubBrowse(({ type }) =>
			page(
				type === "album"
					? [
							{ title: "No id" },
							{ id: 42, title: "Numeric id" },
							{ id: rgId(4) },
							null,
							rg(5, {
								"artist-credit": [
									{ name: "Nobody" },
									{ name: "Nobody", artist: { name: "Still nobody" } },
									credit(KODE9, "Kode9"),
								],
							}),
						]
					: [],
			),
		);

		const { releases, unavailable } = await fetchArtistDiscographyMb(freshArtist());

		expect(unavailable).toBe(false);
		expect(releases.map((r) => r.mbid)).toEqual([rgId(5)]);
		expect(releases[0]?.artistCredits).toEqual([{ mbid: KODE9, name: "Kode9" }]);
	});

	it("dedupes by mbid across types and sorts newest first", async () => {
		stubBrowse(({ type }) =>
			page(
				type === "album"
					? [rg(6, { "first-release-date": "2001-01-01" }), rg(7, { "first-release-date": "2020-05-05" })]
					: type === "ep"
						? [rg(6, { "first-release-date": "2001-01-01" })]
						: [],
			),
		);

		const { releases } = await fetchArtistDiscographyMb(freshArtist());

		expect(releases.map((r) => r.mbid)).toEqual([rgId(7), rgId(6)]);
	});

	it("flags a persistent 503 on a later page and keeps the pages that were read", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "1");
		stubBrowse(({ type, offset }) => {
			if (type === "album" && offset === 100) return failedResponse(503);
			return page(type === "album" ? [rg(offset === 0 ? 8 : 9)] : [], type === "album" ? 250 : 0);
		});

		const { releases, unavailable } = await fetchArtistDiscographyMb(freshArtist());

		expect(unavailable).toBe(true);
		expect(releases.map((r) => r.mbid).sort()).toEqual([rgId(8), rgId(9)].sort());
	});

	it("flags a first page that never answers, whatever the type", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "1");
		stubBrowse(({ type }) => (type === "single" ? failedResponse(503) : page(type === "ep" ? [rg(10)] : [])));

		const { releases, unavailable } = await fetchArtistDiscographyMb(freshArtist());

		expect(unavailable).toBe(true);
		expect(releases.map((r) => r.mbid)).toEqual([rgId(10)]);
	});

	it("flags an answer that is not a release-group page, rather than reading it as an empty catalog", async () => {
		stubBrowse(() => jsonResponse({ error: "Your requests are being rate limited" }));

		expect(await fetchArtistDiscographyMb(freshArtist())).toEqual({ releases: [], unavailable: true });
	});

	describe("priority", () => {
		const genres = (tag: string) => fetchEntityGenresMb("artist", `${tag}000000-0000-0000-0000-000000000000`);

		/** Kind of the requests in the order they leave, when an interactive one arrives after the browse. */
		async function requestOrder(date: string, opts?: { priority: "background" }): Promise<string[]> {
			musicBrainzConfig.minIntervalMs = 1_000;
			vi.useFakeTimers();
			vi.setSystemTime(new Date(`${date}T00:00:00.000Z`));
			const order: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: URL) => {
					const browse = input.pathname.includes("release-group");
					order.push(browse ? "browse" : "genres");
					return jsonResponse(browse ? { "release-groups": [] } : { genres: [] });
				}),
			);
			const pending: Promise<unknown>[] = [genres("d1"), genres("d2")];
			pending.push(fetchArtistDiscographyMb(freshArtist(), opts));
			await vi.advanceTimersByTimeAsync(500);
			pending.push(genres("d3"));
			await vi.advanceTimersByTimeAsync(10_000);
			await Promise.all(pending);
			return order;
		}

		it("yields to interactive requests when it is background", async () => {
			const order = await requestOrder("2050-01-01", { priority: "background" });
			expect(order.slice(0, 3)).toEqual(["genres", "genres", "genres"]);
			expect(order.filter((o) => o === "browse")).toHaveLength(3);
		});

		it("is interactive by default: the browse keeps its place in the FIFO", async () => {
			const order = await requestOrder("2051-01-01");
			expect(order).toEqual(["genres", "genres", "browse", "browse", "browse", "genres"]);
		});
	});
});
