import type { NodeCache } from "../cache.js";
import { isNotFoundError } from "../errors.js";
import { onDemandImagesEnabled, scopedReleaseSlugsEnabled } from "../flags.js";
import { type GenreRedirects, resolveReadSlug } from "../genre-registry.js";
import { isAllowedImageUrl } from "../images/hosts.js";
import type { EnqueueOutcome, ImageQueue } from "../images/image-queue.js";
import { type ImageSidecarEntry, readImageSidecar } from "../images/image-sidecar.js";
import { reciprocates } from "../images/resolve-image.js";
import type { WorkImageHint } from "../images/resolve-work-hint.js";
import { logger } from "../logger.js";
import { hasTransliteratedLetter, isScopedSlug } from "../slug.js";
import type { EdgeRef, NodePayload, Slug } from "../types.js";

const log = logger.child({ module: "image-service" });

// Same horizon as the Cache-Control on GET /image. Anything that writes a node clears the whole
// map (see clearNegativeCache), so a freshly resolved image never waits for the TTL.
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

// A page opened less than this long ago is not warmed again: the queue deduplicates by key anyway, so a
// second pass would only re-read the node and re-walk its edges (TRA-582).
const WARM_TTL_MS = 10 * 60 * 1000;

// Asked of the client on a `pending` answer. Constant on purpose: the worker's pace is not predictable.
const RETRY_AFTER_SECONDS = 5;

export type DisplayImageState = "found" | "pending" | "none";

export interface DisplayImage {
	slug: Slug;
	image_url: string | null;
	/**
	 * Where the answer comes from: an ImageSource, "legacy" (a stored `image_url` that carries no `image_source`; never photo_url / cover_url, TRA-592), `related:<slug>`, or why there is none
	 * ("no-match", "not-cached", "no-context", "conflict", "ambiguous", "unavailable"), or "pending".
	 */
	source: string;
	/** `found` exactly when `image_url` is set. */
	state: DisplayImageState;
	/** `pending` only. */
	retry_after_seconds?: number;
}

type OnDemand = { queue: ImageQueue; cacheDir: string };

/** What only the requested slug (not the nodes the walk borrows from) is entitled to do. */
type RootContext = { onDemand: OnDemand | null; from?: Slug };

function foundImage(slug: Slug, image_url: string, source: string): DisplayImage {
	return { slug, image_url, source, state: "found" };
}

function noImage(slug: Slug, source: string): DisplayImage {
	return { slug, image_url: null, source, state: "none" };
}

function pendingImage(slug: Slug): DisplayImage {
	return {
		slug,
		image_url: null,
		source: "pending",
		state: "pending",
		retry_after_seconds: RETRY_AFTER_SECONDS,
	};
}

/** What a sidecar entry says about `slug`. The reader only returns a fresh, valid entry. */
function fromSidecarEntry(slug: Slug, entry: ImageSidecarEntry): DisplayImage {
	switch (entry.state) {
		case "found":
			// The reader guarantees `url` and `source` on a found entry, and re-checked the host.
			return entry.url ? foundImage(slug, entry.url, entry.source ?? "legacy") : noImage(slug, "no-match");
		case "conflict":
			return noImage(slug, "conflict");
		case "unavailable":
			return noImage(slug, "unavailable");
		case "missing":
			return noImage(slug, entry.reason ?? "no-match");
	}
}

function asEdges(refs: EdgeRef | EdgeRef[] | undefined): EdgeRef[] {
	if (!refs) return [];
	return Array.isArray(refs) ? refs : [refs];
}

/**
 * The works a page displays, as hints for the queue (plan 3b-D1; projects before tracks, so the covers
 * fill in the order the eye reads them). An edge is dropped when it has no name, no artist can be named
 * for it, or it points at something other than a project or a track. The artist is the edge's own when
 * the pipeline set one, else the page's subject where that subject IS the artist; a genre or label page
 * has no such fallback, and a credit-less work is exactly what TRA-475 refused to guess.
 */
export function workHintsOf(node: NodePayload): WorkImageHint[] {
	const hints: WorkImageHint[] = [];
	const add = (
		refs: EdgeRef | EdgeRef[] | undefined,
		fallbackArtist: string | undefined,
		parentProject?: WorkImageHint["parentProject"],
	): void => {
		for (const edge of asEdges(refs)) {
			if (edge.type !== "project" && edge.type !== "track") continue;
			const title = edge.name?.trim();
			const artist = (edge.artist ?? fallbackArtist)?.trim();
			if (!title || !artist) continue;
			hints.push({
				slug: edge.slug,
				type: edge.type,
				title,
				artist,
				...(edge.mbid ? { mbid: edge.mbid } : {}),
				...(edge.releaseType ? { releaseType: edge.releaseType } : {}),
				...(parentProject && edge.type === "track" ? { parentProject } : {}),
			});
		}
	};
	switch (node.type) {
		case "artist":
			add(node.discography, node.name);
			add(node.notable_tracks, node.name);
			break;
		case "project": {
			const first = node.artists[0]?.name?.trim();
			const parentProject = first
				? { title: node.name, artist: first, ...(node.mbid ? { mbid: node.mbid } : {}) }
				: undefined;
			add(node.tracklist, first, parentProject);
			break;
		}
		case "track":
			add(node.project, node.artists[0]?.name);
			break;
		case "genre":
			add(node.landmark_projects, undefined);
			add(node.landmark_tracks, undefined);
			break;
		case "label":
			add(node.notable_releases, undefined);
			break;
	}
	return hints;
}

/**
 * Image lookup behind GET /image/:slug (TRA-475, plan decision 5; on-demand states TRA-582, plan 3b).
 * Order for a node: its stored `image_url`, then (on demand) the sidecar entry resolved for it, then an
 * image borrowed from a related node, then "no-match". The legacy `photo_url` / `cover_url` are never served.
 * For a slug with no node, on demand only: the sidecar entry of the work it names, or the job that is
 * resolving it. The answer carries a `state`: found, pending (come back in 5 s), or none.
 *
 * Never a network call and never a cache write: resolving is the queue's job, in the background
 * (decision 3b-D4), and what it finds lands in `cache/images/`, not in a node (3b-D3).
 *
 * 2026-10-14: this path used to ask iTunes at read time, take the first search result and persist
 * it into the node, which gave Grandmaster Flash the cover of an Earth, Wind & Fire compilation.
 * Finding the right image is the resolver's job (src/images/resolve-image.ts), at materialization
 * or backfill time.
 */
export function createImageService(deps: {
	cache: NodeCache;
	redirects: GenreRedirects;
	// Injectable clock for tests: a negative entry expires 24h after the miss, a warmed page after 10 min.
	now?: () => number;
	// Absent => the read-only behaviour of TRA-475, unchanged. Present => active unless
	// ODYSSEY_ON_DEMAND_IMAGES says otherwise (read at each call, so the switch needs no restart).
	onDemand?: OnDemand;
}) {
	const now = deps.now ?? Date.now;
	// slug -> expiry. Only a root lookup that ended in "no-match" lands here, and such a slug is a
	// live node or a redirect to one, so the map is bounded by the graph, not by what clients ask.
	// A related node is only read for its stored image, never walked, so it has no miss to record.
	const negative = new Map<Slug, number>();
	// node slug -> when it was warmed. Fed by nodes read from the cache only, so bounded by the graph.
	const warmed = new Map<Slug, number>();

	function active(): OnDemand | null {
		return deps.onDemand && onDemandImagesEnabled() ? deps.onDemand : null;
	}

	function isKnownMiss(slug: Slug): boolean {
		const expiry = negative.get(slug);
		if (expiry === undefined) return false;
		if (expiry > now()) return true;
		negative.delete(slug);
		return false;
	}

	/**
	 * Forget every remembered miss and every warmed page. server.ts calls it from invalidateCacheIndex,
	 * i.e. whenever a node was written.
	 */
	function clearNegativeCache(): void {
		negative.clear();
		warmed.clear();
	}

	function recentlyWarmed(slug: Slug): boolean {
		const at = warmed.get(slug);
		return at !== undefined && now() - at < WARM_TTL_MS;
	}

	/** Enqueue a page's own image if it lacks one, then the works it displays. Sync, O(edges). */
	function warm(node: NodePayload): void {
		const od = active();
		if (!od || recentlyWarmed(node.slug)) return;
		warmed.delete(node.slug); // re-insertion refreshes the age
		warmed.set(node.slug, now());

		// A full queue is transient: the page must not count as warmed, or its covers wait out the 10 minutes.
		let refusedFull = false;
		const note = (outcome: EnqueueOutcome): void => {
			if (!outcome.accepted && outcome.reason === "full") refusedFull = true;
		};

		if (!node.image_url || !isAllowedImageUrl(node.image_url)) note(od.queue.enqueueNode(node));

		// 2026-10-16 (TRA-582, residual risk of TRA-581): with ODYSSEY_SCOPED_RELEASE_SLUGS off, "MØ" and
		// "M" normalize to the same artist body, so their works share one queue key and one sidecar file:
		// one artist would be shown the other's cover. A rollback must stay safe, so such a work is simply
		// not enqueued while the flag is off (its gradient stays, as before 3b).
		const transliterates = !scopedReleaseSlugsEnabled();
		for (const hint of workHintsOf(node)) {
			if (transliterates && (hasTransliteratedLetter(hint.title) || hasTransliteratedLetter(hint.artist)))
				continue;
			note(od.queue.enqueueHint(hint));
		}
		if (refusedFull) warmed.delete(node.slug);
	}

	/** `warm` for a slug the client names (`?from=`, mobile route). An unknown slug is a no-op. */
	async function warmSlug(slug: Slug): Promise<void> {
		if (!active()) return;
		try {
			const lookupSlug = await resolveReadSlug(slug, deps.redirects, deps.cache);
			if (recentlyWarmed(lookupSlug)) return; // spares the disk read
			const node = await deps.cache.get(lookupSlug).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
			if (node) warm(node);
		} catch (e) {
			// Best effort: a page that cannot be warmed must not fail the image request that asked.
			log.warn("warm failed", { slug, error: e instanceof Error ? e.message : String(e) });
		}
	}

	async function sidecarAnswer(od: OnDemand, slug: Slug, key: Slug): Promise<DisplayImage | null> {
		const entry = await readImageSidecar(od.cacheDir, key, now);
		return entry ? fromSidecarEntry(slug, entry) : null;
	}

	/** A bare slug is mapped to the key of the work it was seen as; a scoped slug is its own key. */
	async function answerForKey(od: OnDemand, slug: Slug): Promise<DisplayImage | null> {
		const key = isScopedSlug(slug) ? slug : od.queue.aliasOf(slug);
		if (key === null) return null;
		if (key === "conflict") return noImage(slug, "conflict");
		if (key !== slug) {
			const hit = await sidecarAnswer(od, slug, key);
			if (hit) return hit;
		}
		return od.queue.stateOf(key) === "pending" ? pendingImage(slug) : null;
	}

	/** A slug with no node: answered from what the queue knows about the work, never from the network. */
	async function resolveWithoutNode(slug: Slug, od: OnDemand, from: Slug | undefined): Promise<DisplayImage> {
		const direct = await sidecarAnswer(od, slug, slug);
		if (direct) return direct;
		const viaKey = await answerForKey(od, slug);
		if (viaKey) return viaKey;
		if (from && from !== slug) {
			// The client says which page it was looking at: opening it enqueues this very work.
			await warmSlug(from);
			const again = await answerForKey(od, slug);
			if (again) return again;
		}
		// No memo for this one: the context may arrive with the next request.
		return noImage(slug, "no-context");
	}

	/** A node with nothing to show yet: its own job, or what the sidecar already decided. */
	function awaitNodeImage(node: NodePayload, slug: Slug, od: OnDemand): DisplayImage {
		const outcome = od.queue.enqueueNode(node);
		// `accepted` without a job happens when the node holds an image_url the queue believes in (here a
		// refused host): pending would never end, so it needs the job to exist.
		if ((outcome.accepted && !node.image_url) || od.queue.stateOf(node.slug) === "pending") {
			return pendingImage(slug);
		}
		// Queue full: transient, so not "no-match" (that one is remembered for 24h).
		return outcome.accepted === false && outcome.reason === "full"
			? noImage(slug, "unavailable")
			: noImage(slug, "no-match");
	}

	/** The edges a node may borrow an image from, in borrowing order. */
	function borrowEdges(node: NodePayload): EdgeRef[] {
		switch (node.type) {
			case "track":
				return asEdges(node.project);
			case "artist":
				return [...asEdges(node.discography), ...asEdges(node.notable_tracks)];
			case "genre":
				return [...asEdges(node.landmark_projects), ...asEdges(node.landmark_tracks)];
			case "label":
				return asEdges(node.notable_releases);
			default:
				return [];
		}
	}

	/**
	 * The first related work that has an allowed `image_url` AND points back at `node` (TRA-592). The
	 * predicate is the one the resolver uses to derive a cover (`reciprocates`, TRA-591): a list polluted by
	 * a homonym or a hallucination must not lend its covers here either (2026-10-16, label:mille-plateaux
	 * got the cover of Electric Ladyland). A track borrows from its own project, as the resolver does
	 * ("project-image"). A borrowed node lends only the image it stores, never one it borrowed itself.
	 */
	async function borrowFromRelated(node: NodePayload): Promise<{ slug: Slug; url: string } | null> {
		if (node.type === "project") return null; // a project has nothing to borrow from
		for (const ref of borrowEdges(node)) {
			const lookupSlug = await resolveReadSlug(ref.slug, deps.redirects, deps.cache);
			const related = await deps.cache.get(lookupSlug).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
			if (!related || (related.type !== "project" && related.type !== "track")) continue;
			if (!related.image_url || !isAllowedImageUrl(related.image_url)) continue;
			if (node.type !== "track" && !(await reciprocates(node, related, deps.cache, deps.redirects))) continue;
			return { slug: ref.slug, url: related.image_url };
		}
		return null;
	}

	async function walk(slug: Slug, root: RootContext): Promise<DisplayImage> {
		// On demand, the root's memory is the sidecar, not this map (see resolveDisplayImage).
		if (!root.onDemand && isKnownMiss(slug)) return noImage(slug, "no-match");

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
		if (!node) {
			return root.onDemand ? resolveWithoutNode(slug, root.onDemand, root.from) : noImage(slug, "not-cached");
		}

		if (node.image_url) {
			if (isAllowedImageUrl(node.image_url)) {
				return foundImage(slug, node.image_url, node.image_source ?? "legacy");
			}
			// The schema already refuses such a value on write and on read; this guards a node that
			// reached us another way, since the URL ends up in an <img src>.
			log.warn("stored image_url ignored: host not allowed", { slug: lookupSlug });
		}

		// Only the requested node consults the sidecar: a borrowed node's image is the one it stores.
		const od = root.onDemand;
		let decided: ImageSidecarEntry | null = null;
		if (od) {
			decided = await readImageSidecar(od.cacheDir, node.slug, now);
			if (decided?.state === "found") return fromSidecarEntry(slug, decided);
		}

		// 2026-10-16 (TRA-592): `photo_url` / `cover_url` are never served. They come from the LLM or from the
		// old read-time iTunes lookup that took the first search result unverified, so they are what showed
		// the Earth, Wind & Fire compilation on Grandmaster Flash and a Wikipedia icon on Gat Decor, still in
		// prod after the backfill (TRA-489) because this path kept serving them. Only a verified image
		// (`image_url`, the sidecar) or a reciprocal borrow answers.

		const borrowed = await borrowFromRelated(node);
		if (borrowed) {
			// A borrowed image is a stopgap: the node gets its own one in the background.
			if (od && !decided) od.queue.enqueueNode(node);
			return foundImage(slug, borrowed.url, `related:${borrowed.slug}`);
		}

		if (!od) return noImage(slug, "no-match");
		// The sidecar already holds a verdict (missing, unavailable, conflict): enqueueing would only make
		// the worker skip the job, and the client would poll a `pending` that never resolves.
		if (decided) return fromSidecarEntry(slug, decided);
		return awaitNodeImage(node, slug, od);
	}

	async function resolveDisplayImage(slug: Slug, opts?: { from?: Slug }): Promise<DisplayImage> {
		const od = active();
		// Answered from memory: do not go through walk(), whose miss would restart the 24h clock.
		// Not on demand only: there a "no-match" is the sidecar's verdict (its own TTL), and an image can land
		// in the sidecar at any moment without clearing this map. A miss remembered while the flag was off
		// must not hide the pending/found answers once it is switched on.
		if (!od && isKnownMiss(slug)) return noImage(slug, "no-match");
		const result = await walk(slug, { onDemand: od, ...(opts?.from ? { from: opts.from } : {}) });
		if (!od && result.source === "no-match") negative.set(slug, now() + NEGATIVE_TTL_MS);
		return result;
	}

	return { resolveDisplayImage, warm, warmSlug, workHintsOf, clearNegativeCache };
}
