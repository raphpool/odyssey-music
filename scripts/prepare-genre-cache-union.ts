/**
 * Prepares a union of two genre caches (repo + server) in a new temp dir, without touching
 * either source -- B6a (TRA-66). A slug on only one side is copied byte-identical. The SAME
 * slug on both sides is compared by decideSameIdentity; a qid conflict or unusable timestamp
 * is refused on BOTH sides (a non-zero exit code then signals an incomplete union). Two
 * DIFFERENT slugs naming the same genre (genre:country-music vs genre:country) are never
 * merged here -- both are copied as-is ("never assume the redirect was followed in the repo");
 * the duplicate-merge migration's own PREVIEW then runs against a copy of the redirects table
 * (never the source) so the manifest reports what a real merge would do. Both variants of a
 * compared pair are archived under <output>/archive/{repo,server}/ regardless of outcome.
 *
 * With `--apply-merge` (TRA-234 / B6a-2), the QID-duplicate merge migration is actually applied
 * to the union's OWN copy: every file under `nodes/` is archived to `archive/pre-migration/`
 * first (so a variant the migration deletes is never lost from the artifact -- see the B6a
 * review incident where a live repo node was silently dropped), then `runMigration(outputDir,
 * true, ...)` runs against the union's own redirects copy (never the source). References are
 * then validated in DELTA, never in absolute: a slug is "resolvable" in a source when a live
 * node exists there, or its (pre-migration) redirect target does -- same rule as
 * `resolveReadSlug`. Only a reference that resolved in at least one source and no longer
 * resolves in the (migrated) union is a real regression; the cache's normal baseline of
 * never-materialized edges is not. This does NOT union `pending-reverses.json` between the two
 * sources -- see the PR for whether that matters for a given run.
 *
 * Usage: tsx scripts/prepare-genre-cache-union.ts <repo-cache-dir> <server-cache-dir> [--apply-merge]
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache } from "../src/cache.js";
import type { GenreRedirects } from "../src/genre-registry.js";
import { loadGenreRedirects, parseGenreRedirects } from "../src/genre-registry.js";
import type { GenreTaxonomy } from "../src/genre-taxonomy.js";
import { LIST_EDGES_BY_TYPE, type NodeType, SINGULAR_EDGES_BY_TYPE } from "../src/node-spec.js";
import { nodePayloadSchema } from "../src/schemas.js";
import { parseSlug } from "../src/slug.js";
import type { NodePayload, Slug } from "../src/types.js";
import {
	isRecord,
	looksLikeCacheDir,
	mergeRedirects,
	readCacheNodes,
	runMigration,
	warnSkippedNodeFiles,
} from "./migrations/2026-09-04-merge-genre-duplicates.js";

type NodeFile = Awaited<ReturnType<typeof readCacheNodes>>["nodes"][number];

// "kept"/"conflict" only ever compare the SAME raw slug on both sides (see buildCacheUnion), so
// one `slug` field is all either variant needs.
export type UnionEntry =
	| { decision: "copied"; from: "repo" | "server"; slug: Slug }
	| {
			decision: "kept";
			from: "repo" | "server";
			slug: Slug;
			tie: boolean;
			qidOnlyOn?: "repo" | "server";
			// Count of list edges pulled in from the OTHER side that weren't already on the winner
			// (B6a-3 / TRA-268) -- omitted, like qidOnlyOn above, when there was nothing to add, so
			// every pre-existing "kept" fixture in the test suite stays valid without updating it.
			mergedEdgeCount?: number;
	  }
	| { decision: "conflict"; slug: Slug; reason: "qid" | "timestamp" };

// An edge the LOSING side contributed that the merge refused to carry over: it targets the merged
// node itself (a self-loop union must not mint), or it no longer resolves against the union's own
// live-slug/redirect state (see slugResolves) and would be written dangling. Reported here instead
// of silently vanishing (the B6a-3 / TRA-268 review finding: a server-only reverse edge added by
// applyReverseToTarget used to be lost with no trace when the repo's copy of the same slug won on
// materialized_at). Edges the WINNER already carried are never listed here -- they pass through
// mergeUnionEdges verbatim.
//
// `resolvedIn` names the sources where the target still resolved BEFORE the union, and is omitted
// when there are none. Omitted is the tolerated baseline -- an edge towards a never-materialized
// node is this cache's normal steady state, and what top-up-dangling.ts consumes to choose what to
// materialize next -- so countUnionProblems ignores it. Present means the union actually broke a
// reference that used to work, which it does count (2026-09-17, review of #239).
export interface DroppedEdge {
	slug: Slug;
	field: string;
	target: Slug;
	resolvedIn?: ("repo" | "server")[];
}

// A "kept" (both-sides) node whose merged content writeValidatedNode refused to write: either a
// genuine nodePayloadSchema violation, or a mismatch between the slug the file was found under
// and the node's own claimed `slug` field (review finding -- see writeValidatedNode). The union
// degrades and keeps going rather than crashing mid-build with no manifest at all: this slug
// simply has no live node in the union's own nodes/ tree, the same as a slug omitted for any
// other reason.
export interface InvalidMergedNode {
	slug: Slug;
	reason: string;
}

// A reference that resolved in a source before the union but no longer resolves after the
// (applied) migration -- see `slugResolves` and the reference-delta block in `buildCacheUnion`.
export interface ReferenceRegression {
	slug: Slug;
	resolvedIn: ("repo" | "server")[];
}

// PR #213 review (B6a-2) and PR #224 review (TRA-245): the server's own redirects table may
// already disagree with the repo's -- "diverged-target" (same loser, two targets) or
// "inverted-pair" (exact reversal), both pairwise; or "cycle", a longer chain spanning both
// tables (repo: a->b, c->d; server: b->c, d->a) that no pairwise check can see -- caught instead
// by combining the two tables with mergeRedirects (see buildCacheUnion). Left unflagged, any of
// these lets the merge migration below write a redirect in the wrong direction -- TRA-48 symptom.
export type RedirectsConflict =
	| {
			reason: "diverged-target" | "inverted-pair";
			repoFrom: Slug;
			repoTo: Slug;
			serverFrom: Slug;
			serverTo: Slug;
	  }
	| { reason: "cycle" | "dangling"; message: string };

/** Pure: flags every genre-redirect entry that disagrees between the two tables. An entry present
 * on only one side is normal steady-state (the other side hasn't caught up yet) and is never
 * flagged -- only a same-key/different-target or an exact reversal is a real conflict. */
export function diffGenreRedirects(repo: GenreRedirects, server: GenreRedirects): RedirectsConflict[] {
	const conflicts: RedirectsConflict[] = [];
	for (const [repoFrom, repoTo] of repo) {
		const serverTo = server.get(repoFrom);
		if (serverTo !== undefined && serverTo !== repoTo) {
			conflicts.push({ reason: "diverged-target", repoFrom, repoTo, serverFrom: repoFrom, serverTo });
		}
		const serverReverseTarget = server.get(repoTo);
		if (serverReverseTarget === repoFrom) {
			conflicts.push({
				reason: "inverted-pair",
				repoFrom,
				repoTo,
				serverFrom: repoTo,
				serverTo: repoFrom,
			});
		}
	}
	return conflicts;
}

export interface UnionManifest {
	generatedAt: string;
	repoCacheDir: string;
	serverCacheDir: string;
	entries: UnionEntry[];
	skipped: { source: "repo" | "server"; path: string; error: string }[];
	// Edges the losing side of a "kept" (both-sides) node contributed and the merge refused -- see
	// DroppedEdge. Always present (like `skipped`), independent of --apply-merge. Only the entries
	// carrying `resolvedIn` are counted by countUnionProblems.
	droppedEdges: DroppedEdge[];
	// "Kept" nodes whose merged content failed to write -- see InvalidMergedNode. Always present,
	// independent of --apply-merge; counted in countUnionProblems (unlike droppedEdges) since an
	// invalid node is a real invariant violation, not a tolerated baseline.
	invalidMergedNodes: InvalidMergedNode[];
	// Only present WITHOUT --apply-merge (a dry run). With --apply-merge, migrationApply below is
	// the sole migration-related field -- it already carries groupsFound/exitCode/report, and is
	// the one that actually describes the artifact's final state.
	migrationPreview?: { groupsFound: number; exitCode: 0 | 1; report: string; migrationWarnings?: string[] };
	// Present only with --apply-merge: the FINAL state of the artifact after the migration
	// actually ran (winner/criterion/losers/rewritten-edge counts live only in `report`'s free
	// text -- MigrationResult has no structured per-group field, and the migration script is out
	// of scope to change).
	migrationApply?: {
		// false when the migration refused to write anything at all (e.g. an onboarding-protected
		// loser) -- exitCode:1 alone doesn't say THAT happened vs. some other invariant failure;
		// `applied` is the one-glance signal, `refusalReason` the free-text detail.
		applied: boolean;
		groupsFound: number;
		deletedCount: number;
		exitCode: 0 | 1;
		report: string;
		archivedNodeCount: number;
		// Only present when NOT applied: the migration's own stderr text. MigrationResult carries
		// no structured failure reason, and `report` (unlike this) describes the merge plan, not
		// why it was refused.
		refusalReason?: string;
		// 2026-09-19 review of TRA-277: every line runMigration wrote to stderr, present even on a
		// SUCCESSFUL run (exitCode 0) -- unlike `refusalReason` above, which captureStderr's output
		// only ever reached via `migrationStderr.trim()` when exitCode !== 0. Without this, the
		// branch-3 "ONBOARDING_GENRES retired, taxonomy protection alone" notice never reached an
		// operator on the one path production actually takes (deploy/sync-genre-cache.sh always
		// passes --apply-merge): the migration succeeds, so its warning was silently dropped.
		migrationWarnings?: string[];
		// Union entries (decision "copied"/"kept") that existed right after the union step but no
		// longer have a live node after the migration ran -- the "final state, not intermediate"
		// gap the B6a review flagged (a merged-away node reported as still "copied").
		removedByMigration: { slug: Slug; redirectsTo?: Slug }[];
	};
	referenceRegressions?: ReferenceRegression[];
	// Only present when options.serverRedirectsPath was given (B6b/sync-genre-cache.sh always
	// passes it). A non-empty array is a hard refusal -- see diffGenreRedirects's own doc comment.
	redirectsConflicts?: RedirectsConflict[];
}

/** Pure: which side wins when the SAME raw slug exists on both sides. */
export function decideSameIdentity(
	repo: Record<string, unknown>,
	server: Record<string, unknown>,
):
	| { from: "repo" | "server"; tie: boolean; qidOnlyOn?: "repo" | "server" }
	| { reason: "qid" | "timestamp" } {
	const repoQid = typeof repo.qid === "string" ? repo.qid : undefined;
	const serverQid = typeof server.qid === "string" ? server.qid : undefined;
	if (repoQid && serverQid && repoQid !== serverQid) return { reason: "qid" };

	const repoTime = Date.parse(String(repo.materialized_at));
	const serverTime = Date.parse(String(server.materialized_at));
	if (Number.isNaN(repoTime) || Number.isNaN(serverTime)) return { reason: "timestamp" };

	// Records which side carries a qid the other doesn't -- kept regardless (not a conflict).
	// countUnionProblems below only flags this as a problem when the qid-BEARING side is NOT
	// the winner: that's the case where the qid is actually dropped from the union (a node
	// without a qid never rejoins a duplicate group -- see the migration's own header comment).
	// When the qid-bearing side wins, nothing is lost.
	const qidOnlyOn: "repo" | "server" | undefined =
		repoQid && !serverQid ? "repo" : !repoQid && serverQid ? "server" : undefined;
	const rest = qidOnlyOn ? { qidOnlyOn } : {};
	if (repoTime === serverTime) return { from: "repo", tie: true, ...rest };
	return { from: repoTime > serverTime ? "repo" : "server", tie: false, ...rest };
}

/** Pure: same resolution rule as `resolveReadSlug` (a live node always wins, else its redirect
 * target if that target is itself live) -- reimplemented in-memory against a precomputed live-slug
 * set instead of calling `resolveReadSlug`'s own `NodeCache.has`, which does one file read per
 * call: checking every referenced slug against three caches (repo/server/union) that way would
 * mean tens of thousands of extra disk reads on the real cache when the live-slug membership is
 * already known from `readCacheNodes` / `listSlugs`. */
export function slugResolves(
	slug: Slug,
	liveSlugs: ReadonlySet<Slug>,
	redirects: ReadonlyMap<Slug, Slug>,
): boolean {
	if (liveSlugs.has(slug)) return true;
	const target = redirects.get(slug);
	return target !== undefined && liveSlugs.has(target);
}

/** Every outgoing edge target slug across the given nodes, via the canonical field lists in
 * node-spec.ts (top-level fields only, list and singular cardinality) -- same source the
 * duplicate-merge migration itself uses to find edges pointing at a slug. */
function collectReferencedSlugs(nodes: readonly NodeFile[]): Set<Slug> {
	const result = new Set<Slug>();
	for (const { node, type } of nodes) {
		for (const field of LIST_EDGES_BY_TYPE[type]) {
			const list = node[field];
			if (!Array.isArray(list)) continue;
			for (const edge of list)
				if (isRecord(edge) && typeof edge.slug === "string") result.add(edge.slug as Slug);
		}
		for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
			const value = node[field];
			if (isRecord(value) && typeof value.slug === "string") result.add(value.slug as Slug);
		}
	}
	return result;
}

/** Captures whatever `fn` writes to stderr while it runs -- the only way to recover the
 * migration's refusal reason (e.g. an onboarding-protected slug), since `MigrationResult` has no
 * structured error field and `report` describes the merge plan, not why it was refused. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let captured = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		return { result: await fn(), stderr: captured };
	} finally {
		process.stderr.write = original;
	}
}

async function copyNode(baseDir: string, file: NodeFile): Promise<void> {
	const { body } = parseSlug(file.slug);
	const dest = join(baseDir, file.type, `${body}.json`);
	await mkdir(dirname(dest), { recursive: true });
	await copyFile(file.path, dest);
}

/** Pure: merges every list-edge field of `type` between the winning ("kept") node and the other
 * side's. The winner's OWN list passes through verbatim -- exactly what copyNode wrote before this
 * ticket, duplicates and unresolvable targets included. Only what the LOSER contributes is
 * filtered: deduped by slug against the winner's list (unionListField's "first occurrence wins"
 * rule, applied here to the loser's side alone), dropped when it targets `ownSlug` (two variants
 * commonly cross-link as "related", and union must not mint a self-loop), and dropped when it no
 * longer resolves against the union's own live-slug/redirect state (slugResolves -- same rule as
 * resolveReadSlug) rather than written dangling. Every drop is reported via `dropped` (see
 * DroppedEdge) instead of vanishing silently -- the bug this function fixes (B6a-3 / TRA-268
 * review finding).
 *
 * 2026-09-17, review of #239: that resolution filter used to run over the merged list as a WHOLE,
 * so an edge the winner already carried towards a never-materialized node was eaten too --
 * 15689 slug-bearing edges in, 7222 out on a self-union of the committed cache, artist:1-2-3
 * losing label:ooh-la-la-records and both its notable_tracks, all of them top-up targets. Those
 * edges ARE this cache's steady state (top-up-dangling.ts reads them to pick what to materialize
 * next). References are validated in DELTA, never in absolute (see this file's header): an edge
 * becomes unacceptable when it STOPS resolving, never because it never did.
 *
 * `ownSlug` is the loop's own key, never `winner.slug`/`loser.slug` -- readCacheNodes never
 * validates cache content, so a node's claimed slug is untrusted like any other field. Every other
 * field, singular edges included, is left exactly as the winner had it -- including a self-loop the
 * winner ALREADY had (artist:tyree lists itself in `aliases`), which is pre-existing data and out
 * of this ticket's scope. `mergedEdgeCount` only counts edges the LOSER contributed that weren't
 * already on the winner -- the signal worth surfacing in the manifest. */
export function mergeUnionEdges(
	winner: Record<string, unknown>,
	loser: Record<string, unknown>,
	type: NodeType,
	ownSlug: Slug,
	liveSlugs: ReadonlySet<Slug>,
	redirects: ReadonlyMap<Slug, Slug>,
): { node: Record<string, unknown>; mergedEdgeCount: number; dropped: Omit<DroppedEdge, "slug">[] } {
	const merged: Record<string, unknown> = { ...winner };
	let mergedEdgeCount = 0;
	const dropped: Omit<DroppedEdge, "slug">[] = [];
	for (const field of LIST_EDGES_BY_TYPE[type]) {
		const winnerList = Array.isArray(winner[field]) ? (winner[field] as unknown[]) : [];
		const loserList = Array.isArray(loser[field]) ? (loser[field] as unknown[]) : [];
		const seen = new Set<string>(
			winnerList
				.filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.slug === "string")
				.map((e) => e.slug as string),
		);
		const kept: unknown[] = [...winnerList];
		for (const edge of loserList) {
			const edgeSlug = isRecord(edge) && typeof edge.slug === "string" ? (edge.slug as Slug) : undefined;
			// No slug: nothing to dedupe by and nothing to resolve -- appended as-is, unionListField's
			// own rule for a slugless entry.
			if (edgeSlug === undefined) {
				kept.push(edge);
				continue;
			}
			// Marked seen before the filters below, so a slug the loser repeats is examined (and, if
			// refused, reported) exactly once.
			if (seen.has(edgeSlug)) continue;
			seen.add(edgeSlug);
			if (edgeSlug === ownSlug || !slugResolves(edgeSlug, liveSlugs, redirects)) {
				dropped.push({ field, target: edgeSlug });
				continue;
			}
			kept.push(edge);
			mergedEdgeCount++;
		}
		merged[field] = kept;
	}
	return { node: merged, mergedEdgeCount, dropped };
}

/** Writes a "kept" node through the same schema every real read/write in this codebase goes
 * through (nodePayloadSchema) -- unlike copyNode's raw byte copy, this node was just
 * reconstructed in memory by mergeUnionEdges, so it must be proven valid before it's trusted
 * again (ticket contract: "pas d'écriture brute non validée"). Never throws: this file's idiom
 * for a per-item problem is degrade-with-report (skippedEntry, redirectsConflicts), not an
 * uncaught exception killing the whole build before manifest.json is written (InvalidMergedNode,
 * review finding). Also returns `ok: false` when `expectedSlug` (from the FILENAME, via
 * readCacheNodes) disagrees with the validated node's own `slug` field (untrusted cache content,
 * same category as any other field) -- writing it under the wrong path would silently mint a
 * stray file instead of surfacing the mismatch (review finding). Uses atomicWriteJson directly
 * rather than NodeCache.write(): the latter also emits reverse edges to OTHER nodes, a side
 * effect this offline, order-independent pass must not trigger. */
async function writeValidatedNode(
	nodesDir: string,
	expectedSlug: Slug,
	node: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	let validated: NodePayload;
	try {
		validated = nodePayloadSchema.parse(node) as NodePayload;
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
	if (validated.slug !== expectedSlug) {
		return {
			ok: false,
			reason: `validated node's own slug "${validated.slug}" does not match the expected slug "${expectedSlug}"`,
		};
	}
	const { type, body } = parseSlug(validated.slug as Slug);
	const dest = join(nodesDir, type, `${body}.json`);
	await mkdir(dirname(dest), { recursive: true });
	await atomicWriteJson(dest, validated);
	return { ok: true };
}

/** readCacheNodes's own `invalid` entries build `path` as `join(root, "nodes", slug)` -- not a
 * real file (the real one is `nodes/<type>/<body>.json`). Rebuilds the real path from that same
 * slug when it parses; falls back to the bogus path (still useful to locate the entry in the
 * `invalid.error` context) only if the slug itself is unparseable. */
function skippedEntry(
	source: "repo" | "server",
	root: string,
	entry: { path: string; error: string },
): UnionManifest["skipped"][number] {
	try {
		const { type, body } = parseSlug(relative(join(root, "nodes"), entry.path));
		return { source, path: join(root, "nodes", type, `${body}.json`), error: entry.error };
	} catch {
		return { source, path: entry.path, error: entry.error };
	}
}

/** Loads the server's own redirects table for a caller-provided path. Unlike
 * `loadGenreRedirects`'s default-location behavior (missing file -> empty table), a path here is
 * always REQUIRED: the server's table is untrusted data, so a typo'd/moved path must fail loudly,
 * not silently fall back to "no redirects" (finding 4, PR #224 review). Every failure -- missing
 * file, invalid JSON, schema violation -- names `path`, and is raised before any write. */
async function loadRequiredGenreRedirects(path: string): Promise<GenreRedirects> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (e) {
		throw new Error(
			`server redirects table ${path} could not be read: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`server redirects table ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	try {
		return parseGenreRedirects(json);
	} catch (e) {
		throw new Error(
			`server redirects table ${path} failed validation: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

export function countUnionProblems(manifest: UnionManifest): number {
	const conflicts = manifest.entries.filter((e) => e.decision === "conflict").length;
	// A qid dropped from the union: the side carrying it did NOT win the comparison.
	const droppedQid = manifest.entries.filter(
		(e) => e.decision === "kept" && e.qidOnlyOn !== undefined && e.qidOnlyOn !== e.from,
	).length;
	const regressions = manifest.referenceRegressions?.length ?? 0;
	// A dropped edge whose target still resolved in a source: the union really did break a working
	// reference, so it counts (2026-09-17, review of #239 -- the whole of droppedEdges used to be
	// excluded, which is how a filter eating 8389 of 15689 slug-bearing edges on a self-union of the
	// committed cache stayed invisible with all 40 tests green). An edge that resolved nowhere keeps
	// its `resolvedIn` omitted and stays at zero here: that's the never-materialized baseline, not a
	// regression (see DroppedEdge). May double up with a referenceRegression naming the same target
	// under --apply-merge -- one is per-edge, the other per-target; both report the same real
	// breakage and this number is only ever read as "> 0 means the union needs attention".
	const brokenEdges = manifest.droppedEdges.filter((e) => (e.resolvedIn?.length ?? 0) > 0).length;
	const redirectsConflicts = manifest.redirectsConflicts?.length ?? 0;
	const migrationExitCode = manifest.migrationApply?.exitCode ?? manifest.migrationPreview?.exitCode ?? 0;
	return (
		conflicts +
		droppedQid +
		manifest.skipped.length +
		manifest.invalidMergedNodes.length +
		migrationExitCode +
		regressions +
		brokenEdges +
		redirectsConflicts
	);
}

export async function buildCacheUnion(
	repoCacheDir: string,
	serverCacheDir: string,
	options: {
		redirectsPath?: string;
		// The server's own genre-redirects.json, read-only -- see diffGenreRedirects. Omitted only
		// by direct callers that don't care (existing tests); sync-genre-cache.sh always passes it.
		serverRedirectsPath?: string;
		outputRoot?: string;
		onboardingSlugs?: readonly string[];
		// Passed through to runMigration only when `onboardingSlugs` above is omitted -- lets a
		// caller (namely this file's own tests, 2026-09-19 review) point the "is ONBOARDING_GENRES
		// still in web/index.html" detection at a fixture instead of the real repo file, without
		// pre-resolving the slug list itself the way `onboardingSlugs` does.
		webIndexPath?: string;
		// Genre-taxonomy (v2) protection passthrough -- TRA-277. Without either of these, the
		// merge guard below falls back to runMigration's own default, which resolves relative to
		// `dirname(cacheDir)`: fine for the migration's own CLI (run directly against a real
		// cache/ with a sibling data/), but `cacheDir` here is always `outputDir`, a synthetic
		// mkdtemp() tree with no sibling data/ -- so that default silently never finds anything.
		// `taxonomyPath` below anchors it to the real repo instead (see the call site).
		taxonomyPath?: string;
		taxonomy?: GenreTaxonomy;
		applyMerge?: boolean;
	} = {},
): Promise<{ outputDir: string; manifest: UnionManifest }> {
	const { nodes: repoNodes, invalid: repoInvalid } = await readCacheNodes(repoCacheDir);
	const { nodes: serverNodes, invalid: serverInvalid } = await readCacheNodes(serverCacheDir);
	const skipped: UnionManifest["skipped"] = [
		...repoInvalid.map((e) => skippedEntry("repo", repoCacheDir, e)),
		...serverInvalid.map((e) => skippedEntry("server", serverCacheDir, e)),
	];
	warnSkippedNodeFiles(skipped);

	// Redirects loaded and validated BEFORE anything is written to nodes/ or archive/ (finding 4)
	// -- a typo'd/missing/broken --server-redirects-path must fail loudly right here.
	const sourceRedirects = await loadGenreRedirects(options.redirectsPath);
	let serverRedirects: GenreRedirects | undefined;
	let redirectsConflicts: UnionManifest["redirectsConflicts"];
	// Seeds the union's OWN redirects copy below: the source table alone, unless both tables agree
	// -- then the COMBINED table, so election (criterion 0) sees a winner the server already
	// picked, not just the repo's. Never combined on a conflict (finding 1).
	let combinedRedirects: Record<string, string> = Object.fromEntries(sourceRedirects);
	// `!== undefined`, not truthy: an explicit "" must still be validated (and refused), never
	// silently treated as "no server table given" (round-2 review, finding 4).
	if (options.serverRedirectsPath !== undefined) {
		serverRedirects = await loadRequiredGenreRedirects(options.serverRedirectsPath);
		const pairwiseConflicts = diffGenreRedirects(sourceRedirects, serverRedirects);
		if (pairwiseConflicts.length > 0) {
			redirectsConflicts = pairwiseConflicts;
		} else {
			// No pairwise disagreement doesn't rule out a longer cycle spanning BOTH tables --
			// mergeRedirects's chain-following throws on exactly that (finding 2).
			try {
				combinedRedirects = mergeRedirects(
					Object.fromEntries(sourceRedirects),
					Object.fromEntries(serverRedirects),
				);
			} catch (e) {
				redirectsConflicts = [{ reason: "cycle", message: e instanceof Error ? e.message : String(e) }];
			}
		}
	}
	// A conflict found above means the migration below must never actually apply (finding 3).
	const redirectsRefused = redirectsConflicts !== undefined;

	const repoBySlug = new Map(repoNodes.map((f) => [f.slug, f]));
	const serverBySlug = new Map(serverNodes.map((f) => [f.slug, f]));
	const allSlugs = new Set([...repoBySlug.keys(), ...serverBySlug.keys()]);

	// Identity decided for every two-sided slug BEFORE any node is written (B6a-3 / TRA-268): a
	// "kept" node's list edges are unioned against the FINAL union membership below, which depends
	// on every slug's own decision (a conflicting slug never gets a live node in the union) --
	// not knowable mid-loop if conflicts and writes stayed interleaved as before this ticket.
	type IdentityDecision = ReturnType<typeof decideSameIdentity>;
	const decisionBySlug = new Map<Slug, IdentityDecision>();
	for (const slug of allSlugs) {
		const repoFile = repoBySlug.get(slug);
		const serverFile = serverBySlug.get(slug);
		if (repoFile && serverFile) {
			decisionBySlug.set(slug as Slug, decideSameIdentity(repoFile.node, serverFile.node));
		}
	}
	const unionLiveSlugs = new Set<Slug>(
		[...allSlugs].filter((slug) => {
			const decision = decisionBySlug.get(slug as Slug);
			return !decision || !("reason" in decision);
		}) as Slug[],
	);
	// The union's OWN redirects table (see combinedRedirects above), as a Map for slugResolves --
	// built here, ahead of writing `redirectsPath` below, since "kept" nodes need it mid-loop.
	const unionRedirects = new Map(Object.entries(combinedRedirects)) as Map<Slug, Slug>;

	// Each source's own PRE-union resolution state -- its live nodes plus its own redirect table
	// (the server's when one was loaded, finding 5; the repo's otherwise). Hoisted above the write
	// loop because a dropped edge has to be classified baseline-vs-regression as it is dropped; the
	// post-migration reference-delta block below reuses the same two sets.
	const repoLiveSlugs = new Set(repoNodes.map((f) => f.slug as Slug));
	const serverLiveSlugs = new Set(serverNodes.map((f) => f.slug as Slug));
	const resolvedInSources = (target: Slug): ("repo" | "server")[] => [
		...(slugResolves(target, repoLiveSlugs, sourceRedirects) ? (["repo"] as const) : []),
		...(slugResolves(target, serverLiveSlugs, serverRedirects ?? sourceRedirects)
			? (["server"] as const)
			: []),
	];

	const outputDir = await mkdtemp(join(options.outputRoot ?? tmpdir(), "odyssey-genre-union-"));
	const nodesDir = join(outputDir, "nodes");
	const archiveDir = join(outputDir, "archive");
	const entries: UnionEntry[] = [];
	const droppedEdges: DroppedEdge[] = [];
	const invalidMergedNodes: InvalidMergedNode[] = [];

	for (const slug of allSlugs) {
		const repoFile = repoBySlug.get(slug);
		const serverFile = serverBySlug.get(slug);
		if (repoFile && serverFile) {
			await copyNode(join(archiveDir, "repo"), repoFile);
			await copyNode(join(archiveDir, "server"), serverFile);
			const decision = decisionBySlug.get(slug as Slug) as IdentityDecision;
			if ("reason" in decision) {
				entries.push({ decision: "conflict", slug: slug as Slug, reason: decision.reason });
				continue;
			}
			const winner = decision.from === "repo" ? repoFile : serverFile;
			const loser = decision.from === "repo" ? serverFile : repoFile;
			// Text/scalar fields and singular edges follow the winner untouched (ticket contract);
			// only list edges are unioned -- see mergeUnionEdges.
			const {
				node: mergedNode,
				mergedEdgeCount,
				dropped,
			} = mergeUnionEdges(winner.node, loser.node, winner.type, slug as Slug, unionLiveSlugs, unionRedirects);
			const written = await writeValidatedNode(nodesDir, slug as Slug, mergedNode);
			if (!written.ok) {
				// Degrade and keep going (review finding): no "kept" entry, no live node under this
				// slug -- same as any other slug this union couldn't produce. Known gap: unionLiveSlugs
				// was fixed BEFORE this loop (see above), so another node's edge to this same slug can
				// still be judged "resolves" even though nothing was actually written for it here --
				// rare (this only fires on genuinely malformed source data) and not worth a second
				// full pass to close.
				invalidMergedNodes.push({ slug: slug as Slug, reason: written.reason });
				continue;
			}
			for (const d of dropped) {
				// A target that STILL resolves in the union was refused for another reason (a self-loop),
				// so it is never a broken reference; only a target the union can no longer reach is
				// weighed against what the sources could reach -- see DroppedEdge.
				const resolvedIn = slugResolves(d.target, unionLiveSlugs, unionRedirects)
					? []
					: resolvedInSources(d.target);
				droppedEdges.push({
					slug: slug as Slug,
					field: d.field,
					target: d.target,
					...(resolvedIn.length > 0 ? { resolvedIn } : {}),
				});
			}
			entries.push({
				decision: "kept",
				from: decision.from,
				slug: slug as Slug,
				tie: decision.tie,
				...(mergedEdgeCount > 0 ? { mergedEdgeCount } : {}),
				...(decision.qidOnlyOn ? { qidOnlyOn: decision.qidOnlyOn } : {}),
			});
		} else {
			const only = (repoFile ?? serverFile) as NodeFile;
			entries.push({ decision: "copied", from: repoFile ? "repo" : "server", slug: only.slug as Slug });
			await copyNode(nodesDir, only);
		}
	}

	const redirectsPath = join(outputDir, "genre-redirects.json");
	await writeFile(redirectsPath, `${JSON.stringify({ redirects: combinedRedirects }, null, 2)}\n`, "utf8");
	// Only ONE runMigration call ever happens: preview and apply both recompute the full plan from
	// scratch. With --apply-merge, nodes/ must be archived BEFORE this call, since apply may
	// delete losers -- unless redirectsRefused, in which case nothing gets deleted.
	let archivedNodeCount = 0;
	const willApply = (options.applyMerge ?? false) && !redirectsRefused;
	if (options.applyMerge && !redirectsRefused) {
		// Archive the WHOLE union nodes/ tree -- at least covers what the migration is about to
		// delete, without needing the migration's own (unexported) per-group loser list. This is
		// exactly the B6a review gap: a live node deleted by the applied migration must never be
		// missing from both nodes/ and archive/ at once.
		await mkdir(nodesDir, { recursive: true });
		await cp(nodesDir, join(archiveDir, "pre-migration"), { recursive: true });
		archivedNodeCount = entries.filter((e) => e.decision !== "conflict").length;
	}
	const { result: migration, stderr: migrationStderr } = await captureStderr(() =>
		runMigration(outputDir, willApply, {
			redirectsPath,
			...(options.onboardingSlugs
				? { onboardingSlugs: options.onboardingSlugs }
				: options.webIndexPath
					? { webIndexPath: options.webIndexPath }
					: {}),
			// TRA-277: anchored to `repoCacheDir` -- the caller's own repo cache argument, whose
			// sibling data/genre-taxonomy.json is the real taxonomy (deploy/sync-genre-cache.sh
			// sets REPO_CACHE_DIR="$REPO_ROOT/cache", so this lines up with the real repo in
			// production) -- not to `outputDir`, see the options doc above. Deliberately NOT
			// `defaultDataDir()` (fixed to wherever this code itself lives): that would pull in
			// the real, full taxonomy for every caller, including every test here, whose own tiny
			// repoDir/serverDir never contain the full genre graph -- runMigration's own
			// "every published source must still resolve" check (D6a) is a whole-cache invariant,
			// so it would spuriously refuse on ~200 unrelated genres never seeded, everywhere else.
			// An explicit override still wins: `taxonomy` (in-memory, bypassing the disk loader)
			// over `taxonomyPath`, same precedence as runMigration's own options.
			...(options.taxonomy
				? { taxonomy: options.taxonomy }
				: {
						taxonomyPath: options.taxonomyPath ?? join(dirname(repoCacheDir), "data", "genre-taxonomy.json"),
					}),
		}),
	);

	// 2026-09-19 review of TRA-277: every non-blank line of the migration's own stderr, regardless
	// of exitCode -- see migrationApply's migrationWarnings doc for why this can't just live behind
	// the existing `refusalReason` (exitCode !== 0 only).
	const migrationWarnings = migrationStderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	let migrationApply: UnionManifest["migrationApply"];
	let referenceRegressions: UnionManifest["referenceRegressions"];
	if (options.applyMerge) {
		if (redirectsRefused) {
			// Never point at a merged union when the tables disagree (finding 3): willApply above
			// was forced false, so nothing was deleted or rewritten -- the manifest must say so too.
			migrationApply = {
				applied: false,
				groupsFound: migration.groupsFound,
				deletedCount: 0,
				exitCode: 1,
				report: migration.report,
				archivedNodeCount: 0,
				refusalReason:
					"server redirects table diverges from the repo's -- refusing to apply the merge (see redirectsConflicts)",
				removedByMigration: [],
				...(migrationWarnings.length > 0 ? { migrationWarnings } : {}),
			};
		} else {
			// Re-read AFTER the migration ran: the union's live nodes and its redirects, which the
			// migration may just have rewritten (a merged pair with no PRE-existing redirect gets one
			// created here) -- reusing the pre-migration `sourceRedirects` here would silently miss
			// that and falsely flag a reference to the loser as broken.
			const unionLiveSlugs = new Set(await new NodeCache(outputDir).listSlugs());
			const unionRedirects = await loadGenreRedirects(redirectsPath);

			const removedByMigration = entries
				.filter((e) => e.decision !== "conflict" && !unionLiveSlugs.has(e.slug))
				.map((e) => {
					const redirectsTo = unionRedirects.get(e.slug);
					return { slug: e.slug, ...(redirectsTo ? { redirectsTo } : {}) };
				});

			migrationApply = {
				applied: migration.exitCode === 0,
				groupsFound: migration.groupsFound,
				deletedCount: migration.deletedCount,
				exitCode: migration.exitCode,
				report: migration.report,
				archivedNodeCount,
				...(migration.exitCode !== 0 ? { refusalReason: migrationStderr.trim() } : {}),
				...(migrationWarnings.length > 0 ? { migrationWarnings } : {}),
				removedByMigration,
			};

			// A deleted slug's redirectsTo must be live in the union (finding 2) -- scoped to what
			// THIS run deleted, not every table entry, so an untouched stale entry (today's
			// tolerated baseline) is never flagged.
			const dangling = removedByMigration.filter((r) => !r.redirectsTo || !unionLiveSlugs.has(r.redirectsTo));
			if (dangling.length > 0) {
				redirectsConflicts = dangling.map((r) => ({
					reason: "dangling" as const,
					message: `${r.slug} was removed but its redirect target ${r.redirectsTo ?? "(none)"} is not live in the union`,
				}));
				migrationApply = { ...migrationApply, applied: false };
			}

			// Delta validation: never absolute (see file header). "Resolvable in a source" is
			// resolvedInSources above -- that source's OWN live nodes plus the PRE-migration redirect
			// table (what that source actually had); "resolvable in the union" uses the re-read
			// post-migration state above.
			const referenced = collectReferencedSlugs([...repoNodes, ...serverNodes]);

			referenceRegressions = [...referenced].flatMap((slug) => {
				const resolvedIn = resolvedInSources(slug);
				if (resolvedIn.length === 0 || slugResolves(slug, unionLiveSlugs, unionRedirects)) return [];
				return [{ slug, resolvedIn }];
			});
		}
	}

	const manifest: UnionManifest = {
		generatedAt: new Date().toISOString(),
		repoCacheDir,
		serverCacheDir,
		entries,
		skipped,
		droppedEdges,
		invalidMergedNodes,
		// Only set without --apply-merge: with it, migrationApply above is the sole (and the
		// FINAL-state) migration field -- see its type doc.
		...(migrationApply
			? {}
			: {
					migrationPreview: {
						groupsFound: migration.groupsFound,
						exitCode: migration.exitCode,
						report: migration.report,
						...(migrationWarnings.length > 0 ? { migrationWarnings } : {}),
					},
				}),
		...(migrationApply ? { migrationApply } : {}),
		...(referenceRegressions ? { referenceRegressions } : {}),
		...(redirectsConflicts ? { redirectsConflicts } : {}),
	};
	await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { outputDir, manifest };
}

export interface UnionCliArgs {
	repoCacheDir: string;
	serverCacheDir: string;
	applyMerge: boolean;
	serverRedirectsPath?: string;
}

/** Parses `<repo-cache-dir> <server-cache-dir> [--apply-merge] [--server-redirects-path <path>]`.
 * Throws (never a silent guess) when --server-redirects-path is repeated, has no value, or is
 * followed by another flag (finding 4); an unrecognized flag is present; or anything but exactly
 * two positional arguments remain. */
export function parseUnionCliArgs(argv: readonly string[]): UnionCliArgs {
	const serverRedirectsFlagIndex = argv.indexOf("--server-redirects-path");
	if (
		serverRedirectsFlagIndex !== -1 &&
		argv.lastIndexOf("--server-redirects-path") !== serverRedirectsFlagIndex
	) {
		throw new Error("--server-redirects-path may only be given once");
	}
	let serverRedirectsPath: string | undefined;
	if (serverRedirectsFlagIndex !== -1) {
		serverRedirectsPath = argv[serverRedirectsFlagIndex + 1];
		if (!serverRedirectsPath || serverRedirectsPath.startsWith("-")) {
			throw new Error("--server-redirects-path requires a value");
		}
	}
	// The flag and its value are consumed as a pair before the unknown-flag/positional checks
	// below, so neither one is mistaken for an unrecognized flag or a stray positional argument.
	const remainingArgs =
		serverRedirectsFlagIndex === -1
			? argv
			: [...argv.slice(0, serverRedirectsFlagIndex), ...argv.slice(serverRedirectsFlagIndex + 2)];
	// An unrecognized flag must never fall through to a silent preview-mode guess -- see the
	// sibling migration script's own parseCliArgs for the same discipline.
	const unknownFlag = remainingArgs.find((a) => a.startsWith("--") && a !== "--apply-merge");
	if (unknownFlag) throw new Error(`unknown argument: ${unknownFlag}`);
	const applyMerge = remainingArgs.includes("--apply-merge");
	// Exactly two positional arguments -- an unflagged typo (no dashes, or a single dash) must
	// never silently become a third, ignored token.
	const positional = remainingArgs.filter((a) => a !== "--apply-merge");
	const [repoCacheDir, serverCacheDir] = positional;
	if (positional.length !== 2 || !repoCacheDir || !serverCacheDir) {
		throw new Error(
			"usage: <repo-cache-dir> <server-cache-dir> [--apply-merge] [--server-redirects-path <path>]",
		);
	}
	return {
		repoCacheDir,
		serverCacheDir,
		applyMerge,
		...(serverRedirectsPath ? { serverRedirectsPath } : {}),
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { repoCacheDir, serverCacheDir, applyMerge, serverRedirectsPath } = parseUnionCliArgs(
		process.argv.slice(2),
	);
	for (const dir of [repoCacheDir, serverCacheDir]) {
		// A typo'd/nonexistent source silently unions "the other side alone" and exits 0 --
		// same guard the migration script's own CLI uses on itself.
		if (!(await looksLikeCacheDir(dir)))
			throw new Error(`${dir} is not a cache directory (no nodes/ subdirectory)`);
	}
	const { outputDir, manifest } = await buildCacheUnion(repoCacheDir, serverCacheDir, {
		applyMerge,
		...(serverRedirectsPath ? { serverRedirectsPath } : {}),
	});
	console.log(`Union written to ${outputDir} (${manifest.entries.length} entries)`);
	if (countUnionProblems(manifest) > 0) process.exitCode = 1;
}
