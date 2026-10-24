/**
 * Fix the doubtful edges and fields that the label merge (TRA-600/TRA-608/TRA-611) put on the same card
 * (TRA-609, plan docs/plans/graph-integrity.md). The merge did not create them; it only gathered them on
 * one fiche, where the deep review of TRA-600 (2026-10-18) found them. Each case below was checked on
 * MusicBrainz on 2026-10-24 (12 requests, 1 req/s, default User-Agent); the evidence of every step is in its
 * `evidence` line, and the same table is in the PR.
 *
 * CLOSED LIST (STEPS below): seven steps, three kinds.
 *   - `detach` (project, label): the project is not a release of the label. Both sides of the pair go, because
 *     `project.label` and `label.notable_releases` are reverse edges (src/node-spec.ts, TRA-454): removing one
 *     side only would let the next reverse-edge backfill restore it. `project.label` is cleared only when it
 *     holds this very label; the entries of `label.notable_releases` with this slug are removed, the others
 *     keep their order. Nothing is re-pointed: no node exists for the true label of these releases, or it
 *     would be a different claim (see the Piper evidence), and an empty edge is honest.
 *   - `set` (label, field, expected, value): a scalar written over its expected, known-wrong value.
 *   - `retarget` (node, from, to): the node points at a dangling duplicate that data/slug-redirects.json
 *     already redirects to a canonical node (the test pins `to` against the committed table). In a list the
 *     dangling entry is replaced in place by the canonical edge, or simply dropped when the list already holds
 *     the canonical one (re-pointing would write a duplicate); a single edge (`landmark_project`) takes the
 *     canonical entry of the artist's own list as is, so it stays a member of that list. Only an edge that
 *     still holds exactly `from` moves.
 *
 * KEPT (KEPT below): the cases of the triage that the evidence does NOT prove false. They have no step; the
 * test pins that the migration never touches them.
 *
 * Rules:
 * - A step touches a node only when the expected value is still there: the project holds the label, the list
 *   holds the entry, the field holds the old text. Anything else is left alone and listed in `skipped`
 *   (`absent`, `already-clean`, `value-changed`): a value the pipeline or a human rewrote since is not ours to
 *   undo, and a second run finds nothing to do (idempotence). `absent` is normal for `project:polyester`, a
 *   dangling duplicate (its redirect to `project:polyester--lisa-carbon` is committed in
 *   data/slug-redirects.json), and for nodes that exist on one side only: the migration runs on the channel's
 *   union (repository + server snapshot).
 * - Nothing else on the node changes: the other fields, the other list entries, the order of the keys. The
 *   node as read is written back with that one edit, after `nodePayloadSchema` validated the result without
 *   dropping a field it carries. One refusal (unreadable file, invalid result) blocks the whole run: nothing
 *   is written (exit 1 in a dry-run, 2 with --apply).
 * - Dry-run by default; the manifest of a dry-run and of the apply that follows are identical but for
 *   `generated_at` and `mode`.
 *
 * Offline and deterministic: no network, no LLM. Reads only the nodes named by the steps, by path.
 *
 * Channel contract (deploy/sync-genre-cache.sh --migration): `<cache-dir> --apply --manifest <path>
 * --data-dir <dir>`. `--data-dir` is accepted and ignored (this migration reads no table). The manifest holds
 * `migration`, `removed: []`, `renamed: {}` and `redirects: {}`: it never deletes or renames a node.
 *
 * Usage: tsx scripts/migrations/2026-10-24-fix-merged-label-edges.ts <cache-dir> [--apply]
 *        [--manifest out/fix-merged-label-edges.json] [--data-dir <dir>]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug } from "../../src/slug.js";
import { isRecord, looksLikeCacheDir } from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-24-fix-merged-label-edges";
export const DEFAULT_MANIFEST_PATH = "out/fix-merged-label-edges.json";

type Obj = Record<string, unknown>;

export interface DetachStep {
	kind: "detach";
	project: string;
	label: string;
	/** Why, in one line: what MusicBrainz says about this project and this label. */
	evidence: string;
}

export interface SetStep {
	kind: "set";
	node: string;
	field: "active_years";
	/** The value the step is written against; any other value is left alone. */
	expected: string;
	value: string;
	evidence: string;
}

export interface RetargetStep {
	kind: "retarget";
	node: string;
	/** The dangling slug; any edge holding another slug is left alone. */
	from: string;
	/** The canonical slug, as data/slug-redirects.json maps `from`. */
	to: string;
	/** Lists first, then single edges: a single edge copies the canonical entry of the list. */
	fields: readonly ("discography" | "landmark_project")[];
	evidence: string;
}

export type Step = DetachStep | SetStep | RetargetStep;

/** The closed list. Exported so that the test pins it: adding a step is a reviewed change. */
export const STEPS: readonly Step[] = [
	{
		kind: "detach",
		project: "project:the-piper-at-the-gates-of-dawn--pink-floyd",
		label: "label:columbia",
		evidence:
			"MusicBrainz release group 6792b6d1: the 1967 UK pressings (SX/SCX 6157) are on Columbia Records ad6f8706 (GB, EMI-owned 1931-1990, renamed EMI in 1973), the US ones on Tower (ad2f9216). label:columbia is the US label 011d1192, and the merge proof (TRA-600/TRA-608, identities.json) names ad6f8706 as 'not this one' (Q1112471 on its own side). No node exists for ad6f8706, and label:emi is the post-1973 EMI of the reissues: nothing proven to re-point to.",
	},
	{
		kind: "detach",
		project: "project:selected-ambient-works-85-92",
		label: "label:rephlex",
		evidence:
			"MusicBrainz release group 6842c81d: 20 releases, on Apollo 40554a9e (the 1992 original), R&S 77bc13d5, Distance, Sony, [PIAS] America, Creative Vibes, Beat, Rough Trade. None on Rephlex 820fa04e. label:apollo already lists the album, so it keeps a label card; project.label was empty before and still is.",
	},
	{
		kind: "detach",
		project: "project:selected-ambient-works-85-92",
		label: "label:warp",
		evidence:
			"Same release group 6842c81d (see above): none of its 20 releases is on Warp 46f0f4cd; the 1992 original is Apollo 40554a9e, the reissues R&S 77bc13d5. The label side is the only one: project.label is empty, and label:apollo keeps the album.",
	},
	{
		kind: "detach",
		project: "project:hard-normal-daddy--squarepusher",
		label: "label:rephlex",
		evidence:
			"MusicBrainz release group f4168d4e: 8 releases, all Warp 46f0f4cd (plus Rough Trade for the German pressing). None on Rephlex 820fa04e. project.label is already label:warp: only the Rephlex side of the pair is wrong.",
	},
	{
		kind: "detach",
		project: "project:polyester",
		label: "label:rephlex",
		evidence:
			"`project:polyester` has no node: data/slug-redirects.json redirects it to project:polyester--lisa-carbon, which label:rephlex also lists. The dangling entry is a duplicate of the true one (MusicBrainz release group 180d7f48: Rephlex 820fa04e, CAT 026, 1994), which stays.",
	},
	{
		kind: "retarget",
		node: "artist:lisa-carbon",
		from: "project:polyester",
		to: "project:polyester--lisa-carbon",
		fields: ["discography", "landmark_project"],
		evidence:
			"`project:polyester` has no node and data/slug-redirects.json maps it to project:polyester--lisa-carbon (Rephlex CAT 026, 1994, release group 180d7f48). The discography lists both: the dangling entry is dropped, the canonical one stays; the landmark takes the canonical entry.",
	},
	{
		kind: "set",
		node: "label:e-g-records",
		field: "active_years",
		expected: "1969–1996",
		value: "1969–1991",
		evidence:
			"MusicBrainz label 71ee312d (E'G): life-span 1969 to 1991-05-09, ended. The 1996 of the card (copied from label:eg-records by the merge) is the end of the 'label ownership' relation of Virgin (1992-1996), not of the label.",
	},
];

/** A case of the triage that is NOT touched, with the proof that it is right. Documentation, and a test pin. */
export interface Kept {
	node: string;
	edge: string;
	evidence: string;
}

export const KEPT: readonly Kept[] = [
	{
		node: "artist:wolfgang-voigt",
		edge: "label:warp",
		evidence:
			"MusicBrainz: Wolfgang Voigt 1cc6e6ad is the person behind Mike Ink f0de7984 ('is person'), and Mike Ink released Paroles (WAP 81, 1996-10-14) and Polka Trax (WAP 82, 1996-10-28) on Warp 46f0f4cd. The edge is true through the alias; no release of the Wolfgang Voigt credit itself is on Warp. kompakt (Polkatrax 1-3) and raster-noton (Gas: November 89, 2008) are also supported.",
	},
	{
		node: "project:polyester--lisa-carbon",
		edge: "label:rephlex",
		evidence:
			"MusicBrainz release group 180d7f48: Polyester, Rephlex 820fa04e, CAT 026 CD, 1994. The true entry of the duplicated pair.",
	},
];

export type SkipReason = "absent" | "already-clean" | "value-changed";

export interface Change {
	node: string;
	field: "label" | "notable_releases" | "active_years" | "discography" | "landmark_project";
	action: "cleared" | "removed" | "set" | "retargeted" | "merged";
	/** The slug cleared, removed or retargeted, or the old value of a scalar. */
	from: string;
	/** The new value of a scalar or the canonical slug of a retargeted edge; null when an edge was cleared or removed. */
	to: string | null;
	/** `removed`, `merged`, `retargeted` in a list: how many entries of the list carried the slug. */
	entries?: number;
}

export interface Skipped {
	node: string;
	field: Change["field"];
	reason: SkipReason;
	/** `value-changed`: the value the node holds instead; `already-clean`: the label a project holds instead, or the value already set. */
	found?: string;
}

export interface Manifest {
	migration: string;
	generated_at: string;
	mode: "dry-run" | "apply";
	/** Errors refused the run: nothing was written, whatever the mode. */
	blocked: boolean;
	/** The channel's contract (deploy/sync-genre-cache.sh): this migration never deletes, renames or redirects. */
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	/** Node files written (planned, in a dry-run). */
	written: number;
	changed: Change[];
	skipped: Skipped[];
	errors: string[];
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const slugOf = (edge: unknown): string | undefined => (isRecord(edge) ? asString(edge.slug) : undefined);

type Outcome = { next: Obj; change: Change } | { next: null; skipped: Skipped };

/** `project.label` -> cleared when it holds `label`. */
export function clearProjectLabel(project: Obj, step: DetachStep): Outcome {
	const slug = step.project;
	const found = slugOf(project.label);
	if (found !== step.label) {
		return {
			next: null,
			skipped: { node: slug, field: "label", reason: "already-clean", ...(found ? { found } : {}) },
		};
	}
	const next: Obj = { ...project };
	delete next.label;
	return { next, change: { node: slug, field: "label", action: "cleared", from: step.label, to: null } };
}

/** `label.notable_releases` -> the entries carrying the project's slug removed, the rest in order. */
export function removeNotableRelease(label: Obj, step: DetachStep): Outcome {
	const slug = step.label;
	const list = label.notable_releases;
	const kept = Array.isArray(list) ? list.filter((e) => slugOf(e) !== step.project) : [];
	const entries = Array.isArray(list) ? list.length - kept.length : 0;
	if (entries === 0)
		return { next: null, skipped: { node: slug, field: "notable_releases", reason: "already-clean" } };
	return {
		next: { ...label, notable_releases: kept },
		change: {
			node: slug,
			field: "notable_releases",
			action: "removed",
			from: step.project,
			to: null,
			entries,
		},
	};
}

/** A list edge holding `from`: replaced by the canonical edge, or dropped when the list holds it already. */
export function retargetListEdge(node: Obj, step: RetargetStep, field: "discography"): Outcome {
	const list = node[field];
	const entries = Array.isArray(list) ? list.filter((e) => slugOf(e) === step.from).length : 0;
	if (!Array.isArray(list) || entries === 0) {
		return { next: null, skipped: { node: step.node, field, reason: "already-clean" } };
	}
	const hasCanonical = list.some((e) => slugOf(e) === step.to);
	const next = hasCanonical
		? list.filter((e) => slugOf(e) !== step.from)
		: list.map((e) => (slugOf(e) === step.from && isRecord(e) ? { ...e, slug: step.to } : e));
	return {
		next: { ...node, [field]: next },
		change: {
			node: step.node,
			field,
			action: hasCanonical ? "merged" : "retargeted",
			from: step.from,
			to: step.to,
			entries,
		},
	};
}

/** A single edge holding exactly `from`: the canonical entry of the artist's own list, as is. */
export function retargetSingleEdge(node: Obj, step: RetargetStep, field: "landmark_project"): Outcome {
	const current = node[field];
	const found = slugOf(current);
	if (found !== step.from || !isRecord(current)) {
		return {
			next: null,
			skipped: { node: step.node, field, reason: "already-clean", ...(found ? { found } : {}) },
		};
	}
	const list = node.discography;
	const canonical = Array.isArray(list) ? list.find((e) => slugOf(e) === step.to) : undefined;
	const edge: Obj = isRecord(canonical) ? { ...canonical } : { ...current, slug: step.to };
	return {
		next: { ...node, [field]: edge },
		change: { node: step.node, field, action: "retargeted", from: step.from, to: step.to },
	};
}

/** A scalar -> `value`, only when it still holds `expected`. */
export function setScalar(node: Obj, step: SetStep): Outcome {
	const found = asString(node[step.field]);
	if (found === step.value) {
		return { next: null, skipped: { node: step.node, field: step.field, reason: "already-clean", found } };
	}
	if (found !== step.expected) {
		return {
			next: null,
			skipped: { node: step.node, field: step.field, reason: "value-changed", ...(found ? { found } : {}) },
		};
	}
	return {
		next: { ...node, [step.field]: step.value },
		change: { node: step.node, field: step.field, action: "set", from: step.expected, to: step.value },
	};
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
}

async function readNode(
	cacheDir: string,
	slug: string,
): Promise<{ path: string; node: Obj } | { path: string; node: null; error?: string }> {
	const { type, body } = parseSlug(slug);
	const path = join(cacheDir, "nodes", type, `${body}.json`);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path, node: null };
		return { path, node: null, error: `${slug}: unreadable node file: ${(e as Error).message}` };
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed)) return { path, node: null, error: `${slug}: node file is not a JSON object` };
		return { path, node: parsed };
	} catch (e) {
		return { path, node: null, error: `${slug}: invalid JSON: ${(e as Error).message}` };
	}
}

export async function runMigration(options: RunOptions): Promise<{ manifest: Manifest; exitCode: number }> {
	const writes = new Map<string, Obj>();
	const changed: Change[] = [];
	const skipped: Skipped[] = [];
	const errors: string[] = [];

	// A node can carry several steps (label:rephlex carries three): fold them over one copy, write once.
	const pending = new Map<string, { path: string; node: Obj }>();
	// A node that is absent or unreadable is read once and reported once (per field), not once per step.
	const missing = new Set<string>();
	// Two steps can reach the same fact (project.label of SAW 85-92 is empty for both of its detachments): once.
	const note = (entry: Skipped): void => {
		if (!skipped.some((s) => JSON.stringify(s) === JSON.stringify(entry))) skipped.push(entry);
	};
	const edit = async (slug: string, field: Change["field"], apply: (node: Obj) => Outcome): Promise<void> => {
		let state = pending.get(slug);
		if (!state) {
			if (missing.has(slug)) {
				note({ node: slug, field, reason: "absent" });
				return;
			}
			const read = await readNode(options.cacheDir, slug);
			if (read.node === null) {
				missing.add(slug);
				if (read.error) errors.push(read.error);
				else note({ node: slug, field, reason: "absent" });
				return;
			}
			state = { path: read.path, node: read.node };
			pending.set(slug, state);
		}
		const result = apply(state.node);
		if (result.next === null) note(result.skipped);
		else {
			state.node = result.next;
			changed.push(result.change);
		}
	};

	for (const step of STEPS) {
		if (step.kind === "detach") {
			await edit(step.project, "label", (n) => clearProjectLabel(n, step));
			await edit(step.label, "notable_releases", (n) => removeNotableRelease(n, step));
		} else if (step.kind === "retarget") {
			for (const field of step.fields) {
				if (field === "discography") await edit(step.node, field, (n) => retargetListEdge(n, step, field));
				else await edit(step.node, field, (n) => retargetSingleEdge(n, step, field));
			}
		} else {
			await edit(step.node, step.field, (n) => setScalar(n, step));
		}
	}

	for (const [slug, { path, node }] of pending) {
		if (!changed.some((c) => c.node === slug)) continue;
		const parsed = nodePayloadSchema.safeParse(node);
		if (!parsed.success) {
			errors.push(`${slug}: refusing to write an invalid node: ${parsed.error.message}`);
		} else if (!onlyAddsSchemaDefaults(node, parsed.data)) {
			errors.push(`${slug}: refusing to write: validation would alter fields the node carries`);
		} else {
			// The node as read, with the one edit: the parsed copy would also add the empty lists a node lacks.
			writes.set(path, node);
		}
	}

	const blocked = errors.length > 0;
	const manifest: Manifest = {
		migration: MIGRATION_NAME,
		generated_at: new Date().toISOString(),
		mode: options.apply ? "apply" : "dry-run",
		blocked,
		removed: [],
		renamed: {},
		redirects: {},
		written: blocked ? 0 : writes.size,
		changed,
		skipped,
		errors,
	};
	if (options.apply && !blocked) {
		for (const [path, node] of writes) await atomicWriteJson(path, node);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: blocked ? (options.apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	lines.push(`  ${"node files written".padEnd(24)} ${manifest.written}`);
	for (const c of manifest.changed) {
		const what =
			c.action === "set"
				? `${c.from} -> ${c.to}`
				: `${c.action} ${c.from}${c.to ? ` -> ${c.to}` : ""}${c.entries ? ` (x${c.entries})` : ""}`;
		lines.push(`  ${c.node}.${c.field}: ${what}`);
	}
	for (const s of manifest.skipped) {
		lines.push(`  skipped ${s.node}.${s.field}: ${s.reason}${s.found ? ` (${s.found})` : ""}`);
	}
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
	/** Part of the channel's contract; this migration reads no table, so it is parsed and ignored. */
	dataDir: string | undefined;
}

/** `<cache-dir> [--apply] [--manifest p] [--data-dir d]`; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let manifestPath: string | undefined;
	let dataDir: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--manifest" && manifestPath === undefined) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			manifestPath = value;
		} else if (token === "--data-dir" && dataDir === undefined) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			dataDir = value;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH, dataDir };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-24-fix-merged-label-edges.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
