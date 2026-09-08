/**
 * Build the MusicBrainz genre MBID → Wikidata QID join table.
 *
 * The genre identity resolver needs a join by identifier: MusicBrainz returns a genre
 * MBID, Wikidata carries the inverse link via property P8052 ("MusicBrainz genre ID"),
 * complete for the vast majority of the MB genre vocabulary (see the coverage report this
 * script prints for the current figure — it moves as both vocabularies grow). This is what
 * raises genre-identity coverage from 88% (string matcher alone) to 96.7%.
 *
 * This script produces the table and nothing else: no application code is touched, no
 * resolver consumes it yet.
 *
 * Usage: build-genre-qid-map.ts <out.json>
 */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const USER_AGENT = "odyssey-music-genre-qid-map/0.1 (https://github.com/raphpool/odyssey-music)";

const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const WIKIDATA_ENTITY_HOST = "www.wikidata.org";
const SPARQL_QUERY = "SELECT ?item ?mbid WHERE { ?item wdt:P8052 ?mbid. }";

const MB_GENRE_ALL_URL = "https://musicbrainz.org/ws/2/genre/all";
const MB_PAGE_LIMIT = 100;
// MusicBrainz asks for at most 1 req/s; wait a bit more than that between pages.
const MB_MIN_DELAY_MS = 1100;

const QID_PATTERN = /^Q[1-9]\d*$/;
const FETCH_TIMEOUT_MS = 15_000;

export interface MbGenre {
	id: string;
	name: string;
}

export interface P8052Row {
	qid: string;
	mbGenreId: string;
}

export interface GenreQidMap {
	source: string;
	generated_at: string;
	mb_genre_count: number;
	mapped_count: number;
	entries: { mb_genre_mbid: string; mb_name: string; qid: string }[];
	unmapped: { mb_genre_mbid: string; mb_name: string }[];
}

// --- HTTP: shared timeout + retry --------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a bounded timeout and a bounded retry on any transient failure: a thrown
 * network error (reset connection, DNS blip), or an HTTP 503 (both Wikidata's public SPARQL
 * endpoint and MusicBrainz throttle under load and return this). Backoff+jitter between
 * attempts, same approach as src/musicbrainz.ts's mbFetch. Capped at 3 attempts so a genuine
 * outage still fails loudly (throws) instead of hanging or retrying forever.
 */
async function fetchWithRetry(url: URL, headers: Record<string, string>, context: string): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(url, { headers, signal: ctrl.signal });
			if (res.status === 503 && attempt < 2) {
				await sleep(250 * 2 ** attempt + Math.random() * 100);
				continue;
			}
			return res;
		} catch (e) {
			lastError = e;
			if (attempt === 2) break;
			await sleep(250 * 2 ** attempt + Math.random() * 100);
		} finally {
			clearTimeout(timer);
		}
	}
	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`${context} failed after retries: ${reason}`);
}

// --- Wikidata: P8052 rows -------------------------------------------------

const wikidataResponseSchema = z.object({
	results: z.object({
		bindings: z.array(
			z.object({
				item: z.object({ value: z.string() }),
				mbid: z.object({ value: z.string() }),
			}),
		),
	}),
});

/**
 * Extract the QID from a Wikidata entity URI (e.g.
 * "http://www.wikidata.org/entity/Q170611" -> "Q170611"). Returns null for anything that
 * isn't a well-formed https/http URI on the expected Wikidata host with a Qnnn path — this
 * is third-party data (CLAUDE.md), so we validate the host explicitly rather than trusting
 * a substring match.
 */
export function extractQid(entityUri: string): string | null {
	let url: URL;
	try {
		url = new URL(entityUri);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.hostname !== WIKIDATA_ENTITY_HOST) return null;
	const match = /^\/entity\/(Q[1-9]\d*)$/.exec(url.pathname);
	if (!match) return null;
	return match[1] ?? null;
}

async function fetchP8052Rows(): Promise<P8052Row[]> {
	const url = new URL(WIKIDATA_SPARQL_URL);
	url.searchParams.set("query", SPARQL_QUERY);
	url.searchParams.set("format", "json");

	const res = await fetchWithRetry(
		url,
		{ "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
		"Wikidata SPARQL query",
	);
	if (!res.ok) {
		throw new Error(`Wikidata SPARQL query failed: ${res.status} ${res.statusText}`);
	}
	const parsed = wikidataResponseSchema.parse(await res.json());

	const rows: P8052Row[] = [];
	for (const binding of parsed.results.bindings) {
		const qid = extractQid(binding.item.value);
		if (!qid) {
			throw new Error(`Wikidata returned an unparseable ?item URI: ${binding.item.value}`);
		}
		rows.push({ qid, mbGenreId: binding.mbid.value });
	}
	return rows;
}

// --- MusicBrainz: full genre vocabulary ------------------------------------

const mbGenreAllResponseSchema = z.object({
	"genre-count": z.number(),
	genres: z.array(
		z.object({
			id: z.string().uuid(),
			name: z.string().min(1),
		}),
	),
});

async function fetchMbGenrePage(url: URL, offset: number): Promise<unknown> {
	const res = await fetchWithRetry(
		url,
		{ "User-Agent": USER_AGENT, Accept: "application/json" },
		`MusicBrainz genre page at offset ${offset}`,
	);
	if (!res.ok) {
		throw new Error(`MusicBrainz genre page at offset ${offset} failed: ${res.status} ${res.statusText}`);
	}
	return res.json();
}

async function fetchAllMbGenres(): Promise<MbGenre[]> {
	const genres: MbGenre[] = [];
	let offset = 0;
	let total = Number.POSITIVE_INFINITY;

	while (offset < total) {
		if (offset > 0) {
			await sleep(MB_MIN_DELAY_MS);
		}
		const url = new URL(MB_GENRE_ALL_URL);
		url.searchParams.set("fmt", "json");
		url.searchParams.set("limit", String(MB_PAGE_LIMIT));
		url.searchParams.set("offset", String(offset));

		const page = mbGenreAllResponseSchema.parse(await fetchMbGenrePage(url, offset));
		if (page.genres.length === 0) break;

		genres.push(...page.genres);
		total = page["genre-count"];
		offset += page.genres.length;
	}
	return genres;
}

// --- Join --------------------------------------------------------------

/**
 * Join MB genres with P8052 rows into the committed table shape. Pure and network-free
 * so it's testable without hitting Wikidata/MusicBrainz.
 */
export function joinGenreQidMap(
	mbGenres: readonly MbGenre[],
	p8052: readonly P8052Row[],
	generatedAt: string,
): GenreQidMap {
	const mbGenreById = new Map(mbGenres.map((g) => [g.id, g]));

	// A handful of MB genre MBIDs can carry more than one P8052 row on Wikidata (duplicate
	// or contested items). Sort by QID first so which row wins is deterministic and stable
	// across runs, independent of API response order.
	const sortedRows = [...p8052].sort((a, b) => (a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0));
	const qidByMbGenreId = new Map<string, string>();
	for (const row of sortedRows) {
		// A P8052 row that doesn't match a known MB genre MBID is ignored — it must not
		// create a phantom entry for a genre MusicBrainz doesn't actually have.
		if (!mbGenreById.has(row.mbGenreId)) continue;
		if (!qidByMbGenreId.has(row.mbGenreId)) {
			qidByMbGenreId.set(row.mbGenreId, row.qid);
		}
	}

	const entries: GenreQidMap["entries"] = [];
	const unmapped: GenreQidMap["unmapped"] = [];
	for (const genre of mbGenres) {
		const qid = qidByMbGenreId.get(genre.id);
		if (qid) {
			entries.push({ mb_genre_mbid: genre.id, mb_name: genre.name, qid });
		} else {
			unmapped.push({ mb_genre_mbid: genre.id, mb_name: genre.name });
		}
	}

	const byName = (a: { mb_name: string }, b: { mb_name: string }) =>
		a.mb_name < b.mb_name ? -1 : a.mb_name > b.mb_name ? 1 : 0;
	entries.sort(byName);
	unmapped.sort(byName);

	return {
		source: "wikidata:P8052 + musicbrainz:/ws/2/genre/all",
		generated_at: generatedAt,
		mb_genre_count: mbGenres.length,
		mapped_count: entries.length,
		entries,
		unmapped,
	};
}

/**
 * Find MB genre MBIDs claimed by more than one Wikidata P8052 row. `joinGenreQidMap` already
 * resolves these deterministically (lowest QID wins), but a curator has no way to spot an
 * unstable or wrong pick from the committed file alone — this surfaces the ambiguity on
 * stderr at generation time instead of leaving it silent.
 */
function findAmbiguousMbGenreIds(mbGenres: readonly MbGenre[], p8052: readonly P8052Row[]): string[] {
	const mbGenreIds = new Set(mbGenres.map((g) => g.id));
	const qidsByMbGenreId = new Map<string, Set<string>>();
	for (const row of p8052) {
		if (!mbGenreIds.has(row.mbGenreId)) continue;
		const qids = qidsByMbGenreId.get(row.mbGenreId) ?? new Set<string>();
		qids.add(row.qid);
		qidsByMbGenreId.set(row.mbGenreId, qids);
	}
	return [...qidsByMbGenreId.entries()].filter(([, qids]) => qids.size > 1).map(([mbGenreId]) => mbGenreId);
}

function formatCoverageReport(map: GenreQidMap): string {
	const pct = map.mb_genre_count === 0 ? "0.0" : ((map.mapped_count / map.mb_genre_count) * 100).toFixed(1);
	const lines = [
		"=== MB genre → Wikidata QID ===",
		`${"MusicBrainz genres:".padEnd(21)}${map.mb_genre_count}`,
		`${"Mapped via P8052:".padEnd(21)}${map.mapped_count} (${pct}%)`,
		`${"Unmapped:".padEnd(21)}${map.unmapped.length}`,
	];
	if (map.unmapped.length > 0) {
		lines.push("", "=== Unmapped MB genres ===");
		for (const genre of map.unmapped) {
			lines.push(`  ${genre.mb_name}`);
		}
	}
	return lines.join("\n");
}

async function main(): Promise<void> {
	const outFile = process.argv[2];
	if (!outFile) {
		process.stderr.write("usage: build-genre-qid-map.ts <out.json>\n");
		process.exit(2);
	}

	const [mbGenres, p8052] = await Promise.all([fetchAllMbGenres(), fetchP8052Rows()]);
	const map = joinGenreQidMap(mbGenres, p8052, new Date().toISOString());

	const ambiguous = findAmbiguousMbGenreIds(mbGenres, p8052);
	if (ambiguous.length > 0) {
		process.stderr.write(
			`warning: ${ambiguous.length} MB genre(s) had more than one P8052 QID candidate; kept the lowest QID (mbids: ${ambiguous.join(", ")})\n`,
		);
	}

	// Sanity-check the invariants the resolver will rely on before writing anything —
	// fail loudly rather than commit a partial or malformed table silently.
	for (const entry of map.entries) {
		if (!QID_PATTERN.test(entry.qid)) {
			throw new Error(`invalid QID in join output: ${entry.qid}`);
		}
	}

	await writeFile(outFile, JSON.stringify(map, null, 2));
	console.log(formatCoverageReport(map));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// Guarded like this (instead of the repo's usual unconditional `main().catch(...)`) so
	// importing this module from a test doesn't trigger network calls.
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
