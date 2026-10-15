import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { isNotFoundError, ValidationError } from "../src/errors.js";
import type { ArtistNode, Slug } from "../src/types.js";

// TRA-502: a decoded request slug such as `artist:..%2F..%2Fx` used to reach
// `join(root, "nodes", type, `${body}.json`)` unchecked and escaped the cache root.

let dir: string;
let cacheRoot: string;
let cache: NodeCache;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-path-safety-"));
	cacheRoot = join(dir, "cache");
	await mkdir(join(cacheRoot, "nodes", "artist"), { recursive: true });
	cache = new NodeCache(cacheRoot);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function artist(slug: string, name = "Fixture Artist"): ArtistNode {
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

function pathForOf(target: NodeCache): (slug: string) => string {
	return (target as unknown as { pathFor(slug: string): string }).pathFor.bind(target);
}

const UNSAFE_BODIES = ["../../../outside", "..", "a/b", "a\\b", "a\0b", "x/../../outside", "..\\..\\outside"];

describe("NodeCache path safety (TRA-502)", () => {
	it.each(UNSAFE_BODIES)("pathFor throws on the unsafe body %j", (body) => {
		expect(() => pathForOf(cache)(`artist:${body}`)).toThrow();
	});

	it("pathFor keeps resolving legacy non-canonical bodies without a path separator", () => {
		expect(pathForOf(cache)("artist:Legacy_Name.v2 (live)")).toBe(
			join(cacheRoot, "nodes", "artist", "Legacy_Name.v2 (live).json"),
		);
	});

	it.each(UNSAFE_BODIES)("get rejects %j without serving a node outside nodes/<type>/", async (body) => {
		await writeFile(join(dir, "outside.json"), JSON.stringify(artist("artist:outside", "Outside")));
		await expect(cache.get(`artist:${body}` as Slug)).rejects.toBeInstanceOf(ValidationError);
	});

	it("get does not report an unsafe slug as a recoverable not-found", async () => {
		const error = await cache.get("artist:../../../outside" as Slug).catch((e: unknown) => e);
		expect(isNotFoundError(error)).toBe(false);
	});

	it("has answers false for an unsafe slug instead of probing the disk", async () => {
		await writeFile(join(dir, "outside.json"), JSON.stringify(artist("artist:outside")));
		await expect(cache.has("artist:../../outside" as Slug)).resolves.toBe(false);
	});

	it("still reads a legacy non-canonical slug that has no path separator", async () => {
		await writeFile(
			join(cacheRoot, "nodes", "artist", "Legacy_Name.v2.json"),
			JSON.stringify(artist("artist:Legacy_Name.v2", "Legacy")),
		);
		const node = await cache.get("artist:Legacy_Name.v2" as Slug);
		expect(node.name).toBe("Legacy");
	});

	it("does not echo the content of a non-JSON node file in the error", async () => {
		await writeFile(join(cacheRoot, "nodes", "artist", "broken.json"), "SECRET=hunter2-do-not-leak\n");
		const error = await cache.get("artist:broken" as Slug).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ValidationError);
		expect((error as Error).message).not.toContain("SECRET");
		expect((error as Error).message).not.toContain("hunter2");
	});

	it("never writes a reverse edge to a path derived from an internal slug that escapes nodes/<type>/", async () => {
		// A tolerant read can hand back a file whose own `slug` differs from its file name.
		await writeFile(
			join(cacheRoot, "nodes", "artist", "tricky.json"),
			JSON.stringify(artist("artist:../../../escaped", "Tricky")),
		);
		const source: ArtistNode = {
			...artist("artist:source", "Source"),
			collaborators: [{ type: "artist", slug: "artist:tricky" as Slug, name: "Tricky" }],
		};
		await cache.write(source).catch(() => undefined);
		await expect(readFile(join(dir, "escaped.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(cacheRoot, "escaped.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
