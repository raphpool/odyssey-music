/**
 * Proof for 2026-10-24-settle-homonym-leftovers (TRA-610, PR 2): that the migration changes nothing outside its
 * closed list. Throwaway in spirit, kept next to the PR so the reviewer can replay it.
 *
 *   tsx scripts/proofs/2026-10-24-settle-homonym-leftovers.proof.ts [<prod data.json>]
 *
 * 1. The repo cache: a copy is migrated (--apply) and every node file is compared byte for byte. Only
 *    cache/nodes/label/harvest-records.json may change; the redirect table must not.
 * 2. The union is mostly prod. The export `https://dropcliffs.com/api/odyssey/data.json` (one GET, read-only) is
 *    projected back into node files (the export keeps the prose, the facts, the edges and the images, not the
 *    work mbids) and the same is done: the changed, removed and created files must all be in the expected set
 *    (the works of the closed list, their wrong and right neighbours, the labels and artists that listed them).
 *    Prints the before / after of each work.
 * Exit 1 on the first file outside the expected set.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { LIST_EDGES_BY_TYPE } from "../../src/node-spec.js";
import { runFix } from "../migrations/2026-10-20-fix-homonym-work-identity.js";
import {
	CANONICAL_TARGETS,
	FORCED,
	MIGRATION_NAME,
} from "../migrations/2026-10-24-settle-homonym-leftovers.js";

type Obj = Record<string, unknown>;

async function files(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const walk = async (d: string): Promise<void> => {
		for (const entry of await readdir(d, { withFileTypes: true })) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) await walk(path);
			else out.set(relative(dir, path), await readFile(path, "utf8"));
		}
	};
	await walk(dir);
	return out;
}

function diff(before: Map<string, string>, after: Map<string, string>) {
	const changed: string[] = [];
	const removed: string[] = [];
	const created: string[] = [];
	for (const [path, text] of before) {
		const next = after.get(path);
		if (next === undefined) removed.push(path);
		else if (next !== text) changed.push(path);
	}
	for (const path of after.keys()) if (!before.has(path)) created.push(path);
	return { changed, removed, created };
}

const migrate = (cache: string, dataDir: string, manifestPath: string) =>
	runFix({
		cacheDir: cache,
		apply: true,
		manifestPath,
		dataDir,
		forced: FORCED,
		canonicalTargets: CANONICAL_TARGETS,
		onlyForced: true,
		migrationName: MIGRATION_NAME,
	});

function fail(message: string): never {
	console.error(`PROOF FAILED: ${message}`);
	process.exit(1);
}

// --- 1. The repo cache ---
const scratch = await mkdtemp(join(tmpdir(), "settle-proof-"));
try {
	const repo = join(scratch, "repo");
	await cp("cache", join(repo, "cache"), { recursive: true });
	await cp("data", join(repo, "data"), { recursive: true });
	const before = await files(join(repo, "cache"));
	const tableBefore = await readFile(join(repo, "data", "slug-redirects.json"), "utf8");
	const repoRun = await migrate(join(repo, "cache"), join(repo, "data"), join(scratch, "repo-manifest.json"));
	const repoDiff = diff(before, await files(join(repo, "cache")));
	console.log(`repo cache: ${before.size} files, exit ${repoRun.exitCode}, diff`, repoDiff);
	// Before the `chore(cache)` commit the run rewrites harvest-records.json; after it, it has nothing left to do.
	const allowed = repoDiff.changed.every((path) => path === "nodes/label/harvest-records.json");
	if (!allowed || repoDiff.removed.length > 0 || repoDiff.created.length > 0) {
		fail("the repo run may change harvest-records.json and nothing else");
	}
	if ((await readFile(join(repo, "data", "slug-redirects.json"), "utf8")) !== tableBefore) {
		fail("the repo run must not rewrite the redirect table");
	}

	// --- 2. The projection of the prod export ---
	const exportPath = process.argv[2];
	if (exportPath) {
		const data = JSON.parse(await readFile(exportPath, "utf8")) as {
			nodes: Obj[];
			redirects: Record<string, string>;
		};
		const prod = join(scratch, "prod");
		const proseKey: Record<string, string> = {
			project: "editorial_pitch",
			track: "editorial_teaser",
			artist: "editorial_bio",
			label: "editorial_description",
		};
		for (const n of data.nodes) {
			const type = String(n.type);
			if (!(type in proseKey)) continue;
			const slug = String(n.id);
			const body = slug.slice(slug.indexOf(":") + 1);
			const node: Obj = {
				type,
				slug,
				name: n.name,
				[proseKey[type] as string]: n.teaser,
				editorial_article: n.article,
				citations: n.citations ?? [],
				materialized_at: n.materialized_at,
				...((n.edges as Obj) ?? {}),
				...((n.facts as Obj) ?? {}),
				...(n.image_url ? { image_url: n.image_url, image_source: n.image_source } : {}),
			};
			// The export drops the empty lists the schema requires.
			for (const field of LIST_EDGES_BY_TYPE[type as keyof typeof LIST_EDGES_BY_TYPE]) node[field] ??= [];
			const path = join(prod, "cache", "nodes", type, `${body}.json`);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(node, null, 2)}\n`);
		}
		await mkdir(join(prod, "data"), { recursive: true });
		await writeFile(join(prod, "data", "genre-redirects.json"), JSON.stringify({ redirects: {} }));
		await writeFile(join(prod, "data", "slug-redirects.json"), JSON.stringify({ redirects: data.redirects }));
		const prodBefore = await files(join(prod, "cache"));
		const run = await migrate(join(prod, "cache"), join(prod, "data"), join(scratch, "prod-manifest.json"));
		const prodAfter = await files(join(prod, "cache"));
		const d = diff(prodBefore, prodAfter);
		console.log(`prod projection: ${prodBefore.size} files, exit ${run.exitCode}`);
		console.log(
			JSON.stringify(
				{
					summary: run.manifest.summary,
					renamed: run.manifest.renamed,
					skipped: run.manifest.skipped,
					conflicts: run.manifest.conflicts,
					edgeConflicts: run.manifest.edgeConflicts,
					failed: run.manifest.failed,
				},
				null,
				2,
			),
		);
		console.log("changed:", d.changed, "\nremoved:", d.removed, "\ncreated:", d.created);

		const listed = new Set(FORCED.map((f) => f.slug));
		const wrongArtists = new Set(FORCED.flatMap((f) => f.wrongArtists));
		const path = (slug: string): string =>
			`nodes/${slug.slice(0, slug.indexOf(":"))}/${slug.slice(slug.indexOf(":") + 1)}.json`;
		const expected = new Set<string>();
		for (const f of FORCED) {
			expected.add(path(f.slug));
			if (f.into) expected.add(path(f.into));
		}
		for (const target of Object.values(run.manifest.renamed)) expected.add(path(target));
		const outside = [...d.changed, ...d.removed, ...d.created].filter((p) => {
			if (expected.has(p)) return false;
			// A neighbour: the file lists, or listed, one of the works (an edge changed) or is a wrong artist's.
			const before = prodBefore.get(p) ?? "";
			const mentions = [...listed].some((slug) => before.includes(`"${slug}"`));
			const bare = Object.keys(data.redirects).some(
				(k) =>
					before.includes(`"${k}"`) &&
					(listed.has(data.redirects[k] as string) ||
						CANONICAL_TARGETS.includes(data.redirects[k] as string)),
			);
			const wrong = [...wrongArtists].some((slug) => p === path(slug));
			return !(mentions || bare || wrong || p.endsWith("track/around-the-world--daft-punk.json"));
		});
		if (outside.length > 0)
			fail(`files changed outside the closed list and its neighbours: ${outside.join(", ")}`);
		console.log("every changed file is a listed work or a node that names one: OK");

		for (const f of FORCED) {
			const b = prodBefore.get(path(f.slug));
			const a = prodAfter.get(path(run.manifest.renamed[f.slug] ?? f.slug));
			const pick = (text: string | undefined): string => {
				if (text === undefined) return "(absent)";
				const n = JSON.parse(text) as Obj;
				const edges = (v: unknown): string[] =>
					Array.isArray(v) ? (v as Obj[]).map((e) => String(e.slug)) : [];
				return JSON.stringify({
					artists: edges(n.artists),
					personnel: edges(n.personnel),
					producers: edges(n.producers),
					cover_url: n.cover_url ?? null,
					duration: n.duration ?? null,
					year: n.year ?? null,
					image: n.image_source ?? null,
				});
			};
			console.log(`\n${f.slug}\n  before ${pick(b)}\n  after  ${pick(a)}`);
			for (const { artist, field } of f.detach ?? []) {
				const held = (text: string | undefined): unknown =>
					text === undefined
						? "(absent)"
						: (((JSON.parse(text) as Obj)[field] as Obj | undefined)?.slug ?? null);
				console.log(
					`  ${artist}.${field}: ${held(prodBefore.get(path(artist)))} -> ${held(prodAfter.get(path(artist)))}`,
				);
			}
		}
	}
} finally {
	await rm(scratch, { recursive: true, force: true });
}
