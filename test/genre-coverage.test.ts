import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { measureGenreCoverage } from "../src/genre-coverage.js";
import type { GenreTaxonomy } from "../src/genre-taxonomy.js";
import type { GraphProjection, VizNode } from "../src/graph.js";
import type { GenreNode, NodeType } from "../src/types.js";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "odyssey-genre-coverage-"));
});
afterEach(async () => rm(directory, { recursive: true, force: true }));
function genre(slug: GenreNode["slug"], name: string, qid?: string): GenreNode {
	return {
		type: "genre",
		slug,
		name,
		...(qid === undefined ? {} : { qid }),
		editorial_definition: "Fixture definition.",
		editorial_article: "Fixture article. ".repeat(8),
		citations: [{ url: "https://example.com/genre" }],
		materialized_at: new Date().toISOString(),
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
	};
}
const taxonomy = (genres: GenreTaxonomy["genres"]): GenreTaxonomy => ({
	version: 2,
	families: [{ key: "electronic", label: "Electronic", order: 0 }],
	genres,
});
const projection = (nodes: GraphProjection["nodes"], edges: GraphProjection["edges"]): GraphProjection => ({
	generated_at: new Date().toISOString(),
	total: nodes.length,
	types: {},
	nodes,
	edges,
});
function vizNode(id: string, type: NodeType): VizNode {
	return {
		id,
		type,
		name: id,
		teaser: "",
		article: "",
		citations: [],
		facts: {},
		edges: {},
		materialized_at: "",
	};
}
async function writeTaxonomy(path: string, genres: GenreTaxonomy["genres"]): Promise<void> {
	await writeFile(path, JSON.stringify(taxonomy(genres)));
}
type CliResult = { status: number; stdout: string; stderr: string };
function runCoverageCli(...args: string[]): CliResult {
	try {
		const stdout = execFileSync("npm", ["--silent", "run", "analyze:genre-coverage", "--", ...args], {
			cwd: process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout: String(stdout), stderr: "" };
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		const result = error as Error & { status?: number; stderr?: unknown; stdout?: unknown };
		return {
			status: result.status ?? 1,
			stdout: typeof result.stdout === "string" ? result.stdout : "",
			stderr: typeof result.stderr === "string" ? result.stderr : "",
		};
	}
}
describe("measureGenreCoverage (TRA-57)", () => {
	it("unites incoming and outgoing eligible neighbours across sources and reports missing and quarantined sources", async () => {
		const cache = new NodeCache(directory);
		await cache.write(genre("genre:canonical", "Canonical", "Q1"));
		await cache.write(genre("genre:alias", "Alias"));
		await cache.write(genre("genre:orphan", "Orphan"));
		const graph = projection(
			[
				...(["genre:canonical", "genre:alias"] as const).map((id) => vizNode(id, "genre")),
				vizNode("artist:one", "artist"),
				vizNode("project:two", "project"),
				vizNode("track:three", "track"),
				vizNode("label:ignored", "label"),
			],
			[
				{ source: "genre:canonical", target: "artist:one", kind: "key_artists" },
				{ source: "artist:one", target: "genre:canonical", kind: "genres" },
				{ source: "project:two", target: "genre:canonical", kind: "genres" },
				{ source: "genre:alias", target: "track:three", kind: "landmark_tracks" },
				{ source: "genre:canonical", target: "label:ignored", kind: "key_labels" },
				{ source: "genre:canonical", target: "genre:alias", kind: "related_genres" },
				{ source: "genre:canonical", target: "project:missing", kind: "landmark_projects" },
			],
		);
		graph.quarantine = [{ id: "genre:orphan", name: "Orphan", reason: "no genre-genre edges" }];

		const report = await measureGenreCoverage(
			taxonomy([
				{
					id: "Q1",
					qid: "Q1",
					name: "Choice",
					family: "electronic",
					published: true,
					sourceSlugs: ["genre:alias", "genre:gone", "genre:orphan"],
				},
			]),
			cache,
			graph,
		);

		expect(report.entries.Q1).toMatchObject({
			resolvedSources: ["genre:alias", "genre:canonical"],
			missingSources: ["genre:gone"],
			quarantinedSources: ["genre:orphan"],
			neighbourCount: 3,
			deficit: 0,
			publishable: true,
		});
		expect(report.families.electronic).toEqual({ entries: 1, publishable: 1, deficit: 0 });
	});

	it("does not infer a source when neither its slug nor QID is materialized", async () => {
		const report = await measureGenreCoverage(
			taxonomy([{ id: "Q9", qid: "Q9", name: "Known by name only", family: "electronic", published: true }]),
			new NodeCache(directory),
			projection([], []),
		);
		expect(report.entries.Q9).toMatchObject({
			resolvedSources: [],
			missingSources: [],
			neighbourCount: 0,
			deficit: 3,
			publishable: false,
		});
	});

	it("rejects contradictory QIDs and sources assigned to multiple entries", async () => {
		const cache = new NodeCache(directory);
		await cache.write(genre("genre:first", "First", "Q1"));
		await cache.write(genre("genre:second", "Second", "Q2"));
		const graph = projection([], []);
		await expect(
			measureGenreCoverage(
				taxonomy([
					{
						id: "Q1",
						qid: "Q1",
						name: "First",
						family: "electronic",
						published: true,
						sourceSlugs: ["genre:second"],
					},
				]),
				cache,
				graph,
			),
		).rejects.toThrow(/contradictory source QID/i);
		await expect(
			measureGenreCoverage(
				taxonomy([
					{
						id: "local:first",
						name: "First",
						family: "electronic",
						published: true,
						sourceSlugs: ["genre:first"],
					},
					{
						id: "local:second",
						name: "Second",
						family: "electronic",
						published: true,
						sourceSlugs: ["genre:first"],
					},
				]),
				cache,
				graph,
			),
		).rejects.toThrow(/multiple genres/i);
	});
});

describe("analyze:genre-coverage (TRA-58)", () => {
	it("reports named choices, family summary, missing sources and a data fingerprint without writing", async () => {
		const cache = new NodeCache(directory);
		const canonical = genre("genre:canonical", "Canonical", "Q1");
		canonical.related_genres = [{ slug: "genre:alias", type: "genre", name: "Alias" }];
		await cache.write(canonical);
		await cache.write(genre("genre:alias", "Alias"));
		const taxonomyPath = join(directory, "genre-taxonomy.json");
		await writeTaxonomy(taxonomyPath, [
			{
				id: "Q1",
				qid: "Q1",
				name: "Choice",
				family: "electronic",
				published: true,
				sourceSlugs: ["genre:alias", "genre:missing"],
			},
		]);
		const beforeCanonical = await readFile(join(directory, "nodes/genre/canonical.json"), "utf8");
		const result = runCoverageCli("--cache", directory, "--taxonomy", taxonomyPath);

		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout) as {
			entries: Record<string, Record<string, unknown>>;
			families: Record<string, Record<string, unknown>>;
			fingerprint: string;
		};
		expect(report.entries.Q1).toMatchObject({
			name: "Choice",
			family: "electronic",
			resolvedSources: ["genre:alias", "genre:canonical"],
			missingSources: ["genre:missing"],
			deficit: 3,
			publishable: false,
		});
		expect(report.families.electronic).toMatchObject({ entries: 1, deficit: 3, publishable: 0 });
		expect(report.families.electronic).toMatchObject({
			absent: 1,
			quarantined: 0,
			deficit: 3,
			publication: 0,
		});
		expect(
			(
				JSON.parse(runCoverageCli("--cache", directory, "--taxonomy", taxonomyPath).stdout) as {
					fingerprint: string;
				}
			).fingerprint,
		).toBe(report.fingerprint);
		expect(await readFile(join(directory, "nodes/genre/canonical.json"), "utf8")).toBe(beforeCanonical);
	});

	it("diagnoses invalid arguments and reports unresolved inputs from the selected cache", async () => {
		const invalid = runCoverageCli("--cache");
		expect(invalid.status).toBe(2);
		expect(invalid.stderr).toMatch(/--cache <dir>/i);

		const taxonomyPath = join(directory, "genre-taxonomy.json");
		await writeTaxonomy(taxonomyPath, [
			{
				id: "Q9",
				qid: "Q9",
				name: "Unknown choice",
				family: "electronic",
				published: true,
			},
		]);
		const result = runCoverageCli("--cache", directory, "--taxonomy", taxonomyPath);
		const report = JSON.parse(result.stdout) as {
			entries: Record<string, Record<string, unknown>>;
			diagnostics: Array<Record<string, unknown>>;
		};
		expect(result.status).toBe(0);
		expect(report.entries.Q9).toMatchObject({
			resolvedSources: [],
			missingSources: [],
			deficit: 3,
			publishable: false,
		});
		expect(report.diagnostics).toContainEqual({
			code: "unresolved-entry",
			id: "Q9",
			name: "Unknown choice",
		});
	});
});
