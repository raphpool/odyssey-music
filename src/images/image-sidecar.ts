/**
 * Persistence for cover art found on demand (Part 3b of docs/plans/graph-integrity.md).
 *
 * Why a sidecar and not the node (decision 3b-D3, validated 2026-10-16): a cover resolved while a
 * visitor browses must survive a server restart, but writing it into `image_url` would turn a
 * request-time lookup into a knowledge-base edit. `cache/` is committed and gated by the node
 * schema; a derived, re-resolvable lookup does not belong there. So this module never touches a
 * node, and `cache/images/` is git-ignored like `cache/youtube/` and `cache/links/`. TRA-489 stays
 * the one path that sets `image_url` on existing nodes.
 *
 * Shape follows `streaming-links.ts`: one JSON file per work, `<type>-<body>.json` in a single
 * folder (one `rm -rf` regenerates everything), hits kept forever, misses expire so a transient
 * upstream outage self-heals. Unlike there, reads are validated: the file is third-party-derived
 * data on disk, so a bad URL host or a malformed entry is deleted and treated as a miss.
 *
 * The key is received, not computed: scoped identity and aliases are the caller's job (3b.4).
 */
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../cache.js";
import { parseSlug } from "../slug.js";
import { IMAGE_SOURCES, type ImageSource, type Slug } from "../types.js";
import { isAllowedImageUrl } from "./hosts.js";

export type ImageSidecarState = "found" | "missing" | "unavailable" | "conflict";

/**
 * Version of the rules that decide whether a work has a cover. Written into every entry; a `missing` or
 * `conflict` verdict (kept 7 days) written under an older version, or under none, is stale and is computed
 * again on the next request. Raise it whenever a change makes the resolvers accept what they used to refuse.
 *
 * 2 (2026-10-18, TRA-612): a double A-side single ("Sine of the Dub / Stalker") and a compilation that holds
 * the artist's own tracks ("Hyperdub 10.3") now get their cover. Without this, the Kode9 page would have kept
 * the old `no-match` of both works for up to 7 days after the deploy, with no way to clear it but a manual
 * action on the server. `found` (definitive) and `unavailable` (1 h) are unaffected.
 *
 * 3 (2026-10-18, TRA-612 follow-up): after the deploy of 2, `project:sine-of-the-dub--kode9` was re-checked and
 * kept `no-match`. A Cover Art Archive that fails (429, 5xx, timeout, network) is no longer recorded as
 * `missing`: it ends as `unavailable` (1 h). The `missing` written under 2, possibly by such a failure, is
 * stale again.
 */
export const IMAGE_RULES_VERSION = 3;

/** Entries written before the version existed are version 1. */
const LEGACY_RULES_VERSION = 1;

export interface ImageSidecarEntry {
	/** `project:<title>--<artist>` | `track:…` | the slug of an existing node. */
	key: Slug;
	state: ImageSidecarState;
	/** `found` only. Re-validated here even though the caller already filtered it. */
	url?: string;
	/** `found` only. */
	source?: ImageSource;
	mbid?: string;
	/** `missing` only. */
	reason?: "ambiguous" | "no-match";
	hint: { title: string; artist: string };
	/** ISO-8601. */
	resolvedAt: string;
	/** {@link IMAGE_RULES_VERSION} at write time. Absent on files written before it existed. */
	rules?: number;
}

const HOUR_MS = 60 * 60 * 1000;
/** Same value as `MISS_TTL_MS` in streaming-links.ts: retry a week-old miss. */
const MISS_TTL_MS = 7 * 24 * HOUR_MS;
/** Short, because "unavailable" means a transient failure (rate limit, timeout), not a verdict. */
const UNAVAILABLE_TTL_MS = HOUR_MS;

function isValidKey(key: string): boolean {
	try {
		parseSlug(key);
		return true;
	} catch {
		return false;
	}
}

const entrySchema = z
	.object({
		key: z.string().refine(isValidKey, { message: "key is not a valid slug" }),
		state: z.enum(["found", "missing", "unavailable", "conflict"]),
		url: z.string().refine(isAllowedImageUrl, { message: "image url host not allowed" }).optional(),
		source: z.enum(IMAGE_SOURCES).optional(),
		mbid: z.string().min(1).optional(),
		reason: z.enum(["ambiguous", "no-match"]).optional(),
		hint: z.object({ title: z.string(), artist: z.string() }),
		resolvedAt: z.string().datetime({ offset: true }),
		rules: z.number().int().min(1).optional(),
	})
	.superRefine((e, ctx) => {
		const found = e.state === "found";
		if (found && (e.url === undefined || e.source === undefined)) {
			ctx.addIssue({ code: "custom", message: "found requires url and source" });
		}
		if (!found && (e.url !== undefined || e.source !== undefined)) {
			ctx.addIssue({ code: "custom", message: "url and source are for found only" });
		}
		if (e.reason !== undefined && e.state !== "missing") {
			ctx.addIssue({ code: "custom", message: "reason is for missing only" });
		}
	});

/**
 * `<cacheDir>/images/<type>-<body>.json`. Both halves are sanitized, not just the body (same
 * reasoning as `sidecarPath` in streaming-links.ts): a key like `track:../../etc` must stay inside
 * the folder. Throws on a malformed slug — a typed `Slug` that is not one is a broken invariant.
 */
export function imageSidecarPath(cacheDir: string, key: Slug): string {
	const { type, body } = parseSlug(key);
	const safe = (s: string): string => s.replace(/[^a-z0-9_-]/gi, "_");
	return join(cacheDir, "images", `${safe(type)}-${safe(body)}.json`);
}

function ttlMs(state: ImageSidecarState): number | null {
	switch (state) {
		case "found":
			return null; // a resolved cover URL is stable
		case "missing":
		case "conflict":
			return MISS_TTL_MS;
		case "unavailable":
			return UNAVAILABLE_TTL_MS;
	}
}

export function isSidecarEntryFresh(entry: ImageSidecarEntry, now: () => number = Date.now): boolean {
	const ttl = ttlMs(entry.state);
	if (ttl === null) return true;
	const at = Date.parse(entry.resolvedAt);
	if (Number.isNaN(at)) return false;
	const age = now() - at;
	// A date in the future (clock skew, hand-edited file) must not pin a miss forever.
	return age >= 0 && age <= ttl;
}

/**
 * False for a refusal (`missing`, `conflict`) made under older rules than the current ones, or under none:
 * it says nothing about what the current rules would answer. Found and unavailable entries are not refusals
 * of a work, and keep their own life.
 */
export function isSidecarEntryCurrent(entry: ImageSidecarEntry): boolean {
	const refusal = entry.state === "missing" || entry.state === "conflict";
	return !refusal || (entry.rules ?? LEGACY_RULES_VERSION) >= IMAGE_RULES_VERSION;
}

/**
 * Delete an invalid file, unless a concurrent atomic write replaced it since we read it: a fresh
 * valid entry must not be lost to a reader that judged the previous content.
 */
async function discardIfUnchanged(file: string, readText: string): Promise<void> {
	const current = await readFile(file, "utf8").catch(() => null);
	if (current === readText) await unlink(file).catch(() => {});
}

/**
 * Entry for `key`, or null when the file is absent, expired, or invalid. An invalid file (bad JSON,
 * schema or host) is deleted so it is not re-parsed on every request. An expired one is left for the
 * next write to overwrite.
 */
export async function readImageSidecar(
	cacheDir: string,
	key: Slug,
	now: () => number = Date.now,
): Promise<ImageSidecarEntry | null> {
	let file: string;
	try {
		file = imageSidecarPath(cacheDir, key);
	} catch {
		return null; // a malformed key is a miss for a reader, never a crash
	}
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return null;
	}
	let parsed: ReturnType<typeof entrySchema.safeParse>;
	try {
		parsed = entrySchema.safeParse(JSON.parse(text));
	} catch {
		await discardIfUnchanged(file, text);
		return null;
	}
	if (!parsed.success) {
		await discardIfUnchanged(file, text);
		return null;
	}
	const entry = parsed.data as ImageSidecarEntry;
	// Two keys can sanitize to the same filename (`a/b` and `a_b`): a valid file that belongs to
	// another key is not ours to serve, nor to delete.
	if (entry.key !== key) return null;
	// A stale refusal is left on disk for the next write to replace, like an expired one.
	return isSidecarEntryFresh(entry, now) && isSidecarEntryCurrent(entry) ? entry : null;
}

/** Validates, creates `cache/images/` if needed, then writes atomically. Throws on an invalid entry. */
export async function writeImageSidecar(cacheDir: string, entry: ImageSidecarEntry): Promise<void> {
	// Every write is made under the current rules; only a file already on disk can carry an older version.
	const data = entrySchema.parse({ ...entry, rules: entry.rules ?? IMAGE_RULES_VERSION });
	const file = imageSidecarPath(cacheDir, entry.key);
	await mkdir(join(cacheDir, "images"), { recursive: true });
	await atomicWriteJson(file, data);
}
