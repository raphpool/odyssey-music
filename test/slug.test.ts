import { describe, expect, test } from "vitest";
import {
	isScopedSlug,
	isValidSlug,
	makeScopedSlug,
	makeSlug,
	normalizeSlugBody,
	parseSlug,
	scopeOf,
} from "../src/slug.js";

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

describe("makeScopedSlug", () => {
	test("builds <type>:<title>--<artist>", () => {
		expect(makeScopedSlug("track", "Fitna", "Rohff")).toBe("track:fitna--rohff");
		expect(makeScopedSlug("project", "New Forms", "Roni Size / Reprazent")).toBe(
			"project:new-forms--roni-size-reprazent",
		);
	});

	test("strips diacritics from both title and artist", () => {
		expect(makeScopedSlug("track", "Corazón Loco", "Lisa Carbon")).toBe("track:corazon-loco--lisa-carbon");
		expect(makeScopedSlug("project", "Dépêche", "Mylène Farmer")).toBe("project:depeche--mylene-farmer");
	});

	test("turns & into and in both parts", () => {
		expect(makeScopedSlug("project", "Rock & Roll", "Simon & Garfunkel")).toBe(
			"project:rock-and-roll--simon-and-garfunkel",
		);
	});

	test("agrees with makeSlug's disambiguator form", () => {
		expect(makeScopedSlug("track", "Tendency", "Jan Jelinek")).toBe(
			makeSlug("track", "Tendency", "Jan Jelinek"),
		);
	});

	test("throws when the artist body is empty", () => {
		expect(() => makeScopedSlug("track", "Fitna", "")).toThrow();
		expect(() => makeScopedSlug("track", "Fitna", "  ?! ")).toThrow();
	});

	test("throws when the title body is empty", () => {
		expect(() => makeScopedSlug("project", "", "Rohff")).toThrow();
		expect(() => makeScopedSlug("project", "...", "Rohff")).toThrow();
	});
});

describe("isScopedSlug / scopeOf", () => {
	test("recognizes a scoped slug and returns its scope", () => {
		expect(isScopedSlug("track:fitna--rohff")).toBe(true);
		expect(scopeOf("track:fitna--rohff")).toBe("rohff");
	});

	test("an unscoped slug has no scope", () => {
		expect(isScopedSlug("track:fitna")).toBe(false);
		expect(scopeOf("track:fitna")).toBeNull();
		expect(isScopedSlug("artist:aphex-twin")).toBe(false);
	});

	test("a hyphenated body is not scoped (single dash is not the separator)", () => {
		expect(isScopedSlug("artist:jay-z")).toBe(false);
		expect(scopeOf("artist:jay-z")).toBeNull();
	});

	test("round-trips with makeScopedSlug", () => {
		const slug = makeScopedSlug("project", "New Forms", "Roni Size / Reprazent");
		expect(scopeOf(slug)).toBe("roni-size-reprazent");
	});
});
