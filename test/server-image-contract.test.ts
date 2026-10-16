import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { writeImageSidecar } from "../src/images/image-sidecar.js";
import { makeScopedSlug } from "../src/slug.js";
import type { ArtistNode, Slug } from "../src/types.js";

// TRA-583 (plan graph-integrity 3b-D5): the HTTP contract of GET /image/:slug (200 found / 202 pending /
// 200 none), the warm-up done by GET /node/:slug, and the queue stats in GET /health. Real server process,
// real routes, real queue on a temp cache. The only mocked boundary is the network: the child preloads a
// `fetch` that never answers, so the worker holds its first job and every later one stays queued (pending)
// without any request leaving the machine.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NO_NETWORK = `data:text/javascript,${encodeURIComponent(`
globalThis.fetch = (_input, init) =>
	new Promise((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) return;
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason));
	});
`)}`;

const FOUND_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=3600";
const COVER_URL = "https://coverartarchive.org/release/abc/front-500.jpg";

type Reply = { status: number; headers: Headers; body: string; json: Record<string, unknown> };

interface TestServer {
	cacheDir: string;
	child: ChildProcess;
	get(path: string): Promise<Reply>;
}

const servers: TestServer[] = [];
let directory: string;

function scopedProject(title: string, artistName: string): Slug {
	const made = makeScopedSlug("project", title, artistName);
	if (!made.ok) throw new Error(`fixture cannot be scoped: ${made.reason}`);
	return made.slug;
}

function edge(type: "project", name: string, artist: string) {
	return { type, slug: scopedProject(name, artist), name };
}

function artist(slug: string, name: string, discography: ReturnType<typeof edge>[]): ArtistNode {
	return {
		slug: slug as Slug,
		type: "artist",
		name,
		editorial_article: "A fixture artist article long enough to satisfy the cache schema. ".repeat(2),
		editorial_bio: "A fixture artist bio.",
		citations: [{ url: "https://example.com/fixture-artist" }],
		materialized_at: new Date().toISOString(),
		genres: [],
		labels: [],
		discography,
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
	};
}

// One artist per scenario: the queue deduplicates, so a shared artist would make the tests order-dependent.
const FROM_BAND = { slug: "artist:from-band", name: "From Band", work: "Lost Album" };
const WARM_BAND = { slug: "artist:warm-band", name: "Warm Band", work: "Quiet Album" };
const MOBILE_BAND = { slug: "artist:mobile-band", name: "Mobile Band", work: "Pocket Album" };
const OFF_BAND = { slug: "artist:off-band", name: "Off Band", work: "Silent Album" };
const workSlug = (band: { name: string; work: string }): Slug => scopedProject(band.work, band.name);

async function availablePort(): Promise<number> {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once("error", fail);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") return fail(new Error("no port"));
			probe.close(() => done(address.port));
		});
	});
}

async function startServer(name: string, extraEnv: Record<string, string>): Promise<TestServer> {
	const cacheDir = join(directory, name, "cache");
	const cache = new NodeCache(cacheDir);
	for (const band of [FROM_BAND, WARM_BAND, MOBILE_BAND, OFF_BAND]) {
		// Two works: the worker takes the first one and the network never answers, so the second stays
		// queued whatever the machine load (a lone work could already be in flight when /health is read).
		await cache.write(
			artist(band.slug, band.name, [
				edge("project", band.work, band.name),
				edge("project", `${band.work} II`, band.name),
			]),
		);
	}
	const port = await availablePort();
	const logs = { stdout: "", stderr: "" };
	const child = spawn(process.execPath, ["--import", "tsx", "--import", NO_NETWORK, "src/server.ts"], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PORT: String(port),
			ODYSSEY_CACHE_DIR: cacheDir,
			MOBILE_STATE_DIR: join(directory, name, "mobile-state"),
			STREAM_CACHE_DIR: join(directory, name, "stream-cache"),
			GEMINI_API_KEY: "test-gemini-key",
			TAVILY_API_KEY: "test-tavily-key",
			FIRECRAWL_API_KEY: "test-firecrawl-key",
			MB_BASE_URL: "http://127.0.0.1:1",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		logs.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		logs.stderr += chunk.toString("utf8");
	});
	const get = async (path: string): Promise<Reply> => {
		const response = await fetch(`http://127.0.0.1:${port}${path}`);
		const body = await response.text();
		let parsed: Record<string, unknown> = {};
		try {
			parsed = JSON.parse(body) as Record<string, unknown>;
		} catch {
			// Not JSON: the assertions on `body` will say so.
		}
		return { status: response.status, headers: response.headers, body, json: parsed };
	};
	const server: TestServer = { cacheDir, child, get };
	servers.push(server);
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`server failed to start: ${logs.stderr || logs.stdout}`);
		try {
			if ((await get("/health")).status === 200) return server;
		} catch {
			// tsx may need a moment before the listener exists.
		}
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`server did not start: ${logs.stderr || logs.stdout}`);
}

let on: TestServer;
let off: TestServer;

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "odyssey-image-contract-"));
	[on, off] = await Promise.all([
		startServer("on", { ODYSSEY_ON_DEMAND_IMAGES: "1" }),
		startServer("off", { ODYSSEY_ON_DEMAND_IMAGES: "0" }),
	]);
}, 60_000);

afterAll(async () => {
	for (const { child } of servers) {
		if (child.pid !== undefined && child.exitCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}
	}
	await rm(directory, { recursive: true, force: true });
});

describe("GET /image/:slug, on-demand contract (TRA-583)", () => {
	it("answers 202 + Retry-After + no-store for a work listed by the page named in ?from=, then 200 found once resolved", async () => {
		const slug = workSlug(FROM_BAND);
		const pending = await on.get(
			`/image/${encodeURIComponent(slug)}?from=${encodeURIComponent(FROM_BAND.slug)}`,
		);
		expect(pending.status).toBe(202);
		expect(pending.headers.get("retry-after")).toBe("5");
		expect(pending.headers.get("cache-control")).toBe("no-store");
		expect(pending.json).toEqual({
			slug,
			image_url: null,
			source: "pending",
			state: "pending",
			retry_after_seconds: 5,
		});

		// What the worker does when it succeeds: a `found` sidecar entry under the work's key.
		await writeImageSidecar(on.cacheDir, {
			key: slug,
			state: "found",
			url: COVER_URL,
			source: "caa",
			hint: { title: FROM_BAND.work, artist: FROM_BAND.name },
			resolvedAt: new Date().toISOString(),
		});
		const found = await on.get(
			`/image/${encodeURIComponent(slug)}?from=${encodeURIComponent(FROM_BAND.slug)}`,
		);
		expect(found.status).toBe(200);
		expect(found.headers.get("cache-control")).toBe(FOUND_CACHE_CONTROL);
		expect(found.headers.get("retry-after")).toBeNull();
		expect(found.json).toEqual({ slug, image_url: COVER_URL, source: "caa", state: "found" });
	});

	it("answers 200 none/no-context with no-store for a work with no node and no ?from=", async () => {
		const reply = await on.get(`/image/${encodeURIComponent("project:never-seen--nobody")}`);
		expect(reply.status).toBe(200);
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(reply.json).toEqual({
			slug: "project:never-seen--nobody",
			image_url: null,
			source: "no-context",
			state: "none",
		});
	});

	it("answers 400 for a malformed ?from= and 200 none/no-context for an unknown but well formed one", async () => {
		const slug = encodeURIComponent("project:never-seen--nobody");
		for (const from of ["", "../x", "artist:..%2Fx", "artist:a%2Fb", "%E0%A4%A", "nonsense"]) {
			const reply = await on.get(`/image/${slug}?from=${from}`);
			expect(reply.status, `from=${from}`).toBe(400);
			expect(reply.json).toEqual({ error: "missing or malformed slug" });
		}
		const unknown = await on.get(`/image/${slug}?from=${encodeURIComponent("artist:unknown-band")}`);
		expect(unknown.status).toBe(200);
		expect(unknown.headers.get("cache-control")).toBe("no-store");
		expect(unknown.json).toMatchObject({ image_url: null, source: "no-context", state: "none" });
	});

	it("ignores every other query parameter", async () => {
		const reply = await on.get(
			`/image/${encodeURIComponent("project:never-seen--nobody")}?title=X&artist=Y&force=1`,
		);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ source: "no-context", state: "none" });
	});

	it("GET /node/:slug warms the page before answering: its works are pending without ?from=, the node answer is unchanged, /health counts the queue", async () => {
		const before = (await on.get("/health")).json;
		const node = await on.get(`/node/${encodeURIComponent(WARM_BAND.slug)}`);
		expect(node.status).toBe(200);
		expect(node.headers.get("cache-control")).toBeNull();
		expect(node.headers.get("retry-after")).toBeNull();
		expect(node.json).toMatchObject({
			source: "cache",
			node: { slug: WARM_BAND.slug, name: WARM_BAND.name },
		});

		const slug = workSlug(WARM_BAND);
		const image = await on.get(`/image/${encodeURIComponent(slug)}`);
		expect(image.status).toBe(202);
		expect(image.json).toMatchObject({ state: "pending", source: "pending" });

		const health = await on.get("/health");
		expect(health.status).toBe(200);
		expect(health.json).toMatchObject({ ok: true, on_demand_images: true });
		const images = health.json.images as Record<string, unknown>;
		expect(Object.keys(images).sort()).toEqual(
			[
				"conflicts",
				"dropped",
				"inFlight",
				"missing",
				"paused",
				"pending",
				"resolved",
				"skipped",
				"unavailable",
			].sort(),
		);
		expect(images.pending as number).toBeGreaterThanOrEqual(1);
		expect(images.pending as number).toBeGreaterThanOrEqual(
			((before.images as Record<string, number>).pending ?? 0) + 1,
		);
	});
});

describe("mobile image route shares the on-demand service (TRA-583, TRA-584)", () => {
	it("answers 202 + Retry-After + no-store for a pending work, and never 200 with a max-age", async () => {
		// Reading the page on mobile warms it; the work then has a job in the same queue as the web.
		const page = await on.get(`/mobile/v1/nodes/${encodeURIComponent(MOBILE_BAND.slug)}`);
		expect(page.status).toBe(200);

		const reply = await on.get(`/mobile/v1/nodes/${encodeURIComponent(workSlug(MOBILE_BAND))}/image`);
		expect(reply.status).toBe(202);
		expect(reply.headers.get("retry-after")).toBe("5");
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(reply.headers.get("cache-control")).not.toContain("max-age");
		expect(reply.json).toMatchObject({ image_url: null, source: "pending", state: "pending" });
	});
});

describe("ODYSSEY_ON_DEMAND_IMAGES=0 (TRA-583)", () => {
	it("restores the read-only answers: 200 not-cached with the old public Cache-Control, no warm-up, health says off", async () => {
		const slug = workSlug(OFF_BAND);
		const node = await off.get(`/node/${encodeURIComponent(OFF_BAND.slug)}`);
		expect(node.status).toBe(200);

		const image = await off.get(
			`/image/${encodeURIComponent(slug)}?from=${encodeURIComponent(OFF_BAND.slug)}`,
		);
		expect(image.status).toBe(200);
		expect(image.headers.get("cache-control")).toBe(FOUND_CACHE_CONTROL);
		expect(image.headers.get("retry-after")).toBeNull();
		expect(image.json).toMatchObject({ image_url: null, source: "not-cached" });

		const health = await off.get("/health");
		expect(health.json).toMatchObject({ ok: true, on_demand_images: false });
		expect((health.json.images as Record<string, unknown>).pending).toBe(0);
	});
});
