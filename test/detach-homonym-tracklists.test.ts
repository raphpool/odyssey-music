import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CacheNodeFile } from "../scripts/migrations/2026-09-04-merge-genre-duplicates.js";
import {
	DETACHMENTS,
	KEPT,
	type Listed,
	MIGRATION_NAME,
	parseCliArgs,
	planDetachments,
	runMigration,
} from "../scripts/migrations/2026-10-24-detach-homonym-tracklists.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";

// TRA-561: the closed-list migration that detaches the tracklist entries pointing at a namesake's track.

type Obj = Record<string, unknown>;

const ref = (slug: string, name: string, extra: Obj = {}): Obj => ({
	slug,
	type: parseSlug(slug).type,
	name,
	...extra,
});

function node(slug: string, name: string, fields: Obj = {}): Obj {
	const type: NodeType = parseSlug(slug).type;
	const prose: Record<NodeType, Obj> = {
		artist: { editorial_bio: "bio" },
		project: { editorial_pitch: "pitch" },
		track: { editorial_teaser: "teaser" },
		label: { editorial_description: "description" },
		genre: { editorial_definition: "definition", editorial_description: "description" },
	};
	return {
		slug,
		name,
		type,
		editorial_article: "x".repeat(100),
		citations: [{ url: "https://example.com/a", title: "a" }],
		materialized_at: "2026-10-16T00:00:00.000Z",
		...prose[type],
		...Object.fromEntries(LIST_EDGES_BY_TYPE[type].map((f) => [f, []])),
		...fields,
	};
}

const file = (n: Obj, root = "/cache"): CacheNodeFile => {
	const { type, body } = parseSlug(n.slug as string);
	return { path: `${root}/nodes/${type}/${body}.json`, slug: n.slug as string, type, node: n };
};

const ROHFF = ref("artist:rohff", "Rohff", { mbid: "f4a92aac-995b-47ab-80a5-33218a3e7823" });
const AKUMA = ref("artist:akuma", "Akuma");
const AXMO = ref("artist:axmo", "AXMO");

/** The acceptance case: Rohff's "Fitna" lists the title track of Akuma and AXMO, which points back at it. */
function fitnaNodes(): Obj[] {
	return [
		node("project:fitna--rohff", "Fitna", {
			artists: [ROHFF],
			tracklist: [
				ref("track:fitna--akuma", "Fitna", { mbid: "4407bb57-204e-448a-af98-026b5d5f5317" }),
				ref("track:derniere-fois", "Dernière fois"),
			],
		}),
		node("track:fitna--akuma", "Fitna", {
			artists: [AKUMA, AXMO],
			project: ref("project:fitna--rohff", "Fitna"),
			year: "2023",
		}),
		node("track:derniere-fois", "Dernière fois", { artists: [ROHFF] }),
	];
}

const fitnaItem = (over: Partial<Listed> = {}): Listed =>
	({
		action: "detach",
		project: "project:fitna--rohff",
		projectCredit: ["artist:rohff"],
		track: "track:fitna--akuma",
		trackCredit: ["artist:akuma", "artist:axmo"],
		scope: "artist:rohff",
		proof: "test",
		...over,
	}) as Listed;

const plan = (nodes: Obj[], cases: readonly Listed[], kept = KEPT_NONE) =>
	planDetachments(
		nodes.map((n) => file(n)),
		cases,
		kept,
	);
const KEPT_NONE: typeof KEPT = [];

let savedFlag: string | undefined;
beforeEach(() => {
	savedFlag = process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
	process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = "1";
});
afterEach(() => {
	if (savedFlag === undefined) delete process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
	else process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = savedFlag;
});

describe("planDetachments", () => {
	it("detaches Rohff's Fitna from Akuma's track onto the track scoped on Rohff, keeping the rest", () => {
		const { writes, manifest } = plan(fitnaNodes(), [fitnaItem()]);
		expect(manifest.errors).toEqual([]);
		expect(manifest.changes).toEqual([
			{
				project: "project:fitna--rohff",
				track: "track:fitna--akuma",
				action: "detach",
				to: "track:fitna--rohff",
				mirrorRemoved: true,
				folded: false,
			},
		]);
		const written = new Map([...writes.values()].map((n) => [n.slug as string, n]));
		const tracklist = written.get("project:fitna--rohff")?.tracklist as Obj[];
		// The entry keeps its place and name, gains the artist hint, and loses the mbid of the namesake's release.
		expect(tracklist[0]).toEqual({
			slug: "track:fitna--rohff",
			type: "track",
			name: "Fitna",
			artist: "Rohff",
		});
		expect(tracklist[1]).toMatchObject({ slug: "track:derniere-fois" });
		// The namesake's track keeps everything but the reverse of the bad link; nothing else is written.
		const akuma = written.get("track:fitna--akuma") as Obj;
		expect(akuma.project).toBeUndefined();
		expect(akuma).toMatchObject({ year: "2023", artists: [AKUMA, AXMO] });
		expect(written.size).toBe(2);
	});

	it("leaves a track alone when its project edge points elsewhere", () => {
		const nodes = fitnaNodes();
		nodes[1] = node("track:fitna--akuma", "Fitna", {
			artists: [AKUMA, AXMO],
			project: ref("project:fitna--akuma", "Fitna"),
		});
		const { writes, manifest } = plan(nodes, [fitnaItem()]);
		expect(manifest.changes[0]?.mirrorRemoved).toBe(false);
		expect(writes.size).toBe(1);
	});

	it("does not detach a legitimate featuring, even if the list names it", () => {
		const nodes = fitnaNodes();
		nodes[1] = node("track:fitna--akuma", "Fitna", { artists: [AKUMA, ROHFF] });
		const { writes, manifest } = plan(nodes, [fitnaItem({ trackCredit: ["artist:akuma", "artist:rohff"] })]);
		expect(writes.size).toBe(0);
		expect(manifest.skipped).toEqual([
			{
				project: "project:fitna--rohff",
				track: "track:fitna--akuma",
				reason: "the audit no longer counts this entry",
			},
		]);
	});

	it("scopes on the artist the item names in a project with several artists, or removes the entry with `scope: null`", () => {
		const nodes = [
			node("project:split", "Split", {
				artists: [ref("artist:a", "A"), ref("artist:b", "B")],
				tracklist: [ref("track:t--c", "T"), ref("track:u--c", "U")],
			}),
			node("track:t--c", "T", { artists: [ref("artist:c", "C")] }),
			node("track:u--c", "U", { artists: [ref("artist:c", "C")] }),
		];
		const base = {
			action: "detach",
			project: "project:split",
			projectCredit: ["artist:a", "artist:b"],
			trackCredit: ["artist:c"],
			proof: "test",
		} as const;
		const { writes, manifest } = plan(nodes, [
			{ ...base, track: "track:t--c", scope: "artist:b" },
			{ ...base, track: "track:u--c", scope: null },
		]);
		expect(manifest.errors).toEqual([]);
		const tracklist = [...writes.values()][0]?.tracklist as Obj[];
		expect(tracklist).toEqual([{ slug: "track:t--b", type: "track", name: "T", artist: "B" }]);
		expect(manifest.changes.map((c) => c.to)).toEqual(["track:t--b", null]);
	});

	it("retargets to a node of the cache credited to the project's artist, and refuses a homonym as target", () => {
		const right = node("track:fitna--rohff", "Fitna", { artists: [ROHFF] });
		const retarget = (to: string): Listed => ({ ...fitnaItem(), action: "retarget", to }) as Listed;
		const ok = plan([...fitnaNodes(), right], [retarget("track:fitna--rohff")]);
		expect(ok.manifest.errors).toEqual([]);
		expect(
			([...ok.writes.values()].find((n) => n.slug === "project:fitna--rohff")?.tracklist as Obj[])[0],
		).toEqual({
			slug: "track:fitna--rohff",
			type: "track",
			name: "Fitna",
			artist: "Rohff",
		});
		const bad = plan(fitnaNodes(), [retarget("track:derniere-fois-x")]);
		expect(bad.manifest.blocked).toBe(true);
		expect(bad.writes.size).toBe(0);
		const homonym = plan(
			[...fitnaNodes(), node("track:other--akuma", "Other", { artists: [AKUMA] })],
			[retarget("track:other--akuma")],
		);
		expect(homonym.manifest.blocked).toBe(true);
	});

	it("refuses (nothing written) when the scoped slug is already a node credited to someone else", () => {
		const squatter = node("track:fitna--rohff", "Fitna", { artists: [ref("artist:rohff-2", "Rohff 2")] });
		const { writes, manifest } = plan([...fitnaNodes(), squatter], [fitnaItem()]);
		expect(manifest.blocked).toBe(true);
		expect(manifest.errors[0]).toContain("track:fitna--rohff exists");
		expect(writes.size).toBe(0);
	});

	it("accepts the scoped slug when it is already a node credited to the same artist", () => {
		const own = node("track:fitna--rohff", "Fitna", { artists: [ROHFF] });
		const { manifest } = plan([...fitnaNodes(), own], [fitnaItem()]);
		expect(manifest.errors).toEqual([]);
		expect(manifest.changes[0]?.to).toBe("track:fitna--rohff");
	});

	it("folds the entry when the project already lists the slug it would take", () => {
		const nodes = fitnaNodes();
		(nodes[0] as Obj).tracklist = [ref("track:fitna--akuma", "Fitna"), ref("track:fitna--rohff", "Fitna")];
		const { writes, manifest } = plan(nodes, [fitnaItem()]);
		expect(manifest.changes[0]).toMatchObject({ folded: true });
		expect((writes.values().next().value as Obj).tracklist).toEqual([ref("track:fitna--rohff", "Fitna")]);
	});

	it("applies an item only to the nodes its proof is about", () => {
		const { writes, manifest } = plan(fitnaNodes(), [fitnaItem({ trackCredit: ["artist:somebody-else"] })]);
		expect(writes.size).toBe(0);
		expect(manifest.skipped[0]?.reason).toContain("not the ones of the proof");
	});

	it("is idempotent: a second plan on the written nodes does nothing", () => {
		const first = plan(fitnaNodes(), [fitnaItem()]);
		const written = new Map([...first.writes.values()].map((n) => [n.slug as string, n]));
		const again = plan(
			fitnaNodes().map((n) => written.get(n.slug as string) ?? n),
			[fitnaItem()],
		);
		expect(again.writes.size).toBe(0);
		expect(again.manifest.alreadyDone).toEqual(["project:fitna--rohff tracklist track:fitna--akuma"]);
		expect(again.manifest.changes).toEqual([]);
	});

	it("reports a project or a track that is not in the cache, and never touches an entry that is on no list", () => {
		const absent = plan([fitnaNodes()[0] as Obj], [fitnaItem()]);
		expect(absent.manifest.absent).toHaveLength(1);
		const other = [
			...fitnaNodes(),
			node("project:other", "Other", { artists: [ROHFF], tracklist: [ref("track:x--akuma", "X")] }),
			node("track:x--akuma", "X", { artists: [AKUMA] }),
		];
		const { manifest, writes } = plan(other, [fitnaItem()]);
		expect(manifest.unlisted).toEqual(["project:other tracklist track:x--akuma"]);
		expect(writes.size).toBe(2);
	});

	it("lists the kept entries still counted, and not the ones that stopped being counted", () => {
		const kept = [{ project: "project:fitna--rohff", track: "track:fitna--akuma", why: "test" }];
		expect(plan(fitnaNodes(), [], kept).manifest.kept).toEqual(kept);
		expect(plan(fitnaNodes(), [], kept).manifest.unlisted).toEqual([]);
		expect(plan([fitnaNodes()[0] as Obj], [], kept).manifest.kept).toEqual([]);
	});

	it("blocks when the rewritten node would not validate", () => {
		const nodes = fitnaNodes();
		delete (nodes[0] as Obj).citations;
		const { manifest, writes } = plan(nodes, [fitnaItem()]);
		expect(manifest.blocked).toBe(true);
		expect(writes.size).toBe(0);
	});
});

describe("the closed list", () => {
	it("keeps Spiritual High on the compilation, scoped on Richie Hawtin (UP!), and removes no entry (B1)", () => {
		const item = DETACHMENTS.find((d) => d.track === "track:spiritual-high--moodswings") as Listed;
		const credits = item.projectCredit.map((slug) => ref(slug, slug.slice("artist:".length)));
		const titles = ["A", "B", "C"].map((t) => ref(`track:${t.toLowerCase()}--x`, t));
		const nodes = [
			node(item.project, "Artificial Intelligence", {
				artists: credits,
				tracklist: [titles[0], ref(item.track, "Spiritual High"), titles[1], titles[2]],
			}),
			node(item.track, "Spiritual High", { artists: item.trackCredit.map((s) => ref(s, s)) }),
		];
		const { writes, manifest } = plan(nodes, [item]);
		expect(manifest.errors).toEqual([]);
		const tracklist = ([...writes.values()][0]?.tracklist as Obj[]).map((e) => e.slug);
		expect(tracklist).toEqual([
			"track:a--x",
			"track:spiritual-high--richie-hawtin",
			"track:b--x",
			"track:c--x",
		]);
		expect(DETACHMENTS.filter((d) => d.action === "detach" && d.scope === null)).toEqual([]);
	});

	it("names each entry once, with a proof, scoped on one of the project's credits", () => {
		const keys = DETACHMENTS.map((d) => `${d.project}|${d.track}`);
		expect(new Set(keys).size).toBe(keys.length);
		for (const d of DETACHMENTS) {
			expect(d.proof.length, d.track).toBeGreaterThan(20);
			expect(
				d.trackCredit.some((c) => d.projectCredit.includes(c)),
				d.track,
			).toBe(false);
			if (d.action === "detach" && d.scope !== null) expect(d.projectCredit, d.track).toContain(d.scope);
		}
		for (const k of KEPT) expect(keys, k.track).not.toContain(`${k.project}|${k.track}`);
	});

	it("has a name the migration channel accepts", () => {
		expect(MIGRATION_NAME).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/);
	});
});

describe("runMigration and the command line", () => {
	const dirs: string[] = [];
	function cacheWith(nodes: Obj[]): string {
		const dir = mkdtempSync(join(tmpdir(), "detach-tracklists-"));
		dirs.push(dir);
		for (const n of nodes) {
			const { type, body } = parseSlug(n.slug as string);
			const path = join(dir, "nodes", type, `${body}.json`);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(n, null, 2)}\n`);
		}
		return dir;
	}
	afterAll(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const read = (dir: string, slug: string): Obj => {
		const { type, body } = parseSlug(slug);
		return JSON.parse(readFileSync(join(dir, "nodes", type, `${body}.json`), "utf8")) as Obj;
	};

	it("writes nothing in a dry-run, and in an apply only the project and the track of the list", async () => {
		const dir = cacheWith(fitnaNodes());
		const cases = [fitnaItem()];
		const path = join(dir, "nodes", "project", "fitna--rohff.json");
		const before = readFileSync(path, "utf8");
		const dry = await runMigration({ cacheDir: dir, apply: false, cases });
		expect(dry.exitCode).toBe(0);
		expect(dry.manifest.written).toBe(2);
		expect(readFileSync(path, "utf8")).toBe(before);

		const manifestPath = join(dir, "out", "manifest.json");
		const applied = await runMigration({ cacheDir: dir, apply: true, cases, manifestPath });
		expect(applied.exitCode).toBe(0);
		expect((read(dir, "project:fitna--rohff").tracklist as Obj[])[0]?.slug).toBe("track:fitna--rohff");
		expect(read(dir, "track:fitna--akuma").project).toBeUndefined();
		expect(read(dir, "track:derniere-fois")).toEqual(fitnaNodes()[2]);
		// The channel's contract: the fields it validates, no timestamp.
		expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			written: 2,
		});

		const again = await runMigration({ cacheDir: dir, apply: true, cases });
		expect(again.exitCode).toBe(0);
		expect(again.manifest.written).toBe(0);
		expect(again.manifest.alreadyDone).toHaveLength(1);
	});

	it("refuses to run with ODYSSEY_SCOPED_RELEASE_SLUGS off: exit 2 on --apply, nothing written", async () => {
		delete process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
		const dir = cacheWith(fitnaNodes());
		const result = await runMigration({ cacheDir: dir, apply: true });
		expect(result.exitCode).toBe(2);
		expect(result.manifest.blocked).toBe(true);
		expect(result.manifest.errors[0]).toContain("ODYSSEY_SCOPED_RELEASE_SLUGS");
	});

	it("accepts the flags the migration channel passes", () => {
		expect(parseCliArgs(["/c", "--apply", "--manifest", "/m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/c",
			apply: true,
			manifestPath: "/m.json",
		});
		expect(parseCliArgs(["/c"])?.apply).toBe(false);
		expect(parseCliArgs(["/c", "--nope"])).toBeNull();
		expect(parseCliArgs(["--apply"])).toBeNull();
	});
});
