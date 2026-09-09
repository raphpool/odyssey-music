import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchAllMbGenres,
	type GenreQidMap,
	joinGenreQidMap,
	type MbGenre,
	type P8052Row,
} from "../scripts/build-genre-qid-map.js";

const QID_PATTERN = /^Q[1-9]\d*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const techno: MbGenre = { id: "11111111-1111-1111-1111-111111111111", name: "techno" };
const ambient: MbGenre = { id: "22222222-2222-2222-2222-222222222222", name: "ambient" };
const asmr: MbGenre = { id: "33333333-3333-3333-3333-333333333333", name: "asmr" };

describe("joinGenreQidMap", () => {
	it("joins MB genres to their P8052 QID, splitting mapped from unmapped", () => {
		const rows: P8052Row[] = [
			{ qid: "Q170611", mbGenreId: techno.id },
			{ qid: "Q627603", mbGenreId: ambient.id },
		];

		const map = joinGenreQidMap([techno, ambient, asmr], rows, "2026-09-08T00:00:00.000Z");

		expect(map.mb_genre_count).toBe(3);
		expect(map.mapped_count).toBe(2);
		expect(map.entries).toHaveLength(2);
		expect(map.unmapped).toHaveLength(1);
		expect(map.unmapped[0]?.mb_name).toBe("asmr");
	});

	it("sorts entries and unmapped by mb_name regardless of input order", () => {
		const rows: P8052Row[] = [
			{ qid: "Q170611", mbGenreId: techno.id },
			{ qid: "Q627603", mbGenreId: ambient.id },
		];

		// Genres passed out of alphabetical order on purpose.
		const map = joinGenreQidMap([techno, asmr, ambient], rows, "2026-09-08T00:00:00.000Z");

		expect(map.entries.map((e) => e.mb_name)).toEqual(["ambient", "techno"]);
		expect(map.unmapped.map((u) => u.mb_name)).toEqual(["asmr"]);
	});

	it("ignores a P8052 row whose mbGenreId matches no known MB genre", () => {
		const rows: P8052Row[] = [
			{ qid: "Q170611", mbGenreId: techno.id },
			{ qid: "Q999999", mbGenreId: "99999999-9999-9999-9999-999999999999" },
		];

		const map = joinGenreQidMap([techno, ambient], rows, "2026-09-08T00:00:00.000Z");

		expect(map.entries).toHaveLength(1);
		expect(map.entries[0]?.mb_genre_mbid).toBe(techno.id);
		expect(map.unmapped).toHaveLength(1);
		expect(map.unmapped[0]?.mb_genre_mbid).toBe(ambient.id);
	});

	it("resolves two P8052 rows pointing at the same mbGenreId by keeping the first in QID sort order", () => {
		const rows: P8052Row[] = [
			{ qid: "Q999999", mbGenreId: techno.id },
			{ qid: "Q170611", mbGenreId: techno.id },
		];

		const map = joinGenreQidMap([techno], rows, "2026-09-08T00:00:00.000Z");

		expect(map.entries).toHaveLength(1);
		expect(map.entries[0]?.qid).toBe("Q170611");
	});

	it("handles an empty MB genre list without throwing", () => {
		expect(() => joinGenreQidMap([], [], "2026-09-08T00:00:00.000Z")).not.toThrow();
		const map = joinGenreQidMap([], [], "2026-09-08T00:00:00.000Z");
		expect(map.mb_genre_count).toBe(0);
		expect(map.mapped_count).toBe(0);
		expect(map.entries).toHaveLength(0);
		expect(map.unmapped).toHaveLength(0);
	});

	it("never lists the same mb_genre_mbid in both entries and unmapped", () => {
		const rows: P8052Row[] = [{ qid: "Q170611", mbGenreId: techno.id }];
		const map = joinGenreQidMap([techno, ambient, asmr], rows, "2026-09-08T00:00:00.000Z");

		const entryIds = new Set(map.entries.map((e) => e.mb_genre_mbid));
		const unmappedIds = map.unmapped.map((u) => u.mb_genre_mbid);
		for (const id of unmappedIds) {
			expect(entryIds.has(id)).toBe(false);
		}
	});
});

describe("fetchAllMbGenres", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("throws instead of silently writing a truncated table when MB serves a premature empty page", async () => {
		const g1: MbGenre = { id: "44444444-4444-4444-4444-444444444444", name: "a genre" };
		const g2: MbGenre = { id: "55555555-5555-5555-5555-555555555555", name: "b genre" };

		let call = 0;
		const fetchPage = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return { "genre-count": 5, genres: [g1, g2] };
			}
			// MusicBrainz claims 5 genres total (genre-count) but stops serving them after
			// page 1 — a real, observed HTTP 200 throttling behavior, not a 503.
			return { "genre-count": 5, genres: [] };
		});

		// Attach the rejection assertion before advancing timers so the promise is never
		// unhandled between the moment it rejects and the moment we await it.
		const assertion = expect(fetchAllMbGenres(fetchPage)).rejects.toThrow(/ended early/);
		await vi.runAllTimersAsync();
		await assertion;

		expect(fetchPage).toHaveBeenCalledTimes(2);
	});

	it("resolves normally when the last page's genre count matches genre-count", async () => {
		const g1: MbGenre = { id: "66666666-6666-6666-6666-666666666666", name: "a genre" };
		const g2: MbGenre = { id: "77777777-7777-7777-7777-777777777777", name: "b genre" };

		const fetchPage = vi.fn(async () => ({ "genre-count": 2, genres: [g1, g2] }));

		const result = fetchAllMbGenres(fetchPage);
		await vi.runAllTimersAsync();

		await expect(result).resolves.toEqual([g1, g2]);
	});
});

describe("data/genre-qid-map.json", () => {
	it("respects the committed table's shape invariants", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const raw = await readFile(join(here, "../data/genre-qid-map.json"), "utf8");
		const map = JSON.parse(raw) as GenreQidMap;

		expect(map.mb_genre_count).toBe(map.entries.length + map.unmapped.length);
		expect(map.mapped_count).toBe(map.entries.length);
		expect(map.mapped_count / map.mb_genre_count).toBeGreaterThanOrEqual(0.99);

		const seenMbids = new Set<string>();
		for (const entry of map.entries) {
			expect(entry.qid).toMatch(QID_PATTERN);
			expect(entry.mb_genre_mbid).toMatch(UUID_PATTERN);
			expect(seenMbids.has(entry.mb_genre_mbid)).toBe(false);
			seenMbids.add(entry.mb_genre_mbid);
		}
		for (const genre of map.unmapped) {
			expect(genre.mb_genre_mbid).toMatch(UUID_PATTERN);
			expect(seenMbids.has(genre.mb_genre_mbid)).toBe(false);
			seenMbids.add(genre.mb_genre_mbid);
		}

		const entryNames = map.entries.map((e) => e.mb_name);
		expect(entryNames).toEqual([...entryNames].sort());
		const unmappedNames = map.unmapped.map((u) => u.mb_name);
		expect(unmappedNames).toEqual([...unmappedNames].sort());
	});
});
