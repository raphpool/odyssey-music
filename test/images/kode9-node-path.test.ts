import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeCache } from "../../src/cache.js";
import { resolveImage } from "../../src/images/resolve-image.js";
import { resolveWorkImageByHint } from "../../src/images/resolve-work-hint.js";
import type { NodePayload, ProjectNode } from "../../src/types.js";
import { artistNode, edge, jsonResponse, projectNode, redirectResponse, routedFetch } from "./helpers.js";

// TRA-612 follow-up: `project:sine-of-the-dub--kode9` as prod holds it stayed none / no-match.
const KODE9 = "e95a9d7f-fc26-4e56-8032-90cd954deea0";
const SPACEAPE = "88b53a2c-aac3-426d-b179-73f2355fddd8";
const SINE_RG = "1567159c-ea26-3934-a725-77fd4f6eccfb";

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

afterEach(() => {
	vi.unstubAllGlobals();
});

const sineSearch = (): [string, () => Response] => [
	"musicbrainz.org/ws/2/release-group",
	() => jsonResponse({ count: 1, "release-groups": [realHit] }),
];
const sineCover: [string, () => Response] = [
	`release-group/${SINE_RG}/front-500`,
	() => redirectResponse("https://archive.org/download/x/x.jpg"),
];
const COVER = `https://coverartarchive.org/release-group/${SINE_RG}/front-500`;

describe("a work the discography lists as an album, filed by MusicBrainz as a double A-side single", () => {
	// Measured live 2026-10-18: the hint of the artist page's edge shares the queue key of the node
	// (`project:sine-of-the-dub--kode9`), so its verdict is the node's. With an album release type it was no-match.
	const hint = (title: string, releaseType: "album" | "ep" | "single") => ({
		slug: "project:sine-of-the-dub--kode9" as never,
		type: "project" as const,
		title,
		artist: "Kode9",
		releaseType,
	});

	it("gets the single's cover when the caller wants a cover", async () => {
		const f = routedFetch([sineSearch(), sineCover]);
		vi.stubGlobal("fetch", f);
		const out = await resolveWorkImageByHint(hint("Sine of the Dub", "album"), {
			fetch: f,
			compilations: true,
		});
		expect(out).toEqual({ kind: "found", url: COVER, source: "caa", mbid: SINE_RG });
	});

	it("keeps the agreement rule of TRA-560 when the caller does not ask for a cover only", async () => {
		const f = routedFetch([
			sineSearch(),
			sineCover,
			["itunes.apple.com", () => jsonResponse({ results: [] })],
		]);
		vi.stubGlobal("fetch", f);
		const out = await resolveWorkImageByHint(hint("Sine of the Dub", "album"), { fetch: f });
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
		expect(f.calls.filter((c) => c.includes("coverartarchive"))).toEqual([]);
	});

	it("still needs the credit: an album of another artist, or a single of three titles, gets nothing", async () => {
		const other = {
			...realHit,
			title: "Sine of the Dub Two / Stalker",
			"artist-credit": [
				{ name: "Other", artist: { id: "99999999-0000-4000-8000-0000000000dd", name: "Other" } },
			],
		};
		const f = routedFetch([
			["musicbrainz.org/ws/2/release-group", () => jsonResponse({ count: 1, "release-groups": [other] })],
			sineCover,
			["musicbrainz.org/ws/2/recording", () => jsonResponse({ count: 0, recordings: [] })],
			["itunes.apple.com", () => jsonResponse({ results: [] })],
		]);
		vi.stubGlobal("fetch", f);
		const out = await resolveWorkImageByHint(hint("Sine of the Dub Two", "album"), {
			fetch: f,
			compilations: true,
		});
		expect(out).toEqual({ kind: "missing", reason: "no-match" });
	});

	it("reaches the node path too: a project stamped as an album gets the cover", async () => {
		const f = routedFetch([sineSearch(), sineCover]);
		vi.stubGlobal("fetch", f);
		const node = projectNode("sine-of-the-dub--kode9", "Sine of the Dub", {
			release_type: "album",
			artists: [edge("artist", "kode9", "Kode9", { mbid: KODE9 })],
		});
		const out = await resolveImage(node as NodePayload, {
			cache: {} as NodeCache,
			fetch: f,
			viaMusicBrainz: true,
		});
		expect(out).toEqual({ url: COVER, source: "caa" });
	});
});

describe("the Kode9 node as prod holds it", () => {
	it("gets the cover of 'Sine of the Dub / Stalker', whatever its year", async () => {
		const f = routedFetch([
			["musicbrainz.org/ws/2/release-group", () => jsonResponse({ count: 1, "release-groups": [realHit] })],
			[`release-group/${SINE_RG}/front-500`, () => redirectResponse("https://archive.org/download/x/x.jpg")],
		]);
		vi.stubGlobal("fetch", f);
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
		expect(out).toEqual({
			url: `https://coverartarchive.org/release-group/${SINE_RG}/front-500`,
			source: "caa",
		});
	});
});
