import { NodeCache } from "./cache.js";
import { isSameEntityName } from "./entity-name.js";
import { isNotFoundError } from "./errors.js";
import { loadGenreResolver } from "./genre-identity.js";
import { createGenreRegistry, type GenreRegistry, loadGenreRedirects } from "./genre-registry.js";
import type { GenreSeed, GenreSeeds } from "./genre-seeds.js";
import { type PipelineDeps, type PipelineInput, runPipeline } from "./pipeline.js";
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

interface FrontierEntry {
	input: PipelineInput;
	depth: number;
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
	private seq = 0;
	private popped = 0;
	constructor(
		private readonly strategy: FrontierStrategy = "bfs",
		private readonly bfsHead = 40,
	) {}

	push(slug: Slug, base: Omit<FrontierEntry, "refCount" | "seq">): boolean {
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
		this.items.set(slug, { ...base, refCount: 1, seq: this.seq++ });
		return true;
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

export async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
	const log = opts.logger ?? (() => undefined);
	const cache = new NodeCache(opts.out);
	// TRA-28: built on this crawl's own cache, not a new one, so genre canonicalization sees
	// the same nodes this run has already written (see PipelineDeps.genreRegistry, pipeline.ts).
	const [genreResolver, genreRedirects] = await Promise.all([loadGenreResolver(), loadGenreRedirects()]);
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
	let stopped = false;
	let lastCompleted: string | undefined;
	const startedAt = Date.now();

	const heartbeatMs = opts.heartbeatMs ?? 90_000;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	const snapshot = (): CrawlProgress => {
		const elapsedMs = Date.now() - startedAt;
		const elapsedMin = elapsedMs / 60_000;
		const nodesPerMin = elapsedMin > 0 ? cache.stats.written / elapsedMin : 0;
		const remaining = Math.max(0, opts.maxNodes - cache.stats.written);
		const etaSec = nodesPerMin > 0 ? Math.round((remaining / nodesPerMin) * 60) : 0;
		const snap: CrawlProgress = {
			nodesWritten: cache.stats.written,
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
			if (cache.stats.written + claimed >= opts.maxNodes) {
				if (cache.stats.written >= opts.maxNodes) {
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
				if (alreadyCached) {
					log(`[w${workerId}] dedup ${result.slug} (already cached) — still expanding edges`);
				} else {
					await cache.write(result.node);
					lastCompleted = result.slug;
					const ms = Date.now() - t0;
					log(
						`[w${workerId}] OK ${result.slug} pipeline=${result.metrics.totalMs}ms ${ms}ms (total=${cache.stats.written}/${opts.maxNodes})`,
					);
				}
				if (next.entry.depth + 1 <= opts.maxDepth) {
					enqueueEdges(result.node, next.entry.depth + 1, frontier, log);
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
		nodesWritten: cache.stats.written,
		revUpdates: cache.stats.revUpdates,
		durationMs: Date.now() - startedAt,
		failed,
	};
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
	const [genreResolver, genreRedirects] = await Promise.all([loadGenreResolver(), loadGenreRedirects()]);
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
		const added = frontier.push(e.slug, { input, depth });
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
