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
import { lstat, readFile } from "node:fs/promises";
import type { PendingReverse } from "../src/cache.js";
import { isNotFoundError } from "../src/errors.js";
import { edgeSchemaFor } from "../src/schemas.js";
import { isValidSlug, parseSlug } from "../src/slug.js";

export type PendingReversesMap = Record<string, PendingReverse[]>;

export type PendingReversesParse = { ok: true; value: PendingReversesMap } | { ok: false; error: string };

export interface PendingReversesSummary {
	repoKeys: number;
	serverKeys: number;
	unionKeys: number;
	unionEntries: number;
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
 * one is an error carrying its path. Only an ENOENT from `lstat` itself counts as "missing": anything
 * that is not a regular file (a symlink -- dangling or not --, a directory) is refused, never followed
 * (TRA-499 deep review: the server's file comes off a remote disk). */
export async function readPendingReversesFile(path: string): Promise<PendingReversesParse> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile()) return { ok: false, error: `${path}: not a regular file (symlink or directory)` };
	} catch (e) {
		if (isNotFoundError(e)) return { ok: true, value: {} };
		return { ok: false, error: `${path}: unreadable (${e instanceof Error ? e.message : String(e)})` };
	}
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (e) {
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

export function countPendingEntries(map: Readonly<PendingReversesMap>): number {
	return Object.values(map).reduce((n, list) => n + list.length, 0);
}

/** Post-migration checks on a (shape-valid) map, as problem lines: no key and no `edge.slug` may name
 * a node the migrations deleted (a rename that did not rewrite the file leaves reverses aimed at, or
 * pointing to, a slug that no longer exists), and every `edge` must satisfy the edge schema the target
 * node will apply to that field once the reverse lands in it -- an invalid one would make that node
 * impossible to write in prod. */
export function checkPendingReversesAfterMigration(
	map: Readonly<PendingReversesMap>,
	deletedSlugs: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	for (const [key, list] of Object.entries(map)) {
		if (deletedSlugs.has(key)) {
			problems.push(`key ${key}: names a node the migrations deleted (file not rewritten?)`);
		}
		const { type } = parseSlug(key);
		for (const [i, entry] of list.entries()) {
			const where = `key ${key}: entry ${i}`;
			if (deletedSlugs.has(entry.edge.slug)) {
				problems.push(
					`${where}: edge.slug ${entry.edge.slug} is a node the migrations deleted (file not rewritten?)`,
				);
			}
			const schema = edgeSchemaFor(type, entry.field);
			if (!schema) {
				problems.push(`${where}: a ${type} node has no edge field "${entry.field}"`);
				continue;
			}
			const parsed = schema.safeParse(entry.edge);
			if (!parsed.success) {
				const issues = parsed.error.issues.map((x) => `${x.path.join(".") || "(edge)"}: ${x.message}`);
				problems.push(`${where}: edge fails the ${type}.${entry.field} edge schema (${issues.join("; ")})`);
			}
		}
	}
	return problems;
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
		unionEntries: countPendingEntries(union),
		keysWithExistingTarget: Object.keys(union).filter((key) => liveSlugs.has(key)).length,
	};
}
