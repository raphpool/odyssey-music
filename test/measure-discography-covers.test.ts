import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatReport,
	isInside,
	measureHttp,
	measureOffline,
	parseArtists,
} from "../scripts/measure-discography-covers.js";
import { imageSidecarPath, writeImageSidecar } from "../src/images/image-sidecar.js";
import type { Slug } from "../src/types.js";

const ARTIST: Slug = "artist:kode9";
const COVER = "https://coverartarchive.org/release-group/5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111/front-500";
const MBID = "5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "measure-covers-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeNode(slug: Slug, node: Record<string, unknown>): Promise<void> {
	const [type, body] = slug.split(":") as [string, string];
	const file = join(dir, "nodes", type, `${body}.json`);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ slug, ...node }), "utf8");
}

function edge(slug: Slug, mbid?: string): Record<string, unknown> {
	return { slug, type: "project", name: slug, ...(mbid ? { mbid } : {}) };
}

async function writeSidecar(
	key: Slug,
	state: "found" | "missing" | "unavailable" | "conflict",
): Promise<void> {
	await writeImageSidecar(dir, {
		key,
		state,
		...(state === "found" ? { url: COVER, source: "caa" as const } : {}),
		hint: { title: "t", artist: "a" },
		resolvedAt: new Date().toISOString(),
	});
}

/** Relative path -> content, for every file under `root`. */
async function snapshot(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (d: string): Promise<void> => {
		for (const e of await readdir(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else out[p.slice(root.length)] = await readFile(p, "utf8");
		}
	};
	await walk(root);
	return out;
}

const A: Slug = "project:with-node--kode9";
const B: Slug = "project:sidecar-found--kode9";
const C: Slug = "project:sidecar-missing--kode9";
const D: Slug = "project:nothing--kode9";

async function fourEdgeArtist(): Promise<void> {
	await writeNode(ARTIST, { discography: [edge(A, MBID), edge(B, MBID), edge(C), edge(D, MBID)] });
	await writeNode(A, { image_url: COVER });
	await writeSidecar(B, "found");
	await writeSidecar(C, "missing");
}

describe("measureOffline", () => {
	it("counts a node image and a found sidecar as found, a missing sidecar as missing, nothing as absent", async () => {
		await fourEdgeArtist();
		const { rows, totals } = await measureOffline(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			artist: ARTIST,
			edges: 4,
			withMbid: 3,
			found: 2,
			missing: 1,
			unavailable: 0,
			conflict: 0,
			absent: 1,
			none: 0,
			error: 0,
		});
		expect(totals).toMatchObject({ edges: 4, withMbid: 3, found: 2, missing: 1, absent: 1 });
	});

	it("falls back to the sidecar when the project node has no image_url, and counts unavailable and conflict", async () => {
		await writeNode(ARTIST, { discography: [edge(A), edge(B), edge(C)] });
		await writeNode(A, { name: "no image" });
		await writeSidecar(A, "unavailable");
		await writeSidecar(B, "conflict");
		await writeSidecar(C, "found");
		const { rows } = await measureOffline(dir);
		expect(rows[0]).toMatchObject({ edges: 3, found: 1, unavailable: 1, conflict: 1, absent: 0 });
	});

	it("counts a corrupt sidecar as absent, without throwing and without deleting it", async () => {
		await writeNode(ARTIST, { discography: [edge(A), edge(B)] });
		await writeSidecar(B, "found");
		const file = imageSidecarPath(dir, A);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, "{ not json", "utf8");
		const before = await snapshot(dir);
		const { rows } = await measureOffline(dir);
		expect(rows[0]).toMatchObject({ edges: 2, found: 1, absent: 1 });
		expect(await snapshot(dir)).toEqual(before);
	});

	it("counts a sidecar whose cover host is refused as absent, and leaves it on disk", async () => {
		await writeNode(ARTIST, { discography: [edge(A)] });
		const file = imageSidecarPath(dir, A);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({
				key: A,
				state: "found",
				url: "https://evil.example/cover.jpg",
				source: "caa",
				hint: { title: "t", artist: "a" },
				resolvedAt: new Date().toISOString(),
			}),
			"utf8",
		);
		const { rows } = await measureOffline(dir);
		expect(rows[0]).toMatchObject({ edges: 1, found: 0, absent: 1 });
		expect(await readFile(file, "utf8")).toContain("evil.example");
	});

	it("does not count a node image on a refused host, and keeps a node without discography as a 0-edge row", async () => {
		await writeNode(ARTIST, { discography: [edge(A)] });
		await writeNode(A, { image_url: "https://evil.example/cover.jpg" });
		await writeNode("artist:burial", { name: "Burial" });
		const { rows, skipped } = await measureOffline(dir);
		expect(rows.find((r) => r.artist === ARTIST)).toMatchObject({ edges: 1, found: 0, absent: 1 });
		expect(rows.find((r) => r.artist === "artist:burial")).toMatchObject({ edges: 0 });
		expect(skipped).toEqual([]);
	});

	it("restricts to --artists and totals the rows", async () => {
		await fourEdgeArtist();
		await writeNode("artist:burial", { discography: [edge(B)] });
		await writeNode("artist:other", { discography: [edge(D)] });
		const all = await measureOffline(dir);
		expect(all.rows.map((r) => r.artist)).toEqual(["artist:burial", ARTIST, "artist:other"]);
		expect(all.totals).toMatchObject({ edges: 6, found: 3, absent: 2, missing: 1 });
		const some = await measureOffline(dir, [ARTIST, "artist:burial"]);
		expect(some.rows.map((r) => r.artist)).toEqual([ARTIST, "artist:burial"]);
		expect(some.totals).toMatchObject({ edges: 5, found: 3 });
	});

	it("reports an artist with no node as skipped instead of a row of zeros", async () => {
		await fourEdgeArtist();
		const { rows, skipped } = await measureOffline(dir, [ARTIST, "artist:ghost"]);
		expect(rows.map((r) => r.artist)).toEqual([ARTIST]);
		expect(skipped).toEqual(["artist:ghost"]);
	});

	it("rejects a cache directory without nodes/artist", async () => {
		await expect(measureOffline(dir)).rejects.toThrow(/nodes\/artist/);
	});

	it("leaves the repository cache untouched (git status stays clean)", async () => {
		const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const status = (): string =>
			execFileSync("git", ["status", "--porcelain", "--", "cache"], { cwd: root, encoding: "utf8" });
		const before = status();
		const { rows } = await measureOffline(join(root, "cache"));
		expect(rows.length).toBeGreaterThan(0);
		expect(status()).toBe(before);
	});
});

const BASE = "http://127.0.0.1:9/api/odyssey";

interface Call {
	url: string;
	headers: Record<string, string>;
}

function fakeFetch(
	node: unknown,
	imageAnswers: Array<() => Response>,
): { fetch: typeof fetch; calls: Call[]; sleeps: number[]; sleep: (ms: number) => Promise<void> } {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	let i = 0;
	const fake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		if (url.includes("/node/")) return Response.json({ source: "cache", node });
		const answer = imageAnswers[Math.min(i++, imageAnswers.length - 1)];
		if (!answer) throw new Error("no answer");
		return answer();
	}) as typeof fetch;
	return {
		fetch: fake,
		calls,
		sleeps,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
}

const pending = (retry?: number) => (): Response =>
	Response.json(
		{ image_url: null, state: "pending", ...(retry === undefined ? {} : { retry_after_seconds: retry }) },
		{ status: 202 },
	);
const found = (): Response => Response.json({ image_url: COVER, state: "found" });
const none = (): Response => Response.json({ image_url: null, state: "none" });

describe("measureHttp", () => {
	const node = { discography: [edge("project:sine-of-the-dub--kode9", MBID)] };

	it("retries a 202 then counts the 200 found: 2 /image requests, from= on each, one /node", async () => {
		const f = fakeFetch(node, [pending(7), found]);
		const { rows, totals } = await measureHttp(BASE, [ARTIST], { fetch: f.fetch, sleep: f.sleep });
		expect(rows[0]).toMatchObject({ artist: ARTIST, edges: 1, withMbid: 1, found: 1, none: 0, error: 0 });
		expect(totals.found).toBe(1);
		const images = f.calls.filter((c) => c.url.includes("/image/"));
		expect(images).toHaveLength(2);
		for (const c of images) {
			expect(c.url).toBe(
				`${BASE}/image/${encodeURIComponent("project:sine-of-the-dub--kode9")}?from=${encodeURIComponent(ARTIST)}`,
			);
		}
		expect(f.calls.filter((c) => c.url.includes("/node/"))).toEqual([
			expect.objectContaining({ url: `${BASE}/node/${encodeURIComponent(ARTIST)}` }),
		]);
		expect(f.sleeps).toEqual([7000]);
	});

	it("gives up after 6 pending answers: none, 6 requests, 5 waits bounded to 2..30 s", async () => {
		const f = fakeFetch(node, [pending(100), pending(0), pending(), pending(), pending(), pending()]);
		const { rows } = await measureHttp(BASE, [ARTIST], { fetch: f.fetch, sleep: f.sleep });
		expect(rows[0]).toMatchObject({ found: 0, none: 1, error: 0 });
		expect(f.calls.filter((c) => c.url.includes("/image/"))).toHaveLength(6);
		expect(f.sleeps).toEqual([30000, 2000, 5000, 5000, 5000]);
	});

	it("counts a 200 without image_url as none, and a network error or a 5xx as error", async () => {
		const wide = {
			discography: [
				edge("project:a--kode9"),
				edge("project:b--kode9"),
				edge("project:c--kode9"),
				edge("project:d--kode9"),
			],
		};
		const f = fakeFetch(wide, [
			none,
			() => Response.json({ error: "boom" }, { status: 500 }),
			() => {
				throw new Error("ECONNRESET");
			},
			found,
		]);
		const { rows } = await measureHttp(BASE, [ARTIST], { fetch: f.fetch, sleep: f.sleep });
		expect(rows[0]).toMatchObject({ edges: 4, none: 1, error: 2, found: 1 });
	});

	it("only ever requests URLs under --base, with the measure user agent", async () => {
		const f = fakeFetch(node, [found]);
		await measureHttp(`${BASE}/`, [ARTIST], { fetch: f.fetch, sleep: f.sleep });
		expect(f.calls.length).toBeGreaterThan(0);
		for (const c of f.calls) {
			expect(c.url.startsWith(`${BASE}/`)).toBe(true);
			expect(c.url).not.toMatch(/musicbrainz|coverartarchive/);
			expect(c.headers["User-Agent"]).toBe("odyssey-measure/1");
		}
	});

	it("skips an artist whose /node does not answer a node, and says why", async () => {
		const problems: string[] = [];
		const f = {
			fetch: (async () => Response.json({ error: "not cached" }, { status: 404 })) as typeof fetch,
			sleep: async () => {},
			onProblem: (m: string) => problems.push(m),
		};
		const { rows, skipped } = await measureHttp(BASE, [ARTIST], f);
		expect(rows).toEqual([]);
		expect(skipped).toEqual([ARTIST]);
		expect(problems).toEqual([`${BASE}/node/${encodeURIComponent(ARTIST)}: HTTP 404`]);
	});
});

describe("command line helpers", () => {
	it("tells a path inside the cache from one outside it", () => {
		expect(isInside("/c", "/c/images/x.json")).toBe(true);
		expect(isInside("/c", "/c/..out.json")).toBe(true);
		expect(isInside("/c", "/c/../out.json")).toBe(false);
		expect(isInside("/c", "/elsewhere/out.json")).toBe(false);
	});

	it("deduplicates --artists and refuses a non-artist slug", () => {
		expect(parseArtists(" artist:kode9, artist:burial,artist:kode9 ")).toEqual([
			"artist:kode9",
			"artist:burial",
		]);
		expect(() => parseArtists("artist:kode9,project:go-plastic--squarepusher")).toThrow(/project:go-plastic/);
		expect(() => parseArtists("artist:")).toThrow(/artist slugs/);
	});
});

describe("formatReport", () => {
	it("prints one line per artist, the totals and the found rate", async () => {
		await fourEdgeArtist();
		const report = await measureOffline(dir);
		const text = formatReport("offline", report);
		expect(text).toContain("artist:kode9");
		expect(text).toContain("absent");
		expect(text).toContain("found 2/4 (50.0%)");
	});
});
