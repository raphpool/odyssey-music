import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCacheIndex, type CacheIndex, createCacheIndexHolder } from "../src/cache-index.js";

const MBID = "11111111-2222-3333-4444-555555555555";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-cache-index-holder-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeArtist(name: string, mbid: string): Promise<void> {
	await mkdir(join(dir, "nodes", "artist"), { recursive: true });
	await writeFile(
		join(dir, "nodes", "artist", `${name}.json`),
		JSON.stringify({ type: "artist", name, mbid }),
	);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("createCacheIndexHolder", () => {
	it("runs a single build for concurrent get() calls and shares its result", async () => {
		await writeArtist("nina", MBID);
		const gate = deferred();
		let builds = 0;
		const holder = createCacheIndexHolder(async () => {
			builds++;
			await gate.promise;
			return buildCacheIndex(dir);
		});

		const first = holder.get();
		const second = holder.get();
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);

		expect(builds).toBe(1);
		expect(a).toBe(b);
		expect(a.byMbid(MBID)).toBe("artist:nina");
		// Published: a later call neither rebuilds nor returns another instance.
		expect(await holder.get()).toBe(a);
		expect(builds).toBe(1);
	});

	it("does not publish a build that was invalidated mid-flight, so the next get() sees the write", async () => {
		const gate = deferred();
		const scanned = deferred();
		let builds = 0;
		const holder = createCacheIndexHolder(async () => {
			builds++;
			const index = await buildCacheIndex(dir);
			if (builds === 1) {
				scanned.resolve();
				await gate.promise;
			}
			return index;
		});

		const stale = holder.get();
		await scanned.promise;
		// The write lands after the first scan read the directory, then the writer invalidates.
		await writeArtist("nina", MBID);
		holder.invalidate();
		gate.resolve();

		expect((await stale).byMbid(MBID)).toBeNull();
		const fresh = await holder.get();
		expect(builds).toBe(2);
		expect(fresh.byMbid(MBID)).toBe("artist:nina");
		expect(await holder.get()).toBe(fresh);
		expect(builds).toBe(2);
	});

	it("a get() issued after an invalidation does not join the stale build", async () => {
		const gate = deferred();
		let builds = 0;
		const holder = createCacheIndexHolder(async () => {
			const n = ++builds;
			if (n === 1) await gate.promise;
			return buildCacheIndex(dir);
		});

		const stale = holder.get();
		await writeArtist("nina", MBID);
		holder.invalidate();
		const fresh = await holder.get();
		gate.resolve();
		await stale;

		expect(fresh.byMbid(MBID)).toBe("artist:nina");
		// The late-finishing stale build must not overwrite the published fresh index.
		expect(await holder.get()).toBe(fresh);
		expect(builds).toBe(2);
	});

	it("does not cache a failed build: the next get() retries", async () => {
		let builds = 0;
		const holder = createCacheIndexHolder(async (): Promise<CacheIndex> => {
			builds++;
			if (builds === 1) throw new Error("scan failed");
			return buildCacheIndex(dir);
		});

		await expect(holder.get()).rejects.toThrow("scan failed");
		const index = await holder.get();
		expect(builds).toBe(2);
		expect(index.byMbid(MBID)).toBeNull();
	});
});
