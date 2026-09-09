import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** How the identity was established. Reported for the coverage/curation report. */
export type GenreMatchStrategy = "mbid" | "name" | "alias" | "heuristic";

export interface GenreIdentity {
	/** Wikidata entity id, e.g. "Q170611". */
	qid: string;
	/** Canonical catalog label for that QID, e.g. "techno". */
	label: string;
	/** Canonical catalog slug body for that QID, e.g. "techno" (no "genre:" prefix). */
	slug: string;
	via: GenreMatchStrategy;
}

export interface GenreLookupInput {
	/** Free-text genre name, any casing. */
	name: string;
	/** MusicBrainz genre MBID, when the caller has one. */
	mbid?: string;
}

/** One entry of data/genre-catalog.json `genres`. */
export interface GenreCatalogEntry {
	slug: string;
	name: string;
	wikidata_qid: string;
	parents?: string[];
}

export interface GenreTables {
	catalog: readonly GenreCatalogEntry[];
	/** MusicBrainz genre MBID -> QID, from data/genre-qid-map.json. */
	mbidToQid: ReadonlyMap<string, string>;
	/** Normalized alias -> QID, from data/genre-aliases.json. */
	aliases: ReadonlyMap<string, string>;
}

export interface GenreResolver {
	resolve(input: GenreLookupInput): GenreIdentity | null;
}

const MUSIC_SUFFIX = " music";

/**
 * Normalizes a free-text genre name into a stable lookup key: NFKD-fold accents away,
 * lowercase, spell out "&" as "and", collapse everything else to single spaces.
 */
export function normalizeGenreName(raw: string): string {
	const withoutDiacritics = raw.normalize("NFKD").replace(/\p{Mn}/gu, "");
	const lowered = withoutDiacritics.toLowerCase();
	const ampersandSpelledOut = lowered.replace(/&/g, " and ");
	const alnumOnly = ampersandSpelledOut.replace(/[^a-z0-9]/g, " ");
	return alnumOnly.replace(/\s+/g, " ").trim();
}

function squash(normalized: string): string {
	return normalized.replace(/\s+/g, "");
}

function toIdentity(entry: GenreCatalogEntry, via: GenreMatchStrategy): GenreIdentity {
	return { qid: entry.wikidata_qid, label: entry.name, slug: entry.slug, via };
}

/**
 * Builds a resolver from in-memory tables, doing no I/O. Indexes are built once here,
 * not per `resolve` call, since the catalog has thousands of entries.
 *
 * On a normalized-key collision between two catalog entries, the first one encountered
 * in `tables.catalog` order wins; this is deterministic because the catalog is sorted
 * by slug.
 */
export function createGenreResolver(tables: GenreTables): GenreResolver {
	const nameIndex = new Map<string, GenreCatalogEntry>();
	const slugIndex = new Map<string, GenreCatalogEntry>();
	const squashedNameIndex = new Map<string, GenreCatalogEntry>();
	const squashedSlugIndex = new Map<string, GenreCatalogEntry>();
	const qidIndex = new Map<string, GenreCatalogEntry>();

	for (const entry of tables.catalog) {
		const normalizedName = normalizeGenreName(entry.name);
		if (!nameIndex.has(normalizedName)) nameIndex.set(normalizedName, entry);
		if (!squashedNameIndex.has(squash(normalizedName))) {
			squashedNameIndex.set(squash(normalizedName), entry);
		}

		const normalizedSlug = normalizeGenreName(entry.slug);
		if (!slugIndex.has(normalizedSlug)) slugIndex.set(normalizedSlug, entry);
		if (!squashedSlugIndex.has(squash(normalizedSlug))) {
			squashedSlugIndex.set(squash(normalizedSlug), entry);
		}

		if (!qidIndex.has(entry.wikidata_qid)) qidIndex.set(entry.wikidata_qid, entry);
	}

	function byQid(qid: string, via: GenreMatchStrategy): GenreIdentity | null {
		const entry = qidIndex.get(qid);
		return entry ? toIdentity(entry, via) : null;
	}

	function byNameOrSlug(normalized: string, via: GenreMatchStrategy): GenreIdentity | null {
		const entry = nameIndex.get(normalized) ?? slugIndex.get(normalized);
		return entry ? toIdentity(entry, via) : null;
	}

	function bySquashedNameOrSlug(squashed: string, via: GenreMatchStrategy): GenreIdentity | null {
		const entry = squashedNameIndex.get(squashed) ?? squashedSlugIndex.get(squashed);
		return entry ? toIdentity(entry, via) : null;
	}

	return {
		resolve(input: GenreLookupInput): GenreIdentity | null {
			// Step 1: a known MBID always wins, even over a name that would match elsewhere.
			// A QID found here but absent from the catalog cannot be named, so we return null
			// rather than falling through — the curated/MBID match is authoritative.
			if (input.mbid) {
				const qid = tables.mbidToQid.get(input.mbid);
				if (qid) return byQid(qid, "mbid");
			}

			const normalized = normalizeGenreName(input.name);

			// Steps 2 and 3: exact name, then exact slug.
			const exact = byNameOrSlug(normalized, "name");
			if (exact) return exact;

			// Step 4: hand-curated alias, authoritative over the heuristics below.
			const aliasQid = tables.aliases.get(normalized);
			if (aliasQid) return byQid(aliasQid, "alias");

			// Step 5: toggle the " music" suffix and replay steps 2-3.
			const suffixToggled = normalized.endsWith(MUSIC_SUFFIX)
				? normalized.slice(0, -MUSIC_SUFFIX.length).trim()
				: `${normalized}${MUSIC_SUFFIX}`;
			const bySuffix = byNameOrSlug(suffixToggled, "heuristic");
			if (bySuffix) return bySuffix;

			// Step 6: squash all whitespace and try the squashed indexes.
			const bySquashedForm = bySquashedNameOrSlug(squash(normalized), "heuristic");
			if (bySquashedForm) return bySquashedForm;

			return null;
		},
	};
}

const genreCatalogEntrySchema = z.object({
	slug: z.string(),
	name: z.string(),
	wikidata_qid: z.string(),
	parents: z.array(z.string()).optional(),
});

const genreCatalogFileSchema = z.object({
	genres: z.array(genreCatalogEntrySchema),
});

const genreQidMapFileSchema = z.object({
	entries: z.array(
		z.object({
			mb_genre_mbid: z.string(),
			qid: z.string(),
		}),
	),
});

const genreAliasesFileSchema = z.object({
	aliases: z.array(
		z.object({
			alias: z.string(),
			qid: z.string(),
			catalog_name: z.string(),
		}),
	),
});

let GENRE_RESOLVER: GenreResolver | null = null;

/** Memoized loader reading the three data files, like loadGenreCatalog does. */
export async function loadGenreResolver(): Promise<GenreResolver> {
	if (GENRE_RESOLVER) return GENRE_RESOLVER;

	const here = dirname(fileURLToPath(import.meta.url));
	const dataDir = join(here, "..", "data");

	const [catalogRaw, qidMapRaw, aliasesRaw] = await Promise.all([
		readFile(join(dataDir, "genre-catalog.json"), "utf8"),
		readFile(join(dataDir, "genre-qid-map.json"), "utf8"),
		readFile(join(dataDir, "genre-aliases.json"), "utf8"),
	]);

	const catalogFile = genreCatalogFileSchema.parse(JSON.parse(catalogRaw));
	const qidMapFile = genreQidMapFileSchema.parse(JSON.parse(qidMapRaw));
	const aliasesFile = genreAliasesFileSchema.parse(JSON.parse(aliasesRaw));

	const catalog: GenreCatalogEntry[] = catalogFile.genres.map((entry) => ({
		slug: entry.slug,
		name: entry.name,
		wikidata_qid: entry.wikidata_qid,
		...(entry.parents ? { parents: entry.parents } : {}),
	}));

	const mbidToQid = new Map<string, string>();
	for (const entry of qidMapFile.entries) mbidToQid.set(entry.mb_genre_mbid, entry.qid);

	const aliases = new Map<string, string>();
	for (const entry of aliasesFile.aliases) aliases.set(entry.alias, entry.qid);

	GENRE_RESOLVER = createGenreResolver({ catalog, mbidToQid, aliases });
	return GENRE_RESOLVER;
}
