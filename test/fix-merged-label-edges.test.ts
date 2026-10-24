import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	KEPT,
	type Manifest,
	MIGRATION_NAME,
	parseCliArgs,
	runMigration,
	STEPS,
} from "../scripts/migrations/2026-10-24-fix-merged-label-edges.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

const PARAGRAPH = "A real paragraph about the node, long enough for the cache invariants to hold, by far.";
const CITATIONS = [{ url: "https://example.com/source", title: "Source" }];

type Obj = Record<string, unknown>;

const edge = (slug: string, name: string, extra: Obj = {}): Obj => ({
	slug,
	type: slug.slice(0, slug.indexOf(":")),
	name,
	...extra,
});

const base = (slug: Slug, o: Obj): Obj => ({
	slug,
	name: slug,
	editorial_article: PARAGRAPH,
	citations: CITATIONS,
	materialized_at: "2026-10-16T00:00:00.000Z",
	...o,
});

const label = (slug: Slug, o: Obj = {}): Obj =>
	base(slug, {
		type: "label",
		editorial_description: "A short description.",
		genres: [],
		roster: [],
		notable_releases: [],
		...o,
	});

const project = (slug: Slug, o: Obj = {}): Obj =>
	base(slug, {
		type: "project",
		editorial_pitch: "A short pitch.",
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
		...o,
	});

const artist = (slug: Slug, o: Obj = {}): Obj =>
	base(slug, {
		type: "artist",
		editorial_bio: "A short bio.",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...o,
	});

// The edges the closed list is written against, as the cache holds them (2026-10-24).
const COLUMBIA = edge("label:columbia", "Columbia");
const REPHLEX = edge("label:rephlex", "Rephlex");
const WARP = edge("label:warp", "Warp");
const PIPER = edge("project:the-piper-at-the-gates-of-dawn--pink-floyd", "The Piper at the Gates of Dawn", {
	artist: "Pink Floyd",
});
const SAW = edge("project:selected-ambient-works-85-92", "Selected Ambient Works 85–92");
const HND = edge("project:hard-normal-daddy--squarepusher", "Hard Normal Daddy");
const POLYESTER_DANGLING = edge("project:polyester", "Polyester");
const POLYESTER = edge("project:polyester--lisa-carbon", "Polyester", { artist: "Lisa Carbon" });
const STANDARDS = edge("project:standards--lisa-carbon", "Standards", {
	mbid: "0927c813-aa54-3de7-9c21-0ec36f70f6b0",
	year: "2003",
});
const KIND_OF_BLUE = edge("project:kind-of-blue--miles-davis", "Kind of Blue");
const ANALORD = edge("project:analord", "Analord");
const ARTIFICIAL = edge("project:artificial-intelligence", "Artificial Intelligence");

/** Everything the closed list touches, and the neighbours it must leave alone, in their pre-fix state. */
function nodes(): Obj[] {
	return [
		// detach: Piper on Columbia
		project("project:the-piper-at-the-gates-of-dawn--pink-floyd", {
			label: COLUMBIA,
			artists: [edge("artist:pink-floyd", "Pink Floyd")],
		}),
		label("label:columbia", {
			founded: "1889",
			roster: [edge("artist:bob-dylan", "Bob Dylan")],
			notable_releases: [PIPER, KIND_OF_BLUE],
		}),
		// detach: SAW 85-92 and Hard Normal Daddy on Rephlex, the dangling Polyester
		project("project:selected-ambient-works-85-92"),
		project("project:hard-normal-daddy--squarepusher", { label: WARP }),
		project("project:polyester--lisa-carbon", { label: REPHLEX }),
		label("label:rephlex", {
			active_years: "1991-2014",
			roster: [edge("artist:aphex-twin", "Aphex Twin")],
			notable_releases: [SAW, HND, ANALORD, POLYESTER_DANGLING, POLYESTER],
		}),
		// neighbours that hold the same projects and are NOT in the list
		label("label:warp", {
			notable_releases: [ARTIFICIAL, SAW, HND],
			roster: [edge("artist:wolfgang-voigt", "Wolfgang Voigt")],
		}),
		label("label:apollo", { notable_releases: [SAW] }),
		// kept: E.G. Records (the proofs on its end date contradict each other)
		label("label:e-g-records", { founded: "1969", active_years: "1969–1996" }),
		// retarget: Lisa Carbon's dangling Polyester, in the discography and as the landmark
		artist("artist:lisa-carbon", {
			labels: [edge("label:sub-rosa", "Sub Rosa")],
			discography: [STANDARDS, POLYESTER_DANGLING, POLYESTER],
			landmark_project: POLYESTER_DANGLING,
		}),
		// kept: Wolfgang Voigt on Warp
		artist("artist:wolfgang-voigt", {
			labels: [edge("label:kompakt", "Kompakt"), WARP, edge("label:raster-noton", "Raster-Noton")],
		}),
	];
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "fix-merged-label-edges-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeCache(list: readonly Obj[]): Promise<void> {
	for (const node of list) {
		const { type, body } = parseSlug(node.slug as Slug);
		const file = join(dir, "nodes", type, `${body}.json`);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
}

async function readNode(slug: Slug): Promise<Obj> {
	const { type, body } = parseSlug(slug);
	return JSON.parse(await readFile(join(dir, "nodes", type, `${body}.json`), "utf8")) as Obj;
}

async function snapshot(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const type of await readdir(join(dir, "nodes"))) {
		for (const f of await readdir(join(dir, "nodes", type))) {
			out[`${type}/${f}`] = await readFile(join(dir, "nodes", type, f), "utf8");
		}
	}
	return out;
}

async function run(apply: boolean): Promise<Manifest> {
	const result = await runMigration({ cacheDir: dir, apply });
	expect(result.manifest.errors).toEqual([]);
	expect(result.exitCode).toBe(0);
	return result.manifest;
}

const slugsOf = (list: unknown): string[] => (list as Obj[]).map((e) => e.slug as string);
const without = (node: Obj, key: string): Obj => {
	const { [key]: _dropped, ...rest } = node;
	return rest;
};

describe("fix-merged-label-edges: the closed list", () => {
	it("holds exactly the six steps of TRA-609 (adding one is a reviewed change)", () => {
		expect(
			STEPS.map((s) =>
				s.kind === "detach"
					? `detach ${s.project} from ${s.label}`
					: `retarget ${s.node} ${s.fields.join("+")} ${s.from} -> ${s.to}`,
			),
		).toEqual([
			"detach project:the-piper-at-the-gates-of-dawn--pink-floyd from label:columbia",
			"detach project:selected-ambient-works-85-92 from label:rephlex",
			"detach project:selected-ambient-works-85-92 from label:warp",
			"detach project:hard-normal-daddy--squarepusher from label:rephlex",
			"detach project:polyester from label:rephlex",
			"retarget artist:lisa-carbon discography+landmark_project project:polyester -> project:polyester--lisa-carbon",
		]);
	});

	it("gives every step and every kept case a written proof", () => {
		for (const s of STEPS) expect(s.evidence.length).toBeGreaterThan(80);
		for (const k of KEPT) expect(k.evidence.length).toBeGreaterThan(80);
	});

	it("keeps Wolfgang Voigt on Warp, E.G.'s end date and Polyester (Lisa Carbon) on Rephlex: no step may name them", () => {
		expect(KEPT.map((k) => `${k.node} ${k.edge}`)).toEqual([
			"artist:wolfgang-voigt label:warp",
			"label:e-g-records active_years",
			"project:polyester--lisa-carbon label:rephlex",
		]);
		const touched = STEPS.flatMap((s) => (s.kind === "detach" ? [s.project] : [s.node]));
		expect(touched).not.toContain("artist:wolfgang-voigt");
		expect(touched).not.toContain("label:e-g-records");
		expect(touched).not.toContain("project:polyester--lisa-carbon");
	});
});

describe("fix-merged-label-edges: one test per case, and nothing else moves", () => {
	it("Piper at the Gates of Dawn: the project loses label:columbia, Columbia loses the release", async () => {
		const before = nodes();
		await writeCache(before);
		await run(true);

		const piper = await readNode("project:the-piper-at-the-gates-of-dawn--pink-floyd");
		expect(piper).toEqual(without(before[0] as Obj, "label"));
		const columbia = await readNode("label:columbia");
		expect(columbia).toEqual({ ...(before[1] as Obj), notable_releases: [KIND_OF_BLUE] });
	});

	it("Selected Ambient Works 85-92: Rephlex drops it, the project (no label) and Apollo keep theirs", async () => {
		const before = nodes();
		await writeCache(before);
		await run(true);
		expect(slugsOf((await readNode("label:rephlex")).notable_releases)).not.toContain(SAW.slug);
		expect(await readNode("project:selected-ambient-works-85-92")).toEqual(before[2]);
		expect(await readNode("label:apollo")).toEqual(before[7]);
	});

	it("Hard Normal Daddy: Rephlex drops it, the project stays on Warp, and so does Warp's entry", async () => {
		const before = nodes();
		await writeCache(before);
		await run(true);
		expect(slugsOf((await readNode("label:rephlex")).notable_releases)).not.toContain(HND.slug);
		expect((await readNode("project:hard-normal-daddy--squarepusher")).label).toEqual(WARP);
		expect(slugsOf((await readNode("label:warp")).notable_releases)).toContain(HND.slug);
	});

	it("Selected Ambient Works 85-92 on Warp: Warp drops it, keeps its other releases in order and its roster", async () => {
		const before = nodes();
		await writeCache(before);
		await run(true);
		const warp = await readNode("label:warp");
		expect(warp).toEqual({ ...(before[6] as Obj), notable_releases: [ARTIFICIAL, HND] });
		expect(await readNode("label:apollo")).toEqual(before[7]);
	});

	it("Lisa Carbon: the dangling Polyester leaves the discography, the landmark takes the canonical entry", async () => {
		const before = nodes();
		await writeCache(before);
		await run(true);
		const lisa = await readNode("artist:lisa-carbon");
		expect(lisa).toEqual({
			...(before[9] as Obj),
			discography: [STANDARDS, POLYESTER],
			landmark_project: POLYESTER,
		});
		expect(lisa.landmark_project).not.toBe(POLYESTER);
	});

	it("Lisa Carbon: with no canonical entry in the discography, the dangling one is re-pointed in place", async () => {
		const bare = nodes().map((n) =>
			n.slug === "artist:lisa-carbon" ? { ...n, discography: [STANDARDS, POLYESTER_DANGLING] } : n,
		);
		await writeCache(bare);
		const manifest = await run(true);
		const lisa = await readNode("artist:lisa-carbon");
		expect(slugsOf(lisa.discography)).toEqual([STANDARDS.slug, POLYESTER.slug]);
		expect(lisa.discography).toContainEqual({ ...POLYESTER_DANGLING, slug: POLYESTER.slug });
		expect(lisa.landmark_project).toEqual({ ...POLYESTER_DANGLING, slug: POLYESTER.slug });
		expect(manifest.changed.filter((c) => c.node === "artist:lisa-carbon").map((c) => c.action)).toEqual([
			"retargeted",
			"retargeted",
		]);
	});

	it("Lisa Carbon: a landmark that is no longer exactly project:polyester is not ours", async () => {
		const moved = nodes().map((n) =>
			n.slug === "artist:lisa-carbon" ? { ...n, landmark_project: STANDARDS } : n,
		);
		await writeCache(moved);
		const manifest = await run(true);
		expect((await readNode("artist:lisa-carbon")).landmark_project).toEqual(STANDARDS);
		expect(manifest.skipped).toContainEqual({
			node: "artist:lisa-carbon",
			field: "landmark_project",
			reason: "already-clean",
			found: STANDARDS.slug,
		});
	});

	it("Lisa Carbon: the target of the step is the one the committed redirect table gives", () => {
		const table = JSON.parse(readFileSync(join(process.cwd(), "data", "slug-redirects.json"), "utf8")) as {
			redirects?: Record<string, string>;
		} & Record<string, unknown>;
		const redirects = (table.redirects ?? table) as Record<string, string>;
		const step = STEPS.find((s) => s.kind === "retarget");
		expect(step?.kind === "retarget" && redirects[step.from]).toBe(step?.kind === "retarget" ? step.to : "");
	});

	it("Polyester: the dangling duplicate goes, the Lisa Carbon release stays on Rephlex, in order", async () => {
		const before = nodes();
		await writeCache(before);
		await run(true);
		expect(await readNode("project:polyester--lisa-carbon")).toEqual(before[4]);
		expect(slugsOf((await readNode("label:rephlex")).notable_releases)).toEqual([
			"project:analord",
			"project:polyester--lisa-carbon",
		]);
	});

	it("Rephlex: its other fields and its roster do not move", async () => {
		const before = nodes();
		await writeCache(before);
		await run(true);
		const rephlex = await readNode("label:rephlex");
		expect(without(rephlex, "notable_releases")).toEqual(without(before[5] as Obj, "notable_releases"));
	});

	it("E.G. Records: the end date is not proven wrong, the card is byte for byte what it was", async () => {
		await writeCache(nodes());
		const before = (await snapshot())["label/e-g-records.json"];
		const manifest = await run(true);
		expect((await snapshot())["label/e-g-records.json"]).toBe(before);
		expect((await readNode("label:e-g-records")).active_years).toBe("1969–1996");
		expect(manifest.changed.map((c) => c.node)).not.toContain("label:e-g-records");
	});

	it("Wolfgang Voigt: the artist and his three labels are byte for byte what they were", async () => {
		await writeCache(nodes());
		const before = (await snapshot())["artist/wolfgang-voigt.json"];
		const manifest = await run(true);
		expect((await snapshot())["artist/wolfgang-voigt.json"]).toBe(before);
		expect(manifest.changed.map((c) => c.node)).not.toContain("artist:wolfgang-voigt");
	});

	it("writes exactly the five node files the cases need, and reports every change", async () => {
		await writeCache(nodes());
		const manifest = await run(true);
		// piper, columbia, rephlex (three edits, one write), warp, lisa-carbon (two edits, one write).
		expect(manifest.written).toBe(5);
		expect(manifest.changed.map((c) => `${c.node}.${c.field} ${c.action} ${c.from}`)).toEqual([
			"project:the-piper-at-the-gates-of-dawn--pink-floyd.label cleared label:columbia",
			"label:columbia.notable_releases removed project:the-piper-at-the-gates-of-dawn--pink-floyd",
			"label:rephlex.notable_releases removed project:selected-ambient-works-85-92",
			"label:warp.notable_releases removed project:selected-ambient-works-85-92",
			"label:rephlex.notable_releases removed project:hard-normal-daddy--squarepusher",
			"label:rephlex.notable_releases removed project:polyester",
			"artist:lisa-carbon.discography merged project:polyester",
			"artist:lisa-carbon.landmark_project retargeted project:polyester",
		]);
	});

	it("does not touch a node outside the list, even one holding the very same edge", async () => {
		const bystander = label("label:somebody-else", { notable_releases: [PIPER, SAW] });
		const bystanderProject = project("project:another-piper", { label: COLUMBIA });
		await writeCache([...nodes(), bystander, bystanderProject]);
		const before = await snapshot();
		await run(true);
		const after = await snapshot();
		expect(after["label/somebody-else.json"]).toBe(before["label/somebody-else.json"]);
		expect(after["project/another-piper.json"]).toBe(before["project/another-piper.json"]);
	});

	it("leaves the node bytes alone except the edit: the diff of Columbia is the removed entry", async () => {
		await writeCache(nodes());
		const before = (await snapshot())["label/columbia.json"] as string;
		await run(true);
		const after = (await snapshot())["label/columbia.json"] as string;
		expect(after.split("\n").filter((line) => !before.split("\n").includes(line))).toEqual([]);
		expect(
			before
				.split("\n")
				.filter((line) => !after.split("\n").includes(line))
				.join("\n"),
		).toContain("the-piper-at-the-gates-of-dawn--pink-floyd");
	});
});

describe("fix-merged-label-edges: the union (repository + production)", () => {
	it("lists as absent, without error, the nodes that do not exist (project:polyester, dangling)", async () => {
		await writeCache(nodes());
		const manifest = await run(false);
		expect(manifest.skipped).toContainEqual({ node: "project:polyester", field: "label", reason: "absent" });
	});

	it("clears a project.label that production holds for a pair the repository has already cleaned", async () => {
		// Production: the project still says Columbia, the label's list is already clean.
		const clean = nodes().map((n) =>
			n.slug === "label:columbia" ? { ...n, notable_releases: [KIND_OF_BLUE] } : n,
		);
		await writeCache(clean);
		await run(true);
		expect((await readNode("project:the-piper-at-the-gates-of-dawn--pink-floyd")).label).toBeUndefined();
	});

	it("removes every entry a list holds for the slug, when a union left a duplicate", async () => {
		const duplicated = nodes().map((n) =>
			n.slug === "label:columbia" ? { ...n, notable_releases: [PIPER, KIND_OF_BLUE, PIPER] } : n,
		);
		await writeCache(duplicated);
		const manifest = await run(true);
		expect(slugsOf((await readNode("label:columbia")).notable_releases)).toEqual([KIND_OF_BLUE.slug]);
		expect(manifest.changed).toContainEqual({
			node: "label:columbia",
			field: "notable_releases",
			action: "removed",
			from: PIPER.slug,
			to: null,
			entries: 2,
		});
	});
});

describe("fix-merged-label-edges: idempotence and dry-run", () => {
	it("a dry-run writes nothing and its manifest is the apply's, but for the date and the mode", async () => {
		await writeCache(nodes());
		const before = await snapshot();
		const dry = await run(false);
		expect(await snapshot()).toEqual(before);
		expect(dry.mode).toBe("dry-run");
		const applied = await run(true);
		expect(applied.mode).toBe("apply");
		const strip = ({ generated_at: _g, mode: _m, ...rest }: Manifest) => rest;
		expect(strip(applied)).toEqual(strip(dry));
	});

	it("a second apply writes nothing and changes no byte", async () => {
		await writeCache(nodes());
		await run(true);
		const after = await snapshot();
		const second = await run(true);
		expect(second.written).toBe(0);
		expect(second.changed).toEqual([]);
		expect(second.skipped.length).toBeGreaterThan(0);
		expect(await snapshot()).toEqual(after);
	});
});

describe("fix-merged-label-edges: an edge that is not the expected one is not ours", () => {
	it("leaves a project that now holds another label, and says which", async () => {
		const moved = nodes().map((n) =>
			n.slug === "project:the-piper-at-the-gates-of-dawn--pink-floyd"
				? { ...n, label: edge("label:emi", "EMI") }
				: n,
		);
		await writeCache(moved);
		const manifest = await run(true);
		expect((await readNode("project:the-piper-at-the-gates-of-dawn--pink-floyd")).label).toEqual(
			edge("label:emi", "EMI"),
		);
		expect(manifest.skipped).toContainEqual({
			node: "project:the-piper-at-the-gates-of-dawn--pink-floyd",
			field: "label",
			reason: "already-clean",
			found: "label:emi",
		});
	});

	it("reports a node three steps share (label:rephlex) once, absent or unreadable", async () => {
		await writeCache([label("label:e-g-records", { active_years: "1969–1996" })]);
		const absent = await run(false);
		expect(absent.skipped.filter((s) => s.node === "label:rephlex")).toEqual([
			{ node: "label:rephlex", field: "notable_releases", reason: "absent" },
		]);
		await writeFile(join(dir, "nodes", "label", "rephlex.json"), "{ not json", "utf8");
		const broken = await runMigration({ cacheDir: dir, apply: false });
		expect(broken.manifest.errors.filter((e) => e.startsWith("label:rephlex"))).toHaveLength(1);
	});
});

describe("fix-merged-label-edges: a refusal blocks the whole run", () => {
	it("writes nothing when one of the files is not valid JSON, exit 1 in dry-run and 2 with --apply", async () => {
		await writeCache(nodes());
		await writeFile(join(dir, "nodes", "label", "rephlex.json"), "{ not json", "utf8");
		const before = await snapshot();
		const dry = await runMigration({ cacheDir: dir, apply: false });
		expect([dry.exitCode, dry.manifest.blocked, dry.manifest.written]).toEqual([1, true, 0]);
		const applied = await runMigration({ cacheDir: dir, apply: true });
		expect([applied.exitCode, applied.manifest.blocked, applied.manifest.written]).toEqual([2, true, 0]);
		expect(applied.manifest.errors[0]).toContain("label:rephlex");
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a result the schema rejects instead of writing it", async () => {
		const broken = nodes().map((n) =>
			n.slug === "label:columbia" ? { ...n, editorial_article: "short" } : n,
		);
		await writeCache(broken);
		const before = await snapshot();
		const result = await runMigration({ cacheDir: dir, apply: true });
		expect([result.exitCode, result.manifest.written]).toEqual([2, 0]);
		expect(result.manifest.errors[0]).toContain("label:columbia");
		expect(result.manifest.errors[0]).toContain("invalid node");
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a result the schema would strip a field from (an undeclared key), instead of writing it", async () => {
		// nodePayloadSchema drops undeclared keys: the guard (onlyAddsSchemaDefaults) refuses anything the
		// validation would alter, so a stray key on a node the migration edits blocks the whole run.
		const stray = nodes().map((n) =>
			n.slug === "label:columbia" ? { ...n, stray_field: "kept by hand" } : n,
		);
		await writeCache(stray);
		const before = await snapshot();
		const dry = await runMigration({ cacheDir: dir, apply: false });
		const applied = await runMigration({ cacheDir: dir, apply: true });
		expect([dry.exitCode, applied.exitCode, applied.manifest.written]).toEqual([1, 2, 0]);
		expect(applied.manifest.errors).toHaveLength(1);
		expect(applied.manifest.errors[0]).toContain("label:columbia");
		expect(applied.manifest.errors[0]).toContain("would alter fields");
		expect(await snapshot()).toEqual(before);
	});
});

describe("fix-merged-label-edges: the command line", () => {
	it("parses the channel's arguments and refuses the rest", () => {
		expect(parseCliArgs(["/c", "--apply", "--manifest", "/m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/c",
			apply: true,
			manifestPath: "/m.json",
			dataDir: "/d",
		});
		expect(parseCliArgs(["/c"])).toEqual({
			cacheDir: "/c",
			apply: false,
			manifestPath: DEFAULT_MANIFEST_PATH,
			dataDir: undefined,
		});
		for (const bad of [
			[],
			["--apply"],
			["/c", "--bogus"],
			["/c", "--manifest"],
			["/c", "--apply", "--apply"],
		]) {
			expect(parseCliArgs(bad)).toBeNull();
		}
	});

	it("runs end to end with the exact arguments deploy/sync-genre-cache.sh passes", async () => {
		await writeCache(nodes());
		const dataDir = join(dir, "scratch-data");
		await mkdir(dataDir);
		const manifestPath = join(dir, "channel.manifest.json");
		const out = execFileSync(
			join(process.cwd(), "node_modules", ".bin", "tsx"),
			[
				join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`),
				dir,
				"--apply",
				"--manifest",
				manifestPath,
				"--data-dir",
				dataDir,
			],
			{ encoding: "utf8" },
		);
		expect(out).toContain("node files written");
		const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
		expect([m.migration, m.written, m.removed, m.renamed, m.redirects]).toEqual([
			MIGRATION_NAME,
			5,
			[],
			{},
			{},
		]);
		expect((await readNode("artist:lisa-carbon")).landmark_project).toEqual(POLYESTER);
		expect(await readdir(dataDir)).toEqual([]);
	});

	it("exits 2 on a usage error and on a directory that is not a cache", () => {
		const script = join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`);
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		expect(spawnSync(tsx, [script, dir, "--bogus"], { encoding: "utf8" }).status).toBe(2);
		expect(spawnSync(tsx, [script, dir], { encoding: "utf8" }).status).toBe(2);
	});
});

describe("fix-merged-label-edges: the migration channel", () => {
	const script = readFileSync(join(process.cwd(), "deploy", "sync-genre-cache.sh"), "utf8");

	it("its name passes the channel's whitelist and is the name of the file", () => {
		const pattern = /^MIGRATION_NAME_PATTERN='(.+)'$/m.exec(script)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
	});
});
