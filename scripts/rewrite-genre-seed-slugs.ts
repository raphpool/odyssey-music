// TRA-673 (2026-10-23): one-shot rewrite of the project/track targets of data/genre-seeds.json
// that still hold a pre-scoped-slug name (project:ride-on-time) to the scoped node that exists in
// cache/nodes (project:ride-on-time--black-box). The slug is never guessed: it is whatever
// resolveReadSlug returns from data/slug-redirects.json, and it is only written when that node is
// really in the cache. A target with no such node is reported and left untouched.
//
// Usage: npx tsx scripts/rewrite-genre-seed-slugs.ts [--apply]   (dry-run by default)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeCache } from "../src/cache.js";
import { loadRedirects, resolveReadSlug } from "../src/genre-registry.js";
import { GenreSeedsSchema } from "../src/genre-seeds.js";
import type { Slug } from "../src/types.js";

const SEEDS_PATH = fileURLToPath(new URL("../data/genre-seeds.json", import.meta.url));
const CACHE_ROOT = fileURLToPath(new URL("../cache", import.meta.url));

const apply = process.argv.includes("--apply");
const raw = await readFile(SEEDS_PATH, "utf8");
const seeds = GenreSeedsSchema.parse(JSON.parse(raw));
const redirects = await loadRedirects();
const cache = new NodeCache(CACHE_ROOT);

let rewritten = 0;
const unresolved: string[] = [];
for (const [qid, folder] of Object.entries(seeds)) {
	for (const target of folder.targets) {
		if (target.type === "artist") continue;
		const resolved = await resolveReadSlug(target.slug as Slug, redirects, cache);
		if (!(await cache.has(resolved))) {
			unresolved.push(`${qid} ${target.slug}`);
			continue;
		}
		if (resolved === target.slug) continue;
		console.log(`${qid}  ${target.slug}  ->  ${resolved}`);
		target.slug = resolved;
		rewritten += 1;
	}
}

for (const entry of unresolved) console.log(`UNRESOLVED (left untouched): ${entry}`);
console.log(`${rewritten} target(s) rewritten, ${unresolved.length} unresolved`);

if (apply) {
	// Re-validate the rewritten table: two targets of one folder landing on the same scoped slug
	// would trip the folder-level duplicate check and break every loader of the seeds.
	GenreSeedsSchema.parse(seeds);
	// Same layout as the committed file (tabs, trailing newline), so the diff is the slugs only.
	await writeFile(SEEDS_PATH, `${JSON.stringify(seeds, null, "\t")}\n`);
	console.log(`written: ${SEEDS_PATH}`);
} else {
	console.log("dry-run: pass --apply to write");
}
