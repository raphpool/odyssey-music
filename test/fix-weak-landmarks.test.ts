import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyDecision,
	CLOSED_LIST,
	DEFAULT_MANIFEST_PATH,
	type Decision,
	type Manifest,
	MIGRATION_NAME,
	parseCliArgs,
	runMigration,
} from "../scripts/migrations/2026-10-24-fix-weak-landmarks.js";
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

function artist(slug: Slug, o: Obj = {}): Obj {
	return {
		type: "artist",
		slug,
		name: slug,
		editorial_article: PARAGRAPH,
		editorial_bio: "A short bio.",
		citations: CITATIONS,
		materialized_at: "2026-10-16T00:00:00.000Z",
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
	};
}

// The edges the closed list is written against, as the cache holds them (2026-10-24).
const LIVE_FOREVER = edge("project:live-forever", "Live Forever", { year: "2024", releaseType: "single" });
const FABRIC = edge("project:fabriclive-37--caspa", "Fabriclive.37", { artist: "Caspa" });
const EVERYBODY = edge(
	"project:everybody-s-talking-nobody-s-listening",
	"Everybody's Talking, Nobody's Listening",
	{
		mbid: "60830f95-eb92-46b7-a37a-04832173a0db",
		year: "2009",
		releaseType: "album",
	},
);
const DOUGAL_TRACK = edge("track:dj-dougal-takes-control", "DJ Dougal Takes Control");
const STAR_CLUB = edge("project:live-at-the-star-club-in-hamburg-germany-1962", "Live! at the Star-Club");
const LODA = edge("project:obscure-italian-disco-ii-beppe-loda-cuts", "Obscure Italian Disco II", {
	releaseType: "ep",
});
const CARTER = edge("track:tha-carter-iii", "Tha Carter III");
const JACKBOYS = edge("project:jackboys-2", "JackBoys 2");

/** The six artists of the repository, in their pre-fix state; `other` fields prove nothing else moves. */
function repoNodes(): Obj[] {
	return [
		artist("artist:headhunterz", {
			discography: [LIVE_FOREVER],
			landmark_project: LIVE_FOREVER,
			notable_tracks: [edge("track:live-forever", "Live Forever")],
			reference_track: edge("track:live-forever", "Live Forever"),
		}),
		artist("artist:caspa", {
			discography: [EVERYBODY, FABRIC],
			landmark_project: FABRIC,
			notable_tracks: [edge("track:cockney-flute", "Cockney Flute")],
			reference_track: edge("track:cockney-flute", "Cockney Flute"),
		}),
		artist("artist:rusko", {
			discography: [FABRIC],
			landmark_project: FABRIC,
			reference_track: edge("track:cockney-thug", "Cockney Thug"),
		}),
		artist("artist:dougal", {
			notable_tracks: [DOUGAL_TRACK],
			reference_track: DOUGAL_TRACK,
			landmark_project: edge("project:dj-dougal-takes-control", "DJ Dougal Takes Control", {
				releaseType: "album",
			}),
		}),
		artist("artist:stuart-sutcliffe", {
			discography: [STAR_CLUB],
			landmark_project: STAR_CLUB,
			reference_track: edge("track:love-me-tender", "Love Me Tender"),
		}),
		artist("artist:beppe-loda", {
			discography: [LODA],
			landmark_project: LODA,
			reference_track: edge("track:counter", "Counter"),
		}),
	];
}

/** The two artists that exist in production only. */
function prodNodes(): Obj[] {
	return [
		artist("artist:lil-wayne", {
			discography: [edge("project:tha-block-is-hot", "Tha Block Is Hot")],
			landmark_project: edge("project:tha-block-is-hot", "Tha Block Is Hot"),
			notable_tracks: [CARTER],
			reference_track: CARTER,
		}),
		artist("artist:tyla", {
			discography: [edge("project:tyla", "Tyla"), JACKBOYS],
			landmark_project: JACKBOYS,
			reference_track: edge("track:water--tyla", "Water"),
		}),
	];
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "fix-weak-landmarks-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeCache(nodes: readonly Obj[]): Promise<void> {
	for (const node of nodes) {
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

const without = (node: Obj, key: string): Obj => {
	const { [key]: _dropped, ...rest } = node;
	return rest;
};

describe("fix-weak-landmarks: the closed list", () => {
	it("holds exactly the eight pairs of TRA-605 (adding one is a reviewed change)", () => {
		expect(
			CLOSED_LIST.map((d) => `${d.artist}.${d.field}=${d.expected} ${d.action}${d.with ? `:${d.with}` : ""}`),
		).toEqual([
			"artist:headhunterz.landmark_project=project:live-forever clear",
			"artist:caspa.landmark_project=project:fabriclive-37--caspa replace:project:everybody-s-talking-nobody-s-listening",
			"artist:rusko.landmark_project=project:fabriclive-37--caspa clear",
			"artist:dougal.reference_track=track:dj-dougal-takes-control clear",
			"artist:stuart-sutcliffe.landmark_project=project:live-at-the-star-club-in-hamburg-germany-1962 clear",
			"artist:beppe-loda.landmark_project=project:obscure-italian-disco-ii-beppe-loda-cuts clear",
			"artist:lil-wayne.reference_track=track:tha-carter-iii clear",
			"artist:tyla.landmark_project=project:jackboys-2 clear",
		]);
	});

	it("gives every pair a written proof, and a `with` to every replacement only", () => {
		for (const d of CLOSED_LIST) {
			expect(d.evidence.length).toBeGreaterThan(40);
			expect(d.with !== undefined).toBe(d.action === "replace");
		}
	});
});

describe("fix-weak-landmarks: only the listed fields move", () => {
	it("clears the five weak picks of the repository and replaces Caspa's, nothing else", async () => {
		const before = repoNodes();
		await writeCache(before);
		const manifest = await run(true);

		expect(manifest.written).toBe(6);
		expect(manifest.changed.map((c) => `${c.slug}.${c.field} ${c.action}`)).toEqual([
			"artist:headhunterz.landmark_project cleared",
			"artist:caspa.landmark_project replaced",
			"artist:rusko.landmark_project cleared",
			"artist:dougal.reference_track cleared",
			"artist:stuart-sutcliffe.landmark_project cleared",
			"artist:beppe-loda.landmark_project cleared",
		]);

		const byslug = new Map(before.map((n) => [n.slug as string, n]));
		const expectNode = (slug: Slug, expected: Obj) => readNode(slug).then((n) => expect(n).toEqual(expected));
		await expectNode(
			"artist:headhunterz",
			without(byslug.get("artist:headhunterz") as Obj, "landmark_project"),
		);
		await expectNode("artist:rusko", without(byslug.get("artist:rusko") as Obj, "landmark_project"));
		await expectNode("artist:dougal", without(byslug.get("artist:dougal") as Obj, "reference_track"));
		await expectNode(
			"artist:stuart-sutcliffe",
			without(byslug.get("artist:stuart-sutcliffe") as Obj, "landmark_project"),
		);
		await expectNode(
			"artist:beppe-loda",
			without(byslug.get("artist:beppe-loda") as Obj, "landmark_project"),
		);
		await expectNode("artist:caspa", { ...(byslug.get("artist:caspa") as Obj), landmark_project: EVERYBODY });
	});

	it("keeps the other pick of a node it touches (reference_track of Headhunterz, landmark of Dougal)", async () => {
		await writeCache(repoNodes());
		await run(true);
		expect((await readNode("artist:headhunterz")).reference_track).toEqual(
			edge("track:live-forever", "Live Forever"),
		);
		expect((await readNode("artist:dougal")).landmark_project).toMatchObject({
			slug: "project:dj-dougal-takes-control",
		});
	});

	it("does not touch an artist outside the list, even one holding the very same weak pick", async () => {
		const bystander = artist("artist:somebody-else", {
			discography: [FABRIC],
			landmark_project: FABRIC,
			reference_track: CARTER,
		});
		await writeCache([...repoNodes(), bystander]);
		const before = (await snapshot())["artist/somebody-else.json"];
		const manifest = await run(true);
		expect((await snapshot())["artist/somebody-else.json"]).toBe(before);
		expect(manifest.changed.map((c) => c.slug)).not.toContain("artist:somebody-else");
	});

	it("leaves the node bytes alone except the pick: the diff of a node is one key", async () => {
		await writeCache(repoNodes());
		const before = (await snapshot())["artist/rusko.json"] as string;
		await run(true);
		const after = (await snapshot())["artist/rusko.json"] as string;
		const dropped = before.split("\n").filter((line) => !after.split("\n").includes(line));
		expect(dropped.join("\n")).toContain('"landmark_project"');
		expect(after.split("\n").filter((line) => !before.split("\n").includes(line))).toEqual([]);
	});
});

describe("fix-weak-landmarks: the union (repository + production)", () => {
	it("clears lil-wayne's reference_track and tyla's landmark_project when they are present", async () => {
		await writeCache([...repoNodes(), ...prodNodes()]);
		const manifest = await run(true);
		expect(manifest.written).toBe(8);
		const wayne = await readNode("artist:lil-wayne");
		expect(wayne.reference_track).toBeUndefined();
		expect(wayne.landmark_project).toMatchObject({ slug: "project:tha-block-is-hot" });
		const tyla = await readNode("artist:tyla");
		expect(tyla.landmark_project).toBeUndefined();
		expect(tyla.reference_track).toMatchObject({ slug: "track:water--tyla" });
	});

	it("lists them as absent, without error, in the repository where they do not exist", async () => {
		await writeCache(repoNodes());
		const manifest = await run(false);
		expect(manifest.skipped).toEqual([
			{ slug: "artist:lil-wayne", field: "reference_track", reason: "absent" },
			{ slug: "artist:tyla", field: "landmark_project", reason: "absent" },
		]);
	});
});

describe("fix-weak-landmarks: idempotence and dry-run", () => {
	it("a dry-run writes nothing and its manifest is the apply's, but for the date and the mode", async () => {
		await writeCache([...repoNodes(), ...prodNodes()]);
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
		await writeCache([...repoNodes(), ...prodNodes()]);
		await run(true);
		const after = await snapshot();
		const second = await run(true);
		expect(second.written).toBe(0);
		expect(second.changed).toEqual([]);
		expect(second.skipped.filter((s) => s.reason === "already-empty")).toHaveLength(7);
		expect(await snapshot()).toEqual(after);
	});
});

describe("fix-weak-landmarks: a pick that is not the expected one is not ours", () => {
	it("leaves a pick the pipeline rewrote since, and says so", async () => {
		const rewritten = artist("artist:rusko", {
			discography: [edge("project:o-m-g", "O.M.G.!")],
			landmark_project: edge("project:o-m-g", "O.M.G.!"),
		});
		await writeCache([rewritten]);
		const before = await snapshot();
		const manifest = await run(true);
		expect(manifest.written).toBe(0);
		expect(manifest.skipped).toContainEqual({
			slug: "artist:rusko",
			field: "landmark_project",
			reason: "pick-changed",
			found: "project:o-m-g",
		});
		expect(await snapshot()).toEqual(before);
	});

	it("tells an empty field from a missing artist", async () => {
		await writeCache([artist("artist:rusko")]);
		const manifest = await run(false);
		expect(manifest.skipped).toContainEqual({
			slug: "artist:rusko",
			field: "landmark_project",
			reason: "already-empty",
		});
	});
});

describe("fix-weak-landmarks: a replacement is a member of the artist's own list", () => {
	const replace: Decision = CLOSED_LIST.find((d) => d.action === "replace") as Decision;

	it("copies the entry of the list as is, every field of it", () => {
		const node = repoNodes()[1] as Obj;
		const result = applyDecision(node, replace);
		expect(result.next?.landmark_project).toEqual(EVERYBODY);
		expect(result.next?.landmark_project).not.toBe(EVERYBODY);
	});

	it("falls back to clearing, and says so, when the replacement is not in the list", async () => {
		await writeCache([artist("artist:caspa", { discography: [FABRIC], landmark_project: FABRIC })]);
		const manifest = await run(true);
		expect(manifest.changed).toEqual([
			{
				slug: "artist:caspa",
				field: "landmark_project",
				action: "cleared",
				from: "project:fabriclive-37--caspa",
				to: null,
				replacementMissing: true,
			},
		]);
		expect((await readNode("artist:caspa")).landmark_project).toBeUndefined();
	});
});

describe("fix-weak-landmarks: a refusal blocks the whole run", () => {
	it("writes nothing when one of the files is not valid JSON, exit 1 in dry-run and 2 with --apply", async () => {
		await writeCache(repoNodes());
		const file = join(dir, "nodes", "artist", "tyla.json");
		await writeFile(file, "{ not json", "utf8");
		const before = await snapshot();
		const dry = await runMigration({ cacheDir: dir, apply: false });
		expect([dry.exitCode, dry.manifest.blocked, dry.manifest.written]).toEqual([1, true, 0]);
		const applied = await runMigration({ cacheDir: dir, apply: true });
		expect([applied.exitCode, applied.manifest.blocked, applied.manifest.written]).toEqual([2, true, 0]);
		expect(applied.manifest.errors[0]).toContain("artist:tyla");
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a result the schema rejects instead of writing it", async () => {
		const broken = artist("artist:rusko", { landmark_project: FABRIC, editorial_article: "short" });
		await writeCache([broken]);
		const before = await snapshot();
		const result = await runMigration({ cacheDir: dir, apply: true });
		expect([result.exitCode, result.manifest.written]).toEqual([2, 0]);
		expect(result.manifest.errors[0]).toContain("artist:rusko");
		expect(await snapshot()).toEqual(before);
	});
});

describe("fix-weak-landmarks: the command line", () => {
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
		await writeCache([...repoNodes(), ...prodNodes()]);
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
			8,
			[],
			{},
			{},
		]);
		expect((await readNode("artist:rusko")).landmark_project).toBeUndefined();
		expect(await readdir(dataDir)).toEqual([]);
	});

	it("exits 2 on a usage error and on a directory that is not a cache", () => {
		const script = join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`);
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		expect(spawnSync(tsx, [script, dir, "--bogus"], { encoding: "utf8" }).status).toBe(2);
		expect(spawnSync(tsx, [script, dir], { encoding: "utf8" }).status).toBe(2);
	});
});

describe("fix-weak-landmarks: the migration channel", () => {
	const script = readFileSync(join(process.cwd(), "deploy", "sync-genre-cache.sh"), "utf8");

	it("its name passes the channel's whitelist and is the name of the file", () => {
		const pattern = /^MIGRATION_NAME_PATTERN='(.+)'$/m.exec(script)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
	});
});
