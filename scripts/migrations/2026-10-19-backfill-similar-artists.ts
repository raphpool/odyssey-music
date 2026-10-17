/**
 * `similar_artists` backfill (TRA-490, plan docs/plans/graph-integrity.md, part 4): give every artist of the
 * cache the up-to-10 edges `resolveSimilarArtists` (TRA-468, src/similar-artists.ts) finds for it. No LLM.
 * The resolver itself is not touched.
 *
 * For each artist whose `similar_artists` is empty or absent (every artist with --force):
 *   1. `resolveSimilarArtists(artist, { cacheIndex, others })`: ListenBrainz labs when the artist has an
 *      MBID, otherwise (or when ListenBrainz gave nothing usable) the score computed over the cached artists;
 *   2. the node is written with those edges, or left as it is and listed in `none` when there are none.
 * Only `similar_artists` is ever changed, and no inverse edge is created (hence no NodeCache.write, which
 * would emit reverse edges, and no pending-reverses.json).
 *
 * ListenBrainz is an untrusted third party. The client validates the schema of every row and drops what does
 * not fit; this script adds the one check the client cannot make from where it stands. A candidate that is NOT
 * in the cache by MBID gets `makeSlug("artist", name)`; if a cached artist already holds that slug under a
 * different MBID (or none), the edge would point at a homonym, a name-only match. The candidate is dropped
 * BEFORE the client sees it (the answer is rewritten without those rows, see `guardListenBrainz`), so the node
 * still gets its 10 edges and still falls back to the graph when nothing safe is left. An edge to a cached
 * artist therefore exists only when the MBIDs agree. Safety before rate.
 *
 * Fallback is not an error. A 429 or a 5xx from ListenBrainz (a lab service with no SLA), a timeout, a network
 * error, or any answer without a usable candidate all end in the graph fallback, which the client already
 * does; the script COUNTS them: each node of `graph` and `none` carries the reason (`no-mbid`,
 * `lb-unavailable` for 429 / 408 / 5xx / network / timeout, `lb-rejected` for another non-2xx,
 * `lb-no-usable-edge` for a 2xx that yielded nothing: empty, invalid or only unsafe rows). An invalid answer is
 * never used. To replace the fallbacks by ListenBrainz once it is back: `--force --resume` (it re-resolves
 * everything except what the previous manifest put in `listenbrainz`).
 *
 * `--force` never degrades a node: when the node already has edges and this run does not get ListenBrainz's
 * (an outage, or only the graph), the existing edges stay and the slug is listed in `kept`. Same edges as
 * before: nothing is rewritten.
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation. The file written is the node as read
 * with `similar_artists` replaced (key order and every other field exactly as they were), and only if the
 * schema would not alter anything else (it strips undeclared fields); otherwise the node is listed in
 * `errors`. Idempotent: without --force a node with edges is skipped, so a re-run writes nothing.
 *
 * Pace: strictly sequential. ListenBrainz is held to 1 request per second by the client's own scheduler
 * (LISTENBRAINZ_MIN_INTERVAL_MS); this script adds no concurrency: about 580 requests, ten minutes.
 *
 * Manifest: deterministic (sorted, no timestamp, no mode, no path): the same cache and the same answers give a
 * byte-identical file in a dry-run and in an apply (the answers are the variable, see the channel below). It carries the migration channel's
 * fields as constants (`migration`, `removed: []`, `renamed: {}`, `redirects: {}`). It describes the nodes
 * this run RESOLVED (plus, with --resume, those the previous manifest decided): a node skipped because it
 * already had edges is not in it. `--resume` reads the manifest of the previous run at `--manifest`; it is
 * rewritten every CHECKPOINT_EVERY nodes so an interrupted run loses little.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it
 * passes. `--data-dir` is accepted and ignored: this migration reads and writes no redirect table.
 * The channel runs this migration with --apply in its preview AND in its apply, and replays a preview's
 * manifest (with --resume) only for the identity migrations: here each of the two runs asks ListenBrainz again
 * (about ten minutes each). With a live service the two manifests are therefore equal only if its answers are:
 * the apply's manifest is the one that describes what ships, and its `fallbacks` say how much of it is the
 * graph's. Changing that is a deploy/ change, out of this ticket's scope.
 *
 * Usage: tsx scripts/migrations/2026-10-19-backfill-similar-artists.ts <cache-dir> [--apply]
 *        [--manifest out/similar.json] [--resume] [--force] [--data-dir <dir>]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson } from "../../src/cache.js";
import { buildCacheIndex, type CacheIndex } from "../../src/cache-index.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { resolveSimilarArtists } from "../../src/similar-artists.js";
import { makeSlug, normalizeSlugBody } from "../../src/slug.js";
import type { ArtistNode, EdgeRef } from "../../src/types.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-19-backfill-similar-artists";
export const DEFAULT_MANIFEST_PATH = "out/similar.json";

/** The manifest is rewritten this often during a run, so a crash loses little. */
const CHECKPOINT_EVERY = 25;

export const FALLBACK_REASONS = ["no-mbid", "lb-unavailable", "lb-rejected", "lb-no-usable-edge"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export interface SimilarManifest {
	/** The channel's manifest contract: this migration deletes and renames nothing. */
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	counts: { listenbrainz: number; graph: number; none: number; kept: number; errors: number };
	/** Why a node did not get ListenBrainz's answer, over `graph`, `none` and `kept` together. */
	fallbacks: Record<FallbackReason, number>;
	/** ListenBrainz rows dropped as name-only matches of a cached homonym (this run, not carried by --resume). */
	unsafeCandidates: number;
	/** Nodes whose edges come from ListenBrainz. */
	listenbrainz: string[];
	/** Nodes whose edges come from the graph fallback, and why ListenBrainz did not answer for them. */
	graph: { slug: string; reason: FallbackReason }[];
	/** Nodes left without edges: neither ListenBrainz nor the graph found a safe one. */
	none: { slug: string; reason: FallbackReason }[];
	/** --force only: nodes whose existing edges were kept because this run found nothing better, and why. */
	kept: { slug: string; reason: FallbackReason }[];
	/** Nodes neither resolved nor written: an invalid file, a refused write, a resolver that threw. */
	errors: { slug: string; reason: string }[];
}

export interface BackfillOptions {
	cacheDir: string;
	apply: boolean;
	force?: boolean;
	resume?: boolean;
	manifestPath?: string;
	/** The network boundary, injected by the tests. Default: the global fetch, read at call time. */
	fetch?: typeof fetch;
	log?: (line: string) => void;
}

export interface BackfillResult {
	manifest: SimilarManifest;
	/** Node files written (always empty without --apply). */
	written: string[];
	exitCode: 0 | 1;
}

const bySlug = (a: { slug: string }, b: { slug: string }): number =>
	a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;

// --- What ListenBrainz said, as far as this script needs to know ---

type LbOutcome = "not-asked" | "ok" | "unavailable" | "rejected" | "invalid";

/** 429 (rate limit), 408 (timeout) and 5xx: the service did not answer about the artist. */
function isUnavailableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

export interface ListenBrainzGuard {
	fetch: typeof fetch;
	reset(): void;
	outcome(): LbOutcome;
	/** Rows dropped as unsafe since the guard was made. */
	dropped(): number;
}

/**
 * A `fetch` for the ListenBrainz client that (1) remembers how the last request ended, and (2) rewrites a
 * 2xx array answer without the rows whose edge would be unsafe, see the header. Anything else (a non-2xx,
 * a network error, a body that is not JSON or not an array) is handed to the client unchanged, which turns
 * it into "nothing" by itself.
 */
export function guardListenBrainz(
	base: () => typeof fetch,
	cacheIndex: CacheIndex,
	cachedArtistSlugs: ReadonlySet<string>,
): ListenBrainzGuard {
	let outcome: LbOutcome = "not-asked";
	let dropped = 0;

	// A row is safe when its MBID is the one of a cached artist (the client then uses that artist's slug), or
	// when the slug its name would get is free. A name that cannot be slugified is left to the client.
	function isSafeRow(row: unknown): boolean {
		if (!isRecord(row) || typeof row.artist_mbid !== "string" || typeof row.name !== "string") return true;
		const cached = cacheIndex.byMbid(row.artist_mbid);
		if (cached) return cached.startsWith("artist:");
		if (!normalizeSlugBody(row.name)) return true;
		return !cachedArtistSlugs.has(makeSlug("artist", row.name));
	}

	const guarded = (async (input, init) => {
		outcome = "not-asked";
		let response: Response;
		try {
			response = await base()(input, init);
		} catch (e) {
			outcome = "unavailable";
			throw e;
		}
		if (!response.ok) {
			outcome = isUnavailableStatus(response.status) ? "unavailable" : "rejected";
			return response;
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (e) {
			// The client's timeout can fire while the body is still coming: that is an outage, not a bad body.
			if (init?.signal?.aborted) {
				outcome = "unavailable";
				throw e;
			}
			outcome = "invalid";
			return new Response("null", { status: 200 });
		}
		if (!Array.isArray(body)) {
			outcome = "invalid";
			return new Response(JSON.stringify(body ?? null), { status: 200 });
		}
		outcome = "ok";
		const safe = body.filter(isSafeRow);
		dropped += body.length - safe.length;
		return new Response(JSON.stringify(safe), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	return {
		fetch: guarded,
		reset: () => {
			outcome = "not-asked";
		},
		outcome: () => outcome,
		dropped: () => dropped,
	};
}

function fallbackReason(artist: ArtistNode, outcome: LbOutcome): FallbackReason {
	if (!artist.mbid) return "no-mbid";
	if (outcome === "unavailable") return "lb-unavailable";
	if (outcome === "rejected") return "lb-rejected";
	return "lb-no-usable-edge";
}

// --- --resume ---

interface PriorManifest {
	listenbrainz: string[];
	graph: { slug: string; reason: FallbackReason }[];
}

const isFallbackReason = (v: unknown): v is FallbackReason =>
	(FALLBACK_REASONS as readonly unknown[]).includes(v);

/** The previous run's checkpoint, or null when there is none (a first run, or a file that is not ours). */
async function readPriorManifest(path: string): Promise<PriorManifest | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.migration !== MIGRATION_NAME) return null;
	const prior: PriorManifest = { listenbrainz: [], graph: [] };
	if (Array.isArray(parsed.listenbrainz)) {
		prior.listenbrainz = parsed.listenbrainz.filter((s): s is string => typeof s === "string");
	}
	if (Array.isArray(parsed.graph)) {
		for (const entry of parsed.graph) {
			if (isRecord(entry) && typeof entry.slug === "string" && isFallbackReason(entry.reason)) {
				prior.graph.push({ slug: entry.slug, reason: entry.reason });
			}
		}
	}
	return prior;
}

const edgesOf = (raw: Record<string, unknown>): unknown[] =>
	Array.isArray(raw.similar_artists) ? raw.similar_artists : [];

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
	const { cacheDir, apply } = options;
	const force = options.force ?? false;
	const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
	const log = options.log ?? (() => {});

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	// Relative to nodes/, and without the cache dir in the message: the channel's preview and apply use
	// different scratch directories, and the manifest must not depend on where the cache sits. Only artist
	// files concern this migration.
	const errors: SimilarManifest["errors"] = invalid
		.map((entry) => ({
			slug: relative(join(cacheDir, "nodes"), entry.path),
			reason: `unreadable node file: ${entry.error.split(cacheDir).join("<cache>")}`,
		}))
		.filter((entry) => entry.slug.startsWith("artist:"));

	const entries = nodes.filter((n) => n.type === "artist");
	const artists = new Map<string, ArtistNode>();
	for (const { slug, node } of entries) {
		const parsed = nodePayloadSchema.safeParse(node);
		if (parsed.success && parsed.data.type === "artist") artists.set(slug, parsed.data as ArtistNode);
	}
	const others = [...artists.values()];
	const cacheIndex = await buildCacheIndex(cacheDir);
	const guard = guardListenBrainz(
		() => options.fetch ?? fetch,
		cacheIndex,
		new Set([...entries.map((e) => e.slug), ...errors.map((e) => e.slug)]),
	);

	const prior = options.resume ? await readPriorManifest(manifestPath) : null;
	// What the previous run settled: with --force only ListenBrainz's answer is final (the fallbacks are what
	// a later run wants to replace); without it a node with edges is skipped anyway, so the graph's stay too.
	const settledLb = new Set(prior?.listenbrainz ?? []);
	const settledGraph = new Map((force ? [] : (prior?.graph ?? [])).map((g) => [g.slug, g.reason]));

	const listenbrainz: string[] = [];
	const graph: SimilarManifest["graph"] = [];
	const none: SimilarManifest["none"] = [];
	const kept: SimilarManifest["kept"] = [];
	const written: string[] = [];

	const manifest = (): SimilarManifest => {
		const fallbacks = Object.fromEntries(FALLBACK_REASONS.map((r) => [r, 0])) as Record<
			FallbackReason,
			number
		>;
		for (const { reason } of [...graph, ...none, ...kept]) fallbacks[reason]++;
		return {
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			counts: {
				listenbrainz: listenbrainz.length,
				graph: graph.length,
				none: none.length,
				kept: kept.length,
				errors: errors.length,
			},
			fallbacks,
			unsafeCandidates: guard.dropped(),
			listenbrainz: [...listenbrainz].sort(),
			graph: [...graph].sort(bySlug),
			none: [...none].sort(bySlug),
			kept: [...kept].sort(bySlug),
			errors: [...errors].sort(bySlug),
		};
	};
	const writeManifest = async (): Promise<void> => {
		await mkdir(dirname(manifestPath), { recursive: true });
		await atomicWriteJson(manifestPath, manifest());
	};

	// A settled node is skipped only if its edges are where the previous run said: on disk when this run
	// applies. A dry-run writes the same manifest as an apply, so an --apply that resumes from a dry-run's
	// manifest must write what that dry-run only decided.
	const isSettled = (slug: string, hasEdges: boolean): boolean =>
		(!apply || hasEdges) && (settledLb.has(slug) || settledGraph.has(slug));
	const pending = entries.filter((e) => {
		const hasEdges = edgesOf(e.node).length > 0;
		return (force || !hasEdges) && !isSettled(e.slug, hasEdges);
	});
	const lbCalls = pending.filter((e) => artists.get(e.slug)?.mbid).length;
	log(
		`${pending.length} artist(s) to resolve among ${entries.length}: ${lbCalls} ListenBrainz request(s) ` +
			`at about one per second (${Math.ceil(lbCalls / 60)} min)${apply ? "" : " (dry-run)"}`,
	);

	let processed = 0;
	for (const { slug, path, node: raw } of entries) {
		const artist = artists.get(slug);
		const hasEdges = edgesOf(raw).length > 0;
		if (!force && hasEdges) {
			// Settled in an earlier run (or already there): carried into the manifest if that run said so.
			const reason = settledGraph.get(slug);
			if (reason) graph.push({ slug, reason });
			else if (settledLb.has(slug)) listenbrainz.push(slug);
			continue;
		}
		if (isSettled(slug, hasEdges)) {
			const settled = settledGraph.get(slug);
			if (settled) graph.push({ slug, reason: settled });
			else listenbrainz.push(slug);
			continue;
		}
		if (!artist) {
			const refused = nodePayloadSchema.safeParse(raw);
			errors.push({
				slug,
				reason: `refusing to resolve an invalid node: ${refused.success ? "not an artist" : refused.error.message}`,
			});
			continue;
		}

		guard.reset();
		let result: Awaited<ReturnType<typeof resolveSimilarArtists>>;
		try {
			result = await resolveSimilarArtists(artist, {
				cacheIndex,
				others: () => others,
				fetch: guard.fetch,
			});
		} catch (e) {
			errors.push({ slug, reason: `resolver threw: ${e instanceof Error ? e.message : String(e)}` });
			continue;
		}
		const reason = fallbackReason(artist, guard.outcome());
		const edges: EdgeRef[] = result.edges;

		if (hasEdges && result.source !== "listenbrainz") {
			// --force: never trade existing edges for a fallback or for nothing.
			kept.push({ slug, reason });
		} else if (result.source === "none" || edges.length === 0) {
			none.push({ slug, reason });
		} else {
			const next = { ...raw, similar_artists: edges };
			const valid = nodePayloadSchema.safeParse(next);
			if (!valid.success) {
				errors.push({ slug, reason: `refusing to write an invalid node: ${valid.error.message}` });
			} else if (!onlyAddsSchemaDefaults(next, valid.data)) {
				// The schema strips undeclared fields, edges' included: only similar_artists may change.
				errors.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
			} else {
				if (result.source === "listenbrainz") listenbrainz.push(slug);
				else graph.push({ slug, reason });
				if (apply && !isDeepStrictEqual(edgesOf(raw), edges)) {
					await atomicWriteJson(path, next);
					written.push(path);
				}
			}
		}
		if (++processed % CHECKPOINT_EVERY === 0) await writeManifest();
	}

	await writeManifest();
	return { manifest: manifest(), written, exitCode: errors.length > 0 ? 1 : 0 };
}

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const lines = [
		`listenbrainz ${manifest.counts.listenbrainz}, graph ${manifest.counts.graph}, none ${manifest.counts.none}, kept ${manifest.counts.kept}, errors ${manifest.counts.errors}`,
		`fallback reasons: ${FALLBACK_REASONS.map((r) => `${r} ${manifest.fallbacks[r]}`).join(", ")}`,
		`${manifest.unsafeCandidates} unsafe ListenBrainz candidate(s) dropped`,
		apply ? `${written.length} node file(s) written` : "dry-run: no node file written",
		`manifest: ${manifestPath}`,
	];
	for (const e of manifest.errors) lines.push(`error ${e.slug}: ${e.reason}`);
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	force: boolean;
	resume: boolean;
	manifestPath: string;
}

/**
 * Parses `<cache-dir> [--apply] [--manifest <path>] [--resume] [--force] [--data-dir <dir>]`. `--data-dir`
 * is the migration channel's and is ignored. Null (the CLI exits 2) on a missing cache-dir, a repeated flag,
 * a flag without its value (or with another flag as value), or any token no flag consumes: an ambiguous
 * argument never falls through to a guess.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let resume = false;
	let force = false;
	let manifestPath: string | undefined;
	let dataDirSeen = false;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--resume" && !resume) resume = true;
		else if (token === "--force" && !force) force = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--data-dir" && !dataDirSeen)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else dataDirSeen = true;
		} else return null;
	}
	return { cacheDir, apply, force, resume, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-19-backfill-similar-artists.ts <cache-dir> [--apply] [--manifest <path>] [--resume] [--force] [--data-dir <dir>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runBackfill({
		cacheDir: args.cacheDir,
		apply: args.apply,
		force: args.force,
		resume: args.resume,
		manifestPath: args.manifestPath,
		log: (line) => process.stdout.write(`${line}\n`),
	});
	console.log(formatSummary(result, args.apply, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
