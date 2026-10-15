import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ArtistNode, Slug, TrackNode } from "../src/types.js";

// TRA-502: real server + real NodeCache on a temp directory that also holds files OUTSIDE
// `cache/nodes/<type>/` which must never be served or quoted.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let directory: string;
let child: ChildProcess;
let port: number;
const logs = { stdout: "", stderr: "" };

function artist(slug: string, name: string): ArtistNode {
	return {
		slug: slug as Slug,
		type: "artist",
		name,
		editorial_article: "A fixture artist article long enough to satisfy the cache schema. ".repeat(2),
		editorial_bio: "A fixture artist bio.",
		citations: [{ url: "https://example.com/fixture-artist" }],
		materialized_at: new Date().toISOString(),
		photo_url: "https://images.example.com/fixture.jpg",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
	};
}

function track(slug: string, name: string): TrackNode {
	return {
		slug: slug as Slug,
		type: "track",
		name,
		editorial_article: "A fixture track article long enough to satisfy the cache schema. ".repeat(2),
		editorial_teaser: "A fixture track teaser.",
		citations: [{ url: "https://example.com/fixture-track" }],
		materialized_at: new Date().toISOString(),
		artists: [{ slug: "artist:fixture" as Slug, type: "artist", name: "Fixture" }],
		genres: [],
		producers: [],
		personnel: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
	};
}

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

async function get(path: string): Promise<{ status: number; body: string }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	return { status: response.status, body: await response.text() };
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "odyssey-slug-traversal-"));
	const cacheDir = join(directory, "cache");
	const cache = new NodeCache(cacheDir);
	await cache.write(artist("artist:fixture", "Fixture"));
	await cache.write(track("track:fixture-track", "Fixture Track"));
	// Legacy non-canonical slug, no path separator: must stay readable.
	await mkdir(join(cacheDir, "nodes", "artist"), { recursive: true });
	await writeFile(
		join(cacheDir, "nodes", "artist", "Legacy_Name.v2.json"),
		JSON.stringify(artist("artist:Legacy_Name.v2", "Legacy Name")),
	);
	// A non-JSON node file inside the cache, and valid / non-JSON files OUTSIDE it.
	await writeFile(join(cacheDir, "nodes", "artist", "broken.json"), "SECRET=hunter2-do-not-leak\n");
	await writeFile(join(directory, "outside.json"), JSON.stringify(artist("artist:outside", "Outside Leak")));
	await writeFile(join(directory, "secret.json"), "SECRET=hunter2-do-not-leak\n");
	await mkdir(join(directory, "outside-nodes", "track"), { recursive: true });
	await writeFile(
		join(directory, "outside-nodes", "track", "t.json"),
		JSON.stringify(track("track:t", "Outside Track Leak")),
	);

	port = await availablePort();
	child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PORT: String(port),
			ODYSSEY_CACHE_DIR: cacheDir,
			MOBILE_STATE_DIR: join(directory, "mobile-state"),
			STREAM_CACHE_DIR: join(directory, "stream-cache"),
			GEMINI_API_KEY: "test-gemini-key",
			TAVILY_API_KEY: "test-tavily-key",
			FIRECRAWL_API_KEY: "test-firecrawl-key",
			MB_BASE_URL: "http://127.0.0.1:1",
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
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`server failed to start: ${logs.stderr || logs.stdout}`);
		try {
			if ((await get("/health")).status === 200) return;
		} catch {
			// tsx may need a moment before the listener exists.
		}
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`server did not start: ${logs.stderr || logs.stdout}`);
}, 30_000);

afterAll(async () => {
	if (child?.pid !== undefined && child.exitCode === null) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
	await rm(directory, { recursive: true, force: true });
});

const TRAVERSALS = [
	"artist:..%2F..%2F..%2Foutside",
	"artist:..%2F..%2Foutside",
	"artist:..%5C..%5C..%5Coutside",
	"artist:%2E%2E%2F%2E%2E%2F%2E%2E%2Foutside",
	"artist:..%2F..%2F..%2Fsecret",
	"artist:%00",
	"artist:a%2Fb",
	"track:..%2F..%2F..%2Foutside-nodes%2Ftrack%2Ft",
];

describe("slug path traversal on the HTTP routes (TRA-502)", () => {
	for (const route of ["node", "image", "links", "resolve"]) {
		it.each(TRAVERSALS)(
			`GET /${route}/%s answers 400 and serves nothing from outside nodes/<type>/`,
			async (slug) => {
				const response = await get(`/${route}/${slug}`);
				expect(response.status).toBe(400);
				expect(response.body).not.toContain("Outside");
				expect(response.body).not.toContain("SECRET");
				expect(response.body).not.toContain("hunter2");
			},
		);
	}

	it("a non-JSON node file inside the cache answers without any content extract", async () => {
		for (const route of ["node", "image", "links"]) {
			const response = await get(`/${route}/artist:broken`);
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.body).not.toContain("SECRET");
			expect(response.body).not.toContain("hunter2");
			expect(response.body).not.toContain("valid JSON");
		}
	});

	it("a malformed percent-escape is a 400, not a 500", async () => {
		for (const route of ["node", "image", "resolve"]) {
			expect((await get(`/${route}/artist:%E0%A4%A`)).status).toBe(400);
		}
	});

	it("still serves a canonical node and a legacy non-canonical slug without a path separator", async () => {
		const canonical = await get("/node/artist:fixture");
		expect(canonical.status).toBe(200);
		expect(JSON.parse(canonical.body)).toMatchObject({ node: { name: "Fixture" } });
		const legacy = await get("/node/artist:Legacy_Name.v2");
		expect(legacy.status).toBe(200);
		expect(JSON.parse(legacy.body)).toMatchObject({ node: { name: "Legacy Name" } });
		expect((await get("/image/artist:fixture")).status).toBe(200);
	});

	it("keeps answering 404 for a well formed slug that is not cached", async () => {
		expect((await get("/node/artist:nobody-here")).status).toBe(404);
	});
});
