import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadGenreTaxonomy, validateGenreTaxonomy } from "../src/genre-taxonomy.js";

const validTaxonomy = {
	version: 2,
	families: [
		{ key: "rock", label: "Rock", order: 2, qid: "Q11399" },
		{ key: "jazz", label: "Jazz", order: 3, qid: "Q8341" },
		{ key: "avant-garde", label: "Avant-Garde", order: 1, qid: "Q2332751" },
	],
	genres: [
		{ id: "local:shoegaze", name: "Shoegaze", family: "rock", sourceSlugs: ["shoegaze"], published: true },
		{
			id: "Q123",
			qid: "Q123",
			name: "Free Jazz",
			family: "jazz",
			aliases: ["Free Improvisation"],
			published: true,
		},
	],
};

describe("genre taxonomy v2", () => {
	it("loads the contract, validates ids and returns fixed ordering", async () => {
		const directory = await mkdtemp(join(tmpdir(), "genre-taxonomy-"));
		const path = join(directory, "taxonomy.json");
		await writeFile(path, JSON.stringify(validTaxonomy));

		await expect(loadGenreTaxonomy(path)).resolves.toMatchObject({
			version: 2,
			families: [{ key: "avant-garde" }, { key: "rock" }, { key: "jazz" }],
			genres: [{ name: "Shoegaze" }, { name: "Free Jazz" }],
		});
	});

	it.each([
		[
			"duplicate ids",
			{ genres: [{ ...validTaxonomy.genres[0], id: "Q123", qid: "Q123" }, validTaxonomy.genres[1]] },
		],
		["unknown family", { genres: [{ ...validTaxonomy.genres[0], family: "metal" }] }],
		[
			"duplicate family order",
			{ families: validTaxonomy.families.map((family) => ({ ...family, order: 1 })) },
		],
		[
			"ambiguous alias",
			{ genres: [{ ...validTaxonomy.genres[0], aliases: ["Free Jazz"] }, validTaxonomy.genres[1]] },
		],
		[
			"invalid source slug",
			{ genres: [{ ...validTaxonomy.genres[0], sourceSlugs: ["Shoegaze"] }, validTaxonomy.genres[1]] },
		],
		[
			"family parent used by a child",
			{
				families: validTaxonomy.families.map((family) =>
					family.key === "rock" ? { ...family, qid: undefined } : family,
				),
				genres: [{ ...validTaxonomy.genres[0], id: "Q11399", qid: "Q11399" }, validTaxonomy.genres[1]],
			},
		],
	])("rejects %s", (_, change) => {
		expect(() => validateGenreTaxonomy({ ...validTaxonomy, ...change })).toThrow();
	});

	it("requires the family QID contract and derives local ids", () => {
		expect(() =>
			validateGenreTaxonomy({
				...validTaxonomy,
				families: [{ ...validTaxonomy.families[0], qid: "Q1" }, ...validTaxonomy.families.slice(1)],
			}),
		).toThrow();
		expect(validateGenreTaxonomy(validTaxonomy).genres[1]?.id).toBe("Q123");
		expect(validateGenreTaxonomy(validTaxonomy).genres[0]?.id).toBe("local:shoegaze");
	});
});
