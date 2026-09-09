import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNotFoundError, NotFoundError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";
import { reverseFor, reversibleFields } from "./reverse-edges.js";
import { nodePayloadSchema } from "./schemas.js";
import { parseSlug } from "./slug.js";
import type { EdgeRef, NodePayload, Slug } from "./types.js";

const log = logger.child({ module: "cache" });

export interface PendingReverse {
	field: string;
	cardinality: "list" | "single";
	edge: EdgeRef;
}

export interface CacheStats {
	written: number;
	revUpdates: number;
}

/**
 * Slug-keyed on-disk cache.
 *
 * Layout:
 *   <root>/nodes/<type>/<body>.json
 *   <root>/pending-reverses.json   (JSON map: slug -> PendingReverse[])
 *
 * Concurrency: per-slug mutex around any read-modify-write sequence.
 */
export class NodeCache {
	private readonly root: string;
	private readonly locks = new Map<string, Promise<unknown>>();
	private pendingReverses: Record<string, PendingReverse[]> = {};
	private pendingDirty = false;
	private pendingLoading: Promise<void> | null = null;
	private pendingLoaded = false;
	// Memoized qid -> slug index for genre nodes, built lazily and thrown away on any genre
	// write (see write()). Null means "not built yet". genreQidIndexBuild tracks a build in
	// progress, tagged with the version it started at, so concurrent callers share one
	// promise (no double build) while a write that lands mid-build (bumping the version)
	// makes the NEXT caller start a fresh build instead of awaiting the now-stale one.
	//
	// 2026-09-09: write() used to bump the version only on entry, synchronously, before the
	// node file was actually on disk (loadPending -> runLocked -> mkdir -> atomicWriteJson ->
	// rename all still had to happen). A build that started after that bump but before the
	// rename landed would read a disk that didn't have the new node yet, then commit that
	// stale snapshot as the memo forever (the version had already moved, so the build's own
	// guard saw no further invalidation to defer to). write() now invalidates a second time
	// after the node has actually landed on disk, so no build window can miss it.
	private genreQidIndex: Map<string, Slug> | null = null;
	private genreQidIndexBuild: { version: number; promise: Promise<Map<string, Slug>> } | null = null;
	private genreQidIndexVersion = 0;
	public readonly stats: CacheStats = { written: 0, revUpdates: 0 };

	constructor(root: string) {
		this.root = root;
	}

	private async runLocked<T>(slug: Slug, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(slug) ?? Promise.resolve();
		// IMPORTANT: store the same swallowed-promise reference we use for the identity comparison
		// in finally, so the lock entry gets cleaned up when the chain idles.
		const next = prev.then(fn, fn);
		const stored = next.catch(() => undefined);
		this.locks.set(slug, stored);
		try {
			return await next;
		} finally {
			if (this.locks.get(slug) === stored) {
				this.locks.delete(slug);
			}
		}
	}

	private pathFor(slug: Slug): string {
		const { type, body } = parseSlug(slug);
		return join(this.root, "nodes", type, `${body}.json`);
	}

	private pendingFile(): string {
		return join(this.root, "pending-reverses.json");
	}

	private async loadPending(): Promise<void> {
		if (this.pendingLoaded) return;
		// Concurrent callers must all wait on the SAME promise, otherwise multiple readers can
		// race and one can finish before the other has read, observing an empty map.
		if (!this.pendingLoading) {
			this.pendingLoading = (async () => {
				try {
					const raw = await readFile(this.pendingFile(), "utf8");
					this.pendingReverses = JSON.parse(raw) as Record<string, PendingReverse[]>;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
					this.pendingReverses = {};
				} finally {
					this.pendingLoaded = true;
				}
			})();
		}
		await this.pendingLoading;
	}

	private async flushPending(): Promise<void> {
		if (!this.pendingDirty) return;
		const file = this.pendingFile();
		await mkdir(dirname(file), { recursive: true });
		await atomicWriteJson(file, this.pendingReverses);
		this.pendingDirty = false;
	}

	async has(slug: Slug): Promise<boolean> {
		try {
			await readFile(this.pathFor(slug), "utf8");
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw e;
		}
	}

	async get(slug: Slug): Promise<NodePayload> {
		try {
			const raw = await readFile(this.pathFor(slug), "utf8");
			const obj = JSON.parse(raw) as unknown;
			return nodePayloadSchema.parse(obj) as NodePayload;
		} catch (e) {
			if (isNotFoundError(e)) throw new NotFoundError(`Node not found: ${slug}`, { cause: e });
			throw new ValidationError(
				`Invalid cached node ${slug}: ${e instanceof Error ? e.message : String(e)}`,
				{
					cause: e,
				},
			);
		}
	}

	async listSlugs(): Promise<Slug[]> {
		const { readdir } = await import("node:fs/promises");
		const out: Slug[] = [];
		const typesDir = join(this.root, "nodes");
		let typeDirs: string[];
		try {
			typeDirs = await readdir(typesDir);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
		for (const t of typeDirs) {
			let files: string[];
			try {
				files = await readdir(join(typesDir, t));
			} catch {
				continue;
			}
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				out.push(`${t}:${f.slice(0, -5)}` as Slug);
			}
		}
		return out;
	}

	/**
	 * Find the slug of the existing genre node carrying a given Wikidata QID, if any.
	 *
	 * 2026-09-09: the slug of a genre node has always been a pure function of its *name*
	 * (makeSlug), never of its resolved identity — nothing could answer "does a genre node
	 * for this QID already exist?" This caused 20 groups of duplicate genre nodes sharing a
	 * QID (e.g. "Electronic" / "Electronic music", "idm" / "intelligent-dance-music"). This
	 * index is the first brick of duplicate prevention: pure read, no consumer yet.
	 *
	 * Built lazily on first call by scanning every `genre:` slug via get() (so qid is
	 * Zod-validated), then memoized until the next genre write() invalidates it (write()
	 * invalidates both on entry and again once the node has landed on disk — see the
	 * genreQidIndex field comment). A genre file that fails validation (e.g. a qid violating
	 * QID_PATTERN) is skipped with a warning rather than failing the whole build.
	 *
	 * Accepted risk, documented in docs/plans/qid-genre-identity.md (Décisions d'archi /
	 * Risques): this index is process-scoped, same as the existing pendingReverses memo on
	 * this class — a one-off `--apply` run and a long-lived server each hold their own copy,
	 * so nothing propagates a write from one process to another.
	 */
	async findGenreSlugByQid(qid: string): Promise<Slug | undefined> {
		if (!qid) return undefined;
		const index = await this.getOrBuildGenreQidIndex();
		return index.get(qid);
	}

	private async getOrBuildGenreQidIndex(): Promise<Map<string, Slug>> {
		if (this.genreQidIndex) return this.genreQidIndex;
		const startedAtVersion = this.genreQidIndexVersion;
		// A build already in flight for an older version is stale: a genre write() landed
		// mid-build and bumped the version. Start a fresh build instead of awaiting a result
		// that won't reflect that write.
		if (!this.genreQidIndexBuild || this.genreQidIndexBuild.version !== startedAtVersion) {
			const promise = this.buildGenreQidIndex().then(
				(index) => {
					// Only commit if nothing invalidated the index again while we were building.
					if (this.genreQidIndexBuild?.version === startedAtVersion) {
						this.genreQidIndex = index;
						this.genreQidIndexBuild = null;
					}
					return index;
				},
				(err: unknown) => {
					// Don't let a failed build (e.g. one bad cache file) permanently poison the
					// memo: clear it so the next call retries instead of re-throwing forever.
					if (this.genreQidIndexBuild?.version === startedAtVersion) {
						this.genreQidIndexBuild = null;
					}
					throw err;
				},
			);
			this.genreQidIndexBuild = { version: startedAtVersion, promise };
		}
		return this.genreQidIndexBuild.promise;
	}

	private async buildGenreQidIndex(): Promise<Map<string, Slug>> {
		const slugs = (await this.listSlugs()).filter((s) => s.startsWith("genre:"));
		// Collect every candidate per qid first so collisions (multiple genre nodes sharing a
		// qid, a transient pre-merge state) can be resolved deterministically below.
		const candidates = new Map<string, Slug[]>();
		for (const slug of slugs) {
			let node: NodePayload;
			try {
				node = await this.get(slug);
			} catch (e) {
				// A single malformed genre file (e.g. a qid violating QID_PATTERN) must not
				// fail the whole build — that would take every other qid lookup down with it.
				// Skip it and keep going; it stays invisible to the index until fixed.
				log.warn("skipping invalid genre node while building qid index", {
					slug,
					error: e instanceof Error ? e.message : String(e),
				});
				continue;
			}
			// Narrow on the validated type discriminant (not a cast) so a node misfiled under
			// nodes/genre/ with a different type can't leak a same-shaped field into the index.
			if (node.type !== "genre" || !node.qid) continue;
			const list = candidates.get(node.qid) ?? [];
			list.push(slug);
			candidates.set(node.qid, list);
		}
		const index = new Map<string, Slug>();
		for (const [nodeQid, list] of candidates) {
			// Deterministic collision pick: shortest slug, then lexicographic. Matches the
			// most-used member in 18 of the 20 current duplicate groups; the merge redirects
			// the others.
			const winner = [...list].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
			if (winner) index.set(nodeQid, winner);
		}
		return index;
	}

	/**
	 * Write a node payload. Validates against the schema, merges any pending reverse edges
	 * that were enqueued for this slug before it was materialized, then emits forward
	 * edges as reverse updates on the target nodes (materializing them if cached, or
	 * queueing pendings otherwise).
	 */
	async write(node: NodePayload): Promise<void> {
		const parsed = nodePayloadSchema.parse(node) as NodePayload;
		if (parsed.type === "genre") {
			// First invalidation, on entry: covers any build that started before this write and
			// is still in flight, and rules out a stale-but-not-yet-invalidated index being
			// handed out to a caller between now and the node actually landing on disk below.
			this.genreQidIndex = null;
			this.genreQidIndexVersion++;
		}
		await this.loadPending();
		await this.runLocked(parsed.slug, async () => {
			const pending = this.pendingReverses[parsed.slug] ?? [];
			const merged = applyReverses(parsed, pending);
			const validated = nodePayloadSchema.parse(merged) as NodePayload;
			const file = this.pathFor(validated.slug);
			await mkdir(dirname(file), { recursive: true });
			await atomicWriteJson(file, validated);
			this.stats.written++;
			if (pending.length) {
				delete this.pendingReverses[parsed.slug];
				this.pendingDirty = true;
			}
		});
		// Now emit reverse edges to target nodes (outside the source slug's lock to avoid deadlocks).
		await this.emitReverses(parsed);
		await this.flushPending();
		if (parsed.type === "genre") {
			// Second invalidation, after the node has actually landed on disk: a build that
			// started between the first invalidation above and this point could have read a
			// disk snapshot still missing this node, then committed that stale result as the
			// memo (the version guard only defers to invalidations it can still observe). This
			// bump guarantees the next lookup rebuilds from a disk that has the write applied.
			this.genreQidIndex = null;
			this.genreQidIndexVersion++;
		}
	}

	private async emitReverses(source: NodePayload): Promise<void> {
		// A genre source's qid rides along on the reverse edge it emits (TRA-18).
		const sourceEdge: EdgeRef =
			source.type === "genre" && source.qid
				? { slug: source.slug, type: source.type, name: source.name, qid: source.qid }
				: { slug: source.slug, type: source.type, name: source.name };
		const fields = reversibleFields(source.type);
		for (const field of fields) {
			const value = (source as unknown as Record<string, unknown>)[field];
			const refs: EdgeRef[] = Array.isArray(value)
				? (value as EdgeRef[])
				: value && typeof value === "object"
					? [value as EdgeRef]
					: [];
			const reverse = reverseFor(source.type, field);
			if (!reverse) continue;
			for (const targetRef of refs) {
				await this.applyReverseToTarget(targetRef.slug, reverse.field, reverse.cardinality, sourceEdge);
				this.stats.revUpdates++;
			}
		}
	}

	private async applyReverseToTarget(
		target: Slug,
		field: string,
		cardinality: "list" | "single",
		sourceEdge: EdgeRef,
	): Promise<void> {
		await this.runLocked(target, async () => {
			const existing = await this.get(target).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
			if (existing) {
				const updated = applySingleReverse(existing, { field, cardinality, edge: sourceEdge });
				const validated = nodePayloadSchema.parse(updated) as NodePayload;
				const file = this.pathFor(validated.slug);
				await mkdir(dirname(file), { recursive: true });
				await atomicWriteJson(file, validated);
			} else {
				const list = this.pendingReverses[target] ?? [];
				list.push({ field, cardinality, edge: sourceEdge });
				this.pendingReverses[target] = list;
				this.pendingDirty = true;
			}
		});
	}
}

function applyReverses(node: NodePayload, pendings: PendingReverse[]): NodePayload {
	let cur = node;
	for (const p of pendings) {
		cur = applySingleReverse(cur, p);
	}
	return cur;
}

function applySingleReverse(node: NodePayload, p: PendingReverse): NodePayload {
	// Clone shallowly; nested edge arrays we deep-copy to avoid mutating callers.
	const next = { ...node } as unknown as Record<string, unknown>;
	if (p.cardinality === "list") {
		const cur = Array.isArray(next[p.field]) ? ([...(next[p.field] as EdgeRef[])] as EdgeRef[]) : [];
		if (!cur.some((e) => e.slug === p.edge.slug)) cur.push(p.edge);
		next[p.field] = cur;
	} else {
		// Singular: only set if currently empty (don't clobber an explicit value).
		if (next[p.field] == null) next[p.field] = p.edge;
	}
	return next as unknown as NodePayload;
}

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await rename(tmp, file);
}
