import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeCache } from "../../src/cache.js";
import { musicBrainzConfig } from "../../src/config.js";
import { createImageQueue, type ImageQueue } from "../../src/images/image-queue.js";
import { readImageSidecar } from "../../src/images/image-sidecar.js";
import type { resolveImage } from "../../src/images/resolve-image.js";
import { resolveWorkImageByHint, type WorkImageHint } from "../../src/images/resolve-work-hint.js";
import { fetchEntityGenresMb } from "../../src/musicbrainz.js";
import type { NodePayload, Slug } from "../../src/types.js";
import { projectNode } from "./helpers.js";

// TRA-590: a job of the image queue that overruns its 20 s leaves no MusicBrainz request in flight and none
// waiting. The simulated clock is the queue's own (setTimeout and Date faked, the sidecar folder is real).

const suiteMinIntervalMs = musicBrainzConfig.minIntervalMs;
const JOB_TIMEOUT_MS = 20_000;

function hint(title: string): WorkImageHint {
	return { slug: `project:${title.toLowerCase()}` as Slug, type: "project", title, artist: "Pole" };
}

/** Real time, because Date is faked here: the sidecar write is real I/O. */
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await cond()) return;
		await new Promise<void>((r) => setImmediate(r));
	}
	if (await cond()) return;
	throw new Error("condition never became true");
}

const idle = (q: ImageQueue): Promise<void> =>
	until(() => q.stats().pending === 0 && q.stats().inFlight === 0);

let dir: string;
let queues: ImageQueue[];
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function make(
	over: { resolveNode?: unknown; resolveHint?: unknown; nodes?: Map<string, NodePayload> } = {},
): ImageQueue {
	const nodes = over.nodes ?? new Map<string, NodePayload>();
	const q = createImageQueue({
		cacheDir: dir,
		cache: {
			get: vi.fn(async (slug: string) => {
				const node = nodes.get(slug);
				if (!node) throw new Error(`not found: ${slug}`);
				return node;
			}),
			write: vi.fn(),
			update: vi.fn(),
		} as unknown as NodeCache,
		resolveNode: (over.resolveNode ?? (async () => null)) as typeof resolveImage,
		resolveHint: (over.resolveHint ?? resolveWorkImageByHint) as typeof resolveWorkImageByHint,
		log,
	});
	queues.push(q);
	return q;
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	dir = await mkdtemp(join(tmpdir(), "image-queue-abort-"));
	queues = [];
	log = { info: vi.fn(), warn: vi.fn() };
});

afterEach(async () => {
	musicBrainzConfig.minIntervalMs = suiteMinIntervalMs;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await Promise.all(queues.map((q) => q.stop()));
	await rm(dir, { recursive: true, force: true });
});

interface MbRequest {
	at: number;
	query: string;
	signal: AbortSignal | undefined;
}

/** Global fetch of the tests: MusicBrainz searches are recorded and hang until their signal aborts. */
function stubMusicBrainz(t0: number, hangs: (query: string) => boolean): MbRequest[] {
	const requests: MbRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL | string, init?: RequestInit) => {
			const url = new URL(String(input));
			if (!url.pathname.endsWith("/release-group")) {
				return { ok: true, status: 200, json: async () => ({ genres: [] }) } as Response;
			}
			const query = url.searchParams.get("query") ?? "";
			requests.push({ at: Date.now() - t0, query, signal: init?.signal ?? undefined });
			if (!hangs(query)) return { ok: true, status: 200, json: async () => ({}) } as Response;
			return new Promise<Response>((_, reject) => {
				const signal = init?.signal;
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}),
	);
	return requests;
}

describe("the signal of a job", () => {
	it("reaches both resolvers and is aborted at the 20 s deadline", async () => {
		vi.setSystemTime(new Date("2060-01-01T00:00:00.000Z"));
		const seen: { node?: AbortSignal | undefined; hint?: AbortSignal | undefined } = {};
		const resolveNode = vi.fn(async (_n: NodePayload, deps: { signal?: AbortSignal }) => {
			seen.node = deps.signal;
			return new Promise<never>(() => {});
		});
		const resolveHint = vi.fn(async (_h: WorkImageHint, deps: { mbOptions?: { signal?: AbortSignal } }) => {
			seen.hint = deps.mbOptions?.signal;
			return new Promise<never>(() => {});
		});
		const node = projectNode("old", "Old");
		const q = make({ resolveNode, resolveHint, nodes: new Map([[node.slug, node]]) });
		q.enqueueHint(hint("Hangs"));
		await until(() => seen.hint !== undefined);
		expect(seen.hint?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS - 1);
		expect(seen.hint?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(seen.hint?.aborted).toBe(true);
		await idle(q);

		// The node job gets its own signal, aborted at its own deadline.
		q.enqueueNode(node);
		await until(() => seen.node !== undefined || resolveNode.mock.calls.length > 0);
		expect(seen.node).toBeInstanceOf(AbortSignal);
		expect(seen.node).not.toBe(seen.hint);
		expect(seen.node?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS);
		expect(seen.node?.aborted).toBe(true);
	});
});

describe("a job that overruns 20 s", () => {
	it("leaves no MusicBrainz request in flight and makes no further attempt", async () => {
		vi.setSystemTime(new Date("2061-01-01T00:00:00.000Z"));
		const t0 = Date.now();
		musicBrainzConfig.minIntervalMs = 1_000;
		// 4 s per attempt (MB_FETCH_TIMEOUT_MS) plus a slot each: with 8 attempts the job is still retrying at 20 s.
		vi.stubEnv("MB_MAX_ATTEMPTS", "8");
		const requests = stubMusicBrainz(t0, (query) => query.toLowerCase().includes("hangs"));

		const q = make();
		q.enqueueHint(hint("Hangs"));
		q.enqueueHint(hint("Next"));
		await until(() => requests.length > 0); // the worker reads the sidecar (real I/O) before it resolves
		await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS - 1);
		const before = requests.filter((r) => r.query.toLowerCase().includes("hangs"));
		expect(before.length).toBeGreaterThanOrEqual(3);
		await vi.advanceTimersByTimeAsync(1);
		await idle(q);

		// Every request of the abandoned job is over, and none was made after the deadline.
		const hangs = requests.filter((r) => r.query.toLowerCase().includes("hangs"));
		expect(hangs.every((r) => r.signal?.aborted)).toBe(true);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(requests.filter((r) => r.query.toLowerCase().includes("hangs"))).toHaveLength(hangs.length);
		expect(hangs.every((r) => r.at < JOB_TIMEOUT_MS)).toBe(true);
		// The next job was served right after, and the abandoned one is recorded as unavailable.
		expect(requests.some((r) => r.query.toLowerCase().includes("next"))).toBe(true);
		expect(await readImageSidecar(dir, "project:hangs--pole" as Slug)).toMatchObject({
			state: "unavailable",
		});
	});

	it("leaves no MusicBrainz request waiting for a slot", async () => {
		vi.setSystemTime(new Date("2062-01-01T00:00:00.000Z"));
		const t0 = Date.now();
		musicBrainzConfig.minIntervalMs = 1_000;
		const requests = stubMusicBrainz(t0, () => false);

		// 30 interactive requests hold the slots until 29 s: a background request waits behind all of them.
		const burst = Array.from({ length: 30 }, (_, i) =>
			fetchEntityGenresMb("artist", `${String(i).padStart(2, "0")}000000-0000-0000-0000-000000000000`),
		);
		let started = 0;
		const q = make({
			resolveHint: (h: WorkImageHint, deps: Parameters<typeof resolveWorkImageByHint>[1]) => {
				started++;
				return resolveWorkImageByHint(h, deps);
			},
		});
		q.enqueueHint(hint("Waits"));
		q.enqueueHint(hint("Next"));
		await until(() => started === 1); // the worker reads the sidecar (real I/O) before it resolves
		await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS);
		await until(() => q.stats().unavailable === 1);
		await vi.advanceTimersByTimeAsync(100_000);
		await Promise.all(burst);
		await idle(q);

		// The abandoned job never reached MusicBrainz, even once the interactive burst was over.
		expect(requests.filter((r) => r.query.toLowerCase().includes("waits"))).toEqual([]);
		// It took no slot either: the next job asked as soon as the burst was done, not a second later.
		const next = requests.find((r) => r.query.toLowerCase().includes("next"));
		expect(next).toBeDefined();
		expect(next?.at).toBeLessThanOrEqual(30_000);
		expect(await readImageSidecar(dir, "project:waits--pole" as Slug)).toMatchObject({
			state: "unavailable",
		});
	});
});
