/**
 * What a migration run does to the server, as its manifest declares it: the slugs it renames (`renamed`), the
 * files it removes (`removed`) and the redirects it adds (`redirects`). Those three are what the channel acts on
 * (deploy/sync-genre-cache.sh deletes exactly the old side of `renamed` and `removed`, and only ships a pair that
 * is committed), so they are what the apply must repeat from the preview (TRA-610, PR 3). A node the migration
 * rewrites IN PLACE (an identity stripped, an edge dropped) is not among them: it is neither a deletion nor a
 * redirect, and the channel never reads it from the manifest.
 *
 * Not the whole manifest, on purpose. A manifest also carries the REASONS and the counts that led to the outcome,
 * and a reason can change while the outcome does not: in the homonym migration, a merge into a target that is
 * itself renamed is a `conflict` with reason `target-is-renamed` in the preview, and `target-is-a-redirect-key` in
 * the apply once the pairs are committed. The work is left alone both times; a strict equality would refuse an
 * apply that does exactly what the preview showed.
 *
 * Pure, no I/O: the CLI wrapper is scripts/validate-migrated-union.ts (`compare-outcome`).
 */

export interface MigrationOutcome {
	renamed: Readonly<Record<string, string>>;
	removed: readonly string[];
	redirects: Readonly<Record<string, string>>;
}

export type OutcomeResult = { ok: true; value: MigrationOutcome } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every((v) => typeof v === "string");

/** The outcome part of a parsed manifest; an error naming the first malformed field. */
export function outcomeOf(manifest: unknown): OutcomeResult {
	if (!isRecord(manifest)) return { ok: false, error: "the manifest is not a JSON object" };
	const { renamed, removed, redirects } = manifest;
	if (!isStringMap(renamed)) return { ok: false, error: "manifest.renamed is not a map of slug -> slug" };
	if (!Array.isArray(removed) || !removed.every((r) => typeof r === "string")) {
		return { ok: false, error: "manifest.removed is not a list of paths" };
	}
	if (!isStringMap(redirects)) return { ok: false, error: "manifest.redirects is not a map of slug -> slug" };
	return { ok: true, value: { renamed, removed, redirects } };
}

function diffMaps(
	label: string,
	recorded: Readonly<Record<string, string>>,
	current: Readonly<Record<string, string>>,
): string[] {
	const out: string[] = [];
	// Own keys only: a manifest is parsed JSON, and `constructor` is not a rename.
	const own = (map: Readonly<Record<string, string>>, key: string): string | undefined =>
		Object.hasOwn(map, key) ? map[key] : undefined;
	for (const key of Object.keys(recorded).sort()) {
		const was = own(recorded, key);
		const now = own(current, key);
		if (now === undefined) out.push(`${label} ${key} -> ${was}: in the preview, not in the apply`);
		else if (now !== was) out.push(`${label} ${key}: ${was} in the preview, ${now} in the apply`);
	}
	for (const key of Object.keys(current).sort()) {
		if (own(recorded, key) === undefined) {
			out.push(`${label} ${key} -> ${own(current, key)}: in the apply, not in the preview`);
		}
	}
	return out;
}

function countBy(paths: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
	return counts;
}

/** One line per difference between the recorded (preview) outcome and the current (apply) one; empty = same. */
export function diffOutcomes(recorded: MigrationOutcome, current: MigrationOutcome): string[] {
	// A multiset: a path listed twice is not the path listed once.
	const before = countBy(recorded.removed);
	const after = countBy(current.removed);
	const removals = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
		const was = before.get(path) ?? 0;
		const now = after.get(path) ?? 0;
		if (was === now) return [];
		if (now === 0) return [`removed ${path}: in the preview, not in the apply`];
		if (was === 0) return [`removed ${path}: in the apply, not in the preview`];
		return [`removed ${path}: listed ${was} time(s) in the preview, ${now} in the apply`];
	});
	return [
		...diffMaps("renamed", recorded.renamed, current.renamed),
		...removals,
		...diffMaps("redirects", recorded.redirects, current.redirects),
	];
}
