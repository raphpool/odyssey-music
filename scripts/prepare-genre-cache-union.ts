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
 * This script does NOT validate references at all -- neither before nor after the (unapplied)
 * merge. A conflict refusal already leaves the output an incomplete cache for that slug (see
 * the non-zero exit code), but nothing here checks whether some OTHER node's edge now points
 * at a slug missing from the union. Reference validation, in delta against the two sources, is
 * TRA-234 (B6b), along with actually applying the migration and unioning pending-reverses.json.
 *
 * Usage: tsx scripts/prepare-genre-cache-union.ts <repo-cache-dir> <server-cache-dir>
 */
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { loadGenreRedirects } from "../src/genre-registry.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";
import { readCacheNodes, runMigration } from "./migrations/2026-09-04-merge-genre-duplicates.js";

type NodeFile = Awaited<ReturnType<typeof readCacheNodes>>["nodes"][number];

// "kept"/"conflict" only ever compare the SAME raw slug on both sides (see buildCacheUnion), so
// one `slug` field is all either variant needs.
export type UnionEntry =
	| { decision: "copied"; from: "repo" | "server"; slug: Slug }
	| { decision: "kept"; from: "repo" | "server"; slug: Slug; tie: boolean; qidOnlyOn?: "repo" | "server" }
	| { decision: "conflict"; slug: Slug; reason: "qid" | "timestamp" };

export interface UnionManifest {
	generatedAt: string;
	repoCacheDir: string;
	serverCacheDir: string;
	entries: UnionEntry[];
	skipped: { source: "repo" | "server"; path: string; error: string }[];
	migrationPreview: { groupsFound: number; exitCode: 0 | 1; report: string };
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
	return conflicts + droppedQid + manifest.skipped.length + manifest.migrationPreview.exitCode;
}

export async function buildCacheUnion(
	repoCacheDir: string,
	serverCacheDir: string,
	options: { redirectsPath?: string; outputRoot?: string; onboardingSlugs?: readonly string[] } = {},
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
	const preview = await runMigration(outputDir, false, {
		redirectsPath,
		...(options.onboardingSlugs ? { onboardingSlugs: options.onboardingSlugs } : {}),
	});

	const manifest: UnionManifest = {
		generatedAt: new Date().toISOString(),
		repoCacheDir,
		serverCacheDir,
		entries,
		skipped,
		migrationPreview: {
			groupsFound: preview.groupsFound,
			exitCode: preview.exitCode,
			report: preview.report,
		},
	};
	await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { outputDir, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [repoCacheDir, serverCacheDir] = process.argv.slice(2);
	if (!repoCacheDir || !serverCacheDir) throw new Error("usage: <repo-cache-dir> <server-cache-dir>");
	const { outputDir, manifest } = await buildCacheUnion(repoCacheDir, serverCacheDir);
	console.log(`Union written to ${outputDir} (${manifest.entries.length} entries)`);
	if (countUnionProblems(manifest) > 0) process.exitCode = 1;
}
