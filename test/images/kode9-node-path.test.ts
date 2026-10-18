import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeCache } from "../../src/cache.js";
import { resolveImage } from "../../src/images/resolve-image.js";
import { resolveWorkImageByHint } from "../../src/images/resolve-work-hint.js";
import type { NodePayload, ProjectNode, Slug } from "../../src/types.js";
import { artistNode, edge, jsonResponse, projectNode, redirectResponse, routedFetch } from "./helpers.js";

// TRA-612 follow-up. The prod inputs of 2026-10-18 (c1d51b5c), with every upstream answering: both paths find
// the cover. No year check exists on the node path, and a known release type is not involved (no edge types the work).
const KODE9 = "e95a9d7f-fc26-4e56-8032-90cd954deea0";
const SPACEAPE = "88b53a2c-aac3-426d-b179-73f2355fddd8";
const SINE_RG = "1567159c-ea26-3934-a725-77fd4f6eccfb";
const COVER = `https://coverartarchive.org/release-group/${SINE_RG}/front-500`;

// The release group MusicBrainz really answers for `releasegroup:"Sine of the Dub" AND artist:"Kode9"`.
const realHit = {
	id: SINE_RG,
	score: 100,
	count: 4,
	title: "Sine of the Dub / Stalker",
	"first-release-date": "2004-04-26",
	"primary-type": "Single",
	"artist-credit": [
		{ joinphrase: " + ", name: "Kode9", artist: { id: KODE9, name: "Kode9", "sort-name": "Kode9" } },
		{ name: "The Space Ape", artist: { id: SPACEAPE, name: "The Spaceape", "sort-name": "Spaceape, The" } },
	],
};

function network() {
	const f = routedFetch([
		["musicbrainz.org/ws/2/release-group", () => jsonResponse({ count: 1, "release-groups": [realHit] })],
		[`release-group/${SINE_RG}/front-500`, () => redirectResponse("https://archive.org/download/x/x.jpg")],
	]);
	vi.stubGlobal("fetch", f);
	return f;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the Kode9 work as prod holds it", () => {
	it("node path: the node (2006, no release type, no mbid) gets the cover, whatever its year", async () => {
		const f = network();
		const node = projectNode("sine-of-the-dub--kode9", "Sine of the Dub", {
			year: "2006",
			// prod stores a null here, not an absent key
			release_type: null as unknown as NonNullable<ProjectNode["release_type"]>,
			label: edge("label", "hyperdub", "Hyperdub"),
			artists: [edge("artist", "kode9", "Kode9"), edge("artist", "the-spaceape", "The Spaceape")],
		});
		const kode9 = artistNode("kode9", "Kode9", { mbid: KODE9 });
		const cache = {
			get: async (slug: string) => {
				if (slug === "artist:kode9") return kode9;
				throw new Error(`not found: ${slug}`);
			},
		} as unknown as NodeCache;
		const out = await resolveImage(node as NodePayload, { cache, fetch: f, viaMusicBrainz: true });
		expect(out).toEqual({ url: COVER, source: "caa" });
	});

	it("hint path: the edge of label:hyperdub.notable_releases ({name, artist: Kode9}, no release type) gets it too", async () => {
		const f = network();
		const out = await resolveWorkImageByHint(
			{
				slug: "project:sine-of-the-dub--kode9" as Slug,
				type: "project",
				title: "Sine of the Dub",
				artist: "Kode9",
			},
			{ fetch: f, compilations: true, mbOptions: { priority: "background" } },
		);
		expect(out).toEqual({ kind: "found", url: COVER, source: "caa", mbid: SINE_RG });
	});
});
