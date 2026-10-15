import type { NodeCache } from "../cache.js";
import { isNotFoundError } from "../errors.js";
import { type GenreRedirects, resolveReadSlug } from "../genre-registry.js";
import { isAllowedImageUrl } from "../images/hosts.js";
import { logger } from "../logger.js";
import type { EdgeRef, Slug } from "../types.js";

const log = logger.child({ module: "image-service" });

// Same horizon as the Cache-Control on GET /image. Anything that writes a node clears the whole
// map (see clearNegativeCache), so a freshly resolved image never waits for the TTL.
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

interface DisplayImage {
	slug: Slug;
	image_url: string | null;
	source: string;
}

/**
 * Read-only image lookup behind GET /image/:slug (TRA-475, plan decision 5). Order: the node's
 * stored `image_url`, then its legacy `photo_url` / `cover_url`, then an image borrowed from a
 * related node, then "no-match". No network call and no cache write.
 *
 * 2026-10-14: this path used to ask iTunes at read time, take the first search result and persist
 * it into the node, which gave Grandmaster Flash the cover of an Earth, Wind & Fire compilation.
 * Finding the right image is the resolver's job (src/images/resolve-image.ts), at materialization
 * or backfill time.
 */
export function createImageService(deps: {
	cache: NodeCache;
	redirects: GenreRedirects;
	// Injectable clock for tests: a negative entry expires 24h after the miss.
	now?: () => number;
}) {
	const now = deps.now ?? Date.now;
	// slug -> expiry. Only a root lookup that ended in "no-match" lands here, and such a slug is a
	// live node or a redirect to one, so the map is bounded by the graph, not by what clients ask.
	// A sub-lookup's miss is relative to the `visited` set of the walk that found it (the cycle
	// guard), so it is not recorded.
	const negative = new Map<Slug, number>();

	function isKnownMiss(slug: Slug): boolean {
		const expiry = negative.get(slug);
		if (expiry === undefined) return false;
		if (expiry > now()) return true;
		negative.delete(slug);
		return false;
	}

	/** Forget every remembered miss. server.ts calls it from invalidateCacheIndex, i.e. whenever a node was written. */
	function clearNegativeCache(): void {
		negative.clear();
	}

	async function walk(slug: Slug, visited: Set<string>): Promise<DisplayImage> {
		if (visited.has(slug)) return { slug, image_url: null, source: "cycle" };
		visited.add(slug);
		if (isKnownMiss(slug)) return { slug, image_url: null, source: "no-match" };

		// 2026-09-10 (TRA-39): without resolving the redirect first, GET /image/genre:electronic-music
		// served { image_url: null, source: "not-cached" } forever (and cached that null for 24h,
		// see the /image handler's Cache-Control in server.ts) even though genre:electronic (and its
		// landmark covers) exist and GET /node/genre:electronic-music already serves the canonical
		// node for the same slug (TRA-30). Same rule as node-service.getNode, via the shared helper.
		const lookupSlug = await resolveReadSlug(slug, deps.redirects, deps.cache);
		const node = await deps.cache.get(lookupSlug).catch((e: unknown) => {
			if (isNotFoundError(e)) return null;
			throw e;
		});
		if (!node) return { slug, image_url: null, source: "not-cached" };

		if (node.image_url) {
			if (isAllowedImageUrl(node.image_url)) {
				return { slug, image_url: node.image_url, source: node.image_source ?? "legacy" };
			}
			// The schema already refuses such a value on write and on read; this guards a node that
			// reached us another way, since the URL ends up in an <img src>.
			log.warn("stored image_url ignored: host not allowed", { slug: lookupSlug });
		}

		// photo_url / cover_url predate the allowlist and are served as is: the mobile layer filters
		// them with safePublicHttpsUrl and the web front escapes them.
		const legacy = node.type === "artist" ? node.photo_url : "cover_url" in node ? node.cover_url : undefined;
		if (legacy) return { slug, image_url: legacy, source: "legacy" };

		const edges: Array<EdgeRef | EdgeRef[] | undefined> = (() => {
			switch (node.type) {
				case "track":
					return [node.project];
				case "artist":
					return [node.discography, node.notable_tracks];
				case "genre":
					return [node.landmark_projects, node.landmark_tracks];
				case "label":
					return [node.notable_releases];
				default:
					return [];
			}
		})();

		for (const refs of edges) {
			if (!refs) continue;
			for (const ref of Array.isArray(refs) ? refs : [refs]) {
				const hit = await walk(ref.slug, visited);
				if (hit.image_url) return { slug, image_url: hit.image_url, source: `related:${ref.slug}` };
			}
		}

		return { slug, image_url: null, source: "no-match" };
	}

	async function resolveDisplayImage(slug: Slug): Promise<DisplayImage> {
		// Answered from memory: do not go through walk(), whose miss would restart the 24h clock.
		if (isKnownMiss(slug)) return { slug, image_url: null, source: "no-match" };
		const result = await walk(slug, new Set());
		if (result.source === "no-match") negative.set(slug, now() + NEGATIVE_TTL_MS);
		return result;
	}

	return { resolveDisplayImage, clearNegativeCache };
}
