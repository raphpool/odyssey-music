import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeCache } from "../../src/cache.js";
import { createImageQueue } from "../../src/images/image-queue.js";
import { readImageSidecar } from "../../src/images/image-sidecar.js";
import { resolveImage } from "../../src/images/resolve-image.js";
import { resolveWorkImageByHint, type WorkImageHint } from "../../src/images/resolve-work-hint.js";
import type { NodePayload, ProjectNode, Slug } from "../../src/types.js";
import { edge, jsonResponse, projectNode, redirectResponse, routedFetch } from "./helpers.js";

// TRA-612: Kode9's two covers. The real MusicBrainz resolvers run over a faked network. mbFetch memoizes by
// request for 5 minutes: every test uses titles of its own.
const KODE9 = "e95a9d7f-fc26-4e56-8032-90cd954deea0";
const VARIOUS = "89ad4ac3-39f7-470e-963a-56509c546377";
const SINE_RG = "1567159c-ea26-3934-a725-77fd4f6eccfb";
const HYPERDUB_RG = "1de78c85-bbe7-441f-b3a1-9db3c5358e01";
const ARCHIVE = "https://ia800000.us.archive.org/1/items/x/x.jpg";
const COVER = (mbid: string): string => `https://coverartarchive.org/release-group/${mbid}/front-500`;

const kode9 = { name: "Kode9", artist: { id: KODE9, name: "Kode9" } };
const various = { name: "Various Artists", artist: { id: VARIOUS, name: "Various Artists" } };

const sineGroup = (title = "Sine of the Dub / Stalker") => ({
	id: SINE_RG,
	score: 100,
	title,
	"primary-type": "Single",
	"first-release-date": "2004-01-01",
	"artist-credit": [kode9],
});
const compilationRecording = (title: string, creditedTo: unknown[] = [kode9]) => ({
	id: "33333333-0000-4000-8000-000000000001",
	score: 100,
	title: "Pink Sham Pain Down the Drain",
	"artist-credit": creditedTo,
	releases: [
		{
			id: "33333333-0000-4000-8000-000000000002",
			title,
			"artist-credit": [various],
			"release-group": {
				id: HYPERDUB_RG,
				title,
				"primary-type": "Album",
				"secondary-types": ["Compilation"],
			},
		},
	],
});

const rgSearch = (hits: unknown[]): [string, () => Response] => [
	"musicbrainz.org/ws/2/release-group",
	() => jsonResponse({ count: hits.length, "release-groups": hits }),
];
const recSearch = (hits: unknown[]): [string, () => Response] => [
	"musicbrainz.org/ws/2/recording",
	() => jsonResponse({ count: hits.length, recordings: hits }),
];
const caaFor = (mbid: string): [string, () => Response] => [
	`release-group/${mbid}/front-500`,
	() => redirectResponse(ARCHIVE),
];
const caaMissing: [string, () => Response] = ["coverartarchive.org", () => new Response("", { status: 404 })];
const mbCalls = (f: { calls: string[] }): string[] => f.calls.filter((c) => c.includes("musicbrainz.org"));
const itunesCalls = (f: { calls: string[] }): string[] => f.calls.filter((c) => c.includes("itunes"));

function network(...routes: Array<[string, () => Response]>) {
	const f = routedFetch(routes);
	vi.stubGlobal("fetch", f);
	return f;
}

const hint = (title: string, extra: Partial<WorkImageHint> = {}): WorkImageHint => ({
	slug: `project:${title.toLowerCase().replace(/\W+/g, "-")}` as Slug,
	type: "project",
	title,
	artist: "Kode9",
	...extra,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a work without node: Sine of the Dub", () => {
	it("is served the Cover Art Archive cover of 'Sine of the Dub / Stalker'", async () => {
		const f = network(rgSearch([sineGroup()]), caaFor(SINE_RG));
		const out = await resolveWorkImageByHint(hint("Sine of the Dub"), { fetch: f });
		expect(out).toEqual({ kind: "found", url: COVER(SINE_RG), source: "caa", mbid: SINE_RG });
		expect(mbCalls(f)).toHaveLength(1);
	});
});

describe("a work without node: Hyperdub 10.3", () => {
	const compilations = { compilations: true, mbOptions: { priority: "background" as const } };

	it("is served the cover of the compilation Kode9's tracks are on, with one more request and no mbid", async () => {
		const f = network(rgSearch([]), recSearch([compilationRecording("Hyperdub 10.3")]), caaFor(HYPERDUB_RG));
		const out = await resolveWorkImageByHint(hint("Hyperdub 10.3"), { fetch: f, ...compilations });
		expect(out).toEqual({ kind: "found", url: COVER(HYPERDUB_RG), source: "caa" });
		expect(mbCalls(f).map((c) => new URL(c).pathname)).toEqual(["/ws/2/release-group", "/ws/2/recording"]);
		expect(itunesCalls(f)).toEqual([]);
	});

	it("is refused from an artist the track credits do not hold", async () => {
		const f = network(
			rgSearch([]),
			recSearch([
				compilationRecording("Compilation Nu", [
					{ name: "Other", artist: { id: "99999999-0000-4000-8000-000000000002", name: "Other" } },
				]),
			]),
			caaFor(HYPERDUB_RG),
			["itunes.apple.com", () => jsonResponse({ results: [] })],
		);
		const out = await resolveWorkImageByHint(hint("Compilation Nu", { artist: "Someone Else" }), {
			fetch: f,
			...compilations,
		});
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
		expect(f.calls.filter((c) => c.includes("coverartarchive"))).toEqual([]);
	});

	it("costs nothing more unless the caller asks for the rung", async () => {
		const f = network(rgSearch([]), recSearch([compilationRecording("Compilation Xi")]), caaFor(HYPERDUB_RG));
		const out = await resolveWorkImageByHint(hint("Compilation Xi"), { fetch: f });
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
		expect(mbCalls(f)).toHaveLength(1);
	});

	it("does not run for Various Artists itself, nor for a work known to be an EP or a single", async () => {
		const f = network(
			rgSearch([]),
			recSearch([compilationRecording("Compilation Omicron")]),
			caaFor(HYPERDUB_RG),
		);
		const va = await resolveWorkImageByHint(hint("Compilation Omicron", { artist: "Various Artists" }), {
			fetch: f,
			...compilations,
		});
		const ep = await resolveWorkImageByHint(hint("Compilation Pi", { releaseType: "ep" }), {
			fetch: f,
			...compilations,
		});
		expect(va).toEqual({ kind: "missing", reason: "no-match" });
		expect(ep).toEqual({ kind: "missing", reason: "no-match" });
		// iTunes is never asked about Various Artists, and the only MusicBrainz requests are the two searches.
		expect(itunesCalls(f).some((c) => c.includes("Various"))).toBe(false);
		expect(mbCalls(f).filter((c) => c.includes("/recording"))).toEqual([]);
	});

	it("does not run when the first rung doubts or cannot answer", async () => {
		const a = network(rgSearch([sineGroup("Compilation Rho"), sineGroup("Compilation Rho")]));
		await resolveWorkImageByHint(hint("Compilation Rho"), { fetch: a, ...compilations });
		expect(mbCalls(a).filter((c) => c.includes("/recording"))).toEqual([]);
		const b = network(["musicbrainz.org", () => new Response("no", { status: 400 })]);
		const out = await resolveWorkImageByHint(hint("Compilation Sigma"), { fetch: b, ...compilations });
		expect(out).toEqual({ kind: "unavailable" });
	});
});

describe("a node without MBID", () => {
	const sine = (extra: Partial<ProjectNode> = {}) =>
		projectNode("sine-of-the-dub--kode9", "Sine of the Dub", {
			year: "2006",
			artists: [edge("artist", "kode9", "Kode9", { mbid: KODE9 })],
			...extra,
		});
	const cache = {} as NodeCache;

	it("gets the Cover Art Archive cover MusicBrainz names for it, and the node is left as it was", async () => {
		const f = network(rgSearch([sineGroup()]), caaFor(SINE_RG));
		const node = sine();
		const before = structuredClone(node);
		const out = await resolveImage(node, { cache, fetch: f, viaMusicBrainz: true });
		expect(out).toEqual({ url: COVER(SINE_RG), source: "caa" });
		expect(node).toEqual(before);
		expect(node.mbid).toBeUndefined();
	});

	it("asks MusicBrainz nothing unless the caller turns the rung on", async () => {
		const f = network(rgSearch([sineGroup()]), caaFor(SINE_RG), [
			"itunes.apple.com",
			() => jsonResponse({ results: [] }),
		]);
		expect(await resolveImage(sine({ name: "Sine of the Dub Zero" }), { cache, fetch: f })).toBeNull();
		expect(mbCalls(f)).toEqual([]);
	});

	it("refuses a release group credited to a namesake, whatever name it prints", async () => {
		const namesake = { name: "Kode9", artist: { id: "99999999-0000-4000-8000-000000000003", name: "Kode9" } };
		const f = network(
			rgSearch([{ ...sineGroup("Sine of the Dub Tau / Stalker"), "artist-credit": [namesake] }]),
			caaFor(SINE_RG),
			["itunes.apple.com", () => jsonResponse({ results: [] })],
		);
		const out = await resolveImage(sine({ name: "Sine of the Dub Tau" }), {
			cache,
			fetch: f,
			viaMusicBrainz: true,
		});
		expect(out).toBeNull();
		expect(f.calls.filter((c) => c.includes("coverartarchive"))).toEqual([]);
	});

	it("does not touch a node that already has an MBID", async () => {
		const f = network(caaMissing, ["itunes.apple.com", () => jsonResponse({ results: [] })]);
		await resolveImage(sine({ name: "Sine of the Dub Upsilon", mbid: SINE_RG }), {
			cache,
			fetch: f,
			viaMusicBrainz: true,
		});
		expect(mbCalls(f)).toEqual([]);
	});
});

describe("through the queue, as GET /image/...?from=artist:kode9 serves it", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "tra-612-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("resolves the node and the compilation, at background priority, and records no mbid for the compilation", async () => {
		const f = network(
			rgSearch([sineGroup("Sine of the Dub Phi / Stalker")]),
			recSearch([compilationRecording("Hyperdub 10.3 Phi")]),
			caaFor(SINE_RG),
			caaFor(HYPERDUB_RG),
		);
		const node = projectNode("sine-of-the-dub-phi--kode9", "Sine of the Dub Phi", {
			artists: [edge("artist", "kode9", "Kode9", { mbid: KODE9 })],
		});
		const nodes = new Map<string, NodePayload>([[node.slug, node]]);
		const queue = createImageQueue({
			cacheDir: dir,
			cache: { get: async (s: string) => nodes.get(s) } as unknown as NodeCache,
			resolveNode: resolveImage,
			resolveHint: resolveWorkImageByHint,
			fetch: f,
			log: { info: () => {}, warn: () => {} },
		});
		queue.enqueueNode(node);
		const work = queue.enqueueHint(hint("Hyperdub 10.3 Phi", { slug: "project:hyperdub-10-3-phi" as Slug }));
		await vi.waitFor(async () => {
			expect(queue.stats()).toMatchObject({ resolved: 2, pending: 0, inFlight: 0 });
		});
		await queue.stop();

		const nodeEntry = await readImageSidecar(dir, node.slug);
		expect(nodeEntry).toMatchObject({ state: "found", url: COVER(SINE_RG), source: "caa" });
		const key = work.accepted ? work.key : ("project:none" as Slug);
		const compilationEntry = await readImageSidecar(dir, key);
		expect(compilationEntry).toMatchObject({ state: "found", url: COVER(HYPERDUB_RG), source: "caa" });
		expect(compilationEntry?.mbid).toBeUndefined();
	});
});
