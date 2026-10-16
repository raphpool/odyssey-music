import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ImageSidecarEntry,
	imageSidecarPath,
	isSidecarEntryFresh,
	readImageSidecar,
	writeImageSidecar,
} from "../../src/images/image-sidecar.js";
import type { Slug } from "../../src/types.js";

const KEY: Slug = "project:go-plastic--squarepusher";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const now = (): number => NOW;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const COVER = "https://coverartarchive.org/release-group/5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111/front-500";

function entry(over: Partial<ImageSidecarEntry> = {}): ImageSidecarEntry {
	return {
		key: KEY,
		state: "found",
		url: COVER,
		source: "caa",
		mbid: "5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111",
		hint: { title: "Go Plastic", artist: "Squarepusher" },
		resolvedAt: ago(0),
		...over,
	};
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "image-sidecar-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function writeRaw(key: Slug, content: string): Promise<string> {
	const file = imageSidecarPath(dir, key);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content, "utf8");
	return file;
}

describe("write then read", () => {
	it("round-trips a found entry field by field", async () => {
		const e = entry();
		await writeImageSidecar(dir, e);
		const back = await readImageSidecar(dir, KEY, now);
		expect(back).toEqual(e);
		expect(back?.url).toBe(e.url);
		expect(back?.source).toBe("caa");
		expect(back?.mbid).toBe(e.mbid);
		expect(back?.hint).toEqual({ title: "Go Plastic", artist: "Squarepusher" });
		expect(back?.resolvedAt).toBe(e.resolvedAt);
	});

	it("round-trips a missing entry with its reason", async () => {
		const e = entry({ state: "missing", reason: "no-match" });
		delete e.url;
		delete e.source;
		await writeImageSidecar(dir, e);
		await expect(readImageSidecar(dir, KEY, now)).resolves.toEqual(e);
	});

	it("returns null for an absent file", async () => {
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
	});

	it("creates cache/images/ when missing and leaves no temp file behind", async () => {
		const cacheDir = join(dir, "not", "yet", "there");
		await writeImageSidecar(cacheDir, entry());
		const files = await readdir(join(cacheDir, "images"));
		expect(files).toEqual(["project-go-plastic--squarepusher.json"]);
	});

	it("refuses to write an entry that would not read back", async () => {
		const bad = entry({ url: "https://evil.example/cover.jpg" });
		await expect(writeImageSidecar(dir, bad)).rejects.toThrow();
		expect(await exists(join(dir, "images"))).toBe(false);
	});
});

describe("imageSidecarPath", () => {
	it("maps a slug to <dir>/images/<type>-<body>.json", () => {
		expect(imageSidecarPath(dir, KEY)).toBe(join(dir, "images", "project-go-plastic--squarepusher.json"));
	});

	it("keeps a hostile key inside the images folder", () => {
		const p = imageSidecarPath(dir, "track:../../etc");
		expect(p).toBe(join(dir, "images", "track-______etc.json"));
		const rel = relative(join(dir, "images"), resolve(p));
		expect(rel.startsWith("..")).toBe(false);
		expect(dirname(p)).toBe(join(dir, "images"));
	});

	it("replaces characters outside [a-z0-9_-] with underscores", () => {
		expect(imageSidecarPath(dir, "track:a b/c\\d.é")).toBe(join(dir, "images", "track-a_b_c_d__.json"));
	});
});

describe("invalid files", () => {
	it("deletes a file that is not JSON and returns null", async () => {
		const file = await writeRaw(KEY, "{not json");
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		expect(await exists(file)).toBe(false);
	});

	it("deletes a file that fails the schema and returns null", async () => {
		const file = await writeRaw(KEY, JSON.stringify({ key: KEY, state: "found" }));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		expect(await exists(file)).toBe(false);
	});

	it("deletes a found entry whose url host is not allowed", async () => {
		const file = await writeRaw(KEY, JSON.stringify(entry({ url: "https://evil.example/cover.jpg" })));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		expect(await exists(file)).toBe(false);
	});

	it("deletes a found entry with a source outside IMAGE_SOURCES", async () => {
		const file = await writeRaw(KEY, JSON.stringify({ ...entry(), source: "scraped" }));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		expect(await exists(file)).toBe(false);
	});

	it("deletes a found entry without url or source", async () => {
		const { url: _url, ...noUrl } = entry();
		const file = await writeRaw(KEY, JSON.stringify(noUrl));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		expect(await exists(file)).toBe(false);
	});

	it("deletes an entry whose resolvedAt is not ISO-8601", async () => {
		const file = await writeRaw(KEY, JSON.stringify(entry({ resolvedAt: "last tuesday" })));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		expect(await exists(file)).toBe(false);
	});

	it("returns null instead of throwing on a malformed key", async () => {
		await expect(readImageSidecar(dir, "track:" as Slug, now)).resolves.toBeNull();
		await expect(readImageSidecar(dir, "nocolon" as Slug, now)).resolves.toBeNull();
	});

	it("neither serves nor deletes a valid file that belongs to another key", async () => {
		// "track:a/b" and "track:a_b" sanitize to the same filename.
		const other: Slug = "track:a/b";
		const file = imageSidecarPath(dir, "track:a_b");
		const { url: _u, source: _s, ...bare } = entry({ key: other, state: "missing" });
		await writeImageSidecar(dir, bare);
		await expect(readImageSidecar(dir, "track:a_b", now)).resolves.toBeNull();
		expect(await exists(file)).toBe(true);
	});
});

describe("time to live", () => {
	const missing = (age: number): ImageSidecarEntry => {
		const e = entry({ state: "missing", reason: "no-match", resolvedAt: ago(age) });
		delete e.url;
		delete e.source;
		return e;
	};

	it("expires a missing entry after 7 days, keeps it at 6", async () => {
		await writeImageSidecar(dir, missing(8 * DAY));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		await writeImageSidecar(dir, missing(6 * DAY));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toMatchObject({ state: "missing" });
	});

	it("applies the same 7 days to conflict", () => {
		const base = { ...missing(0), state: "conflict" as const };
		delete (base as { reason?: string }).reason;
		expect(isSidecarEntryFresh({ ...base, resolvedAt: ago(8 * DAY) }, now)).toBe(false);
		expect(isSidecarEntryFresh({ ...base, resolvedAt: ago(6 * DAY) }, now)).toBe(true);
	});

	it("expires an unavailable entry after 1 hour", async () => {
		const unavailable = (min: number): ImageSidecarEntry => {
			const e = entry({ state: "unavailable", resolvedAt: ago(min * 60_000) });
			delete e.url;
			delete e.source;
			return e;
		};
		await writeImageSidecar(dir, unavailable(61));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
		await writeImageSidecar(dir, unavailable(59));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toMatchObject({ state: "unavailable" });
	});

	it("never expires a found entry", async () => {
		await writeImageSidecar(dir, entry({ resolvedAt: ago(400 * DAY) }));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toMatchObject({ state: "found" });
	});

	it("treats a resolvedAt in the future as expired so a miss cannot be pinned", async () => {
		await writeImageSidecar(dir, missing(-2 * DAY));
		await expect(readImageSidecar(dir, KEY, now)).resolves.toBeNull();
	});

	it("keeps an expired file on disk for the next write to overwrite", async () => {
		await writeImageSidecar(dir, missing(8 * DAY));
		await readImageSidecar(dir, KEY, now);
		expect(await exists(imageSidecarPath(dir, KEY))).toBe(true);
	});
});

describe("git", () => {
	it("ignores cache/images/", () => {
		const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
		const out = execFileSync("git", ["check-ignore", "cache/images/x.json"], { cwd: root, encoding: "utf8" });
		expect(out.trim()).toBe("cache/images/x.json");
	});
});
