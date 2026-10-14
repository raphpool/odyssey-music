import { afterEach, describe, expect, it, vi } from "vitest";
import { musicBrainzConfig } from "../src/config.js";
import {
	fetchArtistEntityMb,
	fetchArtistMembershipsMb,
	fetchEntityGenresMb,
	fetchLabelMetaMb,
	resolveRecording,
	resolveReleaseGroup,
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

		const out = await resolveReleaseGroup("New Forms", "Roni Size");

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
		expect(urls[0]?.searchParams.get("query")).toBe('releasegroup:"New Forms" AND artist:"Roni Size"');
		expect(urls[0]?.searchParams.get("limit")).toBe("8");
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

	it("takes the only exact-title result when the hint matches none of the credits", async () => {
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
		const out = await resolveReleaseGroup("Lone Title", "Totally Unrelated Hint");
		expect(out?.mbid).toBe("44444444-aaaa-4aaa-8aaa-000000000001");
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
		expect(urls[0]?.searchParams.get("limit")).toBe("8");
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
