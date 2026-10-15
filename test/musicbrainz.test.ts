import { afterEach, describe, expect, it, vi } from "vitest";
import { musicBrainzConfig } from "../src/config.js";
import { fetchEntityGenresMb } from "../src/musicbrainz.js";

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
