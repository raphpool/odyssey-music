import type { NodeCache } from "../cache.js";
import { isNotFoundError } from "../errors.js";
import { lookupAlbumArt } from "../itunes.js";
import { logger } from "../logger.js";
import type { EdgeRef, NodePayload, Slug } from "../types.js";

const log = logger.child({ module: "image-service" });

export function createImageService(deps: { cache: NodeCache }) {
	async function resolveDisplayImage(
		slug: Slug,
		visited: Set<string> = new Set(),
	): Promise<{ slug: Slug; image_url: string | null; source: string }> {
		if (visited.has(slug)) return { slug, image_url: null, source: "cycle" };
		visited.add(slug);

		const node = await deps.cache.get(slug).catch((e: unknown) => {
			if (isNotFoundError(e)) return null;
			throw e;
		});
		if (!node) return { slug, image_url: null, source: "not-cached" };

		const raw = node as unknown as Record<string, unknown>;
		const directField = node.type === "artist" ? "photo_url" : "cover_url";
		const direct = raw[directField];
		if (typeof direct === "string" && direct) {
			return { slug, image_url: direct, source: "self" };
		}

		if (node.type === "project" || node.type === "track") {
			const artistRef = (raw.artists as EdgeRef[] | undefined)?.[0];
			const itunes = await lookupAlbumArt(node.name, artistRef?.name);
			if (itunes) {
				try {
					const updated = { ...node, cover_url: itunes, image_source: "itunes-jit" } as NodePayload;
					await deps.cache.write(updated);
				} catch (e) {
					log.warn("image persist failed", { slug, error: e instanceof Error ? e.message : String(e) });
				}
				return { slug, image_url: itunes, source: "itunes" };
			}
		}

		const tryEdges = async (
			refs: EdgeRef | EdgeRef[] | undefined,
		): Promise<{ url: string; via: Slug } | null> => {
			if (!refs) return null;
			const list = Array.isArray(refs) ? refs : [refs];
			for (const r of list) {
				const recurse = await resolveDisplayImage(r.slug, visited);
				if (recurse.image_url) return { url: recurse.image_url, via: r.slug };
			}
			return null;
		};

		const edges: Array<EdgeRef | EdgeRef[] | undefined> = (() => {
			switch (node.type) {
				case "track":
					return [raw.project as EdgeRef | undefined];
				case "artist":
					return [raw.discography as EdgeRef[] | undefined, raw.notable_tracks as EdgeRef[] | undefined];
				case "genre":
					return [
						raw.landmark_projects as EdgeRef[] | undefined,
						raw.landmark_tracks as EdgeRef[] | undefined,
					];
				case "label":
					return [raw.notable_releases as EdgeRef[] | undefined];
				default:
					return [];
			}
		})();

		for (const edge of edges) {
			const hit = await tryEdges(edge);
			if (hit) return { slug, image_url: hit.url, source: `related:${hit.via}` };
		}

		return { slug, image_url: null, source: "no-match" };
	}

	return { resolveDisplayImage };
}
