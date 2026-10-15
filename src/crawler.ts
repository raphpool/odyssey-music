import { NodeCache } from "./cache.js";
import { scopedReleaseSlugsEnabled } from "./config.js";
import { isSameEntityName } from "./entity-name.js";
import { isNotFoundError } from "./errors.js";
import { loadGenreResolver } from "./genre-identity.js";
import { createGenreRegistry, type GenreRegistry, loadRedirects } from "./genre-registry.js";
import type { GenreSeed, GenreSeeds } from "./genre-seeds.js";
import { existingImageOf, type PipelineDeps, type PipelineInput, runPipeline } from "./pipeline.js";
import { normalizeSlugBody } from "./slug.js";
import {
	type EdgeRef,
	LIST_EDGES_BY_TYPE,
	type NodePayload,
	SINGULAR_EDGES_BY_TYPE,
	type Slug,
} from "./types.js";

export interface CrawlOptions {
	seed: string;
	maxDepth: number;
	maxNodes: number;
	concurrency: number;
	out: string;
	deps: PipelineDeps;
	logger?: (line: string) => void;
	signal?: AbortSignal;
	/** Called approximately every `heartbeatMs` ms with a live progress snapshot. */
	onHeartbeat?: (snapshot: CrawlProgress) => void | Promise<void>;
	heartbeatMs?: number;
	/** Frontier selection strategy. Default "hybrid" (BFS head then popularity). */
	strategy?: FrontierStrategy;
	/** When strategy="hybrid", how many BFS pops before switching to popularity. */
	bfsHead?: number;
}

export interface CrawlProgress {
	nodesWritten: number;
	maxNodes: number;
	failed: number;
	frontierSize: number;
	inFlight: number;
	elapsedMs: number;
	revUpdates: number;
	nodesPerMin: number;
	etaSec: number;
	lastCompleted?: string;
}

export interface CrawlResult {
	nodesWritten: number;
	revUpdates: number;
	durationMs: number;
	failed: number;
}

/** Result of a frontier crawl; `crawl()` only (seed batches never repoint a requester). */
export interface FrontierCrawlResult extends CrawlResult {
	/** Parent edges repointed because the pipeline filed the node under another slug than requested. */
	reconciled: number;
	/** Parent edges that could not be repointed and still cite a slug with no file. */
	reconcileFailed: number;
}

export type GenreSeedStage = "anchor" | "genre" | "target";

export interface GenreSeedPlanEntry {
	stage: GenreSeedStage;
	input: PipelineInput;
}

export interface GenreSeedCrawlResult extends CrawlResult {
	/** Pipeline invocations, excluding entries already present in the cache. */
	calls: number;
	/** Budget consumed by create/refresh attempts, including failures. */
	consumed: number;
	/** Entries skipped because their budget was exhausted or their node already existed. */
	refused: number;
	coverage: {
		total: number;
		written: number;
		failed: number;
		refused: number;
	};
}

export interface BackfillSeedGenresResult {
	/** Cached targets rewritten because they were missing their folder's genre edge. */
	backfilled: number;
	/** Cached targets that already carried the folder's genre edge -- left untouched. */
	alreadyLinked: number;
	/** Targets declared in a seed folder but not yet present in the cache. */
	missing: number;
}

/** A materialized node whose `field` edge asked for a frontier target (TRA-476). */
export interface FrontierRequester {
	slug: Slug;
	field: string;
}

interface FrontierEntry {
	/** Complete pipeline request: carries the edge's own `artist`, `mbid` and `qid` (TRA-476). */
	input: PipelineInput;
	depth: number;
	/** Edges that asked for this target, repointed if it is filed elsewhere. Shared with the queue's map. */
	requesters: FrontierRequester[];
	/** How many already-materialized nodes have referenced this target. */
	refCount: number;
	/** Insertion order, used as a tiebreaker after refCount. */
	seq: number;
}

export type FrontierStrategy = "bfs" | "popularity" | "hybrid";

/**
 * Frontier queue with two pop strategies:
 *
 *   - "bfs":        FIFO. Classic breadth-first walk from the seed.
 *   - "popularity": pop the entry with the highest refCount. After the first BFS-ish
 *                   pass naturally settles, every subsequent pick is the most-cited
 *                   dangling target, which directly maximizes click-through coverage.
 *   - "hybrid":     BFS for the first `bfsHead` pops (to seed the graph), then popularity.
 *
 * Re-pushing an already-known slug bumps its refCount instead of duplicating.
 */
// Exported for test/crawler.test.ts (TRA-28 review, B1): enqueueEdges needs a real instance to
// assert against, and FrontierQueue's push/pop/size surface is otherwise private to this module.
export class FrontierQueue {
	private readonly items = new Map<Slug, FrontierEntry>();
	private readonly seen = new Set<Slug>();
	private readonly requestersBySlug = new Map<Slug, FrontierRequester[]>();
	/** Primary artist each slug was first requested for; kept after the pop, while the child runs. */
	private readonly artistBySlug = new Map<Slug, string>();
	/** Requested slug -> where the pipeline filed it, per credit: a bare slug can be shared by homonyms. */
	private readonly resolved = new Map<Slug, { credit: string; target: CanonicalTarget }[]>();
	private seq = 0;
	private popped = 0;
	constructor(
		private readonly strategy: FrontierStrategy = "bfs",
		private readonly bfsHead = 40,
	) {}

	push(
		slug: Slug,
		base: Omit<FrontierEntry, "refCount" | "seq" | "requesters">,
		requester?: FrontierRequester,
	): boolean {
		// Recorded before the dedup returns below: a parent that cites a target another parent already
		// queued (or that is being materialized right now) must still be repointed with the others.
		const requesters = this.requestersBySlug.get(slug) ?? [];
		this.requestersBySlug.set(slug, requesters);
		if (requester && !requesters.some((r) => r.slug === requester.slug && r.field === requester.field)) {
			requesters.push(requester);
		}
		const existing = this.items.get(slug);
		if (existing) {
			existing.refCount++;
			return false;
		}
		if (this.seen.has(slug)) {
			// Already cached or in-flight downstream — nothing to do.
			return false;
		}
		this.seen.add(slug);
		if (base.input.artist) this.artistBySlug.set(slug, base.input.artist);
		this.items.set(slug, { ...base, requesters, refCount: 1, seq: this.seq++ });
		return true;
	}

	/**
	 * A requested slug was requested for `credit` and filed under `target`: later nodes citing it are
	 * repointed before their write, but only the edges credited to `credit` (see repointField).
	 */
	markResolved(requested: Slug, credit: string, target: CanonicalTarget): void {
		const kept = (this.resolved.get(requested) ?? []).filter((r) => !sameCredit(r.credit, credit));
		this.resolved.set(requested, [...kept, { credit, target }]);
	}

	/** `node` with every edge to an already-resolved requested slug repointed; the same object if none. */
	repointResolved(node: NodePayload): NodePayload {
		if (this.resolved.size === 0) return node;
		const obj = node as unknown as Record<string, unknown>;
		let next: Record<string, unknown> | undefined;
		for (const field of [...LIST_EDGES_BY_TYPE[node.type], ...SINGULAR_EDGES_BY_TYPE[node.type]]) {
			let value = obj[field];
			for (const [requested, resolutions] of this.resolved) {
				for (const { credit, target } of resolutions) {
					value = repointField(value, requested, credit, target) ?? value;
				}
			}
			if (value !== obj[field]) next = { ...(next ?? obj), [field]: value };
		}
		return (next ?? obj) as unknown as NodePayload;
	}

	/** True when `slug` was requested for another primary artist: a bare slug shared by two homonyms. */
	hasArtistConflict(slug: Slug, artist: string | undefined): boolean {
		const queued = this.artistBySlug.get(slug);
		return queued !== undefined && artist !== undefined && !sameCredit(queued, artist);
	}

	pop(): { slug: Slug; entry: FrontierEntry } | undefined {
		if (!this.items.size) return undefined;
		const useBfs = this.strategy === "bfs" || (this.strategy === "hybrid" && this.popped < this.bfsHead);
		let pickSlug: Slug | undefined;
		let pickEntry: FrontierEntry | undefined;
		if (useBfs) {
			let bestSeq = Number.POSITIVE_INFINITY;
			for (const [slug, e] of this.items) {
				if (e.seq < bestSeq) {
					bestSeq = e.seq;
					pickSlug = slug;
					pickEntry = e;
				}
			}
		} else {
			let bestRef = -1;
			let bestSeq = Number.POSITIVE_INFINITY;
			for (const [slug, e] of this.items) {
				if (e.refCount > bestRef || (e.refCount === bestRef && e.seq < bestSeq)) {
					bestRef = e.refCount;
					bestSeq = e.seq;
					pickSlug = slug;
					pickEntry = e;
				}
			}
		}
		if (!pickSlug || !pickEntry) return undefined;
		this.items.delete(pickSlug);
		this.popped++;
		return { slug: pickSlug, entry: pickEntry };
	}

	size(): number {
		return this.items.size;
	}
}

export async function crawl(opts: CrawlOptions): Promise<FrontierCrawlResult> {
	const log = opts.logger ?? (() => undefined);
	const cache = new NodeCache(opts.out);
	// TRA-28: built on this crawl's own cache, not a new one, so genre canonicalization sees
	// the same nodes this run has already written (see PipelineDeps.genreRegistry, pipeline.ts).
	const [genreResolver, genreRedirects] = await Promise.all([loadGenreResolver(), loadRedirects()]);
	const genreRegistry = createGenreRegistry({ cache, resolver: genreResolver, redirects: genreRedirects });
	const strategy: FrontierStrategy = opts.strategy ?? "hybrid";
	const frontier = new FrontierQueue(strategy, opts.bfsHead ?? 40);

	const seedInput: PipelineInput = parseSeed(opts.seed);
	// We don't know the seed's slug yet — the agent decides type. So the seed is enqueued
	// under a synthetic slug derived from the raw text. After materialization, the cache
	// is keyed by the canonical slug the agent produces.
	const seedKey: Slug = `track:__seed__${Date.now()}` as Slug;
	frontier.push(seedKey, { input: seedInput, depth: 0 });
	log(
		`[crawl] strategy=${strategy} maxDepth=${opts.maxDepth} maxNodes=${opts.maxNodes} concurrency=${opts.concurrency}`,
	);

	let inFlight = 0;
	let claimed = 0; // atomic budget reservation: incremented before each agent run
	let failed = 0;
	let reconciled = 0;
	let reconcileFailed = 0;
	// `cache.replace` counts each rewritten parent in `cache.stats.written`: not a new node, no budget.
	const writtenNodes = (): number => cache.stats.written - reconciled;
	// "Write a node and queue its edges" and "mark a slug resolved and repoint its requesters" never overlap:
	// a parent is either queued as a requester before the pass reads them, or repointed before its write.
	// It also stops two passes rewriting one parent from stale copies (NodeCache has no locked update).
	let serialChain: Promise<unknown> = Promise.resolve();
	const serialized = <T>(section: () => Promise<T>): Promise<T> => {
		const run = serialChain.then(section, section);
		serialChain = run.catch(() => undefined);
		return run;
	};
	let stopped = false;
	let lastCompleted: string | undefined;
	const startedAt = Date.now();

	const heartbeatMs = opts.heartbeatMs ?? 90_000;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	const snapshot = (): CrawlProgress => {
		const elapsedMs = Date.now() - startedAt;
		const elapsedMin = elapsedMs / 60_000;
		const nodesPerMin = elapsedMin > 0 ? writtenNodes() / elapsedMin : 0;
		const remaining = Math.max(0, opts.maxNodes - writtenNodes());
		const etaSec = nodesPerMin > 0 ? Math.round((remaining / nodesPerMin) * 60) : 0;
		const snap: CrawlProgress = {
			nodesWritten: writtenNodes(),
			maxNodes: opts.maxNodes,
			failed,
			frontierSize: frontier.size(),
			inFlight,
			elapsedMs,
			revUpdates: cache.stats.revUpdates,
			nodesPerMin: Math.round(nodesPerMin * 10) / 10,
			etaSec,
		};
		if (lastCompleted !== undefined) snap.lastCompleted = lastCompleted;
		return snap;
	};
	if (opts.onHeartbeat) {
		const cb = opts.onHeartbeat;
		heartbeatTimer = setInterval(() => {
			void Promise.resolve(cb(snapshot())).catch((e) => {
				log(`heartbeat error: ${e instanceof Error ? e.message : String(e)}`);
			});
		}, heartbeatMs);
		heartbeatTimer.unref?.();
	}

	const start = async (workerId: number): Promise<void> => {
		while (!stopped) {
			if (opts.signal?.aborted) {
				stopped = true;
				return;
			}
			// Atomic budget gate. Reserve a slot before the agent runs so concurrent workers
			// never collectively exceed maxNodes by more than `concurrency - 1` writes
			// (each worker holds at most one outstanding reservation).
			if (writtenNodes() + claimed >= opts.maxNodes) {
				if (writtenNodes() >= opts.maxNodes) {
					stopped = true;
					return;
				}
				// Budget temporarily full because peers hold reservations.
				if (inFlight === 0) return;
				await sleep(100);
				continue;
			}
			const next = frontier.pop();
			if (!next) {
				if (inFlight === 0) return;
				await sleep(100);
				continue;
			}
			claimed++;
			inFlight++;
			const t0 = Date.now();
			try {
				if (next.slug.startsWith("track:__seed__") === false) {
					if (await cache.has(next.slug)) {
						log(`[w${workerId}] skip cached ${next.slug}`);
						continue;
					}
				}
				log(
					`[w${workerId}] materialize depth=${next.entry.depth} ${describeInput(next.entry.input, next.slug)}`,
				);
				// A caller-supplied genreRegistry (if any) wins -- don't clobber one the caller
				// deliberately built (e.g. against a different cache) with crawl()'s own default.
				const result = await runPipeline(next.entry.input, {
					...opts.deps,
					genreRegistry: opts.deps.genreRegistry ?? genreRegistry,
				});
				const alreadyCached = await cache.has(result.slug);
				const node = await serialized(async () => {
					const repointed = frontier.repointResolved(result.node);
					if (alreadyCached) {
						log(`[w${workerId}] dedup ${result.slug} (already cached) — still expanding edges`);
					} else {
						await cache.write(repointed);
						lastCompleted = result.slug;
						const ms = Date.now() - t0;
						log(
							`[w${workerId}] OK ${result.slug} pipeline=${result.metrics.totalMs}ms ${ms}ms (total=${writtenNodes()}/${opts.maxNodes})`,
						);
					}
					if (next.entry.depth + 1 <= opts.maxDepth) {
						enqueueEdges(repointed, next.entry.depth + 1, frontier, log);
					}
					return repointed;
				});
				const requested = result.requestedSlug;
				if (requested && requested !== result.slug) {
					// Read from disk: when the slug was already cached, `node` is a discarded draft.
					const target = canonicalTargetOf(alreadyCached ? await cache.get(result.slug) : node);
					const outcome = await serialized(async () => {
						// No credit asked for: nothing proves whose edge this is, so no edge is repointed.
						const credit = next.entry.input.artist;
						if (!credit) return { rewritten: 0, failed: 0 };
						frontier.markResolved(requested, credit, target);
						return reconcileRequesters(requested, credit, target, next.entry.requesters, cache, log);
					});
					reconciled += outcome.rewritten;
					reconcileFailed += outcome.failed;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				failed++;
				log(`[w${workerId}] FAIL ${next.slug}: ${msg}`);
			} finally {
				// `claimed` tracks IN-FLIGHT reservations only. The budget check uses written+claimed,
				// so once a worker exits this iteration (whether it wrote, deduped, abandoned, or
				// failed) the reservation must be released. Persisted writes are accounted for in
				// `cache.stats.written` and do NOT need to keep a phantom claim.
				inFlight--;
				claimed--;
			}
		}
	};

	const workers = Array.from({ length: Math.max(1, opts.concurrency) }, (_, i) => start(i + 1));
	try {
		await Promise.all(workers);
	} finally {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
	}

	return {
		nodesWritten: writtenNodes(),
		revUpdates: cache.stats.revUpdates,
		durationMs: Date.now() - startedAt,
		failed,
		reconciled,
		reconcileFailed,
	};
}

/** The node an edge requested under one slug was finally filed as (TRA-476). */
interface CanonicalTarget {
	slug: Slug;
	artist?: string;
	mbid?: string;
}

/** What an edge to `node` must carry: the primary credit (`artists[0]`, the scope of its slug) and the mbid. */
function canonicalTargetOf(node: NodePayload): CanonicalTarget {
	const target: CanonicalTarget = { slug: node.slug };
	if (node.type === "project" || node.type === "track") {
		const first = node.artists[0];
		if (first?.name) target.artist = first.name;
	}
	if (node.mbid) target.mbid = node.mbid;
	return target;
}

/** Same credit on the form scoped slugs use; raw text when a name has no Latin letter. */
function sameCredit(a: string, b: string): boolean {
	const na = normalizeSlugBody(a);
	const nb = normalizeSlugBody(b);
	if (na && nb) return na === nb;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * An edge field (list or single edge) with its edges to `requested` repointed to `target`, or undefined
 * when none was. Only an edge credited to `credit` moves: a bare slug can be shared by homonyms, and an
 * edge with no `artist` or another one stays as it is (the identity migration handles it, TRA-478).
 * Edges collapsing onto `target.slug` are kept once.
 */
function repointField(value: unknown, requested: Slug, credit: string, target: CanonicalTarget): unknown {
	const mine = (e: EdgeRef): boolean => e.slug === requested && !!e.artist && sameCredit(e.artist, credit);
	const repoint = (edge: EdgeRef): EdgeRef => {
		const next: EdgeRef = { ...edge, slug: target.slug };
		if (target.artist) next.artist = target.artist;
		if (target.mbid) next.mbid = target.mbid;
		return next;
	};
	if (Array.isArray(value)) {
		const list = value as EdgeRef[];
		if (!list.some(mine)) return undefined;
		const out: EdgeRef[] = [];
		for (const edge of list) {
			const next = mine(edge) ? repoint(edge) : edge;
			if (next.slug === target.slug && out.some((e) => e.slug === target.slug)) continue;
			out.push(next);
		}
		return out;
	}
	if (value && typeof value === "object" && mine(value as EdgeRef)) return repoint(value as EdgeRef);
	return undefined;
}

/**
 * Invariant (TRA-476): once a frontier child has run, no parent edge points at a `requestedSlug` with no
 * file. The pipeline files a project/track under the slug its MusicBrainz credit earns
 * ("project:new-forms--roni-size" -> "...--roni-size-reprazent"); the parent kept the old link, to a node
 * never written or, before scoped slugs, to a homonym's (111 work links measured on 2026-10-14).
 *
 * A parent that vanished or no longer cites the edge is skipped. One that cannot be rewritten (`replace`
 * refuses a legacy non-canonical slug) is counted in `failed`: its edge stays dangling and is reported.
 */
async function reconcileRequesters(
	requested: Slug,
	credit: string,
	target: CanonicalTarget,
	requesters: readonly FrontierRequester[],
	cache: NodeCache,
	log: (s: string) => void,
): Promise<{ rewritten: number; failed: number }> {
	let rewritten = 0;
	let failed = 0;
	for (const requester of requesters) {
		const where = `${requester.slug}.${requester.field}`;
		try {
			const parent = await cache.get(requester.slug);
			const obj = parent as unknown as Record<string, unknown>;
			const updated = repointField(obj[requester.field], requested, credit, target);
			if (updated === undefined) {
				log(`  ~ reconcile skipped: ${where} has no edge to ${requested} credited to "${credit}"`);
				continue;
			}
			await cache.replace({ ...obj, [requester.field]: updated } as unknown as NodePayload);
			rewritten++;
			log(`  ~ reconciled ${where}: ${requested} -> ${target.slug}`);
		} catch (e) {
			if (isNotFoundError(e)) {
				log(`  ~ reconcile skipped: ${requester.slug} is not cached`);
				continue;
			}
			failed++;
			log(`  ~ reconcile FAILED ${where}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { rewritten, failed };
}

/**
 * Builds one data-folder's exact materialization order. Seed batches deliberately do not use the
 * general crawl frontier: a curated target must not implicitly expand into its own references.
 */
export async function buildGenreSeedPlan(
	folder: GenreSeed,
	genreRegistry: Pick<GenreRegistry, "canonicalSlugFor">,
): Promise<GenreSeedPlanEntry[]> {
	const canonicalGenreInput = async (ref: GenreSeed["genre"]): Promise<PipelineInput> => {
		const canonical = await genreRegistry.canonicalSlugFor({
			slug: ref.slug as Slug,
			name: ref.name,
			...(ref.qid ? { qid: ref.qid } : {}),
		});
		const input: PipelineInput = { type: "genre", name: ref.name, slug: canonical.slug };
		const qid = canonical.qid ?? ref.qid;
		if (qid) input.qid = qid;
		// TRA-254: forward the seed folder's disambiguator (e.g. distinguishing Afrobeats
		// pop from Fela Kuti's Afrobeat) to the pipeline's search query and prompt. The
		// slug is already fixed above, so this cannot affect it (see canonicalizeDraft).
		if (ref.disambiguator) input.disambiguator = ref.disambiguator;
		return input;
	};
	const anchors = await Promise.all(folder.anchors.map(async (anchor) => canonicalGenreInput(anchor)));
	const genre = await canonicalGenreInput(folder.genre);
	const targets = folder.targets.map((target): PipelineInput => {
		const input: PipelineInput = { type: target.type, name: target.name, slug: target.slug as Slug };
		if (target.mbid) input.mbid = target.mbid;
		// TRA-254 code review: genre-seeds.ts's targetSchema also accepts a disambiguator —
		// drop it silently here and a homonymous target loses its only disambiguating hint.
		if (target.disambiguator) input.disambiguator = target.disambiguator;
		return input;
	});
	return [
		...anchors.map((input): GenreSeedPlanEntry => ({ stage: "anchor", input })),
		{ stage: "genre", input: genre },
		...targets.map((input): GenreSeedPlanEntry => ({ stage: "target", input })),
	];
}

/** A node type that carries a `genres` edge list (every seed target type: artist/project/track,
 * plus label). Used to attach the folder's own genre onto a target node (TRA-263). */
type GenreLinkedNode = Extract<NodePayload, { genres: EdgeRef[] }>;

function hasGenresField(node: NodePayload): node is GenreLinkedNode {
	return "genres" in node;
}

/**
 * Attaches a seed folder's own genre to one of its targets, when the target doesn't already
 * cite it. Returns the same object reference, unchanged, when there's nothing to add -- callers
 * use that identity to tell a real change from a no-op (see backfillSeedGenres's idempotence).
 *
 * TRA-263 (2026-09-17): each seed folder's target -> genre link is already established by the
 * dossier's own MusicBrainz/Wikidata evidence (verified by the folder's own S-task), but the
 * LLM draft for a target frequently cites only genres it independently found, so the folder's
 * curated genre link never lands on disk (e.g. artist:dj-paul-elstak drafted with only
 * genre:rave, missing the Gabber folder's genre:gabber). Never duplicates an existing edge to
 * the same slug, even one recorded under a different display name.
 */
// Exported for test/crawler.test.ts: pure, synchronous, and shared by both crawlGenreSeeds and
// backfillSeedGenres, so it's cheaper to unit-test directly than only through the full e2e path.
export function attachFolderGenre(node: NodePayload, folderGenre: PipelineInput): NodePayload {
	if (!hasGenresField(node) || !folderGenre.slug) return node;
	const slug = folderGenre.slug;
	if (node.genres.some((edge) => edge.slug === slug)) return node;
	const edge: EdgeRef = { type: "genre", name: folderGenre.name, slug };
	if (folderGenre.qid) edge.qid = folderGenre.qid;
	return { ...node, genres: [...node.genres, edge] };
}

/**
 * Materializes curated seed folders sequentially. This keeps the cache's QID index authoritative
 * between folders and makes the reported maxNodes consumption deterministic.
 */
export async function crawlGenreSeeds(opts: CrawlOptions, seeds: GenreSeeds): Promise<GenreSeedCrawlResult> {
	const log = opts.logger ?? (() => undefined);
	const cache = new NodeCache(opts.out);
	const genreRegistry = await getGenreRegistry(cache, opts.deps.genreRegistry);
	const startedAt = Date.now();
	let calls = 0;
	let consumed = 0;
	let failed = 0;
	let refused = 0;
	let total = 0;

	log(`[seed] maxNodes=${opts.maxNodes} concurrency=1`);
	for (const folder of Object.values(seeds)) {
		const plan = await buildGenreSeedPlan(folder, genreRegistry);
		total += plan.length;
		// TRA-263: the folder's own "genre" stage entry carries the already-canonicalized
		// {name, slug, qid} used below to attach the target -> genre edge.
		const genrePlanEntry = plan.find((planEntry) => planEntry.stage === "genre");
		for (const entry of plan) {
			if (await cache.has(entry.input.slug as Slug)) {
				refused++;
				log(`[seed] skip cached ${entry.stage} ${describeInput(entry.input, entry.input.slug as Slug)}`);
				continue;
			}
			if (consumed >= opts.maxNodes) {
				refused++;
				log(`[seed] limit ${entry.stage} ${describeInput(entry.input, entry.input.slug as Slug)}`);
				continue;
			}

			consumed++;
			calls++;
			try {
				log(`[seed] materialize ${entry.stage} ${describeInput(entry.input, entry.input.slug as Slug)}`);
				const result = await runPipeline(entry.input, { ...opts.deps, genreRegistry });
				// Identity guard (TRA-XXX, 2026-09-17): researchTarget searches by name, and
				// canonicalizeDraft lets the LLM-authored name overwrite the requested one while
				// keeping the requested slug — so a homonym in the search results can silently
				// materialize the wrong real-world entity under the right slug (e.g.
				// artist:tracy-onne, a Spanish makina DJ, got written as Tracy Lawrence, the US
				// country singer). Refuse to write when the drafted name isn't plausibly the same
				// entity as requested, rather than trusting the slug alone.
				if (!isSameEntityName(entry.input.name, result.node.name)) {
					failed++;
					log(`[seed] identity drift: requested "${entry.input.name}", drafted "${result.node.name}"`);
					continue;
				}
				if (await cache.has(result.slug)) {
					refused++;
					log(`[seed] dedup ${result.slug}`);
					continue;
				}
				// Only attach when the folder's genre is actually on disk: crawlGenreSeeds never
				// retries a failed "genre" stage entry within the same run (no frontier expansion
				// here, by design -- see buildGenreSeedPlan's docstring), so attaching
				// unconditionally would leave a target citing a genre slug that was never written
				// (e.g. the genre stage hit the identity guard or a pipeline error earlier in this
				// same folder).
				const nodeToWrite =
					entry.stage === "target" && genrePlanEntry && (await cache.has(genrePlanEntry.input.slug as Slug))
						? attachFolderGenre(result.node, genrePlanEntry.input)
						: result.node;
				await cache.write(nodeToWrite);
			} catch (error) {
				failed++;
				const message = error instanceof Error ? error.message : String(error);
				log(`[seed] FAIL ${entry.stage} ${entry.input.slug}: ${message}`);
			}
		}
	}

	return {
		nodesWritten: cache.stats.written,
		revUpdates: cache.stats.revUpdates,
		durationMs: Date.now() - startedAt,
		failed,
		calls,
		consumed,
		refused,
		coverage: { total, written: cache.stats.written, failed, refused },
	};
}

/**
 * Catches up seed targets that were materialized before the fix above (TRA-263) and so are
 * missing their folder's genre edge. Pure cache maintenance: no pipeline run, no search, and no
 * write at all for a target that already carries the edge or isn't cached yet -- the folder's
 * target -> genre link was already verified by the seed dossier's own MusicBrainz/Wikidata
 * evidence, so relinking it needs no re-materialization.
 */
export async function backfillSeedGenres(
	opts: CrawlOptions,
	seeds: GenreSeeds,
): Promise<BackfillSeedGenresResult> {
	const log = opts.logger ?? (() => undefined);
	const cache = new NodeCache(opts.out);
	const genreRegistry = await getGenreRegistry(cache, opts.deps.genreRegistry);
	let backfilled = 0;
	let alreadyLinked = 0;
	let missing = 0;

	log(`[backfill] maxNodes=${opts.maxNodes}`);
	for (const folder of Object.values(seeds)) {
		const plan = await buildGenreSeedPlan(folder, genreRegistry);
		const genrePlanEntry = plan.find((planEntry) => planEntry.stage === "genre");
		if (!genrePlanEntry) continue;
		for (const entry of plan) {
			if (entry.stage !== "target") continue;
			const slug = entry.input.slug as Slug;
			// A single get() -- rather than has() then get() -- avoids reading the same file
			// twice; get() already throws NotFoundError on a missing node (cache.ts).
			let existing: NodePayload;
			try {
				existing = await cache.get(slug);
			} catch (error) {
				if (!isNotFoundError(error)) throw error;
				missing++;
				log(`[backfill] missing ${slug}`);
				continue;
			}
			const updated = attachFolderGenre(existing, genrePlanEntry.input);
			if (updated === existing) {
				alreadyLinked++;
				continue;
			}
			await cache.replace(updated);
			backfilled++;
			log(`[backfill] linked ${slug} -> ${genrePlanEntry.input.slug}`);
		}
	}

	return { backfilled, alreadyLinked, missing };
}

/**
 * Re-materializes one cached genre without walking its references. The existing node remains on
 * disk until the replacement has passed the pipeline and NodeCache validation successfully.
 *
 * TRA-252: `seedFolder`, when the caller can supply the genre's curated seed dossier, is a
 * stronger identity anchor than a fresh by-name resolve. Its QID is inherited onto the refreshed
 * node when the cached node doesn't have one yet, and stamped as authoritative when it does but
 * disagrees with the dossier — the refresh is refused outright rather than letting the pipeline's
 * ordinary "cached QID wins" rule (pipeline.ts) silently paper over what is, at this level, a
 * curation conflict that needs a human to resolve the dossier or the cache, not a crawl.
 */
export async function refreshGenre(
	opts: CrawlOptions,
	slug: Slug,
	seedFolder?: GenreSeed,
): Promise<GenreSeedCrawlResult> {
	const log = opts.logger ?? (() => undefined);
	const cache = new NodeCache(opts.out);
	const existing = await cache.get(slug);
	if (existing.type !== "genre") {
		throw new Error(`--refresh-genre requires a cached genre node (got ${existing.type}: ${slug})`);
	}
	const startedAt = Date.now();
	let calls = 0;
	let consumed = 0;
	let failed = 0;
	let refused = 0;

	log(`[refresh] maxNodes=${opts.maxNodes} concurrency=1`);

	const dossierQid = seedFolder?.genre.qid;
	if (dossierQid && existing.qid && dossierQid !== existing.qid) {
		refused++;
		log(
			`[refresh] dossier QID conflict for ${slug}: dossier=${dossierQid} cached=${existing.qid} (refused, no write)`,
		);
		return {
			nodesWritten: cache.stats.written,
			revUpdates: cache.stats.revUpdates,
			durationMs: Date.now() - startedAt,
			failed,
			calls,
			consumed,
			refused,
			coverage: { total: 1, written: cache.stats.written, failed, refused },
		};
	}

	const genreRegistry = await getGenreRegistry(cache, opts.deps.genreRegistry);
	const inheritedQid = existing.qid ?? dossierQid;
	const canonical = await genreRegistry.canonicalSlugFor({
		slug,
		name: existing.name,
		...(inheritedQid ? { qid: inheritedQid } : {}),
	});
	const input: PipelineInput = { type: "genre", name: existing.name, slug: canonical.slug };
	// Precedence: a registry-resolved qid first, then the node's own already-committed qid,
	// then — only when neither is set — the seed dossier's qid, inherited onto this refresh.
	const qid = canonical.qid ?? existing.qid ?? dossierQid;
	if (qid) input.qid = qid;
	// TRA-549: the refresh must not erase the image the genre already carries when the resolver misses.
	// Not when the registry moved the refresh onto another slug: that image is another node's.
	const existingImage = canonical.slug === slug ? existingImageOf(existing) : undefined;
	if (existingImage) input.existingImage = existingImage;

	if (consumed >= opts.maxNodes) {
		refused++;
		log(`[refresh] limit genre ${describeInput(input, input.slug as Slug)}`);
	} else {
		consumed++;
		calls++;
		try {
			log(`[refresh] materialize genre ${describeInput(input, input.slug as Slug)}`);
			const result = await runPipeline(input, { ...opts.deps, genreRegistry });
			// Identity guard (TRA-XXX, 2026-09-17) — see the matching comment in
			// crawlGenreSeeds above: refuse a refresh whose drafted name isn't plausibly the
			// same entity as the cached one (e.g. genre:afrobeats drifting to "Afrobeat").
			if (!isSameEntityName(input.name, result.node.name)) {
				failed++;
				log(`[refresh] identity drift: requested "${input.name}", drafted "${result.node.name}"`);
			} else {
				const merged = await preserveLiveNeighbors(existing, result.node, cache, log);
				// 2026-09-17 (TRA-252 review): edges carried over from the cached node have not been
				// through the pipeline's own canonicalization, which drops a genre edge that lands on
				// this node's slug or on another slug sharing its qid -- an unmerged duplicate
				// (TRA-28/B3). Re-running it over the merged node applies that filter to survivors
				// too, including edges whose qid is only known after name resolution, instead of
				// re-implementing the rule here.
				await genreRegistry.canonicalizeNodeEdges(merged);
				await cache.replace(merged);
			}
		} catch (error) {
			failed++;
			const message = error instanceof Error ? error.message : String(error);
			log(`[refresh] FAIL genre ${input.slug}: ${message}`);
		}
	}

	return {
		nodesWritten: cache.stats.written,
		revUpdates: cache.stats.revUpdates,
		durationMs: Date.now() - startedAt,
		failed,
		calls,
		consumed,
		refused,
		coverage: { total: 1, written: cache.stats.written, failed, refused },
	};
}

/**
 * TRA-252: `refreshGenre` re-materializes a single node without walking its references (see the
 * docstring above), so the fresh draft reflects only what that one pipeline call surfaced —
 * typically a narrower edge set than earlier full crawls (or curated edits) had already
 * discovered. Replacing the node outright on every refresh would make a "targeted refresh" a
 * lossy operation for its neighbors. Keep any edge from the previous node whose target is still
 * cached (an alive neighbor) that the fresh draft doesn't already list; drop edges whose target
 * no longer exists in the cache (a dead neighbor).
 */
async function preserveLiveNeighbors(
	existing: NodePayload,
	fresh: NodePayload,
	cache: NodeCache,
	log: (s: string) => void,
): Promise<NodePayload> {
	const merged = { ...fresh } as unknown as Record<string, unknown>;
	const existingObj = existing as unknown as Record<string, unknown>;
	for (const field of LIST_EDGES_BY_TYPE[fresh.type]) {
		const freshEdges = Array.isArray(merged[field]) ? (merged[field] as EdgeRef[]) : [];
		const oldEdges = Array.isArray(existingObj[field]) ? (existingObj[field] as EdgeRef[]) : [];
		if (oldEdges.length === 0) continue;
		const freshSlugs = new Set(freshEdges.map((e) => e.slug));
		const survivors: EdgeRef[] = [];
		for (const edge of oldEdges) {
			if (freshSlugs.has(edge.slug)) continue; // already re-surfaced by the fresh draft
			if (await cache.has(edge.slug)) survivors.push(edge); // still alive, keep it
			// else: target no longer cached — a dead neighbor, dropped rather than carried forward.
		}
		if (survivors.length > 0) {
			merged[field] = [...freshEdges, ...survivors];
			log(`[refresh] kept ${survivors.length} live ${field} neighbor(s) for ${fresh.slug}`);
		}
	}
	return merged as unknown as NodePayload;
}

async function getGenreRegistry(cache: NodeCache, injected?: GenreRegistry): Promise<GenreRegistry> {
	if (injected) return injected;
	const [genreResolver, genreRedirects] = await Promise.all([loadGenreResolver(), loadRedirects()]);
	return createGenreRegistry({ cache, resolver: genreResolver, redirects: genreRedirects });
}

// Exported for test/crawler.test.ts (TRA-28 review, B1).
export function enqueueEdges(
	node: NodePayload,
	depth: number,
	frontier: FrontierQueue,
	log: (s: string) => void,
): void {
	// Build a parent-context disambiguator so the child node's agent run
	// receives full identifying context instead of just a bare name. Without
	// this, an ambiguous name like a track "Tendency" or an artist "Bird"
	// would lock onto the wrong entity. Henry called this out 2026-05-14.
	const parentDisambig = `${node.type} "${node.name}"`;
	const collect = (e: EdgeRef, kind: string): void => {
		// 2026-09-10 (TRA-28 review, B1): key the frontier by the edge's OWN slug, not one
		// re-derived from its name. A genre edge can carry a slug that GenreRegistry
		// canonicalized onto an existing/redirected node, which no longer matches
		// makeSlug(e.type, e.name) -- re-deriving it here sent the frontier chasing a
		// name-derived slug the cache.has() dedup check below (in `start`) could never match,
		// minting a second, orphaned duplicate node for a target that was never actually
		// missing. `input.slug` pins runPipeline's output to this exact slug if it does end up
		// getting materialized (see PipelineInput.slug).
		const disambiguator = `${kind.replace(/_/g, " ")} of ${parentDisambig}`;
		// 2026-09-10 (TRA-43): forward the edge's own qid so a rematerialization is stamped with
		// the same identity, not a fresh by-name resolve. Conditional (exactOptionalPropertyTypes).
		const input: FrontierEntry["input"] = { type: e.type, name: e.name, slug: e.slug, disambiguator };
		if (e.qid) input.qid = e.qid;
		// TRA-476 (2026-10-14, 111 work links to a homonym): artist and mbid were dropped here.
		if (e.artist) input.artist = e.artist;
		if (e.mbid) input.mbid = e.mbid;
		// Scoped slugs differ per artist; a pre-migration bare slug already requested for ANOTHER artist
		// must not absorb this edge. Flag off keeps today's merge by slug (TRA-509).
		if (scopedReleaseSlugsEnabled() && frontier.hasArtistConflict(e.slug, e.artist)) {
			log(`  - frontier ${e.slug} not merged: queued for another artist than "${e.artist}"`);
			return;
		}
		const added = frontier.push(e.slug, { input, depth }, { slug: node.slug, field: kind });
		if (added) log(`  + frontier ${e.slug} (depth=${depth}) disambig=${disambiguator}`);
	};
	const obj = node as unknown as Record<string, unknown>;
	for (const field of LIST_EDGES_BY_TYPE[node.type]) {
		const v = obj[field];
		if (Array.isArray(v)) for (const e of v as EdgeRef[]) collect(e, field);
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[node.type]) {
		const v = obj[field];
		if (v && typeof v === "object") collect(v as EdgeRef, field);
	}
}

function describeInput(input: PipelineInput, fallbackSlug: Slug): string {
	if (input.type && input.name) return `${input.type}:${input.name}`;
	return fallbackSlug;
}

function parseSeed(seed: string): PipelineInput {
	const match = /^(genre|label|artist|project|track)\s*:\s*(.+)$/i.exec(seed.trim());
	if (match?.[1] && match[2]) {
		return { type: match[1].toLowerCase() as PipelineInput["type"], name: match[2].trim() };
	}
	return { type: "track", name: seed };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
