import { NodeCache } from "./cache.js";
import { loadGenreResolver } from "./genre-identity.js";
import { createGenreRegistry, loadGenreRedirects } from "./genre-registry.js";
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
		// 2026-09-10 (TRA-43): forward the edge's own qid, when it carries one, so the frontier's
		// PipelineInput names the same identity the edge does -- omitting it let a rematerialized
		// genre get stamped by a fresh by-name resolve instead, potentially landing on a different
		// QID than the edge that enqueued it. Built conditionally (exactOptionalPropertyTypes):
		// `qid: e.qid` would fail to typecheck when e.qid is undefined.
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
