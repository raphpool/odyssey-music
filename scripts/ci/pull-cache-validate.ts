/**
 * Validation of the prod nodes pulled back into the repo (TRA-493, plan docs/plans/graph-integrity.md,
 * part 7.2), called by deploy/pull-cache.sh on a read-only copy of the server's `cache/nodes/`.
 *
 * Every pulled file is classified against the repo's `cache/nodes/`:
 *   new      absent from the repo: the only files that can be copied;
 *   changed  same slug, different bytes: listed, NEVER copied (after the identity migration the repo
 *            is the source of truth, and a divergence is an integrity signal, not an update);
 *   same     identical, nothing to do.
 * Each `new` file is then judged, as untrusted data: size, JSON, `nodePayloadSchema` (canonical slug),
 * path <-> slug agreement, no field the schema would strip (the repo must hold what a write would
 * produce), only plain http(s) URLs (no userinfo, no IP literal), and not a redirect source in
 * data/{genre,slug}-redirects.json. Only if all of them pass, `auditNodes` runs on repo + new nodes
 * against `data/integrity-thresholds.json`, with the ceilings as committed: nothing here raises one.
 *
 * Read-only: with `--out-dir`, the only writes are `new.txt` and `changed.txt` (one slug per line)
 * under that directory, which the caller keeps outside the repo.
 *
 * Usage: pull-cache-validate.ts <pulled-cache-dir> <repo-cache-dir> [--out-dir <dir>]
 *          [--thresholds <file>] [--redirects <slug-redirects.json>] [--genre-redirects <file>]
 * Exit:  0 every new node is valid and the audit holds, 1 at least one problem, 2 usage or read error.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRedirects, parseSlugRedirects } from "../../src/genre-registry.js";
import { NODE_TYPES } from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { isValidSlug } from "../../src/slug.js";
import {
	auditNodes,
	compareWithThresholds,
	coverageNodeType,
	defaultRedirectsPath,
	defaultThresholdsPath,
	formatViolation,
	parseThresholds,
	type RawNode,
	readRawNodes,
	type Thresholds,
} from "../audit-cache.js";

/** Largest node in the repo is about 18 KB: anything near this is not a node. */
export const MAX_NODE_BYTES = 256 * 1024;

export interface Classification {
	/** Slugs (`type:body`), sorted. */
	new: string[];
	changed: string[];
	same: string[];
	/** Entries that are not node files (a server temp file, say): never copied, never judged. */
	ignored: string[];
	/** Layout problems: an unexpected directory, a symlink named like a node. */
	problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A slug safe to print on its own line; a non-canonical file name is shown escaped instead. */
function label(slug: string): string {
	return isValidSlug(slug) ? slug : JSON.stringify(slug);
}

export function nodePath(slug: string): string {
	const i = slug.indexOf(":");
	return join("nodes", slug.slice(0, i), `${slug.slice(i + 1)}.json`);
}

async function readIfPresent(path: string): Promise<Buffer | null | "unreadable"> {
	try {
		return await readFile(path);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
	}
}

export async function classify(pulledDir: string, repoDir: string): Promise<Classification> {
	const out: Classification = { new: [], changed: [], same: [], ignored: [], problems: [] };
	const known: readonly string[] = NODE_TYPES;
	for (const typeDir of (await readdir(join(pulledDir, "nodes"), { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (!typeDir.isDirectory() || !known.includes(typeDir.name)) {
			out.problems.push(`nodes/${JSON.stringify(typeDir.name).slice(1, -1)}: not a node type directory`);
			continue;
		}
		const entries = await readdir(join(pulledDir, "nodes", typeDir.name), { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.name.endsWith(".json")) {
				out.ignored.push(`nodes/${typeDir.name}/${entry.name}`);
				continue;
			}
			const slug = `${typeDir.name}:${basename(entry.name, ".json")}`;
			if (!entry.isFile()) {
				out.problems.push(`${label(slug)}: not a regular file (a symlink or directory named like a node)`);
				continue;
			}
			const repo = await readIfPresent(join(repoDir, nodePath(slug)));
			if (repo === null) out.new.push(slug);
			else if (repo !== "unreadable" && repo.equals(await readFile(join(pulledDir, nodePath(slug)))))
				out.same.push(slug);
			else out.changed.push(slug);
		}
	}
	return out;
}

/** Plain web URL: http(s), no userinfo, a dotted host name (no `localhost`, no IP literal). */
export function isPlainWebUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	if (url.username !== "" || url.password !== "") return false;
	return url.hostname.includes(".") && !/^[\d.]+$/.test(url.hostname) && !url.hostname.startsWith("[");
}

/** Paths present in `raw` that `parsed` (the schema's output) no longer has: what a write would strip. */
function strippedPaths(raw: unknown, parsed: unknown, path: string, out: string[]): void {
	if (Array.isArray(raw)) {
		if (Array.isArray(parsed)) {
			for (const [i, value] of raw.entries()) strippedPaths(value, parsed[i], `${path}[${i}]`, out);
		}
		return;
	}
	if (!isRecord(raw) || !isRecord(parsed)) return;
	for (const [key, value] of Object.entries(raw)) {
		const here = path === "" ? key : `${path}.${key}`;
		if (Object.hasOwn(parsed, key)) strippedPaths(value, parsed[key], here, out);
		else out.push(here);
	}
}

/** Why a new node file cannot be imported; empty when it can. `raw` is set whenever the JSON parsed. */
export function checkNode(
	slug: string,
	text: string,
	redirects: ReadonlyMap<string, string>,
): { problems: string[]; raw?: RawNode } {
	if (Buffer.byteLength(text) > MAX_NODE_BYTES) {
		return { problems: [`${label(slug)}: file larger than ${MAX_NODE_BYTES} bytes`] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { problems: [`${label(slug)}: not valid JSON (${e instanceof Error ? e.message : String(e)})`] };
	}
	if (!isRecord(raw)) return { problems: [`${label(slug)}: not a JSON object`] };
	const parsed = nodePayloadSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.slice(0, 5)
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		return { raw, problems: [`${label(slug)}: fails the node schema (${issues.join("; ")})`] };
	}
	const problems: string[] = [];
	if (parsed.data.slug !== slug) {
		problems.push(`${label(slug)}: node slug ${JSON.stringify(parsed.data.slug)} does not match its path`);
	}
	if (!isValidSlug(slug)) problems.push(`${label(slug)}: the file name is not a canonical slug`);
	const redirect = redirects.get(slug);
	if (redirect !== undefined) {
		problems.push(`${label(slug)}: slug is a redirect source (canonical node: ${redirect})`);
	}
	const stripped: string[] = [];
	strippedPaths(raw, parsed.data, "", stripped);
	if (stripped.length > 0) {
		problems.push(`${label(slug)}: field(s) the schema would strip: ${stripped.slice(0, 5).join(", ")}`);
	}
	const data = parsed.data as unknown as Record<string, unknown>;
	const urls = [
		...(Array.isArray(data.citations) ? (data.citations as { url: string }[]).map((c) => c.url) : []),
		...["cover_url", "photo_url", "image_url"].flatMap((f) => (typeof data[f] === "string" ? [data[f]] : [])),
	] as string[];
	for (const url of urls) {
		if (!isPlainWebUrl(url))
			problems.push(`${label(slug)}: URL is not a plain http(s) URL: ${JSON.stringify(url)}`);
	}
	return { raw, problems };
}

async function readPendingReverseKeys(repoDir: string): Promise<string[]> {
	try {
		const parsed = JSON.parse(await readFile(join(repoDir, "pending-reverses.json"), "utf8")) as unknown;
		return isRecord(parsed) ? Object.keys(parsed) : [];
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
}

interface Options {
	pulledDir: string;
	repoDir: string;
	outDir?: string;
	thresholdsPath: string;
	redirectsPath: string;
	genreRedirectsPath?: string;
}

function parseArgs(argv: readonly string[]): Options | null {
	const positional: string[] = [];
	const opts: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (["--out-dir", "--thresholds", "--redirects", "--genre-redirects"].includes(arg)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) return null;
			opts[arg] = value;
		} else if (arg.startsWith("--")) {
			return null;
		} else {
			positional.push(arg);
		}
	}
	const [pulledDir, repoDir, ...rest] = positional;
	if (pulledDir === undefined || repoDir === undefined || rest.length > 0) return null;
	return {
		pulledDir,
		repoDir,
		thresholdsPath: opts["--thresholds"] ?? defaultThresholdsPath(),
		redirectsPath: opts["--redirects"] ?? defaultRedirectsPath(),
		...(opts["--out-dir"] === undefined ? {} : { outDir: opts["--out-dir"] }),
		...(opts["--genre-redirects"] === undefined ? {} : { genreRedirectsPath: opts["--genre-redirects"] }),
	};
}

const USAGE =
	"usage: pull-cache-validate.ts <pulled-cache-dir> <repo-cache-dir> [--out-dir <dir>] [--thresholds <file>] [--redirects <file>] [--genre-redirects <file>]\n";

export async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (!args) {
		process.stderr.write(USAGE);
		return 2;
	}
	let thresholds: Thresholds;
	let slugRedirects: ReadonlyMap<string, string>;
	let allRedirects: ReadonlyMap<string, string>;
	let classification: Classification;
	let repoNodes: Map<string, RawNode>;
	let pendingKeys: string[];
	try {
		thresholds = parseThresholds(JSON.parse(await readFile(args.thresholdsPath, "utf8")));
		slugRedirects = parseSlugRedirects(JSON.parse(await readFile(args.redirectsPath, "utf8")));
		allRedirects = await loadRedirects({ slug: args.redirectsPath, genre: args.genreRedirectsPath });
		classification = await classify(args.pulledDir, args.repoDir);
		const read = await readRawNodes(args.repoDir);
		// A partial repo cache would lower every count: refuse to certify against it.
		if (read.invalid.length > 0 || read.nodes.size === 0) {
			throw new Error(`repo cache ${args.repoDir} is empty or has unreadable nodes`);
		}
		repoNodes = read.nodes;
		pendingKeys = await readPendingReverseKeys(args.repoDir);
	} catch (e) {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		return 2;
	}

	const problems = [...classification.problems];
	const accepted = new Map<string, RawNode>();
	for (const slug of classification.new) {
		const { problems: found, raw } = checkNode(
			slug,
			await readFile(join(args.pulledDir, nodePath(slug)), "utf8"),
			allRedirects,
		);
		problems.push(...found);
		if (found.length === 0 && raw !== undefined) accepted.set(slug, raw);
	}

	const c = classification;
	console.log(
		`pulled: ${c.new.length + c.changed.length + c.same.length} node file(s): new ${c.new.length}, changed ${c.changed.length}, same ${c.same.length}, ignored ${c.ignored.length}`,
	);
	const list = (title: string, slugs: string[]) => {
		if (slugs.length > 0) console.log(`${title}:\n${slugs.map((s) => `  ${label(s)}`).join("\n")}`);
	};
	list("new", c.new);
	list("changed (the repo wins: listed, never copied)", c.changed);

	if (problems.length === 0) {
		// Per-file problems make the audit meaningless: it would run on a union missing those nodes.
		const report = auditNodes(new Map([...repoNodes, ...accepted]), pendingKeys, slugRedirects);
		for (const v of compareWithThresholds(report, thresholds)) {
			const kind = coverageNodeType(v.metric, v.key) === null ? "correctness" : "coverage";
			problems.push(`audit: ${formatViolation(v)} [${kind}] with the ${c.new.length} new node(s)`);
		}
	}

	if (args.outDir !== undefined) {
		await mkdir(args.outDir, { recursive: true });
		const lines = (slugs: string[]) => (slugs.length === 0 ? "" : `${slugs.map(label).join("\n")}\n`);
		// new.txt is the copy list: empty unless the whole batch is valid, so a caller that forgets to
		// look at the exit code still copies nothing.
		await writeFile(join(args.outDir, "new.txt"), problems.length === 0 ? lines(c.new) : "");
		await writeFile(join(args.outDir, "changed.txt"), lines(c.changed));
	}
	for (const p of problems) process.stderr.write(`${p}\n`);
	if (problems.length === 0) console.log("validation: OK");
	return problems.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e: unknown) => {
			process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
			process.exit(2);
		},
	);
}
