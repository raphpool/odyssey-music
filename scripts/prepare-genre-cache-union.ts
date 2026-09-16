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
import { copyFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeCache } from "../src/cache.js";
import { loadGenreRedirects } from "../src/genre-registry.js";
import { LIST_EDGES_BY_TYPE, SINGULAR_EDGES_BY_TYPE } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";
import { isRecord, readCacheNodes, runMigration } from "./migrations/2026-09-04-merge-genre-duplicates.js";

type NodeFile = Awaited<ReturnType<typeof readCacheNodes>>["nodes"][number];

// "kept"/"conflict" only ever compare the SAME raw slug on both sides (see buildCacheUnion), so
// one `slug` field is all either variant needs.
export type UnionEntry =
	| { decision: "copied"; from: "repo" | "server"; slug: Slug }
	| { decision: "kept"; from: "repo" | "server"; slug: Slug; tie: boolean; qidOnlyOn?: "repo" | "server" }
	| { decision: "conflict"; slug: Slug; reason: "qid" | "timestamp" };

// A reference that resolved in a source before the union but no longer resolves after the
// (applied) migration -- see `slugResolves` and the reference-delta block in `buildCacheUnion`.
export interface ReferenceRegression {
	slug: Slug;
	resolvedIn: ("repo" | "server")[];
}

export interface UnionManifest {
	generatedAt: string;
	repoCacheDir: string;
	serverCacheDir: string;
	entries: UnionEntry[];
	skipped: { source: "repo" | "server"; path: string; error: string }[];
	migrationPreview: { groupsFound: number; exitCode: 0 | 1; report: string };
	// Present only with --apply-merge: the FINAL state of the artifact after the migration
	// actually ran (winner/criterion/losers/rewritten-edge counts live only in `report`'s free
	// text -- MigrationResult has no structured per-group field, and the migration script is out
	// of scope to change).
	migrationApply?: {
		groupsFound: number;
		deletedCount: number;
		exitCode: 0 | 1;
		report: string;
		archivedNodeCount: number;
	};
	referenceRegressions?: ReferenceRegression[];
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

async function copyNode(baseDir: string, file: NodeFile): Promise<void> {
	const { body } = parseSlug(file.slug);
	const dest = join(baseDir, file.type, `${body}.json`);
	await mkdir(dirname(dest), { recursive: true });
	await copyFile(file.path, dest);
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

export function countUnionProblems(manifest: UnionManifest): number {
	const conflicts = manifest.entries.filter((e) => e.decision === "conflict").length;
	// A qid dropped from the union: the side carrying it did NOT win the comparison.
	const droppedQid = manifest.entries.filter(
		(e) => e.decision === "kept" && e.qidOnlyOn !== undefined && e.qidOnlyOn !== e.from,
	).length;
	const regressions = manifest.referenceRegressions?.length ?? 0;
	return conflicts + droppedQid + manifest.skipped.length + manifest.migrationPreview.exitCode + regressions;
}

export async function buildCacheUnion(
	repoCacheDir: string,
	serverCacheDir: string,
	options: {
		redirectsPath?: string;
		outputRoot?: string;
		onboardingSlugs?: readonly string[];
		applyMerge?: boolean;
	} = {},
): Promise<{ outputDir: string; manifest: UnionManifest }> {
	const { nodes: repoNodes, invalid: repoInvalid } = await readCacheNodes(repoCacheDir);
	const { nodes: serverNodes, invalid: serverInvalid } = await readCacheNodes(serverCacheDir);
	const skipped: UnionManifest["skipped"] = [
		...repoInvalid.map((e) => skippedEntry("repo", repoCacheDir, e)),
		...serverInvalid.map((e) => skippedEntry("server", serverCacheDir, e)),
	];
	for (const { source, path, error } of skipped) {
		process.stderr.write(`warning: skipping unreadable ${source} node file ${path}: ${error}\n`);
	}
	const repoBySlug = new Map(repoNodes.map((f) => [f.slug, f]));
	const serverBySlug = new Map(serverNodes.map((f) => [f.slug, f]));
	const allSlugs = new Set([...repoBySlug.keys(), ...serverBySlug.keys()]);

	const outputDir = await mkdtemp(join(options.outputRoot ?? tmpdir(), "odyssey-genre-union-"));
	const nodesDir = join(outputDir, "nodes");
	const archiveDir = join(outputDir, "archive");
	const entries: UnionEntry[] = [];

	for (const slug of allSlugs) {
		const repoFile = repoBySlug.get(slug);
		const serverFile = serverBySlug.get(slug);
		if (repoFile && serverFile) {
			await copyNode(join(archiveDir, "repo"), repoFile);
			await copyNode(join(archiveDir, "server"), serverFile);
			const decision = decideSameIdentity(repoFile.node, serverFile.node);
			if ("reason" in decision) {
				entries.push({ decision: "conflict", slug: slug as Slug, reason: decision.reason });
				continue;
			}
			const winner = decision.from === "repo" ? repoFile : serverFile;
			await copyNode(nodesDir, winner);
			entries.push({
				decision: "kept",
				from: decision.from,
				slug: slug as Slug,
				tie: decision.tie,
				...(decision.qidOnlyOn ? { qidOnlyOn: decision.qidOnlyOn } : {}),
			});
		} else {
			const only = (repoFile ?? serverFile) as NodeFile;
			entries.push({ decision: "copied", from: repoFile ? "repo" : "server", slug: only.slug as Slug });
			await copyNode(nodesDir, only);
		}
	}

	// Seed the union's OWN redirects copy from the source table (read-only) so the migration's
	// preview below sees the same existing-redirect knowledge a real merge would -- the source
	// table (options.redirectsPath, or its real committed default) is never written.
	const sourceRedirects = await loadGenreRedirects(options.redirectsPath);
	const redirectsPath = join(outputDir, "genre-redirects.json");
	await writeFile(
		redirectsPath,
		`${JSON.stringify({ redirects: Object.fromEntries(sourceRedirects) }, null, 2)}\n`,
		"utf8",
	);
	// Only ONE runMigration call ever happens: preview and apply both re-read and recompute the
	// full duplicate-group plan from scratch (readCacheNodes + election + edge rewrite +
	// invariants), so calling both on the real cache would double that I/O/CPU cost for nothing.
	// With --apply-merge, nodes/ must be archived BEFORE this call, since apply may delete losers.
	let archivedNodeCount = 0;
	if (options.applyMerge) {
		// Archive the WHOLE union nodes/ tree -- at least covers what the migration is about to
		// delete, without needing the migration's own (unexported) per-group loser list. This is
		// exactly the B6a review gap: a live node deleted by the applied migration must never be
		// missing from both nodes/ and archive/ at once.
		await mkdir(nodesDir, { recursive: true });
		await cp(nodesDir, join(archiveDir, "pre-migration"), { recursive: true });
		archivedNodeCount = entries.filter((e) => e.decision !== "conflict").length;
	}
	const migration = await runMigration(outputDir, options.applyMerge ?? false, {
		redirectsPath,
		...(options.onboardingSlugs ? { onboardingSlugs: options.onboardingSlugs } : {}),
	});

	let migrationApply: UnionManifest["migrationApply"];
	let referenceRegressions: UnionManifest["referenceRegressions"];
	if (options.applyMerge) {
		migrationApply = {
			groupsFound: migration.groupsFound,
			deletedCount: migration.deletedCount,
			exitCode: migration.exitCode,
			report: migration.report,
			archivedNodeCount,
		};

		// Delta validation: never absolute (see file header). "Resolvable in a source" uses that
		// source's OWN live nodes plus the pre-migration redirect table; "resolvable in the union"
		// uses the union's live nodes and its (migration-rewritten) redirects after apply.
		const repoLiveSlugs = new Set(repoNodes.map((f) => f.slug as Slug));
		const serverLiveSlugs = new Set(serverNodes.map((f) => f.slug as Slug));
		const unionLiveSlugs = new Set(await new NodeCache(outputDir).listSlugs());
		const unionRedirects = await loadGenreRedirects(redirectsPath);
		const referenced = collectReferencedSlugs([...repoNodes, ...serverNodes]);

		referenceRegressions = [...referenced].flatMap((slug) => {
			const resolvedIn: ("repo" | "server")[] = [
				...(slugResolves(slug, repoLiveSlugs, sourceRedirects) ? (["repo"] as const) : []),
				...(slugResolves(slug, serverLiveSlugs, sourceRedirects) ? (["server"] as const) : []),
			];
			if (resolvedIn.length === 0 || slugResolves(slug, unionLiveSlugs, unionRedirects)) return [];
			return [{ slug, resolvedIn }];
		});
	}

	const manifest: UnionManifest = {
		generatedAt: new Date().toISOString(),
		repoCacheDir,
		serverCacheDir,
		entries,
		skipped,
		// With --apply-merge this mirrors the SAME applied run as migrationApply below (no separate
		// dry run) -- kept for the non-apply case, where it's the only migration-related field.
		migrationPreview: {
			groupsFound: migration.groupsFound,
			exitCode: migration.exitCode,
			report: migration.report,
		},
		...(migrationApply ? { migrationApply } : {}),
		...(referenceRegressions ? { referenceRegressions } : {}),
	};
	await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { outputDir, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	// An unrecognized flag must never fall through to a silent preview-mode guess -- see the
	// sibling migration script's own parseCliArgs for the same discipline.
	const unknownFlag = args.find((a) => a.startsWith("--") && a !== "--apply-merge");
	if (unknownFlag) throw new Error(`unknown argument: ${unknownFlag}`);
	const applyMerge = args.includes("--apply-merge");
	const [repoCacheDir, serverCacheDir] = args.filter((a) => !a.startsWith("--"));
	if (!repoCacheDir || !serverCacheDir) {
		throw new Error("usage: <repo-cache-dir> <server-cache-dir> [--apply-merge]");
	}
	const { outputDir, manifest } = await buildCacheUnion(repoCacheDir, serverCacheDir, { applyMerge });
	console.log(`Union written to ${outputDir} (${manifest.entries.length} entries)`);
	if (countUnionProblems(manifest) > 0) process.exitCode = 1;
}
