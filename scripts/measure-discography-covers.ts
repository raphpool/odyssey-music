/**
 * Read-only measure of the cover rate of artist discographies (TRA-622, decision 8-D6 of
 * docs/plans/graph-integrity.md). Run it before and after the discography backfill (8.9).
 *
 * offline <cache-dir>  For every edge of every `discography`: a project node with an `image_url` at the edge
 *                      slug is `found`; otherwise the image sidecar (`<cache-dir>/images/`) says `found` /
 *                      `missing` / `unavailable` / `conflict`; no usable sidecar is `absent`.
 * http --base <url>    GET /node/<artist> (which warms the covers), then GET /image/<slug>?from=<artist> per
 *                      edge, retrying a 202 up to 6 times; a 200 with an image_url is `found`, any other
 *                      200 is `none`, a failure is `error`. Sequential, so it does not load production.
 *
 * Nothing is ever written under <cache-dir>, and MusicBrainz / Cover Art Archive are never called: the only
 * URLs fetched are under --base.
 *
 * Usage: measure-discography-covers.ts offline <cache-dir> [--artists <slug,...>] [--json <out>]
 *        measure-discography-covers.ts http --base <url> --artists <slug,...> [--json <out>]
 * Exit:  0 report printed, 2 usage or unreadable cache.
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isAllowedImageUrl } from "../src/images/hosts.js";
import { imageSidecarPath, readImageSidecar } from "../src/images/image-sidecar.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

export interface CoverMeasure {
	artist: Slug;
	edges: number;
	withMbid: number;
	found: number;
	missing: number;
	unavailable: number;
	conflict: number;
	absent: number;
	none: number;
	error: number;
}

export interface CoverReport {
	rows: CoverMeasure[];
	totals: CoverMeasure;
	/** Requested artists that could not be measured (no node in the cache, or /node did not answer one). */
	skipped: Slug[];
}

const TOTALS_LABEL: Slug = "artist:*";
const MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_SECONDS = 5;
const MIN_RETRY_SECONDS = 2;
const MAX_RETRY_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "odyssey-measure/1";

const COUNTERS = [
	"edges",
	"withMbid",
	"found",
	"missing",
	"unavailable",
	"conflict",
	"absent",
	"none",
	"error",
] as const;

function emptyRow(artist: Slug): CoverMeasure {
	return {
		artist,
		edges: 0,
		withMbid: 0,
		found: 0,
		missing: 0,
		unavailable: 0,
		conflict: 0,
		absent: 0,
		none: 0,
		error: 0,
	};
}

function sum(rows: readonly CoverMeasure[]): CoverMeasure {
	const totals = emptyRow(TOTALS_LABEL);
	for (const r of rows) for (const k of COUNTERS) totals[k] += r[k];
	return totals;
}

interface Edge {
	slug: string;
	hasMbid: boolean;
}

/** The discography edges of a raw node: third-party-shaped data, so only well-formed entries count. */
function discographyOf(node: unknown): Edge[] | null {
	if (!node || typeof node !== "object") return null;
	const list = (node as { discography?: unknown }).discography;
	const edges: Edge[] = [];
	// A node without the field is an artist with no edge (a row of zeros), not a missing node.
	for (const e of Array.isArray(list) ? list : []) {
		if (!e || typeof e !== "object") continue;
		const { slug, mbid } = e as { slug?: unknown; mbid?: unknown };
		if (typeof slug === "string" && slug)
			edges.push({ slug, hasMbid: typeof mbid === "string" && mbid !== "" });
	}
	return edges;
}

/** `<root>/nodes/<type>/<body>.json`, or null for a slug that is malformed or could leave that folder. */
function nodeFile(root: string, slug: string): string | null {
	try {
		const { type, body } = parseSlug(slug);
		if (/[/\\\0]|\.\./.test(body)) return null;
		return join(root, "nodes", type, `${body}.json`);
	} catch {
		return null;
	}
}

async function readJson(file: string | null): Promise<unknown> {
	if (!file) return null;
	try {
		return JSON.parse(await readFile(file, "utf8")) as unknown;
	} catch {
		return null;
	}
}

/**
 * State of the sidecar for `key`, as the server would see it (fresh, valid, current rules), else null.
 * `readImageSidecar` deletes an invalid file, which a read-only measure must not do: it reads a copy of the
 * single file in a scratch folder, so the validation is the server's own and the cache is not touched.
 */
async function sidecarState(cacheDir: string, scratch: string, key: string): Promise<string | null> {
	let source: string;
	let copy: string;
	try {
		source = imageSidecarPath(cacheDir, key as Slug);
		copy = imageSidecarPath(scratch, key as Slug);
	} catch {
		return null;
	}
	try {
		await copyFile(source, copy);
	} catch {
		return null;
	}
	try {
		return (await readImageSidecar(scratch, key as Slug))?.state ?? null;
	} finally {
		await unlink(copy).catch(() => {});
	}
}

async function listArtists(root: string): Promise<Slug[]> {
	let files: string[];
	try {
		files = await readdir(join(root, "nodes", "artist"));
	} catch {
		throw new Error(`${join(root, "nodes", "artist")} is not readable: <cache-dir> must contain nodes/`);
	}
	return files
		.filter((f) => f.endsWith(".json"))
		.map((f) => `artist:${f.slice(0, -".json".length)}` as Slug)
		.sort();
}

export async function measureOffline(cacheDir: string, artists?: readonly Slug[]): Promise<CoverReport> {
	const root = resolve(cacheDir);
	const wanted = artists ?? (await listArtists(root));
	const scratch = await mkdtemp(join(tmpdir(), "measure-covers-"));
	await mkdir(join(scratch, "images"), { recursive: true });
	const rows: CoverMeasure[] = [];
	const skipped: Slug[] = [];
	try {
		for (const artist of wanted) {
			const edges = discographyOf(await readJson(nodeFile(root, artist)));
			if (!edges) {
				skipped.push(artist);
				continue;
			}
			const row = emptyRow(artist);
			for (const edge of edges) {
				row.edges++;
				if (edge.hasMbid) row.withMbid++;
				const node = (await readJson(nodeFile(root, edge.slug))) as { image_url?: unknown } | null;
				// Same host rule as the server: a stored image_url on a refused host is ignored there, so not counted here.
				if (typeof node?.image_url === "string" && isAllowedImageUrl(node.image_url)) {
					row.found++;
					continue;
				}
				const state = await sidecarState(root, scratch, edge.slug);
				if (state === "found" || state === "missing" || state === "unavailable" || state === "conflict") {
					row[state]++;
				} else {
					row.absent++;
				}
			}
			rows.push(row);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	return { rows, totals: sum(rows), skipped };
}

export interface HttpDeps {
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** Called as each artist is done: a production run takes minutes. */
	onArtist?: (row: CoverMeasure) => void;
	/** Why a request failed (redirect, timeout, 5xx...): otherwise a wrong --base reads as 0% found. */
	onProblem?: (message: string) => void;
}

function retryDelayMs(body: unknown, header: string | null): number {
	const fromBody = (body as { retry_after_seconds?: unknown } | null)?.retry_after_seconds;
	const fromHeader = header === null ? Number.NaN : Number(header);
	const seconds =
		typeof fromBody === "number" && Number.isFinite(fromBody)
			? fromBody
			: Number.isFinite(fromHeader)
				? fromHeader
				: DEFAULT_RETRY_SECONDS;
	return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, seconds)) * 1000;
}

export async function measureHttp(
	base: string,
	artists: readonly Slug[],
	deps: HttpDeps = {},
): Promise<CoverReport> {
	const root = new URL(base);
	if (root.protocol !== "http:" && root.protocol !== "https:")
		throw new Error(`--base must be http(s): ${base}`);
	const prefix = base.replace(/\/+$/, "");
	const doFetch = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	// A redirect could send the request to another host: it is an error, not something to follow.
	const get = (url: string): Promise<Response> =>
		doFetch(url, {
			headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

	/** found | none | error for one edge, retrying while the server says pending. */
	const measureEdge = async (slug: string, artist: Slug): Promise<"found" | "none" | "error"> => {
		const url = `${prefix}/image/${encodeURIComponent(slug)}?from=${encodeURIComponent(artist)}`;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			let res: Response;
			let body: unknown;
			try {
				res = await get(url);
				body = await res.json().catch(() => null);
			} catch (e) {
				deps.onProblem?.(`${url}: ${e instanceof Error ? e.message : String(e)}`);
				return "error";
			}
			if (res.status === 202) {
				if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs(body, res.headers.get("Retry-After")));
				continue;
			}
			if (res.status !== 200 || !body || typeof body !== "object") {
				deps.onProblem?.(`${url}: HTTP ${res.status}`);
				return "error";
			}
			const imageUrl = (body as { image_url?: unknown }).image_url;
			return typeof imageUrl === "string" && imageUrl !== "" ? "found" : "none";
		}
		return "none"; // still pending after the last attempt: the page would show no cover either
	};

	const rows: CoverMeasure[] = [];
	const skipped: Slug[] = [];
	for (const artist of artists) {
		let edges: Edge[] | null = null;
		const nodeUrl = `${prefix}/node/${encodeURIComponent(artist)}`;
		try {
			const res = await get(nodeUrl);
			if (res.status === 200) edges = discographyOf(((await res.json()) as { node?: unknown } | null)?.node);
			else deps.onProblem?.(`${nodeUrl}: HTTP ${res.status}`);
		} catch (e) {
			deps.onProblem?.(`${nodeUrl}: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (!edges) {
			skipped.push(artist);
			continue;
		}
		const row = emptyRow(artist);
		for (const edge of edges) {
			row.edges++;
			if (edge.hasMbid) row.withMbid++;
			row[await measureEdge(edge.slug, artist)]++;
		}
		rows.push(row);
		deps.onArtist?.(row);
	}
	return { rows, totals: sum(rows), skipped };
}

function rate(r: CoverMeasure): string {
	return r.edges === 0 ? "n/a" : `${((100 * r.found) / r.edges).toFixed(1)}%`;
}

export function formatReport(mode: "offline" | "http", report: CoverReport): string {
	const unknown = mode === "offline" ? "absent" : "none";
	const columns = [
		"edges",
		"withMbid",
		"found",
		"missing",
		"unavailable",
		"conflict",
		unknown,
		"error",
	] as const;
	const table = [...report.rows, report.totals].map((r) => [
		r.artist === TOTALS_LABEL ? "TOTAL" : r.artist,
		...columns.map((c) => String(r[c])),
		rate(r),
	]);
	const header = ["artist", ...columns, "found/edges"];
	const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => (t[i] ?? "").length)));
	const line = (cells: readonly string[]): string =>
		cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
	const out = [line(header), ...table.map(line)];
	out.push("", `found ${report.totals.found}/${report.totals.edges} (${rate(report.totals)})`);
	if (report.skipped.length > 0) out.push(`skipped (no node, or /node failed): ${report.skipped.join(", ")}`);
	return out.join("\n");
}

/** True when `file` is `dir` itself or under it. A name like `..out.json` is inside, `../out.json` is not. */
export function isInside(dir: string, file: string): boolean {
	const rel = relative(resolve(dir), resolve(file));
	return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** `--artists` value: trimmed, deduplicated (a repeat would be counted twice), every entry an artist slug. */
export function parseArtists(value: string): Slug[] {
	const slugs = [
		...new Set(
			value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
	const bad = slugs.find((s) => !s.startsWith("artist:") || s.length === "artist:".length);
	if (bad) throw new Error(`--artists takes artist slugs ("artist:<name>"), got: ${bad}`);
	return slugs as Slug[];
}

function usage(message?: string): never {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write(
		"usage: measure-discography-covers.ts offline <cache-dir> [--artists <slug,...>] [--json <out>]\n" +
			"       measure-discography-covers.ts http --base <url> --artists <slug,...> [--json <out>]\n",
	);
	process.exit(2);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: { artists: { type: "string" }, base: { type: "string" }, json: { type: "string" } },
	});
	const [mode, cacheDir, ...rest] = positionals;
	const artists = values.artists ? parseArtists(values.artists) : undefined;
	let report: CoverReport;
	let kind: "offline" | "http";
	if (mode === "offline" && cacheDir && rest.length === 0) {
		// The report is the only thing this script writes, and never inside the cache it measures.
		if (values.json && isInside(cacheDir, values.json)) {
			usage("--json must be outside <cache-dir>");
		}
		kind = "offline";
		report = await measureOffline(cacheDir, artists);
	} else if (mode === "http" && cacheDir === undefined && values.base && artists?.length) {
		kind = "http";
		report = await measureHttp(values.base, artists, {
			onArtist: (r) => process.stderr.write(`${r.artist}: ${r.found}/${r.edges} found\n`),
			onProblem: (m) => process.stderr.write(`problem: ${m}\n`),
		});
	} else {
		usage();
	}
	console.log(formatReport(kind, report));
	if (values.json) await writeFile(values.json, `${JSON.stringify({ mode: kind, ...report }, null, "\t")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	});
}
