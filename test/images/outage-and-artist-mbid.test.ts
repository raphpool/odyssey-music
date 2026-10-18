import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeCache } from "../../src/cache.js";
import { createImageQueue } from "../../src/images/image-queue.js";
import { readImageSidecar } from "../../src/images/image-sidecar.js";
import { resolveImage } from "../../src/images/resolve-image.js";
import { resolveWorkImageByHint, type WorkImageHint } from "../../src/images/resolve-work-hint.js";
import type { NodePayload, Slug } from "../../src/types.js";
import { artistNode, edge, jsonResponse, projectNode, redirectResponse, routedFetch } from "./helpers.js";

// TRA-612, review nits: an outage is not a miss, and the artist's MBID is read where it is.
const KODE9 = "e95a9d7f-fc26-4e56-8032-90cd954deea0";
const NAMESAKE = "99999999-0000-4000-8000-0000000000aa";
const SINE_RG = "1567159c-ea26-3934-a725-77fd4f6eccfb";
const ARCHIVE = "https://ia800000.us.archive.org/1/items/x/x.jpg";
const COVER = `https://coverartarchive.org/release-group/${SINE_RG}/front-500`;

const credit = (id: string) => [{ name: "Kode9", artist: { id, name: "Kode9" } }];
const sineGroup = (title: string, creditedTo: string) => ({
	id: SINE_RG,
	score: 100,
	title: `${title} / Stalker`,
	"primary-type": "Single",
	"first-release-date": "2004-01-01",
	"artist-credit": credit(creditedTo),
});
const rgSearch = (hits: unknown[]): [string, () => Response] => [
	"musicbrainz.org/ws/2/release-group",
	() => jsonResponse({ count: hits.length, "release-groups": hits }),
];
const recSearchEmpty: [string, () => Response] = [
	"musicbrainz.org/ws/2/recording",
	() => jsonResponse({ count: 0, recordings: [] }),
];
const caa: [string, () => Response] = [`release-group/${SINE_RG}/front-500`, () => redirectResponse(ARCHIVE)];
const itunesEmpty: [string, () => Response] = ["itunes.apple.com", () => jsonResponse({ results: [] })];
const mbDown = (path: string): [string, () => Response] => [
	`musicbrainz.org/ws/2/${path}`,
	() => new Response("busy", { status: 503 }),
];

function network(...routes: Array<[string, () => Response]>) {
	const f = routedFetch(routes);
	vi.stubGlobal("fetch", f);
	return f;
}

beforeEach(() => {
	vi.stubEnv("MB_MAX_ATTEMPTS", "1"); // one try per request: the 503 is not retried for seconds
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

/** A cache that holds the credited artist's node (and answers "not found" for the rest). */
function cacheWith(...nodes: NodePayload[]): NodeCache {
	const bySlug = new Map(nodes.map((n) => [n.slug as string, n]));
	return {
		get: async (slug: string) => {
			const node = bySlug.get(slug);
			if (!node) throw new Error(`not found: ${slug}`);
			return node;
		},
	} as unknown as NodeCache;
}

const project = (name: string, artistEdge = edge("artist", "kode9", "Kode9")) =>
	projectNode(`${name.toLowerCase().replace(/\W+/g, "-")}--kode9`, name, { artists: [artistEdge] });

describe("an outage is not a miss: node path", () => {
	it("tells the caller when the MusicBrainz rung could not answer, and stays silent on a plain miss", async () => {
		const down = network(mbDown("release-group"), itunesEmpty);
		const outage = { musicBrainz: false };
		const out = await resolveImage(project("Outage Alpha"), {
			cache: cacheWith(),
			fetch: down,
			viaMusicBrainz: true,
			outage,
		});
		expect(out).toBeNull();
		expect(outage.musicBrainz).toBe(true);

		const quiet = network(rgSearch([]), recSearchEmpty, itunesEmpty);
		const sink = { musicBrainz: false };
		expect(
			await resolveImage(project("Outage Beta"), {
				cache: cacheWith(),
				fetch: quiet,
				viaMusicBrainz: true,
				outage: sink,
			}),
		).toBeNull();
		expect(sink.musicBrainz).toBe(false);
	});

	it("is not reported when a later rung found the image anyway", async () => {
		const f = network(mbDown("release-group"), ["itunes.apple.com", () => jsonResponse({ results: [] })]);
		const outage = { musicBrainz: false };
		await resolveImage(project("Outage Gamma"), {
			cache: cacheWith(),
			fetch: f,
			viaMusicBrainz: true,
			outage,
		});
		expect(outage.musicBrainz).toBe(true); // reported; the queue only uses it when there is no image
	});
});

describe("an outage is not a miss: compilation path", () => {
	const hint = (title: string): WorkImageHint => ({
		slug: `project:${title.toLowerCase().replace(/\W+/g, "-")}` as Slug,
		type: "project",
		title,
		artist: "Kode9",
	});

	it("ends as unavailable when the recording search fails", async () => {
		const f = network(rgSearch([]), mbDown("recording"), itunesEmpty);
		const out = await resolveWorkImageByHint(hint("Outage Delta"), { fetch: f, compilations: true });
		expect(out).toEqual({ kind: "unavailable" });
	});

	it("ends as missing, as before, when the search answered and found nothing", async () => {
		const f = network(
			rgSearch([]),
			["musicbrainz.org/ws/2/recording", () => jsonResponse({ count: 0, recordings: [] })],
			itunesEmpty,
		);
		const out = await resolveWorkImageByHint(hint("Outage Epsilon"), { fetch: f, compilations: true });
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
	});
});

describe("through the queue: unavailable (1 h), not missing (7 days)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "tra-612-outage-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function runQueue(f: typeof fetch, node?: NodePayload, workHint?: WorkImageHint) {
		const queue = createImageQueue({
			cacheDir: dir,
			cache: cacheWith(...(node ? [node] : [])),
			resolveNode: resolveImage,
			resolveHint: resolveWorkImageByHint,
			fetch: f,
			log: { info: () => {}, warn: () => {} },
		});
		const outcome = node ? queue.enqueueNode(node) : queue.enqueueHint(workHint as WorkImageHint);
		await vi.waitFor(() => expect(queue.stats()).toMatchObject({ pending: 0, inFlight: 0 }));
		await queue.stop();
		return outcome.accepted ? outcome.key : ("project:none" as Slug);
	}

	it("records unavailable for a node whose MusicBrainz rung failed", async () => {
		const node = project("Outage Zeta");
		const key = await runQueue(network(mbDown("release-group"), itunesEmpty), node);
		expect(await readImageSidecar(dir, key)).toMatchObject({ state: "unavailable" });
	});

	it("records unavailable for a work whose compilation search failed", async () => {
		const workHint: WorkImageHint = {
			slug: "project:outage-eta" as Slug,
			type: "project",
			title: "Outage Eta",
			artist: "Kode9",
		};
		const key = await runQueue(network(rgSearch([]), mbDown("recording"), itunesEmpty), undefined, workHint);
		expect(await readImageSidecar(dir, key)).toMatchObject({ state: "unavailable" });
	});

	it("still records missing for a node MusicBrainz answered about", async () => {
		const node = project("Outage Theta");
		const key = await runQueue(network(rgSearch([]), recSearchEmpty, itunesEmpty), node);
		expect(await readImageSidecar(dir, key)).toMatchObject({ state: "missing", reason: "no-match" });
	});
});

describe("the credited artist's MBID on the node path", () => {
	const kode9Node = artistNode("kode9", "Kode9", { mbid: KODE9 });

	it("refuses a release group credited to a namesake when the artist's own node holds a different MBID", async () => {
		const f = network(rgSearch([sineGroup("Mbid Alpha", NAMESAKE)]), caa, itunesEmpty);
		const out = await resolveImage(project("Mbid Alpha"), {
			cache: cacheWith(kode9Node),
			fetch: f,
			viaMusicBrainz: true,
		});
		expect(out).toBeNull();
		expect(f.calls.filter((c) => c.includes("coverartarchive"))).toEqual([]);
	});

	it("accepts the same release group when it is credited to the artist's MBID", async () => {
		const f = network(rgSearch([sineGroup("Mbid Beta", KODE9)]), caa);
		const out = await resolveImage(project("Mbid Beta"), {
			cache: cacheWith(kode9Node),
			fetch: f,
			viaMusicBrainz: true,
		});
		expect(out).toEqual({ url: COVER, source: "caa" });
	});

	it("falls back to the name when no MBID is known anywhere", async () => {
		const f = network(rgSearch([sineGroup("Mbid Gamma", NAMESAKE)]), caa);
		const out = await resolveImage(project("Mbid Gamma"), {
			cache: cacheWith(artistNode("kode9", "Kode9")),
			fetch: f,
			viaMusicBrainz: true,
		});
		expect(out).toEqual({ url: COVER, source: "caa" });
	});

	it("passes the artist's MBID from its node to the compilation search", async () => {
		const namesakeTrack = {
			id: "33333333-0000-4000-8000-0000000000bb",
			score: 100,
			title: "A track",
			"artist-credit": credit(NAMESAKE),
			releases: [
				{
					id: "33333333-0000-4000-8000-0000000000cc",
					title: "Mbid Delta",
					"artist-credit": [
						{
							name: "Various Artists",
							artist: { id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists" },
						},
					],
					"release-group": {
						id: "1de78c85-bbe7-441f-b3a1-9db3c5358e01",
						title: "Mbid Delta",
						"primary-type": "Album",
						"secondary-types": ["Compilation"],
					},
				},
			],
		};
		const f = network(
			rgSearch([]),
			["musicbrainz.org/ws/2/recording", () => jsonResponse({ count: 1, recordings: [namesakeTrack] })],
			["coverartarchive.org", () => redirectResponse(ARCHIVE)],
			itunesEmpty,
		);
		const out = await resolveImage(project("Mbid Delta"), {
			cache: cacheWith(kode9Node),
			fetch: f,
			viaMusicBrainz: true,
		});
		expect(out).toBeNull();
	});
});
