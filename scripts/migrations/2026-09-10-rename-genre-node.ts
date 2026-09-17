/**
 * CLI, disk application and report for renaming a single genre node's slug while leaving its
 * content untouched (TRA-35): reads `from`, writes it under `to` with slug: to, rewrites every
 * cache-wide incoming edge (slug, plus the denormalized qid when it disagrees with the node's
 * own), rewrites pending-reverses.json, adds a flattened `from -> to` redirect, and deletes
 * `from` last. Dry-run by default; fails loudly (writes nothing on an invariant violation) and
 * is idempotent.
 *
 * WHY (2026-09-10, TRA-35): genre:trap collided two concepts under one slug -- the MusicBrainz
 * tag "trap" denotes trap hip-hop (Q2913982), while the node materialized under genre:trap is
 * actually "Trap (EDM)" (Q47781397, TRA-33). Renaming it to genre:edm-trap and redirecting
 * genre:trap -> genre:edm-trap frees the slug for trap hip-hop without ever creating a
 * duplicate (genre-registry.ts follows a redirect before minting).
 *
 * Reuses 2026-09-04-merge-genre-duplicates.ts rather than duplicating it (rewriteNodeEdges,
 * rewritePendingReverses, mergeRedirects, readCacheNodes, loadOnboardingGenreSlugs,
 * looksLikeCacheDir, isRecord, isNodeType, defaultDataDir, readTextOrDefault, plus
 * atomicWriteJson from src/cache.ts). rewriteNodeEdges/rewritePendingReverses were generalized
 * there (RewriteTarget: a bare slug, still all the merge script passes, or `{ slug, qid }`) to
 * also correct a denormalized qid -- the merge script's own behavior/tests are unchanged.
 *
 * Deployment (same procedure as TRA-42): also run this against the server's cache (stop the
 * server first, restart after -- the redirects table is memoized per-process), merging the
 * repo's and the server's redirects tables (append-only, chains flattened) if they diverge.
 * This rename itself doesn't need the QID backfill (it matches by explicit slug, not QID) --
 * but see 2026-09-04-merge-genre-duplicates.ts's header (TRA-48) for that prerequisite when
 * the duplicate merge runs in the same server window.
 *
 * Usage: tsx scripts/migrations/2026-09-10-rename-genre-node.ts <cache-dir> <from> <to>
 *        [--apply] [--redirects <path>]
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { loadGenreRedirects, parseGenreRedirects } from "../../src/genre-registry.js";
import { type GenreTaxonomy, validateGenreTaxonomy } from "../../src/genre-taxonomy.js";
import { LIST_EDGES_BY_TYPE, type NodeType, SINGULAR_EDGES_BY_TYPE } from "../../src/node-spec.js";
import { isValidSlug, parseSlug } from "../../src/slug.js";
import type { Slug } from "../../src/types.js";
import {
	type CacheNodeFile,
	defaultDataDir,
	isNodeType,
	isRecord,
	loadOnboardingGenreSlugs,
	looksLikeCacheDir,
	mergeRedirects,
	type RewriteTarget,
	readCacheNodes,
	readTextOrDefault,
	rewriteNodeEdges,
	rewritePendingReverses,
} from "./2026-09-04-merge-genre-duplicates.js";

function isGenreSlug(value: string): value is Slug {
	return isValidSlug(value) && value.startsWith("genre:");
}

function formatRenameReport(args: {
	from: Slug;
	to: Slug;
	renamed: boolean;
	hitsByType: ReadonlyMap<NodeType, number>;
	qidFixes: number;
	redirects: { newCount: number; totalCount: number };
	dryRun: boolean;
	note?: string;
}): string {
	const { from, to, renamed, hitsByType, qidFixes, redirects, dryRun, note } = args;
	const totalRewritten = [...hitsByType.values()].reduce((sum, n) => sum + n, 0);
	const lines: string[] = [`=== Genre rename${dryRun ? " (DRY RUN)" : ""} ===`];
	lines.push(`${"From:".padEnd(24)}${from}`);
	lines.push(`${"To:".padEnd(24)}${to}`);
	if (note) {
		lines.push(note);
		return lines.join("\n");
	}
	lines.push(`${"Nodes renamed:".padEnd(24)}${renamed ? 1 : 0}`);
	lines.push(`${"Incoming edges rewritten:".padEnd(24)}${totalRewritten}`);
	lines.push(`${"Denormalized qids fixed:".padEnd(24)}${qidFixes}`);
	lines.push(`${"Redirects (new/total):".padEnd(24)}${redirects.newCount}/${redirects.totalCount}`);

	lines.push("", "=== Edges rewritten by node type ===");
	if (hitsByType.size === 0) {
		lines.push("  (none)");
	} else {
		for (const [type, count] of [...hitsByType.entries()].sort()) {
			lines.push(`  ${type.padEnd(10)} ${count}`);
		}
	}
	lines.push(`  ${"total".padEnd(10)} ${totalRewritten}`);

	return lines.join("\n");
}

export interface RenameResult {
	report: string;
	/** True only when this call actually wrote the rename (apply=true, not already done). */
	applied: boolean;
	exitCode: 0 | 1;
}

// --- Taxonomy-backed protection (2026-09-17, TRA-139/D6b) ---
//
// ONBOARDING_GENRES (checked below, unchanged) is web/index.html's v1 picker constant and is
// due for removal by D3 (TRA-211): once gone, it can no longer be this migration's only guard
// against renaming a slug still needed for resolution. From here on the same invariant is also
// checked against data/genre-taxonomy.json (v2, loaded through its own canonical validator --
// src/genre-taxonomy.ts's validateGenreTaxonomy -- never hand-rolled here): every *published*
// genre's declared identity (explicit sourceSlugs, or -- for a family-umbrella entry with none
// -- its qid) must still resolve to a live node after the rename, the same one-hop
// redirect-or-live-node rule genre-registry.ts's resolveReadSlug applies at read time. Both
// guards run when both are available; either alone is enough to protect a slug still in use.
// Neither available is never treated as "nothing to protect" -- it's a refusal (see runRename).

export type TaxonomyLoadResult =
	| { status: "ok"; taxonomy: GenreTaxonomy }
	| { status: "absent" }
	| { status: "invalid"; error: string };

/** Schema-only load (no source resolution against a live cache -- this script does that itself,
 * in memory, against the post-rename plan, via findLostTaxonomyResolutions below). */
export async function loadTaxonomyOrStatus(path: string): Promise<TaxonomyLoadResult> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
		return { status: "invalid", error: e instanceof Error ? e.message : String(e) };
	}
	try {
		return { status: "ok", taxonomy: validateGenreTaxonomy(JSON.parse(raw)) };
	} catch (e) {
		return { status: "invalid", error: e instanceof Error ? e.message : String(e) };
	}
}

/** Tolerant wrapper around loadOnboardingGenreSlugs: once D3 deletes ONBOARDING_GENRES (or the
 * file itself can't be read), that's "the v1 guard is retired", not a crash -- the taxonomy
 * guard above is what's left to protect the slug. Still warns loudly on the fallback (2026-09-17
 * review): the same catch also covers a still-in-use constant broken by an unrelated regression
 * (a renamed variable, a stale regex), which must not silently disable the v1 guard without a
 * trace -- only the taxonomy result decides whether that's still safe overall.
 */
async function loadOnboardingSlugsOrAbsent(webIndexPath?: string): Promise<string[] | undefined> {
	try {
		return await loadOnboardingGenreSlugs(webIndexPath);
	} catch (e) {
		process.stderr.write(
			`warning: ONBOARDING_GENRES unreadable (${e instanceof Error ? e.message : String(e)}) -- ` +
				"falling back to the genre-taxonomy guard alone\n",
		);
		return undefined;
	}
}

export interface TaxonomyResolutionError {
	genreId: string;
	source: Slug | "(none)";
	reason: string;
}

/**
 * Pure post-write check: does every published genre in `taxonomy` still resolve, given the
 * post-rename node set and the merged redirect table? Mirrors src/genre-taxonomy.ts's own
 * source-resolution rule (resolveReadSlug: a live node wins unchanged, else follow one redirect
 * hop) plus its contradictory-qid guard, against the in-memory plan rather than a second disk
 * read -- this runs *before* anything is written, same as the dangling-edge check above it.
 */
export function findLostTaxonomyResolutions(
	taxonomy: GenreTaxonomy,
	nodesAfter: readonly Record<string, unknown>[],
	redirectsAfter: ReadonlyMap<string, string>,
): TaxonomyResolutionError[] {
	const bySlug = new Map(nodesAfter.map((n) => [String(n.slug), n]));
	const qidIndex = new Map<string, string>();
	for (const n of nodesAfter) {
		if (
			n.type === "genre" &&
			typeof n.qid === "string" &&
			typeof n.slug === "string" &&
			!qidIndex.has(n.qid)
		) {
			qidIndex.set(n.qid, n.slug);
		}
	}
	const resolve = (slug: string): string => (bySlug.has(slug) ? slug : (redirectsAfter.get(slug) ?? slug));

	const errors: TaxonomyResolutionError[] = [];
	for (const genre of taxonomy.genres) {
		if (!genre.published) continue;
		// Union, not fallback (2026-09-17 review): src/genre-taxonomy.ts's loadSources always
		// combines explicit sourceSlugs with the qid-index hit, deduplicated -- never one or the
		// other -- so a family-umbrella entry that *also* carries curated sourceSlugs is checked
		// on both, same as the real loader would resolve it.
		const qidSource = genre.qid ? qidIndex.get(genre.qid) : undefined;
		const sources = [...new Set([...(genre.sourceSlugs ?? []), ...(qidSource ? [qidSource as Slug] : [])])];
		if (sources.length === 0) {
			errors.push({ genreId: genre.id, source: "(none)", reason: "no source resolves after the rename" });
			continue;
		}
		for (const source of sources) {
			const resolved = resolve(source);
			const resolvedNode = bySlug.get(resolved);
			if (!resolvedNode) {
				errors.push({ genreId: genre.id, source, reason: `${source} -> ${resolved} does not exist` });
			} else if (genre.qid && typeof resolvedNode.qid === "string" && resolvedNode.qid !== genre.qid) {
				errors.push({
					genreId: genre.id,
					source,
					reason: `${source} -> ${resolved} carries a different qid`,
				});
			}
		}
	}
	return errors;
}

/**
 * Runs the rename against `cacheDir`: builds the plan in memory, verifies invariants before
 * touching disk, writes only if clean and `apply` is set. No process.exit -- exit code only.
 */
export async function runRename(
	cacheDir: string,
	from: Slug,
	to: Slug,
	apply: boolean,
	options: {
		redirectsPath?: string;
		onboardingSlugs?: readonly string[];
		webIndexPath?: string;
		taxonomy?: GenreTaxonomy;
		taxonomyPath?: string;
	} = {},
): Promise<RenameResult> {
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	for (const { path, error } of invalid) {
		process.stderr.write(`warning: skipping unreadable node file ${path}: ${error}\n`);
	}

	const bySlug = new Map(nodes.map((f) => [f.slug, f]));
	const onboardingSlugs =
		options.onboardingSlugs ?? (await loadOnboardingSlugsOrAbsent(options.webIndexPath));
	const taxonomyResult: TaxonomyLoadResult = options.taxonomy
		? { status: "ok", taxonomy: options.taxonomy }
		: await loadTaxonomyOrStatus(options.taxonomyPath ?? join(defaultDataDir(), "genre-taxonomy.json"));
	const redirectsPath = options.redirectsPath ?? join(defaultDataDir(), "genre-redirects.json");
	const existingRedirects = await loadGenreRedirects(redirectsPath);

	const fromFile = bySlug.get(from);
	const toFile = bySlug.get(to);
	const earlyReport = (note: string): string =>
		formatRenameReport({
			from,
			to,
			renamed: false,
			hitsByType: new Map(),
			qidFixes: 0,
			redirects: { newCount: 0, totalCount: existingRedirects.size },
			dryRun: !apply,
			note,
		});

	// Idempotence: a completed prior run leaves `from` gone, `to` in place, redirect recorded --
	// that shape is "nothing to do", not a "from must exist" error (anything else below fails loud).
	if (!fromFile && toFile && existingRedirects.get(from) === to) {
		return {
			report: earlyReport(`${from} is already renamed to ${to} -- nothing to do.`),
			applied: false,
			exitCode: 0,
		};
	}

	const errors: string[] = [];
	if (toFile) errors.push(`target slug ${to} already exists`);
	if (existingRedirects.has(to)) errors.push(`target slug ${to} is itself a redirect source`);
	if (!fromFile) {
		errors.push(`source slug ${from} does not exist`);
	} else if (fromFile.type !== "genre") {
		errors.push(`source slug ${from} is not a genre node (type: ${fromFile.type})`);
	}
	if (errors.length > 0) {
		for (const err of errors) process.stderr.write(`error: ${err}\n`);
		return {
			report: earlyReport(errors.map((e) => `error: ${e}`).join("\n")),
			applied: false,
			exitCode: 1,
		};
	}
	const source = fromFile as CacheNodeFile;

	// The node's own qid never changes -- that's what every rewritten incoming edge aligns on.
	const nodeQid = typeof source.node.qid === "string" ? source.node.qid : undefined;
	const rewriteTarget: RewriteTarget = nodeQid ? { slug: to, qid: nodeQid } : to;
	const rewriteMap = new Map<string, RewriteTarget>([[from, rewriteTarget]]);

	const renamedSource: Record<string, unknown> = { ...source.node, slug: to };
	const writes = new Map<string, Record<string, unknown>>();
	const hitsByType = new Map<NodeType, number>();
	let qidFixesTotal = 0;
	const resultNodes: Record<string, unknown>[] = [renamedSource];

	for (const file of nodes) {
		if (file.slug === from) continue; // handled above: content unchanged but for its slug
		const { node: rewritten, hits, qidFixes } = rewriteNodeEdges(file.node, file.type, rewriteMap);
		const typeHits = [...hits.values()].reduce((sum, n) => sum + n, 0);
		if (typeHits > 0) hitsByType.set(file.type, (hitsByType.get(file.type) ?? 0) + typeHits);
		qidFixesTotal += [...qidFixes.values()].reduce((sum, n) => sum + n, 0);
		if (JSON.stringify(rewritten) !== JSON.stringify(file.node)) writes.set(file.path, rewritten);
		resultNodes.push(rewritten);
	}

	// --- Verify invariants in memory before writing anything.
	for (const node of resultNodes) {
		if (!isNodeType(node.type) || typeof node.slug !== "string") continue;
		for (const field of [...LIST_EDGES_BY_TYPE[node.type], ...SINGULAR_EDGES_BY_TYPE[node.type]]) {
			const value = node[field];
			const edges = Array.isArray(value) ? value : value ? [value] : [];
			for (const edge of edges) {
				if (isRecord(edge) && edge.slug === from) {
					errors.push(`dangling edge: ${node.slug}.${field} still points to renamed slug ${from}`);
				}
			}
		}
	}

	let mergedRedirects: Record<string, string> = {};
	try {
		mergedRedirects = mergeRedirects(Object.fromEntries(existingRedirects), { [from]: to });
		parseGenreRedirects({ redirects: mergedRedirects }); // re-validates the flattening invariant
	} catch (e) {
		errors.push(`redirects table would fail validation: ${e instanceof Error ? e.message : String(e)}`);
	}

	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pendingParsed: Record<string, PendingReverse[]> = {};
	try {
		pendingParsed = JSON.parse(await readTextOrDefault(pendingPath, "{}")) as Record<
			string,
			PendingReverse[]
		>;
	} catch (e) {
		errors.push(`pending-reverses.json is invalid: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Strict guard, same rule as the merge script (2026-09-11, review 1): web/index.html's
	// genrePickList() filters ONBOARDING_GENRES by cache membership only, never through
	// DATA.redirects -- a renamed slug would silently vanish from onboarding, not follow it.
	// Kept only as long as the constant itself is still readable (v1 picker still in use);
	// once D3 removes it, `onboardingSlugs` is undefined and this guard is simply skipped.
	if (onboardingSlugs?.includes(from)) {
		errors.push(`${from} is an ONBOARDING_GENRES slug; update web/index.html first`);
	}

	// TRA-139/D6b: the taxonomy (v2) and ONBOARDING_GENRES (v1) guards are additive, but never
	// both absent -- an absent v1 constant with no taxonomy to fall back on would otherwise run
	// this migration with *no* resolution protection at all, silently. Same for an unreadable
	// taxonomy: a schema failure could just as easily be hiding a real duplicate/ambiguity, so
	// it refuses rather than proceeding as if the taxonomy weren't there.
	if (taxonomyResult.status === "invalid") {
		errors.push(
			`genre taxonomy failed validation, refusing rather than skipping its guard: ${taxonomyResult.error}`,
		);
	} else if (taxonomyResult.status === "absent" && onboardingSlugs === undefined) {
		errors.push(
			"neither the genre taxonomy nor the ONBOARDING_GENRES constant is available -- refusing rather than running an empty resolution check",
		);
	} else if (taxonomyResult.status === "ok") {
		const mergedRedirectsMap = new Map(Object.entries(mergedRedirects));
		for (const lost of findLostTaxonomyResolutions(
			taxonomyResult.taxonomy,
			resultNodes,
			mergedRedirectsMap,
		)) {
			errors.push(
				`genre taxonomy entry ${lost.genreId} would lose resolution (source ${lost.source}): ${lost.reason}`,
			);
		}
	}

	const newCount = existingRedirects.has(from) ? 0 : 1;
	const redirectsWritten = { newCount, totalCount: Object.keys(mergedRedirects).length };
	const report = formatRenameReport({
		from,
		to,
		renamed: true,
		hitsByType,
		qidFixes: qidFixesTotal,
		redirects: redirectsWritten,
		dryRun: !apply,
	});

	if (errors.length > 0) {
		for (const err of errors) process.stderr.write(`error: ${err}\n`);
		return { report, applied: false, exitCode: 1 };
	}

	if (!apply) return { report, applied: false, exitCode: 0 };

	// --- Apply, crash-safe order (same as TRA-22/41): nodes -> pending -> redirects -> THEN
	// delete `from` last (a briefly-duplicated node is harmless; deleting first could lose both).
	const toPath = join(cacheDir, "nodes", parseSlug(to).type, `${parseSlug(to).body}.json`);
	await mkdir(dirname(toPath), { recursive: true });
	await atomicWriteJson(toPath, renamedSource);
	for (const [path, node] of writes) await atomicWriteJson(path, node);

	const { result: nextPending, changed: pendingChanged } = rewritePendingReverses(pendingParsed, rewriteMap);
	if (pendingChanged) await atomicWriteJson(pendingPath, nextPending);

	await mkdir(dirname(redirectsPath), { recursive: true });
	await atomicWriteJson(redirectsPath, {
		source: "genre node rename",
		generated_at: new Date().toISOString(),
		redirects: mergedRedirects,
	});

	await rm(source.path);

	return { report, applied: true, exitCode: 0 };
}

export interface CliArgs {
	cacheDir: string;
	from: string;
	to: string;
	apply: boolean;
	redirectsPath?: string;
}

/**
 * Parses `<cache-dir> <from> <to> [--apply] [--redirects <path>]`, modeled on the merge
 * script's parseCliArgs: null (exit 2) on a bad positional, a malformed/repeated --redirects,
 * or any unconsumed argv token -- never a guess.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	const from = argv[1];
	const to = argv[2];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	if (!from || from.startsWith("-")) return null;
	if (!to || to.startsWith("-")) return null;

	const redirectsIndex = argv.indexOf("--redirects");
	if (redirectsIndex >= 0 && argv.lastIndexOf("--redirects") !== redirectsIndex) return null;
	const redirectsPath = redirectsIndex >= 0 ? argv[redirectsIndex + 1] : undefined;
	if (redirectsIndex >= 0 && (!redirectsPath || redirectsPath.startsWith("-"))) return null;

	const consumed = new Set([0, 1, 2, redirectsIndex, redirectsIndex + 1, argv.indexOf("--apply")]);
	if (argv.some((_, i) => i > 2 && !consumed.has(i))) return null;

	return { cacheDir, from, to, apply: argv.includes("--apply"), ...(redirectsPath ? { redirectsPath } : {}) };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-09-10-rename-genre-node.ts <cache-dir> <from> <to> [--apply] [--redirects <path>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	if (!isGenreSlug(args.from) || !isGenreSlug(args.to)) {
		process.stderr.write("error: <from> and <to> must both be genre slugs (genre:...)\n");
		process.exit(2);
	}
	const result = await runRename(
		args.cacheDir,
		args.from,
		args.to,
		args.apply,
		args.redirectsPath ? { redirectsPath: args.redirectsPath } : {},
	);
	console.log(result.report);
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// Guarded like the other migrations in this directory, so importing this module from a
	// test doesn't require a cache-dir argument or touch the filesystem.
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
