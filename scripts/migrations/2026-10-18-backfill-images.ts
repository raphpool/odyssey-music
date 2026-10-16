/**
 * Image backfill (TRA-489, plan docs/plans/graph-integrity.md, part 3): give every node of the cache the
 * `image_url` / `image_source` the deterministic resolver (TRA-465, src/images/resolve-image.ts) can find,
 * in the order of the dependencies. No LLM. The resolver itself is not touched.
 *
 * Order, fixed: project -> track -> artist -> label -> genre. A track reuses its project's image, and the
 * artist / label / genre `derived-cover` rungs read the images of the projects and tracks they point at,
 * so those must exist (on disk with --apply, in memory otherwise) before the node that borrows them is
 * resolved. A dry-run therefore gives exactly the result of an apply: the resolver reads the nodes
 * through an overlay that holds what this run has decided so far, never the stale disk.
 *
 * For each node WITHOUT `image_url` (a node that has one is never touched, so a second run is a no-op):
 *   1. `resolveImage(node, { cache })`;
 *   2. when it finds nothing and the node carries a legacy `photo_url` (artist) / `cover_url` (project,
 *      track) on an allowed host (`isAllowedImageUrl`): `image_url` = that field, `image_source: "legacy"`.
 *      `photo_url` / `cover_url` are never removed or rewritten;
 *   3. otherwise the node stays without image and is listed in the manifest's `none` with a reason:
 *      `no-mbid` | `caa-404` | `no-wikidata` | `no-related-image` (see `noneReason`).
 *
 * Untrusted data: every URL written passes `isAllowedImageUrl` (the resolver gates its own, this checks
 * again what it writes), and the node schema refuses a host off the list on write.
 *
 * Fail-closed on an unavailable source (2026-10-16, same rule as MusicBrainz in TRA-505 / TRA-573). The
 * resolver swallows a network error, a timeout or a 429 / 5xx and answers null, which is
 * indistinguishable from "this node has no image": taken as a verdict, an outage would write a lower rung
 * (an iTunes cover when the Cover Art Archive was down) or list a node in `none` for good. The resolver is
 * handed a `fetch` that remembers, per host, the outcome of the LAST request of the node (MusicBrainz
 * retries by itself: a 503 followed by a 200 is not an outage). A node whose resolution ended on an
 * unavailable host is neither written nor listed in `none`: it goes to `failed`, and the run exits 1 so
 * the operator re-runs with --resume. A 404 (Cover Art Archive "no front cover") IS a verdict; a 403, 408,
 * 425, 429 or 5xx, a timeout or a network error is not. What the resolver turns into null while the source
 * answered 200 (a body that is not what the API documents) cannot be told from "no image" and stays a
 * verdict. A node that READS a node that failed (a track and its project, a genre and its landmarks, ...)
 * waits too, in `failed`, whatever it could resolve now: it would borrow another input's image and, having
 * an image, never be revisited. After MAX_CONSECUTIVE_UNAVAILABLE such nodes in a row (a node that made no
 * request neither breaks nor extends the row) the run stops: a dead network must not burn the timeouts of
 * the 2 700 remaining calls.
 *
 * A node the node schema refuses (including a legacy non-canonical slug that NodeCache.get still serves) or
 * a file that cannot be read is listed in `failed` and exits 1: it can be neither resolved nor written, and
 * the identity migrations of the same channel run come first.
 *
 * The legacy field is tried after the whole resolver ladder (contract of TRA-489): an artist with a
 * `photo_url` but a discography image gets that album cover as `derived-cover`, not its photo.
 *
 * Pace: strictly sequential, one node at a time. MusicBrainz is held to one request per second by
 * mbFetch (MB_MIN_INTERVAL_MS) and Wikidata to wikidataConfig.minIntervalMs by their own modules; this
 * script adds no concurrency to either. Cover Art Archive and iTunes have no limiter of their own and are
 * reached sequentially at most a few hundred times (one call per project, iTunes only on a CAA miss).
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation, never NodeCache.write (which would
 * emit reverse edges this migration has no business creating). A write that validation would alter (it
 * strips undeclared fields) is refused and the node listed in `failed`.
 *
 * Manifest: deterministic (sorted, no timestamp, no mode): the same cache and the same answers from the
 * sources give a byte-identical file in a dry-run, an apply and a re-run on a copy. It carries the migration
 * channel's fields as constants (`migration`, `removed: []`, `renamed: {}`, `redirects: {}`).
 * `bySource` is a snapshot: the provenance of every image of the cache at the end of the run, those that
 * were there before included (a JIT `caa` of the server, an earlier run), so it never depends on which run
 * wrote what. `--resume` reads the manifest of the previous run at `--manifest` and keeps its
 * `coverage.*.before` (a second run would otherwise report the first run's work as "already there").
 * A node already imaged is skipped with or without it.
 *
 * Migration channel (deploy/sync-genre-cache.sh, TRA-568): `--apply`, `--manifest` and `--data-dir` are
 * the flags it passes. `--data-dir` is accepted and ignored: this migration reads and writes no redirect
 * table. The channel replays a preview's manifest only for the two identity migrations; for this one the
 * apply runs the resolver again.
 *
 * Usage: tsx scripts/migrations/2026-10-18-backfill-images.ts <cache-dir> [--apply]
 *        [--types project,track,artist,label,genre] [--manifest out/images.json] [--resume]
 *        [--data-dir <dir>]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache } from "../../src/cache.js";
import { musicBrainzConfig } from "../../src/config.js";
import { isAllowedImageUrl } from "../../src/images/hosts.js";
import { resolveImage } from "../../src/images/resolve-image.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { IMAGE_SOURCES, type ImageSource, type NodePayload, type Slug } from "../../src/types.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-18-backfill-images";
export const DEFAULT_MANIFEST_PATH = "out/images.json";

/** The order of the dependencies, see the header. */
export const IMAGE_TYPE_ORDER = ["project", "track", "artist", "label", "genre"] as const;
export type ImageType = (typeof IMAGE_TYPE_ORDER)[number];

export const NONE_REASONS = ["no-mbid", "caa-404", "no-wikidata", "no-related-image"] as const;
export type NoneReason = (typeof NONE_REASONS)[number];

/** Consecutive nodes ended on an unavailable source after which the run stops. */
export const MAX_CONSECUTIVE_UNAVAILABLE = 5;
/** The manifest is rewritten this often during a run, so a crash loses little. */
const CHECKPOINT_EVERY = 25;

export interface Coverage {
	before: number;
	after: number;
	total: number;
}

export interface ImagesManifest {
	/** The channel's manifest contract (TRA-568): this migration deletes and renames nothing. */
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	coverage: Record<ImageType, Coverage>;
	bySource: Record<ImageSource, number>;
	none: { slug: string; reason: NoneReason }[];
	/** Nodes left untouched and not in `none`: a source was unavailable, or a write was refused. */
	failed: { slug: string; reason: string }[];
}

export interface BackfillOptions {
	cacheDir: string;
	apply: boolean;
	/** Subset of types to process (always in IMAGE_TYPE_ORDER). Default: all five. */
	types?: readonly ImageType[];
	manifestPath?: string;
	resume?: boolean;
	/** The network boundary, injected by the tests. Default: the global fetch, read at call time. */
	fetch?: typeof fetch;
	log?: (line: string) => void;
}

export interface BackfillResult {
	manifest: ImagesManifest;
	/** Node files written (always empty without --apply). */
	written: string[];
	/** The run stopped early after MAX_CONSECUTIVE_UNAVAILABLE unavailable nodes in a row. */
	aborted: boolean;
	exitCode: 0 | 1;
}

// --- The resolver's view of the cache: what this run has decided, then the disk ---

class OverlayCache extends NodeCache {
	private readonly decided = new Map<string, NodePayload>();

	set(node: NodePayload): void {
		this.decided.set(node.slug, node);
	}

	override async get(slug: Slug): Promise<NodePayload> {
		return this.decided.get(slug) ?? (await super.get(slug));
	}
}

// --- Detecting an unavailable source behind the resolver's null ---

/**
 * A request that did not get an answer about the resource: a server error, or a refusal that says nothing
 * about the node (403 / 425 / 429: rate limit or blocked client, 408: timeout). A 404 is an answer, and so
 * is any other 4xx (a malformed request is a defect to read in the node's manifest entry, not an outage).
 */
function isUnavailableStatus(status: number): boolean {
	return status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function hostOf(input: string | URL | Request): string {
	try {
		return new URL(input instanceof Request ? input.url : String(input)).host;
	} catch {
		return "unknown-host";
	}
}

export interface AvailabilityTracker {
	fetch: typeof fetch;
	/** Forget the previous node. */
	reset(): void;
	/** Hosts whose last request of this node was not answered, sorted, with what happened. */
	unavailable(): string[];
	/** Requests made since the last reset: a node resolved without network says nothing about the network. */
	requests(): number;
}

/**
 * Wraps `base` so a node's resolution can tell "the source said no" (404, an empty answer) from "the source
 * did not answer". The outcome kept per host is the LAST one: mbFetch retries a 429/5xx on its own, and a
 * retried request that ends 200 is a success.
 */
export function trackAvailability(base: () => typeof fetch): AvailabilityTracker {
	const lastFailure = new Map<string, string | null>();
	let requests = 0;
	const tracked = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const host = hostOf(input);
		requests++;
		try {
			const response = await base()(input, init);
			lastFailure.set(host, isUnavailableStatus(response.status) ? `HTTP ${response.status}` : null);
			return response;
		} catch (e) {
			lastFailure.set(host, `no answer (${e instanceof Error ? e.name : "error"})`);
			throw e;
		}
	}) as typeof fetch;
	return {
		fetch: tracked,
		reset: () => {
			lastFailure.clear();
			requests = 0;
		},
		requests: () => requests,
		unavailable: () =>
			[...lastFailure].flatMap(([host, failure]) => (failure === null ? [] : [`${host}: ${failure}`])).sort(),
	};
}

// --- Per-node decisions ---

function hasImage(raw: Record<string, unknown>): boolean {
	return typeof raw.image_url === "string" && raw.image_url !== "";
}

/** The pre-TRA-455 field of the node that holds a picture of it, when its type has one. */
function legacyUrl(type: ImageType, raw: Record<string, unknown>): string | undefined {
	const value =
		type === "artist" ? raw.photo_url : type === "project" || type === "track" ? raw.cover_url : undefined;
	return typeof value === "string" ? value : undefined;
}

/**
 * Why a node the resolver and the legacy fields could not image has no image. One reason per node, the
 * first blocker of its ladder (src/images/resolve-image.ts):
 * - project: no MBID, so no Cover Art Archive lookup (`no-mbid`); else the CAA has no front cover (`caa-404`);
 * - track: no project to borrow from (`no-related-image`); a project with no MBID (`no-mbid`); else `caa-404`;
 * - artist: no MBID, so no Wikidata lookup (`no-mbid`); else Wikidata has no P18 for it (`no-wikidata`);
 * - label: the QID comes from MusicBrainz or a verified name search, and none has an image (`no-wikidata`);
 * - genre: none of its landmark projects / tracks has an image (`no-related-image`).
 * The `derived-cover` rungs of an artist or a label having failed too is implied, not a reason of its own.
 */
export async function noneReason(node: NodePayload, cache: NodeCache): Promise<NoneReason> {
	switch (node.type) {
		case "project":
			return node.mbid ? "caa-404" : "no-mbid";
		case "track": {
			if (!node.project) return "no-related-image";
			const project = await cache.get(node.project.slug).catch(() => null);
			return (project?.mbid ?? node.project.mbid) ? "caa-404" : "no-mbid";
		}
		case "artist":
			return node.mbid ? "no-wikidata" : "no-mbid";
		case "label":
			return "no-wikidata";
		case "genre":
			return "no-related-image";
	}
}

const bySlug = <T extends { slug: string }>(a: T, b: T): number =>
	a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;

const isImageSource = (value: unknown): value is ImageSource =>
	(IMAGE_SOURCES as readonly unknown[]).includes(value);

/**
 * The slugs whose image a node's resolution reads from the cache (track: its project; artist: landmark and
 * discography; label: notable releases; genre: landmark projects and tracks). A node whose input failed
 * for lack of an answer must wait for the re-run: resolved now, it would borrow another input's image and
 * keep it for good, since a node with an image is never touched again.
 */
function inputsOf(node: NodePayload): string[] {
	const slugs = (refs: ReadonlyArray<{ slug: string } | undefined>): string[] =>
		refs.flatMap((ref) => (ref ? [ref.slug] : []));
	switch (node.type) {
		case "project":
			return [];
		case "track":
			return slugs([node.project]);
		case "artist": {
			const landmark = (node as unknown as Record<string, unknown>).landmark_project;
			const landmarkSlug = isRecord(landmark) && typeof landmark.slug === "string" ? [landmark.slug] : [];
			return [...landmarkSlug, ...slugs(node.discography)];
		}
		case "label":
			return slugs(node.notable_releases);
		case "genre":
			return slugs([...node.landmark_projects, ...node.landmark_tracks]);
	}
}

interface PriorManifest {
	before: Partial<Record<ImageType, number>>;
}

/** The checkpoint of the previous run, or null when there is none (a first run, or a file that is not ours). */
async function readPriorManifest(path: string): Promise<PriorManifest | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.migration !== MIGRATION_NAME) return null;
	const prior: PriorManifest = { before: {} };
	if (isRecord(parsed.coverage)) {
		for (const type of IMAGE_TYPE_ORDER) {
			const entry = parsed.coverage[type];
			if (isRecord(entry) && Number.isInteger(entry.before) && (entry.before as number) >= 0) {
				prior.before[type] = entry.before as number;
			}
		}
	}
	return prior;
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
	const { cacheDir, apply, resume } = options;
	const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
	const log = options.log ?? (() => {});
	const selected = IMAGE_TYPE_ORDER.filter((t) => (options.types ?? IMAGE_TYPE_ORDER).includes(t));

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const failed: ImagesManifest["failed"] = invalid.map((entry) => ({
		slug: entry.path,
		reason: `unreadable node file: ${entry.error}`,
	}));
	const prior = resume ? await readPriorManifest(manifestPath) : null;

	const byType = new Map<ImageType, typeof nodes>(IMAGE_TYPE_ORDER.map((t) => [t, []]));
	for (const entry of nodes) byType.get(entry.type as ImageType)?.push(entry);

	const total = {} as Record<ImageType, number>;
	const before = {} as Record<ImageType, number>;
	for (const type of IMAGE_TYPE_ORDER) {
		const entries = byType.get(type) ?? [];
		total[type] = entries.length;
		before[type] = entries.filter((e) => hasImage(e.node)).length;
	}
	const gained = {} as Record<ImageType, number>;
	for (const type of IMAGE_TYPE_ORDER) gained[type] = 0;
	// The provenance of every image of the cache, as it stands: read from the nodes at the start, updated as
	// this run decides. A snapshot, so an interrupted run, a dry-run and a resumed run all report the truth.
	const sourceOf = new Map<string, ImageSource>();
	for (const { slug, node } of nodes) {
		if (hasImage(node) && isImageSource(node.image_source)) sourceOf.set(slug, node.image_source);
	}
	const none: ImagesManifest["none"] = [];
	const written: string[] = [];

	const manifest = (): ImagesManifest => ({
		migration: MIGRATION_NAME,
		removed: [],
		renamed: {},
		redirects: {},
		coverage: Object.fromEntries(
			IMAGE_TYPE_ORDER.map((type) => [
				type,
				{
					before: prior?.before[type] ?? before[type],
					after: before[type] + gained[type],
					total: total[type],
				},
			]),
		) as Record<ImageType, Coverage>,
		bySource: Object.fromEntries(
			IMAGE_SOURCES.map((source) => [source, [...sourceOf.values()].filter((s) => s === source).length]),
		) as Record<ImageSource, number>,
		none: [...none].sort(bySlug),
		failed: [...failed].sort(bySlug),
	});
	const writeManifest = async (): Promise<void> => {
		await mkdir(dirname(manifestPath), { recursive: true });
		await atomicWriteJson(manifestPath, manifest());
	};

	const pending = selected.reduce(
		(n, t) => n + (byType.get(t) ?? []).filter((e) => !hasImage(e.node)).length,
		0,
	);
	const mbCalls = selected
		.filter((t) => t === "artist" || t === "label")
		.reduce((n, t) => n + (byType.get(t) ?? []).filter((e) => !hasImage(e.node) && e.node.mbid).length, 0);
	log(
		`${pending} node(s) without image among ${selected.join(", ")}: about ${mbCalls} MusicBrainz request(s) ` +
			`at one per ${musicBrainzConfig.minIntervalMs} ms (${Math.ceil((mbCalls * Math.max(musicBrainzConfig.minIntervalMs, 0)) / 60000)} min), ` +
			`plus Wikidata, Cover Art Archive and iTunes${apply ? "" : " (dry-run)"}`,
	);

	// Every node is parsed once and held by the overlay, so the derived-cover rungs read memory, not the disk.
	// A node the schema refuses is not held: the cache would not serve it either, and its edges are no image.
	const cache = new OverlayCache(cacheDir);
	const parsedBySlug = new Map<string, NodePayload>();
	for (const { slug, node } of nodes) {
		const parsed = nodePayloadSchema.safeParse(node);
		if (parsed.success) {
			parsedBySlug.set(slug, parsed.data as NodePayload);
			cache.set(parsed.data as NodePayload);
		}
	}
	const tracker = trackAvailability(() => options.fetch ?? fetch);

	let processed = 0;
	let consecutiveUnavailable = 0;
	let aborted = false;
	// Nodes that failed for lack of an answer: retrying fixes them, so what reads them must wait too.
	const waiting = new Set<string>();
	outer: for (const type of selected) {
		for (const { slug, path, node: raw } of byType.get(type) ?? []) {
			if (hasImage(raw)) continue;
			const payload = parsedBySlug.get(slug);
			if (!payload) {
				const refused = nodePayloadSchema.safeParse(raw);
				failed.push({
					slug,
					reason: `refusing to resolve an invalid node: ${refused.success ? "unknown" : refused.error.message}`,
				});
				continue;
			}
			const blockedBy = inputsOf(payload).filter((input) => waiting.has(input));
			if (blockedBy.length > 0) {
				waiting.add(slug);
				failed.push({ slug, reason: `waits for a node that failed: ${blockedBy.sort().join(", ")}` });
				continue;
			}

			tracker.reset();
			let found: Awaited<ReturnType<typeof resolveImage>> = null;
			let threw: string | null = null;
			try {
				found = await resolveImage(payload, { cache, fetch: tracker.fetch });
			} catch (e) {
				threw = e instanceof Error ? e.message : String(e);
			}
			const down = tracker.unavailable();
			if (threw !== null || down.length > 0) {
				waiting.add(slug);
				failed.push({
					slug,
					reason: threw !== null ? `resolver threw: ${threw}` : `source unavailable: ${down.join(", ")}`,
				});
				if (++consecutiveUnavailable >= MAX_CONSECUTIVE_UNAVAILABLE) {
					aborted = true;
					break outer;
				}
				continue;
			}
			// Only a node that reached the network and got its answers shows the network is back: one resolved
			// from the cache (a track borrowing its project's image) or without an MBID says nothing about it.
			if (tracker.requests() > 0) consecutiveUnavailable = 0;

			let image: { url: string; source: ImageSource } | null = found;
			if (!image) {
				const legacy = legacyUrl(type, raw);
				if (legacy !== undefined && isAllowedImageUrl(legacy)) image = { url: legacy, source: "legacy" };
			}
			if (!image) {
				none.push({ slug, reason: await noneReason(payload, cache) });
			} else if (!isAllowedImageUrl(image.url)) {
				failed.push({ slug, reason: "refusing to write an image URL off the allowed hosts" });
			} else {
				const next = { ...raw, image_url: image.url, image_source: image.source };
				const valid = nodePayloadSchema.safeParse(next);
				if (!valid.success) {
					failed.push({ slug, reason: `refusing to write an invalid node: ${valid.error.message}` });
				} else if (!onlyAddsSchemaDefaults(next, valid.data)) {
					// The schema strips undeclared fields, edges' included: only the image fields may change.
					failed.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
				} else {
					if (apply) {
						await atomicWriteJson(path, valid.data);
						written.push(path);
					}
					cache.set(valid.data as NodePayload);
					gained[type]++;
					sourceOf.set(slug, image.source);
				}
			}
			if (++processed % CHECKPOINT_EVERY === 0) await writeManifest();
		}
	}

	await writeManifest();
	return { manifest: manifest(), written, aborted, exitCode: failed.length > 0 ? 1 : 0 };
}

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const lines = IMAGE_TYPE_ORDER.map((t) => {
		const c = manifest.coverage[t];
		return `${t.padEnd(8)} ${c.before} -> ${c.after} / ${c.total}`;
	});
	lines.push(
		`by source: ${IMAGE_SOURCES.map((s) => `${s} ${manifest.bySource[s]}`).join(", ")}`,
		`${manifest.none.length} node(s) left without image, ${manifest.failed.length} failed`,
		apply ? `${written.length} node file(s) written` : "dry-run: no node file written",
		`manifest: ${manifestPath}`,
	);
	for (const f of manifest.failed) lines.push(`failed ${f.slug}: ${f.reason}`);
	if (result.aborted) {
		lines.push(
			`stopped after ${MAX_CONSECUTIVE_UNAVAILABLE} nodes in a row with an unavailable source: re-run with --resume`,
		);
	}
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	types: readonly ImageType[];
	manifestPath: string;
	resume: boolean;
}

/**
 * Parses `<cache-dir> [--apply] [--types a,b] [--manifest <path>] [--resume] [--data-dir <dir>]`.
 * `--data-dir` is the migration channel's and is ignored. Null (the CLI exits 2) on a missing cache-dir, a
 * repeated flag, a flag without its value (or with another flag as value), an unknown or repeated type, or
 * any token no flag consumes: an ambiguous argument never falls through to a guess.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let resume = false;
	let manifestPath: string | undefined;
	let types: ImageType[] | undefined;
	let dataDirSeen = false;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--resume" && !resume) resume = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--types" && types === undefined) ||
			(token === "--data-dir" && !dataDirSeen)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else if (token === "--data-dir") dataDirSeen = true;
			else {
				const parts = value.split(",");
				const known = (p: string): p is ImageType => (IMAGE_TYPE_ORDER as readonly string[]).includes(p);
				if (!parts.every(known) || new Set(parts).size !== parts.length) return null;
				types = parts as ImageType[];
			}
		} else return null;
	}
	return {
		cacheDir,
		apply,
		resume,
		types: IMAGE_TYPE_ORDER.filter((t) => (types ?? IMAGE_TYPE_ORDER).includes(t)),
		manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH,
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-18-backfill-images.ts <cache-dir> [--apply] [--types project,track,artist,label,genre] [--manifest <path>] [--resume] [--data-dir <dir>]\n",
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
		types: args.types,
		manifestPath: args.manifestPath,
		resume: args.resume,
		log: (line) => process.stdout.write(`${line}\n`),
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
