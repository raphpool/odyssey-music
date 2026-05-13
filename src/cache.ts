import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { reverseFor, reversibleFields } from "./reverse-edges.js";
import { nodePayloadSchema } from "./schemas.js";
import { parseSlug } from "./slug.js";
import type { EdgeRef, NodePayload, Slug } from "./types.js";

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
	private pendingLoaded = false;
	public readonly stats: CacheStats = { written: 0, revUpdates: 0 };

	constructor(root: string) {
		this.root = root;
	}

	private async runLocked<T>(slug: Slug, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(slug) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.locks.set(
			slug,
			next.catch(() => undefined),
		);
		try {
			return await next;
		} finally {
			if (this.locks.get(slug) === (next as Promise<unknown>).catch(() => undefined)) {
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
		this.pendingLoaded = true;
		try {
			const raw = await readFile(this.pendingFile(), "utf8");
			this.pendingReverses = JSON.parse(raw) as Record<string, PendingReverse[]>;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			this.pendingReverses = {};
		}
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

	async get(slug: Slug): Promise<NodePayload | null> {
		try {
			const raw = await readFile(this.pathFor(slug), "utf8");
			const obj = JSON.parse(raw) as unknown;
			return nodePayloadSchema.parse(obj) as NodePayload;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
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
	 * Write a node payload. Validates against the schema, merges any pending reverse edges
	 * that were enqueued for this slug before it was materialized, then emits forward
	 * edges as reverse updates on the target nodes (materializing them if cached, or
	 * queueing pendings otherwise).
	 */
	async write(node: NodePayload): Promise<void> {
		const parsed = nodePayloadSchema.parse(node) as NodePayload;
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
	}

	private async emitReverses(source: NodePayload): Promise<void> {
		const sourceEdge: EdgeRef = { slug: source.slug, type: source.type, name: source.name };
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
			const existing = await this.get(target);
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

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await rename(tmp, file);
}
