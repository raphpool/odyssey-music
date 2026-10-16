import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	identityDisagreement,
	isSafePendingEntry,
	type Manifest,
	parseCliArgs,
	runMigration,
} from "../scripts/migrations/2026-10-16-scope-release-slugs.js";
import { parseSlugRedirects } from "../src/genre-registry.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { nodePayloadSchema } from "../src/schemas.js";
import { normalizeSlugBody, parseSlug } from "../src/slug.js";

type Obj = Record<string, unknown>;

const MBID_RONI = "45e00f0f-0000-4000-8000-000000000001";
const MBID_SAKAMOTO = "45e00f0f-0000-4000-8000-000000000002";
const MBID_POLE = "45e00f0f-0000-4000-8000-000000000003";
const MBID_A = "45e00f0f-0000-4000-8000-000000000004";
const MBID_B = "45e00f0f-0000-4000-8000-000000000005";

const PROSE: Record<NodeType, Obj> = {
	artist: { editorial_bio: "bio" },
	project: { editorial_pitch: "pitch" },
	track: { editorial_teaser: "teaser" },
	label: { editorial_description: "description" },
	genre: { editorial_definition: "definition", editorial_description: "description" },
};

function ref(slug: string, name: string, extra: Obj = {}): Obj {
	return { slug, type: parseSlug(slug).type, name, ...extra };
}

function node(slug: string, name: string, fields: Obj = {}): Obj {
	const type = parseSlug(slug).type;
	return {
		slug,
		name,
		type,
		editorial_article: "x".repeat(100),
		citations: [{ url: "https://example.com/a", title: "a" }],
		materialized_at: "2026-10-16T00:00:00.000Z",
		...PROSE[type],
		...Object.fromEntries(LIST_EDGES_BY_TYPE[type].map((f) => [f, []])),
		...fields,
	};
}

const credit = (slug: string, name: string, extra: Obj = {}): Obj[] => [ref(slug, name, extra)];

let root: string;
let cacheDir: string;
let redirectsPath: string;
let artistManifestPath: string;
const savedFlag = process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "scope-release-slugs-"));
	cacheDir = join(root, "cache");
	redirectsPath = join(root, "data", "slug-redirects.json");
	artistManifestPath = join(root, "out", "artist-identity.json");
	await mkdir(join(cacheDir, "nodes"), { recursive: true });
	process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = "1";
});

afterEach(async () => {
	if (savedFlag === undefined) delete process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
	else process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = savedFlag;
	await rm(root, { recursive: true, force: true });
});

function nodePath(slug: string): string {
	const { type, body } = parseSlug(slug);
	return join(cacheDir, "nodes", type, `${body}.json`);
}

async function seed(nodes: Obj[], pending?: Obj): Promise<void> {
	for (const n of nodes) {
		const path = nodePath(n.slug as string);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(n));
	}
	if (pending) await writeFile(join(cacheDir, "pending-reverses.json"), JSON.stringify(pending));
}

async function seedIdentities(manifest: { resolved?: Obj; collisions?: Obj[] }): Promise<void> {
	await mkdir(dirname(artistManifestPath), { recursive: true });
	await writeFile(artistManifestPath, JSON.stringify({ resolved: {}, collisions: [], ...manifest }));
}

async function read(slug: string): Promise<Obj> {
	return JSON.parse(await readFile(nodePath(slug), "utf8")) as Obj;
}

async function exists(slug: string): Promise<boolean> {
	return readFile(nodePath(slug), "utf8").then(
		() => true,
		() => false,
	);
}

async function tree(dir: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (d: string): Promise<void> => {
		for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) await walk(p);
			else out[p.slice(dir.length)] = await readFile(p, "utf8");
		}
	};
	await walk(dir);
	return out;
}

const run = (apply: boolean, extra: { manifestPath?: string; beforeWrite?: (index: number) => void } = {}) =>
	runMigration({ cacheDir, apply, redirectsPath, artistManifestPath, scratch: true, ...extra });

const edgeSlugs = (n: Obj, field: string): unknown[] => ((n[field] as Obj[]) ?? []).map((e) => e.slug);

describe("scope-release-slugs migration", () => {
	it("refuses to run when the scoped-slug flag is off, before reading anything", async () => {
		process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = "0";
		await seed([node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") })]);
		const before = await tree(root);
		const result = await run(true);
		expect(result.exitCode).toBe(2);
		expect(result.manifest.errors.join()).toContain("ODYSSEY_SCOPED_RELEASE_SLUGS");
		expect(await tree(root)).toEqual(before);
	});

	describe("Fitna: a namesake's work is renamed, the other artist is detached", () => {
		beforeEach(async () => {
			await seed([
				node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") }),
				node("artist:akuma", "Akuma", { notable_tracks: [ref("track:fitna", "Fitna")] }),
				node("artist:rohff", "Rohff", {
					notable_tracks: [ref("track:fitna", "Fitna", { mbid: MBID_A, year: "2020" })],
				}),
			]);
		});

		it("dry-run plans the rename and the detachment without touching the cache", async () => {
			const before = await tree(root);
			const { manifest, exitCode } = await run(false);
			expect(exitCode).toBe(0);
			expect(manifest.mode).toBe("dry-run");
			expect(manifest.renamed).toEqual({ "track:fitna": "track:fitna--akuma" });
			expect(manifest.detached).toEqual([
				{
					node: "artist:rohff",
					field: "notable_tracks",
					from: "track:fitna",
					to: "track:fitna--rohff",
					name: "Fitna",
				},
			]);
			expect(manifest.written).toBe(0);
			expect(await tree(root)).toEqual(before);
		});

		it("apply writes track:fitna--akuma, redirects the old slug, rewrites Akuma, detaches Rohff", async () => {
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(await exists("track:fitna")).toBe(false);
			expect((await read("track:fitna--akuma")).slug).toBe("track:fitna--akuma");
			const redirects = parseSlugRedirects(JSON.parse(await readFile(redirectsPath, "utf8")));
			expect(redirects.get("track:fitna" as never)).toBe("track:fitna--akuma");
			expect(edgeSlugs(await read("artist:akuma"), "notable_tracks")).toEqual(["track:fitna--akuma"]);
			const [detached] = (await read("artist:rohff")).notable_tracks as Obj[];
			expect(detached).toMatchObject({ slug: "track:fitna--rohff", artist: "Rohff", year: "2020" });
			expect(detached).not.toHaveProperty("mbid");
			expect(manifest.rewritten).toEqual([
				{ node: "artist:akuma", from: "track:fitna", to: "track:fitna--akuma", count: 1 },
			]);
			expect(manifest.written).toBe(3);
		});

		it("without a credit match and without membership data, an edge is never attached by guesswork", async () => {
			await run(true);
			const rohff = await read("artist:rohff");
			expect(edgeSlugs(rohff, "notable_tracks")).not.toContain("track:fitna--akuma");
		});
	});

	describe("New Forms: a member of the credited group keeps the edge", () => {
		const seedNewForms = async (): Promise<void> =>
			seed([
				node("project:new-forms", "New Forms", {
					artists: credit("artist:roni-size-reprazent", "Roni Size / Reprazent", { mbid: MBID_RONI }),
				}),
				node("artist:roni-size-reprazent", "Roni Size / Reprazent", { mbid: MBID_RONI }),
				node("artist:roni-size", "Roni Size", { discography: [ref("project:new-forms", "New Forms")] }),
			]);

		it("rewrites (does not detach) when the artist manifest says the source belongs to the credited group", async () => {
			await seedNewForms();
			await seedIdentities({
				resolved: { "artist:roni-size": { mbid: MBID_A, groups: [{ mbid: MBID_RONI }] } },
			});
			const { manifest } = await run(true);
			expect(manifest.detached).toEqual([]);
			expect(edgeSlugs(await read("artist:roni-size"), "discography")).toEqual([
				"project:new-forms--roni-size-reprazent",
			]);
		});

		it("rewrites when the credited group lists the source among its members", async () => {
			await seedNewForms();
			await seed([
				node("artist:roni-size-reprazent", "Roni Size / Reprazent", {
					mbid: MBID_RONI,
					members: [ref("artist:roni-size", "Roni Size")],
				}),
			]);
			const { manifest } = await run(true);
			expect(manifest.detached).toEqual([]);
		});

		it("detaches when nothing links the source to the credit", async () => {
			await seedNewForms();
			const { manifest } = await run(true);
			expect(manifest.detached.map((d) => d.to)).toEqual(["project:new-forms--roni-size"]);
		});
	});

	it("an incoming edge with no credit information is detached, never attached at random", async () => {
		await seed([
			node("track:intro", "Intro", { artists: credit("artist:alpha", "Alpha") }),
			node("artist:alpha", "Alpha"),
			node("artist:beta", "Beta", { notable_tracks: [ref("track:intro", "Intro")] }),
		]);
		const { manifest } = await run(true);
		expect(manifest.detached).toHaveLength(1);
		expect(edgeSlugs(await read("artist:beta"), "notable_tracks")).toEqual(["track:intro--beta"]);
	});

	it("merges two legacy duplicates of one work into one scoped node and unions their edges", async () => {
		const jan = credit("artist:jan-jelinek", "Jan Jelinek");
		await seed([
			node("track:moire--by-jan-jelinek", "Moire", {
				artists: jan,
				genres: [ref("genre:ambient", "Ambient")],
				citations: [{ url: "https://example.com/a" }],
			}),
			node("track:moire--track-by-jan-jelinek-from-loop-finding-jazz-records", "Moire", {
				artists: jan,
				genres: [ref("genre:jazz", "Jazz")],
				citations: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
			}),
			node("artist:jan-jelinek", "Jan Jelinek", {
				notable_tracks: [
					ref("track:moire--by-jan-jelinek", "Moire"),
					ref("track:moire--track-by-jan-jelinek-from-loop-finding-jazz-records", "Moire"),
				],
			}),
		]);
		const { manifest, exitCode } = await run(true);
		expect(exitCode).toBe(0);
		expect(manifest.merged).toEqual([
			{
				slug: "track:moire--jan-jelinek",
				winner: "track:moire--track-by-jan-jelinek-from-loop-finding-jazz-records",
				losers: ["track:moire--by-jan-jelinek"],
				criterion: "citations",
			},
		]);
		expect(manifest.removed).toEqual(["nodes/track/moire--by-jan-jelinek.json"]);
		expect(Object.keys(manifest.redirects).sort()).toEqual([
			"track:moire--by-jan-jelinek",
			"track:moire--track-by-jan-jelinek-from-loop-finding-jazz-records",
		]);
		const merged = await read("track:moire--jan-jelinek");
		expect(edgeSlugs(merged, "genres")).toEqual(["genre:jazz", "genre:ambient"]);
		expect(edgeSlugs(await read("artist:jan-jelinek"), "notable_tracks")).toEqual([
			"track:moire--jan-jelinek",
		]);
		expect(await exists("track:moire--by-jan-jelinek")).toBe(false);
	});

	it("merges artists the manifest resolved on one MBID into the slug without a disambiguator", async () => {
		await seed([
			node("artist:pole", "Pole", { mbid: MBID_POLE }),
			node("artist:pole--stefan-betke", "Pole", {
				mbid: MBID_POLE,
				collaborators: [ref("artist:x", "X")],
				citations: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
			}),
			node("project:steel", "Steel", { artists: credit("artist:pole--stefan-betke", "Pole") }),
		]);
		await seedIdentities({
			collisions: [{ mbid: MBID_POLE, slugs: ["artist:pole", "artist:pole--stefan-betke"] }],
		});
		const { manifest, exitCode } = await run(true);
		expect(exitCode).toBe(0);
		expect(manifest.merged).toMatchObject([
			{
				slug: "artist:pole",
				winner: "artist:pole",
				losers: ["artist:pole--stefan-betke"],
				criterion: "no-disambiguator",
			},
		]);
		expect(await exists("artist:pole--stefan-betke")).toBe(false);
		expect(edgeSlugs(await read("artist:pole"), "collaborators")).toEqual(["artist:x"]);
		expect(manifest.redirects).toMatchObject({ "artist:pole--stefan-betke": "artist:pole" });
		expect(edgeSlugs(await read("project:steel--pole"), "artists")).toEqual(["artist:pole"]);
	});

	it("removes an artist's edge to itself", async () => {
		await seed([node("artist:cartola", "Cartola", { members: [ref("artist:cartola", "Cartola")] })]);
		const { manifest } = await run(true);
		expect(manifest.self_edges_removed).toEqual([{ node: "artist:cartola", field: "members" }]);
		expect((await read("artist:cartola")).members).toEqual([]);
	});

	it("scopes a work credited in a non-Latin script through the cache's own artist node", async () => {
		await seed([
			node("project:async", "Async", { artists: credit("artist:x", "坂本龍一", { mbid: MBID_SAKAMOTO }) }),
			node("artist:ryuichi-sakamoto", "Ryuichi Sakamoto", { mbid: MBID_SAKAMOTO }),
			node("project:orphan", "Orphan", { artists: credit("artist:y", "坂本龍一") }),
		]);
		const { manifest, exitCode } = await run(true);
		expect(exitCode).toBe(0);
		expect(manifest.renamed).toEqual({ "project:async": "project:async--ryuichi-sakamoto" });
		expect(manifest.skipped).toEqual([{ slug: "project:orphan", reason: "no-latin-scope-name" }]);
		expect(await exists("project:orphan")).toBe(true);
	});

	it("lists a work with no credit as skipped and leaves it intact", async () => {
		await seed([node("project:lonely", "Lonely")]);
		const { manifest } = await run(true);
		expect(manifest.skipped).toEqual([{ slug: "project:lonely", reason: "no-credit" }]);
		expect(await exists("project:lonely")).toBe(true);
		expect(manifest.summary.nodes_to_write).toBe(0);
	});

	it("keeps three remixes of one title apart", async () => {
		const bugz = credit("artist:bugz-in-the-attic", "Bugz in the Attic");
		await seed([
			node("project:booty-la-la", "Booty La La", { artists: bugz }),
			node("project:booty-la-la-loefah-remix", "Booty La La (Loefah remix)", { artists: bugz }),
			node("project:booty-la-la-draw-the-line-remix", "Booty La La (Draw the Line remix)", { artists: bugz }),
		]);
		const { manifest } = await run(true);
		expect(manifest.merged).toEqual([]);
		expect(Object.values(manifest.renamed).sort()).toEqual([
			"project:booty-la-la--bugz-in-the-attic",
			"project:booty-la-la-draw-the-line-remix--bugz-in-the-attic",
			"project:booty-la-la-loefah-remix--bugz-in-the-attic",
		]);
	});

	it("refuses --apply without the artist-identity manifest, and while the table lacks ð / ı", async () => {
		await seed([node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") })]);
		const noManifest = await runMigration({ cacheDir, apply: true, redirectsPath, artistManifestPath });
		expect(noManifest.exitCode).toBe(2);
		expect(noManifest.manifest.errors.join()).toContain("artist-identity manifest");
		expect(await exists("track:fitna")).toBe(true);

		await seedIdentities({});
		const complete = normalizeSlugBody("ðı") === "di";
		const dry = await runMigration({ cacheDir, apply: false, redirectsPath, artistManifestPath });
		expect(dry.exitCode).toBe(0);
		expect(dry.manifest.notes.some((n) => n.includes("TRA-531"))).toBe(!complete);
		const applied = await runMigration({ cacheDir, apply: true, redirectsPath, artistManifestPath });
		expect(applied.exitCode).toBe(complete ? 0 : 2);
		expect(await exists("track:fitna")).toBe(!complete);
	});

	it("reports a malformed edge slug instead of aborting the plan", async () => {
		await seed([
			node("project:lp", "LP", { artists: credit("artist:rohff-x", "Rohff") }),
			node("artist:rohff", "Rohff", {
				discography: [ref("project:lp", "LP"), { slug: "album:??", type: "project", name: "Bad" }],
			}),
		]);
		const { manifest } = await run(false);
		expect(manifest.conflicts).toMatchObject([{ kind: "detach-target" }]);
	});

	it("does not merge a namesake without mbid whose credit differs (Mo / MØ)", async () => {
		await seed([node("artist:m", "MØ"), node("artist:mo", "Mo")]);
		const { manifest } = await run(true);
		expect(manifest.conflicts).toMatchObject([{ kind: "merge", slugs: ["artist:m", "artist:mo"] }]);
		expect(await exists("artist:m")).toBe(true);
		expect(await exists("artist:mo")).toBe(true);
	});

	describe("conflicts", () => {
		it("two works with different MBIDs on one scoped slug are listed, not merged, and nothing is written", async () => {
			await seed([
				node("track:echo", "Echo", { artists: credit("artist:a", "A"), mbid: MBID_A }),
				node("track:echo--a", "Echo", { artists: credit("artist:a", "A"), mbid: MBID_B }),
			]);
			const before = await tree(cacheDir);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.conflicts).toMatchObject([{ kind: "merge", slugs: ["track:echo", "track:echo--a"] }]);
			expect(manifest.merged).toEqual([]);
			expect(await tree(cacheDir)).toEqual(before);
		});

		it("identityDisagreement accepts a missing mbid on one side only when the credits agree", () => {
			const file = (mbid: string | undefined, creditName: string) => ({
				path: "",
				slug: "track:t",
				type: "track" as const,
				node: { name: "T", artists: [{ name: creditName }], ...(mbid ? { mbid } : {}) },
			});
			expect(identityDisagreement([file(MBID_A, "A"), file(undefined, "A")])).toBeNull();
			expect(identityDisagreement([file(undefined, "A"), file(undefined, "B")])).toContain(
				"different credits",
			);
			expect(identityDisagreement([file(MBID_A, "A"), file(MBID_B, "A")])).toContain("different mbids");
		});
	});

	it("does not let a manifest collision settle a third node that only transliterates onto its slug", async () => {
		await seed([
			node("artist:mo", "Mo", { mbid: MBID_A }),
			node("artist:mo--stage-name", "Mo", { mbid: MBID_A }),
			node("artist:m", "MØ"),
		]);
		await seedIdentities({ collisions: [{ mbid: MBID_A, slugs: ["artist:mo", "artist:mo--stage-name"] }] });
		const before = await tree(root);
		const { manifest, exitCode } = await run(true);
		expect(exitCode).toBe(0);
		expect(manifest.conflicts).toMatchObject([
			{ kind: "merge", slugs: ["artist:m", "artist:mo", "artist:mo--stage-name"] },
		]);
		expect(manifest.merged).toEqual([]);
		expect(manifest.redirects).toEqual({});
		expect(await tree(root)).toEqual(before);
	});

	describe("the collision's own mbid", () => {
		const collision = { collisions: [{ mbid: MBID_A, slugs: ["artist:mo", "artist:mo--stage-name"] }] };

		it("does not merge an intruder carrying another mbid into a collision, even if the collision nodes carry none yet", async () => {
			await seed([
				node("artist:mo", "Mo"),
				node("artist:mo--stage-name", "Mo"),
				node("artist:m", "MØ", { mbid: MBID_B }),
			]);
			await seedIdentities(collision);
			const before = await tree(cacheDir);
			const { manifest, exitCode } = await run(false);
			expect(exitCode).toBe(0);
			expect(manifest.conflicts).toMatchObject([{ kind: "merge" }]);
			expect(manifest.conflicts[0]?.reason).toContain(`different mbids: ${MBID_A}, ${MBID_B}`);
			expect(manifest.merged).toEqual([]);
			expect(await tree(cacheDir)).toEqual(before);
		});

		it("same conflict, no write, when the collision nodes do carry the manifest's mbid", async () => {
			await seed([
				node("artist:mo", "Mo", { mbid: MBID_A }),
				node("artist:mo--stage-name", "Mo", { mbid: MBID_A }),
				node("artist:m", "MØ", { mbid: MBID_B }),
			]);
			await seedIdentities(collision);
			const before = await tree(cacheDir);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.conflicts).toMatchObject([{ kind: "merge" }]);
			expect(await tree(cacheDir)).toEqual(before);
		});

		it("refuses --apply (exit 2, nothing written) while a collision node lacks the manifest's mbid", async () => {
			await seed([node("artist:mo", "Mo"), node("artist:mo--stage-name", "Mo", { mbid: MBID_A })]);
			await seedIdentities(collision);
			const before = await tree(root);
			const applied = await run(true);
			expect(applied.exitCode).toBe(2);
			expect(applied.manifest.errors.join()).toContain("artist identity backfill (TRA-463)");
			expect(await tree(root)).toEqual(before);
			const dry = await run(false);
			expect(dry.exitCode).toBe(0);
			expect(dry.manifest.notes.join()).toContain("artist identity backfill (TRA-463)");
		});
	});

	describe("one identity guard on every path onto an existing node", () => {
		it("path 2: a dangling target is not sent to an existing node of another identity (MØ -> Mo)", async () => {
			await seed([
				node("artist:mo", "Mo"),
				node("artist:a", "A", { collaborators: [ref("artist:m", "MØ")] }),
			]);
			const before = await tree(cacheDir);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.conflicts).toMatchObject([
				{ kind: "dangling-target", slugs: ["artist:m", "artist:mo"] },
			]);
			expect(manifest.redirects).toEqual({});
			expect(await tree(cacheDir)).toEqual(before);
			expect(await readFile(redirectsPath, "utf8").catch(() => null)).toBeNull();
		});

		it("path 2: the same dangling target is followed when the references carry the node's mbid", async () => {
			await seed([
				node("artist:mo", "Mo", { mbid: MBID_A }),
				node("artist:a", "A", { collaborators: [ref("artist:m", "MØ", { mbid: MBID_A })] }),
			]);
			const { manifest } = await run(true);
			expect(manifest.conflicts).toEqual([]);
			expect(manifest.redirects).toEqual({ "artist:m": "artist:mo" });
		});

		it("path 3: a pending-reverses key follows no rename that the guard refused", async () => {
			const pending = {
				"artist:m": [{ field: "collaborators", cardinality: "list", edge: ref("artist:a", "A") }],
			};
			await seed(
				[node("artist:mo", "Mo"), node("artist:a", "A", { collaborators: [ref("artist:m", "MØ")] })],
				pending,
			);
			const { manifest } = await run(true);
			expect(manifest.pending_reverses).toEqual([]);
			expect(JSON.parse(await readFile(join(cacheDir, "pending-reverses.json"), "utf8"))).toEqual(
				JSON.parse(JSON.stringify(pending)),
			);
			expect(edgeSlugs(await read("artist:mo"), "collaborators")).toEqual([]);
		});

		it("path 1 and 5: no edge is rewritten to a node a refused merge left alone", async () => {
			await seed([
				node("artist:m", "MØ"),
				node("artist:mo", "Mo"),
				node("artist:c", "C", { collaborators: [ref("artist:m", "MØ")] }),
			]);
			const before = await tree(cacheDir);
			const { manifest } = await run(true);
			expect(manifest.conflicts).toMatchObject([{ kind: "merge", slugs: ["artist:m", "artist:mo"] }]);
			expect(manifest.redirects).toEqual({});
			expect(await tree(cacheDir)).toEqual(before);
		});

		it("path 4: an edge is not detached onto a scoped slug that belongs to another artist", async () => {
			await seed([
				node("project:x", "X", { artists: credit("artist:other", "Other") }),
				node("project:x--mo", "X", { artists: credit("artist:other-mo", "Mø") }),
				node("artist:mo", "Mo", { discography: [ref("project:x", "X")] }),
			]);
			const before = await tree(cacheDir);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(1);
			expect(manifest.conflicts).toMatchObject([
				{ kind: "detach-target", slugs: ["artist:mo", "project:x--mo"] },
			]);
			expect(await tree(cacheDir)).toEqual(before);
		});

		it("keeps the benign Lætitia / Laetitia collision (æ is the same spelling as ae)", async () => {
			await seed([
				node("artist:laetitia-sadier", "Laetitia Sadier"),
				node("artist:stereolab", "Stereolab", { members: [ref("artist:l-titia-sadier", "Lætitia Sadier")] }),
			]);
			const { manifest } = await run(true);
			expect(manifest.conflicts).toEqual([]);
			expect(manifest.redirects).toEqual({ "artist:l-titia-sadier": "artist:laetitia-sadier" });
		});
	});

	describe("transliteration (TRA-528)", () => {
		it("renames the node, the dangling targets and the pending-reverses keys, and leaves a namesake alone", async () => {
			await seed(
				[
					node("artist:m", "MØ", { influenced: [ref("artist:x", "X")] }),
					node("artist:laetitia-sadier", "Laetitia Sadier"),
					node("artist:stereolab", "Stereolab", {
						members: [ref("artist:l-titia-sadier", "Lætitia Sadier"), ref("artist:m", "MØ")],
					}),
					node("artist:mary-hansen", "Mary Hansen", {
						collaborators: [ref("artist:l-titia-sadier", "Lætitia Sadier")],
					}),
					node("artist:quartet", "Quartet", {
						members: [ref("artist:s-awomir-kurkiewicz", "Sławomir Kurkiewicz")],
					}),
				],
				{
					"artist:l-titia-sadier": [
						{ field: "members", cardinality: "list", edge: ref("artist:stereolab", "Stereolab") },
					],
					"artist:s-awomir-kurkiewicz": [
						{ field: "members", cardinality: "list", edge: ref("artist:quartet", "Quartet") },
					],
				},
			);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.renamed).toEqual({ "artist:m": "artist:mo" });
			expect(manifest.redirects).toEqual({
				"artist:l-titia-sadier": "artist:laetitia-sadier",
				"artist:m": "artist:mo",
				"artist:s-awomir-kurkiewicz": "artist:slawomir-kurkiewicz",
			});
			expect(edgeSlugs(await read("artist:stereolab"), "members")).toEqual([
				"artist:laetitia-sadier",
				"artist:mo",
			]);
			expect(edgeSlugs(await read("artist:mary-hansen"), "collaborators")).toEqual([
				"artist:laetitia-sadier",
			]);
			expect(manifest.pending_reverses).toEqual([
				{ from: "artist:l-titia-sadier", to: "artist:laetitia-sadier" },
				{ from: "artist:s-awomir-kurkiewicz", to: "artist:slawomir-kurkiewicz" },
			]);
			// Onto a node that exists: applied to it and dropped. Onto a dangling target: only the key moves.
			expect(edgeSlugs(await read("artist:laetitia-sadier"), "members")).toEqual(["artist:stereolab"]);
			const pending = JSON.parse(await readFile(join(cacheDir, "pending-reverses.json"), "utf8")) as Obj;
			expect(Object.keys(pending)).toEqual(["artist:slawomir-kurkiewicz"]);
		});

		it("never applies the table edge by edge when two references name one old slug differently", async () => {
			await seed([
				node("artist:a", "A", { collaborators: [ref("artist:m", "MØ")] }),
				node("artist:b", "B", { collaborators: [ref("artist:m", "M")] }),
			]);
			const { manifest } = await run(true);
			expect(manifest.conflicts).toMatchObject([
				{ kind: "transliteration", slugs: ["artist:m", "artist:mo"] },
			]);
			expect(manifest.redirects).toEqual({});
			expect(edgeSlugs(await read("artist:a"), "collaborators")).toEqual(["artist:m"]);
			expect(edgeSlugs(await read("artist:b"), "collaborators")).toEqual(["artist:m"]);
		});

		it("leaves a transliterated work with a free-text legacy disambiguator as it is, and lists it", async () => {
			await seed([
				node("track:foo--free-text-by-mo", "Foo", { artists: credit("artist:m", "MØ") }),
				node("artist:m", "MØ", { notable_tracks: [ref("track:foo--free-text-by-mo", "Foo")] }),
			]);
			const { manifest } = await run(true);
			expect(manifest.not_derivable).toEqual([
				{ slug: "track:foo--free-text-by-mo", reason: expect.stringContaining("not derived from the name") },
			]);
			expect(await exists("track:foo--free-text-by-mo")).toBe(true);
			expect(manifest.renamed).toEqual({ "artist:m": "artist:mo" });
		});
	});

	describe("apply", () => {
		const seedMixed = async (): Promise<void> => {
			await seed([
				node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") }),
				node("artist:akuma", "Akuma", { notable_tracks: [ref("track:fitna", "Fitna")] }),
				node("artist:rohff", "Rohff", { notable_tracks: [ref("track:fitna", "Fitna")] }),
				node("artist:cartola", "Cartola", { members: [ref("artist:cartola", "Cartola")] }),
				node("project:void", "ØØ Void", { artists: credit("artist:akuma", "Akuma") }),
			]);
		};

		it("is idempotent: a second --apply plans and writes nothing", async () => {
			await seedMixed();
			await run(true);
			const after = await tree(root);
			const second = await run(true);
			expect(second.exitCode).toBe(0);
			expect(second.manifest.written).toBe(0);
			expect(second.manifest.renamed).toEqual({});
			expect(second.manifest.detached).toEqual([]);
			expect(second.manifest.summary.nodes_to_write).toBe(0);
			expect(await tree(root)).toEqual(after);
		});

		it("leaves a cache whose files all validate, with a parseable redirect table and no edge to a retired slug", async () => {
			await seedMixed();
			const { manifest } = await run(true);
			const redirects = parseSlugRedirects(JSON.parse(await readFile(redirectsPath, "utf8")));
			expect([...redirects.keys()].sort()).toEqual(Object.keys(manifest.redirects).sort());
			const files = await tree(join(cacheDir, "nodes"));
			expect(Object.keys(files).length).toBe(5);
			for (const text of Object.values(files)) {
				const parsed = nodePayloadSchema.parse(JSON.parse(text)) as unknown as Obj;
				const slugs = Object.values(parsed)
					.flatMap((v) => (Array.isArray(v) ? v : [v]))
					.flatMap((v) =>
						typeof v === "object" && v !== null && "slug" in v ? [(v as Obj).slug as string] : [],
					);
				for (const slug of slugs) expect(redirects.has(slug as never)).toBe(false);
			}
		});

		it("writes the manifest in dry-run too, and nothing else", async () => {
			await seedMixed();
			const before = await tree(cacheDir);
			const manifestPath = join(root, "out", "manifest.json");
			await run(false, { manifestPath });
			const written = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
			expect(written.migration).toBe("2026-10-16-scope-release-slugs");
			expect(Object.keys(written.renamed).sort()).toEqual(["project:void", "track:fitna"]);
			expect(await tree(cacheDir)).toEqual(before);
			expect(await readFile(redirectsPath, "utf8").catch(() => null)).toBeNull();
		});

		it("refuses to write anything when a written node would lose a field", async () => {
			await seed([
				node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma"), undeclared_field: "kept?" }),
			]);
			const before = await tree(cacheDir);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(1);
			expect(manifest.errors.join()).toContain("alter fields");
			expect(await tree(cacheDir)).toEqual(before);
		});
	});

	describe("edge folding (only collisions this run creates)", () => {
		const bugz = [
			ref("project:booty-la-la", "Booty La La (Loefah remix)", { mbid: MBID_A, year: "2010" }),
			ref("project:booty-la-la", "Booty La La", { mbid: MBID_B, year: "2005" }),
			ref("project:booty-la-la", "Booty La La (Draw the Line remix)", { mbid: MBID_RONI, year: "2005" }),
		];

		it("leaves a node that holds duplicates of its own byte for byte, whatever else is migrated", async () => {
			await seed([
				node("artist:bugz-in-the-attic", "Bugz in the Attic", { discography: bugz }),
				node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") }),
			]);
			const before = await readFile(nodePath("artist:bugz-in-the-attic"), "utf8");
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(await readFile(nodePath("artist:bugz-in-the-attic"), "utf8")).toBe(before);
			expect(manifest.folded).toEqual([]);
			expect(manifest.summary.nodes_to_write).toBe(1);
		});

		const jan = credit("artist:jan-jelinek", "Jan Jelinek");
		const twins = (extra: Obj = {}): Obj[] => [
			node("track:moire--by-jan-jelinek", "Moire", { artists: jan }),
			node("track:moire--other-by-jan-jelinek", "Moire", {
				artists: jan,
				citations: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
			}),
			node("artist:jan-jelinek", "Jan Jelinek", extra),
		];

		it("keeps both edges and reports a conflict when merged duplicates are cited with two mbids", async () => {
			await seed(
				twins({
					notable_tracks: [
						ref("track:moire--by-jan-jelinek", "Moire", { mbid: MBID_A }),
						ref("track:moire--other-by-jan-jelinek", "Moire", { mbid: MBID_B }),
					],
				}),
			);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.folded).toEqual([]);
			expect(manifest.conflicts).toMatchObject([
				{ kind: "edge-mbid", slugs: ["artist:jan-jelinek.notable_tracks", "track:moire--jan-jelinek"] },
			]);
			expect(((await read("artist:jan-jelinek")).notable_tracks as Obj[]).map((e) => e.mbid)).toEqual([
				MBID_A,
				MBID_B,
			]);
		});

		it("folds a collision the run created into the most informative edge, and records it", async () => {
			await seed(
				twins({
					notable_tracks: [
						ref("track:moire--by-jan-jelinek", "Moire", { mbid: MBID_A }),
						ref("track:moire--other-by-jan-jelinek", "Moire", { year: "2020" }),
						ref("track:other", "Other"),
					],
				}),
			);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			const edges = (await read("artist:jan-jelinek")).notable_tracks as Obj[];
			expect(edges.map((e) => e.slug)).toEqual(["track:moire--jan-jelinek", "track:other"]);
			expect(edges[0]).toMatchObject({ mbid: MBID_A, year: "2020" });
			expect(manifest.folded).toHaveLength(1);
			expect(manifest.folded[0]).toMatchObject({ node: "artist:jan-jelinek", field: "notable_tracks" });
			expect(manifest.folded[0]?.before).toHaveLength(2);
		});
	});

	describe("inputs and malformed files", () => {
		it("lists an unreadable node file and carries on", async () => {
			await seed([node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") })]);
			await mkdir(join(cacheDir, "nodes", "artist"), { recursive: true });
			await writeFile(join(cacheDir, "nodes", "artist", "broken.json"), "{ not json");
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.malformed).toHaveLength(1);
			expect(manifest.malformed[0]?.reason).toContain("unreadable");
			expect(await exists("track:fitna--akuma")).toBe(true);
		});

		it("keeps a node with a non-canonical edge slug as it is when nothing in it needs rewriting", async () => {
			await seed([
				node("artist:odd", "Odd", { discography: [{ slug: "album:??", type: "project", name: "Bad" }] }),
				node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") }),
			]);
			const before = await readFile(nodePath("artist:odd"), "utf8");
			const { exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(await readFile(nodePath("artist:odd"), "utf8")).toBe(before);
		});

		it("exits 2 before any write on an invalid pending-reverses.json or artist manifest", async () => {
			await seed([node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") })], {
				"artist:x": "oops",
			});
			const before = await tree(root);
			const badPending = await run(true);
			expect(badPending.exitCode).toBe(2);
			expect(badPending.manifest.errors.join()).toContain("pending-reverses.json");
			await writeFile(join(cacheDir, "pending-reverses.json"), "{}");
			await seedIdentities({ resolved: { "artist:x": { mbid: MBID_A, groups: ["not-an-object"] } } });
			const afterManifest = await tree(root);
			const badManifest = await run(true);
			expect(badManifest.exitCode).toBe(2);
			expect(badManifest.manifest.errors.join()).toContain("invalid artist manifest");
			expect(await tree(root)).toEqual(afterManifest);
			expect(Object.keys(before).length).toBeGreaterThan(0);
		});
	});

	describe("rename targets and pending entries that cannot be written", () => {
		it("never overwrites an unreadable file at the target slug of a rename, and carries on", async () => {
			await seed([
				node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") }),
				node("track:echo", "Echo", { artists: credit("artist:a", "A") }),
			]);
			await mkdir(join(cacheDir, "nodes", "track"), { recursive: true });
			await writeFile(join(cacheDir, "nodes", "track", "fitna--akuma.json"), "{ not json");
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.conflicts).toMatchObject([
				{ kind: "unreadable-target", slugs: ["track:fitna", "track:fitna--akuma"] },
			]);
			expect(await readFile(join(cacheDir, "nodes", "track", "fitna--akuma.json"), "utf8")).toBe(
				"{ not json",
			);
			expect(await exists("track:fitna")).toBe(true);
			expect(manifest.renamed).toEqual({ "track:echo": "track:echo--a" });
		});

		it("keeps pending reverse edges under their key when the node meant to receive them is kept as is", async () => {
			await seed(
				[
					node("artist:laetitia-sadier", "Laetitia Sadier", { undeclared_field: "kept" }),
					node("artist:stereolab", "Stereolab", {
						members: [ref("artist:l-titia-sadier", "Lætitia Sadier")],
					}),
				],
				{
					"artist:l-titia-sadier": [
						{ field: "members", cardinality: "list", edge: ref("artist:stereolab", "Stereolab") },
					],
				},
			);
			const before = await readFile(nodePath("artist:laetitia-sadier"), "utf8");
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(await readFile(nodePath("artist:laetitia-sadier"), "utf8")).toBe(before);
			expect(manifest.malformed[0]?.reason).toContain("pending reverse edge(s) kept under their key");
			const pending = JSON.parse(await readFile(join(cacheDir, "pending-reverses.json"), "utf8")) as Obj;
			expect(Object.keys(pending)).toEqual(["artist:laetitia-sadier"]);
			expect((pending["artist:laetitia-sadier"] as Obj[]).map((e) => (e.edge as Obj).slug)).toEqual([
				"artist:stereolab",
			]);
		});
	});

	describe("pending entries that put a credit, a parent or a genre on a work (TRA-568)", () => {
		const entry = (field: string, slug: string, name: string): Obj => ({
			field,
			cardinality: "list",
			edge: ref(slug, name),
		});

		it("never applies them to the existing node a work key moves onto; the rest of the key is applied", async () => {
			const pole = credit("artist:pole", "Pole");
			await seed(
				[
					node("artist:pole", "Pole"),
					node("project:steel", "Steel", { artists: pole }),
					node("project:steel--pole", "Steel", { artists: pole }),
				],
				{
					"project:steel": [
						entry("artists", "artist:homonym", "Pole"),
						entry("genres", "genre:dub", "Dub"),
						entry("producers", "artist:someone", "Someone"),
						entry("related_projects", "project:other", "Other"),
					],
				},
			);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.redirects).toMatchObject({ "project:steel": "project:steel--pole" });
			const target = await read("project:steel--pole");
			expect(edgeSlugs(target, "artists")).toEqual(["artist:pole"]);
			expect(edgeSlugs(target, "genres")).toEqual([]);
			expect(edgeSlugs(target, "producers")).toEqual([]);
			expect(edgeSlugs(target, "related_projects")).toEqual(["project:other"]);
			const pending = JSON.parse(await readFile(join(cacheDir, "pending-reverses.json"), "utf8")) as Obj;
			expect(Object.keys(pending)).toEqual(["project:steel--pole"]);
			expect((pending["project:steel--pole"] as Obj[]).map((e) => e.field)).toEqual([
				"artists",
				"genres",
				"producers",
			]);
			expect(manifest.notes.join()).toContain("3 pending reverse edge(s) not applied");
		});

		it("still applies the same fields on an artist key, where the reverse edge is the safe direction", async () => {
			await seed(
				[
					node("artist:laetitia-sadier", "Laetitia Sadier"),
					node("project:x", "X", { artists: credit("artist:l-titia-sadier", "Lætitia Sadier") }),
				],
				{ "artist:l-titia-sadier": [entry("discography", "project:x", "X")] },
			);
			await run(true);
			expect(edgeSlugs(await read("artist:laetitia-sadier"), "discography")).toContain(
				"project:x--laetitia-sadier",
			);
		});

		it("classifies by the key's type and the field", () => {
			expect(isSafePendingEntry("project:a", { field: "artists" })).toBe(false);
			expect(isSafePendingEntry("track:a", { field: "project" })).toBe(false);
			expect(isSafePendingEntry("track:a", { field: "label" })).toBe(false);
			expect(isSafePendingEntry("track:a", { field: "samples" })).toBe(true);
			expect(isSafePendingEntry("artist:a", { field: "discography" })).toBe(true);
			expect(isSafePendingEntry("label:a", { field: "roster" })).toBe(true);
		});
	});

	describe("crash safety", () => {
		const seedCrashFixture = async (): Promise<void> => {
			const jan = credit("artist:jan-jelinek", "Jan Jelinek");
			await seed(
				[
					node("track:fitna", "Fitna", { artists: credit("artist:akuma", "Akuma") }),
					node("artist:akuma", "Akuma", {
						notable_tracks: [ref("track:fitna", "Fitna"), ref("track:song", "Song")],
						discography: [ref("project:ep", "EP")],
					}),
					node("artist:rohff", "Rohff", { notable_tracks: [ref("track:fitna", "Fitna")] }),
					node("track:moire--by-jan-jelinek", "Moire", { artists: jan }),
					node("track:moire--other-by-jan-jelinek", "Moire", {
						artists: jan,
						citations: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
					}),
					node("artist:jan-jelinek", "Jan Jelinek", {
						notable_tracks: [
							ref("track:moire--by-jan-jelinek", "Moire"),
							ref("track:moire--other-by-jan-jelinek", "Moire"),
						],
					}),
					// A renamed work pointing at another renamed work, both from the same artist.
					node("project:ep", "EP", {
						artists: credit("artist:akuma", "Akuma"),
						tracklist: [ref("track:song", "Song")],
					}),
					node("track:song", "Song", {
						artists: credit("artist:akuma", "Akuma"),
						project: ref("project:ep", "EP"),
					}),
					node("artist:laetitia-sadier", "Laetitia Sadier"),
					node("artist:stereolab", "Stereolab", {
						members: [ref("artist:l-titia-sadier", "Lætitia Sadier")],
					}),
				],
				{
					"artist:l-titia-sadier": [
						{ field: "members", cardinality: "list", edge: ref("artist:stereolab", "Stereolab") },
					],
				},
			);
		};

		const snapshot = async (): Promise<Record<string, string>> => ({
			...(await tree(cacheDir)),
			redirects: JSON.stringify(
				JSON.parse(await readFile(redirectsPath, "utf8").catch(() => '{"redirects":{}}')).redirects,
			),
		});

		it("converges to the same cache when a crash after any write is followed by a new run", async () => {
			await seedCrashFixture();
			let total = 0;
			const clean = await run(true, { beforeWrite: () => total++ });
			expect(clean.exitCode).toBe(0);
			expect(total).toBeGreaterThan(5);
			const expected = await snapshot();

			for (let crashAt = 0; crashAt < total; crashAt++) {
				await rm(cacheDir, { recursive: true, force: true });
				await rm(redirectsPath, { force: true });
				await mkdir(join(cacheDir, "nodes"), { recursive: true });
				await seedCrashFixture();
				await expect(
					run(true, {
						beforeWrite: (i) => {
							if (i === crashAt) throw new Error("simulated crash");
						},
					}),
				).rejects.toThrow("simulated crash");
				const retry = await run(true);
				expect(
					retry.exitCode,
					`crash at write ${crashAt}: ${JSON.stringify(retry.manifest.invariantViolations)}`,
				).toBe(0);
				expect(await snapshot(), `crash at write ${crashAt}`).toEqual(expected);
			}
		});
	});

	describe("the invariant: no edge resolves to a node of another identity", () => {
		// An oracle written apart from the script. A node is (name, mbid); an edge is followed by (name, mbid).
		const foldName = (s: string): string =>
			s
				.normalize("NFKD")
				.replace(/[̀-ͯ]/g, "")
				.trim()
				.toLowerCase()
				.replace(/[æœßþ]/g, (c) => ({ æ: "ae", œ: "oe", ß: "ss", þ: "th" })[c] as string);
		const keyOf = (n: Obj): string => `${n.name}|${n.mbid ?? ""}`;
		const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
		const edgesOf = (n: Obj, field: string): Obj[] =>
			([] as unknown[])
				.concat(n[field])
				.filter((e): e is Obj => isObj(e) && typeof e.slug === "string" && typeof e.type === "string");

		async function loadAll(): Promise<{ nodes: Map<string, Obj>; unreadable: Set<string> }> {
			const nodes = new Map<string, Obj>();
			const unreadable = new Set<string>();
			for (const type of await readdir(join(cacheDir, "nodes")).catch(() => [])) {
				for (const file of await readdir(join(cacheDir, "nodes", type)).catch(() => [])) {
					const slug = `${type}:${file.replace(/\.json$/, "")}`;
					try {
						nodes.set(slug, JSON.parse(await readFile(join(cacheDir, "nodes", type, file), "utf8")) as Obj);
					} catch {
						unreadable.add(slug);
					}
				}
			}
			return { nodes, unreadable };
		}

		/** Edges of the migrated cache that resolve to a node other than the one they cited, and do not describe it. */
		async function crossIdentity(before: Map<string, Obj>): Promise<string[]> {
			const { nodes: after, unreadable } = await loadAll();
			const byKey = new Map([...after.values()].map((n) => [keyOf(n), n]));
			const out: string[] = [];
			for (const n0 of before.values()) {
				const n1 = byKey.get(keyOf(n0));
				if (!n1) continue;
				for (const field of Object.keys(n0)) {
					for (const e0 of edgesOf(n0, field)) {
						const e1 = edgesOf(n1, field).find(
							(e) => e.name === e0.name && (e.mbid === e0.mbid || e.mbid === undefined),
						);
						if (!e1) continue;
						const slug = e1.slug as string;
						if (unreadable.has(slug) && slug !== e0.slug)
							out.push(`${n0.slug}.${field} -> unreadable ${slug}`);
						const r1 = after.get(slug);
						if (!r1) continue;
						const r0 = before.get(e0.slug as string);
						if (r0 && keyOf(r0) === keyOf(r1)) continue;
						const work = slug.startsWith("track:") || slug.startsWith("project:");
						const ref = foldName(String((work ? e1.artist : e1.name) ?? ""));
						const node = foldName(String((work ? (r1.artists as Obj[])[0]?.name : r1.name) ?? ""));
						const clash = e1.mbid !== undefined && r1.mbid !== undefined && e1.mbid !== r1.mbid;
						const detached = work && e1.artist === n1.name && e1.slug !== e0.slug;
						const creditMbid = work ? ((r1.artists as Obj[])[0]?.mbid as string | undefined) : undefined;
						const creditClash =
							detached && creditMbid !== undefined && n1.mbid !== undefined && creditMbid !== n1.mbid;
						if (ref === "" || ref !== node || clash || creditClash) {
							out.push(`${n0.slug}.${field} (${String(e0.name)}) -> ${slug} (${String(r1.name)})`);
						}
					}
				}
			}
			return out;
		}

		/** Run --apply; a refusal writes nothing, a success leaves no cross-identity edge. Returns the exit code. */
		async function applySafely(): Promise<{ exitCode: number; manifest: Manifest }> {
			const { nodes: before } = await loadAll();
			const snapshot = await tree(cacheDir);
			const result = await run(true);
			if (result.exitCode !== 0) {
				expect(await tree(cacheDir), "a refused run writes nothing").toEqual(snapshot);
			} else {
				expect(await crossIdentity(before)).toEqual([]);
			}
			return result;
		}

		const a = (slug: string, name: string, mbid?: string, fields: Obj = {}): Obj =>
			node(slug, name, { ...(mbid ? { mbid } : {}), ...fields });

		const attacks: [string, () => Promise<void>][] = [
			[
				"P1 node MØ(B) renamed onto node Mo(A)",
				() =>
					seed([
						a("artist:m", "MØ", MBID_B),
						a("artist:mo", "Mo", MBID_A),
						a("artist:x", "X", undefined, { collaborators: [ref("artist:m", "MØ")] }),
					]),
			],
			[
				"P2 dangling 'MØ'(B) refs -> node Mo(A)",
				() =>
					seed([
						a("artist:mo", "Mo", MBID_A),
						a("artist:x", "X", undefined, { collaborators: [ref("artist:m", "MØ", { mbid: MBID_B })] }),
					]),
			],
			[
				"P3 pending key vs node Mo(A)",
				() =>
					seed(
						[
							a("artist:mo", "Mo", MBID_A),
							a("artist:x", "X", undefined, { collaborators: [ref("artist:m", "MØ", { mbid: MBID_B })] }),
						],
						{ "artist:m": [{ field: "collaborators", cardinality: "list", edge: ref("artist:x", "X") }] },
					),
			],
			[
				"P4a detach onto a node credited to someone else",
				() =>
					seed([
						a("track:fitna", "Fitna", undefined, { artists: credit("artist:akuma", "Akuma") }),
						a("track:fitna--rohff", "Fitna", MBID_B, {
							artists: credit("artist:other", "Other", { mbid: MBID_B }),
						}),
						a("artist:rohff", "Rohff", MBID_A, { notable_tracks: [ref("track:fitna", "Fitna")] }),
					]),
			],
			[
				"P4b detach onto a node, same credit name, other artist mbid",
				() =>
					seed([
						a("track:fitna", "Fitna", undefined, { artists: credit("artist:akuma", "Akuma") }),
						a("track:fitna--rohff", "Fitna", MBID_B, {
							artists: credit("artist:rohff-2", "Rohff", { mbid: MBID_B }),
						}),
						a("artist:rohff", "Rohff", MBID_A, { notable_tracks: [ref("track:fitna", "Fitna")] }),
					]),
			],
			[
				"P4c detach onto a node with no credit",
				() =>
					seed([
						a("track:fitna", "Fitna", undefined, { artists: credit("artist:akuma", "Akuma") }),
						a("track:fitna--rohff", "Fitna", MBID_B),
						a("artist:rohff", "Rohff", MBID_A, { notable_tracks: [ref("track:fitna", "Fitna")] }),
					]),
			],
			[
				"P4d detach onto a rename destination credited to another artist",
				() =>
					seed([
						a("track:song", "Song", MBID_B, { artists: credit("artist:m", "MØ", { mbid: MBID_B }) }),
						a("artist:m", "MØ", MBID_B),
						a("artist:mo", "Mo", MBID_A, { notable_tracks: [ref("track:song", "Song")] }),
					]),
			],
			[
				"P5 existing redirect artist:m -> artist:mo applied to 'MØ' edges",
				async () => {
					await seed([
						a("artist:mo", "Mo", MBID_A),
						a("artist:x", "X", undefined, { collaborators: [ref("artist:m", "MØ", { mbid: MBID_B })] }),
					]);
					await mkdir(dirname(redirectsPath), { recursive: true });
					await writeFile(redirectsPath, JSON.stringify({ redirects: { "artist:m": "artist:mo" } }));
				},
			],
			[
				"6a node MØ(B) renamed onto a slug already cited by 'Mo'(A) refs",
				() =>
					seed([
						a("artist:m", "MØ", MBID_B),
						a("artist:x", "X", undefined, { collaborators: [ref("artist:mo", "Mo", { mbid: MBID_A })] }),
					]),
			],
			[
				"6a' work renamed onto a scoped slug already cited with another mbid",
				() =>
					seed([
						a("track:echo", "Echo", MBID_A, { artists: credit("artist:a", "A") }),
						a("artist:x", "X", undefined, {
							notable_tracks: [ref("track:echo--a", "Echo", { artist: "A", mbid: MBID_B })],
						}),
					]),
			],
			[
				"6b dangling 'Yalnızlık'(B) refs -> destination of a rename",
				() =>
					seed([
						a("track:yalnizlik", "Yalnizlik", MBID_A, { artists: credit("artist:cem-adrian", "Cem Adrian") }),
						a("artist:x", "X", undefined, {
							notable_tracks: [
								ref("track:yaln-zl-k--cem-adrian", "Yalnızlık", { artist: "Cem Adrian", mbid: MBID_B }),
							],
						}),
					]),
			],
			[
				"6c dangling 'MØ' refs -> unreadable artist:mo",
				async () => {
					await seed([
						a("artist:x", "X", undefined, { collaborators: [ref("artist:m", "MØ", { mbid: MBID_B })] }),
					]);
					await writeFile(nodePath("artist:mo"), "<<<<<<< HEAD\n{}\n=======\n");
				},
			],
			[
				"6d dangling 'MØ'(B) refs -> slug cited by dangling 'Mo'(A) refs",
				() =>
					seed([
						a("artist:x", "X", undefined, {
							collaborators: [
								ref("artist:m", "MØ", { mbid: MBID_B }),
								ref("artist:mo", "Mo", { mbid: MBID_A }),
							],
						}),
					]),
			],
		];

		it.each(attacks)("attack %s: refused, or safe", async (_label, build) => {
			await build();
			await applySafely();
		});

		const seedRedirects = async (redirects: Record<string, string>): Promise<void> => {
			await mkdir(dirname(redirectsPath), { recursive: true });
			await writeFile(redirectsPath, JSON.stringify({ source: "test", redirects }));
		};
		const moCitation = a("artist:x", "X", undefined, {
			collaborators: [ref("artist:mo", "Mo", { mbid: MBID_A })],
		});

		it("a non-empty redirect table opens no way in: MØ onto artist:mo, cited by Mo, is refused all the same", async () => {
			for (const redirects of [{}, { "artist:q": "artist:mo" }, { "artist:m": "artist:mo" }]) {
				await rm(cacheDir, { recursive: true, force: true });
				await mkdir(join(cacheDir, "nodes"), { recursive: true });
				await seed([a("artist:m", "MØ", MBID_B), moCitation]);
				await seedRedirects(redirects);
				const result = await applySafely();
				expect(result.exitCode, JSON.stringify(redirects)).toBe(2);
				expect(result.manifest.invariantViolations).toMatchObject([{ node: "artist:x", to: "artist:mo" }]);
			}
		});

		it("union-like table (the repo's migrated artist:mo and prod's old artist:m, one identity) stays safe", async () => {
			await seed([a("artist:mo", "MØ", MBID_B), a("artist:m", "MØ", MBID_B), moCitation]);
			await seedRedirects({ "artist:m": "artist:mo" });
			await applySafely();
		});

		it("P4d: an edge whose scoped slug is its own work's rename destination is listed as a conflict, not as detached", async () => {
			await seed([
				a("track:song", "Song", MBID_B, { artists: credit("artist:m", "MØ", { mbid: MBID_B }) }),
				a("artist:m", "MØ", MBID_B),
				a("artist:mo", "Mo", MBID_A, { notable_tracks: [ref("track:song", "Song")] }),
			]);
			const result = await applySafely();
			expect(result.manifest.detached).toEqual([]);
			expect(result.manifest.conflicts).toContainEqual(
				expect.objectContaining({ kind: "detach-target", slugs: ["artist:mo", "track:song--mo"] }),
			);
		});

		it("refuses the attacks that attach a stranger (exit 2, the violation listed)", async () => {
			await seed([
				a("artist:m", "MØ", MBID_B),
				a("artist:x", "X", undefined, { collaborators: [ref("artist:mo", "Mo", { mbid: MBID_A })] }),
			]);
			const dry = await run(false);
			expect(dry.exitCode).toBe(1);
			expect(dry.manifest.invariantViolations).toMatchObject([
				{ node: "artist:x", field: "collaborators", from: "artist:mo", to: "artist:mo" },
			]);
			const applied = await run(true);
			expect(applied.exitCode).toBe(2);
			expect(await exists("artist:m")).toBe(true);
		});

		it("holds on 300 random small caches (fixed seed), and a success is idempotent", async () => {
			let state = 0x2f6e2b1;
			const rand = (): number => {
				state = (state + 0x6d2b79f5) | 0;
				let x = Math.imul(state ^ (state >>> 15), 1 | state);
				x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
				return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
			};
			const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
			const legacy = (name: string): string =>
				name
					.normalize("NFKD")
					.replace(/[̀-ͯ]/g, "")
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "");
			const modern = (name: string): string =>
				legacy(
					name
						.normalize("NFKD")
						.replace(/[̀-ͯ]/g, "")
						.toLowerCase()
						.replace(
							/[øłæœßþ]/g,
							(c) => ({ ø: "o", ł: "l", æ: "ae", œ: "oe", ß: "ss", þ: "th" })[c] as string,
						),
				);
			const MBID_C = "45e00f0f-0000-4000-8000-000000000006";
			const MBID_D = "45e00f0f-0000-4000-8000-000000000007";
			const MBID_E = "45e00f0f-0000-4000-8000-000000000008";
			// One mbid, one person: homonyms differ by mbid, and a name may also come without any.
			const entities: { name: string; mbid?: string }[] = [
				{ name: "Mo" },
				{ name: "Mo", mbid: MBID_A },
				{ name: "MØ", mbid: MBID_B },
				{ name: "MØ" },
				{ name: "Lætitia Sadier" },
				{ name: "Laetitia Sadier", mbid: MBID_C },
				{ name: "Łona", mbid: MBID_D },
				{ name: "Lona" },
				{ name: "Zoë" },
				{ name: "Zoe", mbid: MBID_E },
			];
			let succeeded = 0;
			let refused = 0;
			for (let i = 0; i < 300; i++) {
				await rm(cacheDir, { recursive: true, force: true });
				await rm(redirectsPath, { force: true });
				await mkdir(join(cacheDir, "nodes"), { recursive: true });
				const nodes: Obj[] = [];
				const taken = new Set<string>();
				for (const e of entities) {
					if (rand() < 0.45) continue;
					const slug = `artist:${legacy(e.name)}`;
					if (taken.has(slug) || legacy(e.name) === "") continue;
					taken.add(slug);
					nodes.push(a(slug, e.name, e.mbid));
				}
				const works: Obj[] = [];
				for (const title of ["Song", "Fitna"]) {
					if (rand() < 0.5) continue;
					const e = pick(entities);
					works.push(
						a(`track:${legacy(title)}`, title, rand() < 0.4 ? MBID_A : undefined, {
							artists: credit(`artist:${legacy(e.name)}`, e.name, e.mbid ? { mbid: e.mbid } : {}),
						}),
					);
				}
				for (const n of nodes) {
					const refs: Obj[] = [];
					for (let k = Math.floor(rand() * 3); k > 0; k--) {
						const e = pick(entities);
						if (legacy(e.name) !== "")
							refs.push(
								ref(`artist:${legacy(e.name)}`, e.name, e.mbid && rand() < 0.6 ? { mbid: e.mbid } : {}),
							);
					}
					n.collaborators = refs;
					if (works.length > 0 && rand() < 0.5) {
						const w = pick(works);
						const hint = rand() < 0.5 ? pick(entities).name : undefined;
						n.notable_tracks = [
							ref(w.slug as string, w.name as string, {
								...(hint ? { artist: hint } : {}),
								...(rand() < 0.3 ? { mbid: MBID_B } : {}),
							}),
						];
					}
				}
				await seed([...nodes, ...works]);
				if (rand() < 0.5) {
					const table: Record<string, string> = {};
					for (let k = 1 + Math.floor(rand() * 2); k > 0; k--) {
						const from = `artist:${legacy(pick(entities).name)}`;
						const to = `artist:${modern(pick(entities).name)}`;
						const clash = from === to || taken.has(from) || from === "artist:" || to === "artist:";
						if (clash || to in table || Object.values(table).includes(from)) continue;
						table[from] = to;
					}
					await mkdir(dirname(redirectsPath), { recursive: true });
					await writeFile(redirectsPath, JSON.stringify({ source: "test", redirects: table }));
				}
				if (rand() < 0.15) {
					const e = pick(entities);
					const slug = `artist:${modern(e.name)}`;
					if (modern(e.name) !== "" && !taken.has(slug)) {
						await mkdir(dirname(nodePath(slug)), { recursive: true });
						await writeFile(nodePath(slug), "<<<<<<< conflict");
					}
				}
				const result = await applySafely();
				if (result.exitCode === 0) {
					succeeded++;
					const again = await run(true);
					expect(
						again.exitCode,
						`case ${i} second run ${JSON.stringify([again.manifest.errors, again.manifest.invariantViolations, again.manifest.conflicts])}`,
					).toBe(0);
					expect(again.manifest.written, `case ${i} second run`).toBe(0);
				} else {
					refused++;
				}
			}
			console.info(`property test: ${succeeded} applied, ${refused} refused, of 300`);
			expect(succeeded).toBeGreaterThan(30);
			expect(refused).toBeGreaterThan(5);
		});
	});

	describe("parseCliArgs", () => {
		it("defaults to the contract's manifest paths and a dry-run", () => {
			expect(parseCliArgs(["cache"])).toEqual({
				cacheDir: "cache",
				apply: false,
				manifestPath: DEFAULT_MANIFEST_PATH,
				artistManifestPath: "out/artist-identity.json",
			});
		});

		it("reads every flag and rejects anything ambiguous", () => {
			expect(
				parseCliArgs(["c", "--apply", "--manifest", "m", "--artist-manifest", "a", "--redirects", "r"]),
			).toEqual({
				cacheDir: "c",
				apply: true,
				manifestPath: "m",
				artistManifestPath: "a",
				redirectsPath: "r",
			});
			expect(parseCliArgs(["c", "--data-dir", "/d"])).toMatchObject({
				redirectsPath: "/d/slug-redirects.json",
			});
			expect(parseCliArgs(["c", "--data-dir", "/d", "--redirects", "r"])).toBeNull();
			expect(parseCliArgs(["c", "--allow-incomplete-table"])).toBeNull();
			expect(parseCliArgs([])).toBeNull();
			expect(parseCliArgs(["--apply"])).toBeNull();
			expect(parseCliArgs(["c", "--apply", "--apply"])).toBeNull();
			expect(parseCliArgs(["c", "--manifest"])).toBeNull();
			expect(parseCliArgs(["c", "--redirects", "--apply"])).toBeNull();
			expect(parseCliArgs(["c", "stray"])).toBeNull();
		});
	});
});
