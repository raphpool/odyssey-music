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
