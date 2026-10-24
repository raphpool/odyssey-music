/**
 * Integrity audit of the committed cache (TRA-448, plan docs/plans/graph-integrity.md, part 0).
 *
 * Measures the defects found by hand on 2026-10-14 (release links to homonyms, zero-edge nodes,
 * literal "\n", missing reciprocal edges, ...) and compares each metric to a committed ceiling
 * (`data/integrity-thresholds.json`). The ceilings start at the measured values; the CI ratchet
 * that lowers them is a separate ticket (TRA-461).
 *
 * Nodes are read as raw JSON, never through `NodeCache.get`: the Zod schema strips undeclared
 * fields, which would hide exactly the drift this audit exists to see.
 *
 * `artist-edge-to-redirect-key` also needs the slug-redirects table (`data/slug-redirects.json`, or
 * `--redirects <file>`): an unreadable table is a usage error (exit 2), never a silent 0 (TRA-598).
 *
 * Read-only: nothing is ever written under <cache-dir>.
 *
 * Usage: audit-cache.ts <cache-dir> [--thresholds <file>] [--redirects <file>] [--json <file>]
 * Exit:  0 no metric above its ceiling, 1 at least one violation, 2 usage or read error.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { unescapeQuotes } from "../src/editorial-text.js";
import { parseSlugRedirects } from "../src/genre-registry.js";
import { EDGE_FIELDS_BY_TYPE, NODE_TYPES, type NodeType, REVERSE_EDGE_PAIRS } from "../src/node-spec.js";

export type RawNode = Record<string, unknown>;
export type MetricValue = number | Record<string, number>;

export interface AuditReport {
	generatedAt: string;
	nodeCount: Record<NodeType, number>;
	metrics: Record<string, MetricValue>;
	samples: Record<string, string[]>;
	/** Full case lists (unlike the 10-slug `samples`), for the metrics whose cases feed a data ticket. */
	cases: Record<string, string[]>;
}

export type Thresholds = Record<string, MetricValue>;

export interface Violation {
	metric: string;
	/** Present for per-type / per-pair metrics. */
	key?: string;
	measured: number;
	/** `null` when the thresholds file has no entry for this metric: forgetting one is a violation. */
	threshold: number | null;
}

/** Reported for context, never compared: they describe the normal state of the frontier. */
export const INFORMATIVE_METRICS: ReadonlySet<string> = new Set([
	"dangling-edges",
	"edge-name-drift",
	"pending-reverse-targets-existing",
	// Counted per edge, so no per-artist allowance can cover it; the ratcheted twin is
	// artist-discography-without-mbid (TRA-616, amends 8-D6).
	"discography-edge-without-mbid",
	// The redirect leads to a node the repo cache does not hold (prod-only work, TRA-484), so its credit cannot
	// be judged here and the count rises with every backfill that adds a right identity (2026-10-23, TRA-598:
	// #531 would have taken it from 8 to 11 with three correct ones, and turned the integrity job red). Its
	// ceilinged twin is artist-edge-to-redirect-key, which only counts a target it can read.
	"artist-edge-to-redirect-key-unresolved",
]);

/**
 * Coverage metrics count nodes that are still missing an enrichment (image, similar artists, a second
 * citation...). Unlike correctness metrics they rise legitimately when a batch ADDS nodes that are not
 * enriched yet, so the ratchet (scripts/ci/threshold-ratchet.ts, TRA-498) lets their ceiling grow by at
 * most the growth of the node count of the type they measure. Value: that node type, or `null` when the
 * metric is keyed by node type. Every other metric stays strict.
 */
const COVERAGE_METRICS: ReadonlyMap<string, NodeType | null> = new Map([
	["missing-image", null],
	["single-citation", null],
	["missing-similar-artists", "artist"],
	["missing-landmark-project", "artist"],
	["missing-reference-track", "artist"],
	// An added artist contributes at most 1 to each (TRA-616): a Gemini list has no mbid, a MusicBrainz
	// list can keep fewer than 3 release groups, and neither can be fixed on the data side.
	["artist-discography-under-3", "artist"],
	["artist-discography-without-mbid", "artist"],
]);

/** The node type whose growth may absorb a rise of this metric (or metric key), `null` for strict metrics. */
export function coverageNodeType(metric: string, key?: string): NodeType | null {
	const type = COVERAGE_METRICS.get(metric);
	if (type === undefined) return null;
	if (type !== null) return key === undefined ? type : null;
	return NODE_TYPES.find((t) => t === key) ?? null;
}

const SAMPLE_LIMIT = 10;
const IMAGE_FIELDS = ["image_url", "photo_url", "cover_url"] as const;
const RELEASE_LINK_FIELDS = ["discography", "notable_tracks"] as const;
/**
 * Every artist edge field that points at a work (project or track): the ones a redirect can misroute
 * (TRA-598). Derived from the node spec so a new such field gets measured, and then needs its ceiling.
 */
const ARTIST_WORK_FIELDS: readonly string[] = Object.entries(EDGE_FIELDS_BY_TYPE.artist)
	.filter(([, spec]) => spec.targets.some((t) => t === "project" || t === "track"))
	.map(([field]) => field);

interface ReciprocityPair {
	sourceType: NodeType;
	sourceField: string;
	targetType: NodeType;
	targetField: string;
}

function pairKey(p: ReciprocityPair): string {
	return `${p.sourceType}.${p.sourceField}->${p.targetType}.${p.targetField}`;
}

function reciprocityPairs(): ReciprocityPair[] {
	const pairs: ReciprocityPair[] = [];
	const seen = new Set<string>();
	for (const { sourceType, sourceField, reverse } of REVERSE_EDGE_PAIRS) {
		const spec = (EDGE_FIELDS_BY_TYPE[sourceType] as Record<string, { targets: readonly NodeType[] }>)[
			sourceField
		];
		for (const targetType of spec?.targets ?? []) {
			const pair = { sourceType, sourceField, targetType, targetField: reverse.field };
			if (seen.has(pairKey(pair))) continue;
			seen.add(pairKey(pair));
			pairs.push(pair);
		}
	}
	return pairs;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Edge references of one field, whatever its cardinality; malformed entries are ignored. */
function edgesOf(node: RawNode, field: string): { slug: string; name: string | undefined }[] {
	const raw = node[field];
	const items = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	const out: { slug: string; name: string | undefined }[] = [];
	for (const item of items) {
		if (isRecord(item) && typeof item.slug === "string" && item.slug) {
			out.push({ slug: item.slug, name: typeof item.name === "string" ? item.name : undefined });
		}
	}
	return out;
}

function nodeType(slug: string): NodeType | undefined {
	const type = slug.slice(0, Math.max(slug.indexOf(":"), 0));
	return (NODE_TYPES as readonly string[]).includes(type) ? (type as NodeType) : undefined;
}

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nameOf(node: RawNode): string | undefined {
	return typeof node.name === "string" ? node.name : undefined;
}

function hasText(v: unknown): boolean {
	return typeof v === "string" && v.trim() !== "";
}

/**
 * A top-level string holding a backslash + quote that `unescapeQuotes` would turn into a quote (TRA-577):
 * the same double escaping as the `\n` of `literal-newlines`, which does not see it. Asking the normalizer
 * keeps the measure and the fix in step: a `\"` it keeps on purpose (escaped backslash, code block) is not
 * counted, so 0 stays reachable. Like `literal-newlines`, it reads the top-level strings of the node: the
 * titles inside `citations` are not looked at.
 */
function hasLiteralEscapedQuote(node: RawNode): boolean {
	return Object.values(node).some((v) => typeof v === "string" && unescapeQuotes(v) !== v);
}

class Collector {
	readonly metrics: Record<string, MetricValue> = {};
	readonly samples: Record<string, string[]> = {};
	readonly cases: Record<string, string[]> = {};

	scalar(metric: string): void {
		this.metrics[metric] = 0;
	}

	keyed(metric: string, keys: readonly string[]): void {
		this.metrics[metric] = Object.fromEntries(keys.map((k) => [k, 0]));
	}

	hit(metric: string, slug: string, key?: string): void {
		const current = this.metrics[metric];
		if (key === undefined) {
			this.metrics[metric] = (current as number) + 1;
		} else {
			const bucket = current as Record<string, number>;
			bucket[key] = (bucket[key] ?? 0) + 1;
		}
		this.sample(key === undefined ? metric : `${metric}[${key}]`, slug);
	}

	/** Keeps every case of a metric, in cache order. */
	addCase(metric: string, description: string): void {
		const list = this.cases[metric] ?? [];
		this.cases[metric] = list;
		list.push(description);
	}

	/** Keeps the first SAMPLE_LIMIT distinct slugs seen for a metric. */
	sample(sampleKey: string, slug: string): void {
		const list = this.samples[sampleKey] ?? [];
		this.samples[sampleKey] = list;
		if (list.length < SAMPLE_LIMIT && !list.includes(slug)) list.push(slug);
	}
}

/**
 * Whether one of the credited slugs is `slug` itself or a group whose `members` include it
 * (Roni Size -> New Forms, credited to Reprazent).
 */
function creditsArtist(nodes: Map<string, RawNode>, credited: readonly string[], slug: string): boolean {
	return credited.some(
		(creditedSlug) =>
			creditedSlug === slug || edgesOf(nodes.get(creditedSlug) ?? {}, "members").some((m) => m.slug === slug),
	);
}

/** The artists and producers a release or track credits. */
function creditedSlugs(target: RawNode): string[] {
	return [...edgesOf(target, "artists"), ...edgesOf(target, "producers")].map((e) => e.slug);
}

/**
 * Computes every metric over the raw nodes of a cache.
 * `pendingReverseKeys` are the keys of `cache/pending-reverses.json`: they are not nodes, so
 * they come in separately. `redirects` is the slug-redirects table (old slug -> canonical slug); empty
 * by default, in which case `artist-edge-to-redirect-key` is 0.
 */
export function auditNodes(
	nodes: Map<string, RawNode>,
	pendingReverseKeys: Iterable<string> = [],
	redirects: ReadonlyMap<string, string> = new Map(),
): AuditReport {
	const c = new Collector();
	const typeKeys: readonly string[] = NODE_TYPES;
	const pairs = reciprocityPairs();

	for (const m of [
		"homonym-release-links",
		"release-links-to-empty-credit",
		"zero-edge-nodes",
		"self-edges",
		"duplicate-names",
		"unscoped-release-slugs",
		"literal-newlines",
		"literal-escaped-quotes",
		"missing-similar-artists",
		"missing-landmark-project",
		"missing-reference-track",
		"dangling-edges",
		"edge-name-drift",
		"pending-reverse-targets-existing",
		"discography-edge-without-mbid",
		"artist-discography-under-3",
		"artist-discography-without-mbid",
		"artist-edge-to-redirect-key-unresolved",
	]) {
		c.scalar(m);
	}
	c.keyed("artist-edge-to-redirect-key", ARTIST_WORK_FIELDS);
	c.keyed("empty-artists", ["project", "track"]);
	c.keyed("single-citation", typeKeys);
	c.keyed("missing-image", typeKeys);
	c.keyed("reciprocity-missing", pairs.map(pairKey));

	const nodeCount = Object.fromEntries(NODE_TYPES.map((t) => [t, 0])) as Record<NodeType, number>;
	const namesByType = new Map<string, Map<string, string[]>>();

	for (const [slug, node] of nodes) {
		const type = nodeType(slug);
		if (!type) continue;
		nodeCount[type] += 1;

		const edgeFields = Object.keys(EDGE_FIELDS_BY_TYPE[type]);
		let outgoing = 0;
		for (const field of edgeFields) {
			for (const edge of edgesOf(node, field)) {
				outgoing += 1;
				if (edge.slug === slug) c.hit("self-edges", slug);
				const target = nodes.get(edge.slug);
				if (!target) {
					c.hit("dangling-edges", slug);
					continue;
				}
				const targetName = nameOf(target);
				if (edge.name !== undefined && targetName !== undefined) {
					if (normalizeName(edge.name) !== normalizeName(targetName)) c.hit("edge-name-drift", slug);
				}
			}
		}
		if (outgoing === 0) c.hit("zero-edge-nodes", slug);

		for (const value of Object.values(node)) {
			// A literal backslash + n is a rendering bug: the front prints it as-is (pre-wrap).
			if (typeof value === "string" && value.includes("\\n")) {
				c.hit("literal-newlines", slug);
				break;
			}
		}

		if (hasLiteralEscapedQuote(node)) c.hit("literal-escaped-quotes", slug);

		const citations = node.citations;
		if (Array.isArray(citations) && citations.length === 1) c.hit("single-citation", slug, type);
		if (!IMAGE_FIELDS.some((f) => hasText(node[f]))) c.hit("missing-image", slug, type);

		if (type === "project" || type === "track") {
			if (edgesOf(node, "artists").length === 0) c.hit("empty-artists", slug, type);
			if (!slug.slice(slug.indexOf(":") + 1).includes("--")) c.hit("unscoped-release-slugs", slug);
		}

		if (type === "artist") {
			if (edgesOf(node, "similar_artists").length === 0) c.hit("missing-similar-artists", slug);
			if (edgesOf(node, "landmark_project").length === 0) c.hit("missing-landmark-project", slug);
			if (edgesOf(node, "reference_track").length === 0) c.hit("missing-reference-track", slug);
			// Discography quality (TRA-616): an edge without an MBID could not be tied to a MusicBrainz release
			// group, and a short discography is often a truncated lookup. The per-edge count is informative
			// (one artist adds up to 10 edges); the ratcheted twin counts artists with at least one such edge.
			// Raw entries are counted on purpose (the ticket's contract), not through edgesOf.
			const discography = Array.isArray(node.discography) ? node.discography : [];
			let withoutMbid = 0;
			for (const entry of discography) {
				if (!(isRecord(entry) && hasText(entry.mbid))) {
					c.hit("discography-edge-without-mbid", slug);
					withoutMbid += 1;
				}
			}
			if (withoutMbid > 0) c.hit("artist-discography-without-mbid", slug);
			if (discography.length < 3) c.hit("artist-discography-under-3", slug);
			for (const field of RELEASE_LINK_FIELDS) {
				for (const edge of edgesOf(node, field)) {
					const target = nodes.get(edge.slug);
					if (!target) continue;
					const credited = creditedSlugs(target);
					if (edgesOf(target, "artists").length === 0) c.hit("release-links-to-empty-credit", slug);
					if (credited.length === 0) continue;
					if (!creditsArtist(nodes, credited, slug)) c.hit("homonym-release-links", slug);
				}
			}

			// TRA-598: an edge whose slug is a redirect key. A read follows the redirect, and it can lead to
			// another artist's work (the-byrds -> track:mr-tambourine-man -> --bob-dylan). The two metrics above
			// never see it: they skip a target that is not a live node, and a redirect key is not one. A live
			// node wins over the redirect (resolveReadSlug), so such an edge is not misrouted and is skipped.
			// The per-field metric reads the credit of the resolved node (an empty credit credits no one, so it
			// counts). A target missing from the repo cache (prod-only work, TRA-484) cannot be judged here: it
			// is only reported, as informative, with its cases.
			for (const field of ARTIST_WORK_FIELDS) {
				for (const edge of edgesOf(node, field)) {
					const resolved = redirects.get(edge.slug);
					if (resolved === undefined || nodes.has(edge.slug)) continue;
					const target = nodes.get(resolved);
					if (target === undefined) {
						c.hit("artist-edge-to-redirect-key-unresolved", slug);
						c.addCase(
							"artist-edge-to-redirect-key-unresolved",
							`${slug} ${field} ${edge.slug} -> ${resolved}`,
						);
					} else if (!creditsArtist(nodes, creditedSlugs(target), slug)) {
						c.hit("artist-edge-to-redirect-key", slug, field);
						c.addCase("artist-edge-to-redirect-key", `${slug} ${field} ${edge.slug} -> ${resolved}`);
					}
				}
			}
		}

		const name = nameOf(node);
		const normalized = name === undefined ? "" : normalizeName(name);
		if (normalized) {
			const byName = namesByType.get(type) ?? new Map<string, string[]>();
			byName.set(normalized, [...(byName.get(normalized) ?? []), slug]);
			namesByType.set(type, byName);
		}
	}

	for (const byName of namesByType.values()) {
		for (const group of byName.values()) {
			if (group.length < 2) continue;
			c.hit("duplicate-names", group[0] as string);
			for (const extra of group.slice(1)) c.sample("duplicate-names", extra);
		}
	}

	for (const pair of pairs) {
		for (const [slug, node] of nodes) {
			if (nodeType(slug) !== pair.sourceType) continue;
			for (const edge of edgesOf(node, pair.sourceField)) {
				const target = nodes.get(edge.slug);
				if (!target) continue;
				if (!edgesOf(target, pair.targetField).some((back) => back.slug === slug)) {
					c.hit("reciprocity-missing", slug, pairKey(pair));
				}
			}
		}
	}

	for (const key of pendingReverseKeys) {
		if (nodes.has(key)) c.hit("pending-reverse-targets-existing", key);
	}

	return {
		generatedAt: new Date().toISOString(),
		nodeCount,
		metrics: c.metrics,
		samples: c.samples,
		cases: c.cases,
	};
}

/** One violation per metric (or metric key) whose value exceeds its ceiling or has none. */
export function compareWithThresholds(report: AuditReport, thresholds: Thresholds): Violation[] {
	const violations: Violation[] = [];
	for (const [metric, measured] of Object.entries(report.metrics)) {
		if (INFORMATIVE_METRICS.has(metric)) continue;
		const ceiling = thresholds[metric];
		if (typeof measured === "number") {
			const threshold = typeof ceiling === "number" ? ceiling : null;
			if (threshold === null || measured > threshold) violations.push({ metric, measured, threshold });
			continue;
		}
		for (const [key, value] of Object.entries(measured)) {
			const keyed = isRecord(ceiling) ? ceiling[key] : undefined;
			const threshold = typeof keyed === "number" ? keyed : null;
			if (threshold === null || value > threshold)
				violations.push({ metric, key, measured: value, threshold });
		}
	}
	return violations;
}

/** Ceilings equal to the measured values (informative metrics have none). */
export function thresholdsFromReport(report: AuditReport): Thresholds {
	return Object.fromEntries(
		Object.entries(report.metrics)
			.filter(([m]) => !INFORMATIVE_METRICS.has(m))
			.map(([m, v]) => [m, typeof v === "number" ? v : { ...v }]),
	);
}

export function formatViolation(v: Violation): string {
	const name = v.key === undefined ? v.metric : `${v.metric}[${v.key}]`;
	return `${name} ${v.measured} > ${v.threshold === null ? "(no threshold)" : v.threshold}`;
}

export function formatReport(report: AuditReport, thresholds: Thresholds): string {
	const lines = [`nodes: ${NODE_TYPES.map((t) => `${t} ${report.nodeCount[t]}`).join(", ")}`];
	const row = (name: string, measured: number, ceiling: unknown, informative: boolean): string => {
		const limit = informative
			? "informative"
			: typeof ceiling === "number"
				? `threshold ${ceiling}`
				: "no threshold";
		return `${name.padEnd(52)} ${String(measured).padStart(7)}  (${limit})`;
	};
	for (const [metric, measured] of Object.entries(report.metrics)) {
		const informative = INFORMATIVE_METRICS.has(metric);
		const ceiling = thresholds[metric];
		if (typeof measured === "number") {
			lines.push(row(metric, measured, ceiling, informative));
			continue;
		}
		for (const [key, value] of Object.entries(measured)) {
			lines.push(row(`${metric}[${key}]`, value, isRecord(ceiling) ? ceiling[key] : undefined, informative));
		}
	}
	return lines.join("\n");
}

// --- Disk I/O (read-only) ---

export async function readRawNodes(
	root: string,
): Promise<{ nodes: Map<string, RawNode>; invalid: { path: string; error: string }[] }> {
	const nodes = new Map<string, RawNode>();
	const invalid: { path: string; error: string }[] = [];
	for (const type of NODE_TYPES) {
		const dir = join(root, "nodes", type);
		let files: string[];
		try {
			files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw e;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
				if (!isRecord(parsed)) throw new Error("node file is not a JSON object");
				nodes.set(`${type}:${basename(file, ".json")}`, parsed);
			} catch (e) {
				invalid.push({ path, error: e instanceof Error ? e.message : String(e) });
			}
		}
	}
	return { nodes, invalid };
}

async function readPendingReverseKeys(root: string): Promise<string[]> {
	try {
		const parsed = JSON.parse(await readFile(join(root, "pending-reverses.json"), "utf8")) as unknown;
		return isRecord(parsed) ? Object.keys(parsed) : [];
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
}

const thresholdsSchema = z.record(z.string(), z.union([z.number(), z.record(z.string(), z.number())]));

export function parseThresholds(raw: unknown): Thresholds {
	return thresholdsSchema.parse(raw);
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	thresholdsPath: string;
	redirectsPath: string;
	jsonPath?: string;
}

export function defaultThresholdsPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "data", "integrity-thresholds.json");
}

export function defaultRedirectsPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "data", "slug-redirects.json");
}

export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	let cacheDir: string | undefined;
	let thresholdsPath = defaultThresholdsPath();
	let redirectsPath = defaultRedirectsPath();
	let jsonPath: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--thresholds" || arg === "--redirects" || arg === "--json") {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) return null;
			if (arg === "--thresholds") thresholdsPath = value;
			else if (arg === "--redirects") redirectsPath = value;
			else jsonPath = value;
		} else if (arg.startsWith("--") || cacheDir !== undefined) {
			return null;
		} else {
			cacheDir = arg;
		}
	}
	if (cacheDir === undefined) return null;
	return { cacheDir, thresholdsPath, redirectsPath, ...(jsonPath === undefined ? {} : { jsonPath }) };
}

const USAGE =
	"usage: audit-cache.ts <cache-dir> [--thresholds <file>] [--redirects <file>] [--json <file>]\n";

export async function main(argv: readonly string[]): Promise<number> {
	const args = parseCliArgs(argv);
	if (!args) {
		process.stderr.write(USAGE);
		return 2;
	}
	if (args.jsonPath !== undefined) {
		const rel = relative(resolve(args.cacheDir), resolve(args.jsonPath));
		if (rel === "" || !(rel.startsWith("..") || isAbsolute(rel))) {
			process.stderr.write(
				`error: --json ${args.jsonPath} is inside the cache directory; the audit never writes there\n`,
			);
			return 2;
		}
	}
	let thresholds: Thresholds;
	try {
		thresholds = parseThresholds(JSON.parse(await readFile(args.thresholdsPath, "utf8")));
	} catch (e) {
		process.stderr.write(
			`error: cannot read thresholds ${args.thresholdsPath}: ${e instanceof Error ? e.message : String(e)}\n`,
		);
		return 2;
	}
	// The redirect table is an input of a metric: reading none would report 0 and look clean.
	let redirects: ReadonlyMap<string, string>;
	try {
		redirects = parseSlugRedirects(JSON.parse(await readFile(args.redirectsPath, "utf8")));
	} catch (e) {
		process.stderr.write(
			`error: cannot read redirects ${args.redirectsPath}: ${e instanceof Error ? e.message : String(e)}\n`,
		);
		return 2;
	}
	let nodes: Map<string, RawNode>;
	let pendingKeys: string[];
	try {
		const read = await readRawNodes(args.cacheDir);
		for (const { path, error } of read.invalid) {
			process.stderr.write(`error: unreadable node file ${path}: ${error}\n`);
		}
		// An unreadable node would silently lower the counts: refuse to certify a partial cache.
		if (read.invalid.length > 0) return 2;
		if (read.nodes.size === 0) {
			process.stderr.write(`error: no node found under ${join(args.cacheDir, "nodes")}\n`);
			return 2;
		}
		nodes = read.nodes;
		pendingKeys = await readPendingReverseKeys(args.cacheDir);
	} catch (e) {
		process.stderr.write(
			`error: cannot read cache ${args.cacheDir}: ${e instanceof Error ? e.message : String(e)}\n`,
		);
		return 2;
	}

	const report = auditNodes(nodes, pendingKeys, redirects);
	if (args.jsonPath) {
		try {
			await writeFile(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		} catch (e) {
			process.stderr.write(
				`error: cannot write ${args.jsonPath}: ${e instanceof Error ? e.message : String(e)}\n`,
			);
			return 2;
		}
	}
	console.log(formatReport(report, thresholds));
	for (const [metric, cases] of Object.entries(report.cases)) {
		console.log(`\n${metric}: ${cases.length} case(s)`);
		for (const line of cases) console.log(`  ${line}`);
	}
	const violations = compareWithThresholds(report, thresholds);
	for (const v of violations) process.stderr.write(`${formatViolation(v)}\n`);
	return violations.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// Guarded so importing this module from a test doesn't run the CLI.
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e: unknown) => {
			process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
			process.exit(2);
		},
	);
}
