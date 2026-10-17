/**
 * Does a work point back at the node that lists it? (TRA-591, shared with GET /image by TRA-592.)
 *
 * Kept apart from resolve-image.ts on purpose: that module pulls in the iTunes, MusicBrainz and Wikidata
 * clients, and the read path (src/services/image-service.ts) must stay free of them. It also keeps the
 * test files that mock those boundaries from loading the real modules through a static import.
 */
import type { NodeCache } from "../cache.js";
import { type GenreRedirects, resolveReadSlug } from "../genre-registry.js";
import type { NodePayload, Slug } from "../types.js";

/** The works a node may borrow a cover from (`project` / `track`) and the edges they declare. */
export type Work = Extract<NodePayload, { type: "project" | "track" }>;
export type Subject = Extract<NodePayload, { type: "artist" | "label" | "genre" }>;

export const isWork = (node: NodePayload): node is Work => node.type === "project" || node.type === "track";

/**
 * Does `work` point back at `subject`? A cover is borrowed only from a work that declares the node
 * itself: a notable_releases / discography / landmark list polluted by a homonym or a hallucination must
 * not lend its covers (2026-10-16, label:mille-plateaux got the cover of Electric Ladyland, a Reprise
 * release). Equality is strict everywhere:
 * - label: the work's label slug is the label's slug;
 * - artist: the work credits the artist's slug, or an artist edge carrying the same non-empty mbid;
 * - genre: a genre edge with the same slug, or with a direct parent (`parent_genres`) or a direct
 *   subgenre (`subgenres`) of the genre, once all sides went through the redirect table (TRA-597).
 * A band member therefore no longer borrows the band's cover: it credits the band, not the member.
 */
export async function reciprocates(
	subject: Subject,
	work: Work,
	cache: NodeCache,
	redirects: GenreRedirects,
): Promise<boolean> {
	switch (subject.type) {
		case "label":
			return work.label?.slug === subject.slug;
		case "artist":
			return work.artists.some(
				(a) =>
					a.type === "artist" &&
					(a.slug === subject.slug || (!!subject.mbid && !!a.mbid && a.mbid === subject.mbid)),
			);
		case "genre": {
			// TRA-597 (Raphael's decision, 2026-10-17): a genre page often cites an album tagged with a
			// neighbouring genre ("jungle" citing a drum-and-bass album). The cover is still the right sleeve of
			// the right album, so a genre also accepts a work that carries its direct parent or a direct
			// subgenre. One level only: no grandparent, no sibling, no `related_genres`. The relations come from
			// the genre node's own edges: data/genre-taxonomy.json only groups genres into families, it holds no
			// parent/child relation. Label and artist stay strict (see above).
			const accepted = new Set<Slug>([subject.slug, await resolveReadSlug(subject.slug, redirects, cache)]);
			for (const e of [...subject.parent_genres, ...subject.subgenres]) {
				if (e.type !== "genre") continue;
				accepted.add(e.slug);
				accepted.add(await resolveReadSlug(e.slug, redirects, cache));
			}
			for (const g of work.genres) {
				if (g.type !== "genre") continue;
				if (accepted.has(g.slug) || accepted.has(await resolveReadSlug(g.slug, redirects, cache)))
					return true;
			}
			return false;
		}
	}
}
