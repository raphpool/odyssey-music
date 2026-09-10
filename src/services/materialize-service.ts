import type { NodeCache } from "../cache.js";
import { pipelineConfig } from "../config.js";
import type { ApiEnv } from "../env.js";
import { BadRequestError, isNotFoundError } from "../errors.js";
import type { GenreRegistry } from "../genre-registry.js";
import { runPipeline } from "../pipeline.js";
import { makeSlug, parseSlug } from "../slug.js";
import type { NodePayload, NodeType, Slug } from "../types.js";
import { NODE_TYPES, QID_PATTERN } from "../types.js";

export interface MaterializeRequest {
	type?: string;
	name?: string;
	disambiguator?: string;
	mbid?: string;
	// 2026-09-10 (TRA-43): identity carried by the EDGE that produced this request (front chip's
	// dataset, crawler frontier), not re-derived from `name` -- see the validation block in
	// handleMaterialize below and docs/plans/qid-genre-identity.md, decision d'archi 8/9.
	slug?: string;
	qid?: string;
}

// Matches exactly what makeSlug (src/slug.ts normalizeSlugBody) can produce: one or more
// dash-joined lowercase alphanumeric segments, optionally followed by a `--`-separated
// disambiguator segment of the same shape. parseSlug alone doesn't enforce this -- it only
// checks for a colon and a known type -- so "genre:../x" would otherwise parse "successfully"
// with body "../x". Rejecting anything but this exact shape is what keeps a client-supplied
// slug from ever reaching a cache path (NodeCache resolves slugs straight to disk paths).
const SLUG_BODY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

// 2026-09-10 (TRA-43 review round 1, nit): an unbounded slug reaches NodeCache's fs calls
// straight from the request body -- a multi-KB value passed SLUG_BODY_PATTERN (which has no
// length limit of its own) would surface as a raw ENOENT/ENAMETOOLONG 500 instead of a clean 400.
// 200 is generous next to any real makeSlug output (longest committed slug body is well under 100).
const MAX_SLUG_LENGTH = 200;

/**
 * Validates a client-supplied slug before any I/O (TRA-43): bounded length, must parse
 * (parseSlug), name the same type as the rest of the request, and match SLUG_BODY_PATTERN.
 * Throws BadRequestError (never a bare Error) -- src/server.ts maps that to a 400.
 */
function validateRequestSlug(rawSlug: string, type: string): Slug {
	if (rawSlug.length > MAX_SLUG_LENGTH) {
		throw new BadRequestError(`Invalid slug: too long (max ${MAX_SLUG_LENGTH} chars)`);
	}
	let parsed: { type: NodeType; body: string };
	try {
		parsed = parseSlug(rawSlug);
	} catch {
		throw new BadRequestError(`Invalid slug: ${rawSlug}`);
	}
	if (parsed.type !== type || !SLUG_BODY_PATTERN.test(parsed.body)) {
		throw new BadRequestError(`Invalid slug: ${rawSlug}`);
	}
	return rawSlug as Slug;
}

/**
 * SECURITY (TRA-43 review round 1, 2026-09-10): a refresh of an existing/canonical node must use
 * THAT NODE'S OWN identity, never the client's -- repro that forced this: a stale `genre:techno`
 * (nodeTtlMs is 12h, so most committed nodes are "stale") plus `{name: "Attacker Controlled
 * Topic", slug: "genre:techno"}` used to pin `slug` straight from the client body while keeping
 * the client's own `name`, so a public, unauthenticated POST /materialize could rewrite any
 * cache/<slug>.json with attacker-chosen LLM-generated content. A differing client `mbid` must
 * likewise never survive onto `effectiveBody`: it would otherwise force the `mbidMismatch` check
 * below to treat an already-correct, freshly-served node as needing a refresh.
 */
function refreshIdentityFrom(node: NodePayload): MaterializeRequest {
	const out: MaterializeRequest = { type: node.type, name: node.name };
	const mbid = (node as unknown as { mbid?: string }).mbid;
	if (mbid) out.mbid = mbid;
	return out;
}

export interface MaterializeResponse {
	// The reference value for the client is `node.slug`, not `makeSlug(body)` on the original
	// request: the genre canonicalization guard in handleMaterialize can rewrite a request onto
	// an existing canonical node, so the returned node's own slug may differ from what the
	// caller's {type, name} would hash to.
	node: NodePayload;
	source: "cache" | "jit";
	wallMs: number;
	metricsCostUsd?: number;
}

export function createMaterializeService(deps: {
	cache: NodeCache;
	env: ApiEnv;
	genreRegistry: GenreRegistry;
}) {
	const inflight = new Map<string, Promise<NodePayload>>();

	async function handleMaterialize(
		body: MaterializeRequest,
		opts: { fresh?: boolean } = {},
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
		const t0 = Date.now();
		const fresh = opts.fresh === true;
		let effectiveBody = body;
		// 2026-09-10 (TRA-43 security fix, review round 1): the eventual MINT slug is always
		// name-derived, exactly as on main before this ticket. `requestSlug` below is a LOOKUP key
		// for an existing/canonical node, never a write target on its own -- see refreshIdentityFrom
		// above for why (an unresolved `requestSlug` must never become a mint target with the
		// client's own name/mbid attached).
		let slug = makeSlug(body.type as NodePayload["type"], body.name, body.disambiguator);
		// Set whenever `slug` above is known to already name the exact target this call is about
		// to serve or refresh: a caller-supplied slug that hit a real node (TRA-43 phase 1 below),
		// a canonical rewrite, or the cache lookup further down finding it (whether or not `fresh`
		// was requested) -- never on a genuinely fresh, name-derived mint with no identity of its
		// own. Passed through to runPipeline as PipelineInput.slug so canonicalizeDraft
		// (pipeline.ts) keeps that exact slug instead of re-deriving one from whatever name the LLM
		// draft happens to use, which can legitimately differ from the node's own persisted name
		// (2026-09-10, review round 2 / TRA-30 review: 62 real cache nodes already have
		// makeSlug(name) !== slug). A fresh mint with no resolved identity keeps deriving its own
		// slug from the draft, same as before this ticket.
		let pinnedSlug: Slug | undefined;
		let cached: NodePayload | null = null;

		// Phase 1 (TRA-43): does the caller's OWN slug already name a real node? If so, that node's
		// own identity (refreshIdentityFrom) drives everything below, never the client's -- this is
		// the direct analog of GenreRegistry's rule 2 ("a ref pointing at an existing node never
		// moves"), applied up front for every node type, not just genre.
		if (requestSlug) {
			const existing = await deps.cache.get(requestSlug).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
			if (existing) {
				effectiveBody = refreshIdentityFrom(existing);
				slug = requestSlug;
				pinnedSlug = requestSlug;
				cached = existing;
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
		// 2026-09-10 (TRA-43 review round 1): skipped when phase 1 above already resolved a node.
		// Reference `requestSlug` for the redirect/qid lookups below when the caller gave one --
		// their own identity anchor, possibly a merged loser slug or a brand-new one -- else the
		// plain name-derived `slug`, exactly as before this ticket. `requestSlug`'s own
		// non-existence was already established in phase 1, so only the no-`requestSlug` case needs
		// its own has() check here.
		if (!cached && body.type === "genre" && !body.disambiguator) {
			const guardSlug = requestSlug ?? slug;
			const guardApplies = requestSlug !== undefined || !(await deps.cache.has(guardSlug));
			if (guardApplies) {
				// 2026-09-10 (TRA-43): forward the request's own qid/mbid so the registry's rule 4
				// (an existing node for this qid wins, qid autoritaire) can fire even for a request
				// whose own slug hashes to a brand new, never-before-seen target -- e.g. two MB tags
				// sharing a QID materialized by name, one after the other
				// (test/genre-dedup-postmerge.test.ts scenario 6).
				const canonicalRef: { slug: Slug; name: string; qid?: string; mbid?: string } = {
					slug: guardSlug,
					name: body.name,
				};
				if (body.qid) canonicalRef.qid = body.qid;
				if (body.mbid) canonicalRef.mbid = body.mbid;
				const canonical = await deps.genreRegistry.canonicalSlugFor(canonicalRef);
				if (canonical.slug !== guardSlug) {
					// Single read, not has()+get(): the registry can name a slug that isn't actually
					// on disk (e.g. a fresh deployment with a pruned cache) -- ENOENT there means
					// "nothing to serve", so fall through and mint under the name-derived slug, same
					// as if canonicalSlugFor had returned it unchanged. Any other read failure still
					// throws.
					const canonicalNode = await deps.cache.get(canonical.slug).catch((e: unknown) => {
						if (isNotFoundError(e)) return null;
						throw e;
					});
					if (canonicalNode) {
						effectiveBody = refreshIdentityFrom(canonicalNode);
						slug = canonical.slug;
						pinnedSlug = canonical.slug;
						cached = canonicalNode;
					}
				}
				// canonical.slug === guardSlug (rule 5, "nothing to canonicalize"): `slug` stays
				// name-derived and `pinnedSlug` stays unset -- an unresolved `requestSlug` is never
				// pinned as a mint target on its own (the security fix above).
			}
		}

		// 2026-09-10 (review round 2, nit): read once regardless of `fresh` -- opts.fresh === true
		// (?fresh=1, server.ts) used to skip this whole block, so a request for an ALREADY-cached
		// slug with fresh:true never set pinnedSlug: the loser name was protected by the guard
		// above, but the canonical name wasn't, once fresh:true was in play. A node found here is
		// always the one this call is about to refresh, fresh or not. Skipped when phase 1/2 above
		// already resolved `cached` -- no need to re-read the same file.
		if (!cached) {
			cached = await deps.cache.get(slug).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
		}
		if (cached) pinnedSlug = slug;
		let effectiveFresh = fresh;
		if (!fresh && cached) {
			const matAt = new Date(cached.materialized_at).getTime();
			const stale = Number.isFinite(matAt) && Date.now() - matAt > pipelineConfig.nodeTtlMs;
			const cachedMbid = (cached as unknown as { mbid?: string }).mbid;
			const mbidMismatch = !!effectiveBody.mbid && cachedMbid !== effectiveBody.mbid;
			if (!stale && !mbidMismatch) {
				return { node: cached, source: "cache", wallMs: Date.now() - t0 };
			}
			effectiveFresh = true;
		}
		const key = `${slug}|${effectiveBody.disambiguator ?? ""}|fresh=${effectiveFresh}`;
		const existing = inflight.get(key);
		if (existing) {
			const node = await existing;
			return { node, source: "jit", wallMs: Date.now() - t0 };
		}
		const jitOpts: { fresh?: boolean; slug?: Slug } = { fresh: effectiveFresh };
		if (pinnedSlug) jitOpts.slug = pinnedSlug;
		const p = runJit(effectiveBody, jitOpts);
		inflight.set(key, p);
		try {
			const node = await p;
			const out: MaterializeResponse = { node, source: "jit", wallMs: Date.now() - t0 };
			const m = (node as unknown as { _metrics?: { cost_usd: number } })._metrics;
			if (m) out.metricsCostUsd = m.cost_usd;
			return out;
		} finally {
			inflight.delete(key);
		}
	}

	async function runJit(
		body: MaterializeRequest,
		opts: { fresh?: boolean; slug?: Slug } = {},
	): Promise<NodePayload> {
		if (!body.type || !body.name) {
			throw new BadRequestError("Pipeline JIT requires both 'type' and 'name'.");
		}
		const pipelineInput: {
			type: NodeType;
			name: string;
			disambiguator?: string;
			mbid?: string;
			slug?: Slug;
			qid?: string;
		} = {
			type: body.type as NodeType,
			name: body.name,
		};
		if (body.disambiguator) pipelineInput.disambiguator = body.disambiguator;
		if (body.mbid) pipelineInput.mbid = body.mbid;
		// TRA-30 (node-service, PR #31) will pass its own opts.slug after this ticket merges --
		// keep this shape stable (see the pinnedSlug comment in handleMaterialize above).
		if (opts.slug) pipelineInput.slug = opts.slug;
		// 2026-09-10 (TRA-43): the edge's own qid, carried through as an identity hint --
		// enrichFromMusicBrainz's genre block gives it precedence over a fresh by-name resolve.
		if (body.qid) pipelineInput.qid = body.qid;
		const r = await runPipeline(pipelineInput, {
			tavilyApiKey: deps.env.TAVILY_API_KEY,
			firecrawlApiKey: deps.env.FIRECRAWL_API_KEY,
			genreRegistry: deps.genreRegistry,
		});
		if (!opts.fresh) {
			const existing = await deps.cache.get(r.slug).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
			if (existing) return existing;
		}
		const enriched = body.mbid ? ({ ...r.node, mbid: body.mbid } as NodePayload) : r.node;
		await deps.cache.write(enriched);
		return enriched;
	}

	return { handleMaterialize, runJit };
}
