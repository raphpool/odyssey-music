import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type GenreTaxonomyEntry, validateGenreTaxonomy } from "./genre-taxonomy.js";
import { isValidSlug } from "./slug.js";
import { QID_PATTERN } from "./types.js";

const TAXONOMY_ID_PATTERN = /^(?:Q[1-9]\d*|local:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const EXPLICIT_SLUG_PATTERN =
	/^(?:genre|artist|project|track):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const nonEmptyText = z.string().trim().min(1);
const explicitSlug = z
	.string()
	.refine(
		(value) => isValidSlug(value) && EXPLICIT_SLUG_PATTERN.test(value),
		"Expected an explicit canonical slug",
	);
const qid = z.string().regex(QID_PATTERN, "Expected a Wikidata QID");
// Free-text hint disambiguating a seed from a same-named entity (e.g. Afrobeats the
// 2000s-2010s West African pop genre vs. Fela Kuti's Afrobeat) — TRA-254. Forwarded to the
// pipeline's search query and prompt, so it is bounded to a short phrase, not a paragraph.
const disambiguator = z.string().trim().min(1).max(120);

const genreReferenceSchema = z
	.object({
		slug: explicitSlug,
		name: nonEmptyText,
		qid: qid.optional(),
		disambiguator: disambiguator.optional(),
	})
	.strict()
	.superRefine(({ slug }, ctx) => {
		if (!slug.startsWith("genre:"))
			ctx.addIssue({ code: "custom", message: "Expected a genre slug", path: ["slug"] });
	});
const anchorSchema = genreReferenceSchema;
const targetSchema = z
	.object({
		type: z.enum(["artist", "project", "track"]),
		name: nonEmptyText,
		slug: explicitSlug,
		mbid: z.string().uuid().optional(),
		disambiguator: disambiguator.optional(),
	})
	.strict()
	.superRefine(({ type, slug }, ctx) => {
		if (!slug.startsWith(`${type}:`))
			ctx.addIssue({ code: "custom", message: "Target type and slug disagree", path: ["slug"] });
	});

export const GenreSeedSchema = z
	.object({ genre: genreReferenceSchema, targets: z.array(targetSchema), anchors: z.array(anchorSchema) })
	.strict()
	.superRefine(({ genre, targets, anchors }, ctx) => {
		const seen = new Set([genre.slug]);
		const qids = [genre.qid, ...anchors.map(({ qid }) => qid)].filter(Boolean);
		const mbids = targets.flatMap(({ mbid }) => (mbid === undefined ? [] : [mbid.toLowerCase()]));
		if (new Set(qids).size !== qids.length) ctx.addIssue({ code: "custom", message: "Duplicate seed QID" });
		if (new Set(mbids).size !== mbids.length)
			ctx.addIssue({ code: "custom", message: "Duplicate seed MBID" });
		for (const [field, entries] of [
			["targets", targets],
			["anchors", anchors],
		] as const) {
			entries.forEach((entry, index) => {
				if (seen.has(entry.slug))
					ctx.addIssue({ code: "custom", message: "Duplicate seed slug", path: [field, index, "slug"] });
				seen.add(entry.slug);
			});
		}
	});
export type GenreSeed = z.infer<typeof GenreSeedSchema>;
export type GenreSeedFolder = GenreSeed;
export type GenreTaxonomyReference = Pick<GenreTaxonomyEntry, "id" | "name" | "qid">;
export const GenreSeedsSchema = z.record(
	z.string().regex(TAXONOMY_ID_PATTERN, "Invalid taxonomy id"),
	GenreSeedSchema,
);
export type GenreSeeds = z.infer<typeof GenreSeedsSchema>;
export function validateGenreSeeds(input: unknown, taxonomy?: readonly GenreTaxonomyReference[]): GenreSeeds {
	const seeds = GenreSeedsSchema.parse(input);
	if (Object.keys(seeds).length === 0) return seeds;
	if (taxonomy === undefined) throw new Error("A taxonomy is required to validate non-empty genre seeds");

	const entries = new Map(taxonomy.map((entry) => [entry.id, entry]));
	for (const [id, seed] of Object.entries(seeds)) {
		const entry = entries.get(id);
		if (entry === undefined) throw new Error(`Unknown genre taxonomy id: ${id}`);
		const expectedQid = entry.qid ?? (QID_PATTERN.test(id) ? id : undefined);
		if (seed.genre.qid !== expectedQid) {
			throw new Error(`Genre QID is incoherent with taxonomy id: ${id}`);
		}
		if (
			id.startsWith("local:") &&
			(seed.genre.name !== entry.name || seed.genre.slug !== `genre:${id.slice(6)}`)
		) {
			throw new Error(`Genre identity is incoherent with taxonomy id: ${id}`);
		}
	}
	return seeds;
}
const DEFAULT_GENRE_SEEDS_PATH = fileURLToPath(new URL("../data/genre-seeds.json", import.meta.url));

export async function loadGenreSeeds(
	filePath: string = DEFAULT_GENRE_SEEDS_PATH,
	taxonomyPath: string = join(dirname(filePath), "genre-taxonomy.json"),
): Promise<GenreSeeds> {
	const seeds = GenreSeedsSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
	if (Object.keys(seeds).length === 0) return seeds;
	const taxonomy = validateGenreTaxonomy(JSON.parse(await readFile(taxonomyPath, "utf8")));
	return validateGenreSeeds(seeds, taxonomy.genres);
}
