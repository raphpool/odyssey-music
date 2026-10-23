/**
 * Discography edge overrides (TRA-652, absorbing the two retractions of TRA-654; plan docs/plans/graph-integrity.md,
 * part 8b). A CLOSED list of hand decisions about single `artist.discography` edges. Nothing here is computed from
 * the cache: every target is spelled out below, and a run touches those edges and no other.
 *
 * Why a migration. The v6 discography policy (TRA-649, #571) keeps five doubtful entries closed (no mbid posed) and
 * the v6 run on the repo (#572) added two entries that should not exist. Raphael decided on 2026-10-21: "His
 * Greatest Hits and Intolleranza 1960 closed; The Serpent (In Quicksilver), Nixon in China and 206 posed by hand
 * later, through a ticket". Those hand decisions do not belong in `src/discography-policy.ts` (a rule that names
 * three titles is not a rule), and `cache/` is never edited by hand: hence a migration, run by the channel
 * (deploy/sync-genre-cache.sh) on the UNION of the repo and the server, so an entry only prod holds is handled too.
 *
 * POSES (3). Set the MusicBrainz release-group mbid on an edge that has none, and complete `year` / `releaseType`
 * only where the edge lacked them, exactly like the policy's own pose (`poseOnEntry`). `name`, `slug` and every other
 * field stay. Each pose is checked against MusicBrainz BEFORE anything is written: the release group answers to the
 * pinned mbid with the pinned title, type and year, and its FIRST credit is the artist node's own mbid. One request
 * per pose. An edge that already holds the pinned mbid is left alone (the run is idempotent); an edge holding any
 * other mbid is a conflict, never overwritten.
 *
 * RETRACTIONS (2, TRA-654). Remove an edge the v6 backfill ADDED wrongly: Pierre Henry "Variance / Duo" (a release
 * group MusicBrainz announces for 2026-11-20, so it does not exist yet) and Hikaru Utada "Intentions" (its only
 * release is a promo, "60s edit"). The rule "nothing is ever removed" protects the entries the cache came with; these
 * two were appended by the backfill itself, and an additive backfill never comes back to an entry that holds an mbid,
 * so a release date that slips would leave a wrong year for good. Each retraction is re-checked on MusicBrainz
 * (one request each) and only goes ahead while its reason still holds: a release date that has since passed, or a
 * promo that has since been joined by a real release, makes the entry legitimate and the run refuses. An edge that is
 * already gone is `absent`: the target state is reached, no request is made. Only the edge goes: no project node
 * exists for either slug in the repo, and none is deleted here. If the union holds one, or if its
 * `pending-reverses.json` names the slug, the manifest says so (`projectNode` / `pendingReverse: true`) so that
 * nobody discovers a dangling reciprocity later.
 * Ordering for the channel: run this AFTER `2026-10-21-backfill-discography-mbid`, which is what adds both edges. The
 * other way round it finds them absent and the backfill then appends them again. Until the policy stops adding
 * future and promo-only release groups (TRA-654, code part), any new run of that backfill adds them again.
 *
 * KEPT CLOSED (2). `his-greatest-hits` (Fats Domino) and `intolleranza-1960` (Luigi Nono) are declared below so the
 * decision is written down, reported in the manifest (with the mbid they hold, expected: none) and tested. The run
 * never writes them.
 *
 * All or nothing. Every check (cache state, MusicBrainz, schema) is done before the first write. If any item is
 * refused, NOTHING is written (the manifest is, so the refusal is readable: `blocked: true`) and the run exits 1;
 * the channel then refuses before touching the server. The node files are written one by one (each atomically),
 * then the manifest: a write that fails midway exits 1 without a manifest, and a re-run, being idempotent, finishes.
 *
 * Writes. Only `discography` of the artist nodes that change, through `atomicWriteJson` after
 * `nodePayloadSchema.safeParse` and only if the schema alters nothing else (`onlyAddsSchemaDefaults`): no
 * NodeCache.write (it would emit inverse edges), no project node, no `pending-reverses.json`. A list that was in
 * policy order stays in it (the posed edges move to their year); a list that was not keeps every position.
 *
 * Pace. 5 MusicBrainz requests per run (3 poses + 2 retractions; none when everything is already done), plus at
 * most 3 retries for the whole run on a 429 / 503 (so 8 at worst, under 10), one at a time, at least
 * `musicBrainzConfig.minIntervalMs` (1 s) apart, with the User-Agent of src/config.ts and no other header. Any other
 * failed answer is `unavailable`: nothing is written, the next run asks again. This module has its own small
 * client because `mbFetch` is private to src/musicbrainz.ts, which TRA-653 is changing. `fetchImpl` and `today` are
 * injectable so tests stay offline and the future-date check stays deterministic.
 *
 * Manifest (--manifest, default out/discography-edge-overrides.json): no timestamp, no path; the same cache and the
 * same answers give the same bytes in a dry-run and in an apply. It carries the channel's fields as constants
 * (`removed: []`, `renamed: {}`, `redirects: {}`: `removed` lists NODE FILES, and none is deleted); each retracted
 * edge is traced in `edgeRetractions`.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it passes;
 * `--data-dir` is accepted and unused (no redirect table is read or written).
 *
 * Exit codes: 0; 1 when at least one item is refused; 2 on a usage error.
 *
 * Usage: tsx scripts/migrations/2026-10-23-discography-edge-overrides.ts <cache-dir> [--apply]
 *        [--manifest out/discography-edge-overrides.json] [--data-dir <dir>]
 */
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { musicBrainzConfig } from "../../src/config.js";
import { orderDiscography } from "../../src/discography-policy.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug } from "../../src/slug.js";
import type { EdgeRef, Slug } from "../../src/types.js";
import { looksLikeCacheDir } from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-23-discography-edge-overrides";
export const DEFAULT_MANIFEST_PATH = "out/discography-edge-overrides.json";

type ReleaseType = "album" | "ep" | "single";
type Raw = Record<string, unknown>;

export interface PoseOverride {
	artist: Slug;
	edge: Slug;
	/** The edge's name, and the title MusicBrainz must give the release group. */
	title: string;
	/** Full release-group mbid, read from MusicBrainz on 2026-10-23. */
	mbid: string;
	year: string;
	releaseType: ReleaseType;
	why: string;
}

export interface RetractionOverride {
	artist: Slug;
	edge: Slug;
	/** The mbid the edge holds (the backfill added it); a retraction only goes ahead on that very mbid. */
	mbid: string;
	reason: "future-release" | "promotion-only";
	why: string;
}

export interface KeptClosed {
	artist: Slug;
	edge: Slug;
	why: string;
}

export const POSES: readonly PoseOverride[] = [
	{
		artist: "artist:harold-budd",
		edge: "project:the-serpent",
		title: "The Serpent (In Quicksilver)",
		mbid: "bbea6257-57de-4754-a9f0-658166ac02d8",
		year: "1981",
		releaseType: "ep",
		why: "1981 EP, the only EP of this title; the 1989 compilation 'The Serpent (In Quicksilver) / Abandoned Cities' is another release group.",
	},
	{
		artist: "artist:john-adams",
		edge: "project:nixon-in-china",
		title: "Nixon in China",
		mbid: "ab57421b-ec7b-3190-8c98-93e7cc01fe16",
		year: "1988",
		releaseType: "album",
		why: "Nonesuch 1988 recording conducted by de Waart with the premiere cast: the reference recording. The 2009 Live release group (Alsop) and the 1987 compilation are other release groups.",
	},
	{
		artist: "artist:quadrant",
		edge: "project:206",
		title: "206",
		mbid: "a465667c-f288-4f82-874e-0aef036c95f4",
		year: "2015",
		releaseType: "album",
		why: "The only release group of this title, Quadrant credited first (with Kid Hops and Iris, the collaborators named in the node's own bio; Seattle, area code 206). The policy keeps it closed only because it has three credits.",
	},
];

export const RETRACTIONS: readonly RetractionOverride[] = [
	{
		artist: "artist:pierre-henry",
		edge: "project:variance-duo--pierre-henry",
		mbid: "b3189f1d-3d84-4966-acac-d1f4ac7b6e44",
		reason: "future-release",
		why: "MusicBrainz announces the release group for 2026-11-20: it does not exist yet.",
	},
	{
		artist: "artist:hikaru-utada",
		edge: "project:intentions--hikaru-utada",
		mbid: "8cad71b2-f26e-47bd-b74e-e54d023f353a",
		reason: "promotion-only",
		why: "Its only release is a promo ('60s edit').",
	},
];

export const KEPT_CLOSED: readonly KeptClosed[] = [
	{
		artist: "artist:fats-domino",
		edge: "project:his-greatest-hits",
		why: "Decision of 2026-10-21: stays closed.",
	},
	{
		artist: "artist:luigi-nono",
		edge: "project:intolleranza-1960",
		why: "Decision of 2026-10-21: stays closed.",
	},
];

// --- Manifest ---

export type RefusedReason =
	| "artist-missing"
	| "edge-missing"
	| "mbid-conflict"
	| "name-mismatch"
	| "unavailable"
	| "mismatch"
	| "reason-gone"
	| "invalid-node"
	| "would-alter-fields";

export interface PoseEntry {
	artist: Slug;
	edge: Slug;
	mbid: string;
	status: "posed" | "already-posed" | "refused";
	refusal?: RefusedReason;
	/** On a refusal: what was found (the other mbid, the check that failed). */
	detail?: string;
	filled?: ("year" | "releaseType")[];
	/** What MusicBrainz answered (absent when it was not asked). */
	musicBrainz?: { title: string; primaryType: string; firstReleaseDate: string; firstCredit: string };
}

export interface RetractionEntry {
	artist: Slug;
	edge: Slug;
	mbid: string;
	reason: RetractionOverride["reason"];
	status: "removed" | "absent" | "refused";
	refusal?: RefusedReason;
	detail?: string;
	/** The project node file exists in the cache: it is NOT removed here. */
	projectNode?: true;
	/** `pending-reverses.json` names the slug: not touched here either. */
	pendingReverse?: true;
	musicBrainz?: { firstReleaseDate: string; releaseStatuses: Record<string, number> };
}

export interface EdgeOverridesManifest {
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	poses: PoseEntry[];
	edgeRetractions: RetractionEntry[];
	keptClosed: { artist: Slug; edge: Slug; mbid: string | null }[];
	totals: { posed: number; alreadyPosed: number; removed: number; absent: number; refused: number };
	/**
	 * True when at least one item is refused: nothing is written then, and the `posed` / `removed` statuses are
	 * verdicts that were NOT applied. Same bytes in a dry-run and in an apply.
	 */
	blocked: boolean;
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** Injectable for tests; defaults to the global fetch, read at call time. */
	fetchImpl?: typeof fetch;
	/** Calendar day (YYYY-MM-DD, UTC) a "future release" is measured against. */
	today?: string;
	/** Minimum gap between two MusicBrainz requests; defaults to the shared client's. */
	minIntervalMs?: number;
}

export interface RunResult {
	manifest: EdgeOverridesManifest;
	written: number;
	requests: number;
	exitCode: 0 | 1;
}

// --- Helpers ---

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isObject(value: unknown): value is Raw {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sameMbid = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b;

function nodePath(cacheDir: string, slug: Slug): string {
	const { type, body } = parseSlug(slug);
	return join(cacheDir, "nodes", type, `${body}.json`);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** The earliest day a (possibly partial) MusicBrainz date can stand for; null when it is not a date. */
function earliestDay(date: string): string | null {
	const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date);
	return m === null ? null : `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}`;
}

function createPacer(minIntervalMs: number): () => Promise<void> {
	let last = 0;
	return async () => {
		const wait = last + minIntervalMs - Date.now();
		if (last > 0 && wait > 0) await new Promise((done) => setTimeout(done, wait));
		last = Date.now();
	};
}

/**
 * One release-group lookup. The body is third-party data: it is only used after the checks of the caller, and
 * anything but a JSON object (an error status, a timeout, a body that is not an object) is "no answer".
 */
async function lookupReleaseGroup(
	mbid: string,
	inc: "artist-credits" | "releases",
	io: Io,
): Promise<Raw | null> {
	if (!UUID.test(mbid)) return null;
	const url = new URL(`${musicBrainzConfig.baseUrl}/release-group/${mbid}`);
	url.searchParams.set("inc", inc);
	url.searchParams.set("fmt", "json");
	for (;;) {
		await io.pace();
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), musicBrainzConfig.fetchTimeoutMs);
		try {
			const response = await io.fetchImpl(url, {
				headers: { "User-Agent": musicBrainzConfig.userAgent, Accept: "application/json" },
				signal: ctrl.signal,
			});
			if (RETRYABLE_STATUSES.has(response.status) && io.retriesLeft > 0) {
				// 2026-10-23: MusicBrainz answered 503 to a plain lookup while this migration was being written. The
				// channel's preview and apply both ask live, so one throttled answer must not end a run; the retries
				// are few (3 for the whole run) and wait for Retry-After, which keeps the run under 10 requests.
				io.retriesLeft--;
				const wait = retryWaitMs(response.headers.get("Retry-After"), io.minIntervalMs);
				await new Promise((done) => setTimeout(done, wait));
				continue;
			}
			if (!response.ok) return null;
			const body: unknown = await response.json();
			return isObject(body) ? body : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
}

const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 10_000;

/** Retry-After in seconds (a date or anything else is ignored), at least twice the pacing, at most 10 s. */
function retryWaitMs(retryAfter: string | null, minIntervalMs: number): number {
	const seconds = retryAfter !== null && /^\d{1,3}$/.test(retryAfter) ? Number(retryAfter) : 0;
	return Math.min(MAX_RETRY_WAIT_MS, Math.max(2 * minIntervalMs, seconds * 1000));
}

interface Io {
	fetchImpl: typeof fetch;
	/** Waits for the next request slot and counts the request. */
	pace: () => Promise<void>;
	minIntervalMs: number;
	retriesLeft: number;
}

/** Marks an entry refused; `detail` says what was found. */
function refuse(
	entry: { status: string; refusal?: RefusedReason; detail?: string },
	refusal: RefusedReason,
	detail?: string,
): void {
	entry.status = "refused";
	entry.refusal = refusal;
	if (detail !== undefined && detail !== "") entry.detail = detail;
}

async function readTextIfAny(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

/** The first artist credit of a release-group body: `{ mbid, name }`, or null when it has none. */
function firstCredit(body: Raw): { mbid: string; name: string } | null {
	const credits = body["artist-credit"];
	const first = Array.isArray(credits) ? credits[0] : undefined;
	if (!isObject(first) || !isObject(first.artist)) return null;
	const { id, name } = first.artist;
	return typeof id === "string" && typeof name === "string" ? { mbid: id.toLowerCase(), name } : null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

// --- Run ---

interface ArtistFile {
	path: string;
	raw: Raw;
	edges: Raw[];
}

async function readArtist(cacheDir: string, slug: Slug): Promise<ArtistFile | null> {
	const path = nodePath(cacheDir, slug);
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
	if (!isObject(raw) || !Array.isArray(raw.discography) || !raw.discography.every(isObject)) return null;
	return { path, raw, edges: raw.discography as Raw[] };
}

export async function runEdgeOverrides(options: RunOptions): Promise<RunResult> {
	const { cacheDir, apply } = options;
	const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
	const today = options.today ?? new Date().toISOString().slice(0, 10);
	let asked = 0;
	const minIntervalMs = options.minIntervalMs ?? musicBrainzConfig.minIntervalMs;
	const pace = createPacer(minIntervalMs);
	const io: Io = {
		fetchImpl: options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
		pace: () => {
			asked++;
			return pace();
		},
		minIntervalMs,
		retriesLeft: MAX_RETRIES,
	};
	const pendingReverses = await readTextIfAny(join(cacheDir, "pending-reverses.json"));

	const artists = new Map<Slug, ArtistFile | null>();
	for (const slug of new Set([...POSES, ...RETRACTIONS, ...KEPT_CLOSED].map((o) => o.artist))) {
		artists.set(slug, await readArtist(cacheDir, slug));
	}
	const edgeOf = (artist: Slug, edge: Slug): Raw | undefined =>
		artists.get(artist)?.edges.find((e) => e.slug === edge);

	// 1. Poses: the cache first, then MusicBrainz for the ones still to do.
	const poses: PoseEntry[] = [];
	const toPose: { entry: PoseEntry; override: PoseOverride }[] = [];
	for (const o of POSES) {
		const entry: PoseEntry = { artist: o.artist, edge: o.edge, mbid: o.mbid, status: "refused" };
		poses.push(entry);
		const file = artists.get(o.artist);
		const edge = edgeOf(o.artist, o.edge);
		if (!file) refuse(entry, "artist-missing");
		else if (!edge) refuse(entry, "edge-missing");
		else if (sameMbid(edge.mbid, o.mbid)) entry.status = "already-posed";
		else if (edge.mbid !== undefined && edge.mbid !== "") refuse(entry, "mbid-conflict", str(edge.mbid));
		else if (edge.name !== o.title) refuse(entry, "name-mismatch", str(edge.name));
		else toPose.push({ entry, override: o });
	}
	for (const { entry, override: o } of toPose) {
		const body = await lookupReleaseGroup(o.mbid, "artist-credits", io);
		if (body === null) {
			refuse(entry, "unavailable");
			continue;
		}
		const credit = firstCredit(body);
		const primaryType = str(body["primary-type"]);
		const firstReleaseDate = str(body["first-release-date"]);
		entry.musicBrainz = {
			title: str(body.title),
			primaryType,
			firstReleaseDate,
			firstCredit: credit === null ? "" : `${credit.mbid} ${credit.name}`,
		};
		const nodeMbid = str(artists.get(o.artist)?.raw.mbid).toLowerCase();
		const failed =
			str(body.id).toLowerCase() !== o.mbid
				? "id"
				: body.title !== o.title
					? "title"
					: primaryType.toLowerCase() !== o.releaseType
						? "primary-type"
						: firstReleaseDate.slice(0, 4) !== o.year
							? "year"
							: credit === null || nodeMbid === "" || credit.mbid !== nodeMbid
								? "first-credit"
								: null;
		if (failed !== null) refuse(entry, "mismatch", failed);
		else entry.status = "posed";
	}

	// 2. Retractions: the same, for the edges that are still there.
	const retractions: RetractionEntry[] = [];
	const toRemove: RetractionEntry[] = [];
	for (const o of RETRACTIONS) {
		const entry: RetractionEntry = {
			artist: o.artist,
			edge: o.edge,
			mbid: o.mbid,
			reason: o.reason,
			status: "refused",
		};
		retractions.push(entry);
		const file = artists.get(o.artist);
		const edge = edgeOf(o.artist, o.edge);
		if (await exists(nodePath(cacheDir, o.edge))) entry.projectNode = true;
		if (pendingReverses.includes(`"${o.edge}"`)) entry.pendingReverse = true;
		if (!file) refuse(entry, "artist-missing");
		else if (!edge) entry.status = "absent";
		// An edge without the mbid the backfill gave it is not the one that was checked: left alone.
		else if (!sameMbid(edge.mbid, o.mbid)) refuse(entry, "mbid-conflict", str(edge.mbid) || "(none)");
		else toRemove.push(entry);
	}
	for (const entry of toRemove) {
		const body = await lookupReleaseGroup(entry.mbid, "releases", io);
		if (body === null) {
			refuse(entry, "unavailable");
			continue;
		}
		const firstReleaseDate = str(body["first-release-date"]);
		const releases = Array.isArray(body.releases) ? body.releases.filter(isObject) : [];
		const releaseStatuses: Record<string, number> = {};
		for (const release of releases) {
			const status = str(release.status) || "(none)";
			releaseStatuses[status] = (releaseStatuses[status] ?? 0) + 1;
		}
		entry.musicBrainz = { firstReleaseDate, releaseStatuses: sortedKeys(releaseStatuses) };
		const day = earliestDay(firstReleaseDate);
		const holds =
			entry.reason === "future-release"
				? day !== null && day > today
				: releases.length > 0 && releases.every((r) => r.status === "Promotion");
		if (str(body.id).toLowerCase() !== entry.mbid) refuse(entry, "mismatch", "id");
		else if (!holds) refuse(entry, "reason-gone");
		else entry.status = "removed";
	}

	// 3. Build every node to write; a node the schema would alter beyond its own defaults refuses the run.
	const pending: { path: string; next: Raw }[] = [];
	if (poses.every((p) => p.status !== "refused") && retractions.every((r) => r.status !== "refused")) {
		for (const [slug, file] of artists) {
			if (!file) continue;
			let edges = file.edges;
			let changed = false;
			for (const o of POSES) {
				const pose = poses.find((p) => p.edge === o.edge && p.artist === slug);
				if (pose?.status !== "posed") continue;
				const filled: ("year" | "releaseType")[] = [];
				edges = edges.map((edge) => {
					if (edge.slug !== o.edge) return edge;
					const next: Raw = { ...edge, mbid: o.mbid };
					if (edge.year === undefined || edge.year === "") {
						next.year = o.year;
						filled.push("year");
					}
					if (edge.releaseType === undefined) {
						next.releaseType = o.releaseType;
						filled.push("releaseType");
					}
					return next;
				});
				pose.filled = filled;
				changed = true;
			}
			for (const o of RETRACTIONS) {
				const entry = retractions.find((r) => r.edge === o.edge && r.artist === slug);
				if (entry?.status !== "removed") continue;
				edges = edges.filter((edge) => edge.slug !== o.edge);
				changed = true;
			}
			if (!changed) continue;
			// A list already in policy order stays in it; any other keeps every position.
			const inOrder = sameOrder(orderDiscography(file.edges as unknown as EdgeRef[]), file.edges);
			const ordered = inOrder ? (orderDiscography(edges as unknown as EdgeRef[]) as unknown as Raw[]) : edges;
			const next: Raw = { ...file.raw, discography: ordered };
			const valid = nodePayloadSchema.safeParse(next);
			if (!valid.success || !onlyAddsSchemaDefaults(next, valid.data)) {
				const reason: RefusedReason = valid.success ? "would-alter-fields" : "invalid-node";
				for (const p of poses) if (p.artist === slug && p.status === "posed") refuse(p, reason);
				for (const r of retractions) if (r.artist === slug && r.status === "removed") refuse(r, reason);
				continue;
			}
			pending.push({ path: file.path, next });
		}
	}

	const refusedTotal = [...poses, ...retractions].filter((e) => e.status === "refused").length;
	const manifest: EdgeOverridesManifest = {
		migration: MIGRATION_NAME,
		removed: [],
		renamed: {},
		redirects: {},
		poses,
		edgeRetractions: retractions,
		keptClosed: KEPT_CLOSED.map((k) => {
			const mbid = edgeOf(k.artist, k.edge)?.mbid;
			return { artist: k.artist, edge: k.edge, mbid: typeof mbid === "string" && mbid !== "" ? mbid : null };
		}),
		totals: {
			posed: poses.filter((p) => p.status === "posed").length,
			alreadyPosed: poses.filter((p) => p.status === "already-posed").length,
			removed: retractions.filter((r) => r.status === "removed").length,
			absent: retractions.filter((r) => r.status === "absent").length,
			refused: refusedTotal,
		},
		blocked: refusedTotal > 0,
	};

	// A refusal found while building nodes can leave `pending` incomplete: nothing is written in that case.
	// The nodes go first and the manifest last, so a write that fails never leaves a manifest claiming success.
	let written = 0;
	if (apply && !manifest.blocked) {
		for (const { path, next } of pending) {
			await atomicWriteJson(path, next);
			written++;
		}
	}
	await mkdir(dirname(manifestPath), { recursive: true });
	await atomicWriteJson(manifestPath, manifest);
	return { manifest, written, requests: asked, exitCode: manifest.blocked ? 1 : 0 };
}

function sortedKeys(counts: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sameOrder(a: readonly unknown[], b: readonly Raw[]): boolean {
	return (
		a.length === b.length &&
		a.every((edge, i) => edge === b[i] || (isObject(edge) && edge.slug === b[i]?.slug))
	);
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	dataDir: string | undefined;
}

/** `<cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]`; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let manifestPath: string | undefined;
	let dataDir: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--data-dir" && dataDir === undefined)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else dataDir = value;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH, dataDir };
}

export function formatSummary(result: RunResult, apply: boolean, manifestPath: string): string {
	const { totals } = result.manifest;
	const lines = [
		`${MIGRATION_NAME} (${apply ? "apply" : "dry-run"}): ${totals.posed} to pose, ${totals.alreadyPosed} already posed, ${totals.removed} to retract, ${totals.absent} already absent, ${totals.refused} refused`,
		`${result.requests} MusicBrainz request(s); ${result.written} node file(s) written; manifest: ${manifestPath}`,
	];
	const why = (e: { refusal?: RefusedReason; detail?: string }): string =>
		e.refusal ? ` (${e.refusal}${e.detail ? `: ${e.detail}` : ""})` : "";
	for (const p of result.manifest.poses) lines.push(`  pose ${p.artist} ${p.edge}: ${p.status}${why(p)}`);
	for (const r of result.manifest.edgeRetractions) {
		lines.push(`  retract ${r.artist} ${r.edge}: ${r.status}${why(r)}`);
	}
	if (result.manifest.blocked) lines.push("REFUSED: nothing was written.");
	return lines.join("\n");
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-23-discography-edge-overrides.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runEdgeOverrides({
		cacheDir: args.cacheDir,
		apply: args.apply,
		manifestPath: args.manifestPath,
	});
	console.log(formatSummary(result, args.apply, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
