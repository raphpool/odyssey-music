/**
 * CLI, disk application and report for merging genre nodes sharing a Wikidata QID (election
 * / union / rewrite / redirect rules: TRA-22 above). Elect, union edges, rewrite every other
 * node's edges pointing at a loser, delete the losers, rewrite pending-reverses.json, and
 * record loser -> canonical in data/genre-redirects.json.
 *
 * WARNING: with --apply, this DELETES cache files and rewrites edges cache-wide. Dry-run by
 * default. Fails loudly (an invariant violation writes nothing) and is idempotent.
 *
 * Deployment (TRA-30 review): deploy/deploy-server.sh rsyncs cache/** excluded, so this must
 * also run on the server's cache (server stopped, then restarted -- cacheIndex and the
 * redirects table are memoized per-process). data/genre-redirects.json must be committed;
 * merge the repo's and the server's tables (append-only, chains flattened) if they differ.
 *
 * PREREQUISITE (TRA-42/TRA-48): run `npm run migrate:genre-qid -- cache --apply` (QID
 * backfill) on that same cache first. A node without a `qid` never joins a duplicate group,
 * so a cache that hasn't been backfilled yet reports "nothing to merge" -- indistinguishable
 * from a genuinely already-merged cache -- while still hiding real duplicates.
 *
 * Usage: tsx scripts/migrations/2026-09-04-merge-genre-duplicates.ts <cache-dir> [--apply]
 *        [--redirects <path>]
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache, type PendingReverse } from "../../src/cache.js";
import { normalizeGenreName } from "../../src/genre-identity.js";
import { loadGenreRedirects, parseGenreRedirects } from "../../src/genre-registry.js";
import { type GenreTaxonomy, loadGenreTaxonomy } from "../../src/genre-taxonomy.js";
import {
	LIST_EDGES_BY_TYPE,
	NODE_TYPES,
	type NodeType,
	SINGULAR_EDGES_BY_TYPE,
} from "../../src/node-spec.js";
import { parseSlug } from "../../src/slug.js";
import { buildDuplicateReport, type DuplicateGroup } from "../report-genre-duplicates.js";

// Exported (2026-09-10, TRA-35): the single-slug rename migration reuses this instead of
// duplicating it.
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

function compareLex(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// --- Election (pure) ---

export type ElectionCriterion =
	| "existing-redirect"
	| "usage-count"
	| "catalog-name"
	| "slug-length"
	| "slug-lex-order";

export interface ElectionCandidate {
	slug: string;
	name: string;
	usages: number;
}

export interface ElectionResult {
	winner: ElectionCandidate;
	losers: ElectionCandidate[];
	criterion: ElectionCriterion;
}

/**
 * Elects the canonical member of a QID group: an existing redirect between two members of
 * the group wins outright (see criterion 0 below); otherwise most incoming usages wins; at a
 * tie, the node whose name matches the Wikidata catalog name for the QID; else shortest slug;
 * else lexicographic order. Order-independent -- the same group, in any order, always
 * elects the same winner. Usages first among the remaining criteria (2026-09-10, reversed
 * from catalog-name-first): see the header comment for why.
 *
 * `existingRedirects` defaults to empty so every prior caller (this module's own tests
 * included) keeps behaving exactly as before.
 */
export function electCanonical(
	members: readonly ElectionCandidate[],
	catalogName: string | undefined,
	existingRedirects: ReadonlyMap<string, string> = new Map(),
): ElectionResult {
	if (members.length === 0) throw new Error("electCanonical: empty group");

	// Criterion 0 (2026-09-11, TRA-48): prod elected genre:minimal while the repo's
	// already-shipped table said genre:minimal -> genre:minimal-music (elected there) --
	// two caches, two elections, then a "redirect cycle detected" refusal on the next merge.
	// The table records a decision already taken elsewhere; election must converge to it.
	const memberSlugs = new Set(members.map((m) => m.slug));
	const existingTargets = new Set<string>();
	for (const member of members) {
		const target = existingRedirects.get(member.slug);
		if (target !== undefined && memberSlugs.has(target)) existingTargets.add(target);
	}
	if (existingTargets.size > 1) {
		// Defensive: a flattened table can never store two distinct targets for members of
		// the same group, but a corrupted or hand-edited one could -- fail loudly.
		const targets = [...existingTargets].sort().join(", ");
		throw new Error(
			`electCanonical: group has ${existingTargets.size} conflicting existing-redirect targets (${targets})`,
		);
	}
	if (existingTargets.size === 1) {
		const targetSlug = [...existingTargets][0] as string;
		const winner = members.find((m) => m.slug === targetSlug) as ElectionCandidate;
		return { winner, losers: members.filter((m) => m.slug !== targetSlug), criterion: "existing-redirect" };
	}

	const maxUsage = Math.max(...members.map((m) => m.usages));
	const byUsage = members.filter((m) => m.usages === maxUsage);

	let winner: ElectionCandidate;
	let criterion: ElectionCriterion;
	if (byUsage.length === 1) {
		winner = byUsage[0] as ElectionCandidate;
		criterion = "usage-count";
	} else {
		const byName = catalogName
			? byUsage.filter((m) => normalizeGenreName(m.name) === normalizeGenreName(catalogName))
			: [];
		if (byName.length === 1) {
			winner = byName[0] as ElectionCandidate;
			criterion = "catalog-name";
		} else {
			const pool = byName.length > 1 ? byName : byUsage;
			const minLength = Math.min(...pool.map((m) => m.slug.length));
			const byLength = pool.filter((m) => m.slug.length === minLength);
			winner = [...byLength].sort((a, b) => compareLex(a.slug, b.slug))[0] as ElectionCandidate;
			criterion = byLength.length === 1 ? "slug-length" : "slug-lex-order";
		}
	}

	return { winner, losers: members.filter((m) => m.slug !== winner.slug), criterion };
}

// --- Edge union (pure) ---

/** First occurrence wins, starting with the canonical's own list, deduplicated by slug. */
export function unionListField(
	canonicalList: readonly unknown[],
	loserLists: readonly (readonly unknown[])[],
): unknown[] {
	const seen = new Set<string>();
	const merged: unknown[] = [];
	for (const edge of [canonicalList, ...loserLists].flat()) {
		const slug = isRecord(edge) && typeof edge.slug === "string" ? edge.slug : undefined;
		// An edge without a string slug is kept as-is (consistent with rewriteNodeEdges's
		// dedupe below) -- only slug-bearing edges participate in the dedupe-by-slug.
		if (slug !== undefined) {
			if (seen.has(slug)) continue;
			seen.add(slug);
		}
		merged.push(edge);
	}
	return merged;
}

/** The canonical's value wins when present; otherwise the first non-empty loser value. */
export function unionSingularField(canonicalValue: unknown, loserValues: readonly unknown[]): unknown {
	return canonicalValue ?? loserValues.find((v) => v != null) ?? canonicalValue;
}

/**
 * Merges every genre edge field of the losers into the canonical node. Everything else --
 * editorial prose included -- is left as-is: edges are unioned, prose is never merged. A
 * loser's edge pointing at the canonical itself (a real case: two duplicates commonly link
 * to each other as "related") would otherwise survive the union as a self-loop -- dropped
 * here, from list fields by filtering and from a singular field by clearing it to undefined.
 */
export function mergeGenreEdges(
	canonical: Record<string, unknown>,
	losers: readonly Record<string, unknown>[],
): Record<string, unknown> {
	const ownSlug = typeof canonical.slug === "string" ? canonical.slug : undefined;
	const merged: Record<string, unknown> = { ...canonical };
	for (const field of LIST_EDGES_BY_TYPE.genre) {
		const canonicalList = Array.isArray(canonical[field]) ? (canonical[field] as unknown[]) : [];
		const loserLists = losers.map((l) => (Array.isArray(l[field]) ? (l[field] as unknown[]) : []));
		merged[field] = unionListField(canonicalList, loserLists).filter(
			(r) => !(isRecord(r) && r.slug === ownSlug),
		);
	}
	for (const field of SINGULAR_EDGES_BY_TYPE.genre) {
		const value = unionSingularField(
			canonical[field],
			losers.map((l) => l[field]),
		);
		merged[field] = isRecord(value) && value.slug === ownSlug ? undefined : value;
	}
	return merged;
}

// --- Cache-wide incoming edge rewrite (pure) ---

/**
 * A rewrite target: either a bare slug (the merge script's own usage -- an edge's slug is
 * rewritten, its qid left alone since a QID-duplicate merge unifies same-real-entity nodes),
 * or a slug plus the qid to stamp on any rewritten edge that already carries a *different*
 * qid. Generalized 2026-09-10 (TRA-35) for the genre-rename migration, which needs to also
 * correct a denormalized qid drifted from the node's own -- see rename script for why. Never
 * changes the merge script's own behavior: it only ever passes bare-string targets.
 */
export type RewriteTarget = string | { slug: string; qid?: string };

/**
 * Rewrites every edge on `node` whose slug is a key of `rewriteMap` to point at its mapped
 * value, deduplicating list fields afterwards by slug. Returns which loser slugs were
 * actually redirected (and how many times), for reporting, plus which of those rewrites also
 * corrected an existing-but-wrong denormalized qid (only ever non-empty for an object rewrite
 * target -- see RewriteTarget). A rewrite can turn an edge into a self-loop (node itself
 * referenced a loser that redirects back to node's own slug) -- dropped from list fields by
 * filtering, from a singular field by clearing it to undefined.
 */
export function rewriteNodeEdges(
	node: Record<string, unknown>,
	type: NodeType,
	rewriteMap: ReadonlyMap<string, RewriteTarget>,
): { node: Record<string, unknown>; hits: Map<string, number>; qidFixes: Map<string, number> } {
	const hits = new Map<string, number>();
	const qidFixes = new Map<string, number>();
	const ownSlug = typeof node.slug === "string" ? node.slug : undefined;
	const rewriteRef = (edge: unknown): unknown => {
		const slug = isRecord(edge) && typeof edge.slug === "string" ? edge.slug : undefined;
		const target = slug ? rewriteMap.get(slug) : undefined;
		if (!target) return edge;
		hits.set(slug as string, (hits.get(slug as string) ?? 0) + 1);
		const nextSlug = typeof target === "string" ? target : target.slug;
		const nextQid = typeof target === "string" ? undefined : target.qid;
		const record = edge as Record<string, unknown>;
		const qidChanged = nextQid !== undefined && typeof record.qid === "string" && record.qid !== nextQid;
		if (qidChanged) qidFixes.set(slug as string, (qidFixes.get(slug as string) ?? 0) + 1);
		return { ...record, slug: nextSlug, ...(qidChanged ? { qid: nextQid } : {}) };
	};

	const next: Record<string, unknown> = { ...node };
	for (const field of LIST_EDGES_BY_TYPE[type]) {
		const list = node[field];
		if (!Array.isArray(list)) continue;
		const seen = new Set<string>();
		next[field] = list.map(rewriteRef).filter((edge) => {
			const slug = isRecord(edge) && typeof edge.slug === "string" ? edge.slug : undefined;
			if (slug === undefined) return true;
			if (slug === ownSlug || seen.has(slug)) return false;
			seen.add(slug);
			return true;
		});
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		const value = node[field];
		if (!isRecord(value) || typeof value.slug !== "string") continue;
		const rewritten = rewriteRef(value);
		next[field] = isRecord(rewritten) && rewritten.slug === ownSlug ? undefined : rewritten;
	}

	return { node: next, hits, qidFixes };
}

// --- Redirect table (pure) ---

/**
 * Combines an existing redirect table with this run's new loser -> canonical pairs,
 * flattening chains (a -> b, then b -> c, becomes a -> c and b -> c) so no stored value is
 * ever also a stored key. Append-only: existing keys are never dropped. Keys sorted.
 */
export function mergeRedirects(
	existing: Readonly<Record<string, string>>,
	additions: Readonly<Record<string, string>>,
): Record<string, string> {
	const combined: Record<string, string> = { ...existing, ...additions };
	const finalTarget = (start: string): string => {
		let current = start;
		const seen = new Set<string>();
		while (combined[current] !== undefined) {
			if (seen.has(current)) throw new Error(`redirect cycle detected at ${current}`);
			seen.add(current);
			current = combined[current] as string;
		}
		return current;
	};

	const flattened: Record<string, string> = {};
	for (const key of Object.keys(combined).sort(compareLex)) {
		flattened[key] = finalTarget(combined[key] as string);
	}
	return flattened;
}

/**
 * True when `slug` still points at a node present in `survivingSlugs`: either `slug` itself is
 * still a live node, or -- failing that -- it resolves through one hop of `redirects` (already
 * flattened by mergeRedirects, so one hop is always enough). An existing node always wins over
 * a redirect entry, mirroring resolveReadSlug's own rule 2 in src/genre-registry.ts ("an
 * existing node beats a stale redirect") -- see this file's header comment on why a loser can
 * briefly have both its file and a redirect after a crash mid-apply. Used by the taxonomy-era
 * protection below (TRA-138): unlike v1's literal "never a loser" rule, a protected slug here
 * may legitimately become a loser as long as it still resolves one way or the other.
 */
export function stillResolves(
	slug: string,
	redirects: Readonly<Record<string, string>>,
	survivingSlugs: ReadonlySet<string>,
): boolean {
	return survivingSlugs.has(slug) || survivingSlugs.has(redirects[slug] ?? slug);
}

/** Rewrites pending-reverses.json the same way: keys and edge.slug values alike, plus the
 * same denormalized-qid correction as rewriteNodeEdges (see RewriteTarget) when the target
 * carries a qid. */
export function rewritePendingReverses(
	pending: Readonly<Record<string, PendingReverse[]>>,
	rewriteMap: ReadonlyMap<string, RewriteTarget>,
): { result: Record<string, PendingReverse[]>; changed: boolean } {
	const result: Record<string, PendingReverse[]> = {};
	let changed = false;
	for (const [key, list] of Object.entries(pending)) {
		const keyTarget = rewriteMap.get(key);
		const canonicalKey = keyTarget ? (typeof keyTarget === "string" ? keyTarget : keyTarget.slug) : key;
		if (canonicalKey !== key) changed = true;
		const rewrittenList = list.map((pr) => {
			const target = rewriteMap.get(pr.edge.slug);
			if (!target) return pr;
			changed = true;
			const nextSlug = (typeof target === "string" ? target : target.slug) as PendingReverse["edge"]["slug"];
			const nextQid = typeof target === "string" ? undefined : target.qid;
			const edgeRecord = pr.edge as unknown as Record<string, unknown>;
			const qidChanged =
				nextQid !== undefined && typeof edgeRecord.qid === "string" && edgeRecord.qid !== nextQid;
			return { ...pr, edge: { ...pr.edge, slug: nextSlug, ...(qidChanged ? { qid: nextQid } : {}) } };
		});
		result[canonicalKey] = [...(result[canonicalKey] ?? []), ...rewrittenList];
	}
	return { result, changed };
}

// --- Disk I/O ---

export interface CacheNodeFile {
	path: string;
	slug: string;
	type: NodeType;
	node: Record<string, unknown>;
}

/** Reads node files directly (readFile + JSON.parse), never NodeCache.get() -- that would
 * strip undeclared fields via Zod. Enumerated via NodeCache.listSlugs(). */
export async function readCacheNodes(
	root: string,
): Promise<{ nodes: CacheNodeFile[]; invalid: { path: string; error: string }[] }> {
	const slugs = [...(await new NodeCache(root).listSlugs())].sort();
	const nodes: CacheNodeFile[] = [];
	const invalid: { path: string; error: string }[] = [];
	for (const slug of slugs) {
		try {
			const { type, body } = parseSlug(slug);
			const path = join(root, "nodes", type, `${body}.json`);
			const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
			if (!isRecord(parsed)) throw new Error("node file is not a JSON object");
			nodes.push({ path, slug, type, node: parsed });
		} catch (e) {
			invalid.push({ path: join(root, "nodes", slug), error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { nodes, invalid };
}

// Exported (2026-09-10, TRA-35): shared with the rename migration, which lives in this same
// directory, so the relative resolution below is correct for it too.
export function defaultDataDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
}

/** First catalog entry for a QID wins -- the catalog is sorted by slug, so this is deterministic. */
async function loadCatalogNameIndex(): Promise<Map<string, string>> {
	const raw = JSON.parse(await readFile(join(defaultDataDir(), "genre-catalog.json"), "utf8")) as unknown;
	const index = new Map<string, string>();
	const genres = isRecord(raw) && Array.isArray(raw.genres) ? raw.genres : [];
	for (const g of genres) {
		if (
			isRecord(g) &&
			typeof g.wikidata_qid === "string" &&
			typeof g.name === "string" &&
			!index.has(g.wikidata_qid)
		) {
			index.set(g.wikidata_qid, g.name);
		}
	}
	return index;
}

/**
 * Reads ONBOARDING_GENRES out of web/index.html (read-only). Throws on zero matches --
 * feeds the onboarding invariant directly, so a stale regex must fail loudly, not check
 * nothing silently.
 */
export async function loadOnboardingGenreSlugs(webIndexPath?: string): Promise<string[]> {
	const path = webIndexPath ?? join(defaultDataDir(), "..", "web", "index.html");
	const html = await readFile(path, "utf8");
	const arrayLiteral = html.match(/const ONBOARDING_GENRES = \[([\s\S]*?)\];/)?.[1] ?? "";
	const slugs = [...arrayLiteral.matchAll(/"(genre:[a-z0-9-]+)"/g)].map((m) => m[1] as string);
	if (slugs.length === 0) throw new Error(`no ONBOARDING_GENRES slugs found in ${path}`);
	return slugs;
}

// Exported (2026-09-10, TRA-35): reused verbatim by the rename migration for pending-reverses.json.
export async function readTextOrDefault(path: string, fallback: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw e;
	}
}

// --- Report formatting ---

interface GroupPlan {
	qid: string;
	winner: ElectionCandidate;
	criterion: ElectionCriterion;
	losers: ElectionCandidate[];
	rewrittenIncomingEdges: number;
}

export function formatMergeReport(
	groups: readonly GroupPlan[],
	rewritesByType: ReadonlyMap<NodeType, number>,
	redirects: { newCount: number; totalCount: number },
	onboardingSlugsChecked: number,
	dryRun: boolean,
): string {
	const totalRewritten = [...rewritesByType.values()].reduce((sum, n) => sum + n, 0);
	const lines: string[] = [`=== Genre duplicate merge${dryRun ? " (DRY RUN)" : ""} ===`];
	lines.push(`${"Groups to merge:".padEnd(24)}${groups.length}`);
	lines.push(`${"Files to delete:".padEnd(24)}${groups.reduce((sum, g) => sum + g.losers.length, 0)}`);
	lines.push(`${"Redirects (new/total):".padEnd(24)}${redirects.newCount}/${redirects.totalCount}`);
	lines.push(`${"Onboarding slugs checked:".padEnd(24)}${onboardingSlugsChecked}`);

	lines.push("", "=== Groups ===");
	for (const g of groups) {
		lines.push(`  ${g.qid}  winner=${g.winner.slug} (${g.winner.name})  criterion=${g.criterion}`);
		for (const loser of g.losers) {
			lines.push(`    loser ${loser.slug.padEnd(32)}${String(loser.usages).padStart(4)} usages`);
		}
		lines.push(`    incoming edges rewritten: ${g.rewrittenIncomingEdges}`);
	}

	lines.push("", "=== Edges rewritten by node type ===");
	if (rewritesByType.size === 0) {
		lines.push("  (none)");
	} else {
		for (const [type, count] of [...rewritesByType.entries()].sort()) {
			lines.push(`  ${type.padEnd(10)} ${count}`);
		}
	}
	lines.push(`  ${"total".padEnd(10)} ${totalRewritten}`);

	return lines.join("\n");
}

// --- Migration runner ---

export interface MigrationResult {
	report: string;
	groupsFound: number;
	deletedCount: number;
	exitCode: 0 | 1;
}

/**
 * Runs the full migration against `cacheDir`: builds the plan in memory, verifies its
 * invariants before touching disk, and -- only if clean and `apply` is set -- writes.
 * Never calls process.exit; exit-code semantics only, so it's directly testable.
 */
export async function runMigration(
	cacheDir: string,
	apply: boolean,
	options: {
		redirectsPath?: string;
		catalogNames?: ReadonlyMap<string, string>;
		onboardingSlugs?: readonly string[];
		webIndexPath?: string;
		taxonomyPath?: string;
		taxonomy?: GenreTaxonomy;
	} = {},
): Promise<MigrationResult> {
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	for (const { path, error } of invalid) {
		process.stderr.write(`warning: skipping unreadable node file ${path}: ${error}\n`);
	}

	const catalogNames = options.catalogNames ?? (await loadCatalogNameIndex());
	const duplicateGroups: readonly DuplicateGroup[] = buildDuplicateReport(nodes.map((n) => n.node)).groups;
	const header = `=== Genre duplicate merge${apply ? "" : " (DRY RUN)"} ===`;
	if (duplicateGroups.length === 0) {
		return {
			report: `${header}\nNo duplicate groups found -- nothing to merge.\n`,
			groupsFound: 0,
			deletedCount: 0,
			exitCode: 0,
		};
	}

	// Loaded up front (TRA-48): electCanonical's existing-redirect criterion needs the table
	// during election, and the final validation below (mergeRedirects + re-parse) reuses this
	// same loaded value instead of reading the file twice. A load failure here doesn't abort
	// immediately -- the plan still builds (so the report reflects it) -- but it always ends
	// in `errors` below, so the migration exits 1 without writing, same as before.
	const redirectsPath = options.redirectsPath ?? join(defaultDataDir(), "genre-redirects.json");
	const errors: string[] = [];
	let existingRedirects: ReadonlyMap<string, string> = new Map();
	try {
		existingRedirects = await loadGenreRedirects(redirectsPath);
	} catch (e) {
		errors.push(`existing redirects table failed to load: ${e instanceof Error ? e.message : String(e)}`);
	}

	// --- Genre protections (TRA-138, D6a) -----------------------------------------------------
	// v1 reads ONBOARDING_GENRES out of web/index.html by regex; it stays in force exactly as
	// before, as long as that constant exists. D3 (TRA-211) will remove the whole identifier --
	// only that ("no ONBOARDING_GENRES anywhere in the file") means "retired on purpose", and
	// is swallowed into `undefined` (protection inactive). The identifier still being present
	// but loadOnboardingGenreSlugs failing anyway (e.g. reformatted to `Object.freeze([...])`,
	// which the array-literal regex doesn't match) is a *different*, broken shape -- not this
	// planned retirement -- so it must still fail loudly, per that function's own docstring.
	// Checked by reading the file directly rather than trusting loadOnboardingGenreSlugs's error
	// message, which is identical in both cases (2026-09-17 review: a prior version conflated
	// them, silently disabling v1 whenever the regex merely failed to match).
	let onboardingSlugs: string[] | undefined;
	if (options.onboardingSlugs) {
		onboardingSlugs = [...options.onboardingSlugs];
	} else {
		const webIndexPath = options.webIndexPath ?? join(defaultDataDir(), "..", "web", "index.html");
		const html = await readTextOrDefault(webIndexPath, "");
		onboardingSlugs = /\bONBOARDING_GENRES\b/.test(html)
			? await loadOnboardingGenreSlugs(webIndexPath)
			: undefined;
	}

	// The taxonomy-era protection (A4b): every source slug of a `published: true` entry,
	// already resolved through existing redirects and QID lookup by the canonical loader.
	// Three distinct outcomes, kept separate rather than collapsed into one boolean: not shipped
	// yet (ENOENT on the path itself) is silently `undefined`; the path existing but unreadable
	// for another reason (permissions, say) and the file existing but failing to parse/validate
	// are both hard errors, with distinct messages -- corruption is never silently treated as
	// "no taxonomy". Default path is a sibling of `cacheDir`, not of the repo's own data/
	// (loadGenreTaxonomy's own cacheRootFor mirrors this): the header above documents this same
	// migration running against the *server's* cache, at a different path than the repo's --
	// this keeps the two aligned whenever cacheDir follows the usual cache/data sibling layout;
	// pass `taxonomyPath` explicitly for a cache directory that doesn't.
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

	// A taxonomy that loads but publishes nothing would otherwise silently disarm this whole
	// protection (2026-09-17 review, nit 5) -- exactly the "empty check that lets everything
	// through" criterion 3 already forbids for the "both missing" case below.
	if (taxonomySources !== undefined && taxonomySources.length === 0) {
		errors.push("genre taxonomy loaded but publishes no genres -- refusing rather than protecting nothing");
		taxonomySources = undefined;
	}

	if (onboardingSlugs === undefined && taxonomySources === undefined) {
		errors.push(
			"no genre protection available: both ONBOARDING_GENRES and the genre taxonomy are missing -- " +
				"refusing rather than merging unchecked",
		);
	} else if (taxonomyAbsent && onboardingSlugs !== undefined) {
		process.stderr.write(
			"warning: genre taxonomy not found -- proceeding with v1 (ONBOARDING_GENRES) protection alone\n",
		);
	}

	// --- Plan (in memory, nothing written yet): elect, union, then rewrite every kept node.
	const bySlug = new Map(nodes.map((f) => [f.slug, f]));
	const rewriteMap = new Map<string, string>();
	const loserSlugs = new Set<string>();
	const winnerMerged = new Map<string, Record<string, unknown>>();
	const elections: { group: DuplicateGroup; result: ElectionResult }[] = [];

	for (const group of duplicateGroups) {
		const candidates = group.members.map((m) => ({ slug: m.slug, name: m.name, usages: m.usages }));
		let result: ElectionResult;
		try {
			result = electCanonical(candidates, catalogNames.get(group.qid), existingRedirects);
		} catch (e) {
			// Defensive invariant (see electCanonical's own comment): named by QID so the
			// operator knows which group to look at, exit 1 without writing anything.
			errors.push(`group ${group.qid}: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		elections.push({ group, result });

		const winnerFile = bySlug.get(result.winner.slug);
		if (!winnerFile) throw new Error(`merge invariant: winner ${result.winner.slug} not found on disk`);
		const loserFiles = result.losers.map((l) => {
			const f = bySlug.get(l.slug);
			if (!f) throw new Error(`merge invariant: loser ${l.slug} not found on disk`);
			return f;
		});
		winnerMerged.set(
			result.winner.slug,
			mergeGenreEdges(
				winnerFile.node,
				loserFiles.map((f) => f.node),
			),
		);
		for (const loser of result.losers) {
			rewriteMap.set(loser.slug, result.winner.slug);
			loserSlugs.add(loser.slug);
		}
	}

	const writes = new Map<string, Record<string, unknown>>();
	const hitsBySlug = new Map<string, number>();
	const hitsByType = new Map<NodeType, number>();
	const resultNodes: Record<string, unknown>[] = [];
	for (const file of nodes) {
		if (loserSlugs.has(file.slug)) continue;
		const base = winnerMerged.get(file.slug) ?? file.node;
		const { node: rewritten, hits } = rewriteNodeEdges(base, file.type, rewriteMap);
		let typeHits = 0;
		for (const [slug, count] of hits) {
			hitsBySlug.set(slug, (hitsBySlug.get(slug) ?? 0) + count);
			typeHits += count;
		}
		if (typeHits > 0) hitsByType.set(file.type, (hitsByType.get(file.type) ?? 0) + typeHits);
		if (JSON.stringify(rewritten) !== JSON.stringify(file.node)) writes.set(file.path, rewritten);
		resultNodes.push(rewritten);
	}

	const groupPlans: GroupPlan[] = elections.map(({ group, result }) => ({
		qid: group.qid,
		winner: result.winner,
		criterion: result.criterion,
		losers: result.losers,
		rewrittenIncomingEdges: result.losers.reduce((sum, l) => sum + (hitsBySlug.get(l.slug) ?? 0), 0),
	}));
	const deletePaths = [...loserSlugs].map((slug) => (bySlug.get(slug) as CacheNodeFile).path);

	// --- Verify invariants in memory before writing anything -- fail loudly, never half-merged.
	const remainingGroups = buildDuplicateReport(resultNodes).groups.length;
	if (remainingGroups > 0) errors.push(`${remainingGroups} duplicate group(s) still share a QID after merge`);
	for (const node of resultNodes) {
		if (!isNodeType(node.type) || typeof node.slug !== "string") continue;
		for (const field of [...LIST_EDGES_BY_TYPE[node.type], ...SINGULAR_EDGES_BY_TYPE[node.type]]) {
			const value = node[field];
			const edges = Array.isArray(value) ? value : value ? [value] : [];
			for (const edge of edges) {
				if (isRecord(edge) && typeof edge.slug === "string" && loserSlugs.has(edge.slug)) {
					errors.push(`dangling edge: ${node.slug}.${field} still points to deleted slug ${edge.slug}`);
				}
			}
		}
	}
	if (deletePaths.length !== loserSlugs.size) {
		errors.push(`delete count ${deletePaths.length} does not match loser count ${loserSlugs.size}`);
	}
	for (const slug of onboardingSlugs ?? []) {
		if (loserSlugs.has(slug)) errors.push(`onboarding genre slug ${slug} would be deleted by this merge`);
	}

	// A corrupted redirects table or a truncated pending-reverses.json must fail here,
	// before any write -- not after losers are already gone from disk. `existingRedirects`
	// is the same value loaded up front, above, for electCanonical.
	let mergedRedirects: Record<string, string> = {};
	try {
		mergedRedirects = mergeRedirects(Object.fromEntries(existingRedirects), Object.fromEntries(rewriteMap));
		parseGenreRedirects({ redirects: mergedRedirects }); // re-validates the flattening invariant
	} catch (e) {
		errors.push(`redirects table would fail validation: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Post-operation control (TRA-138): every published taxonomy source, and every slug the
	// redirects table already protected before this run, must still resolve afterwards -- via
	// mergedRedirects, not literal survival, so a safe merge-with-redirect is accepted while a
	// resolution actually broken by drift or corruption is refused. Checked only once a
	// taxonomy is actually loaded; v1's stricter, literal rule above is unaffected by it.
	if (taxonomySources !== undefined) {
		const survivingSlugs = new Set(resultNodes.flatMap((n) => (typeof n.slug === "string" ? [n.slug] : [])));
		const protectedSlugs = new Set([...taxonomySources, ...existingRedirects.keys()]);
		for (const slug of protectedSlugs) {
			if (!stillResolves(slug, mergedRedirects, survivingSlugs)) {
				errors.push(`genre taxonomy protection: ${slug} no longer resolves after this merge`);
			}
		}
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

	const redirectsWritten = { newCount: rewriteMap.size, totalCount: Object.keys(mergedRedirects).length };
	const report = formatMergeReport(
		groupPlans,
		hitsByType,
		redirectsWritten,
		(onboardingSlugs ?? []).length,
		!apply,
	);

	if (errors.length > 0) {
		for (const err of errors) process.stderr.write(`error: ${err}\n`);
		return { report, groupsFound: groupPlans.length, deletedCount: 0, exitCode: 1 };
	}

	if (!apply) return { report, groupsFound: groupPlans.length, deletedCount: 0, exitCode: 0 };

	// --- Apply, crash-safe order: rewrite nodes, pending-reverses, redirects, THEN delete
	// losers last -- a loser briefly having both its file and a redirect is harmless
	// (genre-registry's rule 2, an existing node, beats rule 3, follow a redirect); deleting
	// first could leave a loser with neither if a later step then failed.
	for (const [path, node] of writes) await atomicWriteJson(path, node);

	const { result: nextPending, changed: pendingChanged } = rewritePendingReverses(pendingParsed, rewriteMap);
	if (pendingChanged) await atomicWriteJson(pendingPath, nextPending);

	await mkdir(dirname(redirectsPath), { recursive: true });
	await atomicWriteJson(redirectsPath, {
		source: "genre duplicate merge",
		generated_at: new Date().toISOString(),
		redirects: mergedRedirects,
	});

	for (const path of deletePaths) await rm(path);

	return { report, groupsFound: groupPlans.length, deletedCount: deletePaths.length, exitCode: 0 };
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	redirectsPath?: string;
}

/**
 * Parses `<cache-dir> [--apply] [--redirects <path>]`. Null (CLI exits 2) when: cache-dir
 * is missing or is itself a flag; --redirects is repeated, has no value, or one that's
 * actually another flag (--redirects --apply with the path forgotten); or any argv token
 * beyond cache-dir isn't consumed by a recognized flag (an unrecognized flag like
 * --dry-run/--aply, or a stray extra positional such as a redirects path typed without its
 * --redirects flag) -- an ambiguous argument never falls through to a guess.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;

	const redirectsIndex = argv.indexOf("--redirects");
	if (redirectsIndex >= 0 && argv.lastIndexOf("--redirects") !== redirectsIndex) return null;
	const redirectsPath = redirectsIndex >= 0 ? argv[redirectsIndex + 1] : undefined;
	if (redirectsIndex >= 0 && (!redirectsPath || redirectsPath.startsWith("-"))) return null;

	const consumed = new Set([0, redirectsIndex, redirectsIndex + 1, argv.indexOf("--apply")]);
	if (argv.some((_, i) => i > 0 && !consumed.has(i))) return null;

	return { cacheDir, apply: argv.includes("--apply"), ...(redirectsPath ? { redirectsPath } : {}) };
}

/** True when `dir` has a nodes/ subdirectory, i.e. looks like a NodeCache root. Guards main
 * against a typo'd or nonexistent cache-dir, which would otherwise report "0 groups" --
 * indistinguishable from a genuinely idempotent second run on a real cache. */
export async function looksLikeCacheDir(dir: string): Promise<boolean> {
	try {
		return (await stat(join(dir, "nodes"))).isDirectory();
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-09-04-merge-genre-duplicates.ts <cache-dir> [--apply] [--redirects <path>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runMigration(
		args.cacheDir,
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
