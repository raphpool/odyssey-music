/**
 * Deterministic image resolver (TRA-465, plan graph-integrity decision 5).
 *
 * One ladder per node type, first success wins, and the rung that succeeded is reported as
 * `ImageSource` so a batch can later be invalidated or re-run by provenance:
 *
 *   project → Cover Art Archive (release-group MBID) → MusicBrainz names the release group (only when
 *             `deps.viaMusicBrainz`, TRA-612, for a project with no MBID) → verified iTunes (title AND artist)
 *   track   → its project's image → CAA by the project's MBID → verified iTunes
 *   artist  → Wikidata P18 via MusicBrainz → cover of the landmark project / a discography release
 *   label   → Wikidata P154 then P18 (QID via MusicBrainz or a verified search) → a notable release
 *   genre   → cover of the first landmark project, then landmark track, that has an image
 *
 * The borrowed cover must come from a work that points back at the node (TRA-591): see `reciprocates`.
 * For a genre that includes a work carrying its direct parent or a direct subgenre (TRA-597).
 *
 * Nothing is written: this only computes a candidate. Every returned URL passes
 * `isAllowedImageUrl` (the same gate the node schema applies on write), and a failing rung (network
 * error, malformed third-party response) falls through to the next one instead of throwing.
 *
 * A cover borrowed from a release for an artist, label or genre is `derived-cover`: it is an album
 * cover, never to be presented as a photo of the entity.
 */
import type { NodeCache } from "../cache.js";
import { type GenreRedirects, loadRedirects } from "../genre-registry.js";
import { lookupVerifiedAlbumArt } from "../itunes.js";
import { logger } from "../logger.js";
import { fetchWikidataUrlRelMb, type MbPriority } from "../musicbrainz.js";
import type { EdgeRef, ImageSource, NodePayload } from "../types.js";
import { coverArtUrl } from "./coverart.js";
import { isAllowedImageUrl } from "./hosts.js";
import { isWork, reciprocity, type Subject } from "./reciprocity.js";
import { resolveAlbumByMusicBrainz } from "./resolve-work-hint.js";
import { commonsFileUrl, fetchWikidataImages, searchWikidataLabel } from "./wikidata.js";

const log = logger.child({ module: "resolve-image" });

export interface ResolvedImage {
	url: string;
	source: ImageSource;
}

export interface ImageDeps {
	cache: NodeCache;
	fetch?: typeof fetch;
	/** Queue priority of the MusicBrainz lookups (TRA-579); `interactive` when absent. */
	priority?: MbPriority;
	/**
	 * Slug redirect table used to compare genres by their canonical slug (TRA-591). Loaded lazily from
	 * `data/` when absent; an unreadable table counts as empty, i.e. strict slug equality.
	 */
	redirects?: GenreRedirects;
	/**
	 * A project without an MBID asks MusicBrainz which release group it is (the hint resolver's rules, TRA-612),
	 * between the Cover Art Archive and iTunes. Off by default: materialization has just run that very
	 * resolution to stamp the MBID, so only the on-demand queue, which serves nodes materialized before a
	 * rule was relaxed, turns it on. The MBID found is used for the cover and never written to the node.
	 */
	viaMusicBrainz?: boolean;
	/**
	 * Filled in by the resolver when a MusicBrainz request of the `viaMusicBrainz` rung failed (HTTP error,
	 * timeout, network, unreadable answer). `null` from `resolveImage` then means "could not tell", not
	 * "no image": the queue records `unavailable` (retried in an hour) instead of `missing` (kept 7 days).
	 */
	outage?: { musicBrainz: boolean };
}

// Calls `fetchWikidataUrlRelMb` directly rather than `fetchWikidataQid`: that wrapper (src/images/wikidata.ts)
// is outside the scope of TRA-579 and does not carry a priority. Same contract: any failure is a null QID.
async function mbWikidataQid(
	entity: "artist" | "label",
	mbid: string,
	deps: ImageDeps,
): Promise<string | null> {
	try {
		return await fetchWikidataUrlRelMb(
			entity,
			mbid,
			deps.fetch,
			deps.priority ? { priority: deps.priority } : {},
		);
	} catch {
		return null;
	}
}

/** Run one rung; a thrown error is a miss for that rung, not a failure of the ladder. */
async function attempt(
	rung: string,
	run: () => Promise<ResolvedImage | null>,
): Promise<ResolvedImage | null> {
	try {
		const found = await run();
		return found && isAllowedImageUrl(found.url) ? found : null;
	} catch (e) {
		log.warn("image rung failed", { rung, error: e instanceof Error ? e.message : String(e) });
		return null;
	}
}

async function firstOf(
	rungs: Array<[string, () => Promise<ResolvedImage | null>]>,
): Promise<ResolvedImage | null> {
	for (const [rung, run] of rungs) {
		const found = await attempt(rung, run);
		if (found) return found;
	}
	return null;
}

async function readNode(cache: NodeCache, ref: EdgeRef): Promise<NodePayload | null> {
	try {
		return await cache.get(ref.slug);
	} catch {
		// Not in the cache (or unreadable): an edge to a node we have not materialized has no image.
		return null;
	}
}

let defaultRedirects: GenreRedirects | undefined;

async function redirectsOf(deps: Pick<ImageDeps, "redirects">): Promise<GenreRedirects> {
	if (deps.redirects) return deps.redirects;
	if (defaultRedirects) return defaultRedirects;
	try {
		defaultRedirects = await loadRedirects();
		return defaultRedirects;
	} catch (e) {
		// Not memoized, so a later call retries. With no table two genres match only on equal slugs: the
		// strictest reading, which can only refuse a cover, never lend a wrong one.
		log.warn("redirect table unreadable, genres compared by strict slug", {
			error: e instanceof Error ? e.message : String(e),
		});
		return new Map();
	}
}

interface Borrowed {
	/** The cover of the first reciprocal work, or null when none lends one. */
	url: string | null;
	/** Cached works with an allowed image that were skipped because they do not point back at the node. */
	skipped: number;
}

/** The first cached work among `refs` that has an allowed `image_url` AND points back at `subject`. */
async function borrowFrom(
	subject: Subject,
	refs: ReadonlyArray<EdgeRef | undefined>,
	deps: Pick<ImageDeps, "cache" | "redirects">,
): Promise<Borrowed> {
	// Only genres go through the redirect table: label and artist equality stays on the raw slug (or mbid).
	const redirects = subject.type === "genre" ? await redirectsOf(deps) : new Map();
	let skipped = 0;
	// Exact before neighbour (TRA-597): the first work carrying the genre itself wins; a parent / subgenre
	// work lends its cover only when no exact one has an image. List order is kept within each kind.
	let neighbour: string | null = null;
	for (const ref of refs) {
		if (!ref) continue;
		const work = await readNode(deps.cache, ref);
		if (!work || !isWork(work) || !work.image_url || !isAllowedImageUrl(work.image_url)) continue;
		const kind = await reciprocity(subject, work, deps.cache, redirects);
		if (kind === "exact") return { url: work.image_url, skipped };
		if (kind === "neighbour") neighbour ??= work.image_url;
		else skipped++;
	}
	return { url: neighbour, skipped };
}

async function derivedCover(
	subject: Subject,
	refs: ReadonlyArray<EdgeRef | undefined>,
	deps: ImageDeps,
): Promise<ResolvedImage | null> {
	const { url } = await borrowFrom(subject, refs, deps);
	return url ? { url, source: "derived-cover" } : null;
}

/** A singular edge that older node shapes may not declare yet (`landmark_project`, TRA-457). */
function optionalEdge(node: NodePayload, key: string): EdgeRef | undefined {
	const value = (node as unknown as Record<string, unknown>)[key];
	if (typeof value !== "object" || value === null) return undefined;
	const slug = (value as { slug?: unknown }).slug;
	return typeof slug === "string" ? (value as EdgeRef) : undefined;
}

/** The edges the derived rung reads for a node, in borrowing order. */
function derivedRefs(node: Subject): Array<EdgeRef | undefined> {
	switch (node.type) {
		case "artist":
			return [optionalEdge(node, "landmark_project"), ...node.discography];
		case "label":
			return node.notable_releases;
		case "genre":
			return [...node.landmark_projects, ...node.landmark_tracks];
	}
}

/**
 * True when the derived rung found images among the node's listed works but none points back at the node:
 * the backfill reports such a node as `no-reciprocal-cover` rather than blaming a missing image (TRA-591).
 */
export async function refusedUnreciprocalCover(
	node: NodePayload,
	deps: Pick<ImageDeps, "cache" | "redirects">,
): Promise<boolean> {
	if (node.type !== "artist" && node.type !== "label" && node.type !== "genre") return false;
	const { url, skipped } = await borrowFrom(node, derivedRefs(node), deps);
	return url === null && skipped > 0;
}

async function caa(mbid: string | undefined, deps: ImageDeps): Promise<ResolvedImage | null> {
	if (!mbid) return null;
	const url = await coverArtUrl(mbid, deps.fetch);
	return url ? { url, source: "caa" } : null;
}

/** The cover of the release group MusicBrainz names for a project that holds no MBID; null when it names none. */
async function musicBrainzCover(
	node: Extract<NodePayload, { type: "project" }>,
	deps: ImageDeps,
): Promise<ResolvedImage | null> {
	const artist = node.artists[0];
	if (node.mbid || !deps.viaMusicBrainz || !artist?.name) return null;
	// The edge of a project almost never carries the MBID: the credited artist's own node does.
	const artistMbid = artist.mbid ?? (await creditedArtistMbid(artist, deps.cache));
	const found = await resolveAlbumByMusicBrainz(
		{
			title: node.name,
			artist: artist.name,
			releaseType: node.release_type,
			artistMbid,
		},
		{ slug: node.slug },
		{
			compilations: true,
			...(deps.fetch ? { fetch: deps.fetch } : {}),
			...(deps.priority ? { mbOptions: { priority: deps.priority } } : {}),
		},
	);
	// A MusicBrainz outage is no verdict on the work: the caller is told, so that it is not kept as a miss.
	if (found?.kind === "unavailable" && deps.outage) deps.outage.musicBrainz = true;
	// Only the Cover Art Archive rung can answer here (iTunes is not part of resolveAlbumByMusicBrainz).
	return found?.kind === "found" ? { url: found.url, source: "caa" } : null;
}

/** The MBID held by the node of a credited artist, or undefined: unreadable, not an artist, or without MBID. */
async function creditedArtistMbid(artist: EdgeRef, cache: NodeCache): Promise<string | undefined> {
	const node = await readNode(cache, artist);
	return node?.type === "artist" ? node.mbid : undefined;
}

async function itunes(
	title: string,
	artistName: string | undefined,
	year: string | undefined,
	deps: ImageDeps,
): Promise<ResolvedImage | null> {
	if (!artistName) return null;
	// The year is what tells two recordings of the same work apart (TRA-595).
	const url = await lookupVerifiedAlbumArt(title, artistName, deps.fetch, { year });
	return url ? { url, source: "itunes-verified" } : null;
}

async function wikidataImage(
	qid: string | null,
	order: Array<"p18" | "p154">,
	deps: ImageDeps,
): Promise<ResolvedImage | null> {
	if (!qid) return null;
	const images = await fetchWikidataImages(qid, deps.fetch);
	for (const key of order) {
		const filename = images[key];
		if (filename) {
			return { url: commonsFileUrl(filename), source: key === "p18" ? "wikidata-p18" : "wikidata-p154" };
		}
	}
	return null;
}

export async function resolveImage(node: NodePayload, deps: ImageDeps): Promise<ResolvedImage | null> {
	const { cache } = deps;
	switch (node.type) {
		case "project":
			return firstOf([
				["caa", () => caa(node.mbid, deps)],
				["musicbrainz", () => musicBrainzCover(node, deps)],
				["itunes", () => itunes(node.name, node.artists[0]?.name, node.year, deps)],
			]);

		case "track": {
			const projectRef = node.project;
			const project = projectRef ? await readNode(cache, projectRef) : null;
			return firstOf([
				[
					"project-image",
					async () => {
						if (!project?.image_url) return null;
						// Same picture as the project, so same provenance (a batch re-run by source covers both).
						return { url: project.image_url, source: project.image_source ?? "derived-cover" };
					},
				],
				["caa", () => caa(project?.mbid ?? projectRef?.mbid, deps)],
				[
					"itunes",
					() =>
						itunes(
							projectRef?.name ?? node.name,
							node.artists[0]?.name ?? (project?.type === "project" ? project.artists[0]?.name : undefined),
							// The release year is the album's: the track's own year may be a single's.
							(project?.type === "project" ? project.year : undefined) ?? projectRef?.year ?? node.year,
							deps,
						),
				],
			]);
		}

		case "artist":
			return firstOf([
				[
					"wikidata",
					async () =>
						wikidataImage(node.mbid ? await mbWikidataQid("artist", node.mbid, deps) : null, ["p18"], deps),
				],
				["derived-cover", () => derivedCover(node, derivedRefs(node), deps)],
			]);

		case "label":
			return firstOf([
				[
					"wikidata",
					async () => {
						const qid =
							(node.mbid ? await mbWikidataQid("label", node.mbid, deps) : null) ??
							(await searchWikidataLabel(node.name, node.mbid, deps.fetch));
						return wikidataImage(qid, ["p154", "p18"], deps);
					},
				],
				["derived-cover", () => derivedCover(node, derivedRefs(node), deps)],
			]);

		case "genre":
			// One pass over projects then tracks (TRA-597): an exact landmark track must beat a neighbour
			// landmark project, so the two lists cannot be separate rungs any more.
			return firstOf([["derived-cover", () => derivedCover(node, derivedRefs(node), deps)]]);
	}
}
