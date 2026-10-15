import type { NodeCache } from "../cache.js";
import type { CacheIndex } from "../cache-index.js";
import { scopedReleaseSlugsEnabled } from "../config.js";
import type { ApiEnv } from "../env.js";
import { BadRequestError, isNotFoundError } from "../errors.js";
import type { GenreRegistry } from "../genre-registry.js";
import { logger } from "../logger.js";
import { EDGE_FIELDS_BY_TYPE } from "../node-spec.js";
import { type PipelineDeps, runPipeline } from "../pipeline.js";
import {
	isScopedSlug,
	isValidSlug,
	makeScopedSlug,
	makeSlug,
	normalizeSlugBody,
	parseSlug,
	scopeMatchesArtist,
	scopeOf,
} from "../slug.js";
import type { EdgeRef, NodePayload, NodeType, Slug } from "../types.js";
import { NODE_TYPES, QID_PATTERN } from "../types.js";

const log = logger.child({ module: "materialize-service" });

/** A cache-only mobile preflight found no reusable node; it never contacted a provider. */
export class MaterializeCacheMissError extends Error {
	constructor() {
		super("materialize cache miss");
		this.name = "MaterializeCacheMissError";
	}
}

export interface MaterializeRequest {
	type?: string;
	name?: string;
	// TRA-477: primary artist of the work (project/track) the edge points at -- the artist page the
	// click came from. UNTRUSTED client input: shape-checked (validateArtist), never used as a path,
	// and it only ever scopes a slug (`<title>--<artist>`) or gates a cache hit on the node's credit.
	// Ignored for other types, and ignored altogether while ODYSSEY_SCOPED_RELEASE_SLUGS is off.
	artist?: string;
	disambiguator?: string;
	mbid?: string;
	// 2026-09-10 (TRA-43): identity carried by the EDGE that produced this request (front chip,
	// crawler frontier), not re-derived from `name` -- validated in handleMaterialize below.
	slug?: string;
	qid?: string;
	// TRA-477: the node and edge field the clicked reference lives in. When the pipeline learns the work's
	// canonical slug, that one edge is repointed (see repointSourceEdge). UNTRUSTED: validateSource.
	source?: { slug: string; field: string };
}

// 2026-09-10 (review round 1, nit): unbounded, this would surface as a raw ENOENT/ENAMETOOLONG
// 500 instead of a 400. 200 is generous (real committed slug bodies are well under 100).
const MAX_SLUG_LENGTH = 200;

/**
 * Validates a client-supplied slug before any I/O (TRA-43, TRA-501): bounded length, canonical
 * (CANONICAL_SLUG_PATTERN, the same rule the node schema applies on write -- parseSlug alone only
 * checks a colon and a known type, so "genre:../x" and `artist:x" onmouseover="y` would pass it), and
 * naming the same type as the rest of the request. Throws BadRequestError (never a bare Error) --
 * src/server.ts maps that to a 400.
 */
function validateRequestSlug(rawSlug: string, type: string): Slug {
	if (rawSlug.length > MAX_SLUG_LENGTH) {
		throw new BadRequestError(`Invalid slug: too long (max ${MAX_SLUG_LENGTH} chars)`);
	}
	if (!isValidSlug(rawSlug) || parseSlug(rawSlug).type !== type) {
		throw new BadRequestError(`Invalid slug: ${rawSlug}`);
	}
	return rawSlug;
}

const MAX_ARTIST_LENGTH = 200;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Credited artists whose own node is read to look for a group membership. A work credits a handful of
// artists; the cap only keeps a hostile or corrupt node from fanning the lookup out.
const MAX_GROUP_LOOKUPS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The artist a client names for a work (TRA-477). Untrusted: bounded, no control characters, and it
 * must normalize to a non-empty slug body when it has to scope a slug (flag on): a name with no Latin
 * letter or digit ("坂本龍一") cannot, and a context we cannot use is refused rather than silently dropped
 * (a dropped context is how a work gets attached to the wrong artist). With the flag off it is ignored,
 * so it is not refused. Whitespace is collapsed; the display spelling is kept.
 */
function validateArtist(raw: unknown, mustScope: boolean): string {
	if (typeof raw !== "string") throw new BadRequestError("Invalid artist");
	const artist = raw.replace(/\s+/gu, " ").trim();
	if (!artist || artist.length > MAX_ARTIST_LENGTH || /\p{Cc}/u.test(artist)) {
		throw new BadRequestError("Invalid artist");
	}
	if (mustScope && !normalizeSlugBody(artist)) {
		throw new BadRequestError("Invalid artist: needs at least one Latin letter or digit");
	}
	return artist;
}

/**
 * The edge a click came from (TRA-477): a canonical slug and an edge field that really exists on that
 * node type (EDGE_FIELDS_BY_TYPE). The field name indexes a record, so an unknown or inherited key
 * ("__proto__", "constructor") is refused here, not later.
 */
function validateSource(raw: unknown): { slug: Slug; field: string } {
	if (!isRecord(raw) || typeof raw.slug !== "string" || typeof raw.field !== "string") {
		throw new BadRequestError("Invalid source");
	}
	const { slug, field } = raw;
	if (slug.length > MAX_SLUG_LENGTH || !isValidSlug(slug)) {
		throw new BadRequestError(`Invalid source slug: ${slug.slice(0, 80)}`);
	}
	const fields: Record<string, unknown> = EDGE_FIELDS_BY_TYPE[parseSlug(slug).type];
	if (!Object.hasOwn(fields, field)) {
		throw new BadRequestError(`Invalid source field: ${field.slice(0, 40)}`);
	}
	return { slug, field };
}

function isWorkType(type: string): type is "project" | "track" {
	return type === "project" || type === "track";
}

/**
 * SECURITY (TRA-43 review round 1, 2026-09-10): a refresh must use the existing/canonical node's
 * OWN identity, never the client's. Repro: a stale `genre:techno` + `{name: "Attacker Controlled
 * Topic", slug: "genre:techno"}` pinned `slug` while keeping the client's `name` -- an
 * unauthenticated POST /materialize could rewrite any cache/<slug>.json with attacker content.
 *
 * 2026-09-10 (TRA-45): the node itself never stores a `disambiguator` (src/types.ts) -- left
 * alone, a refresh silently dropped it from the search query/prompt even though the node's OWN
 * slug still carries the distinguishing suffix (bug repro: refreshing "genre:trap--edm" lost
 * "EDM" entirely). Reconstruct it from that suffix; prefer `clientDisambiguator`'s original
 * casing/wording ONLY when it normalizes to the exact same suffix the node's own slug already
 * carries -- never apply a client value the slug doesn't corroborate, which would reopen the
 * spoofing this refresh path exists to close.
 */
function refreshIdentityFrom(
	node: NodePayload,
	clientDisambiguator?: string,
	scoped = false,
): MaterializeRequest {
	const out: MaterializeRequest = { type: node.type, name: node.name };
	const mbid = (node as unknown as { mbid?: string }).mbid;
	if (mbid) out.mbid = mbid;
	// TRA-477: a scoped work's suffix is its artist, not a free-text disambiguator -- hand it back as the
	// artist hint (the credited name when the node has one, else the scope body read as words).
	if (scoped && (node.type === "project" || node.type === "track")) {
		const scope = scopeOf(node.slug);
		const artist = node.artists[0]?.name ?? (scope ? scope.replace(/-/gu, " ") : undefined);
		if (artist) out.artist = artist;
		return out;
	}
	const { body } = parseSlug(node.slug);
	const suffixIdx = body.indexOf("--");
	if (suffixIdx >= 0) {
		const suffix = body.slice(suffixIdx + 2);
		const coherent = !!clientDisambiguator && normalizeSlugBody(clientDisambiguator) === suffix;
		out.disambiguator = coherent ? clientDisambiguator : suffix;
	}
	return out;
}

export interface MaterializeResponse {
	// The reference value for the client is `node.slug`, not `makeSlug(body)` on the original
	// request: the genre canonicalization guard in handleMaterialize can rewrite a request onto
	// an existing canonical node, so the returned node's own slug may differ from what the
	// caller's {type, name} would hash to.
	node: NodePayload;
	source: "cache" | "jit";
	// TRA-477: set when the slug the request was filed under is not the one the node ended up with
	// (MusicBrainz named a different primary artist). A client holding an edge to this slug repoints it
	// to `node.slug`; the server already did so for `source`, when the request carried one.
	requested_slug?: Slug;
	wallMs: number;
	metricsCostUsd?: number;
}

interface JitOptions {
	fresh?: boolean;
	slug?: Slug;
	maxProviderAttempts?: 1;
	// TRA-538: provenance of `body.mbid`; absent means a client's (the safe reading).
	mbidSource?: "client" | "server";
}

/** What one pipeline run produced: the node, and the slug it was asked for when the node moved. */
interface JitResult {
	node: NodePayload;
	requestedSlug?: Slug;
}

export function createMaterializeService(deps: {
	cache: NodeCache;
	env: ApiEnv;
	genreRegistry: GenreRegistry;
	// TRA-477: MBID -> cached node, to answer a request that names its MusicBrainz id from the cache.
	// Optional: without it an mbid is only a hint, as before.
	getCacheIndex?: () => Promise<CacheIndex>;
	// Called after every node write so the index above never serves a stale slug.
	invalidateCacheIndex?: () => void;
	// TRA-479: picks the image of a node being materialized (see PipelineDeps.resolveImage). The
	// composition root builds it from the images resolver and this same cache; unset = no image step.
	resolveImage?: PipelineDeps["resolveImage"];
	// TRA-480: attaches `similar_artists` to an artist being materialized (see PipelineDeps.similarArtists).
	// Built by the composition root from the resolver and this same cache; unset = `[]`, as before.
	similarArtists?: PipelineDeps["similarArtists"];
}) {
	const inflight = new Map<string, Promise<JitResult>>();

	async function readNode(slug: Slug): Promise<NodePayload | null> {
		return await deps.cache.get(slug).catch((e: unknown) => {
			if (isNotFoundError(e)) return null;
			throw e;
		});
	}

	/**
	 * True when `node` (a project/track) credits `artist`: the name is in `artists` or `producers`, or
	 * in the `members` of a credited artist's own node (a person credited through their group: Roni Size
	 * -> Roni Size / Reprazent, plan decision 3). Names are compared normalized, never as slugs.
	 */
	async function creditsArtist(node: NodePayload, artist: string): Promise<boolean> {
		if (node.type !== "project" && node.type !== "track") return false;
		const wanted = normalizeSlugBody(artist);
		if (!wanted) return false;
		const credited: EdgeRef[] = [...node.artists, ...node.producers];
		if (credited.some((edge) => normalizeSlugBody(edge.name) === wanted)) return true;
		let lookups = 0;
		for (const edge of credited) {
			if (edge.type !== "artist" || !isValidSlug(edge.slug)) continue;
			if (lookups++ >= MAX_GROUP_LOOKUPS) break;
			const group = await readNode(edge.slug);
			if (group?.type === "artist" && group.members.some((m) => normalizeSlugBody(m.name) === wanted)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Repoints the edge `source.field` of `source.slug` that holds `requested` onto the node written
	 * instead (TRA-477). It only REPLACES an edge that already equals `requested`: the source is client
	 * input, so it can fix a dangling edge but never add one. A self-edge, or a field that does not take
	 * the node's type, is refused (with or without the scoped-slug flag). Failures are logged, not thrown:
	 * the node is written and the client must get it.
	 */
	async function repointSourceEdge(
		source: { slug: Slug; field: string },
		requested: Slug,
		node: NodePayload,
	): Promise<boolean> {
		try {
			const spec = (
				EDGE_FIELDS_BY_TYPE[parseSlug(source.slug).type] as Record<string, { targets: readonly NodeType[] }>
			)[source.field];
			if (source.slug === node.slug || !spec?.targets.includes(node.type)) {
				log.warn("materialize: refused to repoint an edge", { ...source, target: node.slug });
				return false;
			}
			const sourceNode = await readNode(source.slug);
			if (!sourceNode) return false;
			const fields = sourceNode as unknown as Record<string, unknown>;
			const current = fields[source.field];
			const repoint = (ref: unknown) =>
				isRecord(ref) && ref.slug === requested ? { ...ref, slug: node.slug } : ref;
			if (Array.isArray(current)) {
				if (!current.some((ref) => isRecord(ref) && ref.slug === requested)) return false;
				// Only the replaced edge is touched: it is dropped when the list already holds the target,
				// every other entry stays as it was (committed lists carry same-slug entries that differ).
				const present = current.some((ref) => isRecord(ref) && ref.slug === node.slug);
				fields[source.field] = present
					? current.filter((ref) => !(isRecord(ref) && ref.slug === requested))
					: current.map(repoint);
			} else if (isRecord(current) && current.slug === requested) {
				fields[source.field] = repoint(current);
			} else {
				return false;
			}
			await deps.cache.replace(sourceNode);
			deps.invalidateCacheIndex?.();
			return true;
		} catch (e) {
			log.warn("materialize: could not repoint the requesting edge", {
				...source,
				requested,
				error: e instanceof Error ? e.message : String(e),
			});
			return false;
		}
	}

	async function handleMaterialize(
		body: MaterializeRequest,
		opts: { fresh?: boolean; reuseExisting?: boolean; cacheOnly?: boolean; maxProviderAttempts?: 1 } = {},
	): Promise<MaterializeResponse> {
		if (
			!body.type ||
			typeof body.type !== "string" ||
			!(NODE_TYPES as readonly string[]).includes(body.type)
		) {
			throw new BadRequestError("Provide {type, name}");
		}
		if (!body.name || typeof body.name !== "string") {
			throw new BadRequestError("Provide {type, name}");
		}
		// 2026-09-10 (TRA-43): validate BEFORE any cache I/O -- `slug` below can end up naming a
		// path NodeCache derives straight from it (cache.ts), so an unvalidated client value must
		// never reach that point, even indirectly through a caught ENOENT.
		let requestSlug: Slug | undefined;
		if (body.slug !== undefined) {
			if (typeof body.slug !== "string") throw new BadRequestError("Invalid slug");
			requestSlug = validateRequestSlug(body.slug, body.type);
		}
		if (body.qid !== undefined && (typeof body.qid !== "string" || !QID_PATTERN.test(body.qid))) {
			throw new BadRequestError(`Invalid qid: ${String(body.qid)}`);
		}
		// TRA-477: the artist context and the source edge are client input, so they are shape-checked
		// here, before any I/O, whatever the flag says. They only change behavior while it is on.
		const scoped = scopedReleaseSlugsEnabled();
		const artist = body.artist === undefined ? undefined : validateArtist(body.artist, scoped);
		const source = body.source === undefined ? undefined : validateSource(body.source);
		const scopedWork = scoped && isWorkType(body.type);
		// Flag on: an mbid is an identity, so it must be one (a UUID, lowercased like the index keys).
		// Flag off it stays the free-form hint it always was.
		let mbid = body.mbid;
		if (scoped && mbid !== undefined) {
			if (typeof mbid !== "string" || !MBID_PATTERN.test(mbid.toLowerCase())) {
				throw new BadRequestError("Invalid mbid");
			}
			mbid = mbid.toLowerCase();
		}
		// What scopes a work's slug: the client's artist, else the scope of a scoped slug it named (the
		// edge it clicked was emitted under that scope). Without either, an mbid is the only identity.
		const requestScopeText =
			artist ??
			(requestSlug && isScopedSlug(requestSlug) ? scopeOf(requestSlug)?.replace(/-/gu, " ") : undefined);
		if (scopedWork && !requestScopeText && !mbid) {
			throw new BadRequestError("A project or track needs an artist, an mbid or a scoped slug");
		}
		let mintedScope: Slug | undefined;
		if (scopedWork && requestScopeText) {
			const minted = makeScopedSlug(body.type as "project" | "track", body.name, requestScopeText);
			if (!minted.ok) throw new BadRequestError(`Cannot build a scoped slug (${minted.reason})`);
			mintedScope = minted.slug;
		}
		const t0 = Date.now();
		const fresh = opts.fresh === true;
		let effectiveBody: MaterializeRequest = mbid === body.mbid ? body : { ...body, mbid: mbid as string };
		// TRA-538: where `effectiveBody.mbid` comes from. The request's own is a hint MusicBrainz must confirm;
		// the one `refreshIdentityFrom` copies off a cached node was established by the server and must
		// survive a refresh even if MusicBrainz no longer singles the work out.
		let mbidSource: "client" | "server" = "client";
		// 2026-09-10 (TRA-43 security fix): the MINT slug is always name-derived, exactly as on main
		// before this ticket -- `requestSlug` below is a LOOKUP key for an existing/canonical node,
		// never a write target on its own (see refreshIdentityFrom above).
		// TRA-477 (flag on): a work's mint slug is `<title>--<artist>`; with only an mbid there is no
		// name-derived slug to look up (the bare `track:fitna` would be somebody else's Fitna), so the
		// lookup is skipped and MusicBrainz names the scope.
		let slug: Slug | undefined = scopedWork
			? mintedScope
			: makeSlug(body.type as NodePayload["type"], body.name, body.disambiguator);
		// Set once `slug` names the exact target this call will serve/refresh (a caller-supplied
		// slug that hit a real node, a canonical rewrite, or the cache lookup below) -- never on a
		// fresh, name-derived mint with no identity of its own. Passed to runPipeline as
		// PipelineInput.slug so canonicalizeDraft keeps it instead of re-deriving one from the LLM
		// draft's own name (review round 2 / TRA-30: 62 real nodes already have makeSlug(name) !== slug).
		// A scoped work is the exception: its freshly minted slug is pinned too (TRA-477), because the
		// pipeline would otherwise file it under the bare title.
		let pinnedSlug: Slug | undefined = mintedScope;
		let cached: NodePayload | null = null;

		// Phase 0 (TRA-477, flag on): an MBID names exactly one entity, so a node the cache already holds
		// for it answers the request before any name or artist is looked at.
		if (scoped && mbid && deps.getCacheIndex) {
			const hit = (await deps.getCacheIndex()).byMbid(mbid);
			const node = hit ? await readNode(hit) : null;
			if (node) {
				if (node.type !== body.type) {
					throw new BadRequestError("Provided identifiers conflict with the existing node");
				}
				effectiveBody = refreshIdentityFrom(node, body.disambiguator, scopedWork);
				mbidSource = "server";
				slug = node.slug;
				pinnedSlug = node.slug;
				cached = node;
			}
		}

		// Phase 1 (TRA-43): does the caller's OWN slug already name a real node? If so, that node's
		// identity drives everything below, never the client's (GenreRegistry rule 2's analog,
		// applied up front for every node type).
		// TRA-477 (flag on): for a work the client's slug only wins when it is scoped, and -- given an
		// artist -- when that node credits the artist. A slug that does not is the exact shape of the
		// homonym bug (`track:fitna--akuma` insisted on from Rohff's page), so it is ignored and the
		// work is minted under the artist's own scoped slug.
		if (requestSlug && !cached && (!scopedWork || isScopedSlug(requestSlug))) {
			const existing = await readNode(requestSlug);
			if (existing) {
				const attaches =
					!scopedWork ||
					!artist ||
					scopeMatchesArtist(requestSlug, artist) ||
					(await creditsArtist(existing, artist));
				if (attaches) {
					effectiveBody = refreshIdentityFrom(existing, body.disambiguator, scopedWork);
					mbidSource = "server";
					slug = requestSlug;
					pinnedSlug = requestSlug;
					cached = existing;
				} else {
					log.info("materialize: client slug does not credit the requested artist, ignoring it", {
						slug: requestSlug,
						artist,
					});
				}
			}
		}

		// 2026-09-09: after TRA-22's duplicate-merge migration, a genre chip whose display name
		// survives edge rewriting (e.g. a "Electronic music" chip after the "electronic-music"
		// node was merged into "electronic") still hashes to the loser's slug and would otherwise
		// re-mint the very duplicate the migration just removed. Before minting a genre, ask the
		// registry for the canonical slug; if a cache node already exists there, rewrite the
		// request onto it instead of minting a new one (decision d'archi 9).
		//
		// 2026-09-10 (review round 2): skipped entirely when a disambiguator is present -- a
		// disambiguator exists precisely to force a distinct node (slug.ts), but
		// canonicalSlugFor's resolver lookup is name-only and would otherwise happily merge
		// {name: "Trap", disambiguator: "EDM"} onto the unrelated existing "genre:trap" (hip-hop)
		// the moment their names resolve to the same qid.
		//
		// 2026-09-10 (TRA-43 security fix): skipped when phase 1 already resolved a node. Reference
		// `requestSlug` (redirect/qid lookups) when given, else the name-derived `slug` -- unchanged
		// from before this ticket. Its non-existence was already checked in phase 1, so only the
		// no-`requestSlug` case needs has() here.
		if (!cached && slug && body.type === "genre" && !body.disambiguator) {
			const guardSlug = requestSlug ?? slug;
			const guardApplies = requestSlug !== undefined || !(await deps.cache.has(guardSlug));
			if (guardApplies) {
				// 2026-09-10 (TRA-43): forward qid/mbid so rule 4 can fire even for a brand-new slug
				// (two MB tags sharing a QID materialized by name, one after the other -- scenario 6).
				const canonicalRef: { slug: Slug; name: string; qid?: string; mbid?: string } = {
					slug: guardSlug,
					name: body.name,
				};
				if (body.qid) canonicalRef.qid = body.qid;
				if (body.mbid) canonicalRef.mbid = body.mbid;
				const canonical = await deps.genreRegistry.canonicalSlugFor(canonicalRef);
				if (canonical.slug !== guardSlug) {
					// Single read, not has()+get(): a named canonical slug absent from disk (pruned
					// cache) means "nothing to serve" -- fall through to the name-derived mint. Any
					// other read failure still throws.
					const canonicalNode = await deps.cache.get(canonical.slug).catch((e: unknown) => {
						if (isNotFoundError(e)) return null;
						throw e;
					});
					if (canonicalNode) {
						effectiveBody = refreshIdentityFrom(canonicalNode, body.disambiguator);
						mbidSource = "server";
						slug = canonical.slug;
						pinnedSlug = canonical.slug;
						cached = canonicalNode;
					}
				}
				// Rule 5: `slug`/`pinnedSlug` stay untouched -- an unresolved `requestSlug` is never
				// pinned as a mint target (security fix).
			}
		}

		// 2026-09-10 (review round 2, nit): read once regardless of `fresh` -- opts.fresh === true
		// (?fresh=1, server.ts) used to skip this whole block, so a request for an ALREADY-cached
		// slug with fresh:true never set pinnedSlug: the loser name was protected by the guard
		// above, but the canonical name wasn't, once fresh:true was in play. A node found here is
		// always the one this call is about to refresh, fresh or not. Skipped when phase 1/2 above
		// already resolved `cached` -- no need to re-read the same file.
		if (!cached && slug) cached = await readNode(slug);
		if (cached) pinnedSlug = slug;
		const cachedMbid = (cached as unknown as { mbid?: string } | null)?.mbid;
		const cachedQid = (cached as unknown as { qid?: string } | null)?.qid;
		if (
			cached &&
			opts.reuseExisting === true &&
			((body.mbid !== undefined &&
				cachedMbid !== undefined &&
				body.mbid.toLowerCase() !== cachedMbid.toLowerCase()) ||
				(body.qid !== undefined && cachedQid !== undefined && body.qid !== cachedQid))
		) {
			throw new BadRequestError("Provided identifiers conflict with the existing node");
		}
		// Mobile generation intentionally serves a known node as-is, without the mbid-mismatch
		// refresh below. The default remains unchanged so legacy /materialize keeps that refresh.
		if (cached && opts.reuseExisting === true) {
			return { node: cached, source: "cache", wallMs: Date.now() - t0 };
		}
		// TRA-477: an mbid alone can find a work in the cache, never create one: without an artist (or a
		// scoped slug) the pipeline would file it under the bare title, or the scope a client-chosen mbid
		// names. Refused before any paid call, and without asking MusicBrainz, so an outage is not a 400.
		if (scopedWork && !cached && !pinnedSlug) {
			throw new BadRequestError("A project or track that is not cached needs an artist or a scoped slug");
		}
		if (!cached && opts.cacheOnly === true) throw new MaterializeCacheMissError();
		// TRA-538: a refresh of a work that already carries an mbid keeps that server-established mbid,
		// whatever the request sent: a different client mbid stays a hint and never replaces it, and
		// MusicBrainz no longer singling the work out must not erase it.
		if (cached && cachedMbid && isWorkType(body.type) && mbidSource === "client") {
			effectiveBody = { ...effectiveBody, mbid: cachedMbid };
			mbidSource = "server";
		}
		let effectiveFresh = fresh;
		if (!fresh && cached) {
			// 2026-10-14 (TRA-449): age no longer forces a refresh (it used to, past a 12 h TTL --
			// symptom: prod diverging silently from the repo). Only an explicit `fresh`, or a
			// client mbid that contradicts the cached one, re-runs the pipeline.
			// A work's mbid from the client is a hint only (TRA-477 flag on, TRA-538 whatever the flag): never
			// a reason to rewrite it, since the refresh would no longer adopt the client's value anyway.
			const mbidMismatch =
				!isWorkType(body.type) && !!effectiveBody.mbid && cachedMbid !== effectiveBody.mbid;
			if (!mbidMismatch) {
				return { node: cached, source: "cache", wallMs: Date.now() - t0 };
			}
			effectiveFresh = true;
		}
		// A scoped slug without `artist` (what the web front sends today) still tells MusicBrainz and the
		// search whose work it is.
		if (scopedWork && requestScopeText && !effectiveBody.artist) {
			effectiveBody = { ...effectiveBody, artist: requestScopeText };
		}
		// Mobile promises never retry a paid provider call. Keep this policy in the
		// in-flight identity: sharing with a concurrent web refresh would otherwise let
		// whichever request arrives first silently choose the other surface's retry policy.
		const normalizedDisambiguator = normalizeSlugBody(effectiveBody.disambiguator ?? "");
		const key = JSON.stringify({
			slug: slug ?? null,
			type: effectiveBody.type,
			// `slug` is name-normalized, but this key used the raw display spelling.
			// That let case-only mobile retries start duplicate paid materializations.
			name: normalizeSlugBody(effectiveBody.name ?? ""),
			disambiguator: normalizedDisambiguator || null,
			// TRA-477: the artist scopes a work, so two artists' same-titled works never share a run.
			artist: scoped ? normalizeSlugBody(effectiveBody.artist ?? "") || null : null,
			mbid: effectiveBody.mbid?.toLowerCase() ?? null,
			mbidSource,
			qid: effectiveBody.qid ?? null,
			fresh: effectiveFresh,
			providerAttempts: opts.maxProviderAttempts ?? 2,
		});
		// The slug to report, after repointing the caller's own edge (a shared run repoints once per caller).
		// An edge moves only when the server established the target's identity AND the node credits the
		// context artist (or its scope is the artist): a client mbid naming somebody else's work must not
		// carry an artist's edge to it -- the reverse edges would then credit that artist on the work.
		// When the client's own slug was ignored (homonym), the stale edge stays; TRA-478 migrates it.
		const settle = async ({ node, requestedSlug }: JitResult): Promise<Slug | undefined> => {
			if (!requestedSlug) return undefined;
			if (
				scopedWork &&
				requestScopeText &&
				!scopeMatchesArtist(node.slug, requestScopeText) &&
				!(await creditsArtist(node, requestScopeText))
			) {
				return undefined;
			}
			if (source && !(await repointSourceEdge(source, requestedSlug, node))) return undefined;
			return requestedSlug;
		};
		const existing = inflight.get(key);
		if (existing) {
			const result = await existing;
			const requested = await settle(result);
			return {
				node: result.node,
				source: "jit",
				...(requested ? { requested_slug: requested } : {}),
				wallMs: Date.now() - t0,
			};
		}
		const jitOpts: JitOptions = { fresh: effectiveFresh, mbidSource };
		if (pinnedSlug) jitOpts.slug = pinnedSlug;
		if (opts.maxProviderAttempts !== undefined) jitOpts.maxProviderAttempts = opts.maxProviderAttempts;
		const p = runJitDetailed(effectiveBody, jitOpts);
		inflight.set(key, p);
		try {
			const result = await p;
			const { node } = result;
			const requested = await settle(result);
			const out: MaterializeResponse = { node, source: "jit", wallMs: Date.now() - t0 };
			if (requested) out.requested_slug = requested;
			const m = (node as unknown as { _metrics?: { cost_usd: number } })._metrics;
			if (m) out.metricsCostUsd = m.cost_usd;
			return out;
		} finally {
			inflight.delete(key);
		}
	}

	async function runJit(body: MaterializeRequest, opts: JitOptions = {}): Promise<NodePayload> {
		return (await runJitDetailed(body, opts)).node;
	}

	async function runJitDetailed(body: MaterializeRequest, opts: JitOptions = {}): Promise<JitResult> {
		if (!body.type || !body.name) {
			throw new BadRequestError("Pipeline JIT requires both 'type' and 'name'.");
		}
		const pipelineInput: {
			type: NodeType;
			name: string;
			disambiguator?: string;
			mbid?: string;
			mbidIsClientHint?: boolean;
			slug?: Slug;
			qid?: string;
			artist?: string;
		} = {
			type: body.type as NodeType,
			name: body.name,
		};
		if (body.disambiguator) pipelineInput.disambiguator = body.disambiguator;
		if (body.mbid) {
			pipelineInput.mbid = body.mbid;
			// TRA-538: a client's mbid is a hint the pipeline must have MusicBrainz confirm; one read off
			// the cached node (refresh) was established by the server and is kept.
			if (opts.mbidSource !== "server") pipelineInput.mbidIsClientHint = true;
		}
		// TRA-477: the credit hint MusicBrainz and the search use to tell same-titled works apart.
		if (body.artist && isWorkType(body.type) && scopedReleaseSlugsEnabled()) {
			pipelineInput.artist = body.artist;
		}
		// TRA-30 (node-service, PR #31) will pass its own opts.slug after this ticket merges --
		// keep this shape stable (see the pinnedSlug comment in handleMaterialize above).
		if (opts.slug) pipelineInput.slug = opts.slug;
		// 2026-09-10 (TRA-43): the edge's own qid, carried through as an identity hint --
		// enrichFromMusicBrainz's genre block gives it precedence over a fresh by-name resolve.
		// 2026-09-10 (TRA-45): EXCEPT when a disambiguator is present -- a disambiguator asserts
		// this is a DISTINCT node, which a client-supplied qid (naming some OTHER, presumably
		// existing entity) directly contradicts. Repro this closes: an unauthenticated POST
		// {name:"Fake Genre", disambiguator:"xx", qid:<genre:techno's real Q170611>} used to mint
		// a brand-new "genre:fake-genre--xx" stamped with techno's qid -- two nodes sharing one
		// QID, which TRA-32 then makes sticky on every future rematerialization.
		if (body.qid && body.disambiguator) {
			log.info("materialize: disambiguator present, ignoring client-supplied qid", {
				type: body.type,
				name: body.name,
				disambiguator: body.disambiguator,
				ignoredQid: body.qid,
			});
		} else if (body.qid) {
			pipelineInput.qid = body.qid;
		}
		const r = await runPipeline(pipelineInput, {
			tavilyApiKey: deps.env.TAVILY_API_KEY,
			firecrawlApiKey: deps.env.FIRECRAWL_API_KEY,
			genreRegistry: deps.genreRegistry,
			...(deps.resolveImage ? { resolveImage: deps.resolveImage } : {}),
			...(deps.similarArtists ? { similarArtists: deps.similarArtists } : {}),
			...(opts.maxProviderAttempts === undefined ? {} : { maxProviderAttempts: opts.maxProviderAttempts }),
		});
		const requestedSlug = r.requestedSlug;
		// TRA-477: `fresh` refreshes the node it was asked about. When the enrichment moved the node onto
		// another slug (a client mbid naming somebody else's work), whatever lives there is not ours to
		// overwrite: serve it as is.
		if (!opts.fresh || (opts.slug !== undefined && r.slug !== opts.slug)) {
			const existing = await readNode(r.slug);
			if (existing) return { node: existing, ...(requestedSlug ? { requestedSlug } : {}) };
		}
		// TRA-538: a work's mbid is written by the pipeline from its own MusicBrainz resolution (title +
		// credit), and only when that confirms the client's hint. Stamping `body.mbid` here made a
		// client-chosen identity authoritative through `byMbid`. Artists and labels keep the old behavior.
		const enriched =
			body.mbid && !isWorkType(body.type) ? ({ ...r.node, mbid: body.mbid } as NodePayload) : r.node;
		await deps.cache.write(enriched);
		deps.invalidateCacheIndex?.();
		return { node: enriched, ...(requestedSlug ? { requestedSlug } : {}) };
	}

	return { handleMaterialize, runJit };
}
