/**
 * Proof that a `reenrich-thin-nodes` run changed the text and the citations of the nodes, and nothing else
 * (TRA-487). It compares two cache directories (typically `git archive <base> cache | tar -x` against the
 * working tree) and fails on any of:
 *   - a node file added or removed, or a changed file outside the two types of the ticket (artist, label);
 *   - a changed node that was not thin before (>= 2 citations) or is still thin after (< 2);
 *   - a key outside the text fields (+ `materialized_at`) that differs, appears or disappears: edges, `mbid`,
 *     `image_url`, `_metrics`, `name`, `slug`... all strictly deep-equal;
 *   - `materialized_at` not moving forward;
 *   - a node that no longer validates (`nodePayloadSchema`), which also checks the citation and image hosts.
 * Any other file of the cache (pending-reverses.json...) must be byte-identical.
 *
 * Usage: tsx scripts/verify-reenrich-thin-nodes.ts <before-cache-dir> <after-cache-dir> [--json out/verify.json]
 * Exit 0 = proven, 1 = a violation (listed), 2 = bad arguments.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson } from "../src/cache.js";
import { nodePayloadSchema } from "../src/schemas.js";
import { citationCount, isReenrichType, MIN_CITATIONS, mergedFieldsOf } from "./reenrich-thin-nodes.js";

export interface VerifyReport {
	/** Node files whose content differs. */
	changed: string[];
	/** Node files, and other cache files, identical in both directories. */
	unchanged: number;
	violations: string[];
}

async function listFiles(root: string, dir = root): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(root, full)));
		else out.push(relative(root, full));
	}
	return out.sort();
}

type Obj = Record<string, unknown>;

function checkNode(path: string, before: Obj, after: Obj): string[] {
	const out: string[] = [];
	const type = String(before.type);
	if (!isReenrichType(type)) return [`${path}: changed but its type is ${type}, out of scope`];
	if (citationCount(before) >= MIN_CITATIONS)
		out.push(`${path}: was not thin (${citationCount(before)} citations)`);
	if (citationCount(after) < MIN_CITATIONS) out.push(`${path}: still thin after (${citationCount(after)})`);
	const allowed = new Set([...mergedFieldsOf(type), "materialized_at"]);
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (!allowed.has(key) && !isDeepStrictEqual(before[key], after[key]))
			out.push(`${path}: "${key}" changed`);
	}
	if (!(String(after.materialized_at) > String(before.materialized_at))) {
		out.push(`${path}: materialized_at did not move forward`);
	}
	const parsed = nodePayloadSchema.safeParse(after);
	if (!parsed.success) out.push(`${path}: no longer validates (${parsed.error.issues[0]?.message ?? "?"})`);
	return out;
}

export async function verifyReenrich(beforeDir: string, afterDir: string): Promise<VerifyReport> {
	const [beforeFiles, afterFiles] = await Promise.all([listFiles(beforeDir), listFiles(afterDir)]);
	const report: VerifyReport = { changed: [], unchanged: 0, violations: [] };
	const beforeSet = new Set(beforeFiles);
	const afterSet = new Set(afterFiles);
	for (const f of beforeFiles) if (!afterSet.has(f)) report.violations.push(`${f}: removed`);
	for (const f of afterFiles) if (!beforeSet.has(f)) report.violations.push(`${f}: added`);
	for (const f of beforeFiles.filter((p) => afterSet.has(p))) {
		const [a, b] = await Promise.all([
			readFile(join(beforeDir, f), "utf8"),
			readFile(join(afterDir, f), "utf8"),
		]);
		if (a === b) {
			report.unchanged++;
			continue;
		}
		if (!f.startsWith("nodes/") || !f.endsWith(".json")) {
			report.violations.push(`${f}: changed, and it is not a node file`);
			continue;
		}
		report.changed.push(f);
		report.violations.push(...checkNode(f, JSON.parse(a) as Obj, JSON.parse(b) as Obj));
	}
	return report;
}

async function main(): Promise<void> {
	const [beforeDir, afterDir, flag, jsonPath] = process.argv.slice(2);
	const isDir = async (d: string | undefined): Promise<boolean> =>
		d !== undefined && (await stat(d).catch(() => null))?.isDirectory() === true;
	if (!(await isDir(beforeDir)) || !(await isDir(afterDir)) || (flag !== undefined && flag !== "--json")) {
		process.stderr.write(
			"usage: verify-reenrich-thin-nodes.ts <before-cache-dir> <after-cache-dir> [--json path]\n",
		);
		process.exit(2);
	}
	const report = await verifyReenrich(beforeDir as string, afterDir as string);
	if (jsonPath) await atomicWriteJson(jsonPath, report);
	process.stdout.write(
		`[verify] changed=${report.changed.length} unchanged=${report.unchanged} violations=${report.violations.length}\n`,
	);
	for (const v of report.violations) process.stdout.write(`  ${v}\n`);
	process.exit(report.violations.length > 0 ? 1 : 0);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
