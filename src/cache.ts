import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNotFoundError, NotFoundError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";
import {
	isEmittedPendingReverse,
	mergeReverseEdge,
	reverseEdgeFor,
	reverseFor,
	reversibleFields,
} from "./reverse-edges.js";
import { nodePayloadSchema, readNodePayloadSchema } from "./schemas.js";
import { isValidSlug, parseSlug } from "./slug.js";
import type { EdgeRef, NodePayload, Slug } from "./types.js";

const log = logger.child({ module: "cache" });

// Slugs already reported by get() as non-canonical (TRA-501). Module-level, not per NodeCache: the graph
// builder creates a fresh NodeCache on every /data.json rebuild, and a per-instance set would repeat the
// same line for every legacy node each time.
const warnedNonCanonical = new Set<string>();

/** Tests only: forget which non-canonical slugs were already logged. */
export function resetNonCanonicalSlugWarnings(): void {
	warnedNonCanonical.clear();
}

export interface PendingReverse {
	field: string;
	cardinality: "list" | "single";
	edge: EdgeRef;
}

export interface CacheStats {
	written: number;
	revUpdates: number;
}

interface CacheWriteDelta {
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
	private readonly operationLocks = new Map<string, Promise<unknown>>();
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
	// stale snapshot as the memo forever. write() now invalidates a second time after the node
	// has actually landed on disk (in a finally, so a throw from emitReverses/flushPending
	// can't skip it either), so no build window can miss it -- PROVIDED the commit guard checks
	// the live genreQidIndexVersion (not a frozen copy on the build's own tracker object): a
	// build still in flight when either invalidation fires keeps its tracker object untouched
	// (write() only ever touches genreQidIndex/genreQidIndexVersion), so a guard compared
	// against that stale tracker would trivially match itself and commit anyway, overwriting
	// the null the invalidation had just set. See getOrBuildGenreQidIndex's commit closure.
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

	private async runOperationLocked<T>(slug: Slug, fn: () => Promise<T>): Promise<T> {
		const prev = this.operationLocks.get(slug) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const stored = next.catch(() => undefined);
		this.operationLocks.set(slug, stored);
		try {
			return await next;
		} finally {
			if (this.operationLocks.get(slug) === stored) {
				this.operationLocks.delete(slug);
			}
		}
	}

	/**
	 * Node file for `slug`. Throws (invariant) when the body could leave `nodes/<type>/`.
	 *
	 * 2026-10-15 (TRA-502): `GET /node/artist:..%2F..%2Foutside` is decoded to `artist:../../outside`
	 * by the server and used to resolve to a `.json` file outside the cache root (served when it
	 * parsed as a node). Every route and every reverse-edge write funnels through here, so the
	 * check lives here rather than in each handler. Legacy non-canonical bodies WITHOUT a path
	 * separator (spaces, dots, upper case) stay valid: they exist on disk and must stay readable.
	 */
	private pathFor(slug: Slug): string {
		const { type, body } = parseSlug(slug);
		if (!isPathSafeBody(body)) {
			throw new Error("Unsafe slug body: path separators, '..' and NUL are not allowed");
		}
		const typeDir = join(this.root, "nodes", type);
		const file = join(typeDir, `${body}.json`);
		// Belt and braces: whatever the body contains, the file must be a direct child of typeDir.
		if (dirname(file) !== typeDir) {
			throw new Error("Unsafe slug body: resolved outside nodes/<type>/");
		}
		return file;
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
		if (!isPathSafeSlug(slug)) return false;
		try {
			await readFile(this.pathFor(slug), "utf8");
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw e;
		}
	}

	async get(slug: Slug): Promise<NodePayload> {
		// Outside the try on purpose: an unsafe slug is a client error (400), not "invalid cached data",
		// and it must be rejected before any filesystem access.
		if (!isPathSafeSlug(slug)) throw new ValidationError("Invalid slug");
		try {
			const raw = await readFile(this.pathFor(slug), "utf8");
			const obj = JSON.parse(raw) as unknown;
			const canonical = nodePayloadSchema.safeParse(obj);
			if (canonical.success) return canonical.data as NodePayload;
			// TRA-501: reading is tolerant of a slug that is merely non-canonical (a node written by a
			// deployed server before the canonical rule): it is served and logged, never a 500 on
			// /data.json or a node page. Only the slug rule differs between the two schemas, so
			// anything the read schema rejects too is genuinely invalid and still throws below.
			const legacy = readNodePayloadSchema.parse(obj) as NodePayload;
			if (!warnedNonCanonical.has(slug)) {
				warnedNonCanonical.add(slug);
				// `fields` names where the offending slug sits (e.g. "slug", "aliases.0.slug"), which is
				// what a production measurement needs to size a migration.
				const fields = [...new Set(canonical.error.issues.map((i) => i.path.join(".")))].slice(0, 10);
				log.warn("cached node has a non-canonical slug; served as-is", { slug, fields });
			}
			return legacy;
		} catch (e) {
			if (isNotFoundError(e)) throw new NotFoundError(`Node not found: ${slug}`, { cause: e });
			// 2026-10-15 (TRA-502): the message used to embed `e.message`, and for a non-JSON file
			// JSON.parse quotes the start of the content ("SECRET=hun"... is not valid JSON), which the
			// server then returned to the client. The detail stays in the log and in `cause`.
			log.warn("invalid cached node", { slug, error: e instanceof Error ? e.message : String(e) });
			throw new ValidationError(`Invalid cached node ${slug}`, { cause: e });
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

	// 2026-09-10 (TRA-28 review, B4): the commit guard below protects the MEMO (genreQidIndex)
	// from a stale write, but used to still hand the vetoed snapshot straight back to whichever
	// caller's own lookup triggered that build -- e.g. 8 concurrent crawler workers, one starts
	// this build, another writes a new genre node mid-build and bumps the version; the commit is
	// correctly vetoed so the memo stays clean, but the first caller's `findGenreSlugByQid` still
	// resolved with the pre-write snapshot, missing the new node, sending the genre registry down
	// rule 5 (mint) for a target that had just landed. Bounded retry loop: a build whose commit
	// was vetoed is retried against the (now current) version instead of being handed back as-is.
	private async getOrBuildGenreQidIndex(): Promise<Map<string, Slug>> {
		const maxAttempts = 3;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (this.genreQidIndex) return this.genreQidIndex;
			const startedAtVersion = this.genreQidIndexVersion;
			// A build already in flight, tagged with the version in effect when IT started, is
			// stale to share if a genre write() has landed since (bumping the version): start a
			// fresh build instead of awaiting a result that won't reflect that write.
			if (!this.genreQidIndexBuild || this.genreQidIndexBuild.version !== startedAtVersion) {
				const promise = this.buildGenreQidIndex().then(
					(index) => {
						// 2026-09-09: this used to gate the commit on `genreQidIndexBuild.version`
						// instead of the live `genreQidIndexVersion`. write()'s invalidations (entry
						// and exit) only ever touch genreQidIndex/genreQidIndexVersion, never this
						// build's own tracker object -- so a build still in flight when a write
						// invalidated survived with its tracker untouched, and its guard trivially
						// matched itself, committing a stale snapshot straight over the fresh null a
						// write had *just* set. Comparing against the live version instead means ANY
						// invalidation that happened anywhere during this build's lifetime -- not
						// just a newer build replacing the tracker -- correctly vetoes the commit.
						if (this.genreQidIndexVersion === startedAtVersion) {
							this.genreQidIndex = index;
						}
						// Only clear the tracker if it's still ours to clear -- a newer build may
						// have already replaced it with its own.
						if (this.genreQidIndexBuild?.version === startedAtVersion) {
							this.genreQidIndexBuild = null;
						}
						return index;
					},
					(err: unknown) => {
						// Don't let a failed build (e.g. a transient read error) permanently poison
						// the memo: clear it so the next call retries instead of re-throwing forever.
						if (this.genreQidIndexBuild?.version === startedAtVersion) {
							this.genreQidIndexBuild = null;
						}
						throw err;
					},
				);
				this.genreQidIndexBuild = { version: startedAtVersion, promise };
			}
			const index = await this.genreQidIndexBuild.promise;
			// Commit succeeded (reference equality: the memo was set to THIS build's own result,
			// meaning the version never moved during it) -- safe to hand back.
			if (this.genreQidIndex === index) return index;
			// Vetoed: a write landed during this build, so `index` may be missing it. Retry
			// against the (now current) version rather than returning a known-stale snapshot.
			if (attempt === maxAttempts) {
				log.warn("genre qid index build repeatedly raced a concurrent write; returning last snapshot", {
					attempts: maxAttempts,
				});
				return index;
			}
		}
		// Unreachable: the loop above always returns by its last iteration.
		throw new Error("unreachable: getOrBuildGenreQidIndex exhausted its retry loop");
	}

	private async buildGenreQidIndex(): Promise<Map<string, Slug>> {
		// Canonical slugs only (TRA-501): the index answers "which node should a NEW edge point at", and
		// a new edge must carry a canonical slug (write validation). A legacy-named file would be picked
		// as the target, then fail validateNode and turn /materialize into a 500.
		const slugs = (await this.listSlugs()).filter((s) => s.startsWith("genre:") && isValidSlug(s));
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
			if (node.type !== "genre" || !node.qid || !isValidSlug(node.slug)) continue;
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
			// Preserve the eager invalidation contract: concurrent QID lookups must not reuse a
			// memo from before a write that has already been requested but is still queued.
			this.genreQidIndex = null;
			this.genreQidIndexVersion++;
		}
		await this.runOperationLocked(parsed.slug, async () => {
			await this.writeParsed(parsed, { written: 0, revUpdates: 0 }, true);
		});
	}

	private async writeParsed(
		parsed: NodePayload,
		delta: CacheWriteDelta,
		alreadyInvalidated = false,
	): Promise<void> {
		if (parsed.type === "genre" && !alreadyInvalidated) {
			// First invalidation, on entry: covers any build that started before this write and
			// is still in flight, and rules out a stale-but-not-yet-invalidated index being
			// handed out to a caller between now and the node actually landing on disk below.
			this.genreQidIndex = null;
			this.genreQidIndexVersion++;
		}
		try {
			await this.loadPending();
			await this.runLocked(parsed.slug, () => this.commitLocked(parsed, delta));
			// Now emit reverse edges to target nodes (outside the source slug's lock to avoid deadlocks).
			await this.emitReverses(parsed, delta);
			await this.flushPending();
		} finally {
			// 2026-09-09: emitReverses/flushPending can throw after the source node itself is
			// already on disk (e.g. a target of a reverse edge fails to validate on read). The
			// second invalidation must still run on that path — it was previously a plain
			// statement after the try body, so a throw here skipped it and left a build that
			// raced this write memoized on a stale, pre-write snapshot forever.
			if (parsed.type === "genre") {
				// Second invalidation, after the node has actually landed on disk: a build that
				// started between the first invalidation above and this point could have read a
				// disk snapshot still missing this node. Bumping the version here — checked
				// against the live genreQidIndexVersion in getOrBuildGenreQidIndex's commit
				// guard, not a frozen copy — vetoes that build's commit even if it resolves
				// after this line runs, and guarantees the next lookup rebuilds from a disk that
				// has the write applied.
				this.genreQidIndex = null;
				this.genreQidIndexVersion++;
			}
		}
	}

	/**
	 * Writes `parsed` merged with the reverse edges pending for its slug. MUST run inside
	 * `runLocked(parsed.slug)` with the pending map loaded: write() and update() share this body so both
	 * apply the same pendings under the same lock.
	 */
	private async commitLocked(parsed: NodePayload, delta: CacheWriteDelta): Promise<void> {
		const pending = this.pendingReverses[parsed.slug] ?? [];
		// TRA-563: a pending entry written before the runtime stopped emitting unsafe directions (a credit on a
		// work from a namesake's list) is not applied. It stays on disk until the purge migration.
		const applicable: PendingReverse[] = [];
		const skipped: PendingReverse[] = [];
		for (const p of pending) {
			(isEmittedPendingReverse(parsed.type, p) ? applicable : skipped).push(p);
		}
		if (skipped.length) {
			log.warn("ignored unsafe pending reverse edges", { slug: parsed.slug, skipped: skipped.length });
		}
		const merged = applyReverses(parsed, applicable);
		// Re-validation of `parsed` (strictly validated by the caller) plus reverse edges queued
		// earlier: a legacy slug among them must not fail the write of a valid node (TRA-501).
		const validated = readNodePayloadSchema.parse(merged) as NodePayload;
		const file = this.pathFor(validated.slug);
		await mkdir(dirname(file), { recursive: true });
		await atomicWriteJson(file, validated);
		this.stats.written++;
		delta.written++;
		if (applicable.length) {
			if (skipped.length) this.pendingReverses[parsed.slug] = skipped;
			else delete this.pendingReverses[parsed.slug];
			this.pendingDirty = true;
		}
	}

	/**
	 * Locked read-modify-write of an existing node (TRA-535). `fn` receives the node as it is on disk NOW and
	 * returns the node to store, or `null` for "no change" (nothing is written, the pendings stay queued).
	 * Read, `fn`, strict validation and write all happen under the same per-slug lock as write() and as the
	 * reverse-edge application of other nodes, so a concurrent writer is never overwritten: the previous
	 * `get` + `replace` pair let a write slip in between and silently dropped its edges. The reverse edges
	 * pending for the node are merged like write() does.
	 *
	 * Errors from `fn` or from validation leave the file untouched; a failure after the write (reverse-edge
	 * emission, pending flush) restores the previous file like replace(). Returns whether a write happened;
	 * a missing node throws NotFoundError. `fn` runs while the lock is held: it must not call back into
	 * this cache for the same slug (it would wait on itself).
	 */
	async update(
		slug: Slug,
		fn: (current: NodePayload) => NodePayload | null | Promise<NodePayload | null>,
	): Promise<boolean> {
		// Same client-error guard as get(): an unsafe slug is rejected before any filesystem access.
		if (!isPathSafeSlug(slug)) throw new ValidationError("Invalid slug");
		const isGenre = parseSlug(slug).type === "genre";
		return await this.runOperationLocked(slug, async () => {
			const delta: CacheWriteDelta = { written: 0, revUpdates: 0 };
			const file = this.pathFor(slug);
			const backup = `${file}.backup-${process.pid}-${Math.random().toString(36).slice(2)}`;
			await this.loadPending();
			const committed = await this.runLocked(slug, async (): Promise<NodePayload | null> => {
				const current = await this.get(slug);
				const next = await fn(current);
				if (next === null) return null;
				const parsed = nodePayloadSchema.parse(next) as NodePayload;
				if (parsed.slug !== slug) {
					throw new Error(`update(${slug}) must not change the slug (got ${parsed.slug})`);
				}
				await copyFile(file, backup);
				if (isGenre) {
					this.genreQidIndex = null;
					this.genreQidIndexVersion++;
				}
				try {
					await this.commitLocked(parsed, delta);
				} catch (error) {
					// Nothing landed (validation or write failed): the file is intact, only the backup is left.
					await unlink(backup).catch(() => undefined);
					throw error;
				}
				return parsed;
			});
			if (committed === null) return false;
			try {
				try {
					await this.emitReverses(committed, delta);
					await this.flushPending();
				} catch (error) {
					this.stats.written -= delta.written;
					this.stats.revUpdates -= delta.revUpdates;
					try {
						await rename(backup, file);
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							`Failed to update ${slug} and restore its previous source file`,
						);
					}
					throw error;
				}
				await unlink(backup).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						log.warn("update backup cleanup failed", {
							slug,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				});
			} finally {
				if (isGenre) {
					// Same second invalidation as writeParsed: the node has landed (or been restored).
					this.genreQidIndex = null;
					this.genreQidIndexVersion++;
				}
			}
			return true;
		});
	}

	/**
	 * Replaces an existing node while preserving its exact source file if a later write phase
	 * fails. The source remains readable until its replacement lands, and the backup is renamed
	 * back rather than written again, so a failed flush or reverse edge update cannot turn a
	 * refresh failure into a second best-effort write.
	 */
	async replace(node: NodePayload): Promise<void> {
		const parsed = nodePayloadSchema.parse(node) as NodePayload;
		await this.runOperationLocked(parsed.slug, async () => {
			const file = this.pathFor(parsed.slug);
			const backup = `${file}.backup-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const delta: CacheWriteDelta = { written: 0, revUpdates: 0 };

			await copyFile(file, backup);
			try {
				await this.writeParsed(parsed, delta);
			} catch (error) {
				this.stats.written -= delta.written;
				this.stats.revUpdates -= delta.revUpdates;
				try {
					await rename(backup, file);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Failed to replace ${parsed.slug} and restore its previous source file`,
					);
				}
				throw error;
			}

			try {
				await unlink(backup);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					log.warn("replacement backup cleanup failed", {
						slug: parsed.slug,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		});
	}

	private async emitReverses(source: NodePayload, delta: CacheWriteDelta): Promise<void> {
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
			// The edge is built once per field by the helper shared with the backfill (TRA-624).
			const edge = reverseEdgeFor(source, reverse.field);
			if (!edge) continue;
			for (const targetRef of refs) {
				await this.applyReverseToTarget(targetRef.slug, reverse.field, reverse.cardinality, edge);
				this.stats.revUpdates++;
				delta.revUpdates++;
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
				const updated = applySingleReverse(
					existing,
					{ field, cardinality, edge: sourceEdge },
					mbidConflictLogger(target, field),
				);
				// `existing` may be a legacy node read tolerantly, `sourceEdge` comes from a node that
				// write()/replace() validated strictly: re-validate with the read rule so adding a
				// reverse edge never fails because of what the target already had (TRA-501).
				const validated = readNodePayloadSchema.parse(updated) as NodePayload;
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

function isPathSafeBody(body: string): boolean {
	return !(body.includes("/") || body.includes("\\") || body.includes("..") || body.includes("\0"));
}

/** True when `slug` is well formed and its body cannot leave `nodes/<type>/`. */
function isPathSafeSlug(slug: Slug): boolean {
	const idx = slug.indexOf(":");
	// Malformed slugs (no colon, bad type) are left to parseSlug's own error path.
	return idx < 0 || isPathSafeBody(slug.slice(idx + 1));
}

function applyReverses(node: NodePayload, pendings: PendingReverse[]): NodePayload {
	let cur = node;
	for (const p of pendings) {
		cur = applySingleReverse(cur, p, mbidConflictLogger(node.slug, p.field));
	}
	return cur;
}

// An mbid already on the target's edge wins over the one a reverse carries: report the disagreement so a
// wrong id on either side can be found, without touching either (TRA-624).
function mbidConflictLogger(target: Slug, field: string): (kept: EdgeRef, incoming: EdgeRef) => void {
	return (kept, incoming) =>
		log.warn("reverse edge mbid differs from the one on the target: kept the existing one", {
			target,
			field,
			slug: kept.slug,
			kept: kept.mbid,
			incoming: incoming.mbid,
		});
}

// Exported for the reverse-edge backfill (TRA-486), which applies the same rule to raw nodes without going
// through NodeCache.write (that would re-emit reverses of the reverses).
export function applySingleReverse(
	node: NodePayload,
	p: PendingReverse,
	onMbidConflict?: (kept: EdgeRef, incoming: EdgeRef) => void,
): NodePayload {
	// Clone shallowly; nested edge arrays we deep-copy to avoid mutating callers.
	const next = { ...node } as unknown as Record<string, unknown>;
	if (p.cardinality === "list") {
		const cur = Array.isArray(next[p.field]) ? ([...(next[p.field] as EdgeRef[])] as EdgeRef[]) : [];
		const at = cur.findIndex((e) => e.slug === p.edge.slug);
		const held = cur[at];
		if (!held) {
			cur.push(p.edge);
		} else {
			// TRA-624 (2026-10-24): an edge already there is enriched, never replaced. Rewriting a project
			// with an mbid left `artist.discography` without it, so "discography without mbid" never went down.
			const merged = mergeReverseEdge(held, p.edge);
			cur[at] = merged.edge;
			if (merged.mbidConflict) onMbidConflict?.(held, p.edge);
		}
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
