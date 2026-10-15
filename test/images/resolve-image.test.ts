import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../../src/cache.js";
import { isAllowedImageUrl } from "../../src/images/hosts.js";
import { resolveImage } from "../../src/images/resolve-image.js";
import { wikidataConfig } from "../../src/images/wikidata.js";
import type { NodePayload } from "../../src/types.js";
import {
	artistNode,
	edge,
	genreNode,
	jsonResponse,
	labelNode,
	projectNode,
	redirectResponse,
	routedFetch,
	trackNode,
} from "./helpers.js";

// Each MBID is used by one test only: mbFetch memoizes by path for 5 minutes.
const mb = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const caaUrl = (id: string): string => `https://coverartarchive.org/release-group/${id}/front-500`;
const COVER = (n: number): string => `https://coverartarchive.org/release-group/${mb(n)}/front-500`;
const ARCHIVE = "https://ia800000.us.archive.org/1/items/x/x.jpg";
const itunesArt = "https://is1-ssl.mzstatic.com/image/thumb/Music/x/source/100x100bb.jpg";

let dir: string;
let cache: NodeCache;
const suiteInterval = wikidataConfig.minIntervalMs;

beforeEach(async () => {
	wikidataConfig.minIntervalMs = 0;
	dir = await mkdtemp(join(tmpdir(), "odyssey-resolve-image-"));
	cache = new NodeCache(dir);
});

afterEach(async () => {
	wikidataConfig.minIntervalMs = suiteInterval;
	await rm(dir, { recursive: true, force: true });
});

const caaFound = (id: string): [string, () => Response] => [
	`release-group/${id}/front-500`,
	() => redirectResponse(ARCHIVE),
];
const caaMissing: [string, () => Response] = ["coverartarchive.org", () => new Response("", { status: 404 })];
const itunesWith = (results: unknown[]): [string, () => Response] => [
	"itunes.apple.com",
	() => jsonResponse({ results }),
];
const mbRels = (relations: unknown[]): [string, () => Response] => [
	"musicbrainz.org/ws/2/",
	() => jsonResponse({ relations }),
];
const wikidataRel = (qid: string) => ({
	type: "wikidata",
	url: { resource: `https://www.wikidata.org/wiki/${qid}` },
});
const claims = (qid: string, claimsByProp: Record<string, unknown[]>): [string, () => Response] => [
	"wbgetentities",
	() => jsonResponse({ entities: { [qid]: { id: qid, claims: claimsByProp } } }),
];
const value = (v: unknown) => ({ mainsnak: { snaktype: "value", datavalue: { value: v } } });

async function seed(...nodes: NodePayload[]): Promise<void> {
	for (const n of nodes) await cache.write(n);
}

describe("resolveImage: project", () => {
	it("uses the canonical Cover Art Archive URL when the release group has a front cover", async () => {
		const f = routedFetch([caaFound(mb(1))]);
		const node = projectNode("new-forms", "New Forms", { mbid: mb(1) });
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({ url: COVER(1), source: "caa" });
		expect(f.calls.filter((c) => c.includes("itunes"))).toEqual([]);
	});

	it("falls back to a verified iTunes match, upscaled to 600 px", async () => {
		const f = routedFetch([
			caaMissing,
			itunesWith([{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: itunesArt }]),
		]);
		const node = projectNode("new-forms", "New Forms", {
			mbid: mb(2),
			artists: [edge("artist", "roni-size", "Roni Size")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({
			url: itunesArt.replace("100x100bb", "600x600bb"),
			source: "itunes-verified",
		});
	});

	it("is null when CAA has no cover and no iTunes result matches artist AND title (never results[0])", async () => {
		const f = routedFetch([
			caaMissing,
			itunesWith([
				{ collectionName: "The Message", artistName: "Earth, Wind & Fire", artworkUrl100: itunesArt },
				{ collectionName: "Something Else", artistName: "Grandmaster Flash", artworkUrl100: itunesArt },
			]),
		]);
		const node = projectNode("the-message", "The Message", {
			mbid: mb(3),
			artists: [edge("artist", "grandmaster-flash", "Grandmaster Flash")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
	});

	it("skips CAA without an MBID, and iTunes without a credited artist", async () => {
		const f = routedFetch([
			itunesWith([{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: itunesArt }]),
		]);
		const node = projectNode("new-forms", "New Forms");
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
		expect(f.calls).toEqual([]);
	});

	it("falls through to iTunes when the CAA request fails", async () => {
		const f = routedFetch([
			[
				"coverartarchive.org",
				() => {
					throw new Error("offline");
				},
			],
			itunesWith([{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: itunesArt }]),
		]);
		const node = projectNode("new-forms", "New Forms", {
			mbid: mb(4),
			artists: [edge("artist", "roni-size", "Roni Size")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toMatchObject({
			source: "itunes-verified",
		});
	});

	it("returns null when the CAA redirect leaves the allowed hosts", async () => {
		const f = routedFetch([["coverartarchive.org", () => redirectResponse("https://evil.example/c.jpg")]]);
		const node = projectNode("new-forms", "New Forms", { mbid: mb(5) });
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
	});
});

describe("resolveImage: track", () => {
	it("reuses the image of its cached project, with the project's provenance", async () => {
		await seed(projectNode("new-forms", "New Forms", { image_url: COVER(10), image_source: "caa" }));
		const f = routedFetch([]);
		const node = trackNode("brown-paper-bag", "Brown Paper Bag", {
			project: edge("project", "new-forms", "New Forms"),
			artists: [edge("artist", "roni-size", "Roni Size")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({ url: COVER(10), source: "caa" });
		expect(f.calls).toEqual([]);
	});

	it("asks CAA with the project's MBID when the project has no image yet", async () => {
		await seed(projectNode("new-forms", "New Forms", { mbid: mb(11) }));
		const f = routedFetch([caaFound(mb(11))]);
		const node = trackNode("brown-paper-bag", "Brown Paper Bag", {
			mbid: mb(99), // a recording MBID: must never be sent to Cover Art Archive
			project: edge("project", "new-forms", "New Forms"),
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({ url: COVER(11), source: "caa" });
		expect(f.calls.some((c) => c.includes(mb(99)))).toBe(false);
	});

	it("falls back to the edge MBID when the project is not cached", async () => {
		const f = routedFetch([caaFound(mb(12))]);
		const node = trackNode("brown-paper-bag", "Brown Paper Bag", {
			project: edge("project", "new-forms", "New Forms", { mbid: mb(12) }),
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({ url: COVER(12), source: "caa" });
	});

	it("falls back to a verified iTunes album match on the project title and the track's artist", async () => {
		const f = routedFetch([
			caaMissing,
			itunesWith([{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: itunesArt }]),
		]);
		const node = trackNode("brown-paper-bag", "Brown Paper Bag", {
			project: edge("project", "new-forms", "New Forms", { mbid: mb(13) }),
			artists: [edge("artist", "roni-size", "Roni Size")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toMatchObject({
			source: "itunes-verified",
		});
		const term = new URL(f.calls.find((c) => c.includes("itunes")) ?? "").searchParams.get("term");
		expect(term).toBe("New Forms Roni Size");
	});

	it("is null for an orphan track whose iTunes results do not match", async () => {
		const f = routedFetch([
			itunesWith([
				{ collectionName: "Brown Paper Bag", artistName: "Someone Else", artworkUrl100: itunesArt },
			]),
		]);
		const node = trackNode("brown-paper-bag", "Brown Paper Bag", {
			artists: [edge("artist", "roni-size", "Roni Size")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
	});
});

describe("resolveImage: artist", () => {
	const roni = (extra = {}) => artistNode("roni-size", "Roni Size", { mbid: mb(20), ...extra });

	it("resolves Roni Size through MusicBrainz url-rels, Wikidata P18 and Commons", async () => {
		const f = routedFetch([
			mbRels([wikidataRel("Q964002")]),
			claims("Q964002", { P18: [value("Roni Size.jpg")] }),
		]);
		await expect(resolveImage(roni(), { cache, fetch: f })).resolves.toEqual({
			url: "https://commons.wikimedia.org/wiki/Special:FilePath/Roni%20Size.jpg?width=600",
			source: "wikidata-p18",
		});
	});

	it("falls back to the landmark project's cover as a derived cover, never a photo source", async () => {
		await seed(
			projectNode("new-forms", "New Forms", { image_url: COVER(21), image_source: "caa" }),
			projectNode("in-the-møde", "In the Møde", { image_url: COVER(22), image_source: "caa" }),
		);
		const f = routedFetch([mbRels([wikidataRel("Q964002")]), claims("Q964002", {})]);
		const node = roni({
			discography: [edge("project", "in-the-møde", "In the Møde")],
			landmark_project: edge("project", "new-forms", "New Forms"),
		} as Record<string, unknown>);
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({
			url: COVER(21),
			source: "derived-cover",
		});
	});

	it("takes the first discography release that has an image when there is no landmark project", async () => {
		await seed(
			projectNode("no-image", "No Image"),
			projectNode("new-forms", "New Forms", { image_url: COVER(23), image_source: "caa" }),
		);
		const f = routedFetch([mbRels([]), claims("Q1", {})]);
		const node = roni({
			discography: [
				edge("project", "uncached", "Not In Cache"),
				edge("project", "no-image", "No Image"),
				edge("project", "new-forms", "New Forms"),
			],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({
			url: COVER(23),
			source: "derived-cover",
		});
	});

	it("derives from the discography without any request when the artist has no MBID", async () => {
		await seed(projectNode("new-forms", "New Forms", { image_url: COVER(24), image_source: "caa" }));
		const f = routedFetch([]);
		const node = artistNode("roni-size", "Roni Size", {
			discography: [edge("project", "new-forms", "New Forms")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toMatchObject({ source: "derived-cover" });
		expect(f.calls).toEqual([]);
	});

	it("is null when there is no photo and nothing imaged to derive from", async () => {
		const f = routedFetch([mbRels([wikidataRel("Q964002")]), claims("Q964002", {})]);
		await expect(resolveImage(roni(), { cache, fetch: f })).resolves.toBeNull();
	});

	it("is null, without throwing, when the Wikidata response is malformed", async () => {
		for (const body of [
			{},
			{ entities: 3 },
			"<html>",
			null,
			{ entities: { Q964002: { claims: { P18: [{ mainsnak: 1 }] } } } },
		]) {
			const f = routedFetch([mbRels([wikidataRel("Q964002")]), ["wbgetentities", () => jsonResponse(body)]]);
			const node = artistNode("roni-size", "Roni Size", { mbid: mb(25) });
			await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
		}
	});

	it("is null when Wikidata is unreachable", async () => {
		const f = routedFetch([
			mbRels([wikidataRel("Q964002")]),
			[
				"wbgetentities",
				() => {
					throw new Error("offline");
				},
			],
		]);
		const node = artistNode("roni-size", "Roni Size", { mbid: mb(26) });
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
	});

	it("ignores a Wikidata link that is not on wikidata.org", async () => {
		const f = routedFetch([
			mbRels([{ type: "wikidata", url: { resource: "https://evil.example/wiki/Q964002" } }]),
		]);
		const node = artistNode("roni-size", "Roni Size", { mbid: mb(27) });
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
		expect(f.calls.some((c) => c.includes("wikidata.org"))).toBe(false);
	});
});

describe("resolveImage: label", () => {
	const warpReleases = [edge("project", "mus-no-image", "Untitled"), edge("project", "lp5", "LP5")];

	it("uses the P154 logo first, then P18 (Wikidata QID from MusicBrainz url-rels)", async () => {
		const both = routedFetch([
			mbRels([wikidataRel("Q1312")]),
			claims("Q1312", { P154: [value("Warp logo.svg")], P18: [value("Warp HQ.jpg")] }),
		]);
		const node = labelNode("warp", "Warp", { mbid: mb(30) });
		await expect(resolveImage(node, { cache, fetch: both })).resolves.toEqual({
			url: "https://commons.wikimedia.org/wiki/Special:FilePath/Warp%20logo.svg?width=600",
			source: "wikidata-p154",
		});

		const p18Only = routedFetch([
			mbRels([wikidataRel("Q1313")]),
			claims("Q1313", { P18: [value("Warp HQ.jpg")] }),
		]);
		const other = labelNode("warp-2", "Warp 2", { mbid: mb(31) });
		await expect(resolveImage(other, { cache, fetch: p18Only })).resolves.toEqual({
			url: "https://commons.wikimedia.org/wiki/Special:FilePath/Warp%20HQ.jpg?width=600",
			source: "wikidata-p18",
		});
	});

	it("looks the label up by name when MusicBrainz has no Wikidata link", async () => {
		const f = routedFetch([
			mbRels([]),
			["wbsearchentities", () => jsonResponse({ search: [{ id: "Q1312", label: "Warp" }] })],
			[
				"ids=Q1312&props=claims",
				() =>
					jsonResponse({
						entities: {
							Q1312: {
								id: "Q1312",
								claims: {
									P31: [value({ id: "Q18127" })],
									P966: [value(mb(32))],
									P154: [value("Warp logo.svg")],
								},
							},
						},
					}),
			],
		]);
		const node = labelNode("warp", "Warp", { mbid: mb(32) });
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toMatchObject({ source: "wikidata-p154" });
	});

	it("falls back to the cover of the first notable release that has an image (Warp, no P18/P154)", async () => {
		await seed(
			projectNode("mus-no-image", "Untitled"),
			projectNode("lp5", "LP5", { image_url: COVER(33), image_source: "caa" }),
		);
		const f = routedFetch([mbRels([wikidataRel("Q1312")]), claims("Q1312", {})]);
		const node = labelNode("warp", "Warp", { mbid: mb(33), notable_releases: warpReleases });
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({
			url: COVER(33),
			source: "derived-cover",
		});
	});

	it("is null without an imaged notable release", async () => {
		await seed(projectNode("mus-no-image", "Untitled"));
		const f = routedFetch([mbRels([]), ["wbsearchentities", () => jsonResponse({ search: [] })]]);
		const node = labelNode("warp", "Warp", { mbid: mb(34), notable_releases: warpReleases });
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
	});

	it("searches by name alone when the label has no MBID", async () => {
		const f = routedFetch([
			["wbsearchentities", () => jsonResponse({ search: [{ id: "Q1312", label: "Warp" }] })],
			[
				"ids=Q1312&props=claims",
				() =>
					jsonResponse({
						entities: {
							Q1312: {
								id: "Q1312",
								claims: { P31: [value({ id: "Q18127" })], P154: [value("Warp logo.svg")] },
							},
						},
					}),
			],
		]);
		const node = labelNode("warp", "Warp");
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toMatchObject({ source: "wikidata-p154" });
	});
});

describe("resolveImage: genre", () => {
	it("skips a first landmark project without image and takes the second", async () => {
		await seed(
			projectNode("bare", "Bare"),
			projectNode("second", "Second", { image_url: COVER(40), image_source: "caa" }),
		);
		const node = genreNode("jungle", "Jungle", {
			landmark_projects: [edge("project", "bare", "Bare"), edge("project", "second", "Second")],
		});
		const f = routedFetch([]);
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toEqual({
			url: COVER(40),
			source: "derived-cover",
		});
		expect(f.calls).toEqual([]);
	});

	it("only looks at landmark tracks when no landmark project has an image", async () => {
		await seed(
			projectNode("bare", "Bare"),
			trackNode("anthem", "Anthem", { image_url: COVER(41), image_source: "derived-cover" }),
		);
		const node = genreNode("jungle", "Jungle", {
			landmark_projects: [edge("project", "bare", "Bare")],
			landmark_tracks: [edge("track", "anthem", "Anthem")],
		});
		await expect(resolveImage(node, { cache })).resolves.toEqual({ url: COVER(41), source: "derived-cover" });
	});

	it("is null when nothing is imaged", async () => {
		const node = genreNode("jungle", "Jungle", { landmark_projects: [edge("project", "ghost", "Ghost")] });
		await expect(resolveImage(node, { cache })).resolves.toBeNull();
	});
});

describe("resolveImage: URL gate", () => {
	it("only ever returns URLs accepted by isAllowedImageUrl", async () => {
		const f = routedFetch([caaFound(mb(50))]);
		const found = await resolveImage(projectNode("p", "P", { mbid: mb(50) }), { cache, fetch: f });
		expect(found && isAllowedImageUrl(found.url)).toBe(true);
		expect(caaUrl(mb(50))).toBe(found?.url);
	});

	it("refuses an iTunes artwork on an unlisted host", async () => {
		const f = routedFetch([
			caaMissing,
			itunesWith([
				{
					collectionName: "New Forms",
					artistName: "Roni Size",
					artworkUrl100: "https://evil.example/x/100x100bb.jpg",
				},
			]),
		]);
		const node = projectNode("new-forms", "New Forms", {
			mbid: mb(51),
			artists: [edge("artist", "roni-size", "Roni Size")],
		});
		await expect(resolveImage(node, { cache, fetch: f })).resolves.toBeNull();
	});
});
