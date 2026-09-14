import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGenreSeeds, validateGenreSeeds } from "../src/genre-seeds.js";

const taxonomy = [
	{ id: "Q11399", qid: "Q11399", name: "Rock" },
	{ id: "Q2913982", qid: "Q2913982", name: "Trap Hip-Hop" },
];
const target = {
	type: "track",
	name: "Tendency",
	slug: "track:tendency--jan-jelinek",
	mbid: "550e8400-e29b-41d4-a716-446655440000",
} as const;
const folder = {
	genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" },
	targets: [target],
	anchors: [{ slug: "genre:jazz", name: "Jazz", qid: "Q8341" }],
};
describe("genre seeds", () => {
	it("loads the real seed registry", async () => {
		expect(await loadGenreSeeds()).toBeTypeOf("object");
	});

	it("loads an explicitly empty seed registry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "odyssey-genre-seeds-"));
		try {
			const filePath = join(directory, "genre-seeds.json");
			await writeFile(filePath, "{}");
			await expect(loadGenreSeeds(filePath)).resolves.toEqual({});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("validates taxonomy membership, coherent QIDs, and explicit slugs", () => {
		expect(validateGenreSeeds({ Q2913982: folder }, taxonomy)).toEqual({ Q2913982: folder });
		expect(() => validateGenreSeeds({ Q999999: folder }, taxonomy)).toThrow(/Unknown/);
		expect(() =>
			validateGenreSeeds({ Q2913982: { ...folder, genre: { ...folder.genre, qid: "Q1" } } }, taxonomy),
		).toThrow(/incoherent/);
		expect(() =>
			validateGenreSeeds(
				{ "local:rap": { genre: { slug: "genre:jazz", name: "Jazz" }, targets: [], anchors: [] } },
				[{ id: "local:rap", name: "Rap" }],
			),
		).toThrow(/identity/);
	});

	it.each([
		["duplicate targets", { Q2913982: { ...folder, targets: [target, target] } }],
		[
			"mistyped target",
			{ Q2913982: { ...folder, targets: [{ ...target, type: "artist", slug: "track:wrong" }] } },
		],
		["bad MBID", { Q2913982: { ...folder, targets: [{ ...target, mbid: "not-a-uuid" }] } }],
		[
			"duplicate stable MBID",
			{
				Q2913982: {
					...folder,
					targets: [target, { ...target, slug: "track:other", mbid: target.mbid.toUpperCase() }],
				},
			},
		],
		[
			"duplicate stable QID",
			{
				Q2913982: {
					...folder,
					anchors: [folder.anchors[0], { ...folder.anchors[0], slug: "genre:free-jazz" }],
				},
			},
		],
		["duplicate folder genre", { Q2913982: { ...folder, anchors: [folder.genre] } }],
		["arbitrary taxonomy path", { "genre:../../secret": folder }],
		[
			"path traversal",
			{ Q2913982: { ...folder, anchors: [{ slug: "genre:../../secret", name: "Secret" }] } },
		],
	])("rejects %s", (_label, input) => expect(() => validateGenreSeeds(input, taxonomy)).toThrow());
	it("requires taxonomy for non-empty seeds", () => {
		expect(() => validateGenreSeeds({ Q2913982: folder })).toThrow(/taxonomy/);
	});

	it("validates taxonomy invariants before loading non-empty seeds", async () => {
		const directory = await mkdtemp(join(tmpdir(), "odyssey-genre-seeds-"));
		const filePath = join(directory, "genre-seeds.json");
		await writeFile(
			filePath,
			JSON.stringify({ Q1: { genre: { slug: "genre:x", name: "X", qid: "Q2" }, targets: [], anchors: [] } }),
		);
		await writeFile(
			join(directory, "genre-taxonomy.json"),
			JSON.stringify({
				version: 2,
				families: [{ key: "rock", label: "Rock", order: 1 }],
				genres: [{ id: "Q1", qid: "Q2", name: "X", family: "rock", published: true }],
			}),
		);
		await expect(loadGenreSeeds(filePath)).rejects.toThrow(/does not match/);
		await rm(directory, { recursive: true, force: true });
	});
});
