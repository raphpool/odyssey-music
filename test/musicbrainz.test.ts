import { afterEach, describe, expect, it, vi } from "vitest";
import { musicBrainzConfig } from "../src/config.js";
import {
	fetchArtistEntityMb,
	fetchArtistMembershipsMb,
	fetchEntityGenresMb,
	fetchLabelMetaMb,
	fetchProjectMetaDetailedMb,
	fetchProjectMetaMb,
	fetchTrackMetaDetailedMb,
	fetchTrackMetaMb,
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

	it("spaces 503 retries by one second and stops after the bounded retry count", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
		const requestTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestTimes.push(Date.now());
				return failedResponse(503);
			}),
		);

		const pending = fetchEntityGenresMb("artist", "77777777-7777-7777-7777-777777777777");
		await vi.advanceTimersByTimeAsync(2_000);

		expect(await pending).toEqual([]);
		expect(requestTimes).toEqual([
			new Date("2026-09-14T00:00:00.000Z").getTime(),
			new Date("2026-09-14T00:00:01.000Z").getTime(),
			new Date("2026-09-14T00:00:02.000Z").getTime(),
		]);
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
