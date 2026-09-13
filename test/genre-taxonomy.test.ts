import { mkdtemp, writeFile } from "node:fs/promises";
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
		genre("local:shoegaze", "Shoegaze", "rock", { sourceSlugs: ["genre:shoegaze"] }),
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
it("loads the contract, validates ids and returns fixed ordering", async () => {
	const directory = await mkdtemp(join(tmpdir(), "genre-taxonomy-"));
	const path = join(directory, "taxonomy.json");
	await writeFile(path, JSON.stringify(validTaxonomy));

	await expect(loadGenreTaxonomy(path)).resolves.toMatchObject({
		version: 2,
		families: [{ key: "avant-garde" }, { key: "rock" }, { key: "jazz" }],
		genres: [
			{ id: "local:shoegaze", name: "Shoegaze" },
			{ id: "Q123", name: "Free Jazz" },
		],
	});
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
