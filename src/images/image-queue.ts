/**
 * Background queue that finds covers while a visitor browses (TRA-581, plan graph-integrity part 3b,
 * decision 3b-D4).
 *
 * Why it exists (2026-10-16): discography thumbnails stay gradients because ~94 % of the works a page
 * links to have no node, and resolving 30 to 90 covers at 1 req/s inside a request would hold it for a
 * minute and starve `/materialize`. So opening a page only enqueues; ONE worker resolves in FIFO order
 * at `background` priority (TRA-579) and writes the sidecar (TRA-580). Nodes are never written here:
 * the queue only calls `cache.get`.
 *
 * Safety before rate: any doubt about identity yields no image.
 *  - The key of a work without node is `makeScopedSlug(type, title, artist)`, computed from the hint
 *    the page displayed, never from the slug the client asked for. A bare slug (`project:3`) is only an
 *    alias of that key. Two different keys behind one bare slug make it a `conflict`: both keys are
 *    still resolved (each is served to its own page), the bare slug gets nothing.
 *  - A key whose sidecar file name would not be injective is refused (`unscopable`): `imageSidecarPath`
 *    folds every character outside [a-z0-9_-] to `_`, so `project:é` and `project:ö` would share a
 *    file and overwrite each other (finding left open by #499). Keys from `makeScopedSlug` and
 *    canonical node slugs are ASCII and always pass; a legacy non-canonical node simply gets no cover.
 *
 * Findings of the previous PRs, and where they land:
 *  - Stampede when a sidecar entry expires (#499): by construction. A key is queued once (dedup), the
 *    worker is sequential and re-reads the sidecar right before resolving, so a wave of expired
 *    entries costs one resolution per key, one at a time, at the MusicBrainz pace; it cannot burst.
 *  - Unbounded, uncancellable background wait in `mbFetch` (#500): partly handled. A job gets 20 s; at
 *    the deadline its `AbortSignal` aborts the `fetch` handed to the resolver, so every request the
 *    abandoned job issues afterwards (cover archive, iTunes, Wikidata, and the MusicBrainz requests of
 *    the node resolver) fails at once, and its late verdict is ignored. NOT handled: MusicBrainz
 *    requests of the hint resolver use the module's own fetch (`WorkResolveOptions` has no `fetch` or
 *    `signal`) and are not aborted; an aborted MusicBrainz request of the node resolver is retried by
 *    `mbFetch` (3 attempts), each retry reserving a background slot before failing at once. So an
 *    abandoned job wastes up to 3 slots, never a request. Bounded by the circuit breaker (3 timeouts pause
 *    the worker); the real fix is a `signal` through `mbFetch`, outside this ticket (follow-up ticket).
 *  - Alias table: plain aliases are evicted first-in-first-out beyond 20 000; a conflict is kept in its
 *    own set (same bound, never reached: 8 351 bare slugs exist today) so that eviction of aliases cannot
 *    make the second homonym look unique. Aliases live in memory only; the `conflict` sidecar entry (7
 *    days) is what survives a restart, for the service to read (3b.5).
 *
 * Known residual: `makeScopedSlug` follows `ODYSSEY_SCOPED_RELEASE_SLUGS` for the artist part (decision
 * of the ticket: the flag is not consulted here). With it off, "MØ" and "M" share a key; the pipeline
 * has the same collision today, and the 3b.5 service is the place to cross-check the page's artist.
 */
import type { NodeCache } from "../cache.js";
import { makeScopedSlug, parseSlug } from "../slug.js";
import type { ImageSource, NodePayload, Slug } from "../types.js";
import { isAllowedImageUrl } from "./hosts.js";
import {
	IMAGE_RULES_VERSION,
	type ImageSidecarEntry,
	isSidecarEntryFresh,
	readImageSidecar,
	writeImageSidecar,
} from "./image-sidecar.js";
import type { resolveImage } from "./resolve-image.js";
import type { resolveWorkImageByHint, WorkImageHint } from "./resolve-work-hint.js";

export interface ImageQueueLog {
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
}

export interface ImageQueueDeps {
	cacheDir: string;
	cache: NodeCache;
	resolveNode: typeof resolveImage;
	resolveHint: typeof resolveWorkImageByHint;
	fetch?: typeof fetch;
	now?: () => number;
	log: ImageQueueLog;
}

export type EnqueueOutcome =
	| { accepted: true; key: Slug }
	| { accepted: false; reason: "conflict" | "unscopable" | "full" };

export interface ImageQueueStats {
	pending: number;
	inFlight: 0 | 1;
	resolved: number;
	missing: number;
	unavailable: number;
	conflicts: number;
	dropped: number;
	skipped: number;
	paused: boolean;
}

export interface ImageQueue {
	/** Key = the node's slug. No-op (accepted) when the node already has an `image_url`. */
	enqueueNode(node: NodePayload): EnqueueOutcome;
	/** Key = `makeScopedSlug(hint.type, hint.title, hint.artist)`. */
	enqueueHint(hint: WorkImageHint): EnqueueOutcome;
	/** Queued or running → `pending`. */
	stateOf(key: Slug): "pending" | "idle";
	/** Slug of an edge (bare or scoped) → its key, `conflict`, or null when unknown. */
	aliasOf(slug: Slug): Slug | "conflict" | null;
	stats(): ImageQueueStats;
	/** Starts no further job, waits for the running one. Later enqueues are refused as `full`. */
	stop(): Promise<void>;
}

const MAX_QUEUED = 5_000;
const MAX_ALIASES = 20_000;
// Copied from `IMAGE_RESOLVE_TIMEOUT_MS` (src/pipeline.ts, TRA-479) rather than imported: pipeline.ts
// is not this module's to depend on, and the two bounds have different owners.
const JOB_TIMEOUT_MS = 20_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_PAUSE_MS = 60_000;

type Job = { key: Slug; kind: "node" } | { key: Slug; kind: "hint"; hint: WorkImageHint };

type Verdict =
	| { outcome: "found"; url: string; source: ImageSource; mbid?: string }
	| { outcome: "missing"; reason: "ambiguous" | "no-match" }
	| { outcome: "unavailable" };

/** True when the key's sidecar file name cannot be shared with another key. */
function isFileInjective(key: string): boolean {
	try {
		return /^[a-z0-9_-]+$/.test(parseSlug(key).body);
	} catch {
		return false;
	}
}

/** `fetch` that fails at once once `signal` is aborted, and otherwise aborts with it. */
function guardedFetch(base: typeof fetch | undefined, signal: AbortSignal): typeof fetch {
	return (input, init) => {
		if (signal.aborted) return Promise.reject(signal.reason);
		const merged = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
		return (base ?? fetch)(input, { ...init, signal: merged });
	};
}

export function createImageQueue(deps: ImageQueueDeps): ImageQueue {
	const { cacheDir, cache } = deps;
	// A broken logger must never kill the worker (an unhandled rejection would take the server down).
	const log: ImageQueueLog = {
		info: (msg, data) => {
			try {
				if (data) deps.log.info(msg, data);
				else deps.log.info(msg);
			} catch {}
		},
		warn: (msg, data) => {
			try {
				if (data) deps.log.warn(msg, data);
				else deps.log.warn(msg);
			} catch {}
		},
	};
	const now = deps.now ?? Date.now;

	const jobs = new Map<Slug, Job>(); // every queued or running key
	const queue: Job[] = []; // FIFO, waiting only
	const aliases = new Map<Slug, Slug>();
	const conflictSlugs = new Set<Slug>();
	const counters = { resolved: 0, missing: 0, unavailable: 0, conflicts: 0, dropped: 0, skipped: 0 };
	const writes = new Set<Promise<void>>();

	let running: Promise<void> | null = null;
	let inFlight: 0 | 1 = 0;
	let stopped = false;
	let paused = false;
	let consecutiveUnavailable = 0;
	let cancelPause: (() => void) | null = null;

	function push(job: Job): "queued" | "full" {
		if (stopped || jobs.size >= MAX_QUEUED) {
			counters.dropped++;
			return "full";
		}
		jobs.set(job.key, job);
		queue.push(job);
		running ??= runWorker();
		return "queued";
	}

	function enqueue(job: Job): EnqueueOutcome {
		if (jobs.has(job.key)) return { accepted: true, key: job.key };
		return push(job) === "full" ? { accepted: false, reason: "full" } : { accepted: true, key: job.key };
	}

	function track(write: Promise<void>): void {
		const p = write.finally(() => writes.delete(p));
		writes.add(p);
	}

	function writeEntry(entry: ImageSidecarEntry): Promise<void> {
		return writeImageSidecar(cacheDir, entry).catch((e: unknown) => {
			log.warn("image sidecar write failed", {
				key: entry.key,
				error: e instanceof Error ? e.message : String(e),
			});
		});
	}

	function rememberAlias(slug: Slug, key: Slug): void {
		aliases.delete(slug); // re-insertion refreshes the age
		aliases.set(slug, key);
		while (aliases.size > MAX_ALIASES) {
			const oldest = aliases.keys().next().value;
			if (oldest === undefined) break;
			aliases.delete(oldest);
		}
	}

	function markConflict(hint: WorkImageHint): void {
		aliases.delete(hint.slug);
		conflictSlugs.add(hint.slug);
		counters.conflicts++;
		while (conflictSlugs.size > MAX_ALIASES) {
			const oldest = conflictSlugs.values().next().value;
			if (oldest === undefined) break;
			conflictSlugs.delete(oldest);
		}
		if (!isFileInjective(hint.slug)) {
			log.warn("image conflict not persisted: slug is not file-safe", { slug: hint.slug });
			return;
		}
		track(
			(async () => {
				// The bare slug can also be the key of a resolved entry (a node `project:3`): that entry is a
				// verdict on a real work, a conflict marker must not replace it. The conflict then lives in memory.
				const existing = await readImageSidecar(cacheDir, hint.slug, now);
				if (existing && existing.state !== "conflict") {
					log.warn("image conflict kept in memory: slug is also a resolved key", { slug: hint.slug });
					return;
				}
				await writeEntry({
					key: hint.slug,
					state: "conflict",
					hint: { title: hint.title, artist: hint.artist },
					resolvedAt: new Date(now()).toISOString(),
					rules: IMAGE_RULES_VERSION,
				});
			})(),
		);
	}

	function enqueueHint(hint: WorkImageHint): EnqueueOutcome {
		// Called directly, not through the scoped-slug flag: the flag only governs the slugs the pipeline
		// emits (decision 3b-D3), never the identity of a displayed work.
		const scoped = makeScopedSlug(hint.type, hint.title, hint.artist);
		if (!scoped.ok || !isFileInjective(scoped.slug)) return { accepted: false, reason: "unscopable" };
		const key = scoped.slug;

		let conflict = false;
		if (hint.slug !== key) {
			if (conflictSlugs.has(hint.slug)) conflict = true;
			else {
				const known = aliases.get(hint.slug);
				if (known === undefined) rememberAlias(hint.slug, key);
				else if (known !== key) {
					markConflict(hint);
					conflict = true;
				}
			}
		}
		const outcome = enqueue({ key, kind: "hint", hint });
		return conflict ? { accepted: false, reason: "conflict" } : outcome;
	}

	function enqueueNode(node: NodePayload): EnqueueOutcome {
		if (node.image_url) return { accepted: true, key: node.slug };
		if (!isFileInjective(node.slug)) return { accepted: false, reason: "unscopable" };
		return enqueue({ key: node.slug, kind: "node" });
	}

	/** Resolve under the job deadline; the signal aborts the requests the job makes past it. */
	async function underDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const ctrl = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const timedOut = new Error("image job timed out");
				ctrl.abort(timedOut);
				reject(timedOut);
			}, JOB_TIMEOUT_MS);
		});
		try {
			return await Promise.race([run(ctrl.signal), deadline]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function resolveJob(job: Job, node: NodePayload | null): Promise<Verdict> {
		try {
			return await underDeadline(async (signal): Promise<Verdict> => {
				const fetchImpl = guardedFetch(deps.fetch, signal);
				if (job.kind === "node" && node) {
					const outage = { musicBrainz: false };
					const found = await deps.resolveNode(node, {
						cache,
						fetch: fetchImpl,
						priority: "background",
						viaMusicBrainz: true,
						outage,
					});
					// No image and a MusicBrainz outage on the way: nothing is known, so nothing is refused for 7 days.
					if (!found)
						return outage.musicBrainz
							? { outcome: "unavailable" }
							: { outcome: "missing", reason: "no-match" };
					return { outcome: "found", url: found.url, source: found.source };
				}
				if (job.kind !== "hint") return { outcome: "unavailable" };
				const r = await deps.resolveHint(job.hint, {
					fetch: fetchImpl,
					mbOptions: { priority: "background" },
					compilations: true,
				});
				if (r.kind === "found") {
					return {
						outcome: "found",
						url: r.url,
						source: r.source,
						...(r.mbid ? { mbid: r.mbid } : {}),
					};
				}
				return r.kind === "missing" ? { outcome: "missing", reason: r.reason } : { outcome: "unavailable" };
			});
		} catch (e) {
			log.warn("image job failed", { key: job.key, error: e instanceof Error ? e.message : String(e) });
			return { outcome: "unavailable" };
		}
	}

	function toEntry(job: Job, verdict: Verdict, node: NodePayload | null): ImageSidecarEntry {
		const hint =
			job.kind === "hint"
				? { title: job.hint.title, artist: job.hint.artist }
				: { title: node?.name ?? "", artist: "" };
		const base = {
			key: job.key,
			hint,
			resolvedAt: new Date(now()).toISOString(),
			rules: IMAGE_RULES_VERSION,
		};
		switch (verdict.outcome) {
			case "found":
				return {
					...base,
					state: "found",
					url: verdict.url,
					source: verdict.source,
					...(verdict.mbid ? { mbid: verdict.mbid } : {}),
				};
			case "missing":
				return { ...base, state: "missing", reason: verdict.reason };
			case "unavailable":
				return { ...base, state: "unavailable" };
		}
	}

	function recordOutcome(outcome: Verdict["outcome"] | "skipped"): void {
		if (outcome === "skipped") {
			counters.skipped++; // no request was made: says nothing about upstream health
			return;
		}
		counters[outcome === "found" ? "resolved" : outcome]++;
		if (outcome !== "unavailable") {
			consecutiveUnavailable = 0;
			return;
		}
		if (++consecutiveUnavailable >= BREAKER_THRESHOLD) {
			consecutiveUnavailable = 0;
			paused = true;
			log.warn("image queue paused", { reason: "consecutive unavailable", ms: BREAKER_PAUSE_MS });
		}
	}

	async function handleJob(job: Job): Promise<Verdict["outcome"] | "skipped"> {
		// A fresh `conflict` entry under a node's own slug also stops that node: a bare slug shared by two
		// works has no picture to give (3b-D3), and TRA-489 is what sets `image_url` on nodes.
		const existing = await readImageSidecar(cacheDir, job.key, now);
		if (existing && isSidecarEntryFresh(existing, now)) return "skipped";

		let node: NodePayload | null = null;
		if (job.kind === "node") {
			try {
				node = await cache.get(job.key);
			} catch (e) {
				log.warn("image job node unreadable", {
					key: job.key,
					error: e instanceof Error ? e.message : String(e),
				});
				return "skipped";
			}
			if (node.image_url) return "skipped"; // it got its picture since it was queued
		}

		let verdict = await resolveJob(job, node);
		if (verdict.outcome === "found" && !isAllowedImageUrl(verdict.url)) {
			log.warn("image refused: host not allowed", { key: job.key });
			verdict = { outcome: "missing", reason: "no-match" };
		}
		await writeEntry(toEntry(job, verdict, node));
		return verdict.outcome;
	}

	async function runWorker(): Promise<void> {
		try {
			while (!stopped) {
				if (paused) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, BREAKER_PAUSE_MS);
						timer.unref?.(); // an idle queue must not keep the process alive
						cancelPause = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					cancelPause = null;
					if (stopped) break;
					paused = false;
					log.warn("image queue resumed");
				}
				const job = queue.shift();
				if (!job) break; // asleep: the next enqueue starts the worker again
				const started = now();
				inFlight = 1;
				let outcome: Verdict["outcome"] | "skipped" = "unavailable";
				try {
					outcome = await handleJob(job);
				} catch (e) {
					log.warn("image job crashed", { key: job.key, error: e instanceof Error ? e.message : String(e) });
				} finally {
					jobs.delete(job.key);
					inFlight = 0;
				}
				recordOutcome(outcome);
				log.info("image job", { key: job.key, kind: job.kind, outcome, ms: now() - started });
			}
		} finally {
			running = null;
		}
	}

	return {
		enqueueNode,
		enqueueHint,
		stateOf: (key) => (jobs.has(key) ? "pending" : "idle"),
		aliasOf: (slug) => (conflictSlugs.has(slug) ? "conflict" : (aliases.get(slug) ?? null)),
		stats: () => ({ pending: queue.length, inFlight, paused, ...counters }),
		async stop() {
			stopped = true;
			cancelPause?.();
			for (const waiting of queue.splice(0)) jobs.delete(waiting.key);
			await running;
			await Promise.all([...writes]);
		},
	};
}
