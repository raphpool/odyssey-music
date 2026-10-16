import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BackfillOptions,
	IMAGE_TYPE_ORDER,
	type ImagesManifest,
	MAX_CONSECUTIVE_UNAVAILABLE,
	MIGRATION_NAME,
	parseCliArgs,
	runBackfill,
	trackAvailability,
} from "../scripts/migrations/2026-10-18-backfill-images.js";
import { musicBrainzConfig } from "../src/config.js";
import { wikidataConfig } from "../src/images/wikidata.js";
import { parseSlug } from "../src/slug.js";
import type { NodePayload } from "../src/types.js";
import {
	artistNode,
	edge,
	genreNode,
	jsonResponse,
	labelNode,
	projectNode,
	type Responder,
	redirectResponse,
	routedFetch,
	trackNode,
} from "./images/helpers.js";

// TRA-489 (a): the backfill script, offline. Only the network boundary is replaced (the injected `fetch`);
// the resolver, the cache layout, the schema and the allowlist are the real ones.

// Each MBID is used by one test only: mbFetch memoizes by path for 5 minutes.
const mb = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const caaUrl = (n: number): string => `https://coverartarchive.org/release-group/${mb(n)}/front-500`;
const ARCHIVE = "https://ia800000.us.archive.org/1/items/x/x.jpg";
const WIKIMEDIA_PHOTO = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg";

const caaFound = (n: number): [string, Responder] => [
	`release-group/${mb(n)}/front-500`,
	() => redirectResponse(ARCHIVE),
];
const caaDown: [string, Responder] = ["coverartarchive.org", () => new Response("", { status: 503 })];
const mbDown: [string, Responder] = ["musicbrainz.org", () => new Response("", { status: 503 })];
const mbNoRelations: [string, Responder] = ["musicbrainz.org/ws/2/", () => jsonResponse({ relations: [] })];

let dir: string;
let scratch: string;
const suite = { wikidata: wikidataConfig.minIntervalMs, mb: musicBrainzConfig.minIntervalMs };

beforeEach(async () => {
	wikidataConfig.minIntervalMs = 0;
	musicBrainzConfig.minIntervalMs = 0;
	scratch = await mkdtemp(join(tmpdir(), "odyssey-backfill-images-"));
	dir = join(scratch, "cache");
});

afterEach(async () => {
	wikidataConfig.minIntervalMs = suite.wikidata;
	musicBrainzConfig.minIntervalMs = suite.mb;
	vi.unstubAllEnvs();
	await rm(scratch, { recursive: true, force: true });
});

// --- Fixtures: raw JSON on disk, as the cache holds them (NodeCache.write would emit reverse edges) ---

const nodePath = (root: string, slug: string): string => {
	const { type, body } = parseSlug(slug);
	return join(root, "nodes", type, `${body}.json`);
};

async function seed(root: string, ...nodes: Array<NodePayload | Record<string, unknown>>): Promise<void> {
	for (const n of nodes) {
		const path = nodePath(root, n.slug as string);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(n, null, 2));
	}
}

type Obj = Record<string, unknown>;
const read = async (root: string, slug: string): Promise<Obj> =>
	JSON.parse(await readFile(nodePath(root, slug), "utf8")) as Obj;
const readText = (root: string, slug: string): Promise<string> => readFile(nodePath(root, slug), "utf8");
const manifestFile = (): string => join(scratch, "out", "images.json");
const readManifest = async (path = manifestFile()): Promise<ImagesManifest> =>
	JSON.parse(await readFile(path, "utf8")) as ImagesManifest;

function run(overrides: Partial<BackfillOptions> & Pick<BackfillOptions, "fetch">) {
	return runBackfill({ cacheDir: dir, apply: true, manifestPath: manifestFile(), ...overrides });
}

describe("order and derived covers (AC 1)", () => {
	it("gives the project a caa image and the genre the same URL as derived-cover, then a re-run writes nothing", async () => {
		const project = projectNode("ok", "OK Computer", { mbid: mb(1) });
		const g = genreNode("indie", "Indie", { landmark_projects: [edge("project", "ok", "OK Computer")] });
		await seed(dir, project, g);
		const f = routedFetch([caaFound(1)]);

		const first = await run({ fetch: f });
		expect(first.exitCode).toBe(0);
		expect(await read(dir, "project:ok")).toMatchObject({ image_url: caaUrl(1), image_source: "caa" });
		expect(await read(dir, "genre:indie")).toMatchObject({
			image_url: caaUrl(1),
			image_source: "derived-cover",
		});

		const projectBefore = await readText(dir, "project:ok");
		const genreBefore = await readText(dir, "genre:indie");
		const secondFetch = routedFetch([caaFound(1)]);
		const second = await run({ fetch: secondFetch });
		expect(second.exitCode).toBe(0);
		expect(second.written).toEqual([]);
		expect(secondFetch.calls).toEqual([]);
		expect(await readText(dir, "project:ok")).toBe(projectBefore);
		expect(await readText(dir, "genre:indie")).toBe(genreBefore);
	});

	it("resolves project, track, artist, label, genre in that order whatever the slugs sort like", async () => {
		// Alphabetically artist: < genre: < label: < project: < track:, the reverse of the dependencies.
		await seed(
			dir,
			projectNode("rg", "A Record", { mbid: mb(2) }),
			trackNode("song", "A Song", { project: edge("project", "rg", "A Record") }),
			artistNode("someone", "Someone", { discography: [edge("project", "rg", "A Record")] }),
			labelNode("imprint", "Imprint", { notable_releases: [edge("project", "rg", "A Record")] }),
			genreNode("style", "Style", { landmark_tracks: [edge("track", "song", "A Song")] }),
		);
		const result = await run({ fetch: routedFetch([caaFound(2)]) });

		expect(result.exitCode).toBe(0);
		expect(await read(dir, "project:rg")).toMatchObject({ image_url: caaUrl(2), image_source: "caa" });
		// A track shows its project's picture, with the project's provenance.
		expect(await read(dir, "track:song")).toMatchObject({ image_url: caaUrl(2), image_source: "caa" });
		for (const slug of ["artist:someone", "label:imprint", "genre:style"]) {
			expect(await read(dir, slug), slug).toMatchObject({
				image_url: caaUrl(2),
				image_source: "derived-cover",
			});
		}
		expect(result.manifest.bySource).toMatchObject({ caa: 2, "derived-cover": 3 });
		expect(IMAGE_TYPE_ORDER).toEqual(["project", "track", "artist", "label", "genre"]);
	});

	it("a dry-run writes no node but plans the derived images exactly like an apply", async () => {
		await seed(
			dir,
			projectNode("ok", "OK Computer", { mbid: mb(3) }),
			genreNode("indie", "Indie", { landmark_projects: [edge("project", "ok", "OK Computer")] }),
		);
		const before = [await readText(dir, "project:ok"), await readText(dir, "genre:indie")];

		const result = await run({ apply: false, fetch: routedFetch([caaFound(3)]) });

		expect(result.written).toEqual([]);
		expect([await readText(dir, "project:ok"), await readText(dir, "genre:indie")]).toEqual(before);
		expect(result.manifest.coverage.genre).toEqual({ before: 0, after: 1, total: 1 });
		expect((await readManifest()).coverage.genre.after).toBe(1);
	});

	it("only touches the --types it is given", async () => {
		await seed(dir, projectNode("ok", "OK Computer", { mbid: mb(4) }), artistNode("nobody", "Nobody"));
		const f = routedFetch([caaFound(4)]);
		const result = await run({ types: ["artist"], fetch: f });
		expect(f.calls).toEqual([]);
		expect(await read(dir, "project:ok")).not.toHaveProperty("image_url");
		expect(result.manifest.coverage.project).toEqual({ before: 0, after: 0, total: 1 });
		expect(result.manifest.none).toEqual([{ slug: "artist:nobody", reason: "no-mbid" }]);
	});
});

describe("legacy photo_url / cover_url (AC 2)", () => {
	it("copies an allowed photo_url of an artist without Wikidata, and keeps photo_url", async () => {
		await seed(dir, artistNode("flash", "Flash", { photo_url: WIKIMEDIA_PHOTO }));
		const result = await run({ fetch: routedFetch([]) });

		expect(result.exitCode).toBe(0);
		expect(await read(dir, "artist:flash")).toMatchObject({
			image_url: WIKIMEDIA_PHOTO,
			image_source: "legacy",
			photo_url: WIKIMEDIA_PHOTO,
		});
		expect(result.manifest.bySource.legacy).toBe(1);
		expect(result.manifest.none).toEqual([]);
	});

	it("uses cover_url for a project the resolver finds nothing for", async () => {
		await seed(dir, projectNode("old", "Old", { cover_url: WIKIMEDIA_PHOTO }));
		await run({ fetch: routedFetch([]) });
		expect(await read(dir, "project:old")).toMatchObject({
			image_url: WIKIMEDIA_PHOTO,
			image_source: "legacy",
		});
	});

	it("never copies a legacy URL off the allowed hosts (or in a non-canonical form): the node goes to none", async () => {
		await seed(
			dir,
			artistNode("elsewhere", "Elsewhere", { photo_url: "https://example.com/photo.jpg" }),
			artistNode("plain", "Plain", { photo_url: "http://upload.wikimedia.org/photo.jpg" }),
		);
		const result = await run({ fetch: routedFetch([]) });

		expect(result.exitCode).toBe(0);
		for (const slug of ["artist:elsewhere", "artist:plain"])
			expect(await read(dir, slug)).not.toHaveProperty("image_url");
		expect(result.manifest.none.map((n) => n.slug)).toEqual(["artist:elsewhere", "artist:plain"]);
		expect(await read(dir, "artist:elsewhere")).toMatchObject({ photo_url: "https://example.com/photo.jpg" });
	});

	it("the resolver wins over a legacy field, and a node that already has an image is never touched", async () => {
		await seed(
			dir,
			projectNode("both", "Both", { mbid: mb(5), cover_url: WIKIMEDIA_PHOTO }),
			projectNode("has", "Has", {
				mbid: mb(6),
				image_url: "https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg?width=600",
				image_source: "wikidata-p154",
			}),
		);
		const hasBefore = await readText(dir, "project:has");
		const f = routedFetch([caaFound(5), caaFound(6)]);
		await run({ fetch: f });

		expect(await read(dir, "project:both")).toMatchObject({ image_url: caaUrl(5), image_source: "caa" });
		expect(await readText(dir, "project:has")).toBe(hasBefore);
		expect(f.calls.some((c) => c.includes(mb(6)))).toBe(false);
	});
});

describe("none reasons", () => {
	it("lists every node left without image with the first blocker of its ladder", async () => {
		await seed(
			dir,
			projectNode("nombid", "No MBID"),
			projectNode("nocover", "No cover", { mbid: mb(7) }),
			trackNode("loose", "Loose"),
			trackNode("nomb", "No mb", { project: edge("project", "nombid", "No MBID") }),
			trackNode("nocoverng", "No cover ng", { project: edge("project", "nocover", "No cover") }),
			artistNode("anon", "Anon"),
			artistNode("wiki", "Wiki", { mbid: mb(8) }),
			labelNode("imprint", "Imprint"),
			genreNode("empty", "Empty"),
		);
		const result = await run({ fetch: routedFetch([mbNoRelations]) });

		expect(result.exitCode).toBe(0);
		expect(result.manifest.none).toEqual([
			{ slug: "artist:anon", reason: "no-mbid" },
			{ slug: "artist:wiki", reason: "no-wikidata" },
			{ slug: "genre:empty", reason: "no-related-image" },
			{ slug: "label:imprint", reason: "no-wikidata" },
			{ slug: "project:nocover", reason: "caa-404" },
			{ slug: "project:nombid", reason: "no-mbid" },
			{ slug: "track:loose", reason: "no-related-image" },
			{ slug: "track:nocoverng", reason: "caa-404" },
			{ slug: "track:nomb", reason: "no-mbid" },
		]);
		expect(result.manifest.coverage.project).toEqual({ before: 0, after: 0, total: 2 });
	});
});

describe("fail-closed on an unavailable source", () => {
	it("a Cover Art Archive outage leaves the project untouched and out of none, and exits 1", async () => {
		await seed(dir, projectNode("ok", "OK Computer", { mbid: mb(10) }));
		const before = await readText(dir, "project:ok");
		const result = await run({ fetch: routedFetch([caaDown]) });

		expect(result.exitCode).toBe(1);
		expect(await readText(dir, "project:ok")).toBe(before);
		expect(result.manifest.none).toEqual([]);
		expect(result.manifest.failed).toEqual([
			{ slug: "project:ok", reason: "source unavailable: coverartarchive.org: HTTP 503" },
		]);
	});

	it("does not fall back to a lower rung while a higher one did not answer", async () => {
		const art = "https://is1-ssl.mzstatic.com/image/thumb/Music/x/source/100x100bb.jpg";
		await seed(
			dir,
			projectNode("ok", "OK Computer", { mbid: mb(11), artists: [edge("artist", "radiohead", "Radiohead")] }),
		);
		const itunes: [string, Responder] = [
			"itunes.apple.com",
			() =>
				jsonResponse({
					results: [{ artworkUrl100: art, collectionName: "OK Computer", artistName: "Radiohead" }],
				}),
		];
		const result = await run({ fetch: routedFetch([caaDown, itunes]) });

		expect(result.exitCode).toBe(1);
		expect(await read(dir, "project:ok")).not.toHaveProperty("image_url");
	});

	it("a network error or a timeout is an outage too", async () => {
		await seed(dir, projectNode("ok", "OK Computer", { mbid: mb(12) }));
		const throwing = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const result = await run({ fetch: throwing });
		expect(result.exitCode).toBe(1);
		expect(result.manifest.failed[0]?.reason).toBe(
			"source unavailable: coverartarchive.org: no answer (TypeError)",
		);
	});

	it("a MusicBrainz outage fails the artist instead of listing it as without Wikidata", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "1");
		await seed(dir, artistNode("wiki", "Wiki", { mbid: mb(13) }));
		const result = await run({ fetch: routedFetch([mbDown]) });
		expect(result.exitCode).toBe(1);
		expect(result.manifest.none).toEqual([]);
		expect(result.manifest.failed.map((x) => x.slug)).toEqual(["artist:wiki"]);
	});

	it("a 404 from the Cover Art Archive is a verdict, not an outage", async () => {
		await seed(dir, projectNode("bare", "Bare", { mbid: mb(14) }));
		const result = await run({ fetch: routedFetch([]) });
		expect(result.exitCode).toBe(0);
		expect(result.manifest.none).toEqual([{ slug: "project:bare", reason: "caa-404" }]);
		expect(result.manifest.failed).toEqual([]);
	});

	it("a failed node does not stop the others, and a re-run with the source back completes it", async () => {
		await seed(dir, projectNode("a", "A", { mbid: mb(15) }), projectNode("b", "B", { mbid: mb(16) }));
		const flaky = routedFetch([
			[`release-group/${mb(15)}`, () => new Response("", { status: 503 })],
			caaFound(16),
		]);
		const first = await run({ fetch: flaky });
		expect(first.exitCode).toBe(1);
		expect(await read(dir, "project:b")).toMatchObject({ image_source: "caa" });
		expect(await read(dir, "project:a")).not.toHaveProperty("image_url");

		const second = await run({ resume: true, fetch: routedFetch([caaFound(15), caaFound(16)]) });
		expect(second.exitCode).toBe(0);
		expect(second.manifest.failed).toEqual([]);
		expect(await read(dir, "project:a")).toMatchObject({ image_source: "caa" });
	});

	it(`stops after ${MAX_CONSECUTIVE_UNAVAILABLE} unavailable nodes in a row`, async () => {
		await seed(
			dir,
			...Array.from({ length: 8 }, (_, i) => projectNode(`p${i}`, `P${i}`, { mbid: mb(20 + i) })),
		);
		const f = routedFetch([caaDown]);
		const result = await run({ fetch: f });
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(f.calls).toHaveLength(MAX_CONSECUTIVE_UNAVAILABLE);
		expect(result.manifest.failed).toHaveLength(MAX_CONSECUTIVE_UNAVAILABLE);
		expect(result.manifest.none).toEqual([]);
	});

	it("a node that made no request does not reset the row: alternating offline nodes do not hide an outage", async () => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "1");
		// a0 b0 a1 b1 ...: the odd ones have an MBID (MusicBrainz is down), the others none (no request at all).
		const artists = Array.from({ length: 2 * MAX_CONSECUTIVE_UNAVAILABLE + 2 }, (_, i) =>
			i % 2 === 0
				? artistNode(`a${String(i).padStart(2, "0")}`, `A${i}`, { mbid: mb(50 + i) })
				: artistNode(`a${String(i).padStart(2, "0")}`, `A${i}`),
		);
		await seed(dir, ...artists);
		const result = await run({ fetch: routedFetch([mbDown]) });
		expect(result.aborted).toBe(true);
		expect(result.manifest.failed).toHaveLength(MAX_CONSECUTIVE_UNAVAILABLE);
	});

	it.each([403, 408, 429])("a %i is an outage, not a verdict (iTunes rate limit)", async (status) => {
		await seed(
			dir,
			projectNode("ok", "OK Computer", { artists: [edge("artist", "radiohead", "Radiohead")] }),
		);
		const result = await run({
			fetch: routedFetch([["itunes.apple.com", () => new Response("", { status })]]),
		});
		expect(result.exitCode).toBe(1);
		expect(result.manifest.none).toEqual([]);
		expect(result.manifest.failed[0]?.reason).toBe(`source unavailable: itunes.apple.com: HTTP ${status}`);
	});

	it("a node that reads a node that failed waits for the re-run, and ends with the same picture as its input", async () => {
		await seed(
			dir,
			projectNode("p", "P", { mbid: mb(70) }),
			trackNode("t", "T", { project: edge("project", "p", "P") }),
			genreNode("g", "G", {
				landmark_projects: [edge("project", "p", "P")],
				landmark_tracks: [edge("track", "t", "T")],
			}),
			// This genre's first landmark failed, its second is fine: resolved now it would show the second.
			projectNode("q", "Q", { mbid: mb(71) }),
			genreNode("h", "H", {
				landmark_projects: [edge("project", "p", "P"), edge("project", "q", "Q")],
			}),
		);
		const first = await run({
			fetch: routedFetch([["coverartarchive.org", () => new Response("", { status: 503 })]]),
		});
		expect(first.exitCode).toBe(1);
		expect(first.manifest.failed.map((x) => x.slug)).toEqual([
			"genre:g",
			"genre:h",
			"project:p",
			"project:q",
			"track:t",
		]);
		expect(first.manifest.failed.find((x) => x.slug === "track:t")?.reason).toBe(
			"waits for a node that failed: project:p",
		);
		expect(await read(dir, "genre:h")).not.toHaveProperty("image_url");

		const second = await run({ resume: true, fetch: routedFetch([caaFound(70), caaFound(71)]) });
		expect(second.exitCode).toBe(0);
		for (const slug of ["track:t", "genre:g", "genre:h"]) {
			expect(await read(dir, slug), slug).toMatchObject({ image_url: caaUrl(70) });
		}
	});

	it("trackAvailability keeps the LAST outcome per host: a request retried into a 200 is not an outage", async () => {
		const answers = [503, 503, 200];
		const base = (async () =>
			new Response("", { status: answers.shift() ?? 200 })) as unknown as typeof fetch;
		const tracker = trackAvailability(() => base);
		await tracker.fetch("https://musicbrainz.org/ws/2/artist/x");
		expect(tracker.unavailable()).toEqual(["musicbrainz.org: HTTP 503"]);
		await tracker.fetch("https://musicbrainz.org/ws/2/artist/x");
		await tracker.fetch("https://musicbrainz.org/ws/2/artist/x");
		expect(tracker.unavailable()).toEqual([]);
		expect(tracker.requests()).toBe(3);
		tracker.reset();
		expect(tracker.unavailable()).toEqual([]);
		expect(tracker.requests()).toBe(0);
	});
});

describe("manifest and resume", () => {
	it("carries the migration channel's fields and no timestamp, and is identical for a dry-run and an apply", async () => {
		const nodes = [
			projectNode("ok", "OK Computer", { mbid: mb(30) }),
			projectNode("bare", "Bare"),
			genreNode("indie", "Indie", { landmark_projects: [edge("project", "ok", "OK Computer")] }),
			artistNode("flash", "Flash", { photo_url: WIKIMEDIA_PHOTO }),
		];
		const other = join(scratch, "cache-2");
		await seed(dir, ...nodes);
		await seed(other, ...nodes);

		await run({ apply: false, fetch: routedFetch([caaFound(30)]) });
		const preview = await readFile(manifestFile(), "utf8");
		const secondPath = join(scratch, "out", "second.json");
		await runBackfill({
			cacheDir: other,
			apply: true,
			manifestPath: secondPath,
			fetch: routedFetch([caaFound(30)]),
		});
		const applied = await readFile(secondPath, "utf8");

		expect(applied).toBe(preview);
		const manifest = JSON.parse(preview) as ImagesManifest & Obj;
		expect(manifest).toMatchObject({ migration: MIGRATION_NAME, removed: [], renamed: {}, redirects: {} });
		expect(manifest).not.toHaveProperty("generated_at");
		expect(Object.keys(manifest.coverage)).toEqual([...IMAGE_TYPE_ORDER]);
		expect(manifest.coverage.project).toEqual({ before: 0, after: 1, total: 2 });
		expect(manifest.bySource).toEqual({
			"wikidata-p18": 0,
			"wikidata-p154": 0,
			caa: 1,
			"itunes-verified": 0,
			"derived-cover": 1,
			legacy: 1,
		});
		expect(manifest.none).toEqual([{ slug: "project:bare", reason: "no-mbid" }]);
		expect(MIGRATION_NAME).toBe("2026-10-18-backfill-images");
	});

	it("--resume keeps the coverage before the first run; bySource is the state of the cache either way", async () => {
		await seed(
			dir,
			projectNode("ok", "OK Computer", { mbid: mb(31) }),
			artistNode("flash", "Flash", { photo_url: WIKIMEDIA_PHOTO }),
		);
		await run({ types: ["project"], fetch: routedFetch([caaFound(31)]) });

		const resumed = await run({ resume: true, fetch: routedFetch([]) });
		expect(resumed.manifest.coverage.project).toEqual({ before: 0, after: 1, total: 1 });
		expect(resumed.manifest.coverage.artist).toEqual({ before: 0, after: 1, total: 1 });
		expect(resumed.manifest.bySource).toMatchObject({ caa: 1, legacy: 1 });

		const fresh = await run({ fetch: routedFetch([]) });
		expect(fresh.manifest.coverage.project).toEqual({ before: 1, after: 1, total: 1 });
		expect(fresh.manifest.bySource).toMatchObject({ caa: 1, legacy: 1 });
	});

	it("a dry-run resumed from a dry-run does not count the same images twice", async () => {
		await seed(dir, projectNode("ok", "OK Computer", { mbid: mb(33) }));
		await run({ apply: false, fetch: routedFetch([caaFound(33)]) });
		const again = await run({ apply: false, resume: true, fetch: routedFetch([caaFound(33)]) });
		expect(again.manifest.coverage.project).toEqual({ before: 0, after: 1, total: 1 });
		expect(again.manifest.bySource.caa).toBe(1);
	});

	it("--resume without a previous manifest, or with one that is not ours, starts from the cache", async () => {
		await seed(dir, projectNode("ok", "OK Computer", { mbid: mb(32) }));
		await mkdir(dirname(manifestFile()), { recursive: true });
		await writeFile(
			manifestFile(),
			JSON.stringify({ migration: "something-else", coverage: { project: { before: 9 } } }),
		);
		const result = await run({ resume: true, fetch: routedFetch([caaFound(32)]) });
		expect(result.manifest.coverage.project).toEqual({ before: 0, after: 1, total: 1 });
	});
});

describe("what is written", () => {
	it("only adds image_url and image_source: every other field, photo_url included, is untouched", async () => {
		const original = projectNode("keep", "Keep", { mbid: mb(40), cover_url: WIKIMEDIA_PHOTO });
		await seed(dir, original);
		await run({ fetch: routedFetch([caaFound(40)]) });
		const next = await read(dir, "project:keep");
		const { image_url, image_source, ...rest } = next;
		expect(image_url).toBe(caaUrl(40));
		expect(image_source).toBe("caa");
		expect(rest).toEqual(JSON.parse(JSON.stringify(original)));
	});

	it("refuses to write a node the schema would alter (an undeclared field would be stripped)", async () => {
		await seed(dir, { ...projectNode("odd", "Odd", { mbid: mb(41) }), undeclared_field: "x" });
		const before = await readText(dir, "project:odd");
		const result = await run({ fetch: routedFetch([caaFound(41)]) });
		expect(result.exitCode).toBe(1);
		expect(await readText(dir, "project:odd")).toBe(before);
		expect(result.manifest.failed[0]?.reason).toContain("would alter fields");
	});

	it("lists a node that is not valid instead of guessing, and a cache without nodes/ is not touched", async () => {
		await seed(dir, { slug: "project:broken", type: "project", name: "Broken" });
		const result = await run({ fetch: routedFetch([]) });
		expect(result.exitCode).toBe(1);
		expect(result.manifest.failed.map((x) => x.slug)).toEqual(["project:broken"]);
		await expect(stat(join(dir, "nodes", "genre"))).rejects.toThrow();
	});
});

describe("parseCliArgs (the flags the migration channel passes)", () => {
	it("accepts --apply, --manifest and --data-dir; --data-dir is ignored", () => {
		expect(parseCliArgs(["/c", "--apply", "--manifest", "m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/c",
			apply: true,
			resume: false,
			types: [...IMAGE_TYPE_ORDER],
			manifestPath: "m.json",
		});
	});

	it("defaults to a dry-run on every type with out/images.json", () => {
		expect(parseCliArgs(["/c"])).toEqual({
			cacheDir: "/c",
			apply: false,
			resume: false,
			types: [...IMAGE_TYPE_ORDER],
			manifestPath: "out/images.json",
		});
	});

	it("keeps --types in the fixed order whatever the order given, and --resume", () => {
		expect(parseCliArgs(["/c", "--types", "genre,project,artist", "--resume"])).toMatchObject({
			types: ["project", "artist", "genre"],
			resume: true,
		});
	});

	it.each([
		[[]],
		[["--apply"]],
		[["/c", "--types", "album"]],
		[["/c", "--types", "project,project"]],
		[["/c", "--types"]],
		[["/c", "--manifest", "--apply"]],
		[["/c", "--apply", "--apply"]],
		[["/c", "--data-dir", "/a", "--data-dir", "/b"]],
		[["/c", "--unknown"]],
		[["/c", "extra"]],
	])("refuses %j", (argv) => {
		expect(parseCliArgs(argv as string[])).toBeNull();
	});
});
