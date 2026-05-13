import { type AgentDeps, type AgentInput, runAgent } from "./agent.js";
import { NodeCache } from "./cache.js";
import { makeSlug } from "./slug.js";
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
	deps: AgentDeps;
	logger?: (line: string) => void;
	signal?: AbortSignal;
}

export interface CrawlResult {
	nodesWritten: number;
	revUpdates: number;
	durationMs: number;
	failed: number;
}

interface FrontierEntry {
	input: AgentInput;
	depth: number;
}

class FrontierQueue {
	private readonly items: { slug: Slug; entry: FrontierEntry }[] = [];
	private readonly seen = new Set<Slug>();

	push(slug: Slug, entry: FrontierEntry): boolean {
		if (this.seen.has(slug)) return false;
		this.seen.add(slug);
		this.items.push({ slug, entry });
		return true;
	}

	pop(): { slug: Slug; entry: FrontierEntry } | undefined {
		return this.items.shift();
	}

	size(): number {
		return this.items.length;
	}
}

export async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
	const log = opts.logger ?? (() => undefined);
	const cache = new NodeCache(opts.out);
	const frontier = new FrontierQueue();

	const seedInput: AgentInput = { text: opts.seed };
	// We don't know the seed's slug yet — the agent decides type. So the seed is enqueued
	// under a synthetic slug derived from the raw text. After materialization, the cache
	// is keyed by the canonical slug the agent produces.
	const seedKey: Slug = `track:__seed__${Date.now()}` as Slug;
	frontier.push(seedKey, { input: seedInput, depth: 0 });

	let inFlight = 0;
	let failed = 0;
	let stopped = false;
	const startedAt = Date.now();

	const start = async (workerId: number): Promise<void> => {
		while (!stopped) {
			if (opts.signal?.aborted) {
				stopped = true;
				return;
			}
			if (cache.stats.written >= opts.maxNodes) {
				stopped = true;
				return;
			}
			const next = frontier.pop();
			if (!next) {
				if (inFlight === 0) return;
				await sleep(50);
				continue;
			}
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
				const result = await runAgent(next.entry.input, opts.deps);
				if (cache.stats.written >= opts.maxNodes) {
					log(`[w${workerId}] discard ${result.slug} (budget reached during run)`);
					stopped = true;
					continue;
				}
				if (await cache.has(result.slug)) {
					log(`[w${workerId}] dedup ${result.slug} (already materialized during run)`);
					continue;
				}
				await cache.write(result.node);
				const ms = Date.now() - t0;
				log(
					`[w${workerId}] OK ${result.slug} turns=${result.turns} ${ms}ms (total=${cache.stats.written}/${opts.maxNodes})`,
				);
				if (next.entry.depth + 1 <= opts.maxDepth) {
					enqueueEdges(result.node, next.entry.depth + 1, frontier, log);
				}
			} catch (e) {
				failed++;
				const msg = e instanceof Error ? e.message : String(e);
				log(`[w${workerId}] FAIL ${next.slug}: ${msg}`);
			} finally {
				inFlight--;
			}
		}
	};

	const workers = Array.from({ length: Math.max(1, opts.concurrency) }, (_, i) => start(i + 1));
	await Promise.all(workers);

	return {
		nodesWritten: cache.stats.written,
		revUpdates: cache.stats.revUpdates,
		durationMs: Date.now() - startedAt,
		failed,
	};
}

function enqueueEdges(
	node: NodePayload,
	depth: number,
	frontier: FrontierQueue,
	log: (s: string) => void,
): void {
	const collect = (e: EdgeRef): void => {
		const slug = makeSlug(e.type, e.name);
		const added = frontier.push(slug, { input: { type: e.type, name: e.name }, depth });
		if (added) log(`  + frontier ${slug} (depth=${depth})`);
	};
	const obj = node as unknown as Record<string, unknown>;
	for (const field of LIST_EDGES_BY_TYPE[node.type]) {
		const v = obj[field];
		if (Array.isArray(v)) for (const e of v as EdgeRef[]) collect(e);
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[node.type]) {
		const v = obj[field];
		if (v && typeof v === "object") collect(v as EdgeRef);
	}
}

function describeInput(input: AgentInput, fallbackSlug: Slug): string {
	if (input.type && input.name) return `${input.type}:${input.name}`;
	if (input.text) return `seed("${input.text}")`;
	return fallbackSlug;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
