import { describe, expect, it } from "vitest";
import { normalizeTokens, parseVideoId, scoreCandidate } from "../src/youtube.js";

describe("normalizeTokens", () => {
	it("strips accents and lowercases", () => {
		expect(normalizeTokens("Tout brûle")).toEqual(["tout", "brule"]);
	});
	it("keeps mononyms >=2 chars and drops single chars", () => {
		expect(normalizeTokens("E-40 & DJ")).toEqual(["40", "and", "dj"]);
	});
});

describe("parseVideoId", () => {
	it("extracts from watch?v=", () => {
		expect(parseVideoId("https://www.youtube.com/watch?v=mkITsrJ81bQ")).toBe("mkITsrJ81bQ");
	});
	it("returns null when none present", () => {
		expect(parseVideoId("https://wikipedia.org/x")).toBeNull();
	});
});

describe("scoreCandidate", () => {
	it("rejects when artist is known and absent from title (Booba/Corbillard regression)", () => {
		expect(scoreCandidate("Corbillard - Some Song (Official Audio)", "Tout brûle", "Booba")).toBeNull();
	});

	it("rejects when artist is known and absent from title (Daft Punk/Stanley Black regression)", () => {
		expect(
			scoreCandidate("Stanley Black & his orchestra - Around the world", "Around the World", "Daft Punk"),
		).toBeNull();
	});

	it("accepts correct match", () => {
		const s = scoreCandidate("Booba - Tout brûle (Clip Officiel)", "Tout brûle", "Booba");
		expect(s).not.toBeNull();
		expect(s as number).toBeGreaterThan(100);
	});

	it("ranks 'official' higher than a plain title for the same artist", () => {
		const a = scoreCandidate("Daft Punk - Around the World", "Around the World", "Daft Punk") ?? -1;
		const b =
			scoreCandidate("Daft Punk - Around the World (Official Video)", "Around the World", "Daft Punk") ?? -1;
		expect(b).toBeGreaterThan(a);
	});

	it("penalises covers below clean matches", () => {
		const clean = scoreCandidate("Booba - Tout brûle", "Tout brûle", "Booba") ?? 0;
		const cover = scoreCandidate("Booba - Tout brûle (Cover by Jim)", "Tout brûle", "Booba") ?? 0;
		expect(clean).toBeGreaterThan(cover);
	});

	it("rejects when no track token is present", () => {
		expect(scoreCandidate("Booba interview 2024", "Tout brûle", "Booba")).toBeNull();
	});
});
