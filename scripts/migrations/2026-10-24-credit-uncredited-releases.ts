/**
 * Credit the projects and tracks left with `artists: []` (TRA-485, plan docs/plans/graph-integrity.md, part 1)
 * when MusicBrainz proves the credit. The schema lock of the second PR (`.min(1)`) needs every work to name an
 * artist; this is the half that gives one to the works for which one can be proven. Those it cannot are removed by
 * 2026-10-24-remove-uncredited-releases.ts.
 *
 * It is the release-identity backfill (2026-10-15-backfill-release-identity.ts, TRA-474) restricted to the works
 * that carry no credit, with two things it did not have when it first ran, both because the 89 works left are the
 * ones it could not settle:
 * - more evidence for "the artist to look the work up under": a credited track that names this project as its own
 *   project, and the credit of a track's own project (`creditPointers`). The artists' lists were all it read;
 * - a judged hint (2026-10-24-credit-uncredited-releases.hints.json) for a work the cache says nothing about, or
 *   several artists about (Aphex Twin and Richard D. James are one person). A hint is a question, not an answer:
 *   MusicBrainz must find the exact title, the credit must confirm the hint (by mbid when the hint has one), and
 *   the year must agree. A work that fails stays uncredited.
 *
 * What is written is the credit and nothing else (`creditOnly`): no `mbid`, so the work is still selected by the
 * identity backfill, which fills the tracklist / label this run does not fetch. The reverse edge of each new
 * credit (the artist's `discography` / `notable_tracks`) is not written here either: 2026-10-17-backfill-reverse-edges
 * does it, and the `reciprocity-missing[project.artists->artist.discography]` measure (cap 0) says when it is due.
 *
 * Dry-run by default (the manifest is written, no node is). `--resume` reuses the resolved entries of a previous
 * manifest and only those: the `--apply` after a dry-run neither searches again nor touches what it left unresolved. `--budget N` is a hard ceiling on MusicBrainz
 * requests, counted on `fetch` itself (retries included): once reached, every further call fails, and a work whose
 * lookup failed is reported as `failed` (exit 1), never as unresolved.
 *
 * Local tool, not a channel migration: it needs MusicBrainz and the repo's cache. Production receives the credited
 * nodes through the union (the repo wins a tie on `materialized_at`, which this run leaves alone).
 *
 * Usage: tsx scripts/migrations/2026-10-24-credit-uncredited-releases.ts <cache-dir> [--apply]
 *        [--manifest out/credit-uncredited-releases.json] [--resume] [--budget N] [--hints <path>]
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { isValidSlug } from "../../src/slug.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { type BackfillResult, formatSummary, runBackfill } from "./2026-10-15-backfill-release-identity.js";

export const MIGRATION_NAME = "2026-10-24-credit-uncredited-releases";
export const DEFAULT_MANIFEST_PATH = "out/credit-uncredited-releases.json";
export const HINTS_PATH = join(dirname(fileURLToPath(import.meta.url)), `${MIGRATION_NAME}.hints.json`);

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obj = Record<string, unknown>;
type CacheNode = Awaited<ReturnType<typeof readCacheNodes>>["nodes"][number];
type Pointers = Map<string, Map<string, { name: string; mbid?: string }>>;
type Hints = Map<string, { name: string; mbid?: string }>;

const hintsFileSchema = z.object({
	source: z.string(),
	hints: z.record(
		z.string().refine((s) => /^(project|track):/.test(s) && isValidSlug(s), "not a work slug"),
		z.object({
			name: z.string().min(1),
			/** The cache artist this name stands for: lends its mbid to the hint, and must exist. */
			artist: z
				.string()
				.refine((s) => s.startsWith("artist:") && isValidSlug(s))
				.optional(),
			/** Verbatim text of the work's own pitch / article / teaser that names the artist. */
			anchor: z.string().min(1),
			why: z.string().min(1),
		}),
	),
});

const edgesOf = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const textOf = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

/** The works with `artists: []`: the only ones this run looks at. */
export function uncreditedWorks(nodes: readonly CacheNode[]): Set<string> {
	return new Set(
		nodes
			.filter((n) => n.type === "project" || n.type === "track")
			.filter((n) => Array.isArray(n.node.artists) && n.node.artists.length === 0)
			.map((n) => n.slug),
	);
}

/**
 * Evidence the artists' lists do not hold, from the works' own edges: for an uncredited project, the first credit
 * of every credited track whose `project` is this one; for an uncredited track, the first credit of its project.
 * A source is an artist asserting the link from the other side, so it can only add candidates; two distinct
 * artists make the work ambiguous, as for any other pointer.
 */
export function creditPointers(nodes: readonly CacheNode[], uncredited: ReadonlySet<string>): Pointers {
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	const artistMbid = (slug: string, edge: Obj): string | undefined => {
		const own = textOf(edge.mbid) ?? textOf(bySlug.get(slug)?.node.mbid);
		return own !== undefined && MBID_RE.test(own) ? own : undefined;
	};
	const out: Pointers = new Map();
	const add = (work: string, credit: Obj | undefined) => {
		const slug = credit ? textOf(credit.slug) : undefined;
		const name = credit ? textOf(credit.name) : undefined;
		if (!credit || !slug || !name) return;
		const mbid = artistMbid(slug, credit);
		const row = out.get(work) ?? new Map();
		row.set(slug, mbid ? { name, mbid } : { name });
		out.set(work, row);
	};
	for (const n of nodes) {
		if (n.type === "track") {
			const projectSlug = textOf((n.node.project as Obj | undefined)?.slug);
			if (uncredited.has(n.slug) && projectSlug)
				add(n.slug, edgesOf(bySlug.get(projectSlug)?.node.artists)[0]);
			if (projectSlug && uncredited.has(projectSlug)) add(projectSlug, edgesOf(n.node.artists)[0]);
		}
	}
	return out;
}

/** The judged hints, each checked against the cache: an uncredited work, and a cache artist when one is named. */
export function parseHints(
	raw: unknown,
	nodes: readonly CacheNode[],
	uncredited: ReadonlySet<string>,
): { hints: Hints; errors: string[] } {
	const parsed = hintsFileSchema.safeParse(raw);
	if (!parsed.success) return { hints: new Map(), errors: [`hints file: ${parsed.error.message}`] };
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	const hints: Hints = new Map();
	const errors: string[] = [];
	for (const [slug, hint] of Object.entries(parsed.data.hints)) {
		// Idempotent: a work credited by a previous run (or removed) needs no hint any more.
		if (!uncredited.has(slug)) continue;
		// A work re-materialized as something else no longer says what the hint was judged from.
		const texts = ["editorial_pitch", "editorial_article", "editorial_teaser"].map((f) =>
			textOf(bySlug.get(slug)?.node[f]),
		);
		if (!texts.some((t) => t?.includes(hint.anchor))) {
			errors.push(`${slug}: the anchor ${JSON.stringify(hint.anchor)} is not in the work's own text`);
			continue;
		}
		let mbid: string | undefined;
		if (hint.artist !== undefined) {
			const artist = bySlug.get(hint.artist);
			if (!artist) {
				errors.push(`${slug}: hint names ${hint.artist}, which is not in the cache`);
				continue;
			}
			const stored = textOf(artist.node.mbid);
			if (stored !== undefined && MBID_RE.test(stored)) mbid = stored;
		}
		hints.set(slug, mbid ? { name: hint.name, mbid } : { name: hint.name });
	}
	return { hints, errors };
}

export interface CreditOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	resume?: boolean;
	/** The judged hints; the committed file by default. */
	hintsPath?: string;
	log?: (line: string) => void;
}

export async function runCredit(options: CreditOptions): Promise<BackfillResult & { errors: string[] }> {
	const { nodes, invalid } = await readCacheNodes(options.cacheDir);
	warnSkippedNodeFiles(invalid);
	const uncredited = uncreditedWorks(nodes);
	let rawHints: unknown = { source: "", hints: {} };
	try {
		rawHints = JSON.parse(await readFile(options.hintsPath ?? HINTS_PATH, "utf8"));
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { ...emptyResult(), exitCode: 1, errors: [`hints file unreadable: ${message}`] };
	}
	const { hints, errors } = parseHints(rawHints, nodes, uncredited);
	if (errors.length > 0) return { ...emptyResult(), exitCode: 1, errors };
	// --resume is "apply what the dry-run resolved": a work it did not resolve is neither searched again nor
	// written, so the apply costs no MusicBrainz request (the budget of the measure is the budget of the run).
	let only: ReadonlySet<string> = uncredited;
	if (options.resume) {
		const prior = JSON.parse(await readFile(options.manifestPath ?? DEFAULT_MANIFEST_PATH, "utf8")) as Obj;
		const resolved = isRecord(prior.resolved) ? prior.resolved : {};
		only = new Set([...uncredited].filter((slug) => slug in resolved));
	}
	const result = await runBackfill({
		cacheDir: options.cacheDir,
		apply: options.apply,
		manifestPath: options.manifestPath ?? DEFAULT_MANIFEST_PATH,
		resume: options.resume === true,
		only,
		hints,
		extraPointers: creditPointers(nodes, uncredited),
		creditOnly: true,
		...(options.log ? { log: options.log } : {}),
	});
	return { ...result, errors: [] };
}

function emptyResult(): BackfillResult {
	return {
		manifest: {
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			generated_at: "",
			resolved: {},
			unresolved: [],
			ambiguous: [],
			collisions: [],
		},
		written: [],
		failed: [],
		exitCode: 1,
	};
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	resume: boolean;
	manifestPath: string;
	budget?: number;
	hintsPath?: string;
}

/** `<cache-dir> [--apply] [--resume] [--manifest p] [--budget N] [--hints p]`; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let resume = false;
	const values: Record<string, string> = {};
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] as string;
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--resume" && !resume) resume = true;
		else if ((token === "--manifest" || token === "--budget" || token === "--hints") && !(token in values)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			values[token] = value;
		} else return null;
	}
	const budget = values["--budget"];
	if (budget !== undefined && !/^[1-9]\d*$/.test(budget)) return null;
	return {
		cacheDir,
		apply,
		resume,
		manifestPath: values["--manifest"] ?? DEFAULT_MANIFEST_PATH,
		...(budget !== undefined ? { budget: Number(budget) } : {}),
		...(values["--hints"] ? { hintsPath: values["--hints"] } : {}),
	};
}

/**
 * Counts every MusicBrainz request on `fetch` itself and fails the ones past `budget` (a thrown fetch is a network
 * error for mbFetch, which the resolvers report as `unavailable`). Returns the live count and the restore function.
 */
export function limitMusicBrainzRequests(budget: number): { used: () => number; restore: () => void } {
	const original = globalThis.fetch;
	let used = 0;
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (new URL(url).hostname.endsWith("musicbrainz.org")) {
			if (used >= budget) throw new Error(`MusicBrainz budget of ${budget} requests reached`);
			used += 1;
		}
		return original(input, init);
	}) as typeof fetch;
	return {
		used: () => used,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			`usage: ${MIGRATION_NAME}.ts <cache-dir> [--apply] [--resume] [--manifest <path>] [--budget N] [--hints <path>]\n`,
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const meter = limitMusicBrainzRequests(args.budget ?? Number.POSITIVE_INFINITY);
	const result = await runCredit({
		cacheDir: args.cacheDir,
		apply: args.apply,
		resume: args.resume,
		manifestPath: args.manifestPath,
		...(args.hintsPath ? { hintsPath: args.hintsPath } : {}),
		log: (line) => process.stdout.write(`${line}\n`),
	});
	meter.restore();
	for (const error of result.errors) process.stderr.write(`error: ${error}\n`);
	console.log(formatSummary(result, args.apply, args.manifestPath));
	console.log(`MusicBrainz requests: ${meter.used()}${args.budget ? ` (budget ${args.budget})` : ""}`);
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
