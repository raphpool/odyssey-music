import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeCache } from "../../src/cache.js";
import { createImageQueue, type ImageQueue } from "../../src/images/image-queue.js";
import {
	type ImageSidecarEntry,
	readImageSidecar,
	writeImageSidecar,
} from "../../src/images/image-sidecar.js";
import type { resolveImage } from "../../src/images/resolve-image.js";
import type {
	resolveWorkImageByHint,
	WorkImageHint,
	WorkImageResolution,
} from "../../src/images/resolve-work-hint.js";
import type { NodePayload, Slug } from "../../src/types.js";
import { artistNode, projectNode } from "./helpers.js";

const COVER = "https://coverartarchive.org/release-group/5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111/front-500";
const MBID = "5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111";
const FOUND: WorkImageResolution = { kind: "found", url: COVER, source: "caa", mbid: MBID };
const UNAVAILABLE: WorkImageResolution = { kind: "unavailable" };

function hint(title: string, artist: string, slug?: string): WorkImageHint {
	return { slug: (slug ?? `project:${title.toLowerCase()}`) as Slug, type: "project", title, artist };
}

/**
 * Wait on real I/O (the sidecar is a real folder) while the timers stay fake.
 *
 * 2026-10-19 (TRA-646): the budget was 5 000 event-loop turns, so a saturated CI disk let all of them
 * pass before the sidecar write landed ("condition never became true" on unrelated PRs). The deadline
 * is now real time, read from performance.now() because Date is faked in this file.
 */
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await cond()) return;
		await new Promise<void>((r) => setImmediate(r));
	}
	// one last look: the write may have landed during the final wait
	if (await cond()) return;
	throw new Error("condition never became true");
}

const idle = (q: ImageQueue): Promise<void> =>
	until(() => q.stats().pending === 0 && q.stats().inFlight === 0);

interface Gate {
	promise: Promise<WorkImageResolution>;
	open(r?: WorkImageResolution): void;
}
function gate(): Gate {
	let open!: Gate["open"];
	const promise = new Promise<WorkImageResolution>((resolve) => {
		open = (r = FOUND) => resolve(r);
	});
	return { promise, open };
}

let dir: string;
let nodes: Map<string, NodePayload>;
let cache: {
	get: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
let resolveHint: ReturnType<typeof vi.fn>;
let resolveNode: ReturnType<typeof vi.fn>;
let queues: ImageQueue[];

function make(over: { fetch?: typeof fetch } = {}): ImageQueue {
	const q = createImageQueue({
		cacheDir: dir,
		cache: cache as unknown as NodeCache,
		// the mocks are re-assigned by the tests, so they are read when a job runs
		resolveNode: ((...a: unknown[]) => resolveNode(...a)) as unknown as typeof resolveImage,
		resolveHint: ((...a: unknown[]) => resolveHint(...a)) as unknown as typeof resolveWorkImageByHint,
		...(over.fetch ? { fetch: over.fetch } : {}),
		log,
	});
	queues.push(q);
	return q;
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
	dir = await mkdtemp(join(tmpdir(), "image-queue-"));
	nodes = new Map();
	cache = {
		get: vi.fn(async (slug: string) => {
			const node = nodes.get(slug);
			if (!node) throw new Error(`not found: ${slug}`);
			return node;
		}),
		write: vi.fn(),
		update: vi.fn(),
	};
	log = { info: vi.fn(), warn: vi.fn() };
	resolveHint = vi.fn(async () => FOUND);
	resolveNode = vi.fn(async () => ({ url: COVER, source: "caa" }));
	queues = [];
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(queues.map((q) => q.stop()));
	await rm(dir, { recursive: true, force: true });
});

describe("worker", () => {
	it("resolves A, B, C in order, one at a time", async () => {
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		resolveHint = vi.fn(async (h: WorkImageHint) => {
			active++;
			maxActive = Math.max(maxActive, active);
			order.push(h.title);
			await new Promise<void>((r) => setImmediate(r));
			active--;
			return FOUND;
		});
		const q = make();
		for (const t of ["A", "B", "C"]) expect(q.enqueueHint(hint(t, "Pole")).accepted).toBe(true);
		await idle(q);
		expect(order).toEqual(["A", "B", "C"]);
		expect(maxActive).toBe(1);
		expect(q.stats()).toMatchObject({ resolved: 3, pending: 0, inFlight: 0 });
	});

	it("queues a hint once, and reports pending until the sidecar is written", async () => {
		const g = gate();
		resolveHint = vi.fn(() => g.promise);
		const q = make();
		const first = q.enqueueHint(hint("Go Plastic", "Squarepusher"));
		const again = q.enqueueHint(hint("Go Plastic", "Squarepusher"));
		expect(first).toEqual({ accepted: true, key: "project:go-plastic--squarepusher" });
		expect(again).toEqual(first);
		await until(() => resolveHint.mock.calls.length === 1);
		expect(q.stateOf("project:go-plastic--squarepusher" as Slug)).toBe("pending");
		g.open();
		await until(() => q.stateOf("project:go-plastic--squarepusher" as Slug) === "idle");
		// idle only once the entry is on disk
		const entry = await readImageSidecar(dir, "project:go-plastic--squarepusher" as Slug);
		expect(entry).toMatchObject({
			state: "found",
			url: COVER,
			source: "caa",
			mbid: MBID,
			hint: { title: "Go Plastic", artist: "Squarepusher" },
		});
		expect(resolveHint).toHaveBeenCalledTimes(1);
	});

	it("logs one line per finished job", async () => {
		const q = make();
		q.enqueueHint(hint("A", "Pole"));
		await idle(q);
		expect(log.info).toHaveBeenCalledWith("image job", {
			key: "project:a--pole",
			kind: "hint",
			outcome: "found",
			ms: expect.any(Number),
		});
	});

	it("writes missing with its reason, and a node job as missing/no-match when the resolver finds nothing", async () => {
		resolveHint = vi.fn(async () => ({ kind: "missing", reason: "ambiguous" }) as const);
		resolveNode = vi.fn(async () => null);
		nodes.set("project:old", projectNode("old", "Old"));
		const q = make();
		q.enqueueHint(hint("Vague", "Pole"));
		q.enqueueNode(nodes.get("project:old") as NodePayload);
		await idle(q);
		expect(await readImageSidecar(dir, "project:vague--pole" as Slug)).toMatchObject({
			state: "missing",
			reason: "ambiguous",
		});
		expect(await readImageSidecar(dir, "project:old" as Slug)).toMatchObject({
			state: "missing",
			reason: "no-match",
			hint: { title: "Old", artist: "" },
		});
		expect(q.stats().missing).toBe(2);
	});

	it("resolves a node job with the freshly read node and writes a found entry", async () => {
		const stale = projectNode("old", "Old");
		nodes.set("project:old", { ...stale, editorial_pitch: "fresh copy" });
		const q = make();
		expect(q.enqueueNode(stale)).toEqual({ accepted: true, key: "project:old" });
		await idle(q);
		expect(resolveNode.mock.calls[0]?.[0]).toMatchObject({ editorial_pitch: "fresh copy" });
		expect(await readImageSidecar(dir, "project:old" as Slug)).toMatchObject({ state: "found", url: COVER });
	});

	it("refuses an image on a host that is not allowed", async () => {
		resolveHint = vi.fn(async () => ({ ...FOUND, url: "https://evil.example/x.jpg" }));
		const q = make();
		q.enqueueHint(hint("A", "Pole"));
		await idle(q);
		expect(await readImageSidecar(dir, "project:a--pole" as Slug)).toMatchObject({ state: "missing" });
	});
});

describe("skipping", () => {
	it("does not call the resolver when the sidecar is fresh", async () => {
		const entry: ImageSidecarEntry = {
			key: "project:a--pole" as Slug,
			state: "found",
			url: COVER,
			source: "caa",
			hint: { title: "A", artist: "Pole" },
			resolvedAt: new Date().toISOString(),
		};
		await writeImageSidecar(dir, entry);
		const q = make();
		q.enqueueHint(hint("A", "Pole"));
		await idle(q);
		expect(resolveHint).not.toHaveBeenCalled();
		expect(q.stats().skipped).toBe(1);
	});

	it("resolves again once an entry has expired", async () => {
		await writeImageSidecar(dir, {
			key: "project:a--pole" as Slug,
			state: "unavailable",
			hint: { title: "A", artist: "Pole" },
			resolvedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
		});
		const q = make();
		q.enqueueHint(hint("A", "Pole"));
		await idle(q);
		expect(resolveHint).toHaveBeenCalledTimes(1);
	});

	it("skips a node job whose node received an image after it was queued", async () => {
		const bare = projectNode("old", "Old");
		nodes.set("project:old", { ...bare, image_url: COVER, image_source: "caa" });
		const q = make();
		q.enqueueNode(bare);
		await idle(q);
		expect(resolveNode).not.toHaveBeenCalled();
		expect(q.stats().skipped).toBe(1);
		expect(await readImageSidecar(dir, "project:old" as Slug)).toBeNull();
	});

	it("does not even queue a node that already has an image", () => {
		const q = make();
		const node = projectNode("old", "Old", { image_url: COVER, image_source: "caa" });
		expect(q.enqueueNode(node)).toEqual({ accepted: true, key: "project:old" });
		expect(q.stateOf("project:old" as Slug)).toBe("idle");
	});

	it("leaves the circuit breaker series alone: a skip made no request", async () => {
		resolveHint = vi.fn(async (h: WorkImageHint) => (h.title === "Cached" ? FOUND : UNAVAILABLE));
		await writeImageSidecar(dir, {
			key: "project:cached--pole" as Slug,
			state: "found",
			url: COVER,
			source: "caa",
			hint: { title: "Cached", artist: "Pole" },
			resolvedAt: new Date().toISOString(),
		});
		const q = make();
		q.enqueueHint(hint("U1", "Pole"));
		q.enqueueHint(hint("U2", "Pole"));
		q.enqueueHint(hint("Cached", "Pole"));
		q.enqueueHint(hint("U3", "Pole"));
		await until(() => q.stats().paused);
		expect(q.stats().unavailable).toBe(3);
	});
});

describe("identity and aliases", () => {
	it("keeps two homonyms apart and gives the bare slug nothing", async () => {
		const q = make();
		expect(q.enqueueHint(hint("3", "Pole", "project:3"))).toEqual({
			accepted: true,
			key: "project:3--pole",
		});
		expect(q.aliasOf("project:3" as Slug)).toBe("project:3--pole");
		expect(q.enqueueHint(hint("3", "Aphex Twin", "project:3"))).toEqual({
			accepted: false,
			reason: "conflict",
		});
		expect(q.aliasOf("project:3" as Slug)).toBe("conflict");
		await idle(q);
		await until(async () => (await readImageSidecar(dir, "project:3" as Slug))?.state === "conflict");
		expect(JSON.parse(await readFile(join(dir, "images", "project-3.json"), "utf8"))).toMatchObject({
			key: "project:3",
			state: "conflict",
		});
		// both works are still resolved, each under its own key
		expect((await readImageSidecar(dir, "project:3--pole" as Slug))?.state).toBe("found");
		expect((await readImageSidecar(dir, "project:3--aphex-twin" as Slug))?.state).toBe("found");
		expect(q.stats().conflicts).toBe(1);
		// and a third sighting stays a conflict, without counting again
		expect(q.enqueueHint(hint("3", "Pole", "project:3"))).toEqual({ accepted: false, reason: "conflict" });
		expect(q.stats().conflicts).toBe(1);
	});

	it("does not overwrite a resolved entry with a conflict marker", async () => {
		const found: ImageSidecarEntry = {
			key: "project:3" as Slug,
			state: "found",
			url: COVER,
			source: "caa",
			hint: { title: "3", artist: "" },
			resolvedAt: new Date().toISOString(),
		};
		await writeImageSidecar(dir, found);
		const q = make();
		q.enqueueHint(hint("3", "Pole", "project:3"));
		expect(q.enqueueHint(hint("3", "Aphex Twin", "project:3"))).toEqual({
			accepted: false,
			reason: "conflict",
		});
		await idle(q);
		await q.stop();
		expect(q.aliasOf("project:3" as Slug)).toBe("conflict");
		expect(await readImageSidecar(dir, "project:3" as Slug)).toMatchObject({ state: "found", url: COVER });
	});

	it("survives a logger that throws", async () => {
		log.info.mockImplementation(() => {
			throw new Error("log down");
		});
		const q = make();
		q.enqueueHint(hint("A", "Pole"));
		q.enqueueHint(hint("B", "Pole"));
		await idle(q);
		expect(q.stats().resolved).toBe(2);
	});

	it("registers no alias for a slug that is already its key", () => {
		const q = make();
		q.enqueueHint(hint("Go Plastic", "Squarepusher", "project:go-plastic--squarepusher"));
		expect(q.aliasOf("project:go-plastic--squarepusher" as Slug)).toBeNull();
	});

	it("is not a conflict when the same work is seen twice under one bare slug", () => {
		const q = make();
		q.enqueueHint(hint("3", "Pole", "project:3"));
		expect(q.enqueueHint(hint("3", "Pole", "project:3"))).toEqual({ accepted: true, key: "project:3--pole" });
		expect(q.aliasOf("project:3" as Slug)).toBe("project:3--pole");
		expect(q.aliasOf("project:unknown" as Slug)).toBeNull();
	});

	it("refuses an artist that normalizes to nothing", () => {
		const q = make();
		expect(q.enqueueHint(hint("Thousand Knives", "坂本龍一"))).toEqual({
			accepted: false,
			reason: "unscopable",
		});
		expect(q.enqueueHint(hint("!!!", "Pole"))).toEqual({ accepted: false, reason: "unscopable" });
		expect(q.stats()).toMatchObject({ pending: 0, inFlight: 0 });
		expect(resolveHint).not.toHaveBeenCalled();
	});

	it("refuses a node whose sidecar file name would be shared with another key", () => {
		const q = make();
		const q1 = q.enqueueNode(artistNode("beyoncé", "Beyoncé"));
		const q2 = q.enqueueNode(artistNode("beyonc.", "Beyonc."));
		expect(q1).toEqual({ accepted: false, reason: "unscopable" });
		expect(q2).toEqual({ accepted: false, reason: "unscopable" });
	});

	it("never forgets a conflict when the alias table evicts its oldest entries", async () => {
		const g = gate(); // keeps the worker busy so the test only exercises the tables
		resolveHint = vi.fn(() => g.promise);
		const q = make();
		q.enqueueHint(hint("3", "Pole", "project:3"));
		q.enqueueHint(hint("3", "Aphex Twin", "project:3"));
		q.enqueueHint(hint("First", "Pole", "project:first"));
		for (let i = 0; i < 20_000; i++) q.enqueueHint(hint(`w${i}`, "Pole", `project:bare-${i}`));
		expect(q.aliasOf("project:3" as Slug)).toBe("conflict");
		expect(q.aliasOf("project:first" as Slug)).toBeNull(); // oldest plain alias evicted
		expect(q.aliasOf("project:bare-19999" as Slug)).toBe("project:w19999--pole");
		g.open();
	});
});

describe("bounds", () => {
	it("refuses the 5001st key and counts it as dropped", () => {
		const g = gate();
		resolveHint = vi.fn(() => g.promise);
		const q = make();
		for (let i = 0; i < 5_000; i++) expect(q.enqueueHint(hint(`w${i}`, "Pole")).accepted).toBe(true);
		expect(q.enqueueHint(hint("w5000", "Pole"))).toEqual({ accepted: false, reason: "full" });
		expect(q.stats().dropped).toBe(1);
		// a key already queued is still accepted when the queue is full
		expect(q.enqueueHint(hint("w10", "Pole")).accepted).toBe(true);
		expect(q.stats().dropped).toBe(1);
		g.open();
	});

	it("serves a conflict verdict even when the queue is full", () => {
		const g = gate();
		resolveHint = vi.fn(() => g.promise);
		const q = make();
		q.enqueueHint(hint("3", "Pole", "project:3"));
		for (let i = 0; i < 4_999; i++) q.enqueueHint(hint(`w${i}`, "Pole"));
		expect(q.enqueueHint(hint("3", "Aphex Twin", "project:3"))).toEqual({
			accepted: false,
			reason: "conflict",
		});
		expect(q.aliasOf("project:3" as Slug)).toBe("conflict");
		g.open();
	});
});

describe("deadline", () => {
	it("records unavailable when the resolver does not answer in 20 s, and moves on", async () => {
		let seenFetch: typeof fetch | undefined;
		resolveHint = vi.fn(async (h: WorkImageHint, deps: { fetch?: typeof fetch }) => {
			if (h.title === "Hangs") {
				seenFetch = deps.fetch;
				return new Promise<WorkImageResolution>(() => {});
			}
			return FOUND;
		});
		const network = vi.fn(async () => new Response("late"));
		const q = make({ fetch: network as unknown as typeof fetch });
		q.enqueueHint(hint("Hangs", "Pole"));
		q.enqueueHint(hint("Next", "Pole"));
		await until(() => resolveHint.mock.calls.length === 1);
		await vi.advanceTimersByTimeAsync(19_999);
		expect(resolveHint).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await idle(q);
		expect(await readImageSidecar(dir, "project:hangs--pole" as Slug)).toMatchObject({
			state: "unavailable",
		});
		expect(await readImageSidecar(dir, "project:next--pole" as Slug)).toMatchObject({ state: "found" });
		expect(q.stats()).toMatchObject({ unavailable: 1, resolved: 1 });
		// what the abandoned job still tries after the deadline fails at once, with no request made
		expect(seenFetch).toBeDefined();
		await expect((seenFetch as typeof fetch)("https://coverartarchive.org/x")).rejects.toThrow("timed out");
		expect(network).not.toHaveBeenCalled();
	});

	it("records unavailable when the resolver throws", async () => {
		resolveHint = vi.fn(async () => {
			throw new Error("boom");
		});
		const q = make();
		q.enqueueHint(hint("A", "Pole"));
		await idle(q);
		expect(await readImageSidecar(dir, "project:a--pole" as Slug)).toMatchObject({ state: "unavailable" });
		expect(log.warn).toHaveBeenCalledWith(
			"image job failed",
			expect.objectContaining({ key: "project:a--pole" }),
		);
	});
});

describe("circuit breaker", () => {
	it("pauses for 60 s after 3 unavailable in a row, then resumes", async () => {
		resolveHint = vi.fn(async () => UNAVAILABLE);
		const q = make();
		for (const t of ["A", "B", "C", "D"]) q.enqueueHint(hint(t, "Pole"));
		await until(() => q.stats().paused);
		expect(resolveHint).toHaveBeenCalledTimes(3);
		expect(q.stats()).toMatchObject({ paused: true, pending: 1, inFlight: 0 });
		expect(log.warn).toHaveBeenCalledWith("image queue paused", expect.anything());
		await vi.advanceTimersByTimeAsync(59_999);
		expect(resolveHint).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		await idle(q);
		expect(resolveHint).toHaveBeenCalledTimes(4);
		expect(q.stats().paused).toBe(false);
		expect(log.warn).toHaveBeenCalledWith("image queue resumed");
	});

	it("starts the series again after a found", async () => {
		resolveHint = vi.fn(async (h: WorkImageHint) => (h.title === "F" ? FOUND : UNAVAILABLE));
		const q = make();
		for (const t of ["A", "B", "F", "C", "D"]) q.enqueueHint(hint(t, "Pole"));
		await idle(q);
		expect(q.stats()).toMatchObject({ unavailable: 4, resolved: 1, paused: false });
		expect(resolveHint).toHaveBeenCalledTimes(5);
	});

	it("keeps the pause when the queue empties during it", async () => {
		resolveHint = vi.fn(async () => UNAVAILABLE);
		const q = make();
		for (const t of ["A", "B", "C"]) q.enqueueHint(hint(t, "Pole"));
		await until(() => q.stats().paused);
		q.enqueueHint(hint("Late", "Pole"));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(resolveHint).toHaveBeenCalledTimes(3);
	});
});

describe("stop", () => {
	it("finishes the running job and never starts the next one", async () => {
		const g = gate();
		resolveHint = vi.fn(() => g.promise);
		const q = make();
		q.enqueueHint(hint("A", "Pole"));
		q.enqueueHint(hint("B", "Pole"));
		await until(() => resolveHint.mock.calls.length === 1);
		const stopped = q.stop();
		g.open();
		await stopped;
		expect(resolveHint).toHaveBeenCalledTimes(1);
		expect((await readImageSidecar(dir, "project:a--pole" as Slug))?.state).toBe("found");
		expect(await readImageSidecar(dir, "project:b--pole" as Slug)).toBeNull();
		expect(q.stateOf("project:b--pole" as Slug)).toBe("idle");
		expect(q.enqueueHint(hint("C", "Pole"))).toEqual({ accepted: false, reason: "full" });
	});

	it("wakes a paused worker instead of waiting out the pause", async () => {
		resolveHint = vi.fn(async () => UNAVAILABLE);
		const q = make();
		for (const t of ["A", "B", "C", "D"]) q.enqueueHint(hint(t, "Pole"));
		await until(() => q.stats().paused);
		await q.stop();
		expect(resolveHint).toHaveBeenCalledTimes(3);
	});
});

describe("calls", () => {
	it("resolves at background priority and never writes a node", async () => {
		nodes.set("project:old", projectNode("old", "Old"));
		const q = make();
		q.enqueueNode(nodes.get("project:old") as NodePayload);
		q.enqueueHint(hint("A", "Pole"));
		await idle(q);
		expect(resolveNode).toHaveBeenCalledTimes(1);
		expect(resolveNode.mock.calls[0]?.[1]).toMatchObject({ cache, priority: "background" });
		expect(resolveHint).toHaveBeenCalledTimes(1);
		expect(resolveHint.mock.calls[0]?.[1]).toMatchObject({ mbOptions: { priority: "background" } });
		expect(cache.write).not.toHaveBeenCalled();
		expect(cache.update).not.toHaveBeenCalled();
	});

	it("hands the resolvers a fetch that wraps the injected one", async () => {
		const injected = vi.fn(async () => new Response("ok"));
		resolveHint = vi.fn(async (_h: WorkImageHint, deps: { fetch?: typeof fetch }) => {
			await (deps.fetch as typeof fetch)("https://coverartarchive.org/x");
			return FOUND;
		});
		const q = make({ fetch: injected as unknown as typeof fetch });
		q.enqueueHint(hint("A", "Pole"));
		await idle(q);
		expect(injected).toHaveBeenCalledTimes(1);
		const init = (injected.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("until", () => {
	it("accepts a condition that becomes true after more than 5 000 loop turns", async () => {
		let calls = 0;
		await until(() => ++calls >= 6_000);
		expect(calls).toBe(6_000);
	});

	it("still fails with the same message once the real-time deadline passes", async () => {
		// short deadline so the case does not wait the full 10 s; Date is faked here, so this also
		// proves the deadline is read from performance.now()
		const started = performance.now();
		await expect(until(() => false, 50)).rejects.toThrow("condition never became true");
		expect(performance.now() - started).toBeGreaterThanOrEqual(50);
	});
});
