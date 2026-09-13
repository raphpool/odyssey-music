import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeCache } from "../src/cache.js";
import { type GenreCoverageEntry, measureGenreCoverage } from "../src/genre-coverage.js";
import { type GenreTaxonomy, validateGenreTaxonomy } from "../src/genre-taxonomy.js";
import { buildGraphFromCache } from "../src/graph.js";

const USAGE = "usage: npm run analyze:genre-coverage -- --cache <dir> --taxonomy <path>";

interface Options {
	cacheDir: string;
	taxonomyPath: string;
}
interface Entry extends GenreCoverageEntry {
	id: string;
	name: string;
	family: string;
}
interface FamilySummary {
	entries: number;
	absent: number;
	quarantined: number;
	deficit: number;
	publishable: number;
	publication: number;
}
interface Diagnostic {
	code: "unresolved-entry";
	id: string;
	name: string;
}
interface Report {
	fingerprint: string;
	entries: Record<string, Entry>;
	families: Record<string, FamilySummary>;
	diagnostics: Diagnostic[];
}
class ArgumentError extends Error {}

export function parseGenreCoverageArgs(args: string[]): Options {
	let cacheDir: string | undefined;
	let taxonomyPath: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		const value = args[index + 1];
		if (argument === "--cache" || argument === "--taxonomy") {
			if (!value || value.startsWith("--"))
				throw new ArgumentError(`${USAGE}\nMissing value for ${argument}`);
			if (argument === "--cache") {
				if (cacheDir) throw new ArgumentError(`${USAGE}\nDuplicate --cache argument`);
				cacheDir = value;
			} else {
				if (taxonomyPath) throw new ArgumentError(`${USAGE}\nDuplicate --taxonomy argument`);
				taxonomyPath = value;
			}
			index++;
			continue;
		}
		throw new ArgumentError(`${USAGE}\nUnknown argument: ${argument ?? ""}`);
	}
	if (!cacheDir || !taxonomyPath)
		throw new ArgumentError(`${USAGE}\nBoth --cache and --taxonomy are required`);
	return { cacheDir, taxonomyPath };
}

async function readTaxonomy(path: string): Promise<{ taxonomy: GenreTaxonomy; content: string }> {
	if (resolve(path) === resolve("web/data.json")) {
		throw new Error("web/data.json cannot be used as the genre coverage source");
	}
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Genre taxonomy not found: ${path}`, { cause: error });
		}
		throw error;
	}
	return { taxonomy: validateGenreTaxonomy(JSON.parse(content) as unknown), content };
}

async function dataFingerprint(cacheDir: string, taxonomy: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(`taxonomy\n${taxonomy}`);
	let files: string[];
	try {
		files = await readdir(join(cacheDir, "nodes"), { encoding: "utf8", recursive: true });
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
		else throw error;
	}
	for (const file of files.filter((file) => file.endsWith(".json")).sort()) {
		hash.update(`\ncache:nodes/${file}\n`);
		hash.update(await readFile(join(cacheDir, "nodes", file)));
	}
	return `sha256:${hash.digest("hex")}`;
}

function makeEntries(
	taxonomy: GenreTaxonomy,
	measured: Record<string, GenreCoverageEntry>,
): Record<string, Entry> {
	return Object.fromEntries(
		taxonomy.genres.map((choice) => {
			const coverage = measured[choice.id];
			if (!coverage) throw new Error(`Coverage entry missing from taxonomy: ${choice.id}`);
			return [choice.id, { id: choice.id, name: choice.name, family: choice.family, ...coverage }];
		}),
	) as Record<string, Entry>;
}

function makeFamilies(
	taxonomy: GenreTaxonomy,
	entries: Record<string, Entry>,
): Record<string, FamilySummary> {
	return Object.fromEntries(
		taxonomy.families.map((family) => {
			const values = taxonomy.genres
				.filter((choice) => choice.family === family.key)
				.map((choice) => entries[choice.id])
				.filter((entry): entry is Entry => entry !== undefined);
			const publication = values.filter((entry) => entry.publishable).length;
			return [
				family.key,
				{
					entries: values.length,
					absent: values.reduce((total, entry) => total + entry.missingSources.length, 0),
					quarantined: values.reduce((total, entry) => total + entry.quarantinedSources.length, 0),
					deficit: values.reduce((total, entry) => total + entry.deficit, 0),
					publishable: publication,
					publication,
				},
			];
		}),
	) as Record<string, FamilySummary>;
}

function diagnostics(entries: Record<string, Entry>): Diagnostic[] {
	return Object.values(entries).flatMap((entry) => {
		if (!entry.resolvedSources.length && !entry.missingSources.length && !entry.quarantinedSources.length) {
			return [{ code: "unresolved-entry", id: entry.id, name: entry.name }];
		}
		return [];
	});
}

export async function analyzeGenreCoverage(options: Options): Promise<Report> {
	if (!(await stat(options.cacheDir)).isDirectory())
		throw new Error(`Cache path is not a directory: ${options.cacheDir}`);
	const { taxonomy, content } = await readTaxonomy(options.taxonomyPath);
	const fingerprint = await dataFingerprint(options.cacheDir, content);
	const projection = await buildGraphFromCache(options.cacheDir, { quarantineOrphanGenres: true });
	const measured = await measureGenreCoverage(taxonomy, new NodeCache(options.cacheDir), projection);
	const entries = makeEntries(taxonomy, measured.entries);
	const families = makeFamilies(taxonomy, entries);
	if (fingerprint !== (await dataFingerprint(options.cacheDir, content)))
		throw new Error("Cache changed during analysis; retry with a stable cache");
	return {
		fingerprint,
		entries,
		families,
		diagnostics: diagnostics(entries),
	};
}

export async function main(args = process.argv.slice(2)): Promise<number> {
	try {
		process.stdout.write(
			`${JSON.stringify(await analyzeGenreCoverage(parseGenreCoverageArgs(args)), null, 2)}\n`,
		);
		return 0;
	} catch (error: unknown) {
		process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		return error instanceof ArgumentError ? 2 : 1;
	}
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
	void main().then((status) => {
		process.exitCode = status;
	});
}
