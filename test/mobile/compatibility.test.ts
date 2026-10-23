import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NodeCache } from "../../src/cache.js";
import type { ArtistNode, GenreNode, TrackNode } from "../../src/types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const videoId = "dQw4w9WgXcQ";
const requestId = "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd";
const runningServers: RunningServer[] = [];

interface HttpResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

interface RunningServer {
	child: ChildProcess;
	port: number;
	directory: string;
	logs: { stdout: string; stderr: string };
}

const FIXTURE_IMAGE = "https://coverartarchive.org/release/fixture/front-500.jpg";

function artistNode(): ArtistNode {
	return {
		slug: "artist:fixture-artist",
		type: "artist",
		name: "Fixture Artist",
		editorial_article: "A fixture artist article long enough to satisfy the cache schema. ".repeat(2),
		editorial_bio: "A fixture artist bio.",
		citations: [{ url: "https://example.com/fixture-artist" }],
		materialized_at: new Date().toISOString(),
		// Unverified legacy field, kept to prove GET /image no longer serves it (TRA-592); the stored, verified
		// image is image_url.
		photo_url: "https://images.example.com/fixture-artist.jpg",
		image_url: FIXTURE_IMAGE,
		image_source: "caa",
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

function genreNode(): GenreNode {
	return {
		slug: "genre:ambient",
		type: "genre",
		name: "Ambient",
		editorial_article: "A fixture ambient article long enough to satisfy the cache schema. ".repeat(2),
		editorial_definition: "A fixture genre definition.",
		citations: [{ url: "https://example.com/ambient" }],
		materialized_at: new Date().toISOString(),
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
	};
}

function trackNode(): TrackNode {
	return {
		slug: "track:fixture-track",
		type: "track",
		name: "Fixture Track",
		editorial_article: "A fixture track article long enough to satisfy the cache schema. ".repeat(2),
		editorial_teaser: "A fixture track teaser.",
		citations: [{ url: "https://example.com/fixture-track" }],
		materialized_at: new Date().toISOString(),
		artists: [{ slug: "artist:fixture-artist", type: "artist", name: "Fixture Artist" }],
		genres: [],
		producers: [],
		personnel: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
	};
}

afterEach(async () => {
	await Promise.all(
		runningServers.splice(0).map(async (server) => {
			if (server.child.exitCode === null && server.child.signalCode === null) {
				await new Promise<void>((done) => {
					const forceStop = setTimeout(() => signalServer(server.child, "SIGKILL"), 250);
					const timeout = setTimeout(done, 1_000);
					server.child.once("exit", () => {
						clearTimeout(forceStop);
						clearTimeout(timeout);
						done();
					});
					signalServer(server.child, "SIGTERM");
				});
			}
			await rm(server.directory, { recursive: true, force: true });
		}),
	);
});

describe("mobile facade compatibility", () => {
	it("keeps the legacy routes intact while the real server exposes validated mobile responses", async () => {
		const server = await startServer();

		const health = await http(server.port, "GET", "/health");
		expect(json(health)).toMatchObject({ ok: true });

		const graph = await http(server.port, "GET", "/data.json");
		expect(graph.status).toBe(200);
		expect(json<{ nodes: Array<{ id: string; article: string }> }>(graph).nodes).toContainEqual(
			expect.objectContaining({ id: "artist:fixture-artist", article: expect.any(String) }),
		);

		const legacyNode = await http(server.port, "GET", "/node/artist%3Afixture-artist");
		expect(json(legacyNode)).toMatchObject({ source: "cache", node: { slug: "artist:fixture-artist" } });

		const legacySearch = await http(server.port, "GET", "/search?q=ambient&type=genre");
		expect(json(legacySearch)).toMatchObject({
			q: "ambient",
			hits: [expect.objectContaining({ source: "cache", slug: "genre:ambient" })],
		});

		const legacyImage = await http(server.port, "GET", "/image/artist%3Afixture-artist");
		// 2026-10-16 (TRA-592): the stored image_url is served, not the fixture's unverified photo_url.
		expect(json(legacyImage)).toMatchObject({
			slug: "artist:fixture-artist",
			image_url: FIXTURE_IMAGE,
			source: "caa",
		});

		const legacyLinks = await http(server.port, "GET", "/links/genre%3Aambient");
		expect(json(legacyLinks)).toEqual({ slug: "genre:ambient", spotify: null, apple: null, sources: {} });

		const invalidMaterialize = await http(server.port, "POST", "/materialize", {});
		expect(invalidMaterialize).toMatchObject({ status: 400 });
		expect(json(invalidMaterialize)).toEqual({ error: "Provide {type, name}" });

		const resolve = await http(server.port, "GET", "/resolve/track%3Afixture-track");
		expect(json(resolve)).toMatchObject({ source: "cache", videoId });

		const stream = await http(server.port, "GET", `/stream/${videoId}`);
		expect(stream).toMatchObject({ status: 200, body: "fixture-audio" });
		expect(stream.headers["content-type"]).toBe("audio/mp4");

		const catalog = await http(server.port, "GET", "/mobile/v1/catalog");
		expect(json(catalog)).toMatchObject({ version: "v1" });
		const etag = catalog.headers.etag;
		expect(typeof etag).toBe("string");
		if (typeof etag !== "string") throw new Error("mobile catalog must provide an ETag");

		const cachedCatalog = await http(server.port, "GET", "/mobile/v1/catalog", undefined, {
			"If-None-Match": etag,
		});
		expect(cachedCatalog).toMatchObject({ status: 304, body: "" });

		const node = await http(server.port, "GET", "/mobile/v1/nodes/genre%3Aambient-music");
		expect(json(node)).toMatchObject({
			source: "cache",
			redirected_from: "genre:ambient-music",
			node: { id: "genre:ambient" },
		});

		// TRA-584: same slug, same source and URL as the legacy route; the mobile one adds the state.
		const mobileImage = await http(server.port, "GET", "/mobile/v1/nodes/artist%3Afixture-artist/image");
		expect(mobileImage.status).toBe(200);
		expect(json(mobileImage)).toMatchObject({
			slug: "artist:fixture-artist",
			image_url: FIXTURE_IMAGE,
			source: "caa",
			state: "found",
		});

		// Reading the page above enqueued its image job (TRA-583 wires the queue into the server): the first
		// answer is a 202 until the worker has written its verdict, exactly what a client is told to retry.
		let image = await http(server.port, "GET", "/mobile/v1/nodes/genre%3Aambient/image");
		for (let attempt = 0; attempt < 50 && image.status === 202; attempt += 1) {
			await new Promise((done) => setTimeout(done, 100));
			image = await http(server.port, "GET", "/mobile/v1/nodes/genre%3Aambient/image");
		}
		expect(image.status).toBe(200);
		expect(json(image)).toMatchObject({ slug: "genre:ambient", image_url: null, state: "none" });

		// A slug without a node is no longer a 404 (the iOS store memoizes it as unavailable): it is a "none".
		const danglingImage = await http(server.port, "GET", "/mobile/v1/nodes/project%3Anowhere/image");
		expect(danglingImage.status).toBe(200);
		expect(danglingImage.headers["cache-control"]).toBe("no-store");
		expect(json(danglingImage)).toMatchObject({ slug: "project:nowhere", image_url: null, state: "none" });

		const links = await http(server.port, "GET", "/mobile/v1/nodes/genre%3Aambient/links");
		expect(json(links)).toMatchObject({ slug: "genre:ambient", spotify: null, apple: null, sources: {} });

		const search = await http(server.port, "GET", "/mobile/v1/search?q=ambient&type=genre&limit=5");
		expect(json(search)).toMatchObject({
			hits: [expect.objectContaining({ source: "cache", slug: "genre:ambient" })],
		});

		const generation = await http(server.port, "POST", "/mobile/v1/generations", {
			request_id: requestId,
			type: "artist",
			name: "Fixture Artist",
		});
		expect(json(generation)).toMatchObject({
			request_id: requestId,
			status: "succeeded",
			node_id: "artist:fixture-artist",
		});

		const conflict = await http(server.port, "POST", "/mobile/v1/generations", {
			request_id: requestId,
			type: "artist",
			name: "Another Artist",
		});
		expect(conflict).toMatchObject({ status: 409 });
		expect(json(conflict)).toMatchObject({ error: { code: "idempotency_conflict" } });
	});
});

async function startServer(): Promise<RunningServer> {
	const directory = await mkdtemp(join(tmpdir(), "odyssey-mobile-compatibility-"));
	const cacheDir = join(directory, "cache");
	const stateDir = join(directory, "mobile-state");
	const streamDir = join(directory, "stream-cache");
	const cache = new NodeCache(cacheDir);
	await cache.write(artistNode());
	await cache.write(genreNode());
	await cache.write(trackNode());
	await mkdir(join(cacheDir, "youtube"), { recursive: true });
	await writeFile(
		join(cacheDir, "youtube", "fixture-track.json"),
		JSON.stringify({
			videoId,
			url: `https://www.youtube.com/watch?v=${videoId}`,
			title: "Fixture Artist - Fixture Track (Official Audio)",
			resolvedAt: "2026-09-27T00:00:00.000Z",
		}),
	);
	await mkdir(streamDir, { recursive: true });
	await writeFile(join(streamDir, `${videoId}.m4a`), "fixture-audio");

	const port = await availablePort();
	const logs = { stdout: "", stderr: "" };
	const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PORT: String(port),
			ODYSSEY_CACHE_DIR: cacheDir,
			MOBILE_STATE_DIR: stateDir,
			STREAM_CACHE_DIR: streamDir,
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
	const server = { child, port, directory, logs };
	runningServers.push(server);

	// `tsx` may need more than two seconds on a cold CI filesystem before the HTTP listener exists.
	// 2026-10-24 (TRA-677): 5 s was not enough on the shared Linux runners (8 jobs per host since
	// TRA-650) and failed main with "server did not start"; 15 s matches server-image-contract.test.ts.
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`server failed to start: ${logs.stderr || logs.stdout}`);
		try {
			if ((await http(port, "GET", "/health")).status === 200) return server;
		} catch {
			// The production deploy uses the same retry pattern while tsx warms up.
		}
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`server did not start: ${logs.stderr || logs.stdout}`);
}

function signalServer(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

async function availablePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("could not reserve a TCP port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

async function http(
	port: number,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<HttpResponse> {
	const encoded = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolveResponse, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				headers: { ...headers, ...(encoded === undefined ? {} : { "Content-Type": "application/json" }) },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolveResponse({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		if (encoded !== undefined) req.write(encoded);
		req.end();
	});
}

function json<T>(response: HttpResponse): T {
	return JSON.parse(response.body) as T;
}
