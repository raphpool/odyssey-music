/**
 * Merge the label nodes that exist twice (TRA-600, plan docs/plans/graph-integrity.md): `label:warp` (8 artists)
 * and `label:warp-records` (26) are one label, and the fiche of "Warp" looked poor. Offline and deterministic:
 * the identity of each group is NOT guessed here, it is read from the proof table next to this file
 * (2026-10-20-merge-duplicate-labels.identities.json: MusicBrainz label + Wikidata item, looked up by hand on
 * 2026-10-18). No label of the cache carries an `mbid`, so the name alone proves nothing (six MusicBrainz labels
 * are called "Axis Records").
 *
 * A group is the labels sharing a normalized name (lower case, without "records / recordings / music", only
 * letters and digits). It is merged only when its table entry is `proven` AND the cache agrees with the proof:
 * - the two sources link each other (MusicBrainz relation to the QID, or Wikidata P966 listing the mbid) and
 *   neither contradicts the other;
 * - every member of the group in the cache is covered by the entry, is named like the entity (MusicBrainz name or
 *   alias, Wikidata label or alias), and carries the Wikidata inception year in `founded` when it has one;
 * - every `anchors` string (a name only the real label's article gives, e.g. "Jeff Mills" for Axis) is in the
 *   article of every member.
 * Anything else (no entry, `refused` entry, one failed check) is left untouched and listed in `refused`.
 *
 * Merge: the survivor is the member named like the MusicBrainz name, else the richest (most edges), else the
 * lowest slug. Its lists (genres, roster, notable_releases) become the union without duplicates; a text field it
 * lacks (founded, location, founders, active_years, image) is taken from a loser; prose is never merged. Every
 * `artist.labels`, `project.label`, `track.label`, `genre.key_labels` edge and every pending-reverses.json entry
 * naming a loser points at the survivor, with the survivor's name (the audit counts a stale name as drift), a
 * list deduplicated when an artist cited both. The loser file is deleted and `label:<loser> -> label:<survivor>`
 * goes into slug-redirects.json (`--data-dir`, else the repo's data/).
 *
 * Dry-run by default; `--apply` writes. Idempotent: once merged, the group no longer exists. Every node to write
 * is validated (nodePayloadSchema) before the first write; one error blocks the whole run (exit 1, 2 with
 * --apply). Apply order: survivors, nodes that pointed at a loser, pending-reverses.json, redirects, THEN the
 * deletion of the losers, so a crash leaves a duplicate (harmless) and never a dangling edge.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it
 * passes; the manifest declares `removed` (the loser files), `renamed` (empty: nothing is renamed) and
 * `redirects`. It holds no timestamp, so two runs on the same cache give the same bytes.
 *
 * Usage: tsx scripts/migrations/2026-10-20-merge-duplicate-labels.ts <cache-dir> [--apply]
 *        [--manifest out/merge-duplicate-labels.json] [--data-dir <dir>]
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { parseSlugRedirects } from "../../src/genre-registry.js";
import { EDGE_FIELDS_BY_TYPE, type NodeType } from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	type CacheNodeFile,
	defaultDataDir,
	isRecord,
	looksLikeCacheDir,
	mergeRedirects,
	readCacheNodes,
	readTextOrDefault,
	rewritePendingReverses,
	unionListField,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-20-merge-duplicate-labels";
export const DEFAULT_MANIFEST_PATH = "out/merge-duplicate-labels.json";
export const IDENTITIES_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	`${MIGRATION_NAME}.identities.json`,
);

type Obj = Record<string, unknown>;

const labelSlug = z.string().regex(/^label:[a-z0-9]+(-[a-z0-9]+)*$/);
const base = { key: z.string().min(1), members: z.array(labelSlug).min(2), evidence: z.array(z.string()) };
const qid = z.string().regex(/^Q[0-9]+$/);
const identitiesSchema = z.object({
	source: z.string(),
	groups: z.array(
		z.discriminatedUnion("status", [
			z.object({
				...base,
				status: z.literal("proven"),
				mb: z.object({
					mbid: z.string().uuid(),
					name: z.string(),
					aliases: z.array(z.string()),
					wikidata: qid.nullable(),
				}),
				wd: z.object({
					qid,
					label: z.string(),
					aliases: z.array(z.string()),
					inception: z.number().int().nullable(),
					mbids: z.array(z.string().uuid()),
				}),
				anchors: z.array(z.string()),
			}),
			z.object({ ...base, status: z.literal("refused"), reason: z.string().min(1) }),
		]),
	),
});
export type Identities = z.infer<typeof identitiesSchema>;
type Proven = Extract<Identities["groups"][number], { status: "proven" }>;

const pendingFileSchema = z.record(
	z.string(),
	z.array(
		z.object({
			field: z.string(),
			cardinality: z.enum(["list", "single"]),
			edge: z.object({ slug: z.string(), type: z.string(), name: z.string() }).passthrough(),
		}),
	),
);
type PendingFile = Record<string, PendingReverse[]>;

/** "Warp Records" and "Warp" give the same key; so do "E.G. Records" and "EG Records". */
export function groupKey(name: string): string {
	return name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/\b(records?|recordings?|music)\b/g, "")
		.replace(/[^a-z0-9]/g, "");
}
const looseName = (name: string): string =>
	name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");

const LIST_FIELDS = ["genres", "roster", "notable_releases"] as const;
const SCALAR_FIELDS = ["founded", "location", "founders", "active_years"] as const;

export interface Refusal {
	key: string;
	members: string[];
	reason: string;
	detail: string;
}
export interface MergedGroup {
	key: string;
	survivor: string;
	losers: string[];
	chosenBy: "musicbrainz-name" | "richest" | "slug";
	mbid: string;
	qid: string;
	rosterBefore: Record<string, number>;
	rosterAfter: number;
}
export interface Manifest {
	migration: string;
	mode: "dry-run" | "apply";
	blocked: boolean;
	written: number;
	merged: MergedGroup[];
	refused: Refusal[];
	/** Edges re-pointed at a survivor, by "type.field". */
	rewritten: Record<string, number>;
	pendingRewritten: number;
	/** The channel's contract: the loser files, nothing renamed, the redirects to commit. */
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	errors: string[];
}

const edgeCount = (n: Obj): number =>
	LIST_FIELDS.reduce((sum, f) => sum + (Array.isArray(n[f]) ? n[f].length : 0), 0);
const sorted = <T>(items: readonly T[], by: (t: T) => string): T[] =>
	[...items].sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0));
const yearOf = (founded: unknown): number | null => {
	const m = typeof founded === "string" ? /\b(\d{4})\b/.exec(founded) : null;
	return m ? Number(m[1]) : null;
};

/** Why a group the table calls `proven` is still not safe to merge in this cache, or null when it is. */
export function contradiction(
	entry: Proven,
	members: readonly CacheNodeFile[],
): { reason: string; detail: string } | null {
	const { mb, wd } = entry;
	if (mb.wikidata === null && !wd.mbids.includes(mb.mbid))
		return {
			reason: "sources-not-linked",
			detail: "neither MusicBrainz names the QID nor Wikidata lists the mbid",
		};
	if (mb.wikidata !== null && mb.wikidata !== wd.qid)
		return {
			reason: "sources-contradict",
			detail: `MusicBrainz links ${mb.wikidata}, the proof is ${wd.qid}`,
		};
	if (wd.mbids.length > 0 && !wd.mbids.includes(mb.mbid))
		return { reason: "sources-contradict", detail: `Wikidata ${wd.qid} does not list ${mb.mbid}` };
	const names = new Set([mb.name, ...mb.aliases, wd.label, ...wd.aliases].map(looseName));
	for (const m of members) {
		if (!entry.members.includes(m.slug))
			return { reason: "member-not-covered", detail: `${m.slug} is not in the proof` };
		if (!names.has(looseName(String(m.node.name ?? ""))))
			return {
				reason: "name-mismatch",
				detail: `${m.slug} (${String(m.node.name)}) is no name of ${mb.mbid}`,
			};
		const year = yearOf(m.node.founded);
		if (wd.inception !== null && year !== null && year !== wd.inception)
			return {
				reason: "founded-mismatch",
				detail: `${m.slug} founded ${year}, ${wd.qid} says ${wd.inception}`,
			};
		for (const anchor of entry.anchors) {
			if (!String(m.node.editorial_article ?? "").includes(anchor))
				return { reason: "anchor-missing", detail: `${m.slug} never mentions "${anchor}"` };
		}
	}
	return null;
}

/** The survivor: named like MusicBrainz, else the richest, else the lowest slug. */
export function electSurvivor(
	entry: Proven,
	members: readonly CacheNodeFile[],
): { survivor: CacheNodeFile; chosenBy: MergedGroup["chosenBy"] } {
	const named = members.filter((m) => looseName(String(m.node.name ?? "")) === looseName(entry.mb.name));
	const pool = named.length > 0 ? named : members;
	const top = Math.max(...pool.map((m) => edgeCount(m.node)));
	const richest = sorted(
		pool.filter((m) => edgeCount(m.node) === top),
		(m) => m.slug,
	);
	const survivor = richest[0] as CacheNodeFile;
	if (named.length === 1) return { survivor, chosenBy: "musicbrainz-name" };
	return { survivor, chosenBy: richest.length === 1 ? "richest" : "slug" };
}

function mergeInto(survivor: Obj, losers: readonly Obj[]): Obj {
	const merged: Obj = { ...survivor };
	for (const f of LIST_FIELDS) {
		const own = Array.isArray(survivor[f]) ? (survivor[f] as unknown[]) : [];
		merged[f] = unionListField(
			own,
			losers.map((l) => (Array.isArray(l[f]) ? (l[f] as unknown[]) : [])),
		);
	}
	const lacks = (n: Obj, f: string): boolean => typeof n[f] !== "string" || n[f] === "";
	for (const f of SCALAR_FIELDS) {
		const donor = losers.find((l) => !lacks(l, f));
		if (lacks(merged, f) && donor) merged[f] = donor[f];
	}
	const imageDonor = losers.find((l) => !lacks(l, "image_url"));
	if (lacks(merged, "image_url") && imageDonor) {
		merged.image_url = imageDonor.image_url;
		if (imageDonor.image_source !== undefined) merged.image_source = imageDonor.image_source;
	}
	return merged;
}

/** Fields of `type` whose edges point at a label. */
function labelFields(type: NodeType): string[] {
	return Object.entries(EDGE_FIELDS_BY_TYPE[type])
		.filter(([, spec]) => (spec.targets as readonly string[]).includes("label"))
		.map(([field]) => field);
}

/** The node with every label edge to a loser pointing at its survivor, or null when none does. */
function repoint(
	node: Obj,
	type: NodeType,
	to: ReadonlyMap<string, { slug: string; name: string }>,
	hits: Map<string, number>,
): Obj | null {
	let next: Obj | null = null;
	for (const field of labelFields(type)) {
		const value = node[field];
		const edges = Array.isArray(value) ? value : [value];
		if (!edges.some((e) => isRecord(e) && typeof e.slug === "string" && to.has(e.slug))) continue;
		const seen = new Set<string>();
		const rewritten = edges.flatMap((e) => {
			if (!isRecord(e) || typeof e.slug !== "string") return [e];
			const target = to.get(e.slug);
			const edge = target ? { ...e, slug: target.slug, name: target.name } : e;
			if (target) hits.set(`${type}.${field}`, (hits.get(`${type}.${field}`) ?? 0) + 1);
			if (seen.has(edge.slug as string)) return [];
			seen.add(edge.slug as string);
			return [edge];
		});
		next = { ...(next ?? node), [field]: Array.isArray(value) ? rewritten : rewritten[0] };
	}
	return next;
}

export interface Plan {
	/** Node to write, by file path: survivors first, then the nodes that pointed at a loser. */
	writes: Map<string, Obj>;
	deletions: string[];
	pending: PendingFile | null;
	redirects: Record<string, string>;
	manifest: Manifest;
}

/** Pure plan: what to merge, write and report. Does not touch the disk. */
export function planMerge(
	nodes: readonly CacheNodeFile[],
	pending: PendingFile,
	identities: Identities,
): Plan {
	const manifest: Manifest = {
		migration: MIGRATION_NAME,
		mode: "dry-run",
		blocked: false,
		written: 0,
		merged: [],
		refused: [],
		rewritten: {},
		pendingRewritten: 0,
		removed: [],
		renamed: {},
		redirects: {},
		errors: [],
	};
	const groups = new Map<string, CacheNodeFile[]>();
	for (const n of nodes) {
		if (n.type !== "label") continue;
		const key = groupKey(String(n.node.name ?? ""));
		groups.set(key, [...(groups.get(key) ?? []), n]);
	}
	const survivors = new Map<string, Obj>();
	const repointTo = new Map<string, { slug: string; name: string }>();
	const losers = new Map<string, CacheNodeFile>();
	for (const [key, members] of sorted([...groups], ([k]) => k)) {
		if (members.length < 2) continue;
		const slugs = sorted(members, (m) => m.slug).map((m) => m.slug);
		const entry = identities.groups.find((g) => g.key === key);
		const refuse = (reason: string, detail: string): void => {
			manifest.refused.push({ key, members: slugs, reason, detail });
		};
		if (!entry) refuse("no-identity-proof", "no entry in the proof table");
		else if (entry.status === "refused") refuse("identity-not-proven", entry.reason);
		else {
			const bad = contradiction(entry, members);
			if (bad) {
				refuse(bad.reason, bad.detail);
				continue;
			}
			const { survivor, chosenBy } = electSurvivor(entry, members);
			const others = sorted(
				members.filter((m) => m !== survivor),
				(m) => m.slug,
			);
			survivors.set(
				survivor.path,
				mergeInto(
					survivor.node,
					others.map((o) => o.node),
				),
			);
			for (const l of others) {
				losers.set(l.slug, l);
				repointTo.set(l.slug, { slug: survivor.slug, name: String(survivor.node.name) });
				manifest.redirects[l.slug] = survivor.slug;
				manifest.removed.push(`nodes/label/${l.slug.slice("label:".length)}.json`);
			}
			manifest.merged.push({
				key,
				survivor: survivor.slug,
				losers: others.map((o) => o.slug),
				chosenBy,
				mbid: entry.mb.mbid,
				qid: entry.wd.qid,
				rosterBefore: Object.fromEntries(
					sorted(members, (m) => m.slug).map((m) => [
						m.slug,
						Array.isArray(m.node.roster) ? m.node.roster.length : 0,
					]),
				),
				rosterAfter: (survivors.get(survivor.path)?.roster as unknown[]).length,
			});
		}
	}

	const hits = new Map<string, number>();
	const writes = new Map<string, Obj>(survivors);
	for (const n of nodes) {
		if (losers.has(n.slug) || survivors.has(n.path)) continue;
		const next = repoint(n.node, n.type, repointTo, hits);
		if (next) writes.set(n.path, next);
	}
	manifest.rewritten = Object.fromEntries(sorted([...hits], ([k]) => k));
	// Each node to write is validated before the caller writes any, and the validation must not drop a field.
	const checked = new Map<string, Obj>();
	for (const [path, node] of sorted([...writes], ([p]) => p)) {
		const parsed = nodePayloadSchema.safeParse(node);
		if (!parsed.success)
			manifest.errors.push(
				`${String(node.slug)}: refusing to write an invalid node: ${parsed.error.message}`,
			);
		else if (!onlyAddsSchemaDefaults(node, parsed.data))
			manifest.errors.push(
				`${String(node.slug)}: refusing to write: validation would alter fields the node carries`,
			);
		else checked.set(path, parsed.data as unknown as Obj);
	}
	manifest.written = checked.size;
	manifest.removed.sort();
	manifest.redirects = Object.fromEntries(sorted(Object.entries(manifest.redirects), ([k]) => k));

	// pending-reverses.json: a key or an edge naming a loser follows the survivor (and its name).
	const renamed = Object.fromEntries(
		Object.entries(structuredClone(pending)).map(([k, list]) => [
			k,
			list.map((p) => {
				const target = repointTo.get(p.edge.slug);
				return target ? { ...p, edge: { ...p.edge, name: target.name } } : p;
			}),
		]),
	);
	const rewrittenPending = rewritePendingReverses(
		renamed,
		new Map([...repointTo].map(([from, to]) => [from, to.slug])),
	);
	manifest.pendingRewritten = Object.values(pending)
		.flat()
		.filter((p) => repointTo.has(p.edge.slug)).length;
	return {
		writes: checked,
		deletions: [...losers.values()].map((l) => l.path),
		pending: rewrittenPending.changed ? rewrittenPending.result : null,
		redirects: manifest.redirects,
		manifest,
	};
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** Directory holding slug-redirects.json (the channel's `--data-dir`); the repo's data/ by default. */
	dataDir?: string;
	/** The proof table; the committed one by default. */
	identities?: Identities;
}

export async function runMigration(options: RunOptions): Promise<{ manifest: Manifest; exitCode: number }> {
	const { cacheDir, apply } = options;
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const errors = invalid.map((i) => `unreadable node file ${i.path}: ${i.error}`);

	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pending: PendingFile = {};
	try {
		const parsed = pendingFileSchema.safeParse(JSON.parse(await readTextOrDefault(pendingPath, "{}")));
		if (parsed.success) pending = parsed.data as PendingFile;
		else errors.push(`pending-reverses.json is invalid: ${parsed.error.message}`);
	} catch (e) {
		errors.push(`pending-reverses.json is unreadable: ${e instanceof Error ? e.message : String(e)}`);
	}

	let identities = options.identities;
	if (!identities) {
		try {
			identities = identitiesSchema.parse(JSON.parse(await readFile(IDENTITIES_PATH, "utf8")));
		} catch (e) {
			errors.push(`proof table unreadable: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const plan = planMerge(nodes, pending, identities ?? { source: "", groups: [] });
	const manifest = plan.manifest;
	manifest.errors.push(...errors);

	const redirectsPath = join(options.dataDir ?? defaultDataDir(), "slug-redirects.json");
	let table: Obj = { redirects: {} };
	let mergedRedirects: Record<string, string> = {};
	try {
		const raw = JSON.parse(await readTextOrDefault(redirectsPath, '{"redirects":{}}')) as unknown;
		parseSlugRedirects(raw);
		table = raw as Obj;
		mergedRedirects = mergeRedirects(table.redirects as Record<string, string>, plan.redirects);
		parseSlugRedirects({ redirects: mergedRedirects });
		const live = new Set(nodes.filter((n) => !plan.deletions.includes(n.path)).map((n) => n.slug));
		for (const key of Object.keys(plan.redirects)) {
			if (live.has(key)) manifest.errors.push(`redirect key ${key} is also a live node after the merge`);
		}
	} catch (e) {
		manifest.errors.push(
			`${redirectsPath} cannot take the redirects: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	manifest.blocked = manifest.errors.length > 0;
	if (apply) manifest.mode = "apply";
	if (apply && !manifest.blocked) {
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
		if (plan.pending) await atomicWriteJson(pendingPath, plan.pending);
		if (manifest.merged.length > 0) {
			await mkdir(dirname(redirectsPath), { recursive: true });
			await atomicWriteJson(redirectsPath, { ...table, redirects: mergedRedirects });
		}
		for (const path of plan.deletions) await rm(path);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: manifest.blocked ? (apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	for (const g of manifest.merged) {
		lines.push(
			`  merged  ${g.losers.join(", ")} -> ${g.survivor} (${g.chosenBy}), ${g.mbid} ${g.qid}, roster ${g.rosterAfter}`,
		);
	}
	for (const r of manifest.refused) lines.push(`  refused ${r.key}: ${r.reason} (${r.detail})`);
	for (const [field, n] of Object.entries(manifest.rewritten))
		lines.push(`  ${field.padEnd(20)} ${n} edge(s) re-pointed`);
	lines.push(
		`  node files written ${manifest.written}, pending entries re-pointed ${manifest.pendingRewritten}`,
	);
	for (const error of manifest.errors) lines.push(`error: ${error}`);
	if (manifestPath) lines.push(`manifest: ${manifestPath}`);
	if (manifest.blocked) lines.push("blocked: nothing written to the cache");
	else if (manifest.mode === "dry-run")
		lines.push("dry-run: nothing written to the cache (re-run with --apply)");
	return lines.join("\n");
}

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	dataDir?: string;
}

/** `<cache-dir> [--apply] [--manifest p] [--data-dir d]`; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	const values: Record<string, string> = {};
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] as string;
		if (token === "--apply" && !apply) apply = true;
		else if ((token === "--manifest" || token === "--data-dir") && !(token in values)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			values[token] = value;
		} else return null;
	}
	return {
		cacheDir,
		apply,
		manifestPath: values["--manifest"] ?? DEFAULT_MANIFEST_PATH,
		...(values["--data-dir"] ? { dataDir: values["--data-dir"] } : {}),
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-20-merge-duplicate-labels.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runMigration(args);
	console.log(formatSummary(result.manifest, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
