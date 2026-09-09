import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEntityGenresMb } from "../src/musicbrainz.js";

function jsonResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as Response;
}

function failedResponse(status: number): Response {
	return {
		ok: false,
		status,
		json: async () => ({}),
	} as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchEntityGenresMb", () => {
	it("carries the MBID of each genre entry through to the returned tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000001" },
						{ name: "House", count: 8, id: "aaaaaaaa-0000-0000-0000-000000000002" },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "11111111-1111-1111-1111-111111111111");
		expect(out).toEqual([
			{ name: "techno", mbid: "aaaaaaaa-0000-0000-0000-000000000001" },
			{ name: "house", mbid: "aaaaaaaa-0000-0000-0000-000000000002" },
		]);
	});

	it("falls back to tags when genres is empty, without an mbid on any entry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [],
					tags: [
						{ name: "Deep House", count: 5 },
						{ name: "Minimal", count: 3 },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "22222222-2222-2222-2222-222222222222");
		expect(out).toEqual([{ name: "deep house" }, { name: "minimal" }]);
		expect(out.every((g) => !("mbid" in g))).toBe(true);
	});

	it("keeps a genres entry without an id, omitting mbid rather than dropping it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000003" },
						{ name: "Ambient", count: 6 },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "33333333-3333-3333-3333-333333333333");
		expect(out).toEqual([
			{ name: "techno", mbid: "aaaaaaaa-0000-0000-0000-000000000003" },
			{ name: "ambient" },
		]);
		const [, ambient] = out;
		expect(ambient && "mbid" in ambient).toBe(false);
	});

	it("dedupes by name, keeping the first occurrence's mbid in sort order", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000004" },
						{ name: "Techno", count: 10, id: "aaaaaaaa-0000-0000-0000-000000000005" },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "44444444-4444-4444-4444-444444444444");
		expect(out).toEqual([{ name: "techno", mbid: "aaaaaaaa-0000-0000-0000-000000000004" }]);
	});

	it("preserves the minCount filter and max cap on the resulting name sequence", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					genres: [
						{ name: "Techno", count: 12, id: "aaaaaaaa-0000-0000-0000-000000000006" },
						{ name: "House", count: 9, id: "aaaaaaaa-0000-0000-0000-000000000007" },
						{ name: "Electro", count: 7, id: "aaaaaaaa-0000-0000-0000-000000000008" },
						{ name: "Trance", count: 4, id: "aaaaaaaa-0000-0000-0000-000000000009" },
						{ name: "Rare Tag", count: 1, id: "aaaaaaaa-0000-0000-0000-000000000010" },
					],
				}),
			),
		);
		const out = await fetchEntityGenresMb("artist", "55555555-5555-5555-5555-555555555555", {
			minCount: 2,
			max: 3,
		});
		expect(out.map((g) => g.name)).toEqual(["techno", "house", "electro"]);
	});

	it("returns an empty array when the MB request fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => failedResponse(500)),
		);
		const out = await fetchEntityGenresMb("artist", "66666666-6666-6666-6666-666666666666");
		expect(out).toEqual([]);
	});
});
