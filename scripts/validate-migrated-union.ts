#!/usr/bin/env tsx
/**
 * Final-state validation of a cache union after migrations ran on it (TRA-464, deep review N2),
 * called by deploy/sync-genre-cache.sh. The union's own validation ran BEFORE any migration, so a
 * migration's output (or one migration undoing another) is otherwise only checked by the manifest
 * it declares.
 *
 *   validate-migrated-union.ts snapshot <union-dir> <out.json>
 *     Records a hash of every nodes/<type>/<body>.json file, taken before the first migration.
 *   validate-migrated-union.ts check <union-dir> <snapshot.json> <targets.txt>
 *     - every node file that is new or different from the snapshot passes nodePayloadSchema and
 *       carries the slug its path implies (untouched nodes are not re-judged: the union copies them
 *       raw, and blocking a migration run on a pre-existing problem would be a different change);
 *     - <union>/pending-reverses.json (TRA-499: shipped as-is after the migrations rewrote it) is
 *       present, a regular file (rsync would ship a symlink as a symlink) and parses as a
 *       pending-reverses map;
 *     - every slug in targets.txt (one per line: rename and redirect targets) has a node file in
 *       the union -- the same "dangling target" rule as prepare-genre-cache-union.ts.
 *     Exit 1 with one problem per line on stderr, 0 and nothing otherwise.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodePayloadSchema } from "../src/schemas.js";
import { parsePendingReverses } from "./pending-reverses-union.js";

type Snapshot = Record<string, string>;

async function listNodeFiles(unionDir: string): Promise<string[]> {
	const out: string[] = [];
	const nodesDir = join(unionDir, "nodes");
	for (const type of await readdir(nodesDir)) {
		for (const file of await readdir(join(nodesDir, type))) {
			if (file.endsWith(".json")) out.push(`nodes/${type}/${file}`);
		}
	}
	return out.sort();
}

async function hashOf(unionDir: string, rel: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(join(unionDir, rel)))
		.digest("hex");
}

async function snapshot(unionDir: string, outPath: string): Promise<void> {
	const hashes: Snapshot = {};
	for (const rel of await listNodeFiles(unionDir)) hashes[rel] = await hashOf(unionDir, rel);
	await writeFile(outPath, JSON.stringify(hashes));
}

async function checkPendingReverses(unionDir: string): Promise<string[]> {
	const rel = "pending-reverses.json";
	let isRegularFile: boolean;
	try {
		isRegularFile = (await lstat(join(unionDir, rel))).isFile();
	} catch {
		return [`${rel}: missing from the migrated union (the channel always writes it; a migration removed it)`];
	}
	if (!isRegularFile) return [`${rel}: not a regular file (a symlink or directory would be shipped as such)`];
	const parsed = parsePendingReverses(await readFile(join(unionDir, rel), "utf8"));
	return parsed.ok ? [] : [`${rel}: ${parsed.error}`];
}

async function check(unionDir: string, snapshotPath: string, targetsPath: string): Promise<string[]> {
	const before = JSON.parse(await readFile(snapshotPath, "utf8")) as Snapshot;
	const problems: string[] = await checkPendingReverses(unionDir);
	const present = new Set<string>();
	for (const rel of await listNodeFiles(unionDir)) {
		present.add(rel);
		if ((await hashOf(unionDir, rel)) === before[rel]) continue;
		const match = /^nodes\/([^/]+)\/(.+)\.json$/.exec(rel);
		try {
			const parsed = nodePayloadSchema.safeParse(JSON.parse(await readFile(join(unionDir, rel), "utf8")));
			if (!parsed.success) {
				const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
				problems.push(`${rel}: fails the node schema (${issues.join("; ")})`);
				continue;
			}
			const expected = `${match?.[1]}:${match?.[2]}`;
			if (parsed.data.slug !== expected) {
				problems.push(`${rel}: node slug "${parsed.data.slug}" does not match its path (${expected})`);
			}
		} catch (e) {
			problems.push(`${rel}: not readable JSON (${e instanceof Error ? e.message : String(e)})`);
		}
	}
	const targets = (await readFile(targetsPath, "utf8")).split("\n").filter((l) => l !== "");
	for (const slug of new Set(targets)) {
		const i = slug.indexOf(":");
		if (!present.has(`nodes/${slug.slice(0, i)}/${slug.slice(i + 1)}.json`)) {
			problems.push(`${slug}: redirect/rename target has no node in the migrated union (dangling)`);
		}
	}
	return problems;
}

async function main(): Promise<void> {
	const [mode, unionDir, a, b] = process.argv.slice(2);
	if (mode === "snapshot" && unionDir && a) {
		await snapshot(unionDir, a);
		return;
	}
	if (mode === "check" && unionDir && a && b) {
		const problems = await check(unionDir, a, b);
		if (problems.length > 0) {
			process.stderr.write(`${problems.join("\n")}\n`);
			process.exit(1);
		}
		return;
	}
	process.stderr.write("usage: validate-migrated-union.ts snapshot|check <union-dir> <file> [<targets>]\n");
	process.exit(2);
}

await main();
