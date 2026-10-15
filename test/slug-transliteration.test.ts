import { afterEach, describe, expect, test, vi } from "vitest";
import {
	hasTransliteratedLetter,
	isValidSlug,
	makeScopedSlug,
	makeSlug,
	normalizeSlugBody,
	normalizeTitleBody,
	transliteratedSlug,
} from "../src/slug.js";

// TRA-528: ø æ œ ł ß đ þ are transliterated instead of dropped, but only behind
// ODYSSEY_SCOPED_RELEASE_SLUGS (the flag TRA-509 flips with the rest of the slug-identity changes).

afterEach(() => {
	vi.unstubAllEnvs();
});

const NAMES: ReadonlyArray<[string, string]> = [
	["MØ", "mo"],
	["Æther", "aether"],
	["Łona", "lona"],
	["Straße", "strasse"],
	["Œuvre", "oeuvre"],
	["Đorđe", "dorde"],
	["Þór", "thor"],
	["STRASSE ẞ", "strasse-ss"],
	["In the Møde", "in-the-mode"],
	["ØØ Void", "oo-void"],
];

describe("flag on: transliteration", () => {
	test("makeSlug gives the ASCII spelling", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		expect(makeSlug("artist", "MØ")).toBe("artist:mo");
		expect(makeSlug("artist", "Æther")).toBe("artist:aether");
		expect(makeSlug("artist", "Łona")).toBe("artist:lona");
		expect(makeSlug("artist", "Straße")).toBe("artist:strasse");
		expect(makeSlug("project", "ØØ Void")).toBe("project:oo-void");
	});

	test("normalizeSlugBody and normalizeTitleBody agree, upper and lower case", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "1");
		for (const [name, body] of NAMES) {
			expect(normalizeSlugBody(name), name).toBe(body);
			expect(normalizeTitleBody(name), name).toBe(body);
			expect(normalizeSlugBody(name.toLowerCase()), name).toBe(body);
		}
	});

	test("the scoped slug transliterates the title and the artist", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		expect(makeScopedSlug("project", "In the Møde", "MØ")).toEqual({
			ok: true,
			slug: "project:in-the-mode--mo",
		});
		expect(makeSlug("track", "Tendency", "Łona")).toBe("track:tendency--lona");
	});

	test("every output is a canonical slug", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		for (const [name] of NAMES) {
			expect(isValidSlug(makeSlug("artist", name)), name).toBe(true);
			const scoped = makeScopedSlug("project", name, name);
			expect(scoped.ok && isValidSlug(scoped.slug), name).toBe(true);
		}
	});

	test("names without those letters are unchanged", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		expect(makeSlug("artist", "Björk")).toBe("artist:bjork");
		expect(makeSlug("artist", "Mötley Crüe")).toBe("artist:motley-crue");
		expect(makeSlug("artist", "Aphex Twin (musician)")).toBe("artist:aphex-twin");
		expect(makeSlug("artist", "坂本龍一 Ryuichi")).toBe("artist:ryuichi");
	});
});

describe("flag off (default): pre-TRA-528 output, unchanged", () => {
	test.each(["", "false", "0", "no"])("ODYSSEY_SCOPED_RELEASE_SLUGS=%j", (value) => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", value);
		expect(makeSlug("artist", "MØ")).toBe("artist:m");
		expect(makeSlug("artist", "Æther")).toBe("artist:ther");
		expect(makeSlug("artist", "Łona")).toBe("artist:ona");
		expect(makeSlug("artist", "Straße")).toBe("artist:stra-e");
		expect(makeSlug("project", "In the Møde")).toBe("project:in-the-m-de");
		expect(makeSlug("project", "ØØ Void")).toBe("project:void");
		expect(normalizeTitleBody("Łona & Webber")).toBe("ona-and-webber");
		expect(makeScopedSlug("project", "In the Møde", "MØ")).toEqual({
			ok: true,
			slug: "project:in-the-m-de--m",
		});
	});

	test("every output is a canonical slug", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
		for (const [name] of NAMES) {
			const body = normalizeSlugBody(name);
			if (body) expect(isValidSlug(`artist:${body}`), name).toBe(true);
		}
	});
});

describe("transliteratedSlug (old -> new, for the TRA-478 migration)", () => {
	// Independent of the flag: it is the table computed before the flag flips.
	test.each(["false", "true"])("flag %s: unscoped artist", (flag) => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", flag);
		expect(transliteratedSlug("artist:m", "MØ")).toEqual({ ok: true, slug: "artist:mo" });
		expect(transliteratedSlug("artist:ona", "Łona")).toEqual({ ok: true, slug: "artist:lona" });
		expect(transliteratedSlug("artist:stra-e", "Straße")).toEqual({ ok: true, slug: "artist:strasse" });
	});

	test("a work: title and scope are both rewritten", () => {
		expect(transliteratedSlug("project:in-the-m-de--m", "In the Møde", "MØ")).toEqual({
			ok: true,
			slug: "project:in-the-mode--mo",
		});
		expect(transliteratedSlug("project:void", "ØØ Void")).toEqual({ ok: true, slug: "project:oo-void" });
	});

	test("a work title keeps its trailing parenthetical (normalizeTitleBody rules)", () => {
		expect(transliteratedSlug("track:m-de-live--x", "Møde (Live)", "X")).toEqual({
			ok: true,
			slug: "track:mode-live--x",
		});
	});

	test("a slug without an affected letter comes back unchanged", () => {
		expect(transliteratedSlug("artist:bjork", "Björk")).toEqual({ ok: true, slug: "artist:bjork" });
		expect(transliteratedSlug("project:kid-a--radiohead", "Kid A", "Radiohead")).toEqual({
			ok: true,
			slug: "project:kid-a--radiohead",
		});
	});

	test("a slug that cannot be re-derived from the name is refused, not guessed", () => {
		const refused = { ok: false, reason: "not-derived-from-name" };
		expect(transliteratedSlug("artist:pole--stefan-betke", "Pôle")).toEqual(refused);
		expect(transliteratedSlug("artist:something-else", "MØ")).toEqual(refused);
		// scope present in the slug, no artist given: the scope cannot be rewritten
		expect(transliteratedSlug("project:in-the-m-de--m", "In the Møde")).toEqual(refused);
		expect(transliteratedSlug("not a slug", "MØ")).toEqual(refused);
	});

	test("results are canonical slugs", () => {
		for (const [name] of NAMES) {
			const old = makeSlug("artist", name.replace(/[ẞ]/gu, "")) as string;
			const result = transliteratedSlug(old, name.replace(/[ẞ]/gu, ""));
			if (result.ok) expect(isValidSlug(result.slug), name).toBe(true);
		}
	});
});

describe("hasTransliteratedLetter", () => {
	test("detects each letter in both cases, and ignores the rest", () => {
		for (const c of ["ø", "Ø", "æ", "Æ", "œ", "Œ", "ł", "Ł", "ß", "ẞ", "đ", "Đ", "þ", "Þ"]) {
			expect(hasTransliteratedLetter(`a${c}b`), c).toBe(true);
		}
		expect(hasTransliteratedLetter("Björk Ágatis")).toBe(false);
		expect(hasTransliteratedLetter("")).toBe(false);
	});
	test("is not stateful across calls", () => {
		expect(hasTransliteratedLetter("Ø")).toBe(true);
		expect(hasTransliteratedLetter("Ø")).toBe(true);
	});
});
