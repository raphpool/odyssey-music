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
 * not fit; this script adds the checks the client cannot make from where it stands. A candidate that is NOT
 * in the cache by MBID gets a slug minted from its name; if that slug is held by a cached artist under a
 * different MBID (or none), or is a KEY of the redirect tables (the reads then open the artist it redirects
 * to, a homonym), the edge would point at somebody else, a name-only match. The candidate is dropped BEFORE
 * the client sees it (the answer is rewritten without those rows, see `guardListenBrainz`), so the node
 * still gets its 10 edges and still falls back to the graph when nothing safe is left. An edge to a cached
 * artist therefore exists only when the MBIDs agree. Safety before rate.
 *
 * CANONICAL SLUGS (2026-10-17, deep review of PR #522). The client mints with `makeSlug`, which depends on
 * ODYSSEY_SCOPED_RELEASE_SLUGS (TRA-528 transliteration), and the channel runs this migration with the flag
 * OFF while the cache and the server are in the flag-ON form: "Gokhan Kirdar" (dotless i) came out as
 * `artist:gokhan-k-rdar`, a redirect key to ANOTHER artist's `artist:gokhan-kirdar`, and "MØ" as `artist:m`
 * (somebody else). Both the guard and the slugs of the edges written therefore use the flag-on form,
 * `transliteratedSlug` (src/slug.ts), which does not read the flag: the guard judges that form, and an edge
 * the client minted from a name is rewritten to it afterwards (or dropped when it has none). Edges to
 * cached nodes (by MBID, or the graph fallback's) are never touched. The redirect tables are read from
 * `--data-dir` (the channel's scratch copy) or else the repo's data/; an unreadable or invalid table, or a
 * missing slug table when `--data-dir` is given, refuses the run before any write (fail closed).
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
 * rewritten every CHECKPOINT_EVERY nodes while the nodes are written (see the collisions below: nothing is
 * written, nor checkpointed, until every artist is resolved).
 *
 * COLLISIONS (TRA-603, review of the repository run). Two edges can carry the same canonical slug for two
 * different MBIDs: `artist:wink` was Josh Wink for juan-atkins and the J-pop duo for junko-ohashi, and the
 * guard only compares a slug with the cache and the redirects. After all artists are resolved, a slug that
 * stands for two MBIDs or more in the final state (the edges already in the cache that this run keeps, plus
 * the ones it writes) is ambiguous: EVERY edge this run would write to it is dropped, the first seen included,
 * and it is listed in `ambiguousSlugs` with its MBIDs and the number of edges dropped. A node left with
 * nothing from ListenBrainz falls back to the graph. In a dry-run that resumes, the edges of the nodes the
 * previous manifest settled are not known and cannot take part in the check.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it
 * passes. `--data-dir` is where the redirect tables are read (never written).
 * The channel runs this migration with --apply in its preview AND in its apply, and replays a preview's
 * manifest (with --resume) only for the identity migrations: here each of the two runs asks ListenBrainz again
 * (about ten minutes each). With a live service the two manifests are therefore equal only if its answers are:
 * the apply's manifest is the one that describes what ships, and its `fallbacks` say how much of it is the
 * graph's. Changing that is a deploy/ change, out of this ticket's scope.
 *
 * A ListenBrainz outage during the apply must not ship graph fallbacks as final (the channel does not pass
 * --force, so no later channel run could replace them): when more than MAX_UNAVAILABLE_RATE of the artists
 * ListenBrainz was asked about end `lb-unavailable`, the run exits 1 (the channel then refuses it). The nodes
 * are still resolved and, with --apply, written; re-run with `--force --resume` once the service is back.
 * `--resume` skips a node the previous manifest settled only if its edges are what that manifest decided:
 * with --apply, the digest of the edges on disk must equal the one in `edgeDigests` (a dry-run writes the same
 * manifest as an apply, and under --force a node can already carry edges that are not the decided ones).
 *
 * Usage: tsx scripts/migrations/2026-10-19-backfill-similar-artists.ts <cache-dir> [--apply]
 *        [--manifest out/similar.json] [--resume] [--force] [--data-dir <dir>]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson } from "../../src/cache.js";
import { buildCacheIndex, type CacheIndex } from "../../src/cache-index.js";
import { loadRedirects } from "../../src/genre-registry.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { resolveSimilarArtists, type SimilarSource } from "../../src/similar-artists.js";
import { makeSlug, transliteratedSlug } from "../../src/slug.js";
import type { ArtistNode, EdgeRef, Slug } from "../../src/types.js";
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

/**
 * The share of the artists ListenBrainz was asked about that may end `lb-unavailable` (429, 408, 5xx, network,
 * timeout) before the run exits 1. A few failures are noise and fall back to the graph (counted); more than a
 * fifth means the service is down, and the graph edges a run would then ship are not what the preview said.
 * Strictly greater than: 20 % exactly passes. Computed over the artists of THIS run that made a request.
 */
export const MAX_UNAVAILABLE_RATE = 0.2;

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
	/** ListenBrainz rows dropped as name-only matches of a homonym (this run, not carried by --resume). */
	unsafeCandidates: number;
	/** Slugs that stand for two MBIDs or more in the final state; every new edge to them was dropped. */
	ambiguousSlugs: { slug: string; mbids: string[]; dropped: number }[];
	/** Fingerprint of the edges decided for each node of `listenbrainz` and `graph`, see --resume. */
	edgeDigests: Record<string, string>;
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
	/** Where the redirect tables are read (the channel's scratch copy); the repo's data/ when absent. */
	dataDir?: string | undefined;
	/** The network boundary, injected by the tests. Default: the global fetch, read at call time. */
	fetch?: typeof fetch;
	log?: (line: string) => void;
}

export interface BackfillResult {
	manifest: SimilarManifest;
	/** Node files written (always empty without --apply). */
	written: string[];
	/** ListenBrainz requests of this run: artists asked, and those that ended unavailable (see MAX_UNAVAILABLE_RATE). */
	listenbrainzRequests: { asked: number; unavailable: number };
	exitCode: 0 | 1;
}

/**
 * The redirect table the reads use (genre + slug files). Throws on an unreadable or invalid table, and on
 * a missing slug table when a directory was given explicitly: the run is refused, never run on a guess.
 */
export async function loadRunRedirects(dataDir: string | undefined): Promise<ReadonlyMap<Slug, Slug>> {
	if (dataDir === undefined) return loadRedirects();
	const slugTable = join(dataDir, "slug-redirects.json");
	try {
		await stat(slugTable);
	} catch {
		throw new Error(`redirect table not found: ${slugTable}`);
	}
	return loadRedirects({ genre: join(dataDir, "genre-redirects.json"), slug: slugTable });
}

/**
 * The slug an artist named `name` gets in its current canonical form (TRA-528 transliteration on), whatever
 * ODYSSEY_SCOPED_RELEASE_SLUGS says: `makeSlug` yields the old or the new spelling depending on it, and
 * `transliteratedSlug` maps either to the new one. Null when the name has no slug (empty body) or the slug
 * cannot be derived from it.
 */
export function canonicalArtistSlug(name: string): Slug | null {
	let minted: Slug;
	try {
		minted = makeSlug("artist", name);
	} catch {
		return null;
	}
	const canonical = transliteratedSlug(minted, name);
	return canonical.ok ? canonical.slug : null;
}

const digestOf = (edges: readonly unknown[]): string =>
	createHash("sha256").update(JSON.stringify(edges)).digest("hex").slice(0, 16);

/** What the guard and the edge canonicalization know of the cache and of the redirect table. */
export interface SlugContext {
	cacheIndex: CacheIndex;
	/** Every cached artist slug, with its MBID when it has one. */
	cachedArtists: ReadonlyMap<string, string | undefined>;
	redirects: ReadonlyMap<Slug, Slug>;
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
export function guardListenBrainz(base: () => typeof fetch, context: SlugContext): ListenBrainzGuard {
	let outcome: LbOutcome = "not-asked";
	let dropped = 0;

	// A row is safe when its MBID is the one of a cached artist (the client then uses that artist's slug), or
	// when the CANONICAL slug its name gets is free: not held by a cached artist, not a redirect key. (A
	// redirect key whose target carries the row's MBID would mean the MBID is cached, handled just above.) A
	// name with no canonical slug is left to the client, which drops it, and to `canonicalizeEdges`.
	function isSafeRow(row: unknown): boolean {
		if (!isRecord(row) || typeof row.artist_mbid !== "string" || typeof row.name !== "string") return true;
		const cached = context.cacheIndex.byMbid(row.artist_mbid);
		if (cached) return cached.startsWith("artist:");
		const slug = canonicalArtistSlug(row.name);
		if (slug === null) return true;
		return !context.cachedArtists.has(slug) && !context.redirects.has(slug);
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

/**
 * The edges the client minted, with the slug of every edge it MADE UP from a name replaced by the canonical
 * one (see the header). An edge to a cached node is the client's own business and stays as it is: its slug
 * is a cached one and its MBID is the cached node's (by MBID, or the graph fallback's own candidates). Any
 * other edge was minted from a name: it is rewritten to `canonicalArtistSlug(name)`, or dropped when that
 * slug does not exist, is held by a cached artist, is a redirect key, or repeats an edge or the artist.
 * Without the check on the cached MBID, the flag-off "MØ" -> `artist:m` would pass for the cached "M".
 */
export function canonicalizeEdges(
	artist: ArtistNode,
	edges: readonly EdgeRef[],
	context: SlugContext,
): EdgeRef[] {
	const taken = new Set<string>([
		artist.slug,
		...artist.aliases.map((e) => e.slug),
		...artist.members.map((e) => e.slug),
	]);
	const out: EdgeRef[] = [];
	for (const edge of edges) {
		let slug: string = edge.slug;
		const isCachedNode = context.cachedArtists.has(slug) && context.cachedArtists.get(slug) === edge.mbid;
		if (!isCachedNode) {
			const canonical = canonicalArtistSlug(edge.name);
			if (canonical === null || context.cachedArtists.has(canonical) || context.redirects.has(canonical)) {
				continue;
			}
			slug = canonical;
		}
		if (taken.has(slug)) continue;
		taken.add(slug);
		out.push({ ...edge, slug: slug as Slug });
	}
	return out;
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
	edgeDigests: Record<string, string>;
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
	const prior: PriorManifest = { listenbrainz: [], graph: [], edgeDigests: {} };
	if (isRecord(parsed.edgeDigests)) {
		for (const [slug, digest] of Object.entries(parsed.edgeDigests)) {
			if (typeof digest === "string") prior.edgeDigests[slug] = digest;
		}
	}
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
	// Before any write: a redirect table that cannot be read refuses the run (fail closed).
	const redirects = await loadRunRedirects(options.dataDir);
	// Every artist file of the cache counts as taken, an unreadable one included: its slug is not free.
	const cachedArtists = new Map<string, string | undefined>(errors.map((e) => [e.slug, undefined]));
	for (const { slug, node } of entries) {
		cachedArtists.set(slug, typeof node.mbid === "string" ? node.mbid : undefined);
	}
	const slugContext: SlugContext = { cacheIndex, cachedArtists, redirects };
	const guard = guardListenBrainz(() => options.fetch ?? fetch, slugContext);

	const prior = options.resume ? await readPriorManifest(manifestPath) : null;
	// What the previous run settled: with --force only ListenBrainz's answer is final (the fallbacks are what
	// a later run wants to replace); without it a node with edges is skipped anyway, so the graph's stay too.
	const settledLb = new Set(prior?.listenbrainz ?? []);
	const settledGraph = new Map((force ? [] : (prior?.graph ?? [])).map((g) => [g.slug, g.reason]));

	const listenbrainz: string[] = [];
	const graph: SimilarManifest["graph"] = [];
	const none: SimilarManifest["none"] = [];
	const kept: SimilarManifest["kept"] = [];
	const edgeDigests = new Map<string, string>();
	const ambiguous = new Map<string, { mbids: string[]; dropped: number }>();
	const written: string[] = [];
	const requests = { asked: 0, unavailable: 0 };

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
			ambiguousSlugs: [...ambiguous].map(([slug, info]) => ({ slug, ...info })).sort(bySlug),
			edgeDigests: Object.fromEntries([...edgeDigests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
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

	// A settled node is skipped only if its edges are what the previous run decided: when this run applies,
	// the edges on disk must be those (same digest). A dry-run writes the same manifest as an apply, so an
	// --apply that resumes from a dry-run's manifest writes what that dry-run only decided; and under --force
	// a node may already carry edges (a fallback) that are not the ones the manifest announces.
	const isSettled = (slug: string, raw: Record<string, unknown>): boolean =>
		(settledLb.has(slug) || settledGraph.has(slug)) &&
		(!apply || prior?.edgeDigests[slug] === digestOf(edgesOf(raw)));
	const carry = (slug: string): void => {
		const reason = settledGraph.get(slug);
		if (reason) graph.push({ slug, reason });
		else listenbrainz.push(slug);
		const digest = prior?.edgeDigests[slug];
		if (digest !== undefined) edgeDigests.set(slug, digest);
	};
	const pending = entries.filter(
		(e) => (force || edgesOf(e.node).length === 0) && !isSettled(e.slug, e.node),
	);
	const lbCalls = pending.filter((e) => artists.get(e.slug)?.mbid).length;
	log(
		`${pending.length} artist(s) to resolve among ${entries.length}: ${lbCalls} ListenBrainz request(s) ` +
			`at about one per second (${Math.ceil(lbCalls / 60)} min)${apply ? "" : " (dry-run)"}`,
	);

	// Phase 1, resolve: every artist is resolved before any is written, because the collision check below
	// needs the edges of the whole run. Nothing is written, and the manifest is not checkpointed, until then.
	interface Decision {
		slug: string;
		path: string;
		raw: Record<string, unknown>;
		artist: ArtistNode;
		hasEdges: boolean;
		source: SimilarSource;
		edges: EdgeRef[];
		reason: FallbackReason;
	}
	const deps = { cacheIndex, others: () => others, fetch: guard.fetch };
	const decisions: Decision[] = [];
	for (const { slug, path, node: raw } of entries) {
		const artist = artists.get(slug);
		const hasEdges = edgesOf(raw).length > 0;
		if (!force && hasEdges) {
			// Settled in an earlier run (or already there): carried into the manifest if that run said so.
			if (isSettled(slug, raw)) carry(slug);
			continue;
		}
		if (isSettled(slug, raw)) {
			carry(slug);
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
		try {
			const result = await resolveSimilarArtists(artist, deps);
			const edges = canonicalizeEdges(artist, result.edges, slugContext);
			const outcome = guard.outcome();
			if (outcome !== "not-asked") requests.asked++;
			if (outcome === "unavailable") requests.unavailable++;
			decisions.push({
				slug,
				path,
				raw,
				artist,
				hasEdges,
				source: result.source,
				edges,
				reason: fallbackReason(artist, outcome),
			});
		} catch (e) {
			errors.push({ slug, reason: `resolver threw: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	// Phase 2, collisions (TRA-603). A canonical slug that stands for two different MBIDs in the cache as it may
	// end up (the edges already there, plus the edges this run is about to write) is ambiguous: whichever artist
	// is materialized first under it, the other one's page opens the wrong person (artist:wink = Josh Wink for
	// juan-atkins, the J-pop duo for junko-ohashi). Every NEW edge to such a slug is dropped, the first seen
	// included: the safe behaviour, and it does not depend on the order of the run.
	//
	// Conservative on purpose (review of PR #527): the edges already on disk are ALL recorded, and so are all the
	// new ones, whatever the provisional source of a decision. The final source is only known in phase 3 (a
	// ListenBrainz answer whose edges are all discarded falls back to the graph, and under --force the node then
	// keeps its old edges), so an edge kept on disk must count even for a node that looked replaceable. Seeing an
	// ambiguity that is not one only drops edges, which is safe.
	const keepsExisting = (d: Decision): boolean => d.hasEdges && d.source !== "listenbrainz";
	const mbidsBySlug = new Map<string, Set<string>>();
	const note = (edge: unknown): void => {
		if (!isRecord(edge) || typeof edge.slug !== "string" || typeof edge.mbid !== "string") return;
		const mbids = mbidsBySlug.get(edge.slug) ?? new Set<string>();
		mbids.add(edge.mbid);
		mbidsBySlug.set(edge.slug, mbids);
	};
	for (const { node: raw } of entries) for (const edge of edgesOf(raw)) note(edge);
	for (const d of decisions) for (const edge of d.edges) note(edge);
	for (const [slug, mbids] of mbidsBySlug) {
		if (mbids.size >= 2) ambiguous.set(slug, { mbids: [...mbids].sort(), dropped: 0 });
	}
	// The edges dropped for a node are counted only once the node is known to be written: a node that keeps its
	// old edges (`kept`) or ends without any (`none`) did not lose them.
	let droppedByNode: string[] = [];
	const stripAmbiguous = (edges: EdgeRef[]): EdgeRef[] =>
		edges.filter((edge) => {
			const entry = ambiguous.get(edge.slug);
			if (entry) droppedByNode.push(edge.slug);
			return !entry;
		});

	// Phase 3, decide and write.
	let processed = 0;
	for (const d of decisions) {
		const { slug, path, raw, artist, hasEdges, reason } = d;
		let { source, edges } = d;
		droppedByNode = [];
		try {
			if (!keepsExisting(d)) {
				edges = stripAmbiguous(edges);
				if (source === "listenbrainz" && edges.length === 0) {
					// Nothing usable left of ListenBrainz's answer: the graph, asked without a network call.
					const { mbid: _asked, ...withoutMbid } = artist;
					edges = stripAmbiguous(
						canonicalizeEdges(artist, (await resolveSimilarArtists(withoutMbid, deps)).edges, slugContext),
					);
					source = "graph";
				}
				if (edges.length === 0) source = "none";
			}
		} catch (e) {
			errors.push({ slug, reason: `resolver threw: ${e instanceof Error ? e.message : String(e)}` });
			continue;
		}

		if (hasEdges && source !== "listenbrainz") {
			// --force: never trade existing edges for a fallback or for nothing.
			kept.push({ slug, reason });
			if (++processed % CHECKPOINT_EVERY === 0) await writeManifest();
			continue;
		}
		for (const dropped of droppedByNode) {
			const entry = ambiguous.get(dropped);
			if (entry) entry.dropped++;
		}
		if (source === "none") {
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
				if (source === "listenbrainz") listenbrainz.push(slug);
				else graph.push({ slug, reason });
				edgeDigests.set(slug, digestOf(edges));
				if (apply && !isDeepStrictEqual(edgesOf(raw), edges)) {
					await atomicWriteJson(path, next);
					written.push(path);
				}
			}
		}
		if (++processed % CHECKPOINT_EVERY === 0) await writeManifest();
	}

	await writeManifest();
	const outage = requests.asked > 0 && requests.unavailable / requests.asked > MAX_UNAVAILABLE_RATE;
	return {
		manifest: manifest(),
		written,
		listenbrainzRequests: requests,
		exitCode: errors.length > 0 || outage ? 1 : 0,
	};
}

const isOutage = (result: BackfillResult): boolean =>
	result.listenbrainzRequests.asked > 0 &&
	result.listenbrainzRequests.unavailable / result.listenbrainzRequests.asked > MAX_UNAVAILABLE_RATE;

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const lines = [
		`listenbrainz ${manifest.counts.listenbrainz}, graph ${manifest.counts.graph}, none ${manifest.counts.none}, kept ${manifest.counts.kept}, errors ${manifest.counts.errors}`,
		`fallback reasons: ${FALLBACK_REASONS.map((r) => `${r} ${manifest.fallbacks[r]}`).join(", ")}`,
		`${manifest.unsafeCandidates} unsafe ListenBrainz candidate(s) dropped`,
		`${result.listenbrainzRequests.unavailable} of ${result.listenbrainzRequests.asked} ListenBrainz request(s) unavailable` +
			(isOutage(result)
				? ` (more than ${MAX_UNAVAILABLE_RATE * 100} %: the service is down, re-run with --force --resume)`
				: ""),
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
	dataDir: string | undefined;
}

/**
 * Parses `<cache-dir> [--apply] [--manifest <path>] [--resume] [--force] [--data-dir <dir>]`. `--data-dir`
 * is the migration channel's scratch copy of the redirect tables. Null (the CLI exits 2) on a missing cache-dir, a repeated flag,
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
	let dataDir: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--resume" && !resume) resume = true;
		else if (token === "--force" && !force) force = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--data-dir" && dataDir === undefined)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else dataDir = value;
		} else return null;
	}
	return { cacheDir, apply, force, resume, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH, dataDir };
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
		dataDir: args.dataDir,
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
