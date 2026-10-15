import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedImageUrl } from "../../src/images/hosts.js";
import {
	commonsFileUrl,
	fetchWikidataImages,
	fetchWikidataQid,
	searchWikidataLabel,
	wikidataConfig,
} from "../../src/images/wikidata.js";
import { jsonResponse, routedFetch } from "./helpers.js";

// Distinct MBIDs per test: mbFetch memoizes by path for 5 minutes.
const mb = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const suiteInterval = wikidataConfig.minIntervalMs;
beforeEach(() => {
	wikidataConfig.minIntervalMs = 0;
});
afterEach(() => {
	wikidataConfig.minIntervalMs = suiteInterval;
	vi.useRealTimers();
});

function claim(value: unknown, rank?: "preferred" | "normal" | "deprecated") {
	return { ...(rank ? { rank } : {}), mainsnak: { snaktype: "value", datavalue: { value } } };
}

function entities(map: Record<string, Record<string, unknown[]>>) {
	return {
		entities: Object.fromEntries(Object.entries(map).map(([id, claims]) => [id, { id, claims }])),
	};
}

describe("commonsFileUrl", () => {
	it("encodes the spaces of a Commons file name and asks for 600 px by default", () => {
		expect(commonsFileUrl("Roni Size.jpg")).toBe(
			"https://commons.wikimedia.org/wiki/Special:FilePath/Roni%20Size.jpg?width=600",
		);
	});

	it("encodes diacritics, punctuation and reserved characters as one path segment", () => {
		expect(commonsFileUrl("Björk – Vespertine (2001) #1?.png", 300)).toBe(
			"https://commons.wikimedia.org/wiki/Special:FilePath/Bj%C3%B6rk%20%E2%80%93%20Vespertine%20(2001)%20%231%3F.png?width=300",
		);
		expect(commonsFileUrl("a/b.jpg")).toContain("/Special:FilePath/a%2Fb.jpg?");
	});

	it("produces a URL the image allowlist accepts in canonical form", () => {
		for (const name of ["Roni Size.jpg", "Björk.jpg", "Beyoncé's logo (2).svg", "日本語.png"]) {
			expect(isAllowedImageUrl(commonsFileUrl(name))).toBe(true);
		}
	});
});

describe("fetchWikidataQid", () => {
	const rels = (...relations: unknown[]) =>
		routedFetch([["musicbrainz.org/ws/2/", () => jsonResponse({ relations })]]);
	const wikidataRel = (resource: string, type = "wikidata") => ({ type, url: { resource } });

	it("reads the QID from the MusicBrainz url-rels of an artist", async () => {
		const f = rels(
			{ type: "streaming", url: { resource: "https://open.spotify.com/artist/x" } },
			wikidataRel("https://www.wikidata.org/wiki/Q964002"),
		);
		await expect(fetchWikidataQid("artist", mb(1), f)).resolves.toBe("Q964002");
		const url = new URL(f.calls[0] ?? "");
		expect(url.pathname).toBe(`/ws/2/artist/${mb(1)}`);
		expect(url.searchParams.get("inc")).toBe("url-rels");
	});

	it("works for labels and for the /entity/ form", async () => {
		const f = rels(wikidataRel("https://www.wikidata.org/entity/Q1312"));
		await expect(fetchWikidataQid("label", mb(2), f)).resolves.toBe("Q1312");
		expect(new URL(f.calls[0] ?? "").pathname).toBe(`/ws/2/label/${mb(2)}`);
	});

	it("ignores links that are not an https wikidata.org entity page", async () => {
		const f = rels(
			wikidataRel("https://evil.example/wiki/Q1"),
			wikidataRel("https://www.wikidata.org.evil.example/wiki/Q2"),
			wikidataRel("http://www.wikidata.org/wiki/Q3"),
			wikidataRel("https://www.wikidata.org/wiki/Q4/../../x"),
			wikidataRel("https://www.wikidata.org/wiki/Property:P18"),
			wikidataRel("https://www.wikidata.org/wiki/Q5", "official homepage"),
			{ type: "wikidata", url: { resource: 42 } },
			{ type: "wikidata" },
		);
		await expect(fetchWikidataQid("artist", mb(3), f)).resolves.toBeNull();
	});

	it("is null when MusicBrainz answers an error, garbage or throws", async () => {
		const down = routedFetch([["musicbrainz.org", () => new Response("", { status: 404 })]]);
		await expect(fetchWikidataQid("artist", mb(4), down)).resolves.toBeNull();
		const garbage = routedFetch([["musicbrainz.org", () => jsonResponse({ relations: "nope" })]]);
		await expect(fetchWikidataQid("artist", mb(5), garbage)).resolves.toBeNull();
		const boom = vi.fn(async () => {
			throw new Error("offline");
		});
		await expect(fetchWikidataQid("artist", mb(6), boom as unknown as typeof fetch)).resolves.toBeNull();
	});
});

describe("fetchWikidataImages", () => {
	it("returns the P18 file name (Roni Size)", async () => {
		const f = routedFetch([
			["wbgetentities", () => jsonResponse(entities({ Q964002: { P18: [claim("Roni Size.jpg")] } }))],
		]);
		await expect(fetchWikidataImages("Q964002", f)).resolves.toEqual({ p18: "Roni Size.jpg" });
		const url = new URL(f.calls[0] ?? "");
		expect(url.origin + url.pathname).toBe("https://www.wikidata.org/w/api.php");
		expect(url.searchParams.get("ids")).toBe("Q964002");
	});

	it("returns P154 and P18 together, preferring preferred rank and skipping deprecated claims", async () => {
		const f = routedFetch([
			[
				"wbgetentities",
				() =>
					jsonResponse(
						entities({
							Q1: {
								P18: [
									claim("Old.jpg", "deprecated"),
									claim("Normal.jpg", "normal"),
									claim("Best.jpg", "preferred"),
								],
								P154: [claim("Warp logo.svg")],
							},
						}),
					),
			],
		]);
		await expect(fetchWikidataImages("Q1", f)).resolves.toEqual({ p18: "Best.jpg", p154: "Warp logo.svg" });
	});

	it("returns an empty object for an entity without images", async () => {
		const f = routedFetch([
			["wbgetentities", () => jsonResponse(entities({ Q2: { P31: [claim({ id: "Q5" })] } }))],
		]);
		await expect(fetchWikidataImages("Q2", f)).resolves.toEqual({});
	});

	it("follows a merged QID answered under its surviving id", async () => {
		const f = routedFetch([
			["wbgetentities", () => jsonResponse(entities({ Q99: { P18: [claim("Merged.jpg")] } }))],
		]);
		await expect(fetchWikidataImages("Q98", f)).resolves.toEqual({ p18: "Merged.jpg" });
	});

	it("drops file names that are not plain Commons titles", async () => {
		const f = routedFetch([
			[
				"wbgetentities",
				() =>
					jsonResponse(
						entities({
							Q3: {
								P18: [
									claim("../../etc/passwd"),
									claim("a\\b.jpg"),
									claim("ctrl\u0007.jpg"),
									claim(""),
									claim(7),
									claim({ id: "Q1" }),
								],
								P154: [claim("x".repeat(500))],
							},
						}),
					),
			],
		]);
		await expect(fetchWikidataImages("Q3", f)).resolves.toEqual({});
	});

	it("returns {} on malformed responses, HTTP errors, network errors and bad QIDs, without throwing", async () => {
		for (const body of [{}, { entities: "x" }, { entities: { Q4: { claims: "x" } } }, [], "html", null, 3]) {
			const f = routedFetch([["wbgetentities", () => jsonResponse(body)]]);
			await expect(fetchWikidataImages("Q4", f)).resolves.toEqual({});
		}
		const err = routedFetch([["wbgetentities", () => new Response("", { status: 500 })]]);
		await expect(fetchWikidataImages("Q4", err)).resolves.toEqual({});
		const boom = vi.fn(async () => {
			throw new Error("offline");
		});
		await expect(fetchWikidataImages("Q4", boom as unknown as typeof fetch)).resolves.toEqual({});
		const none = routedFetch([]);
		await expect(fetchWikidataImages("Q4|Q5", none)).resolves.toEqual({});
		expect(none.calls).toEqual([]);
	});

	it("identifies itself with the MusicBrainz user agent", async () => {
		const f = vi.fn(async () => jsonResponse(entities({ Q5: {} })));
		await fetchWikidataImages("Q5", f as unknown as typeof fetch);
		const init = f.mock.calls[0] as unknown as [string, RequestInit];
		expect((init[1].headers as Record<string, string>)["User-Agent"]).toContain("odyssey-music");
	});

	it("spaces consecutive Wikidata requests by wikidataConfig.minIntervalMs", async () => {
		wikidataConfig.minIntervalMs = 60;
		const f = routedFetch([["wbgetentities", () => jsonResponse(entities({ Q6: {} }))]]);
		const started = Date.now();
		await fetchWikidataImages("Q6", f);
		await fetchWikidataImages("Q6", f);
		await fetchWikidataImages("Q6", f);
		expect(Date.now() - started).toBeGreaterThanOrEqual(110);
	});
});

describe("searchWikidataLabel", () => {
	const RECORD_LABEL = claim({ "entity-type": "item", id: "Q18127" });

	function wikidata(
		hits: Array<{ id: string; label: string }>,
		claims: Record<string, Record<string, unknown[]>>,
	) {
		return routedFetch([
			["wbsearchentities", () => jsonResponse({ search: hits })],
			["wbgetentities", () => jsonResponse(entities(claims))],
		]);
	}

	it("keeps the hit whose P966 equals the known MusicBrainz label id, even when it is not first", async () => {
		const f = wikidata(
			[
				{ id: "Q10", label: "Warp" },
				{ id: "Q11", label: "Warp Records" },
			],
			{
				Q10: { P31: [RECORD_LABEL], P966: [claim(mb(20))] },
				Q11: { P31: [RECORD_LABEL], P966: [claim(mb(21).toUpperCase())] },
			},
		);
		await expect(searchWikidataLabel("Warp", mb(21), f)).resolves.toBe("Q11");
	});

	it("requests the top 5 hits, and their claims in one call", async () => {
		const f = wikidata([{ id: "Q10", label: "Warp" }], { Q10: { P31: [RECORD_LABEL] } });
		await searchWikidataLabel("Warp", undefined, f);
		const search = new URL(f.calls[0] ?? "");
		expect(search.searchParams.get("action")).toBe("wbsearchentities");
		expect(search.searchParams.get("search")).toBe("Warp");
		expect(search.searchParams.get("limit")).toBe("5");
		expect(f.calls).toHaveLength(2);
	});

	it("without a known MBID, keeps a record label (P31 = Q18127) whose label is exactly the name", async () => {
		const f = wikidata(
			[
				{ id: "Q20", label: "Warp" }, // not a record label
				{ id: "Q21", label: "Warp Records" }, // not the exact label
				{ id: "Q22", label: "warp " }, // exact once case and spacing are normalized
			],
			{ Q20: { P31: [claim({ id: "Q5" })] }, Q21: { P31: [RECORD_LABEL] }, Q22: { P31: [RECORD_LABEL] } },
		);
		await expect(searchWikidataLabel("Warp", undefined, f)).resolves.toBe("Q22");
	});

	it("rejects a record label bound to a different MusicBrainz label than the known one", async () => {
		const f = wikidata([{ id: "Q30", label: "Warp" }], {
			Q30: { P31: [RECORD_LABEL], P966: [claim(mb(31))] },
		});
		await expect(searchWikidataLabel("Warp", mb(32), f)).resolves.toBeNull();
	});

	it("accepts an unbound record label when the MBID is known but P966 is missing", async () => {
		const f = wikidata([{ id: "Q40", label: "Warp" }], { Q40: { P31: [RECORD_LABEL] } });
		await expect(searchWikidataLabel("Warp", mb(41), f)).resolves.toBe("Q40");
	});

	it("is null when no hit qualifies", async () => {
		const f = wikidata([{ id: "Q50", label: "Warp" }], { Q50: { P31: [claim({ id: "Q5" })] } });
		await expect(searchWikidataLabel("Warp", undefined, f)).resolves.toBeNull();
		const empty = wikidata([], {});
		await expect(searchWikidataLabel("Warp", undefined, empty)).resolves.toBeNull();
	});

	it("is null on malformed search or entity responses, without throwing", async () => {
		for (const body of [{}, { search: "x" }, [], "html", null]) {
			const f = routedFetch([["wbsearchentities", () => jsonResponse(body)]]);
			await expect(searchWikidataLabel("Warp", undefined, f)).resolves.toBeNull();
		}
		const badEntities = routedFetch([
			[
				"wbsearchentities",
				() => jsonResponse({ search: [{ id: "Q60", label: "Warp" }, { id: "not-a-qid", label: "Warp" }, 3] }),
			],
			["wbgetentities", () => jsonResponse({ entities: 5 })],
		]);
		await expect(searchWikidataLabel("Warp", undefined, badEntities)).resolves.toBeNull();
	});

	it("does not search for an empty name", async () => {
		const f = routedFetch([]);
		await expect(searchWikidataLabel("   ", undefined, f)).resolves.toBeNull();
		expect(f.calls).toEqual([]);
	});
});
