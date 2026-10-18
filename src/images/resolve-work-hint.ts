/**
 * Cover of a work that has no node, from a hint (title + artist) taken off a displayed edge
 * (TRA-578, plan graph-integrity part 3b, decision 3b-D2 "safety before rate").
 *
 * `resolveImage(node, deps)` needs a whole node; about 94% of the work slugs an artist page links to
 * have none (2026-10-16: 9,411 distinct slugs for 533 project/track nodes), so their thumbnails stayed
 * gradients. The ladder, first success wins:
 *
 *   project → CAA by the edge's release-group MBID, else MusicBrainz decides which release group the
 *             title + artist name (the pipeline's own resolver), then CAA on it
 *   track   → its parent project resolved as above when the edge came from a tracklist, else MusicBrainz
 *             decides the recording and CAA is asked for the release group of the release it lists
 *   all     → verified iTunes (title AND artist must match), last
 *
 * Why MusicBrainz decides first: the identity of a work must not come from a text search that returns
 * plausible strangers. An `ambiguous` verdict stops everything, iTunes included: asking iTunes about a
 * title MusicBrainz cannot single out is the credit-less borrowing TRA-475 removed (Earth, Wind & Fire's
 * cover on a Grandmaster Flash release). `unavailable` stops too, but as a different answer: it says
 * nothing about the work, so the caller retries later instead of recording a verdict.
 *
 * Pure: the network is injected (`deps.fetch` for CAA and iTunes; MusicBrainz goes through its own
 * client, to which `deps.mbOptions` is handed untouched), nothing is read from or written to the cache,
 * and a rung that throws is a miss for that rung, never a crash. Every returned URL passes
 * `isAllowedImageUrl`. At most two MusicBrainz requests per hint (one in practice).
 *
 * Compilations (TRA-612): an album MusicBrainz does not credit to the artist ("Hyperdub 10.3", Various
 * Artists, holds Kode9 tracks) gets ONE more request, and only when the resolver above found no release
 * group at all. It yields a cover and nothing else: the result carries no `mbid`, so nothing downstream can
 * take it for the identity of the work. iTunes stays closed to Various Artists.
 */
import { isVariousArtists, lookupVerifiedAlbumArt } from "../itunes.js";
import { logger } from "../logger.js";
import type { MbWorkResolution, WorkResolveOptions } from "../musicbrainz.js";
import {
	findCompilationCoverReleaseGroup,
	resolveRecordingDetailed,
	resolveReleaseGroupDetailed,
} from "../musicbrainz.js";
import type { ImageSource, Slug } from "../types.js";
import { coverArtUrl } from "./coverart.js";
import { isAllowedImageUrl } from "./hosts.js";

const log = logger.child({ module: "resolve-work-hint" });

export interface WorkImageHint {
	/** Slug of the edge, bare or scoped. Informative only: never used as an identity. */
	slug: Slug;
	type: "project" | "track";
	/** `edge.name`. */
	title: string;
	/** `edge.artist`, else the artist of the page the edge was read on. */
	artist: string;
	/** `edge.mbid`: a release group for a project, a recording for a track. */
	mbid?: string;
	/** `edge.releaseType`, handed to `WorkResolveOptions.releaseType`. */
	releaseType?: string;
	/** For a track that comes out of a tracklist: the project it was listed in. */
	parentProject?: { title: string; artist: string; mbid?: string };
}

export type WorkImageResolution =
	| {
			kind: "found";
			url: string;
			source: Extract<ImageSource, "caa" | "itunes-verified">;
			/** The release group the CAA cover belongs to (never the track's own MBID); absent for iTunes. */
			mbid?: string;
	  }
	| { kind: "missing"; reason: "ambiguous" | "no-match" }
	| { kind: "unavailable" };

export interface WorkHintDeps {
	/** Injected into `coverArtUrl` and `lookupVerifiedAlbumArt`. */
	fetch?: typeof fetch;
	/** Handed as is to the MusicBrainz resolvers: not filtered here, so a later field needs no change. */
	mbOptions?: Omit<WorkResolveOptions, "releaseType">;
	/**
	 * Turns the compilation rung on (TRA-612). Off by default because the rung costs one more MusicBrainz
	 * request for every album the first rung found no work for: only the on-demand queue pays it.
	 */
	compilations?: boolean;
}

type Found = Extract<WorkImageResolution, { kind: "found" }>;

const NO_MATCH: WorkImageResolution = { kind: "missing", reason: "no-match" };

/** Run one rung; a thrown error is a miss for that rung, not a failure of the resolution. */
async function attempt<T>(
	rung: string,
	hint: Pick<WorkImageHint, "slug">,
	run: () => Promise<T | null>,
): Promise<T | null> {
	try {
		return await run();
	} catch (e) {
		log.warn("work image rung failed", {
			rung,
			slug: hint.slug,
			error: e instanceof Error ? e.message : String(e),
		});
		return null;
	}
}

async function coverArchive(
	releaseGroupMbid: string,
	hint: Pick<WorkImageHint, "slug">,
	deps: WorkHintDeps,
): Promise<Found | null> {
	const url = await attempt("caa", hint, () => coverArtUrl(releaseGroupMbid, deps.fetch));
	return url && isAllowedImageUrl(url) ? { kind: "found", url, source: "caa", mbid: releaseGroupMbid } : null;
}

/**
 * Let MusicBrainz name the release group, then ask CAA for it. Null means "this rung has nothing, go
 * on"; a verdict that must end the resolution (`unavailable`, `ambiguous`) or a cover is returned.
 */
async function viaMusicBrainz(
	hint: Pick<WorkImageHint, "slug">,
	deps: WorkHintDeps,
	resolve: () => Promise<MbWorkResolution>,
	releaseGroupOf: (identity: NonNullable<MbWorkResolution["identity"]>) => string | null,
	/** Called only when MusicBrainz answered and found no work at all (not ambiguous, not unavailable). */
	whenNoWork?: () => Promise<WorkImageResolution | null>,
): Promise<WorkImageResolution | null> {
	const verdict = await attempt("musicbrainz", hint, resolve);
	if (!verdict) return null;
	if (verdict.unavailable) return { kind: "unavailable" };
	if (verdict.ambiguous) return { kind: "missing", reason: "ambiguous" };
	if (!verdict.identity) return whenNoWork ? whenNoWork() : null;
	const releaseGroupMbid = releaseGroupOf(verdict.identity);
	return releaseGroupMbid ? coverArchive(releaseGroupMbid, hint, deps) : null;
}

/** The album a hint stands for: the project itself, or the one a track was listed in. */
export interface Album {
	title: string;
	artist: string;
	mbid?: string | undefined;
	releaseType?: string | undefined;
	/** MBID of the artist when the caller holds its node: a direct credit whatever name it is printed under. */
	artistMbid?: string | undefined;
}

/**
 * The compilation rung (TRA-612): the album is no release group MB credits to the artist, but a compilation
 * of that title holds the artist's own tracks. Never for Various Artists itself (the first rung already
 * reads that credit), and never for an album the caller knows to be an EP or a single.
 */
async function viaCompilation(
	album: Album,
	hint: Pick<WorkImageHint, "slug">,
	deps: WorkHintDeps,
): Promise<WorkImageResolution | null> {
	if (isVariousArtists(album.artist)) return null;
	const type = album.releaseType?.trim().toLowerCase();
	if (type && type !== "album") return null;
	const verdict = await attempt("musicbrainz-compilation", hint, () =>
		findCompilationCoverReleaseGroup(album.title, album.artist, {
			...(deps.mbOptions?.priority ? { priority: deps.mbOptions.priority } : {}),
			requestedArtistMbid: album.artistMbid,
		}),
	);
	if (verdict?.kind !== "found") return null;
	const cover = await coverArchive(verdict.releaseGroupMbid, hint, deps);
	// No `mbid`: a cover borrowed from a compilation says nothing about the identity of the work.
	return cover ? { kind: "found", url: cover.url, source: "caa" } : null;
}

/** MusicBrainz decides which release group the album is, CAA is asked for it, and the compilation rung comes last. */
export function resolveAlbumByMusicBrainz(
	album: Album,
	hint: Pick<WorkImageHint, "slug">,
	deps: WorkHintDeps,
): Promise<WorkImageResolution | null> {
	return viaMusicBrainz(
		hint,
		deps,
		() =>
			resolveReleaseGroupDetailed(album.title, album.artist, {
				...deps.mbOptions,
				releaseType: album.releaseType,
				...(album.artistMbid ? { requestedArtistMbid: album.artistMbid } : {}),
			}),
		// An artist whose MBID the caller holds must be credited by that MBID, not only by a name a homonym
		// shares (TRA-560, TRA-570, TRA-604: a node whose wrong MBID was removed must not get it back as a cover).
		(identity) =>
			album.artistMbid &&
			!identity.credit.some((c) => c.mbid.toLowerCase() === album.artistMbid?.toLowerCase())
				? null
				: identity.mbid,
		deps.compilations ? () => viaCompilation(album, hint, deps) : undefined,
	);
}

async function resolveAlbum(
	album: Album,
	hint: WorkImageHint,
	deps: WorkHintDeps,
): Promise<WorkImageResolution | null> {
	if (album.mbid) return coverArchive(album.mbid, hint, deps);
	return resolveAlbumByMusicBrainz(album, hint, deps);
}

export async function resolveWorkImageByHint(
	hint: WorkImageHint,
	deps: WorkHintDeps = {},
): Promise<WorkImageResolution> {
	const title = hint.title.trim();
	const artist = hint.artist.trim();
	if (!title || !artist) return NO_MATCH;

	let album: Album | null = null;
	if (hint.type === "project") {
		album = {
			title,
			artist,
			mbid: hint.mbid?.trim() || undefined,
			releaseType: hint.releaseType?.trim() || undefined,
		};
	} else if (hint.parentProject) {
		const parent = hint.parentProject;
		const parentTitle = parent.title.trim();
		const parentArtist = parent.artist.trim();
		// A parent that is named but unusable is a malformed hint, not a licence to guess from the track.
		if (!parentTitle || !parentArtist) return NO_MATCH;
		album = { title: parentTitle, artist: parentArtist, mbid: parent.mbid?.trim() || undefined };
	}

	let outcome: WorkImageResolution | null;
	if (album) {
		outcome = await resolveAlbum(album, hint, deps);
	} else {
		// A track on its own: the recording names the release group its cover belongs to.
		outcome = await viaMusicBrainz(
			hint,
			deps,
			() => resolveRecordingDetailed(title, artist, deps.mbOptions),
			(identity) => identity.releaseGroupMbid ?? null,
		);
	}
	if (outcome) return outcome;

	const itunesTitle = album?.title ?? title;
	const itunesArtist = album?.artist ?? artist;
	const url = await attempt("itunes", hint, () =>
		lookupVerifiedAlbumArt(itunesTitle, itunesArtist, deps.fetch),
	);
	return url && isAllowedImageUrl(url) ? { kind: "found", url, source: "itunes-verified" } : NO_MATCH;
}
