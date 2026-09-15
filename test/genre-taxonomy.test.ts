import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { loadGenreTaxonomy, validateGenreTaxonomy } from "../src/genre-taxonomy.js";

const genre = (id: string, name: string, family: string, extra: object = {}) => ({
	id,
	name,
	family,
	published: true,
	...extra,
});
const validTaxonomy = {
	version: 2,
	families: [
		{ key: "rock", label: "Rock", order: 2, qid: "Q11399" },
		{ key: "jazz", label: "Jazz", order: 3, qid: "Q8341" },
		{ key: "avant-garde", label: "Avant-Garde", order: 1, qid: "Q2332751" },
	],
	genres: [
		genre("local:shoegaze", "Shoegaze", "rock"),
		genre("Q123", "Free Jazz", "jazz", { qid: "Q123", aliases: ["Free Improvisation"] }),
	],
};
const withFirstGenre = (change: object) => ({
	genres: [{ ...validTaxonomy.genres[0], ...change }, validTaxonomy.genres[1]],
});
const withRockFamily = (change: object) => ({
	families: validTaxonomy.families.map((family) =>
		family.key === "rock" ? { ...family, ...change } : family,
	),
});

async function writeFixture(
	taxonomy: object,
	redirects: Record<string, string> = {},
	liveSlugs: string[] = [],
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "genre-taxonomy-"));
	await writeFile(join(directory, "taxonomy.json"), JSON.stringify(taxonomy));
	if (Object.keys(redirects).length) {
		await writeFile(join(directory, "genre-redirects.json"), JSON.stringify({ redirects }));
	}
	if (liveSlugs.length) {
		await mkdir(join(directory, "cache", "nodes", "genre"), { recursive: true });
		for (const slug of liveSlugs) {
			const filename = `${slug.slice("genre:".length)}.json`;
			await copyFile(
				join(process.cwd(), "cache", "nodes", "genre", filename),
				join(directory, "cache", "nodes", "genre", filename),
			);
		}
	}
	return join(directory, "taxonomy.json");
}

it("loads the contract, validates ids and returns fixed ordering", async () => {
	const path = await writeFixture(validTaxonomy);

	await expect(loadGenreTaxonomy(path)).resolves.toMatchObject({
		version: 2,
		families: [{ key: "avant-garde" }, { key: "rock" }, { key: "jazz" }],
		genres: [
			{ id: "local:shoegaze", name: "Shoegaze" },
			{ id: "Q123", name: "Free Jazz" },
		],
	});
});

it("loads the corrected TRA-98 entries at positions 262–264 and 267–270", async () => {
	const taxonomy = await loadGenreTaxonomy(join(process.cwd(), "data", "genre-taxonomy.json"));
	const corrected = [262, 263, 264, 267, 268, 269, 270].map((position) => {
		const entry = taxonomy.genres[position - 1];
		if (entry === undefined) throw new Error(`missing taxonomy entry at position ${position}`);
		return entry;
	});

	expect(corrected).toMatchObject([
		{ id: "Q9759", name: "Blues", family: "soul-rhythm-and-blues", qid: "Q9759", published: false },
		{ id: "Q546359", name: "Doo Wop", family: "soul-rhythm-and-blues", qid: "Q546359", published: false },
		{
			id: "Q1325963",
			name: "Electro-funk",
			family: "soul-rhythm-and-blues",
			qid: "Q1325963",
			published: false,
		},
		{ id: "Q577080", name: "P Funk", family: "soul-rhythm-and-blues", qid: "Q577080", published: false },
		{
			id: "Q2743435",
			name: "Psychedelic Soul",
			family: "soul-rhythm-and-blues",
			qid: "Q2743435",
			published: false,
		},
		{ id: "local:rare-groove", name: "Rare Groove", family: "soul-rhythm-and-blues", published: false },
		{
			id: "Q45981",
			name: "Rhythm & Blues",
			family: "soul-rhythm-and-blues",
			qid: "Q45981",
			published: false,
		},
	]);
	expect(corrected.map((entry) => Object.hasOwn(entry, "qid"))).toEqual([
		true,
		true,
		true,
		true,
		true,
		false,
		true,
	]);
	expect(corrected.map((entry) => Object.hasOwn(entry, "sourceSlugs"))).toEqual([
		true,
		false,
		true,
		false,
		false,
		false,
		true,
	]);
	expect(corrected.filter((entry) => "sourceSlugs" in entry).map((entry) => entry.sourceSlugs)).toEqual([
		["genre:blues"],
		["genre:electro-funk"],
		["genre:r-and-b"],
	]);
	expect(corrected.map((entry) => Object.hasOwn(entry, "aliases"))).toEqual([
		false,
		false,
		false,
		false,
		false,
		false,
		true,
	]);
	expect(corrected.at(-1)?.aliases).toEqual(["R&B"]);
});

// Delivery-note guard (TRA-227): typecheck/lint/test/diff-size/tier-guard all pass on a batch
// that silently drops or duplicates one entry (skipped line, dedup swallowed) — nothing else in
// the pipeline counts the real file. This constant and check live in the test file on purpose:
// src/genre-taxonomy.ts is a loader, not a delivery-tracking concern.
//
// Next batch: bump this value in the same commit as the imported entries, e.g. 351-360 -> 360,
// 361-370 -> 370, ... down to the final batch 561-568 (only 8 entries) -> 568.
const EXPECTED_TAXONOMY_SIZE = 568;

function assertExpectedTaxonomySize(genres: readonly unknown[], expected: number): void {
	if (genres.length !== expected) {
		throw new Error(
			`Taxonomy has ${genres.length} entries, expected ${expected}. If this batch's entries are ` +
				"correct, update EXPECTED_TAXONOMY_SIZE in the same commit as the import.",
		);
	}
}

it("locks the real taxonomy file to EXPECTED_TAXONOMY_SIZE entries", async () => {
	const taxonomy = await loadGenreTaxonomy(join(process.cwd(), "data", "genre-taxonomy.json"));
	assertExpectedTaxonomySize(taxonomy.genres, EXPECTED_TAXONOMY_SIZE);
});

it("fails with an actionable message when the entry count drifts either way", async () => {
	const taxonomy = await loadGenreTaxonomy(join(process.cwd(), "data", "genre-taxonomy.json"));

	// Mutate the already-loaded array in memory only — data/genre-taxonomy.json is never touched,
	// on disk or otherwise, by this test.
	const oneShort = taxonomy.genres.slice(1);
	const oneOver = [...taxonomy.genres, taxonomy.genres[0]];

	// Numbers are derived from the real file's current length, not hardcoded, so this keeps
	// passing after a future batch bumps EXPECTED_TAXONOMY_SIZE and the file grows with it.
	expect(() => assertExpectedTaxonomySize(oneShort, EXPECTED_TAXONOMY_SIZE)).toThrow(
		`Taxonomy has ${oneShort.length} entries, expected ${EXPECTED_TAXONOMY_SIZE}. If this batch's ` +
			"entries are correct, update EXPECTED_TAXONOMY_SIZE in the same commit as the import.",
	);
	expect(() => assertExpectedTaxonomySize(oneOver, EXPECTED_TAXONOMY_SIZE)).toThrow(
		`Taxonomy has ${oneOver.length} entries, expected ${EXPECTED_TAXONOMY_SIZE}. If this batch's ` +
			"entries are correct, update EXPECTED_TAXONOMY_SIZE in the same commit as the import.",
	);
});

it("loads the Berlin, French rap and Drill and Bass source fixture idempotently", async () => {
	const taxonomy = {
		...validTaxonomy,
		genres: [
			genre("Q530750", "Berlin School", "rock", {
				qid: "Q530750",
				sourceSlugs: ["genre:berlin-school"],
			}),
			genre("Q138020", "Rap français", "rock", {
				qid: "Q138020",
				sourceSlugs: ["genre:rap-francais", "genre:french-hip-hop", "genre:hip-hop-francais"],
			}),
			genre("Q1259016", "Drill and Bass", "jazz", {
				qid: "Q1259016",
				sourceSlugs: ["genre:drill-and-bass", "genre:drill-n-bass"],
			}),
		],
	};
	const path = await writeFixture(
		taxonomy,
		{
			"genre:berlin-school-of-electronic-music": "genre:berlin-school",
			"genre:french-hip-hop": "genre:rap-francais",
			"genre:hip-hop-francais": "genre:rap-francais",
			"genre:drill-n-bass": "genre:drill-and-bass",
		},
		[
			"genre:berlin-school",
			"genre:berlin-school-of-electronic-music",
			"genre:rap-francais",
			"genre:drill-and-bass",
		],
	);

	const first = await loadGenreTaxonomy(path);
	await expect(loadGenreTaxonomy(path)).resolves.toEqual(first);
	expect(first.genres.map(({ sourceSlugs }) => sourceSlugs)).toEqual([
		["genre:berlin-school", "genre:berlin-school-of-electronic-music"],
		["genre:rap-francais"],
		["genre:drill-and-bass"],
	]);
});

it("rejects contradictory source QIDs", async () => {
	const conflictingPath = await writeFixture(
		{
			...validTaxonomy,
			genres: [
				genre("local:conflicting", "Conflicting", "rock", {
					sourceSlugs: ["genre:berlin-school-of-electronic-music", "genre:french-hip-hop"],
				}),
			],
		},
		{},
		["genre:berlin-school-of-electronic-music", "genre:french-hip-hop"],
	);
	await expect(loadGenreTaxonomy(conflictingPath)).rejects.toThrow(/contradictory source qid/i);
});

it("rejects a disappeared source with an explicit diagnostic", async () => {
	const path = await writeFixture({
		...validTaxonomy,
		genres: [genre("local:missing", "Missing", "rock", { sourceSlugs: ["genre:missing"] })],
	});

	await expect(loadGenreTaxonomy(path)).rejects.toThrow(/source slug.*missing/i);
});

it("rejects two entries assigned the same canonical source", async () => {
	const path = await writeFixture(
		{
			...validTaxonomy,
			genres: [
				genre("local:first", "First", "rock", { sourceSlugs: ["genre:first"] }),
				genre("local:second", "Second", "jazz", { sourceSlugs: ["genre:second"] }),
			],
		},
		{
			"genre:first": "genre:drill-and-bass",
			"genre:second": "genre:drill-and-bass",
		},
		["genre:drill-and-bass"],
	);

	await expect(loadGenreTaxonomy(path)).rejects.toThrow(/assigned to multiple/i);
});

it("reports missing files and invalid JSON explicitly", async () => {
	const directory = await mkdtemp(join(tmpdir(), "genre-taxonomy-"));
	await expect(loadGenreTaxonomy(join(directory, "missing.json"))).rejects.toThrow(/not found/i);
	await writeFile(join(directory, "invalid.json"), "{not-json");
	await expect(loadGenreTaxonomy(join(directory, "invalid.json"))).rejects.toThrow(/invalid.*JSON/i);
});

it.each([
	["duplicate ids", withFirstGenre({ id: "Q123", qid: "Q123" })],
	["unknown family", withFirstGenre({ family: "metal" })],
	["duplicate family order", { families: validTaxonomy.families.map((family) => ({ ...family, order: 1 })) }],
	["ambiguous alias", withFirstGenre({ aliases: ["Free Jazz"] })],
	["invalid source slug", withFirstGenre({ sourceSlugs: ["shoegaze"] })],
	["source slug traversal", withFirstGenre({ sourceSlugs: ["genre:../../pending-reverses"] })],
	["invalid QID", withFirstGenre({ id: "Q0", qid: "Q0" })],
	["family key does not match label", withRockFamily({ label: "Alternative Rock" })],
	["invalid family QID", withRockFamily({ qid: "Q1" })],
	[
		"family parent used by a child",
		{ ...withRockFamily({ qid: undefined }), ...withFirstGenre({ id: "Q11399", qid: "Q11399" }) },
	],
])("rejects %s", (_, change) => {
	expect(() => validateGenreTaxonomy({ ...validTaxonomy, ...change })).toThrow();
});
