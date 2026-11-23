import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { withoutL10n } from "../src/services/node-service.js";
import type { ArtistNode, NodeTranslation, Slug } from "../src/types.js";

// TRA-822: the web client stays in English (plan track1-contenu-fr, D5). GET /node/:slug and
// POST /materialize used to hand the raw node back, `l10n` (translation + provenance) included.
// Real server + real NodeCache on a temp directory, like server-slug-traversal.test.ts.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FRENCH: NodeTranslation = {
	teaser: "Un artiste de test.",
	article: "Un article de test en français, assez long pour passer le seuil de quatre-vingts caractères.",
	source_sha256: "a".repeat(64),
	model: "gemini-test",
	translated_at: "2026-11-20T10:00:00.000Z",
};

function artist(slug: string, name: string, l10n?: ArtistNode["l10n"]): ArtistNode {
	return {
		slug: slug as Slug,
		type: "artist",
		name,
		editorial_article: "A fixture artist article long enough to satisfy the cache schema. ".repeat(2),
		editorial_bio: "A fixture artist bio.",
		citations: [{ url: "https://example.com/fixture-artist" }],
		materialized_at: "2026-11-01T00:00:00.000Z",
		// A stored, verified image: GET /node warms covers, and a node without one is not what is tested here.
		image_url: "https://coverartarchive.org/release/fixture/front-500.jpg",
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
		...(l10n ? { l10n } : {}),
	};
}

let directory: string;
let cacheDir: string;
let child: ChildProcess;
let port: number;
const logs = { stdout: "", stderr: "" };

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

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
	return { status: response.status, body: JSON.parse(await response.text()) };
}

function materialize(type: string, name: string) {
	return request("/materialize", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type, name }),
	});
}

async function onDisk(slug: string): Promise<Record<string, unknown>> {
	const body = slug.slice(slug.indexOf(":") + 1);
	const type = slug.slice(0, slug.indexOf(":"));
	return JSON.parse(await readFile(join(cacheDir, "nodes", type, `${body}.json`), "utf8"));
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "odyssey-l10n-projection-"));
	cacheDir = join(directory, "cache");
	const cache = new NodeCache(cacheDir);
	await cache.write(artist("artist:translated", "Translated", { fr: FRENCH }));
	await cache.write(artist("artist:english-only", "English Only"));

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
			if ((await request("/health")).status === 200) return;
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

describe("GET /node/:slug does not expose l10n (TRA-822)", () => {
	it("serves a translated node without the l10n key, every other field untouched", async () => {
		const { status, body } = await request("/node/artist:translated");
		expect(status).toBe(200);
		const { node } = body as { source: string; node: Record<string, unknown> };
		expect(node).not.toHaveProperty("l10n");
		const { l10n: _l10n, ...expected } = await onDisk("artist:translated");
		expect(node).toEqual(expected);
		expect(JSON.stringify(body)).not.toContain(FRENCH.source_sha256);
	});

	it("serves a node without l10n exactly as the disk holds it", async () => {
		const { status, body } = await request("/node/artist:english-only");
		expect(status).toBe(200);
		const { node } = body as { node: Record<string, unknown> };
		expect(node).toEqual(await onDisk("artist:english-only"));
		expect(Object.keys(node)).toEqual(Object.keys(await onDisk("artist:english-only")));
	});
});

describe("POST /materialize does not expose l10n (TRA-822)", () => {
	it("answers a cached translated node without the l10n key", async () => {
		const { status, body } = await materialize("artist", "Translated");
		expect(status).toBe(200);
		const { source, node } = body as { source: string; node: Record<string, unknown> };
		expect(source).toBe("cache");
		expect(node.slug).toBe("artist:translated");
		expect(node).not.toHaveProperty("l10n");
		expect(JSON.stringify(body)).not.toContain(FRENCH.source_sha256);
	});

	it("answers a cached node without l10n as before", async () => {
		const { status, body } = await materialize("artist", "English Only");
		expect(status).toBe(200);
		const { node } = body as { node: Record<string, unknown> };
		expect(node).toEqual(await onDisk("artist:english-only"));
	});
});

describe("the stored node keeps its l10n (TRA-822)", () => {
	it("still carries l10n.fr, provenance included, after both routes answered", async () => {
		await request("/node/artist:translated");
		await materialize("artist", "Translated");
		const stored = await onDisk("artist:translated");
		expect(stored.l10n).toEqual({ fr: FRENCH });
	});
});

describe("withoutL10n (TRA-822)", () => {
	// A freshly written node never reaches the spawned server in a test (the pipeline needs the network),
	// so the helper that both routes apply is checked on the node a JIT response carries.
	it("drops l10n from a freshly materialized node, without mutating the node that was written", () => {
		const written = artist("artist:fresh", "Fresh", { fr: FRENCH });
		const served = withoutL10n(written);
		expect(served).not.toHaveProperty("l10n");
		const { l10n: _l10n, ...rest } = written;
		expect(served).toEqual(rest);
		expect(written.l10n).toEqual({ fr: FRENCH });
	});

	it("returns a node without l10n as is", () => {
		const plain = artist("artist:plain", "Plain");
		expect(withoutL10n(plain)).toBe(plain);
	});
});
