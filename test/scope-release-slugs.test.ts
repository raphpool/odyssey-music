import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	identityDisagreement,
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
		expect(manifest.detached).toHaveLength(1);
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

		it("keeps both edges and reports a conflict when a rename makes two mbids collide", async () => {
			await seed([
				node("project:ep", "EP", { artists: credit("artist:a", "A") }),
				node("artist:a", "A", {
					discography: [
						ref("project:ep", "EP", { mbid: MBID_A }),
						ref("project:ep--a", "EP", { mbid: MBID_B }),
					],
				}),
			]);
			const { manifest, exitCode } = await run(true);
			expect(exitCode).toBe(0);
			expect(manifest.folded).toEqual([]);
			expect(manifest.conflicts).toMatchObject([
				{ kind: "edge-mbid", slugs: ["artist:a.discography", "project:ep--a"] },
			]);
			expect(((await read("artist:a")).discography as Obj[]).map((e) => e.mbid)).toEqual([MBID_A, MBID_B]);
		});

		it("folds a collision the run created into the most informative edge, and records it", async () => {
			await seed([
				node("project:ep", "EP", { artists: credit("artist:a", "A") }),
				node("artist:a", "A", {
					discography: [
						ref("project:ep", "EP", { mbid: MBID_A }),
						ref("project:ep--a", "EP", { year: "2020", releaseType: "ep" }),
						ref("project:other", "Other"),
					],
				}),
			]);
			const { manifest } = await run(true);
			const folded = ((await read("artist:a")).discography as Obj[]).map((e) => e.slug);
			expect(folded).toEqual(["project:ep--a", "project:other"]);
			expect(((await read("artist:a")).discography as Obj[])[0]).toMatchObject({
				mbid: MBID_A,
				year: "2020",
				releaseType: "ep",
			});
			expect(manifest.folded).toHaveLength(1);
			expect(manifest.folded[0]).toMatchObject({ node: "artist:a", field: "discography" });
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
				expect(retry.exitCode, `crash at write ${crashAt}`).toBe(0);
				expect(await snapshot(), `crash at write ${crashAt}`).toEqual(expected);
			}
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
