import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { NodeCache } from "./cache.js";
import { loadGenreRedirects, resolveReadSlug } from "./genre-registry.js";
import { isValidSlug, makeSlug, normalizeSlugBody, parseSlug } from "./slug.js";
import { QID_PATTERN, type Slug } from "./types.js";

const qidSchema = z.string().regex(QID_PATTERN);
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
function isCanonicalGenreSlug(value: unknown): value is Slug {
	if (typeof value !== "string" || !isValidSlug(value)) return false;
	const { type, body } = parseSlug(value);
	if (type !== "genre") return false;
	const parts = body.split("--");
	const [name, disambiguator] = parts;
	if (name === undefined || parts.length > 2) return false;
	try {
		const canonical =
			disambiguator === undefined ? makeSlug("genre", name) : makeSlug("genre", name, disambiguator);
		return canonical === value;
	} catch {
		return false;
	}
}

const genreSlugSchema = z.custom<Slug>(isCanonicalGenreSlug, { message: "Expected a canonical genre slug" });

export const GenreFamilySchema = z.object({
	key: slugSchema,
	label: z.string().trim().min(1),
	order: z.number().int().nonnegative(),
	qid: qidSchema.optional(),
});

export const GenreTaxonomyEntrySchema = z.object({
	id: z.union([qidSchema, z.string().regex(/^local:[a-z0-9]+(?:-[a-z0-9]+)*$/)]),
	qid: qidSchema.optional(),
	name: z.string().trim().min(1),
	family: slugSchema,
	aliases: z.array(z.string().trim().min(1)).optional(),
	sourceSlugs: z.array(genreSlugSchema).optional(),
	published: z.boolean(),
});

export const GenreTaxonomySchema = z.object({
	version: z.literal(2),
	families: z.array(GenreFamilySchema),
	genres: z.array(GenreTaxonomyEntrySchema),
});

export type GenreFamily = z.infer<typeof GenreFamilySchema>;
export type GenreTaxonomyEntry = z.infer<typeof GenreTaxonomyEntrySchema>;
export type GenreTaxonomy = z.infer<typeof GenreTaxonomySchema>;

const FAMILY_QIDS = new Map([
	["avant-garde", "Q2332751"],
	["rock", "Q11399"],
	["jazz", "Q8341"],
]);

function assertUnique(values: Iterable<string>, message: string): void {
	const items = [...values];
	if (new Set(items).size !== items.length) {
		throw new Error(message);
	}
}

function assertTaxonomyInvariants(taxonomy: GenreTaxonomy): GenreTaxonomy {
	assertUnique(
		taxonomy.families.map(({ key }) => key),
		"Genre family keys must be unique",
	);
	assertUnique(
		taxonomy.families.map(({ order }) => String(order)),
		"Genre family orders must be unique",
	);
	assertUnique(
		taxonomy.genres.map(({ id }) => id),
		"Genre ids must be unique",
	);

	const familyByKey = new Map(taxonomy.families.map((family) => [family.key, family]));
	const familyQids = taxonomy.families.flatMap(({ qid }) => (qid === undefined ? [] : [qid]));
	const genreQids = taxonomy.genres.flatMap(({ qid }) => (qid === undefined ? [] : [qid]));
	const knownFamilyQids = new Set(FAMILY_QIDS.values());
	assertUnique([...familyQids, ...genreQids], "Genre and family QIDs must be unique");

	for (const family of taxonomy.families) {
		if (family.key !== normalizeSlugBody(family.label)) {
			throw new Error(`Genre family key does not match its label: ${family.key}`);
		}
		const expectedQid = FAMILY_QIDS.get(family.key);
		if (family.qid !== undefined && family.qid !== expectedQid) {
			throw new Error(`Unexpected QID for genre family ${family.key}`);
		}
	}

	const terms = new Set<string>();
	for (const genre of taxonomy.genres) {
		if (!familyByKey.has(genre.family)) {
			throw new Error(`Unknown genre family ${genre.family}`);
		}
		const expectedId = genre.qid ?? `local:${normalizeSlugBody(genre.name)}`;
		if (genre.id !== expectedId) {
			throw new Error(`Genre id does not match its QID or name: ${genre.name}`);
		}
		for (const term of [genre.name, ...(genre.aliases ?? [])]) {
			const normalizedTerm = normalizeSlugBody(term);
			if (terms.has(normalizedTerm)) {
				throw new Error(`Ambiguous genre name or alias: ${term}`);
			}
			terms.add(normalizedTerm);
		}
		if (genre.qid !== undefined && (familyQids.includes(genre.qid) || knownFamilyQids.has(genre.qid))) {
			throw new Error(`Genre QID cannot be a family parent: ${genre.qid}`);
		}
	}

	const families = [...taxonomy.families].sort((left, right) => left.order - right.order);
	const familyOrder = new Map(families.map(({ key, order }) => [key, order]));
	const genres = [...taxonomy.genres].sort((left, right) => {
		const familyDifference = (familyOrder.get(left.family) ?? 0) - (familyOrder.get(right.family) ?? 0);
		return familyDifference || left.name.localeCompare(right.name, "en", { sensitivity: "base" });
	});
	return { ...taxonomy, families, genres };
}

export function validateGenreTaxonomy(input: unknown): GenreTaxonomy {
	return assertTaxonomyInvariants(GenreTaxonomySchema.parse(input));
}

function cacheRootFor(path: string): string {
	const directory = dirname(path);
	return basename(directory) === "data" ? join(directory, "..", "cache") : join(directory, "cache");
}

async function cachedGenreQid(cache: NodeCache, source: Slug): Promise<string | undefined> {
	const node = await cache.get(source).catch(() => undefined);
	return node?.type === "genre" ? node.qid : undefined;
}

async function loadSources(taxonomy: GenreTaxonomy, path: string): Promise<GenreTaxonomy> {
	const cache = new NodeCache(cacheRootFor(path));
	const redirects = await loadGenreRedirects(join(dirname(path), "genre-redirects.json"));
	const owners = new Map<Slug, string>();
	const genres: GenreTaxonomyEntry[] = [];

	for (const genre of taxonomy.genres) {
		const explicit = new Set<Slug>();
		let sourceQid: string | undefined;
		for (const source of genre.sourceSlugs ?? []) {
			explicit.add(await resolveReadSlug(source, redirects, cache));
		}
		const qidSource = genre.qid === undefined ? undefined : await cache.findGenreSlugByQid(genre.qid);
		const canonicalQidSource =
			qidSource === undefined ? undefined : await resolveReadSlug(qidSource, redirects, cache);

		const sources = [...explicit];
		if (canonicalQidSource !== undefined) sources.push(canonicalQidSource);
		const uniqueSources = [...new Set(sources)];
		for (const source of uniqueSources) {
			if (!(await cache.has(source))) throw new Error(`Genre source slug disappeared: ${source}`);
			const cachedQid = await cachedGenreQid(cache, source);
			const expectedQid = genre.qid ?? sourceQid;
			if (cachedQid !== undefined && expectedQid !== undefined && cachedQid !== expectedQid) {
				throw new Error(`Contradictory source QID for genre ${genre.id}`);
			}
			sourceQid ??= cachedQid;
			const owner = owners.get(source);
			if (owner !== undefined && owner !== genre.id) {
				throw new Error(`Source slug ${source} is assigned to multiple genres`);
			}
			owners.set(source, genre.id);
		}
		genres.push(
			uniqueSources.length > 0 || genre.sourceSlugs !== undefined
				? { ...genre, sourceSlugs: uniqueSources }
				: genre,
		);
	}

	return { ...taxonomy, genres };
}

export async function loadGenreTaxonomy(path = "data/genre-taxonomy.json"): Promise<GenreTaxonomy> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Genre taxonomy not found: ${path}`, { cause: error });
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch (error) {
		throw new Error(`Invalid genre taxonomy JSON: ${path}`, { cause: error });
	}
	return loadSources(validateGenreTaxonomy(parsed), path);
}
