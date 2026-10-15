/**
 * Feature flags read from the environment. Kept apart from config.ts on purpose: config.ts freezes
 * `serverConfig`, `pipelineConfig`... at import time, and src/slug.ts (imported by cache.ts and
 * schemas.ts) needs a flag. Importing config.ts from there evaluated it before tests and the iOS contract
 * harness had set GEMINI_API_KEY / PORT (TRA-528 deep review, 2026-10-15: 58 failing tests, ios-check
 * unable to start). Nothing in this module may run at import time.
 */

/**
 * Whether the slug-identity changes are on (graph-integrity plan, decisions 1 and 2):
 * - project/track references are emitted with a scoped slug (`<title>--<artist>`), and a work reference
 *   with no artist is dropped;
 * - slug normalization (normalizeSlugBody / normalizeTitleBody, so EVERY node type: artist, label,
 *   genre, project, track) transliterates ø æ œ ł ß đ þ instead of dropping them (TRA-528).
 *
 * Off by default (2026-10-15, TRA-509): every merge on main reaches production, and with the cache not
 * yet migrated (268/294 projects without "--") and /materialize still writing under the bare slug, a
 * click on `project:la-fierte--rohff` would write `project:la-fierte`, then the crawler a second scoped
 * node -- duplicates from the first materialization. The cache also holds edges to names like
 * "Lætitia Sadier" under their current slugs. TRA-509 flips it once, after TRA-477/478/481/482/483/484
 * (cache migration, /materialize and click handling). Off = the slugs main emits.
 *
 * When flipped, EVERY process that mints slugs must have it: the server, `npm run crawl`, the
 * top-up-genres workflow, sync-genre-cache and the migrations. One without it keeps writing `artist:m`
 * while another writes `artist:mo`.
 *
 * A function, not a constant: read from the environment at each call so tests can switch it without
 * leaking state between files.
 */
export function scopedReleaseSlugsEnabled(): boolean {
	const raw = process.env.ODYSSEY_SCOPED_RELEASE_SLUGS?.trim().toLowerCase();
	return raw === "true" || raw === "1";
}
