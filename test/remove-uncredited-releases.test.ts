import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MIGRATION_NAME,
	parseCliArgs,
	type RemovalList,
	runMigration,
} from "../scripts/migrations/2026-10-24-remove-uncredited-releases.js";

// TRA-485: the closed removal of the works no credit can be proven for. Raw records, as the migrations read them.

type Obj = Record<string, unknown>;
const article = "A real long article about the test node. ".repeat(4);

const edge = (slug: string, name: string) => ({ slug, type: slug.slice(0, slug.indexOf(":")), name });

const project = (slug: string, overrides: Obj = {}): Obj => ({
	type: "project",
	slug,
	name: slug.replace("project:", ""),
	editorial_pitch: "A pitch.",
	editorial_article: article,
	citations: [{ url: "https://example.com/p", title: "P" }],
	materialized_at: "2026-05-13T13:51:00.910Z",
	artists: [],
	genres: [],
	tracklist: [],
	producers: [],
	related_projects: [],
	...overrides,
});

const track = (slug: string, overrides: Obj = {}): Obj => ({
	type: "track",
	slug,
	name: slug.replace("track:", ""),
	editorial_teaser: "A teaser.",
	editorial_article: article,
	citations: [{ url: "https://example.com/t", title: "T" }],
	materialized_at: "2026-05-14T09:33:56.770Z",
	artists: [],
	genres: [],
	producers: [],
	samples: [],
	sampled_by: [],
	remixed_by: [],
	...overrides,
});

const artist = (slug: string, overrides: Obj = {}): Obj => ({
	type: "artist",
	slug,
	name: slug.replace("artist:", ""),
	editorial_bio: "A bio.",
	editorial_article: article,
	citations: [{ url: "https://example.com/a", title: "A" }],
	materialized_at: "2026-10-01T00:00:00.000Z",
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
	...overrides,
});

let root: string;
const cacheDir = () => join(root, "cache");
const nodePath = (slug: string) => {
	const i = slug.indexOf(":");
	return join(cacheDir(), "nodes", slug.slice(0, i), `${slug.slice(i + 1)}.json`);
};
const seed = async (...nodes: Obj[]) => {
	for (const node of nodes) {
		await mkdir(dirname(nodePath(node.slug as string)), { recursive: true });
		await writeFile(nodePath(node.slug as string), `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
};
const readNode = async (slug: string) => JSON.parse(await readFile(nodePath(slug), "utf8")) as Obj;
const exists = (slug: string) =>
	stat(nodePath(slug)).then(
		() => true,
		() => false,
	);
const list = (...slugs: string[]): RemovalList => ({
	source: "test",
	slugs: slugs.map((slug) => ({ slug, reason: "test" })),
});

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "remove-uncredited-"));
	await mkdir(join(cacheDir(), "nodes"), { recursive: true });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const run = (apply: boolean, l: RemovalList) =>
	runMigration({ cacheDir: cacheDir(), apply, manifestPath: join(root, "out", "m.json"), list: l });

describe("remove-uncredited-releases", () => {
	it("removes the work, every edge that points at it (list and singular) and the pending reverses", async () => {
		await seed(
			project("project:orphan-lp"),
			track("track:orphan-song", { project: edge("project:orphan-lp", "Orphan") }),
			artist("artist:someone", {
				discography: [edge("project:orphan-lp", "Orphan"), edge("project:kept-lp", "Kept")],
				landmark_project: edge("project:orphan-lp", "Orphan"),
			}),
			project("project:kept-lp", { artists: [edge("artist:someone", "Someone")] }),
		);
		await writeFile(
			join(cacheDir(), "pending-reverses.json"),
			JSON.stringify({
				"artist:later": [
					{ field: "discography", cardinality: "list", edge: edge("project:orphan-lp", "Orphan") },
				],
			}),
		);

		const { manifest, exitCode } = await run(true, list("project:orphan-lp"));

		expect(exitCode).toBe(0);
		expect(await exists("project:orphan-lp")).toBe(false);
		const someone = await readNode("artist:someone");
		expect((someone.discography as Obj[]).map((e) => e.slug)).toEqual(["project:kept-lp"]);
		expect(someone.landmark_project).toBeUndefined();
		expect((await readNode("track:orphan-song")).project).toBeUndefined();
		expect(JSON.parse(await readFile(join(cacheDir(), "pending-reverses.json"), "utf8"))).toEqual({});
		expect(manifest.works).toEqual([{ slug: "project:orphan-lp", reason: "test", edgesDropped: 3 }]);
		expect(manifest.removed).toEqual(["nodes/project/orphan-lp.json"]);
		expect(manifest.renamed).toEqual({});
		expect(manifest.redirects).toEqual({});
	});

	it("a dry-run changes nothing on disk but still writes the manifest", async () => {
		await seed(
			project("project:dry-lp"),
			artist("artist:dry", { discography: [edge("project:dry-lp", "Dry")] }),
		);
		const before = await readFile(nodePath("artist:dry"), "utf8");

		const { manifest, exitCode } = await run(false, list("project:dry-lp"));

		expect(exitCode).toBe(0);
		expect(manifest.mode).toBe("dry-run");
		expect(await exists("project:dry-lp")).toBe(true);
		expect(await readFile(nodePath("artist:dry"), "utf8")).toBe(before);
		expect(JSON.parse(await readFile(join(root, "out", "m.json"), "utf8")).removed).toEqual([
			"nodes/project/dry-lp.json",
		]);
	});

	it("refuses a work that has a credit now, and keeps it with the edges to it", async () => {
		await seed(
			project("project:credited-lp", { artists: [edge("artist:owner", "Owner")] }),
			artist("artist:owner", { discography: [edge("project:credited-lp", "Credited")] }),
		);

		const { manifest, exitCode } = await run(true, list("project:credited-lp"));

		expect(exitCode).toBe(0);
		expect(manifest.refused).toEqual([{ slug: "project:credited-lp", reason: "it has a credit now" }]);
		expect(manifest.removed).toEqual([]);
		expect(await exists("project:credited-lp")).toBe(true);
		expect(((await readNode("artist:owner")).discography as Obj[]).length).toBe(1);
	});

	it("reports a work already gone, and a second run is a no-op", async () => {
		await seed(track("track:gone-song"));
		await run(true, list("track:gone-song"));

		const second = await run(true, list("track:gone-song"));

		expect(second.exitCode).toBe(0);
		expect(second.manifest.alreadyRemoved).toEqual(["track:gone-song"]);
		expect(second.manifest.removed).toEqual([]);
	});

	it("writes nothing and exits 2 when a node file is unreadable", async () => {
		await seed(project("project:blocked-lp"));
		await writeFile(join(cacheDir(), "pending-reverses.json"), "{not json");

		const { manifest, exitCode } = await run(true, list("project:blocked-lp"));

		expect(exitCode).toBe(2);
		expect(manifest.blocked).toBe(true);
		expect(await exists("project:blocked-lp")).toBe(true);
	});

	it("reads the committed list: every entry is a project / track slug, and on an empty cache all are already gone", async () => {
		const { manifest, exitCode } = await runMigration({ cacheDir: cacheDir(), apply: false });

		expect(exitCode).toBe(0);
		expect(manifest.errors).toEqual([]);
		expect(manifest.alreadyRemoved.length).toBeGreaterThan(0);
		expect(manifest.alreadyRemoved.every((slug) => /^(project|track):/.test(slug))).toBe(true);
	});
});

describe("the migration channel", () => {
	it("accepts the migration: a script of that name exists and the name matches the channel's pattern", () => {
		const script = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"scripts",
			"migrations",
			`${MIGRATION_NAME}.ts`,
		);
		expect(existsSync(script)).toBe(true);
		expect(MIGRATION_NAME).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/);
	});

	it("takes the flags the channel passes", () => {
		expect(parseCliArgs(["cache", "--apply", "--manifest", "m.json", "--data-dir", "d"])).toEqual({
			cacheDir: "cache",
			apply: true,
			manifestPath: "m.json",
		});
		expect(parseCliArgs(["cache", "--force"])).toBeNull();
	});
});
