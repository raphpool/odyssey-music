import { afterEach, describe, expect, it, vi } from "vitest";
import { musicBrainzConfig } from "../src/config.js";
import {
	fetchEntityGenresMb,
	fetchWikidataUrlRelMb,
	findCompilationCoverReleaseGroup,
	resolveRecordingDetailed,
	resolveReleaseGroupDetailed,
} from "../src/musicbrainz.js";

// TRA-590: an `AbortSignal` goes through mbFetch / mbRequest, the slot queue, the retries and the work
// resolvers. The scheduler is module-level state: each test starts at a later fake date than the previous
// one, so a slot reserved by an earlier test is always in the past.

const QID_BODY = {
	relations: [{ type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q42" } }],
};

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

function failedResponse(status: number): Response {
	return { ok: false, status, headers: new Headers(), json: async () => ({}) } as Response;
}

const suiteMinIntervalMs = musicBrainzConfig.minIntervalMs;

afterEach(() => {
	musicBrainzConfig.minIntervalMs = suiteMinIntervalMs;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function startAt(isoDate: string): number {
	musicBrainzConfig.minIntervalMs = 1_000;
	vi.useFakeTimers();
	vi.setSystemTime(new Date(isoDate));
	return Date.now();
}

const id = (tag: string) => `${tag}000000-0000-0000-0000-000000000000`;
const interactive = (tag: string) => fetchEntityGenresMb("artist", id(tag));
const qid = (tag: string, options: Parameters<typeof fetchWikidataUrlRelMb>[3] = {}) =>
	fetchWikidataUrlRelMb("artist", id(tag), undefined, options);

/** Rejects like a real fetch when the signal it was given is aborted. */
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
	return new Promise<Response>((_, reject) => {
		const signal = init?.signal;
		if (signal?.aborted) return reject(signal.reason);
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** Records "<first two chars of the mbid> @ offset" of every request; `answer` decides the response. */
function stubFetch(
	t0: number,
	answer: (name: string, count: number, init?: RequestInit) => Promise<Response> | Response = () =>
		jsonResponse({ genres: [], relations: [] }),
): { log: string[]; calls: () => number } {
	const log: string[] = [];
	let count = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL, init?: RequestInit) => {
			const name = input.pathname.split("/").at(-1) ?? "";
			log.push(`${name.slice(0, 2)}@${Date.now() - t0}`);
			return answer(name, ++count, init);
		}),
	);
	return { log, calls: () => count };
}

describe("a request whose signal is aborted", () => {
	it("makes no request and reserves no slot when it is aborted before it starts", async () => {
		const t0 = startAt("2050-01-01T00:00:00.000Z");
		const { log } = stubFetch(t0);
		const ctrl = new AbortController();
		ctrl.abort();

		await expect(qid("b1", { signal: ctrl.signal })).resolves.toBeNull();
		const pending = interactive("a1");
		await vi.advanceTimersByTimeAsync(0);
		await pending;

		expect(log).toEqual(["a1@0"]);
	});

	it("leaves backgroundWaiters without taking a slot, so the next background request is not pushed back", async () => {
		const t0 = startAt("2051-01-01T00:00:00.000Z");
		const { log } = stubFetch(t0);
		const ctrl = new AbortController();

		const pending = [
			interactive("a1"),
			interactive("a2"),
			qid("b1", { priority: "background", signal: ctrl.signal }),
			qid("b2", { priority: "background" }),
		];
		await vi.advanceTimersByTimeAsync(500);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(5_000);
		const results = await Promise.all(pending);

		// b1 would have taken the slot at 2 000 and pushed b2 to 3 000.
		expect(log).toEqual(["a1@0", "a2@1000", "b2@2000"]);
		expect(results[2]).toBeNull();
	});

	it("gives back the slot a background request had reserved, and lets the next one go on", async () => {
		const t0 = startAt("2052-01-01T00:00:00.000Z");
		const { log } = stubFetch(t0);
		const ctrl = new AbortController();

		const pending = [qid("b0", { priority: "background" })];
		pending.push(qid("b1", { priority: "background", signal: ctrl.signal }));
		await vi.advanceTimersByTimeAsync(500); // b1 reserved the slot at 1 000 and is sleeping
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(100);
		pending.push(qid("b2", { priority: "background" }));
		await vi.advanceTimersByTimeAsync(5_000);
		await Promise.all(pending);

		// The reservation of b1 was the last one: it is cancelled, b2 takes slot 1 000 instead of 2 000.
		expect(log).toEqual(["b0@0", "b2@1000"]);
	});

	it("gives back the slot of an interactive request and stops it from holding the background ones", async () => {
		const t0 = startAt("2053-01-01T00:00:00.000Z");
		const { log } = stubFetch(t0);
		const ctrl = new AbortController();

		const pending = [interactive("a1"), qid("a2", { signal: ctrl.signal })];
		await vi.advanceTimersByTimeAsync(500);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(100);
		pending.push(qid("b1", { priority: "background" }));
		await vi.advanceTimersByTimeAsync(5_000);
		await Promise.all(pending);

		expect(log).toEqual(["a1@0", "b1@1000"]);
	});

	it("is not retried when it is aborted while waiting between two attempts", async () => {
		const t0 = startAt("2054-01-01T00:00:00.000Z");
		const { log, calls } = stubFetch(t0, () => failedResponse(503));
		const ctrl = new AbortController();

		const pending = qid("r1", { signal: ctrl.signal });
		await vi.advanceTimersByTimeAsync(500); // the first attempt got its 503, the retry waits 1 000 ms
		expect(calls()).toBe(1);
		ctrl.abort();
		await expect(pending).resolves.toBeNull();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(log).toEqual(["r1@0"]);
	});

	it("does not hold up the retry of another request once it left the retry chain", async () => {
		const t0 = startAt("2055-01-01T00:00:00.000Z");
		const seen = new Map<string, number>();
		const { log } = stubFetch(t0, (name) => {
			const tag = name.slice(0, 2);
			const count = (seen.get(tag) ?? 0) + 1;
			seen.set(tag, count);
			if (count > 1) return jsonResponse(QID_BODY);
			// r1 asks for a 30 s wait, r2 gets the default backoff.
			const headers = new Headers(tag === "r1" ? { "Retry-After": "30" } : {});
			return { ok: false, status: 503, headers, json: async () => ({}) } as unknown as Response;
		});
		const ctrl = new AbortController();

		const aborted = qid("r1", { priority: "background", signal: ctrl.signal });
		const other = qid("r2", { priority: "background" });
		await vi.advanceTimersByTimeAsync(1_500); // r1 got its 503 at 0 (30 s wait in the chain), r2 its 503 at 1 000
		ctrl.abort();
		await expect(aborted).resolves.toBeNull();
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(other).resolves.toBe("Q42");
		// r2's retry waits 1 s once r1's place in the chain ends at 1 500: 2 500, not 31 000 (review of #645: the
		// previous version of this test let r1 succeed at once, so a chain that ignored the abort passed it).
		expect(log).toEqual(["r1@0", "r2@1000", "r2@2500"]);
	});

	it("gives an aborted interactive reservation back to a background request already queued", async () => {
		const t0 = startAt("2055-06-01T00:00:00.000Z");
		const { log } = stubFetch(t0);
		const ctrl = new AbortController();

		const pending = [
			interactive("a1"), // slot 0
			qid("a2", { signal: ctrl.signal }), // interactive, slot 1 000
			qid("b1", { priority: "background" }), // queued behind a2
		];
		await vi.advanceTimersByTimeAsync(500);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(5_000);
		await Promise.all(pending);

		expect(log).toEqual(["a1@0", "b1@1000"]);
	});

	it("is not retried when it is aborted in flight, unlike a network failure", async () => {
		const t0 = startAt("2056-01-01T00:00:00.000Z");
		const hanging = stubFetch(t0, (_name, _count, init) => hangUntilAborted(init));
		const ctrl = new AbortController();

		const pending = qid("f1", { signal: ctrl.signal });
		await vi.advanceTimersByTimeAsync(100);
		ctrl.abort();
		await expect(pending).resolves.toBeNull();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(hanging.calls()).toBe(1);

		// Same signal, never aborted, a network error: retried up to 3 attempts.
		const failing = stubFetch(Date.now(), () => {
			throw new Error("ECONNRESET");
		});
		const live = new AbortController();
		const second = qid("f2", { signal: live.signal });
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(second).resolves.toBeNull();
		expect(failing.calls()).toBe(3);
	});

	it("caches nothing: the same request asked again goes to MusicBrainz", async () => {
		const t0 = startAt("2057-01-01T00:00:00.000Z");
		const hanging = stubFetch(t0, (_name, _count, init) => hangUntilAborted(init));
		const ctrl = new AbortController();
		const pending = qid("c1", { signal: ctrl.signal });
		await vi.advanceTimersByTimeAsync(100);
		ctrl.abort();
		await pending;
		expect(hanging.calls()).toBe(1);

		const answering = stubFetch(t0, () => jsonResponse(QID_BODY));
		const again = qid("c1");
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(again).resolves.toBe("Q42");
		expect(answering.calls()).toBe(1);
	});

	it("drops an answer that arrives after the abort instead of caching it", async () => {
		const t0 = startAt("2058-01-01T00:00:00.000Z");
		let deliver: (r: Response) => void = () => {};
		// A fetch that ignores its signal and answers late.
		const late = stubFetch(
			t0,
			() =>
				new Promise<Response>((resolve) => {
					deliver = resolve;
				}),
		);
		const ctrl = new AbortController();
		const pending = qid("l1", { signal: ctrl.signal });
		await vi.advanceTimersByTimeAsync(100);
		ctrl.abort();
		deliver(jsonResponse(QID_BODY));
		await expect(pending).resolves.toBeNull();
		expect(late.calls()).toBe(1);

		const answering = stubFetch(t0, () => jsonResponse(QID_BODY));
		const again = qid("l1");
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(again).resolves.toBe("Q42");
		expect(answering.calls()).toBe(1);
	});

	it("passes the caller's abort to the fetch in flight", async () => {
		const t0 = startAt("2059-01-01T00:00:00.000Z");
		let seen: AbortSignal | undefined;
		stubFetch(t0, (_name, _count, init) => {
			seen = init?.signal ?? undefined;
			return hangUntilAborted(init);
		});
		const ctrl = new AbortController();
		const pending = qid("s1", { signal: ctrl.signal });
		await vi.advanceTimersByTimeAsync(100);
		expect(seen?.aborted).toBe(false);
		ctrl.abort();
		await pending;
		expect(seen?.aborted).toBe(true);
	});
});

describe("a signal that is never aborted", () => {
	it("changes nothing to the order of the queue: interactive first, background after (TRA-579)", async () => {
		const t0 = startAt("2060-01-01T00:00:00.000Z");
		const { log } = stubFetch(t0);
		const ctrl = new AbortController();

		const pending = [
			interactive("a1"),
			interactive("a2"),
			qid("b1", { priority: "background", signal: ctrl.signal }),
		];
		await vi.advanceTimersByTimeAsync(500);
		pending.push(qid("a3", { signal: ctrl.signal }));
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(pending);

		expect(log).toEqual(["a1@0", "a2@1000", "a3@2000", "b1@3000"]);
	});

	it("neither spaces nor yields when MB_MIN_INTERVAL_MS is 0", async () => {
		const t0 = startAt("2061-01-01T00:00:00.000Z");
		musicBrainzConfig.minIntervalMs = 0;
		const { log } = stubFetch(t0, () => jsonResponse(QID_BODY));
		const ctrl = new AbortController();

		await Promise.all([
			qid("z1", { priority: "background", signal: ctrl.signal }),
			qid("z2", { priority: "background", signal: ctrl.signal }),
		]);

		expect(log).toEqual(["z1@0", "z2@0"]);
	});
});

describe("work resolvers", () => {
	const unavailable = { identity: null, ambiguous: false, unavailable: true };

	it.each([
		["resolveReleaseGroupDetailed", resolveReleaseGroupDetailed],
		["resolveRecordingDetailed", resolveRecordingDetailed],
	] as const)(
		"%s answers unavailable without any request when the signal is already aborted",
		async (_n, resolve) => {
			const t0 = startAt("2062-01-01T00:00:00.000Z");
			const { calls } = stubFetch(t0);
			const ctrl = new AbortController();
			ctrl.abort();

			await expect(resolve("Selected Ambient Works", "Aphex Twin", { signal: ctrl.signal })).resolves.toEqual(
				unavailable,
			);
			expect(calls()).toBe(0);
		},
	);

	it.each([
		["resolveReleaseGroupDetailed", resolveReleaseGroupDetailed, "2063-01-01"],
		["resolveRecordingDetailed", resolveRecordingDetailed, "2064-01-01"],
	] as const)("%s leaves the queue when aborted while waiting for its slot", async (name, resolve, date) => {
		const t0 = startAt(`${date}T00:00:00.000Z`);
		const { log } = stubFetch(t0);
		const ctrl = new AbortController();

		const pending: Promise<unknown>[] = [interactive("a1"), interactive("a2")];
		const resolution = resolve(`Title ${name}`, "Artist", { priority: "background", signal: ctrl.signal });
		pending.push(resolution);
		await vi.advanceTimersByTimeAsync(500);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(5_000);
		await Promise.all(pending);

		await expect(resolution).resolves.toEqual(unavailable);
		expect(log).toEqual(["a1@0", "a2@1000"]);
	});

	it("findCompilationCoverReleaseGroup answers unavailable when aborted, and asks nothing", async () => {
		const t0 = startAt("2065-01-01T00:00:00.000Z");
		const { calls } = stubFetch(t0);
		const ctrl = new AbortController();
		ctrl.abort();

		await expect(
			findCompilationCoverReleaseGroup("Hyperdub 10.3", "Kode9", { signal: ctrl.signal }),
		).resolves.toEqual({ kind: "unavailable" });
		expect(calls()).toBe(0);
	});
});
