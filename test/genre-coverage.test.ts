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
type GenreCoverageReport = Awaited<ReturnType<typeof measureGenreCoverage>>;
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
function assertPublishedEntriesAreAdmissible(
	report: GenreCoverageReport,
	entries: GenreTaxonomy["genres"],
): void {
	for (const entry of entries.filter(({ published }) => published === true)) {
		expect(report.entries[entry.id]?.publishable, `published entry ${entry.id} must be admissible`).toBe(
			true,
		);
	}
}

const coverageFamilies = [
	{ key: "house-techno", label: "House / Techno", order: 0 },
	{ key: "uk-dance-grime", label: "UK Dance / Grime", order: 1 },
	{ key: "new-club", label: "New Club", order: 2 },
	{ key: "ambient-new-age", label: "Ambient / New Age", order: 3 },
	{ key: "electronica-downtempo", label: "Electronica / Downtempo", order: 4 },
	{ key: "avant-garde", label: "Avant-Garde", order: 5 },
	{ key: "post-punk-new-wave", label: "Post-Punk / New Wave", order: 6 },
	{ key: "alternative-rock-punk", label: "Alternative Rock / Punk", order: 7 },
	{ key: "rock", label: "Rock", order: 8 },
	{ key: "metal", label: "Metal", order: 9 },
	{ key: "hip-hop-r-n-b", label: "Hip-Hop / R'n'B", order: 10 },
	{ key: "soul-rhythm-and-blues", label: "Soul / Rhythm & Blues", order: 11 },
	{ key: "disco-boogie", label: "Disco / Boogie", order: 12 },
	{ key: "jazz", label: "Jazz", order: 13 },
	{ key: "caribbean", label: "Caribbean", order: 14 },
	{ key: "classical-opera", label: "Classical / Opera", order: 15 },
	{ key: "other", label: "Other", order: 16 },
	{ key: "latin-brazilian", label: "Latin / Brazilian", order: 17 },
	{ key: "african-middle-eastern", label: "African / Middle Eastern", order: 18 },
	{ key: "asia", label: "Asia", order: 19 },
] as const;
type CoverageFamily = (typeof coverageFamilies)[number]["key"];
type CoverageChoiceSeed = { id: string; family: CoverageFamily; name?: string };
type CoverageIds = Partial<Record<CoverageFamily, string>>;

function coverageTargets(idsByFamily: CoverageIds): CoverageChoiceSeed[] {
	return coverageFamilies.flatMap(({ key }) =>
		(idsByFamily[key]?.match(/\S+/g) ?? []).map((id) => ({ id, family: key })),
	);
}

const initialTargets = coverageTargets({
	"house-techno": `Q341364 Q341395 Q9149801 Q1071961 Q874038 Q108610706 Q526463 Q1262781
		Q217597 Q627906 Q105636937 Q928825 Q20502 Q29480448 Q1931555 Q750811
		Q1430587 Q915152 Q898709 Q598593 Q170611 Q170435`,
	"uk-dance-grime": `Q1751409 Q663519 Q1585075 Q903735 Q56580 Q1259016 Q188994
		Q20474 Q5510816 Q1166726 Q1102161 Q106130091 Q1165777`,
	"new-club": "Q20903 Q2963621 Q2346991",
	"ambient-new-age": `Q193207 Q3613770 Q2465085 Q530750 Q121494463
		Q613874 Q213121 Q79784514 Q16625659 Q2342263`,
	"electronica-downtempo": `local:abstract-electronic Q2187392 local:braindance Q251192 Q9778
		Q817138 Q1100989 Q85765918 Q660984 Q325397 Q1507298 Q205560 Q106369996`,
	"avant-garde": `Q756956 Q650316 Q1326777 Q1640319 Q105763581
		Q3503814 Q1045756 Q823560 Q726239 Q507246`,
	"post-punk-new-wave": "Q1643549 Q188450 Q487965 Q187760 Q598929 Q1298934",
	"alternative-rock-punk": `Q1695023 Q11366 Q217467 Q1641839 Q211573 local:guitar-pop
		Q10922 Q1317816 Q842324 Q183504 Q1190565 Q181861 Q209137 Q27190 Q3071 Q236913 Q370778`,
	rock: `Q379033 Q193355 local:desert-rock Q5320459 Q43343 Q186472 Q76092 Q83270
		Q320592 Q484641 Q49451 local:psychedelia Q206159 Q7749 Q89363113 Q106621063`,
	metal: "Q1433387 local:experimental-metal Q41343",
	"hip-hop-r-n-b": "Q11401 Q138020",
	"soul-rhythm-and-blues": "Q9759 Q164444 Q180268 Q45981 Q131272",
	"disco-boogie": "Q58339 Q1374731",
	jazz: "Q790188 Q105513 Q5928480 Q327547 Q211781 Q181010 Q105527 Q1136331",
	caribbean: "Q212688 Q9794 Q1299260",
	"classical-opera": "Q9730 Q612024 Q12183214 Q572901 Q65937946",
	other: "Q25094849 Q9162904 Q2280497 Q211756 Q1166158 Q25094591 Q37073 Q264289",
});

const p2Targets = coverageTargets({
	"house-techno": `Q106528337 Q481900 local:balearic-house Q65937774 Q2406633 local:euro-house
		Q216961 Q820049 Q2748817 Q1521688 Q339906 Q223840 Q601235 Q105636940
		local:leftfield-techno Q3048168`,
	"new-club": "Q25099840 Q85741139",
	metal: "Q132438 Q483251",
	"hip-hop-r-n-b": `Q438503 Q7118426 Q529742 local:chopped-n-screwed Q19879476 Q16829781
		Q141459 Q8560269 Q15697534 Q876171 Q12362064 Q5421158 Q1045541 Q753679
		Q255406 Q97265899 local:memphis Q6918602 Q840065 local:rap local:rnb Q2913982`,
	"disco-boogie": "Q4942839 local:classic-disco Q336567",
	"latin-brazilian": "Q486263 Q723418 Q208239 Q11403 Q14390274",
	caribbean: "Q474027 Q54365",
	"african-middle-eastern": "Q388296 local:ethiopian-jazz Q2000173 Q963061 Q1752683",
	asia: "local:bollywood Q11307326 Q194492 Q131578 Q213665",
});

const deliveryOnlyTargets = coverageTargets({
	"house-techno": "Q622871",
	"new-club": "Q96740854",
});

function coverageSource(id: string): GenreNode["slug"] {
	return `genre:${id}`;
}

function coverageChoice(seed: CoverageChoiceSeed, published: boolean): GenreTaxonomy["genres"][number] {
	return {
		id: seed.id,
		...(seed.id.startsWith("Q") ? { qid: seed.id } : {}),
		name: seed.name ?? seed.id,
		family: seed.family,
		published,
		sourceSlugs: [coverageSource(seed.id)],
	};
}

function initialChoices(): GenreTaxonomy["genres"] {
	return initialTargets.map((target) => coverageChoice(target, true));
}

function choicesForMode(mode: "coverage-p2" | "publication-p2" | "delivery"): GenreTaxonomy["genres"] {
	return [
		...initialChoices(),
		...p2Targets.map((target) => coverageChoice(target, true)),
		...(mode === "delivery" ? deliveryOnlyTargets.map((target) => coverageChoice(target, true)) : []),
	];
}

function sortedIds(choices: ReadonlyArray<{ id: string }>): string[] {
	return choices.map(({ id }) => id).sort();
}

function coverageTaxonomy(genres: GenreTaxonomy["genres"]): GenreTaxonomy {
	return { version: 2, families: coverageFamilies.map((family) => ({ ...family })), genres };
}

async function materializeChoices(
	cache: NodeCache,
	choices: GenreTaxonomy["genres"],
	omitIds: ReadonlySet<string> = new Set(),
): Promise<GraphProjection> {
	const support = "genre:coverage-support";
	const nodes: VizNode[] = [vizNode(support, "genre")];
	const edges: GraphProjection["edges"] = [];
	await cache.write(genre(support, "Coverage support"));
	for (const [index, choice] of choices.entries()) {
		if (omitIds.has(choice.id)) continue;
		const slug = coverageSource(choice.id);
		await cache.write(genre(slug, choice.name, choice.qid));
		const artist = `artist:coverage-${index}`;
		const project = `project:coverage-${index}`;
		const track = `track:coverage-${index}`;
		nodes.push(
			vizNode(slug, "genre"),
			vizNode(artist, "artist"),
			vizNode(project, "project"),
			vizNode(track, "track"),
		);
		edges.push(
			{ source: slug, target: support, kind: "related_genres" },
			{ source: slug, target: artist, kind: "key_artists" },
			{ source: project, target: slug, kind: "genres" },
			{ source: slug, target: track, kind: "landmark_tracks" },
		);
	}
	return projection(nodes, edges);
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

describe("publication eligibility floor (TRA-59)", () => {
	it("marks a published entry with only two canonical neighbours as inadmissible", async () => {
		const cache = new NodeCache(directory);
		await cache.write(genre("genre:two", "Two neighbours", "Q2"));
		await cache.write(genre("genre:support", "Support genre"));
		const choices = [
			{
				id: "Q2",
				qid: "Q2",
				name: "Two neighbours",
				family: "electronic",
				published: true,
				sourceSlugs: ["genre:two"],
			},
		] satisfies GenreTaxonomy["genres"];

		const report = await measureGenreCoverage(
			taxonomy(choices),
			cache,
			projection(
				[
					vizNode("genre:two", "genre"),
					vizNode("genre:support", "genre"),
					vizNode("artist:one", "artist"),
					vizNode("project:two", "project"),
					vizNode("label:ignored", "label"),
				],
				[
					{ source: "genre:two", target: "genre:support", kind: "related_genres" },
					{ source: "genre:two", target: "artist:one", kind: "key_artists" },
					{ source: "project:two", target: "genre:two", kind: "genres" },
					{ source: "genre:two", target: "label:ignored", kind: "key_labels" },
				],
			),
		);

		expect(report.entries.Q2).toMatchObject({
			resolvedSources: ["genre:two"],
			neighbourCount: 2,
			deficit: 1,
			publishable: false,
		});
		expect(() => assertPublishedEntriesAreAdmissible(report, choices)).toThrow(/published entry Q2/);
	});

	it("marks a published entry with exactly three canonical neighbours as admissible", async () => {
		const cache = new NodeCache(directory);
		await cache.write(genre("genre:three", "Three neighbours", "Q3"));
		await cache.write(genre("genre:support", "Support genre"));
		const choices = [
			{
				id: "Q3",
				qid: "Q3",
				name: "Three neighbours",
				family: "electronic",
				published: true,
				sourceSlugs: ["genre:three"],
			},
		] satisfies GenreTaxonomy["genres"];

		const report = await measureGenreCoverage(
			taxonomy(choices),
			cache,
			projection(
				[
					vizNode("genre:three", "genre"),
					vizNode("genre:support", "genre"),
					vizNode("artist:one", "artist"),
					vizNode("project:two", "project"),
					vizNode("track:three", "track"),
				],
				[
					{ source: "genre:three", target: "genre:support", kind: "related_genres" },
					{ source: "genre:three", target: "artist:one", kind: "key_artists" },
					{ source: "project:two", target: "genre:three", kind: "genres" },
					{ source: "genre:three", target: "track:three", kind: "landmark_tracks" },
				],
			),
		);

		expect(report.entries.Q3).toMatchObject({
			resolvedSources: ["genre:three"],
			neighbourCount: 3,
			deficit: 0,
			publishable: true,
		});
		assertPublishedEntriesAreAdmissible(report, choices);
	});

	it("excludes a published=false reserve from the publication floor before part two", async () => {
		const cache = new NodeCache(directory);
		await cache.write(genre("genre:published", "Published choice", "Q3"));
		await cache.write(genre("genre:reserve", "Reserved choice", "Q2"));
		await cache.write(genre("genre:support", "Support genre"));

		const choices = [
			{
				id: "Q3",
				qid: "Q3",
				name: "Published choice",
				family: "electronic",
				published: true,
				sourceSlugs: ["genre:published"],
			},
			{
				id: "Q2",
				qid: "Q2",
				name: "Reserved choice",
				family: "electronic",
				published: false,
				sourceSlugs: ["genre:reserve"],
			},
		] satisfies GenreTaxonomy["genres"];
		const report = await measureGenreCoverage(
			taxonomy(choices),
			cache,
			projection(
				[
					vizNode("genre:published", "genre"),
					vizNode("genre:reserve", "genre"),
					vizNode("genre:support", "genre"),
					vizNode("artist:one", "artist"),
					vizNode("project:two", "project"),
					vizNode("track:three", "track"),
					vizNode("artist:four", "artist"),
					vizNode("project:five", "project"),
				],
				[
					{ source: "genre:published", target: "genre:support", kind: "related_genres" },
					{ source: "genre:reserve", target: "genre:support", kind: "related_genres" },
					{ source: "genre:published", target: "artist:one", kind: "key_artists" },
					{ source: "project:two", target: "genre:published", kind: "genres" },
					{ source: "genre:published", target: "track:three", kind: "landmark_tracks" },
					{ source: "genre:reserve", target: "artist:four", kind: "key_artists" },
					{ source: "project:five", target: "genre:reserve", kind: "genres" },
				],
			),
		);

		expect(report.entries.Q2).toMatchObject({
			neighbourCount: 2,
			deficit: 1,
			publishable: false,
		});
		assertPublishedEntriesAreAdmissible(report, choices);
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

describe("coverage and publication objectives (TRA-65)", () => {
	it("checks the exact 62 P2 targets and all 20 family floors before publication", async () => {
		const choices = choicesForMode("coverage-p2");
		const cache = new NodeCache(directory);
		const graph = await materializeChoices(cache, choices);
		const report = await measureGenreCoverage(coverageTaxonomy(choices), cache, graph);

		expect(p2Targets).toHaveLength(62);
		expect(new Set(p2Targets.map(({ id }) => id)).size).toBe(62);
		for (const target of p2Targets) {
			expect(report.entries[target.id]?.publishable, `P2 target ${target.id} must be admissible`).toBe(true);
		}
		for (const family of coverageFamilies) {
			expect(report.families[family.key]?.entries).toBeGreaterThanOrEqual(5);
		}
	});

	it("requires exactly 208 P2 choices with the contracted House/Techno and Hip-Hop/RnB counts", async () => {
		const choices = choicesForMode("publication-p2");
		const expectedChoices = [...initialTargets, ...p2Targets];

		expect(choices).toHaveLength(208);
		expect(sortedIds(choices)).toEqual(sortedIds(expectedChoices));
		expect(choices.filter(({ family }) => family === "house-techno")).toHaveLength(38);
		expect(choices.filter(({ family }) => family === "hip-hop-r-n-b")).toHaveLength(24);
	});

	it("keeps delivery-only targets out of progressive imports and admits all 210 final choices", async () => {
		const progressiveChoices = choicesForMode("publication-p2");
		const deliveryChoices = choicesForMode("delivery");
		const expectedDeliveryChoices = [...initialTargets, ...p2Targets, ...deliveryOnlyTargets];

		expect(progressiveChoices).toHaveLength(208);
		expect(sortedIds(progressiveChoices)).toEqual(sortedIds([...initialTargets, ...p2Targets]));
		expect(progressiveChoices.some(({ id }) => deliveryOnlyTargets.some((target) => target.id === id))).toBe(
			false,
		);
		expect(deliveryChoices).toHaveLength(210);
		expect(sortedIds(deliveryChoices)).toEqual(sortedIds(expectedDeliveryChoices));
		expect(deliveryChoices.filter(({ family }) => family === "house-techno")).toHaveLength(39);
		expect(deliveryChoices.filter(({ family }) => family === "hip-hop-r-n-b")).toHaveLength(24);

		const cache = new NodeCache(directory);
		const graph = await materializeChoices(cache, deliveryChoices);
		const report = await measureGenreCoverage(coverageTaxonomy(deliveryChoices), cache, graph);
		for (const choice of deliveryChoices) {
			expect(report.entries[choice.id]?.publishable, `delivery choice ${choice.id} must be admissible`).toBe(
				true,
			);
		}
	});

	it("rejects a missing target even when its family has more than five entries", async () => {
		const targetId = "Q999003";
		const choices = Array.from({ length: 6 }, (_, index) =>
			coverageChoice(
				{
					id: index === 5 ? targetId : `local:floor-${index + 1}`,
					name: index === 5 ? "Missing target" : `Floor entry ${index + 1}`,
					family: "house-techno",
				},
				true,
			),
		);
		const cache = new NodeCache(directory);
		const graph = await materializeChoices(cache, choices, new Set([targetId]));
		const report = await measureGenreCoverage(coverageTaxonomy(choices), cache, graph);

		expect(report.families["house-techno"]?.entries).toBe(6);
		expect(report.entries[targetId]).toMatchObject({
			resolvedSources: [],
			missingSources: [coverageSource(targetId)],
			neighbourCount: 0,
			deficit: 3,
			publishable: false,
		});
	});

	it("rejects a quarantined target after the genre relation is reconstructed", async () => {
		const choice = coverageChoice(
			{ id: "Q999001", name: "Quarantined target", family: "house-techno" },
			true,
		);
		const cache = new NodeCache(directory);
		const graph = await materializeChoices(cache, [choice]);
		graph.quarantine = [
			{ id: coverageSource(choice.id), name: choice.name, reason: "genre relation quarantine" },
		];

		const report = await measureGenreCoverage(coverageTaxonomy([choice]), cache, graph);
		expect(report.entries[choice.id]).toMatchObject({
			quarantinedSources: [coverageSource(choice.id)],
			neighbourCount: 0,
			publishable: false,
		});
	});

	it("counts shared canonical neighbours once when a target has an alias source", async () => {
		const choice = {
			id: "Q999002",
			qid: "Q999002",
			name: "Aliased target",
			family: "house-techno",
			published: true,
			sourceSlugs: ["genre:alias", "genre:canonical"],
		} satisfies GenreTaxonomy["genres"][number];
		const cache = new NodeCache(directory);
		await cache.write(genre("genre:canonical", "Canonical", "Q999002"));
		await cache.write(genre("genre:alias", "Alias"));
		const graph = projection(
			[
				vizNode("genre:canonical", "genre"),
				vizNode("genre:alias", "genre"),
				vizNode("artist:shared", "artist"),
				vizNode("project:shared", "project"),
				vizNode("track:shared", "track"),
			],
			[
				{ source: "genre:canonical", target: "artist:shared", kind: "key_artists" },
				{ source: "genre:alias", target: "artist:shared", kind: "key_artists" },
				{ source: "project:shared", target: "genre:canonical", kind: "genres" },
				{ source: "project:shared", target: "genre:alias", kind: "genres" },
				{ source: "genre:canonical", target: "track:shared", kind: "landmark_tracks" },
				{ source: "genre:alias", target: "track:shared", kind: "landmark_tracks" },
				{ source: "genre:canonical", target: "genre:alias", kind: "related_genres" },
			],
		);

		const report = await measureGenreCoverage(coverageTaxonomy([choice]), cache, graph);
		expect(report.entries[choice.id]).toMatchObject({
			resolvedSources: ["genre:alias", "genre:canonical"],
			neighbourCount: 3,
			publishable: true,
		});
	});
});
