import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { scopeOf } from "./slug.js";

/**
 * The (artist, field) pairs whose `landmark_project` / `reference_track` was emptied ON PURPOSE (TRA-605) and
 * must stay empty until a reliable choice exists (TRA-674). An empty field is exactly what the 2026-10-19
 * backfill and `enforceArtistChoices` (first entry of the list, i.e. the most recent) fill, so without this
 * list a replay of either would write the bad picks back (verified by a dry-run on 2026-10-24: 5 of 7).
 *
 * Lives in `data/` because the pipeline (src/) cannot import from `scripts/migrations/`, where TRA-605's own
 * closed list sits; a test pins that the two agree. `rejected` is the slug of the pick that was removed: a
 * regeneration that proposes it again is refused too.
 */
export const CLEARED_FIELDS = ["landmark_project", "reference_track"] as const;
export type ClearedField = (typeof CLEARED_FIELDS)[number];

const entrySchema = z.object({ rejected: z.string().min(1), reason: z.string().min(1) }).strict();
const fileSchema = z.record(
	z.string().min(1),
	z.object({ landmark_project: entrySchema, reference_track: entrySchema }).partial().strict(),
);

export interface ClearedPick {
	/** Slug of the pick that was removed. */
	rejected: string;
	reason: string;
}

export const DEFAULT_CLEARED_LANDMARKS_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"data",
	"cleared-landmarks.json",
);

export const clearedKey = (artist: string, field: ClearedField): string => `${artist}.${field}`;

const loaded = new Map<string, ReadonlyMap<string, ClearedPick>>();

/**
 * The cleared pairs, keyed `<artist slug>.<field>`. Read once per path. Throws when the file is unreadable or
 * invalid: a guard that silently turns itself off would let the bad picks come back.
 */
export function loadClearedLandmarks(
	path = DEFAULT_CLEARED_LANDMARKS_PATH,
): ReadonlyMap<string, ClearedPick> {
	const hit = loaded.get(path);
	if (hit !== undefined) return hit;
	const parsed = fileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	const map = new Map<string, ClearedPick>();
	for (const [artist, fields] of Object.entries(parsed)) {
		for (const field of CLEARED_FIELDS) {
			const entry = fields[field];
			if (entry === undefined) continue;
			// A typo (a track slug on a project field) would never match and the guard would be silently void.
			if (!entry.rejected.startsWith(REJECTED_PREFIX[field])) {
				throw new Error(
					`${artist}.${field}: rejected "${entry.rejected}" is not a ${REJECTED_PREFIX[field]} slug`,
				);
			}
			map.set(clearedKey(artist, field), entry);
		}
	}
	loaded.set(path, map);
	return map;
}

const REJECTED_PREFIX: Record<ClearedField, string> = {
	landmark_project: "project:",
	reference_track: "track:",
};

/** The cleared entry of a pair, or undefined when the field may be filled. */
export function clearedPick(artist: unknown, field: ClearedField): ClearedPick | undefined {
	if (typeof artist !== "string") return undefined;
	return loadClearedLandmarks().get(clearedKey(artist, field));
}

/** `project:live-forever--headhunterz` -> `project:live-forever`; a bare slug is returned as is. */
function withoutScope(slug: string): string {
	return scopeOf(slug) === null ? slug : slug.slice(0, slug.indexOf("--"));
}

/**
 * True when `pick` is the removed pick, bare or scoped: the data file holds the slug as TRA-605 found it, and
 * a regeneration with scoped release slugs (ODYSSEY_SCOPED_RELEASE_SLUGS) names the same work with its scope.
 */
export function isRejectedPick(entry: ClearedPick, pick: string | undefined): boolean {
	return pick !== undefined && withoutScope(pick) === withoutScope(entry.rejected);
}
