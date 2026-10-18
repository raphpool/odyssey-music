import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeCache } from "../../src/cache.js";
import { coverArtUrl } from "../../src/images/coverart.js";
import { createImageQueue } from "../../src/images/image-queue.js";
import { readImageSidecar } from "../../src/images/image-sidecar.js";
import { resolveImage } from "../../src/images/resolve-image.js";
import { resolveWorkImageByHint, type WorkImageHint } from "../../src/images/resolve-work-hint.js";
import type { NodePayload, Slug } from "../../src/types.js";
import { artistNode, edge, jsonResponse, projectNode, redirectResponse, routedFetch } from "./helpers.js";

// TRA-612 follow-up. The Cover Art Archive answers 429 / 5xx or times out at times; the job used to keep that
// null as a `missing / no-match` verdict, for 7 days. Inputs are the prod ones (2026-10-18, c1d51b5c): the node
// `project:sine-of-the-dub--kode9` (2006, no release type, no mbid, artists kode9 + the-spaceape), the edge of
// `label:hyperdub.notable_releases` ({slug, type, name, artist: "Kode9"}, no release type), Kode9's MBID on his node.
const KODE9 = "e95a9d7f-fc26-4e56-8032-90cd954deea0";
const SPACEAPE = "88b53a2c-aac3-426d-b179-73f2355fddd8";
const SINE_RG = "1567159c-ea26-3934-a725-77fd4f6eccfb";
const sineHit = {
	id: SINE_RG,
	score: 100,
	title: "Sine of the Dub / Stalker",
	"first-release-date": "2004-04-26",
	"primary-type": "Single",
	"artist-credit": [
		{ joinphrase: " + ", name: "Kode9", artist: { id: KODE9, name: "Kode9" } },
		{ name: "The Space Ape", artist: { id: SPACEAPE, name: "The Spaceape" } },
	],
};
const mbSearch: [string, () => Response] = [
	"musicbrainz.org/ws/2/release-group",
	() => jsonResponse({ count: 1, "release-groups": [sineHit] }),
];
const recordings: [string, () => Response] = [
	"musicbrainz.org/ws/2/recording",
	() => jsonResponse({ count: 0, recordings: [] }),
];
const itunes: [string, () => Response] = ["itunes.apple.com", () => jsonResponse({ results: [] })];
const caaDown = (status: number): [string, () => Response] => [
	"coverartarchive.org",
	() => new Response("", { status }),
];
const caaUp: [string, () => Response] = [
	`release-group/${SINE_RG}/front-500`,
	() => redirectResponse("https://archive.org/download/x/x.jpg"),
];

const prodNode = () =>
	projectNode("sine-of-the-dub--kode9", "Sine of the Dub", {
		year: "2006",
		label: edge("label", "hyperdub", "Hyperdub"),
		artists: [edge("artist", "kode9", "Kode9"), edge("artist", "the-spaceape", "The Spaceape")],
	});
const prodHint: WorkImageHint = {
	slug: "project:sine-of-the-dub--kode9" as Slug,
	type: "project",
	title: "Sine of the Dub",
	artist: "Kode9",
};
const cacheWith = (...nodes: NodePayload[]): NodeCache =>
	({
		get: async (slug: string) => {
			const found = nodes.find((n) => n.slug === slug);
			if (!found) throw new Error(`not found: ${slug}`);
			return found;
		},
	}) as unknown as NodeCache;

function network(...routes: Array<[string, () => Response]>) {
	const f = routedFetch(routes);
	vi.stubGlobal("fetch", f);
	return f;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("coverArtUrl tells an outage from a missing cover", () => {
	const mbid = SINE_RG;
	it.each([429, 500, 502, 503])("calls onOutage on a %i", async (status) => {
		const onOutage = vi.fn();
		expect(await coverArtUrl(mbid, network(caaDown(status)), onOutage)).toBeNull();
		expect(onOutage).toHaveBeenCalledTimes(1);
	});

	it("calls onOutage when the request fails outright", async () => {
		const onOutage = vi.fn();
		const failing = (async () => {
			throw new Error("socket hang up");
		}) as unknown as typeof fetch;
		expect(await coverArtUrl(mbid, failing, onOutage)).toBeNull();
		expect(onOutage).toHaveBeenCalledTimes(1);
	});

	it("stays silent on a 404 (no cover) and on a found cover", async () => {
		const onOutage = vi.fn();
		expect(await coverArtUrl(mbid, network(caaDown(404)), onOutage)).toBeNull();
		expect(await coverArtUrl(mbid, network(caaUp), onOutage)).toContain(SINE_RG);
		expect(onOutage).not.toHaveBeenCalled();
	});
});

describe("the prod inputs, with the Cover Art Archive down", () => {
	beforeEach(() => {
		vi.stubEnv("MB_MAX_ATTEMPTS", "1");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("hint of the label's edge: unavailable, not no-match", async () => {
		const f = network(mbSearch, caaDown(503), itunes);
		expect(await resolveWorkImageByHint(prodHint, { fetch: f, compilations: true })).toEqual({
			kind: "unavailable",
		});
	});

	it("hint: a 404 is still a plain miss", async () => {
		const f = network(mbSearch, recordings, caaDown(404), itunes);
		expect(await resolveWorkImageByHint(prodHint, { fetch: f, compilations: true })).toEqual({
			kind: "missing",
			reason: "no-match",
		});
	});

	it("hint: an iTunes cover found after the outage still wins", async () => {
		const art = "https://is1-ssl.mzstatic.com/image/thumb/Music/x/source/100x100bb.jpg";
		const f = network(mbSearch, caaDown(503), [
			"itunes.apple.com",
			() =>
				jsonResponse({
					results: [{ artworkUrl100: art, collectionName: "Sine of the Dub", artistName: "Kode9" }],
				}),
		]);
		const out = await resolveWorkImageByHint(prodHint, { fetch: f, compilations: true });
		expect(out).toMatchObject({ kind: "found", source: "itunes-verified" });
	});

	it("node: resolveImage returns null and reports the outage", async () => {
		const f = network(mbSearch, caaDown(503), itunes);
		const outage = { musicBrainz: false, coverArt: false };
		const kode9 = artistNode("kode9", "Kode9", { mbid: KODE9 });
		const out = await resolveImage(prodNode(), {
			cache: cacheWith(kode9),
			fetch: f,
			viaMusicBrainz: true,
			outage,
		});
		expect(out).toBeNull();
		expect(outage).toEqual({ musicBrainz: false, coverArt: true });
	});

	describe("through the queue", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await mkdtemp(join(tmpdir(), "caa-outage-"));
		});
		afterEach(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		async function run(f: typeof fetch, job: { node: NodePayload } | { hint: WorkImageHint }) {
			const kode9 = artistNode("kode9", "Kode9", { mbid: KODE9 });
			const node = "node" in job ? job.node : undefined;
			const queue = createImageQueue({
				cacheDir: dir,
				cache: cacheWith(kode9, ...(node ? [node] : [])),
				resolveNode: resolveImage,
				resolveHint: resolveWorkImageByHint,
				fetch: f,
				log: { info: () => {}, warn: () => {} },
			});
			const outcome = node
				? queue.enqueueNode(node)
				: queue.enqueueHint((job as { hint: WorkImageHint }).hint);
			await vi.waitFor(() => expect(queue.stats()).toMatchObject({ pending: 0, inFlight: 0 }));
			await queue.stop();
			return outcome.accepted ? outcome.key : ("project:none" as Slug);
		}

		it("records unavailable (1 h) for the node, and missing only when the archive really has no cover", async () => {
			const down = await run(network(mbSearch, caaDown(503), itunes), { node: prodNode() });
			expect(await readImageSidecar(dir, down)).toMatchObject({ state: "unavailable" });
		});

		it("records unavailable (1 h) for the hint", async () => {
			const key = await run(network(mbSearch, caaDown(503), itunes), { hint: prodHint });
			expect(await readImageSidecar(dir, key)).toMatchObject({ state: "unavailable" });
		});
	});
});
