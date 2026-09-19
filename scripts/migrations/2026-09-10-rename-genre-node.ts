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
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { loadGenreRedirects, parseGenreRedirects } from "../../src/genre-registry.js";
import { type GenreTaxonomy, loadGenreTaxonomy } from "../../src/genre-taxonomy.js";
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
// Converged (2026-09-17 review) on the same rules as 2026-09-04-merge-genre-duplicates.ts's own
// TRA-138/D6a protection -- duplicated here rather than imported, since that migration hasn't
// merged yet (refactor to share once both have):
//  - v1 (ONBOARDING_GENRES, web/index.html): only the identifier's outright ABSENCE from the
//    file means "retired on purpose" (D3, TRA-211), swallowed to `undefined`. Present but
//    unreadable for any other reason (reformatted so the array-literal regex misses, a directory
//    where the file should be, ...) fails loudly -- loadOnboardingGenreSlugs's own rejection
//    propagates uncaught, never converted into a clean error report.
//  - v2 (the genre taxonomy): every *published* genre's source slugs, resolved by the same
//    canonical loader runMigration uses (loadGenreTaxonomy -- resolution, QID handling and
//    invariants included), at a `data/` sibling of `cacheDir` by default, so the loader's own
//    cache-root inference lines up with the cache this migration actually operates on.
//  - Both guards are additive; neither being available is a refusal, never an empty check --
//    same for a taxonomy that loads but publishes nothing.
//  - Post-operation: every protected slug (a published source, or an already-recorded redirect
//    key) must still resolve afterwards -- a live node, or one redirect hop away from one.

/** Duplicated from the merge migration's own `stillResolves` (TRA-138/D6a): an existing node
 * always wins, unchanged, over a stale redirect entry (resolveReadSlug's rule 2); otherwise one
 * redirect hop is followed. */
export function stillResolves(
	slug: string,
	redirects: Readonly<Record<string, string>>,
	survivingSlugs: ReadonlySet<string>,
): boolean {
	return survivingSlugs.has(slug) || survivingSlugs.has(redirects[slug] ?? slug);
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

	// v1: only outright absence from the file is tolerated -- see header comment above; any other
	// failure (present but unreadable) is left to throw out of loadOnboardingGenreSlugs uncaught.
	let onboardingSlugs: string[] | undefined;
	if (options.onboardingSlugs) {
		onboardingSlugs = [...options.onboardingSlugs];
	} else {
		const webIndexPath = options.webIndexPath ?? join(defaultDataDir(), "..", "web", "index.html");
		// 2026-09-19 review of TRA-277: converged with runMigration's own hardening (2026-09-17,
		// TRA-138) -- only a file that EXISTS and no longer names the constant is the planned D3
		// retirement. A MISSING web/index.html is a wrong path or a broken checkout, not that, and
		// must fail loudly; reading it as an empty string via readTextOrDefault used to disarm the
		// v1 guard silently AND, with this ticket's own branch-3 addition, print a reassuring
		// "considered retired" notice for what is actually a broken checkout.
		const html = await readFile(webIndexPath, "utf8");
		onboardingSlugs = /\bONBOARDING_GENRES\b/.test(html)
			? await loadOnboardingGenreSlugs(webIndexPath)
			: undefined;
	}

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

	// v2: the genre taxonomy, via the same canonical loader runMigration (D6a) uses -- see header.
	let taxonomySources: string[] | undefined;
	let taxonomyAbsent = false;
	if (options.taxonomy) {
		taxonomySources = options.taxonomy.genres.filter((g) => g.published).flatMap((g) => g.sourceSlugs ?? []);
	} else {
		const taxonomyPath = options.taxonomyPath ?? join(dirname(cacheDir), "data", "genre-taxonomy.json");
		let taxonomyPathReadable = true;
		try {
			await stat(taxonomyPath);
		} catch (e) {
			taxonomyPathReadable = false;
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				taxonomyAbsent = true;
			} else {
				errors.push(
					`genre taxonomy path unreadable: ${taxonomyPath}: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
		if (taxonomyPathReadable) {
			try {
				const taxonomy = await loadGenreTaxonomy(taxonomyPath);
				taxonomySources = taxonomy.genres.filter((g) => g.published).flatMap((g) => g.sourceSlugs ?? []);
			} catch (e) {
				errors.push(`genre taxonomy failed to load: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	if (taxonomySources !== undefined && taxonomySources.length === 0) {
		errors.push("genre taxonomy loaded but publishes no genres -- refusing rather than protecting nothing");
		taxonomySources = undefined;
	}
	if (onboardingSlugs === undefined && taxonomySources === undefined) {
		errors.push(
			"no genre protection available: both ONBOARDING_GENRES and the genre taxonomy are missing -- " +
				"refusing rather than renaming unchecked",
		);
	} else if (taxonomyAbsent && onboardingSlugs !== undefined) {
		process.stderr.write(
			"warning: genre taxonomy not found -- proceeding with v1 (ONBOARDING_GENRES) protection alone\n",
		);
	} else if (onboardingSlugs === undefined && taxonomySources !== undefined) {
		// TRA-277 (D6c), converged with the merge migration's own identical fix: the planned D3
		// retirement (ONBOARDING_GENRES gone from web/index.html, TRA-211) is the nominal end
		// state, not a corruption -- say so explicitly, same as the taxonomy-absent branch above
		// does for its own fallback.
		process.stderr.write(
			"warning: ONBOARDING_GENRES not found in web/index.html -- v1 protection is considered " +
				"retired (TRA-211); proceeding with the genre taxonomy protection alone\n",
		);
	}

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

	// Post-operation (TRA-139/D6b, converged with D6a): every published taxonomy source, and
	// every slug the redirects table already protected before this run, must still resolve
	// afterwards -- via mergedRedirects, not literal survival, so a safe rename-with-redirect is
	// accepted while a resolution actually broken by drift or corruption is refused.
	if (taxonomySources !== undefined) {
		const survivingSlugs = new Set(resultNodes.flatMap((n) => (typeof n.slug === "string" ? [n.slug] : [])));
		const protectedSlugs = new Set([...taxonomySources, ...existingRedirects.keys()]);
		for (const slug of protectedSlugs) {
			if (!stillResolves(slug, mergedRedirects, survivingSlugs)) {
				errors.push(`genre taxonomy protection: ${slug} no longer resolves after this rename`);
			}
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
