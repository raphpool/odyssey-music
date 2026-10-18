import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../../src/cache.js";
import { createImageQueue, type EnqueueOutcome, type ImageQueue } from "../../src/images/image-queue.js";
import {
	IMAGE_RULES_VERSION,
	imageSidecarPath,
	readImageSidecar,
	writeImageSidecar,
} from "../../src/images/image-sidecar.js";
import { createImageService } from "../../src/services/image-service.js";
import type { NodePayload, Slug } from "../../src/types.js";
import { projectNode } from "./helpers.js";

// TRA-612: a refusal (`missing`, `conflict`) written under older rules is computed again; the rest keeps its life.
const KEY = "project:rules-version" as Slug;
const COVER = "https://coverartarchive.org/release-group/5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111/front-500";
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const now = (): number => NOW;
const recent = new Date(NOW - 60 * 60 * 1000).toISOString();

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "rules-version-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A file as an older server wrote it: exactly these fields, no `rules` unless given. */
async function putRaw(key: Slug, fields: Record<string, unknown>): Promise<void> {
	const file = imageSidecarPath(dir, key);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		JSON.stringify({ key, hint: { title: "Rules", artist: "Version" }, resolvedAt: recent, ...fields }),
	);
}

const missing = { state: "missing", reason: "no-match" };
const found = { state: "found", url: COVER, source: "caa" };

describe("sidecar entries and the rules version", () => {
	it("reads a fresh refusal written without a version as stale, and with an older one too", async () => {
		await putRaw(KEY, missing);
		expect(await readImageSidecar(dir, KEY, now)).toBeNull();
		await putRaw(KEY, { ...missing, rules: IMAGE_RULES_VERSION - 1 });
		expect(await readImageSidecar(dir, KEY, now)).toBeNull();
		await putRaw(KEY, { state: "conflict" });
		expect(await readImageSidecar(dir, KEY, now)).toBeNull();
	});

	it("keeps a refusal written under the current version", async () => {
		await putRaw(KEY, { ...missing, rules: IMAGE_RULES_VERSION });
		expect(await readImageSidecar(dir, KEY, now)).toMatchObject({ state: "missing", reason: "no-match" });
	});

	it("serves a found entry without a version, and a fresh unavailable one", async () => {
		await putRaw(KEY, found);
		expect(await readImageSidecar(dir, KEY, now)).toMatchObject({ state: "found", url: COVER });
		await putRaw(KEY, { state: "unavailable" });
		expect(await readImageSidecar(dir, KEY, now)).toMatchObject({ state: "unavailable" });
	});

	it("stamps every entry it writes with the current version", async () => {
		await writeImageSidecar(dir, {
			key: KEY,
			state: "missing",
			reason: "no-match",
			hint: { title: "R", artist: "V" },
			resolvedAt: recent,
		});
		expect(JSON.parse(await readFile(imageSidecarPath(dir, KEY), "utf8"))).toMatchObject({
			rules: IMAGE_RULES_VERSION,
		});
	});
});

describe("the image service on a stale refusal", () => {
	let cache: NodeCache;
	beforeEach(() => {
		cache = new NodeCache(join(dir, "nodes"));
	});

	function setup() {
		const pending = new Set<Slug>();
		const enqueueNode = vi.fn((node: NodePayload): EnqueueOutcome => {
			pending.add(node.slug);
			return { accepted: true, key: node.slug };
		});
		const queue = {
			enqueueNode,
			enqueueHint: vi.fn(),
			stateOf: (key: Slug) => (pending.has(key) ? "pending" : "idle"),
			aliasOf: () => null,
			stats: vi.fn(),
			stop: vi.fn(),
		} as unknown as ImageQueue;
		const service = createImageService({
			cache,
			redirects: new Map(),
			now,
			onDemand: { queue, cacheDir: dir },
		});
		return { service, enqueueNode };
	}

	it("answers pending and queues a missing entry written without a version", async () => {
		await cache.write(projectNode("rules-version", "Rules Version"));
		await putRaw(KEY, missing);
		const { service, enqueueNode } = setup();
		expect(await service.resolveDisplayImage(KEY)).toMatchObject({ state: "pending", source: "pending" });
		expect(enqueueNode).toHaveBeenCalledTimes(1);
	});

	it("does not re-evaluate a missing entry at the current version", async () => {
		await cache.write(projectNode("rules-version", "Rules Version"));
		await putRaw(KEY, { ...missing, rules: IMAGE_RULES_VERSION });
		const { service, enqueueNode } = setup();
		expect(await service.resolveDisplayImage(KEY)).toMatchObject({ state: "none", source: "no-match" });
		expect(enqueueNode).not.toHaveBeenCalled();
	});

	it("serves a found entry without a version, with no re-evaluation", async () => {
		await cache.write(projectNode("rules-version", "Rules Version"));
		await putRaw(KEY, found);
		const { service, enqueueNode } = setup();
		expect(await service.resolveDisplayImage(KEY)).toMatchObject({ state: "found", image_url: COVER });
		expect(enqueueNode).not.toHaveBeenCalled();
	});
});

describe("the queue on a stale refusal", () => {
	async function run(fields: Record<string, unknown>) {
		const node = projectNode("rules-version", "Rules Version");
		await putRaw(KEY, fields);
		const resolveNode = vi.fn(async () => ({ url: COVER, source: "caa" as const }));
		const queue = createImageQueue({
			cacheDir: dir,
			cache: { get: async () => node } as unknown as NodeCache,
			resolveNode: resolveNode as unknown as Parameters<typeof createImageQueue>[0]["resolveNode"],
			resolveHint: vi.fn() as unknown as Parameters<typeof createImageQueue>[0]["resolveHint"],
			log: { info: () => {}, warn: () => {} },
			now: () => Date.now(),
		});
		queue.enqueueNode(node);
		await vi.waitFor(() => expect(queue.stats()).toMatchObject({ pending: 0, inFlight: 0 }));
		await queue.stop();
		return resolveNode;
	}

	it("resolves the work again, and writes the new verdict under the current version", async () => {
		// resolvedAt is relative to the real clock here: the queue reads Date.now.
		const resolveNode = await run({ ...missing, resolvedAt: new Date().toISOString() });
		expect(resolveNode).toHaveBeenCalledTimes(1);
		expect(await readImageSidecar(dir, KEY)).toMatchObject({ state: "found", rules: IMAGE_RULES_VERSION });
	});

	it("leaves a refusal at the current version alone", async () => {
		const resolveNode = await run({
			...missing,
			rules: IMAGE_RULES_VERSION,
			resolvedAt: new Date().toISOString(),
		});
		expect(resolveNode).not.toHaveBeenCalled();
	});
});
