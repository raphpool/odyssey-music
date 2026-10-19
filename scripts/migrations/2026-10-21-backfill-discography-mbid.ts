/**
 * Discography backfill (TRA-618, plan docs/plans/graph-integrity.md, part 8, decisions 8-D3 / 8-D4 / 8-D7):
 * give the discography of every artist with an MBID the release groups MusicBrainz knows for it. For each
 * artist: read its release groups (`fetchArtistDiscographyMb`, TRA-614), keep the ones the policy of TRA-613
 * allows, and let `mergeDiscography` (TRA-617) pose the MBID of the entries that lack one and append the
 * missing works. Nothing is ever removed, renamed or reordered except by the merge's own re-sort, and only
 * when the list changed. No LLM.
 *
 * What is written. Only `discography` of an artist node, as a list of edges (8-D4): no project node is
 * created, no inverse edge is emitted, `cache/nodes/project/` and `pending-reverses.json` are never touched.
 * Hence no NodeCache.write (it would emit the inverses) and no NodeCache.get (it strips undeclared fields):
 * nodes are read raw by `readCacheNodes` and written by `atomicWriteJson` after `nodePayloadSchema.safeParse`,
 * and only if the schema would alter nothing else (`onlyAddsSchemaDefaults`). A node the merge leaves intact
 * is not rewritten (same bytes, same mtime). Dry-run by default: without --apply no node file is written.
 *
 * Artists skipped, with the reason kept in the manifest: `no-mbid`; `excluded` (listed in
 * `identity-exclusions.json`, read from --data-dir, else the repo's data/: a refused or unreadable list
 * stops the run); `cap` (already at the cap and every entry has its mbid: nothing to pose or add, no request);
 * `unavailable` (MusicBrainz did not answer for at least one page: an empty or short list is not "nothing on
 * MusicBrainz", nothing is written, the next run retries it); `name-mismatch` (identity guard without any
 * further request: no release group first-credited to the MBID carries the node's name, nor, for a group,
 * does any of its credits; the stored MBID may belong to someone else). An artist whose MBID answers with no
 * release group credited to it has nothing to compare and nothing to merge: it is processed, unchanged.
 * `refused` is separate: a node that does not validate against the schema (before or after the merge), or a
 * file that cannot be read. It is counted, never rewritten, and makes the run exit 1, like `unavailable`.
 *
 * SLUG FORM (2026-10-19, found while writing this migration). The channel runs the migrations with
 * ODYSSEY_SCOPED_RELEASE_SLUGS=0 (deploy/sync-genre-cache.sh, only the scope step gets 1), but the cache and
 * the server are in the flag-on form since TRA-509 (`artist:hildur-gudnadottir`, not `-gu-nadottir`): an edge
 * minted here with the flag off would carry a slug no node answers to for every title or artist with an
 * o-slash, ae, sharp s or dotless i. The flag is therefore pinned on for the duration of the run (restored
 * afterwards), like `canonicalArtistSlug` does for artist slugs in the similar-artists backfill.
 *
 * Pace: ONE MusicBrainz request at a time, at the pace `mbFetch` enforces (1 request per second, shared
 * queue, `background` priority). `fetchArtistDiscographyMb` starts its three types together; the queue spaces
 * them and the fetch handed to it is serialized here, so two requests are never in flight. Known trade-off:
 * the client arms its abort timer before the fetch is called, so a request held behind a slow one (more than
 * a second late) spends part of its timeout waiting. In a degraded MusicBrainz that turns into `unavailable`
 * (nothing written, retried by the next run), never into a wrong write. `runBackfill` patches two process-wide
 * globals while it runs, so it is not re-entrant. About two thousand
 * requests for the repository. No header is added to the client's own (its User-Agent comes from config).
 *
 * Manifest (--manifest, default out/discography-mbid.json): deterministic, sorted by slug, no timestamp, no
 * path, no mode: the same cache and the same answers give the same bytes in a dry-run, in an apply and in a
 * re-run. `totals.written` is the number of nodes that are (dry-run: would be) written, not a file count; the
 * returned `written` is the real count. It carries the migration channel's fields as constants (`removed:
 * []`, `renamed: {}`, `redirects: {}`). Each artist entry has `before` / `after` (list sizes), the
 * `withMbidBefore` / `withMbidAfter` they hold, then what was decided (`posed`, `added`, `ambiguous`,
 * `nearDuplicates`, `excluded` per reason, `capReached`) or why it was skipped or refused. A near duplicate is
 * an added work whose title opens, or is opened by, that of an entry still without mbid ("Sine of the Dub" /
 * "Sine of the Dub / Stalker"): added anyway, measured here, not reconciled.
 *
 * --resume reads that manifest back (it is rewritten every CHECKPOINT_EVERY artists, BEFORE the nodes of that
 * batch are written) and carries an artist whose current list is exactly what it decided: its fingerprint, the
 * hash of the (slug, mbid) pairs, equals the one decided for `after`, or, in a dry-run, `before` as well (a
 * dry-run decides without writing). An artist whose list changed since, a skipped `unavailable` and a refused
 * one are processed again. --only restricts the run to the given artist slugs (a slug that is not an artist
 * of the cache is a usage error); it rewrites the manifest with those artists only, so give it its own
 * --manifest.
 *
 * Exit codes: 0; 1 when at least one artist is `refused`, or when more than MAX_UNAVAILABLE_RATE of the artists
 * asked about are `unavailable` (fewer stay listed in the manifest and counted by the summary, exit 0: the
 * dispatcher's decision of 2026-10-19, amending the ticket, because the channel does not pass --resume and one
 * flaky answer in two thousand must not refuse its run); 2 on a usage error.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it
 * passes; nothing here is specific to it.
 *
 * Usage: tsx scripts/migrations/2026-10-21-backfill-discography-mbid.ts <cache-dir> [--apply]
 *        [--manifest out/discography-mbid.json] [--data-dir <dir>] [--resume] [--only <slug,...>]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache } from "../../src/cache.js";
import {
	DEFAULT_DISCOGRAPHY_CAP,
	DISCOGRAPHY_POLICY_VERSION,
	type ExclusionReason,
	type MergeResult,
	mergeDiscography,
	type ReleaseGroupCandidate,
	selectReleases,
} from "../../src/discography-policy.js";
import { resolveReadSlug } from "../../src/genre-registry.js";
import { fetchArtistDiscographyMb } from "../../src/musicbrainz.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { normalizeSlugBody, pickScopeArtistName, scopeMatchesArtist } from "../../src/slug.js";
import type { EdgeRef, Slug } from "../../src/types.js";
import {
	defaultDataDir,
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { loadExclusions, onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";
import { loadRunRedirects } from "./2026-10-19-backfill-similar-artists.js";

export const MIGRATION_NAME = "2026-10-21-backfill-discography-mbid";
export const DEFAULT_MANIFEST_PATH = "out/discography-mbid.json";

/** The manifest is rewritten this often during a run, so a crash loses little. */
const CHECKPOINT_EVERY = 25;

export const SKIP_REASONS = ["no-mbid", "excluded", "name-mismatch", "unavailable", "cap"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export type RefusedReason = "unreadable" | "invalid-node" | "would-alter-fields";

const EXCLUSION_REASONS: readonly ExclusionReason[] = [
	"secondary-type",
	"credit",
	"various-artists",
	"non-canonical",
	"primary-type",
];

export interface ArtistEntry {
	mbid?: string;
	/** Entries of the discography before and after the merge (equal when skipped, refused or unchanged). */
	before: number;
	after: number;
	/** Of those, the entries that carry an mbid. */
	withMbidBefore: number;
	withMbidAfter: number;
	skipped?: SkipReason;
	refused?: RefusedReason;
	posed?: MergeResult["posed"];
	added?: MergeResult["added"];
	ambiguous?: MergeResult["ambiguous"];
	nearDuplicates?: { added: string; existing: string }[];
	excluded?: Record<ExclusionReason, number>;
	capReached?: boolean;
	/** Hash of the (slug, mbid) pairs of the list as read and as decided, see --resume. */
	fingerprint?: { before: string; after: string };
}

export interface DiscographyManifest {
	/** The channel's manifest contract: this migration deletes and renames nothing. */
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	totals: {
		artists: number;
		processed: number;
		/** Nodes that are (dry-run: would be) written. */
		written: number;
		posed: number;
		added: number;
		ambiguous: number;
		nearDuplicate: number;
		refused: number;
		skipped: Record<SkipReason, number>;
		excluded: Record<ExclusionReason, number>;
		/** Discography edges over every artist of the run, and the share that carries an mbid. */
		edges: {
			before: number;
			after: number;
			withMbidBefore: number;
			withMbidAfter: number;
			mbidShareBefore: number;
			mbidShareAfter: number;
		};
	};
	artists: Record<string, ArtistEntry>;
}

export interface BackfillOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** Where `identity-exclusions.json` and the redirect tables are read; the repo's data/ when absent. */
	dataDir?: string | undefined;
	resume?: boolean;
	/** Only these artists are read and processed. */
	only?: readonly Slug[] | undefined;
	/** The network boundary, injected by the tests. Default: the global fetch. */
	fetch?: typeof fetch;
	log?: (line: string) => void;
}

/**
 * The share of the artists MusicBrainz was asked about that may end `unavailable` before the run exits 1 (model:
 * MAX_UNAVAILABLE_RATE of the similar-artists backfill). A few failures in two thousand requests are noise: they are
 * listed in the manifest, nothing is written for them, and a --resume run retries them. More than a fifth means
 * MusicBrainz is down, and a run that ships what is left would not be what the preview showed. Strictly greater
 * than: 20 % exactly passes. Computed over the artists of THIS run that made a request.
 */
export const MAX_UNAVAILABLE_RATE = 0.2;

export interface BackfillResult {
	manifest: DiscographyManifest;
	/** Node files really written (always 0 without --apply). */
	written: number;
	/** Artists of this run MusicBrainz was asked about, and those that ended `unavailable`. */
	requests: { asked: number; unavailable: number };
	exitCode: 0 | 1 | 2;
}

/** A refusal always fails the run; unavailable artists do only past MAX_UNAVAILABLE_RATE. */
function failedRun(manifest: DiscographyManifest, requests: BackfillResult["requests"]): boolean {
	return manifest.totals.refused > 0 || isOutage(requests);
}

const isOutage = (requests: BackfillResult["requests"]): boolean =>
	requests.asked > 0 && requests.unavailable / requests.asked > MAX_UNAVAILABLE_RATE;

const compareSlugs = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const hasMbid = (edge: unknown): boolean =>
	isRecord(edge) && typeof edge.mbid === "string" && edge.mbid !== "";

const countWithMbid = (edges: readonly unknown[]): number => edges.filter(hasMbid).length;

// The identity (MBID, name, kind) is part of it: a decision carried by --resume is about THIS artist as the
// identity guard saw it, so a corrected MBID or a renamed node is decided again even if its list is the same.
function fingerprintOf(identity: string, edges: readonly unknown[]): string {
	const pairs = edges.map((e) => (isRecord(e) ? [e.slug, e.mbid ?? null] : null));
	return createHash("sha256")
		.update(JSON.stringify([identity, pairs]))
		.digest("hex")
		.slice(0, 16);
}

const sameMbid = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A name as the identity guard compares it: its slug body, or the folded name when it has no Latin letter. */
const identityKey = (name: string): string =>
	normalizeSlugBody(name) || name.normalize("NFKC").trim().toLowerCase();

/**
 * The identity guard (8-D3). `credited` is every release group first-credited to the artist's MBID. The node
 * passes when one of those first credits is named like it, and, for a group, when any credit of any of them is.
 */
function creditsNameTheNode(
	node: { name: string; artist_kind?: "person" | "group" | undefined },
	credited: readonly ReleaseGroupCandidate[],
): boolean {
	const target = identityKey(node.name);
	for (const release of credited) {
		const credits = node.artist_kind === "group" ? release.artistCredits : release.artistCredits.slice(0, 1);
		if (credits.some((credit) => identityKey(credit.name) === target)) return true;
	}
	return false;
}

// --- --resume ---

async function readPriorEntries(path: string): Promise<Map<string, ArtistEntry>> {
	const prior = new Map<string, ArtistEntry>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return prior;
	}
	if (!isRecord(parsed) || parsed.migration !== MIGRATION_NAME || !isRecord(parsed.artists)) return prior;
	for (const [slug, entry] of Object.entries(parsed.artists)) {
		if (!isRecord(entry) || !isRecord(entry.fingerprint)) continue;
		if (typeof entry.fingerprint.before !== "string" || typeof entry.fingerprint.after !== "string") continue;
		const numbers = [entry.before, entry.after, entry.withMbidBefore, entry.withMbidAfter];
		if (!numbers.every((n) => typeof n === "number")) continue;
		// Only a decision is settled: a skip is carried only when it was a name-mismatch (one request spent).
		const decided =
			entry.skipped === "name-mismatch" ||
			(entry.skipped === undefined &&
				entry.refused === undefined &&
				Array.isArray(entry.posed) &&
				Array.isArray(entry.added) &&
				Array.isArray(entry.ambiguous) &&
				Array.isArray(entry.nearDuplicates) &&
				isRecord(entry.excluded));
		if (decided) prior.set(slug, entry as unknown as ArtistEntry);
	}
	return prior;
}

// --- the run ---

interface PendingWrite {
	path: string;
	next: Record<string, unknown>;
}

/** Everything `fetchArtistDiscographyMb` calls goes through one chain: a request starts when the previous ended. */
function serialized(base: typeof fetch): typeof fetch {
	let tail: Promise<unknown> = Promise.resolve();
	return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const run = tail.then(() => base(input, init));
		tail = run.catch(() => undefined);
		return run;
	}) as typeof fetch;
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
	// Process-wide for the duration of the run, restored in `finally`: the MusicBrainz client reads the global
	// fetch and the slug functions read the flag at call time (see "SLUG FORM" above).
	const savedFetch = globalThis.fetch;
	const savedFlag = process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
	globalThis.fetch = serialized(options.fetch ?? savedFetch);
	process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = "1";
	try {
		return await run(options);
	} finally {
		globalThis.fetch = savedFetch;
		if (savedFlag === undefined) delete process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
		else process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = savedFlag;
	}
}

async function run(options: BackfillOptions): Promise<BackfillResult> {
	const { cacheDir, apply } = options;
	const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
	const log = options.log ?? (() => {});
	const only = options.only === undefined ? null : new Set<string>(options.only);

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	// Relative to nodes/ and without the cache dir in the message: the manifest must not depend on where the
	// cache sits (the channel's preview and apply use different scratch directories).
	const unreadable = invalid
		.map((entry) => relative(join(cacheDir, "nodes"), entry.path))
		.filter((slug) => slug.startsWith("artist:") && (only === null || only.has(slug)));
	const artistFiles = nodes.filter((n) => n.type === "artist" && (only === null || only.has(n.slug)));
	if (only !== null) {
		const known = new Set([...artistFiles.map((n) => n.slug), ...unreadable]);
		const unknown = [...only].filter((slug) => !known.has(slug)).sort(compareSlugs);
		if (unknown.length > 0) {
			log(`--only: not an artist of the cache: ${unknown.join(", ")}`);
			return {
				manifest: buildManifest(new Map()),
				written: 0,
				requests: { asked: 0, unavailable: 0 },
				exitCode: 2,
			};
		}
	}

	// Fail closed: neither the exclusion list nor the redirect tables may be guessed.
	const exclusionList = await loadExclusions(options.dataDir ?? defaultDataDir());
	if (!exclusionList.ok) throw new Error(exclusionList.error);
	const exclusions = exclusionList.artists;
	const redirects = await loadRunRedirects(options.dataDir);

	// The project nodes, once: mbid -> slug, and where a redirected slug lands (resolveReadSlug is async, the
	// merge wants a function, so every redirect key of a project is resolved here, against the real cache).
	const byMbid = new Map<string, Slug>();
	for (const { slug, node } of nodes) {
		if (
			slug.startsWith("project:") &&
			typeof node.mbid === "string" &&
			!byMbid.has(node.mbid.toLowerCase())
		) {
			byMbid.set(node.mbid.toLowerCase(), slug as Slug);
		}
	}
	const cache = new NodeCache(cacheDir);
	const resolved = new Map<Slug, Slug>();
	for (const key of redirects.keys()) {
		if (key.startsWith("project:")) resolved.set(key, await resolveReadSlug(key, redirects, cache));
	}

	const prior = options.resume ? await readPriorEntries(manifestPath) : new Map<string, ArtistEntry>();
	const entries = new Map<string, ArtistEntry>();
	for (const slug of unreadable) {
		entries.set(slug, { before: 0, after: 0, withMbidBefore: 0, withMbidAfter: 0, refused: "unreadable" });
	}

	let writtenFiles = 0;
	let pending: PendingWrite[] = [];
	// A checkpoint keeps the decisions of the previous manifest for the artists not reached yet: it overwrites the
	// very file --resume reads, and a crash must not lose what that run had settled. The last write is this run's.
	const writeManifest = async (final: boolean): Promise<void> => {
		await mkdir(dirname(manifestPath), { recursive: true });
		await atomicWriteJson(manifestPath, buildManifest(final ? entries : new Map([...prior, ...entries])));
	};
	// The checkpoint comes first: a crash between it and the writes leaves nodes the manifest already decided
	// and does not know to be written, which --resume then processes again (an apply needs `after` on disk).
	const checkpoint = async (final: boolean): Promise<void> => {
		await writeManifest(final);
		if (apply) {
			for (const { path, next } of pending) {
				await atomicWriteJson(path, next);
				writtenFiles++;
			}
		}
		pending = [];
	};

	log(
		`${artistFiles.length} artist(s) to read at about one request per second` +
			`${apply ? "" : " (DRY RUN)"}${options.resume ? ", resuming" : ""}`,
	);

	let sinceCheckpoint = 0;
	let asked = 0;
	let unavailableCount = 0;
	for (const { slug, path, node: raw } of artistFiles) {
		const rawEdges = Array.isArray(raw.discography) ? (raw.discography as unknown[]) : [];
		const counts = {
			before: rawEdges.length,
			after: rawEdges.length,
			withMbidBefore: countWithMbid(rawEdges),
			withMbidAfter: countWithMbid(rawEdges),
		};
		const mbid = typeof raw.mbid === "string" && raw.mbid !== "" ? raw.mbid : undefined;
		const skip = (reason: SkipReason): void => {
			entries.set(slug, { ...(mbid === undefined ? {} : { mbid }), ...counts, skipped: reason });
		};
		const refuse = (reason: RefusedReason): void => {
			entries.set(slug, { ...(mbid === undefined ? {} : { mbid }), ...counts, refused: reason });
		};

		if (mbid === undefined) {
			skip("no-mbid");
			continue;
		}
		if (exclusions.has(slug as Slug)) {
			skip("excluded");
			continue;
		}
		const parsed = nodePayloadSchema.safeParse(raw);
		if (!parsed.success || parsed.data.type !== "artist") {
			refuse("invalid-node");
			continue;
		}
		const artist = parsed.data;
		const identity = `policy ${DISCOGRAPHY_POLICY_VERSION}|${mbid}|${artist.name}|${artist.artist_kind ?? ""}`;
		const current = fingerprintOf(identity, rawEdges);
		// Before the cap: an artist that reached the cap DURING the run (every entry now has its mbid) would
		// otherwise be re-read as a plain `cap` skip and lose the decision the manifest recorded for it.
		const decided = prior.get(slug);
		if (
			decided?.fingerprint !== undefined &&
			(apply
				? current === decided.fingerprint.after
				: current === decided.fingerprint.before || current === decided.fingerprint.after)
		) {
			entries.set(slug, decided);
			continue;
		}
		if (counts.before >= DEFAULT_DISCOGRAPHY_CAP && counts.withMbidBefore === counts.before) {
			skip("cap");
			continue;
		}

		const { releases, unavailable } = await fetchArtistDiscographyMb(mbid, { priority: "background" });
		asked++;
		if (unavailable) unavailableCount++;
		if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
			sinceCheckpoint = 0;
			// The entry of this artist is not in yet: it lands in the next checkpoint with the others.
			await checkpoint(false);
		}
		if (unavailable) {
			skip("unavailable");
			continue;
		}

		const allCredited = releases.filter((r) => {
			const first = r.artistCredits[0];
			return first !== undefined && sameMbid(first.mbid, mbid);
		});
		const fingerprint = { before: current, after: current };
		if (allCredited.length > 0 && !creditsNameTheNode(artist, allCredited)) {
			entries.set(slug, { mbid, ...counts, skipped: "name-mismatch", fingerprint });
			continue;
		}

		const policy = {
			artistMbid: mbid,
			artistName: pickScopeArtistName([artist.name]) ?? artist.name,
			cap: DEFAULT_DISCOGRAPHY_CAP,
		};
		const selection = selectReleases(releases, policy);
		const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<
			ExclusionReason,
			number
		>;
		for (const { reason } of selection.excluded) excluded[reason]++;
		// A redirect is followed only to a work scoped on THIS artist: `project:human-after-all--twin-atlantic`
		// redirecting to `--daft-punk` (a rename of that other artist's node) must not hand Twin Atlantic's
		// release somebody else's page. The mbid match stays unconditional: it is an identity, not a name.
		const resolveSlug = (target: Slug): Slug => {
			const followed = resolved.get(target);
			return followed !== undefined && scopeMatchesArtist(followed, policy.artistName) ? followed : target;
		};
		const merge = mergeDiscography({
			existing: rawEdges as EdgeRef[],
			candidates: selection.kept,
			allCredited,
			policy,
			projectIndex: { byMbid, resolveSlug },
		});
		const decision = {
			posed: merge.posed,
			added: merge.added,
			ambiguous: merge.ambiguous,
			nearDuplicates: merge.added.flatMap((a) =>
				a.nearDuplicateOf === undefined ? [] : [{ added: a.slug, existing: a.nearDuplicateOf }],
			),
			excluded,
			capReached: merge.capReached,
		};

		if (!merge.changed) {
			entries.set(slug, { mbid, ...counts, ...decision, fingerprint });
			continue;
		}
		// The node as read with `discography` replaced (key order and every other field as they were), and only
		// if the schema would alter nothing else: it strips undeclared fields, edges' included.
		const next = { ...raw, discography: merge.edges };
		const valid = nodePayloadSchema.safeParse(next);
		if (!valid.success || !onlyAddsSchemaDefaults(next, valid.data)) {
			refuse(valid.success ? "would-alter-fields" : "invalid-node");
			continue;
		}
		entries.set(slug, {
			mbid,
			before: counts.before,
			after: merge.edges.length,
			withMbidBefore: counts.withMbidBefore,
			withMbidAfter: countWithMbid(merge.edges),
			...decision,
			fingerprint: { before: current, after: fingerprintOf(identity, merge.edges) },
		});
		pending.push({ path, next });
	}

	await checkpoint(true);
	const manifest = buildManifest(entries);
	const requests = { asked, unavailable: unavailableCount };
	return { manifest, written: writtenFiles, requests, exitCode: failedRun(manifest, requests) ? 1 : 0 };
}

const share = (part: number, whole: number): number =>
	whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 10_000;

function buildManifest(entries: ReadonlyMap<string, ArtistEntry>): DiscographyManifest {
	const skipped = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;
	const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<
		ExclusionReason,
		number
	>;
	const totals: DiscographyManifest["totals"] = {
		artists: entries.size,
		processed: 0,
		written: 0,
		posed: 0,
		added: 0,
		ambiguous: 0,
		nearDuplicate: 0,
		refused: 0,
		skipped,
		excluded,
		edges: {
			before: 0,
			after: 0,
			withMbidBefore: 0,
			withMbidAfter: 0,
			mbidShareBefore: 0,
			mbidShareAfter: 0,
		},
	};
	const artists: Record<string, ArtistEntry> = {};
	for (const slug of [...entries.keys()].sort(compareSlugs)) {
		const entry = entries.get(slug);
		if (entry === undefined) continue;
		artists[slug] = entry;
		totals.edges.before += entry.before;
		totals.edges.after += entry.after;
		totals.edges.withMbidBefore += entry.withMbidBefore;
		totals.edges.withMbidAfter += entry.withMbidAfter;
		if (entry.refused !== undefined) totals.refused++;
		if (entry.skipped !== undefined) skipped[entry.skipped]++;
		if (entry.posed === undefined || entry.added === undefined) continue;
		totals.processed++;
		if (entry.posed.length > 0 || entry.added.length > 0) totals.written++;
		totals.posed += entry.posed.length;
		totals.added += entry.added.length;
		totals.ambiguous += entry.ambiguous?.length ?? 0;
		totals.nearDuplicate += entry.nearDuplicates?.length ?? 0;
		for (const reason of EXCLUSION_REASONS) excluded[reason] += entry.excluded?.[reason] ?? 0;
	}
	totals.edges.mbidShareBefore = share(totals.edges.withMbidBefore, totals.edges.before);
	totals.edges.mbidShareAfter = share(totals.edges.withMbidAfter, totals.edges.after);
	return { migration: MIGRATION_NAME, removed: [], renamed: {}, redirects: {}, totals, artists };
}

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const t = manifest.totals;
	const percent = (value: number): string => `${(value * 100).toFixed(1)} %`;
	const lines = [
		`${MIGRATION_NAME}${apply ? "" : " (DRY RUN)"}`,
		`${t.artists} artist(s): ${t.processed} processed, ${t.refused} refused, skipped ${SKIP_REASONS.map(
			(r) => `${r} ${t.skipped[r]}`,
		).join(", ")}`,
		`${t.posed} mbid posed, ${t.added} entr${t.added === 1 ? "y" : "ies"} added, ${t.ambiguous} ambiguous, ${t.nearDuplicate} near duplicate(s)`,
		`edges with an mbid: ${t.edges.withMbidBefore}/${t.edges.before} (${percent(t.edges.mbidShareBefore)}) -> ${t.edges.withMbidAfter}/${t.edges.after} (${percent(t.edges.mbidShareAfter)})`,
		`excluded by the policy: ${EXCLUSION_REASONS.map((r) => `${r} ${t.excluded[r]}`).join(", ")}`,
		`${result.requests.unavailable} of ${result.requests.asked} artist(s) unavailable on MusicBrainz` +
			(isOutage(result.requests)
				? ` (more than ${MAX_UNAVAILABLE_RATE * 100} %: the service is down, re-run with --resume)`
				: result.requests.unavailable > 0
					? " (nothing written for them, a --resume run retries them)"
					: ""),
		apply
			? `${written} node file(s) written`
			: `dry-run: no node file written (${t.written} would be written)`,
		`manifest: ${manifestPath}`,
	];
	for (const [slug, entry] of Object.entries(manifest.artists)) {
		if (entry.refused !== undefined) lines.push(`refused ${slug}: ${entry.refused}`);
		else if (entry.skipped === "unavailable") lines.push(`unavailable ${slug}: MusicBrainz did not answer`);
	}
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	resume: boolean;
	manifestPath: string;
	dataDir: string | undefined;
	only: Slug[] | undefined;
}

const ARTIST_SLUG = /^artist:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parses `<cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>] [--resume] [--only <slug,...>]`. Null
 * (the CLI exits 2) on a missing cache-dir, a repeated flag, a flag without its value (or with another flag
 * as value), an `--only` entry that is not an artist slug, or any token no flag consumes: an ambiguous
 * argument never falls through to a guess.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let resume = false;
	let manifestPath: string | undefined;
	let dataDir: string | undefined;
	let only: Slug[] | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--resume" && !resume) resume = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--data-dir" && dataDir === undefined) ||
			(token === "--only" && only === undefined)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else if (token === "--data-dir") dataDir = value;
			else {
				const slugs = value.split(",");
				if (!slugs.every((s) => ARTIST_SLUG.test(s))) return null;
				only = [...new Set(slugs)] as Slug[];
			}
		} else return null;
	}
	return { cacheDir, apply, resume, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH, dataDir, only };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-21-backfill-discography-mbid.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>] [--resume] [--only <slug,...>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runBackfill({
		cacheDir: args.cacheDir,
		apply: args.apply,
		manifestPath: args.manifestPath,
		dataDir: args.dataDir,
		resume: args.resume,
		only: args.only,
		log: (line) => process.stdout.write(`${line}\n`),
	});
	if (result.exitCode !== 2) console.log(formatSummary(result, args.apply, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
