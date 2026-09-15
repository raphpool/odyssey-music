/**
 * Prepares a union of two genre caches (repo + server) in a new temp dir, without touching
 * either source -- B6a (TRA-66). A slug on only one side is copied byte-identical. The SAME
 * slug on both sides is compared by decideSameIdentity. Two DIFFERENT slugs naming the same
 * real genre (genre:country-music on the repo, genre:country on the server) are never merged
 * here -- both are copied as-is ("never assume the redirect was followed in the repo"); the
 * existing duplicate-merge migration then runs for real against a throwaway copy of the union,
 * using a copy of the redirects table so the source table is never written. Both raw variants
 * of a compared pair are archived under <output>/archive/{repo,server}/ regardless of outcome.
 *
 * Out of scope: pending-reverses.json is not unioned (left for B6b).
 *
 * Usage: tsx scripts/prepare-genre-cache-union.ts <repo-cache-dir> <server-cache-dir>
 */
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeCache } from "../src/cache.js";
import { loadGenreRedirects, resolveReadSlug } from "../src/genre-registry.js";
import { LIST_EDGES_BY_TYPE, SINGULAR_EDGES_BY_TYPE } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";
import { isRecord, readCacheNodes, runMigration } from "./migrations/2026-09-04-merge-genre-duplicates.js";

type NodeFile = Awaited<ReturnType<typeof readCacheNodes>>["nodes"][number];

// "kept"/"conflict" only ever compare the SAME raw slug on both sides (see buildCacheUnion),
// so one `slug` field is all either variant needs -- there is no separate repo/server spelling
// to record.
export type UnionEntry =
	| { decision: "copied"; from: "repo" | "server"; slug: Slug }
	| { decision: "kept"; from: "repo" | "server"; slug: Slug; tie: boolean; qidOnlyOn?: "repo" | "server" }
	| { decision: "conflict"; slug: Slug; reason: "qid" | "timestamp" };

export interface DanglingReference {
	slug: Slug;
	field: string;
	targetSlug: Slug;
}

export interface UnionManifest {
	generatedAt: string;
	repoCacheDir: string;
	serverCacheDir: string;
	entries: UnionEntry[];
	migrationPreview: { groupsFound: number; exitCode: 0 | 1 };
	migrationApplied: { groupsFound: number; deletedCount: number; exitCode: 0 | 1 };
	danglingReferences: DanglingReference[];
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

	// Surfaces a qid present on only one side -- kept regardless (not a conflict), but worth
	// flagging: the losing side's qid is silently dropped by the winner otherwise.
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

/** Edges whose target resolves to neither a live union node nor a redirect (resolveReadSlug's
 * own rule: a live node always wins, otherwise follow the redirects table). readCacheNodes
 * reads raw, un-Zod-validated JSON, so a ref's slug can be malformed (no colon, unknown type) --
 * that's reported as dangling too, rather than left to throw out of parseSlug/NodeCache. */
async function findDanglingReferences(
	outputDir: string,
	redirectsPath: string,
): Promise<DanglingReference[]> {
	const cache = new NodeCache(outputDir);
	const redirects = await loadGenreRedirects(redirectsPath);
	const { nodes } = await readCacheNodes(outputDir);
	const dangling: DanglingReference[] = [];
	for (const file of nodes) {
		for (const field of [...LIST_EDGES_BY_TYPE[file.type], ...SINGULAR_EDGES_BY_TYPE[file.type]]) {
			const value = file.node[field];
			const refs = Array.isArray(value) ? value : value ? [value] : [];
			for (const ref of refs) {
				if (!isRecord(ref) || typeof ref.slug !== "string") continue;
				try {
					const resolved = await resolveReadSlug(ref.slug as Slug, redirects, cache);
					if (await cache.has(resolved)) continue;
				} catch {
					// Malformed slug -- falls through to "dangling" below, for a different reason.
				}
				dangling.push({ slug: file.slug as Slug, field, targetSlug: ref.slug as Slug });
			}
		}
	}
	return dangling;
}

export async function buildCacheUnion(
	repoCacheDir: string,
	serverCacheDir: string,
	options: { redirectsPath?: string; outputRoot?: string; onboardingSlugs?: readonly string[] } = {},
): Promise<{ outputDir: string; manifest: UnionManifest }> {
	const { nodes: repoNodes, invalid: repoInvalid } = await readCacheNodes(repoCacheDir);
	const { nodes: serverNodes, invalid: serverInvalid } = await readCacheNodes(serverCacheDir);
	for (const { path, error } of [...repoInvalid, ...serverInvalid]) {
		process.stderr.write(`warning: skipping unreadable node file ${path}: ${error}\n`);
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

	// Seed the union's OWN redirects copy from the source table (read-only), then run the
	// existing duplicate-merge migration for real against that copy -- this is what actually
	// unifies a same-QID pair like genre:country-music/genre:country left as two slugs above.
	// The source table (options.redirectsPath, or its real committed default) is never written.
	const sourceRedirects = await loadGenreRedirects(options.redirectsPath);
	const redirectsPath = join(outputDir, "genre-redirects.json");
	await writeFile(
		redirectsPath,
		`${JSON.stringify({ redirects: Object.fromEntries(sourceRedirects) }, null, 2)}\n`,
		"utf8",
	);
	const migrationOptions = {
		redirectsPath,
		...(options.onboardingSlugs ? { onboardingSlugs: options.onboardingSlugs } : {}),
	};
	const migrationPreview = await runMigration(outputDir, false, migrationOptions);
	const migrationApplied = await runMigration(outputDir, true, migrationOptions);
	const danglingReferences = await findDanglingReferences(outputDir, redirectsPath);

	const manifest: UnionManifest = {
		generatedAt: new Date().toISOString(),
		repoCacheDir,
		serverCacheDir,
		entries,
		migrationPreview: { groupsFound: migrationPreview.groupsFound, exitCode: migrationPreview.exitCode },
		migrationApplied: {
			groupsFound: migrationApplied.groupsFound,
			deletedCount: migrationApplied.deletedCount,
			exitCode: migrationApplied.exitCode,
		},
		danglingReferences,
	};
	await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { outputDir, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [repoCacheDir, serverCacheDir] = process.argv.slice(2);
	if (!repoCacheDir || !serverCacheDir) throw new Error("usage: <repo-cache-dir> <server-cache-dir>");
	const { outputDir, manifest } = await buildCacheUnion(repoCacheDir, serverCacheDir);
	console.log(`Union written to ${outputDir} (${manifest.entries.length} entries)`);
	const problems =
		manifest.entries.filter((e) => e.decision === "conflict").length +
		manifest.danglingReferences.length +
		manifest.migrationApplied.exitCode;
	if (problems > 0) process.exitCode = 1;
}
