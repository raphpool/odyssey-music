import { describe, expect, it } from "vitest";
import {
	executeGenreTopUp,
	type GenreTopUpRunner,
	planGenreTopUp,
	selectGenreTopUps,
	topUpGenres,
} from "../scripts/top-up-genres.js";
import type { NodeCache } from "../src/cache.js";
import type { GenreCoverageEntry, GenreCoverageReport } from "../src/genre-coverage.js";
import type { GenreSeeds } from "../src/genre-seeds.js";
import type { GenreTaxonomy } from "../src/genre-taxonomy.js";
import type { GraphProjection } from "../src/graph.js";

const taxonomy = {
	version: 2,
	families: [
		{ key: "under", label: "Under", order: 1 },
		{ key: "house-techno", label: "House / Techno", order: 2 },
	],
	genres: [
		{ id: "local:under-b", name: "Under B", family: "under", published: false },
		{ id: "local:under-a", name: "Under A", family: "under", published: true },
		...Array.from({ length: 6 }, (_unused, index) => ({
			id: `local:covered-${index + 1}`,
			name: `Covered ${index + 1}`,
			family: "house-techno",
			published: true,
		})),
		{ id: "local:acid-house", name: "Acid House", family: "house-techno", published: false },
		{ id: "local:published-gap", name: "Published Gap", family: "house-techno", published: true },
		{ id: "local:reserve", name: "Reserve", family: "house-techno", published: false },
	],
} satisfies GenreTaxonomy;
const seeds: GenreSeeds = {
	"local:acid-house": {
		genre: { slug: "genre:acid-house", name: "Acid House" },
		targets: [],
		anchors: [],
	},
};
function entry(
	deficit: number,
	publishable = false,
	missingSources: GenreCoverageEntry["missingSources"] = ["genre:missing"],
): GenreCoverageEntry {
	return {
		resolvedSources: [],
		missingSources,
		quarantinedSources: [],
		neighbourCount: Math.max(0, 3 - deficit),
		deficit,
		publishable,
	};
}
const coverage: GenreCoverageReport = {
	entries: Object.fromEntries(
		taxonomy.genres.map((genre) => {
			if (genre.id.startsWith("local:covered-")) return [genre.id, entry(0, true)];
			if (genre.id === "local:under-a" || genre.id === "local:under-b") return [genre.id, entry(3)];
			if (genre.id === "local:acid-house") return [genre.id, entry(2, false, [])];
			if (genre.id === "local:published-gap") return [genre.id, entry(1)];
			return [genre.id, entry(4, false, [])];
		}),
	),
	families: {
		under: { entries: 2, publishable: 0, deficit: 6 },
		"house-techno": { entries: 9, publishable: 6, deficit: 7 },
	},
};
const cache = null as unknown as NodeCache;
const projection = null as unknown as GraphProjection;
describe("genre top-up selection", () => {
	it("sorts family gaps first, then required choices, then reserves with a stable top-N", () => {
		const selected = selectGenreTopUps(taxonomy, coverage, seeds, { maxNew: 6 });
		expect(selected.map(({ id }) => id)).toEqual([
			"local:under-a",
			"local:under-b",
			"local:acid-house",
			"local:published-gap",
			"local:reserve",
		]);
		expect(selected[2]?.family).toBe("house-techno");
		expect(selected[2]?.priority).toBe("required");
		expect(selected[2]?.sourceSlug).toBe("genre:acid-house");
		expect(selected[4]?.sourceSlug).toBe("genre:reserve");
		expect(selectGenreTopUps(taxonomy, coverage, seeds, { maxNew: 2 })).toHaveLength(2);
	});
	it("recomputes the deficit on every planning run", async () => {
		let runs = 0;
		const measure = async (): Promise<GenreCoverageReport> => {
			runs++;
			const current = runs === 1 ? 3 : 1;
			return {
				...coverage,
				entries: { ...coverage.entries, "local:under-a": entry(current) },
			};
		};

		const first = await planGenreTopUp(taxonomy, cache, projection, seeds, { maxNew: 1 }, measure);
		const second = await planGenreTopUp(taxonomy, cache, projection, seeds, { maxNew: 1 }, measure);

		expect(runs).toBe(2);
		expect(first.coverage.entries["local:under-a"]?.deficit).toBe(3);
		expect(second.coverage.entries["local:under-a"]?.deficit).toBe(1);
	});
	it("keeps dry-run planning-only", async () => {
		const result = await topUpGenres(
			taxonomy,
			cache,
			projection,
			seeds,
			{ dryRun: true, maxNew: 1 },
			async () => coverage,
		);

		expect(result.candidates).toHaveLength(1);
	});
	it("shares one limit between top-ups and refreshes without traversing outside the selected batch", async () => {
		const selected = selectGenreTopUps(taxonomy, coverage, seeds, { maxNew: 2 });
		const calls: string[] = [];
		const runner: GenreTopUpRunner = async (candidate, remaining) => {
			calls.push(`${candidate.id}:${remaining}`);
			return { calls: 1, consumed: 1, nodesWritten: 1, refused: 0, failed: 0 };
		};

		const result = await executeGenreTopUp(selected, 1, runner);

		expect(calls).toEqual(["local:under-a:1"]);
		expect(result).toMatchObject({ calls: 1, consumed: 1, nodesWritten: 1, refused: 1, failed: 0 });
		expect(result.attempts).toEqual([
			{ candidateId: "local:under-a", status: "written" },
			{ candidateId: "local:under-b", status: "refused" },
		]);
	});
	it("reports a runner failure as a typed failed attempt", async () => {
		const selected = selectGenreTopUps(taxonomy, coverage, seeds, { maxNew: 1 });
		const runner: GenreTopUpRunner = async () => {
			throw new Error("pipeline unavailable");
		};

		const result = await executeGenreTopUp(selected, 1, runner);

		expect(result).toMatchObject({ calls: 1, consumed: 1, nodesWritten: 0, refused: 0, failed: 1 });
		expect(result.attempts).toEqual([
			{ candidateId: "local:under-a", status: "failed", error: "pipeline unavailable" },
		]);
	});
	it("makes zero calls on a second run with no remaining deficit", async () => {
		const runner = async (): Promise<never> => {
			throw new Error("must not run");
		};

		const result = await executeGenreTopUp([], 5, runner);

		expect(result).toMatchObject({ calls: 0, consumed: 0, nodesWritten: 0, refused: 0, failed: 0 });
		expect(result.attempts).toEqual([]);
	});
});
