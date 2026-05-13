import { describe, expect, test } from "vitest";
import { isValidSlug, makeSlug, normalizeSlugBody, parseSlug } from "../src/slug.js";

describe("normalizeSlugBody", () => {
	test("lowercases and dashes", () => {
		expect(normalizeSlugBody("Aphex Twin")).toBe("aphex-twin");
		expect(normalizeSlugBody("aphex twin")).toBe("aphex-twin");
		expect(normalizeSlugBody("APHEX  TWIN ")).toBe("aphex-twin");
	});

	test("strips trailing parenthetical disambiguator", () => {
		expect(normalizeSlugBody("Aphex Twin (musician)")).toBe("aphex-twin");
		expect(normalizeSlugBody("Faust (band)")).toBe("faust");
	});

	test("strips trailing bracket disambiguator", () => {
		expect(normalizeSlugBody("Tendency [Remastered]")).toBe("tendency");
	});

	test("preserves middle parentheticals as plain text", () => {
		expect(normalizeSlugBody("Music (For) Films")).toBe("music-for-films");
	});

	test("expands ampersand", () => {
		expect(normalizeSlugBody("Simon & Garfunkel")).toBe("simon-and-garfunkel");
	});

	test("handles unicode accents", () => {
		// Diacritics are stripped via NFKD
		expect(normalizeSlugBody("Björk")).toBe("bjork");
		expect(normalizeSlugBody("Café Tacvba")).toBe("cafe-tacvba");
	});

	test("keeps distinct entities distinct", () => {
		expect(normalizeSlugBody("AFX")).not.toBe(normalizeSlugBody("Aphex Twin"));
		expect(normalizeSlugBody("Polygon Window")).not.toBe(normalizeSlugBody("Aphex Twin"));
	});

	test("throws on fully empty body", () => {
		expect(() => makeSlug("artist", "()")).toThrow();
		expect(() => makeSlug("artist", "   ")).toThrow();
	});
});

describe("makeSlug", () => {
	test("typed slug includes prefix", () => {
		expect(makeSlug("artist", "Aphex Twin")).toBe("artist:aphex-twin");
		expect(makeSlug("track", "Tendency")).toBe("track:tendency");
		expect(makeSlug("label", "Warp Records")).toBe("label:warp-records");
	});

	test("variants collapse to same slug", () => {
		const a = makeSlug("artist", "Aphex Twin");
		const b = makeSlug("artist", "aphex twin");
		const c = makeSlug("artist", "Aphex Twin (musician)");
		expect(a).toBe(b);
		expect(b).toBe(c);
	});
});

describe("parseSlug", () => {
	test("round-trips", () => {
		const parsed = parseSlug("artist:aphex-twin");
		expect(parsed.type).toBe("artist");
		expect(parsed.body).toBe("aphex-twin");
	});

	test("rejects malformed", () => {
		expect(() => parseSlug("no-colon")).toThrow();
		expect(() => parseSlug("foo:bar")).toThrow();
		expect(() => parseSlug("artist:")).toThrow();
	});
});

describe("isValidSlug", () => {
	test("accepts valid", () => {
		expect(isValidSlug("artist:aphex-twin")).toBe(true);
		expect(isValidSlug("track:tendency")).toBe(true);
	});
	test("rejects invalid", () => {
		expect(isValidSlug("foo:bar")).toBe(false);
		expect(isValidSlug("")).toBe(false);
	});
});
