import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	IDENTITIES_PATH,
	type Identities,
	MIGRATION_NAME,
	parseCliArgs,
	runMigration,
} from "../scripts/migrations/2026-10-24-detach-homonym-credits.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";

// TRA-570: a closed list of credits given to a namesake, detached on both sides.

const WORK = "project:the-ep--inside";
const ARTIST = "artist:inside";
const OTHER = "artist:kurt-howes";

type Obj = Record<string, unknown>;
const ref = (slug: string, name: string): Obj => ({ slug, type: slug.slice(0, slug.indexOf(":")), name });
const base = (slug: string, name: string): Obj => ({
	...Object.fromEntries(LIST_EDGES_BY_TYPE[slug.slice(0, slug.indexOf(":")) as NodeType].map((f) => [f, []])),
	slug,
	name,
	type: slug.slice(0, slug.indexOf(":")),
	editorial_article: `${name}. ${"x".repeat(100)}`,
	citations: [{ url: "https://example.com/a", title: "a" }],
	materialized_at: "2026-10-16T00:00:00.000Z",
});

function artist(fields: Obj = {}): Obj {
	return {
		...base(ARTIST, "Inside"),
		editorial_article: `Inside was an emo band from Long Island. ${"x".repeat(100)}`,
		editorial_bio: "bio",
		discography: [
			{ ...ref(WORK, "The EP"), artist: "Inside" },
			ref("project:my-funeral--inside", "My Funeral"),
		],
		notable_tracks: [],
		landmark_project: { ...ref(WORK, "The EP"), artist: "Inside" },
		...fields,
	};
}
function work(fields: Obj = {}): Obj {
	return {
		...base(WORK, "The EP"),
		editorial_article: `A 1993 EP written and produced by Kurt Howes. ${"x".repeat(100)}`,
		editorial_pitch: "pitch",
		year: "1993",
		artists: [ref(ARTIST, "Inside")],
		tracklist: [],
		producers: [ref(OTHER, "Kurt Howes")],
		...fields,
	};
}

function identities(overrides: Obj = {}): Identities {
	return {
		source: "test",
		cases: [
			{
				key: "inside",
				status: "proven",
				work: WORK,
				artist: ARTIST,
				artist_identity: {
					mbid: "83f6e15e-f4bf-458f-9ebf-4d2634f92dd8",
					name: "Inside",
					disambiguation: "US 90s emo",
					begin: "1995-08",
					end: "1999",
					release_groups: [],
				},
				work_identity: { year: "1993" },
				anchors: { artist: ["Long Island"], work: ["Kurt Howes"] },
				evidence: [],
				...overrides,
			},
		],
	} as Identities;
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "detach-credits-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function write(n: Obj): Promise<void> {
	const slug = n.slug as string;
	const file = join(
		dir,
		"nodes",
		slug.slice(0, slug.indexOf(":")),
		`${slug.slice(slug.indexOf(":") + 1)}.json`,
	);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(n));
}
async function read(slug: string): Promise<Obj> {
	const file = join(
		dir,
		"nodes",
		slug.slice(0, slug.indexOf(":")),
		`${slug.slice(slug.indexOf(":") + 1)}.json`,
	);
	return JSON.parse(await readFile(file, "utf8")) as Obj;
}
async function seed(a: Obj = artist(), w: Obj = work()): Promise<void> {
	await write(a);
	await write(w);
	await write(base(OTHER, "Kurt Howes"));
	await writeFile(join(dir, "pending-reverses.json"), "{}");
}

describe("detach-homonym-credits", () => {
	it("detaches both sides of a proven case and keeps everything else (acceptance case)", async () => {
		await seed();
		const { manifest, exitCode } = await runMigration({
			cacheDir: dir,
			apply: true,
			identities: identities(),
		});
		expect(manifest.errors).toEqual([]);
		expect(exitCode).toBe(0);
		expect(manifest.detached).toEqual([
			{
				key: "inside",
				work: WORK,
				artist: ARTIST,
				removed: [`${WORK}.artists`, `${ARTIST}.discography`, `${ARTIST}.landmark_project`],
			},
		]);
		const a = await read(ARTIST);
		expect((a.discography as Obj[]).map((e) => e.slug)).toEqual(["project:my-funeral--inside"]);
		expect(a).not.toHaveProperty("landmark_project");
		const w = await read(WORK);
		expect(w.artists).toEqual([]);
		expect(w.producers).toEqual([ref(OTHER, "Kurt Howes")]);
		expect(w.year).toBe("1993");
	});

	it("writes nothing in a dry-run, and a second apply finds the pair already detached", async () => {
		await seed();
		const before = JSON.stringify([await read(ARTIST), await read(WORK)]);
		const dry = await runMigration({ cacheDir: dir, apply: false, identities: identities() });
		expect(dry.manifest.mode).toBe("dry-run");
		expect(dry.manifest.written).toBe(2);
		expect(JSON.stringify([await read(ARTIST), await read(WORK)])).toBe(before);
		await runMigration({ cacheDir: dir, apply: true, identities: identities() });
		const again = await runMigration({ cacheDir: dir, apply: true, identities: identities() });
		expect(again.manifest.detached).toEqual([]);
		expect(again.manifest.alreadyDetached).toEqual(["inside"]);
		expect(again.manifest.written).toBe(0);
	});

	it("removes only the namesake from a work that credits several artists, and the pick it was", async () => {
		await seed(artist(), work({ artists: [ref(ARTIST, "Inside"), ref(OTHER, "Kurt Howes")] }));
		await runMigration({ cacheDir: dir, apply: true, identities: identities() });
		expect((await read(WORK)).artists).toEqual([ref(OTHER, "Kurt Howes")]);
	});

	it("drops the queued reverses that would put either side back, and no other", async () => {
		await seed();
		const keep = { field: "roster", cardinality: "list", edge: ref(ARTIST, "Inside") };
		await writeFile(
			join(dir, "pending-reverses.json"),
			JSON.stringify({
				[ARTIST]: [{ field: "discography", cardinality: "list", edge: ref(WORK, "The EP") }],
				[WORK]: [{ field: "artists", cardinality: "list", edge: ref(ARTIST, "Inside") }],
				"label:motherbox": [keep],
			}),
		);
		const { manifest } = await runMigration({ cacheDir: dir, apply: true, identities: identities() });
		expect(manifest.pendingDropped).toBe(2);
		expect(JSON.parse(await readFile(join(dir, "pending-reverses.json"), "utf8"))).toEqual({
			"label:motherbox": [keep],
		});
	});

	it.each([
		["the work has an mbid of its own", artist(), work({ mbid: "83f6e15e-f4bf-458f-9ebf-4d2634f92dd8" })],
		["the work's year differs from the proof", artist(), work({ year: "1999" })],
		["the artist's mbid is another one", artist({ mbid: "17cccfd9-d8f6-4af8-a1e4-9c149a278217" }), work()],
		[
			"the artist article lacks its anchor",
			artist({ editorial_article: `A band. ${"x".repeat(100)}` }),
			work(),
		],
		["the work article lacks its anchor", artist(), work({ editorial_article: `An EP. ${"x".repeat(100)}` })],
		["the artist is another name", artist({ name: "Inside 2" }), work()],
	])("refuses, and writes nothing, when %s", async (_why, a, w) => {
		await seed(a, w);
		const { manifest, exitCode } = await runMigration({
			cacheDir: dir,
			apply: true,
			identities: identities(),
		});
		expect(exitCode).toBe(0);
		expect(manifest.detached).toEqual([]);
		expect(manifest.refused.map((r) => r.key)).toEqual(["inside"]);
		expect(await read(ARTIST)).toEqual(a);
		expect(await read(WORK)).toEqual(w);
	});

	it("refuses a work that does not predate the artist's first year", async () => {
		await seed();
		const late = identities({
			artist_identity: {
				...(identities().cases[0] as { artist_identity: Obj }).artist_identity,
				begin: "1993-01",
			},
		});
		const { manifest } = await runMigration({ cacheDir: dir, apply: true, identities: late });
		expect(manifest.refused[0]?.reason).toContain("does not predate");
	});

	it("leaves a case listed as refused, or a pair absent from the cache, as it is", async () => {
		await seed();
		const refused = identities({ status: "refused", reason: "not proven" } as Obj);
		expect(
			(await runMigration({ cacheDir: dir, apply: true, identities: refused })).manifest.refused,
		).toEqual([{ key: "inside", reason: "not proven" }]);
		const missing = identities({ work: "project:nope--inside" });
		const run = await runMigration({ cacheDir: dir, apply: true, identities: missing });
		expect(run.manifest.refused[0]?.reason).toContain("not in the cache");
		expect((await read(WORK)).artists).toEqual([ref(ARTIST, "Inside")]);
	});

	it("writes no manifest-declared deletion or redirect: the channel ships nodes only", async () => {
		await seed();
		const manifestPath = join(dir, "out", "m.json");
		await runMigration({ cacheDir: dir, apply: true, manifestPath, identities: identities() });
		const m = JSON.parse(await readFile(manifestPath, "utf8")) as Obj;
		expect(m).toMatchObject({ migration: MIGRATION_NAME, removed: [], renamed: {}, redirects: {} });
		expect(JSON.stringify(m)).not.toMatch(/generated_at|T\d\d:\d\d/);
	});

	it("blocks the run, exit 2 with --apply, when the proof table or the cache is unusable", async () => {
		await seed();
		await writeFile(join(dir, "nodes", "artist", "broken.json"), "{");
		const { manifest, exitCode } = await runMigration({
			cacheDir: dir,
			apply: true,
			identities: identities(),
		});
		expect(exitCode).toBe(2);
		expect(manifest.blocked).toBe(true);
		expect((await read(WORK)).artists).toEqual([ref(ARTIST, "Inside")]);
	});
});

describe("detach-homonym-credits: committed proof table and migration channel", () => {
	it("holds the Inside case with its MusicBrainz identity", async () => {
		const table = JSON.parse(await readFile(IDENTITIES_PATH, "utf8")) as { cases: Obj[] };
		expect(table.cases.map((c) => [c.key, c.status, c.work, c.artist])).toEqual([
			["inside", "proven", WORK, ARTIST],
		]);
	});

	it("is a name deploy/sync-genre-cache.sh accepts, for a script that exists", () => {
		const shell = readFileSync(resolve("deploy/sync-genre-cache.sh"), "utf8");
		const pattern = /^MIGRATION_NAME_PATTERN='(.+)'$/m.exec(shell)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(resolve("scripts/migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
	});

	it("takes the flags the channel passes: --apply --manifest --data-dir", () => {
		expect(parseCliArgs(["/u", "--apply", "--manifest", "/m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/u",
			apply: true,
			manifestPath: "/m.json",
			dataDir: "/d",
		});
		expect(parseCliArgs(["/u", "--bogus"])).toBeNull();
		expect(parseCliArgs(["--apply"])).toBeNull();
	});
});
