/**
 * Wikidata / Wikimedia Commons image lookups for the image resolver (TRA-465).
 *
 * Everything that comes back from Wikidata is third-party, user-editable data: each response is
 * schema-checked, malformed pieces are dropped (never thrown), and the only URL built from it is
 * the Commons `Special:FilePath` one in {@link commonsFileUrl}, whose host is fixed by us.
 *
 *   artist: MusicBrainz url-rels → QID → P18 (image)
 *   label : MusicBrainz url-rels or `wbsearchentities` → QID → P154 (logo image), then P18
 */
import { z } from "zod";
import { musicBrainzConfig } from "../config.js";
import { fetchWikidataUrlRelMb, type MbPriority } from "../musicbrainz.js";
import { QID_PATTERN } from "../types.js";

const API_URL = "https://www.wikidata.org/w/api.php";
const REQUEST_TIMEOUT_MS = 5000;
const COMMONS_FILE_PATH = "https://commons.wikimedia.org/wiki/Special:FilePath";
const RECORD_LABEL_QID = "Q18127";
const SEARCH_LIMIT = 5;
const MAX_FILENAME_LENGTH = 240;

/**
 * Politeness spacing between Wikidata requests (no documented limit, but bulk backfills should not
 * hammer it). Mutable like `musicBrainzConfig` so tests can set 0; read at call time.
 */
export const wikidataConfig = { minIntervalMs: 200 };

let lastSlotAt = 0;

function reserveSlotDelayMs(): number {
	const interval = wikidataConfig.minIntervalMs;
	if (interval <= 0) return 0;
	const now = Date.now();
	const at = Math.max(now, lastSlotAt + interval);
	lastSlotAt = at;
	return at - now;
}

async function wikidataGet(params: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
	const url = new URL(API_URL);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	url.searchParams.set("format", "json");
	const delay = reserveSlotDelayMs();
	if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const r = await fetchImpl(url.toString(), {
			headers: { "User-Agent": musicBrainzConfig.userAgent, Accept: "application/json" },
			signal: controller.signal,
		});
		if (!r.ok) return null;
		return (await r.json()) as unknown;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

const claimSchema = z.object({
	rank: z.enum(["preferred", "normal", "deprecated"]).optional(),
	mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }),
});
const entitiesResponseSchema = z.object({
	entities: z.record(z.string(), z.object({ claims: z.record(z.string(), z.array(z.unknown())).optional() })),
});
const searchResponseSchema = z.object({ search: z.array(z.unknown()) });
const searchHitSchema = z.object({ id: z.string().regex(QID_PATTERN), label: z.string().optional() });
const entityIdValueSchema = z.object({ id: z.string() });

type ClaimsByProperty = Record<string, unknown[]>;

/** Values of one property: preferred rank first, deprecated claims and "no value" snaks dropped. */
function claimValues(claims: ClaimsByProperty, property: string): unknown[] {
	const out: Array<{ value: unknown; preferred: boolean }> = [];
	for (const raw of claims[property] ?? []) {
		const claim = claimSchema.safeParse(raw);
		if (!claim.success || claim.data.rank === "deprecated") continue;
		const datavalue = claim.data.mainsnak.datavalue;
		if (!datavalue) continue;
		out.push({ value: datavalue.value, preferred: claim.data.rank === "preferred" });
	}
	return [...out.filter((v) => v.preferred), ...out.filter((v) => !v.preferred)].map((v) => v.value);
}

function stringValues(claims: ClaimsByProperty, property: string): string[] {
	return claimValues(claims, property).filter((v): v is string => typeof v === "string");
}

/** A Commons file name: a plain title, never a path or something with control characters. */
function isPlausibleCommonsFilename(value: string): boolean {
	if (value.trim() !== value || value.length === 0 || value.length > MAX_FILENAME_LENGTH) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
	return !/[/\\\u0000-\u001f\u007f]/.test(value);
}

/** Claims of the requested entities, keyed by QID; entities that fail the schema are absent. */
async function fetchClaims(qids: string[], fetchImpl: typeof fetch): Promise<Map<string, ClaimsByProperty>> {
	const out = new Map<string, ClaimsByProperty>();
	if (qids.length === 0 || !qids.every((q) => QID_PATTERN.test(q))) return out;
	const body = await wikidataGet(
		{ action: "wbgetentities", ids: qids.join("|"), props: "claims" },
		fetchImpl,
	);
	const parsed = entitiesResponseSchema.safeParse(body);
	if (!parsed.success) return out;
	const entries = Object.entries(parsed.data.entities);
	for (const [id, entity] of entries) out.set(id, entity.claims ?? {});
	// A merged QID is answered under the surviving id: with a single request, take the single entity.
	const only = entries[0];
	if (qids.length === 1 && entries.length === 1 && only && qids[0] !== undefined && !out.has(qids[0])) {
		out.set(qids[0], only[1].claims ?? {});
	}
	return out;
}

/**
 * Wikidata QID of an artist or label, from its MusicBrainz url-rels. Any failure is a null QID.
 * `options.priority` is the MusicBrainz queue priority of the lookup (TRA-579, TRA-588).
 */
export async function fetchWikidataQid(
	entity: "artist" | "label",
	mbid: string,
	fetchImpl?: typeof fetch,
	options: { priority?: MbPriority } = {},
): Promise<string | null> {
	try {
		return await fetchWikidataUrlRelMb(entity, mbid, fetchImpl, options);
	} catch {
		return null;
	}
}

/** Commons file names of an entity's image (P18) and logo image (P154), when it has valid ones. */
export async function fetchWikidataImages(
	qid: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ p18?: string; p154?: string }> {
	const result: { p18?: string; p154?: string } = {};
	const claims = (await fetchClaims([qid], fetchImpl)).get(qid);
	if (!claims) return result;
	const p18 = stringValues(claims, "P18").find(isPlausibleCommonsFilename);
	if (p18) result.p18 = p18;
	const p154 = stringValues(claims, "P154").find(isPlausibleCommonsFilename);
	if (p154) result.p154 = p154;
	return result;
}

function normalizeLabelName(s: string): string {
	return s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Find a record label's QID by name. Looks at the top 5 `wbsearchentities` hits and keeps, in order:
 * the one whose P966 (MusicBrainz label ID) equals the known `labelMbid`; otherwise the first one
 * that is an instance of record label (P31 = Q18127) with exactly the same label — and, when the
 * MBID is known, no P966 pointing at a different label. Null when nothing qualifies.
 */
export async function searchWikidataLabel(
	name: string,
	labelMbid?: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	if (!name.trim()) return null;
	const search = searchResponseSchema.safeParse(
		await wikidataGet(
			{
				action: "wbsearchentities",
				search: name,
				language: "en",
				uselang: "en",
				type: "item",
				limit: String(SEARCH_LIMIT),
			},
			fetchImpl,
		),
	);
	if (!search.success) return null;
	const hits: Array<{ id: string; label?: string | undefined }> = [];
	for (const raw of search.data.search.slice(0, SEARCH_LIMIT)) {
		const hit = searchHitSchema.safeParse(raw);
		if (hit.success) hits.push(hit.data);
	}
	if (hits.length === 0) return null;

	const claimsById = await fetchClaims(
		hits.map((h) => h.id),
		fetchImpl,
	);
	const wantedMbid = labelMbid?.toLowerCase();
	const mbidsOf = (id: string): string[] =>
		stringValues(claimsById.get(id) ?? {}, "P966").map((v) => v.toLowerCase());

	if (wantedMbid) {
		const byMbid = hits.find((h) => mbidsOf(h.id).includes(wantedMbid));
		if (byMbid) return byMbid.id;
	}
	const wantedName = normalizeLabelName(name);
	for (const hit of hits) {
		const claims = claimsById.get(hit.id);
		if (!claims || hit.label === undefined || normalizeLabelName(hit.label) !== wantedName) continue;
		const isRecordLabel = claimValues(claims, "P31").some(
			(v) => entityIdValueSchema.safeParse(v).data?.id === RECORD_LABEL_QID,
		);
		if (!isRecordLabel) continue;
		const mbids = mbidsOf(hit.id);
		if (wantedMbid && mbids.length > 0) continue; // it is a different, known MusicBrainz label
		return hit.id;
	}
	return null;
}

/**
 * Commons URL that redirects (301) to a `width`-px rendition of a file named as in Wikidata P18 /
 * P154 (spaces, not underscores). The file name is percent-encoded as a single path segment.
 */
export function commonsFileUrl(filename: string, width = 600): string {
	const w = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 600;
	return `${COMMONS_FILE_PATH}/${encodeURIComponent(filename)}?width=${w}`;
}
