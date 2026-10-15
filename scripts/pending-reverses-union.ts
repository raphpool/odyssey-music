/**
 * Union of two `pending-reverses.json` files (repo + server snapshot) for the migration channel
 * of deploy/sync-genre-cache.sh -- TRA-499.
 *
 * `pending-reverses.json` maps a not-yet-materialized target slug to the reverse edges to apply
 * when that node is first written (NodeCache.write). Migrations rewrite it (rewritePendingReverses:
 * keys and edge slugs), so a migration run must start from ONE coherent file and ship the rewritten
 * result: shipping only `nodes/` left prod with the old file, whose keys name slugs the migration
 * had just renamed -- the reverse edges were lost or landed on stale slugs.
 *
 * Merge rules (decisions recorded here because the ticket left them open):
 *  - per target key, the repo's list first, then the server's; entries are de-duplicated by
 *    (`field`, `edge.slug`) and the first one (the repo's) wins;
 *  - a key whose target ALREADY exists in the union is KEPT. NodeCache.write applies a node's
 *    pending reverses on its next write and only then deletes the key, so keeping it loses nothing,
 *    whereas dropping it would lose edges and applying it here would make this script a second
 *    writer of node files (the cache's write code is out of scope). Such keys are only counted;
 *  - both files are untrusted data (the server's comes off a remote disk): a malformed one is
 *    refused, never "repaired".
 */
import { readFile } from "node:fs/promises";
import type { PendingReverse } from "../src/cache.js";
import { isNotFoundError } from "../src/errors.js";
import { isValidSlug } from "../src/slug.js";

export type PendingReversesMap = Record<string, PendingReverse[]>;

export type PendingReversesParse = { ok: true; value: PendingReversesMap } | { ok: false; error: string };

export interface PendingReversesSummary {
	repoKeys: number;
	serverKeys: number;
	unionKeys: number;
	/** Union keys whose target node already exists: kept, applied by NodeCache at the node's next write. */
	keysWithExistingTarget: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validates the shape the cache writes (src/cache.ts PendingReverse); the edge's own fields are
 * the node schema's business and are deliberately not re-judged here. */
export function parsePendingReverses(raw: string): PendingReversesParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { ok: false, error: `not valid JSON (${e instanceof Error ? e.message : String(e)})` };
	}
	if (!isRecord(parsed)) return { ok: false, error: "must be a JSON object keyed by target slug" };
	const entries: [string, PendingReverse[]][] = [];
	for (const [key, list] of Object.entries(parsed)) {
		if (!isValidSlug(key)) return { ok: false, error: `key ${JSON.stringify(key)} is not a valid slug` };
		if (!Array.isArray(list)) return { ok: false, error: `key ${key}: value must be an array` };
		for (const [i, entry] of list.entries()) {
			const where = `key ${key}: entry ${i}`;
			if (!isRecord(entry)) return { ok: false, error: `${where} is not an object` };
			if (typeof entry.field !== "string" || entry.field === "") {
				return { ok: false, error: `${where}: field must be a non-empty string` };
			}
			if (entry.cardinality !== "list" && entry.cardinality !== "single") {
				return { ok: false, error: `${where}: cardinality must be "list" or "single"` };
			}
			if (!isRecord(entry.edge) || typeof entry.edge.slug !== "string" || !isValidSlug(entry.edge.slug)) {
				return { ok: false, error: `${where}: edge.slug must be a valid slug` };
			}
		}
		entries.push([key, list as PendingReverse[]]);
	}
	// fromEntries defines own properties, so no key can reach Object.prototype (and none is
	// "__proto__" anyway: isValidSlug above refuses it).
	return { ok: true, value: Object.fromEntries(entries) };
}

/** A missing file is an empty map (a cache that never queued a reverse); a present but malformed
 * one is an error carrying its path. */
export async function readPendingReversesFile(path: string): Promise<PendingReversesParse> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (e) {
		if (isNotFoundError(e)) return { ok: true, value: {} };
		return { ok: false, error: `${path}: unreadable (${e instanceof Error ? e.message : String(e)})` };
	}
	const parsed = parsePendingReverses(raw);
	return parsed.ok ? parsed : { ok: false, error: `${path}: ${parsed.error}` };
}

/** Pure. Repo keys first (in their order), then the keys only the server had. */
export function unionPendingReverses(
	repo: Readonly<PendingReversesMap>,
	server: Readonly<PendingReversesMap>,
): PendingReversesMap {
	const merged = new Map<string, PendingReverse[]>();
	const seen = new Map<string, Set<string>>();
	for (const side of [repo, server]) {
		for (const [key, list] of Object.entries(side)) {
			const target = merged.get(key) ?? [];
			const keys = seen.get(key) ?? new Set<string>();
			for (const pending of list) {
				const identity = `${pending.field}\u0000${pending.edge.slug}`;
				if (keys.has(identity)) continue;
				keys.add(identity);
				target.push(pending);
			}
			merged.set(key, target);
			seen.set(key, keys);
		}
	}
	return Object.fromEntries(merged);
}

export function summarizePendingReverses(
	repo: Readonly<PendingReversesMap>,
	server: Readonly<PendingReversesMap>,
	union: Readonly<PendingReversesMap>,
	liveSlugs: ReadonlySet<string>,
): PendingReversesSummary {
	return {
		repoKeys: Object.keys(repo).length,
		serverKeys: Object.keys(server).length,
		unionKeys: Object.keys(union).length,
		keysWithExistingTarget: Object.keys(union).filter((key) => liveSlugs.has(key)).length,
	};
}
