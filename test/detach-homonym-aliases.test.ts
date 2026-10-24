import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CacheNodeFile } from "../scripts/migrations/2026-09-04-merge-genre-duplicates.js";
import {
	DEFAULT_MANIFEST_PATH,
	DETACHMENTS,
	type Detachment,
	MIGRATION_NAME,
	parseCliArgs,
	planDetach,
	runMigration,
} from "../scripts/migrations/2026-10-24-detach-homonym-aliases.js";
import { LIST_EDGES_BY_TYPE } from "../src/node-spec.js";

// TRA-562: the closed-list migration that detaches the homonyms listed as aliases of an artist.

type Obj = Record<string, unknown>;

const MILLS = "470a4ced-1323-4c91-8fd5-0bb3fb4c932a";
const WIZARD = "3193bfb8-d19f-415d-8791-d00ea71a311c";
const BASIC_CHANNEL = "d145a57e-7afb-4793-8cc4-2fad292374ef";
const QUADRANT = "7c1cc8a1-a237-40b6-ab4a-dca495a8f470";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "detach-aliases-"));
	dirs.push(d);
	return d;
}
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ref(slug: string, name: string): Obj {
	return { slug, type: "artist", name };
}

function artist(slug: string, name: string, fields: Obj = {}): Obj {
	return {
		slug,
		name,
		type: "artist",
		editorial_article: `${name} `.repeat(30).padEnd(100, "."),
		editorial_bio: `${name} bio`,
		citations: [{ url: "https://example.com/a", title: "a" }],
		materialized_at: "2026-10-16T00:00:00.000Z",
		...Object.fromEntries(LIST_EDGES_BY_TYPE.artist.map((f) => [f, []])),
		...fields,
	};
}

const jeffMills = (
	aliases: Obj[] = [ref("artist:millsart", "Millsart"), ref("artist:the-wizard", "The Wizard")],
) => artist("artist:jeff-mills", "Jeff Mills", { mbid: MILLS, aliases, origin: "Detroit" });
const theWizard = (aliases: Obj[] = [ref("artist:jeff-mills", "Jeff Mills")]) =>
	artist("artist:the-wizard", "The Wizard", { mbid: WIZARD, aliases, origin: "San Antonio" });
const millsart = () =>
	artist("artist:millsart", "Millsart", {
		mbid: "1e7a51db-e1a9-4a01-a879-957572988253",
		aliases: [ref("artist:jeff-mills", "Jeff Mills")],
	});

function file(node: Obj): CacheNodeFile {
	return {
		path: `/cache/nodes/artist/${(node.slug as string).slice(7)}.json`,
		slug: node.slug as string,
		type: "artist",
		node,
	};
}

function writeCache(root: string, nodes: Obj[]): void {
	for (const n of nodes) {
		const path = join(root, "nodes", "artist", `${(n.slug as string).slice(7)}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(n, null, 2)}\n`);
	}
}

function readNode(root: string, slug: string): Obj {
	return JSON.parse(readFileSync(join(root, "nodes", "artist", `${slug.slice(7)}.json`), "utf8")) as Obj;
}

describe("DETACHMENTS", () => {
	it("is a closed list of artist pairs, each pinned on two distinct mbids and carrying its proof", () => {
		expect(DETACHMENTS.map((d) => [d.a.slug, d.b.slug])).toEqual([
			["artist:jeff-mills", "artist:the-wizard"],
			["artist:basic-channel", "artist:quadrant"],
		]);
		for (const d of DETACHMENTS) {
			expect(d.a.mbid).toMatch(/^[0-9a-f-]{36}$/);
			expect(d.b.mbid).toMatch(/^[0-9a-f-]{36}$/);
			expect(d.a.mbid).not.toBe(d.b.mbid);
			expect(d.proof).toContain("MusicBrainz");
		}
	});
});

describe("planDetach", () => {
	it("removes the alias on both sides and nothing else (acceptance: jeff-mills and the-wizard)", () => {
		const plan = planDetach([file(jeffMills()), file(theWizard()), file(millsart())]);
		expect(plan.manifest.errors).toEqual([]);
		expect(plan.manifest.detached).toEqual([
			{ node: "artist:jeff-mills", alias: "artist:the-wizard" },
			{ node: "artist:the-wizard", alias: "artist:jeff-mills" },
		]);
		const mills = plan.writes.get("/cache/nodes/artist/jeff-mills.json");
		expect(mills).toEqual({ ...jeffMills(), aliases: [ref("artist:millsart", "Millsart")] });
		expect(plan.writes.get("/cache/nodes/artist/the-wizard.json")).toEqual({ ...theWizard(), aliases: [] });
		expect(plan.writes.has("/cache/nodes/artist/millsart.json")).toBe(false);
		expect(plan.manifest.written).toBe(2);
	});

	it("detaches Basic Channel and Quadrant while keeping the aliases that are real", () => {
		const bc = artist("artist:basic-channel", "Basic Channel", {
			mbid: BASIC_CHANNEL,
			aliases: [ref("artist:rhythm-and-sound", "Rhythm & Sound"), ref("artist:quadrant", "Quadrant")],
		});
		const quadrant = artist("artist:quadrant", "Quadrant", {
			mbid: QUADRANT,
			aliases: [ref("artist:basic-channel", "Basic Channel")],
		});
		const plan = planDetach([file(bc), file(quadrant)]);
		expect(plan.writes.get("/cache/nodes/artist/basic-channel.json")?.aliases).toEqual([
			ref("artist:rhythm-and-sound", "Rhythm & Sound"),
		]);
		expect(plan.writes.get("/cache/nodes/artist/quadrant.json")?.aliases).toEqual([]);
	});

	it("handles a pair listed on one side only", () => {
		const plan = planDetach([file(jeffMills([ref("artist:the-wizard", "The Wizard")])), file(theWizard([]))]);
		expect(plan.manifest.detached).toEqual([{ node: "artist:jeff-mills", alias: "artist:the-wizard" }]);
		expect(plan.manifest.written).toBe(1);
	});

	it("is idempotent: nodes already detached produce no write", () => {
		const plan = planDetach([file(jeffMills([ref("artist:millsart", "Millsart")])), file(theWizard([]))]);
		expect(plan.manifest.written).toBe(0);
		expect(plan.manifest.detached).toEqual([]);
		// Only the other listed pair is reported: its nodes are not in this fixture.
		expect(plan.manifest.skipped.map((s) => s.pair)).toEqual(["artist:basic-channel <-> artist:quadrant"]);
	});

	it("leaves a pair alone when a node is absent, and says so", () => {
		const plan = planDetach([file(jeffMills())]);
		expect(plan.manifest.written).toBe(0);
		expect(plan.manifest.skipped).toEqual([
			{ pair: "artist:jeff-mills <-> artist:the-wizard", reason: "node absent: artist:the-wizard" },
			{
				pair: "artist:basic-channel <-> artist:quadrant",
				reason: "node absent: artist:basic-channel, artist:quadrant",
			},
		]);
	});

	it("leaves a pair alone when a node no longer carries the mbid the proof was made on", () => {
		const other = artist("artist:the-wizard", "The Wizard", {
			mbid: "00000000-0000-0000-0000-000000000000",
			aliases: [ref("artist:jeff-mills", "Jeff Mills")],
		});
		const noMbid = { ...jeffMills() } as Obj;
		delete noMbid.mbid;
		for (const wizard of [other, theWizard()]) {
			const plan = planDetach([file(noMbid), file(wizard)], DETACHMENTS.slice(0, 1));
			expect(plan.manifest.written).toBe(0);
			expect(plan.manifest.skipped[0]?.reason).toMatch(/^mbid differs from the proof: artist:jeff-mills/);
		}
	});

	it("refuses to write a node that would no longer pass the schema, and says which", () => {
		const broken = { ...jeffMills(), editorial_article: "too short" };
		const plan = planDetach([file(broken), file(theWizard())]);
		expect(plan.manifest.errors).toHaveLength(1);
		expect(plan.manifest.errors[0]).toContain("artist:jeff-mills: refusing to write an invalid node");
	});

	it("works on a custom list (the closed list is a parameter, not a rule)", () => {
		const custom: Detachment = {
			a: { slug: "artist:a", mbid: MILLS },
			b: { slug: "artist:b", mbid: WIZARD },
			proof: "MusicBrainz",
		};
		const a = artist("artist:a", "A", { mbid: MILLS, aliases: [ref("artist:b", "B")] });
		const b = artist("artist:b", "B", { mbid: WIZARD, aliases: [ref("artist:a", "A")] });
		expect(planDetach([file(a), file(b)], [custom]).manifest.written).toBe(2);
		expect(planDetach([file(a), file(b)], []).manifest.written).toBe(0);
	});
});

describe("runMigration", () => {
	it("writes nothing in a dry-run, then applies, and a second apply writes nothing (acceptance)", async () => {
		const root = tmp();
		writeCache(root, [jeffMills(), theWizard(), millsart()]);
		const before = readFileSync(join(root, "nodes", "artist", "millsart.json"), "utf8");

		const dry = await runMigration({ cacheDir: root, apply: false });
		expect(dry.exitCode).toBe(0);
		expect(dry.manifest.mode).toBe("dry-run");
		expect(dry.manifest.written).toBe(2);
		expect(readNode(root, "artist:jeff-mills").aliases).toHaveLength(2);

		const applied = await runMigration({ cacheDir: root, apply: true });
		expect(applied.exitCode).toBe(0);
		expect(readNode(root, "artist:jeff-mills").aliases).toEqual([ref("artist:millsart", "Millsart")]);
		expect(readNode(root, "artist:the-wizard").aliases).toEqual([]);
		// Out of the list: byte for byte the same file.
		expect(readFileSync(join(root, "nodes", "artist", "millsart.json"), "utf8")).toBe(before);

		const again = await runMigration({ cacheDir: root, apply: true });
		expect(again.manifest.written).toBe(0);
	});

	it("changes no other field of the nodes it touches", async () => {
		const root = tmp();
		writeCache(root, [jeffMills(), theWizard()]);
		await runMigration({ cacheDir: root, apply: true });
		const { aliases: _a, ...mills } = readNode(root, "artist:jeff-mills");
		const { aliases: _b, ...expected } = jeffMills();
		expect(mills).toEqual(expected);
	});

	it("writes the manifest the migration channel validates: nothing removed, renamed or redirected", async () => {
		const root = tmp();
		writeCache(root, [jeffMills(), theWizard()]);
		const manifestPath = join(tmp(), "out", "m.json");
		await runMigration({ cacheDir: root, apply: true, manifestPath });
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			mode: "apply",
			blocked: false,
			removed: [],
			renamed: {},
			redirects: {},
			written: 2,
		});
	});

	it("blocks the whole run, writing nothing, when one node is refused (exit 2 with --apply)", async () => {
		const root = tmp();
		writeCache(root, [{ ...jeffMills(), editorial_article: "too short" }, theWizard()]);
		const result = await runMigration({ cacheDir: root, apply: true });
		expect(result.exitCode).toBe(2);
		expect(result.manifest.blocked).toBe(true);
		expect(readNode(root, "artist:the-wizard").aliases).toHaveLength(1);
	});
});

describe("channel contract (deploy/sync-genre-cache.sh)", () => {
	const script = readFileSync(resolve("deploy/sync-genre-cache.sh"), "utf8");

	it("the migration name is accepted by the channel's name pattern, and the script it runs exists", () => {
		const pattern = /^MIGRATION_NAME_PATTERN='(.+)'$/m.exec(script)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(resolve("scripts", "migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
	});

	it("takes the flags the channel passes: <cache-dir> --apply --manifest <path> --data-dir <dir>", () => {
		expect(parseCliArgs(["/union", "--apply", "--manifest", "/m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/union",
			apply: true,
			manifestPath: "/m.json",
			dataDir: "/d",
		});
		expect(parseCliArgs(["/union"])).toMatchObject({ apply: false, manifestPath: DEFAULT_MANIFEST_PATH });
	});

	it("refuses anything else (exit 2)", () => {
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["--apply"])).toBeNull();
		expect(parseCliArgs(["/union", "--manifest"])).toBeNull();
		expect(parseCliArgs(["/union", "--bogus"])).toBeNull();
		expect(parseCliArgs(["/union", "--apply", "--apply"])).toBeNull();
	});
});

describe("the committed cache after the migration (TRA-562 acceptance)", () => {
	const aliasesOf = (name: string): string[] =>
		(
			JSON.parse(readFileSync(resolve("cache", "nodes", "artist", `${name}.json`), "utf8")).aliases as Obj[]
		).map((e) => e.slug as string);

	it("lists no homonym of the closed list as an alias, on either side", () => {
		for (const d of DETACHMENTS) {
			expect(aliasesOf(d.a.slug.slice(7))).not.toContain(d.b.slug);
			expect(aliasesOf(d.b.slug.slice(7))).not.toContain(d.a.slug);
		}
	});

	it("keeps the aliases that are real (Millsart; LX Empire, confirmed by MusicBrainz)", () => {
		expect(aliasesOf("jeff-mills")).toContain("artist:millsart");
		expect(aliasesOf("alec-empire")).toContain("artist:lx-empire");
	});

	it("has the audit ceiling at the one pair judged right", () => {
		const thresholds = JSON.parse(readFileSync(resolve("data", "integrity-thresholds.json"), "utf8"));
		expect(thresholds["alias-to-uncorroborated-identity"]).toBe(1);
	});
});
