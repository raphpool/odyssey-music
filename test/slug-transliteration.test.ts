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

// TRA-528: ø æ œ ł ß đ þ (and, from TRA-531, ð ı) are transliterated instead of dropped, but only behind
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
	["Ðorđe", "dorde"],
	["Guðnadóttir", "gudnadottir"],
	["Kırdar", "kirdar"],
	["KIRDAR", "kirdar"],
	["İstanbul", "istanbul"],
	["Yalnızlık", "yalnizlik"],
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

	// TRA-531: the two names that sent the cache through "gu-nadottir" / "k-rdar".
	test("ð and ı (TRA-531)", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		expect(makeSlug("artist", "Hildur Guðnadóttir")).toBe("artist:hildur-gudnadottir");
		expect(makeSlug("artist", "Gökhan Kırdar")).toBe("artist:gokhan-kirdar");
		expect(makeSlug("project", "Yalnızlık")).toBe("project:yalnizlik");
		expect(normalizeTitleBody("Yalnızlık")).toBe("yalnizlik");
		expect(makeScopedSlug("project", "Yalnızlık", "Gökhan Kırdar")).toEqual({
			ok: true,
			slug: "project:yalnizlik--gokhan-kirdar",
		});
	});

	// Dotted capital I is decomposed by NFKD (I + U+0307), a plain I lowercases to i: neither needs an
	// entry in the table, and they must land on the same body as the dotless spelling.
	test("I, İ and ı all give i", () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		const bodies = ["Istanbul", "İstanbul", "ıstanbul", "ISTANBUL", "İSTANBUL"].map(normalizeSlugBody);
		expect(new Set(bodies)).toEqual(new Set(["istanbul"]));
		expect("İ".normalize("NFKD")).toBe("I\u0307");
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
		expect(normalizeSlugBody("İstanbul")).toBe("istanbul");
		expect(normalizeSlugBody("Istanbul")).toBe("istanbul");
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
		// TRA-531: still dropped with the flag off (identity does not move before TRA-509)
		expect(makeSlug("artist", "Hildur Guðnadóttir")).toBe("artist:hildur-gu-nadottir");
		expect(makeSlug("artist", "Gökhan Kırdar")).toBe("artist:gokhan-k-rdar");
		expect(normalizeTitleBody("Yalnızlık")).toBe("yaln-zl-k");
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
		// TRA-531
		expect(transliteratedSlug("artist:hildur-gu-nadottir", "Hildur Guðnadóttir")).toEqual({
			ok: true,
			slug: "artist:hildur-gudnadottir",
		});
		expect(transliteratedSlug("artist:gokhan-k-rdar", "Gökhan Kırdar")).toEqual({
			ok: true,
			slug: "artist:gokhan-kirdar",
		});
	});

	test("a work by an ı / ð artist: title and scope are both rewritten (TRA-531)", () => {
		expect(transliteratedSlug("project:yaln-zl-k--gokhan-k-rdar", "Yalnızlık", "Gökhan Kırdar")).toEqual({
			ok: true,
			slug: "project:yalnizlik--gokhan-kirdar",
		});
		expect(transliteratedSlug("project:yaln-zl-k", "Yalnızlık")).toEqual({
			ok: true,
			slug: "project:yalnizlik",
		});
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

	// Deep review nit 1: an unscoped work slug may come from normalizeTitleBody (keeps "(ø)") or from
	// normalizeSlugBody (drops it); once transliterated they differ, so the answer must not be a guess.
	test("an unscoped work whose trailing group holds a table letter is refused", () => {
		const refused = { ok: false, reason: "not-derived-from-name" };
		expect(transliteratedSlug("track:foo", "Foo (ø)")).toEqual(refused);
		expect(transliteratedSlug("track:m", "Mø (Æ)")).toEqual(refused);
		expect(transliteratedSlug("track:foo", "Foo (ð)")).toEqual(refused);
		expect(transliteratedSlug("track:foo", "Foo (ı)")).toEqual(refused);
		// a slug that is neither the old nor the new form of the name
		expect(transliteratedSlug("artist:hildur-gu", "Hildur Guðnadóttir")).toEqual(refused);
		// artists have a single flattener: the trailing group is dropped, as makeSlug does
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		expect(transliteratedSlug("artist:foo", "Foo (ø)")).toEqual({
			ok: true,
			slug: makeSlug("artist", "Foo (ø)"),
		});
	});
});

describe("transliteratedSlug stays aligned with what the pipeline mints", () => {
	test("idempotent: a slug already in its new form comes back unchanged", () => {
		expect(transliteratedSlug("artist:mo", "MØ")).toEqual({ ok: true, slug: "artist:mo" });
		expect(transliteratedSlug("artist:hildur-gudnadottir", "Hildur Guðnadóttir")).toEqual({
			ok: true,
			slug: "artist:hildur-gudnadottir",
		});
		expect(transliteratedSlug("artist:gokhan-kirdar", "Gökhan Kırdar")).toEqual({
			ok: true,
			slug: "artist:gokhan-kirdar",
		});
		expect(transliteratedSlug("project:in-the-mode--mo", "In the Møde", "MØ")).toEqual({
			ok: true,
			slug: "project:in-the-mode--mo",
		});
	});

	// Drift guard: the migration table must give the slugs makeSlug / makeScopedSlug mint with the flag on.
	test("equals makeSlug / makeScopedSlug with the flag on, then off", () => {
		const cases: Array<[string, string]> = NAMES.filter(([n]) => !n.includes("ẞ"));
		const old: Array<{ slug: string; name: string; artist: string }> = [];
		for (const [name] of cases) {
			vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
			const scoped = makeScopedSlug("project", name, "Łona");
			if (!scoped.ok) throw new Error(name);
			old.push({ slug: scoped.slug, name, artist: "Łona" });
			old.push({ slug: makeSlug("artist", name), name, artist: "" });
		}
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		for (const { slug, name, artist } of old) {
			const result = slug.startsWith("project:")
				? transliteratedSlug(slug, name, artist)
				: transliteratedSlug(slug, name);
			const expected = slug.startsWith("project:")
				? makeScopedSlug("project", name, artist)
				: { ok: true as const, slug: makeSlug("artist", name) };
			expect(result, slug).toEqual(expected);
		}
	});
});

describe("hasTransliteratedLetter", () => {
	test("detects each letter in both cases, and ignores the rest", () => {
		for (const c of ["ø", "Ø", "æ", "Æ", "œ", "Œ", "ł", "Ł", "ß", "ẞ", "đ", "Đ", "ð", "Ð", "ı", "þ", "Þ"]) {
			expect(hasTransliteratedLetter(`a${c}b`), c).toBe(true);
		}
		expect(hasTransliteratedLetter("Björk Ágatis")).toBe(false);
		// I and İ are plain i after NFKD: not table letters
		expect(hasTransliteratedLetter("Istanbul İstanbul")).toBe(false);
		expect(hasTransliteratedLetter("")).toBe(false);
	});
});
