import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canonicalScopedSlug,
	MIGRATION_NAME,
	parseCliArgs,
	pickBest,
	type RescopeManifest,
	runRescope,
} from "../scripts/migrations/2026-10-18-rescope-misdirected-artist-edges.js";
import { parseSlug } from "../src/slug.js";
import type { EdgeRef, NodePayload } from "../src/types.js";
import { artistNode, edge, projectNode, trackNode } from "./images/helpers.js";

// TRA-602: the rescope of artist edges that a GLOBAL redirect sends to a homonym's work. Nothing is mocked:
// the cache is real files in a temp dir, the schema, the credit rule (src/images/reciprocity.ts) and the
// read-side redirect resolution are the real ones. The slug flag is deliberately unset by default: the
// migration channel runs with ODYSSEY_SCOPED_RELEASE_SLUGS=0 (TRA-599 is open).

let root: string;
let cacheDir: string;
let dataDir: string;
let manifestPath: string;

beforeEach(async () => {
	vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "");
	root = await mkdtemp(join(tmpdir(), "rescope-"));
	cacheDir = join(root, "cache");
	dataDir = join(root, "data");
	manifestPath = join(root, "out", "rescope.json");
	await writeRedirects({});
	await mkdir(join(cacheDir, "nodes"), { recursive: true });
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

const pathOf = (dir: string, slug: string): string => {
	const { type, body } = parseSlug(slug);
	return join(dir, "nodes", type, `${body}.json`);
};

async function put(node: NodePayload | Record<string, unknown>, dir = cacheDir): Promise<void> {
	const path = pathOf(dir, node.slug as string);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(node));
}

const raw = (slug: string, dir = cacheDir): Promise<string> => readFile(pathOf(dir, slug), "utf8");
const read = async (slug: string, dir = cacheDir): Promise<Record<string, unknown>> =>
	JSON.parse(await raw(slug, dir)) as Record<string, unknown>;
const slugsOf = (node: Record<string, unknown>, field: string): string[] =>
	(node[field] as EdgeRef[]).map((e) => e.slug);

const manifestOf = async (path = manifestPath): Promise<RescopeManifest> =>
	JSON.parse(await readFile(path, "utf8")) as RescopeManifest;

/** The redirect tables of a run: a temp data dir (the channel's --data-dir). */
const writeRedirects = async (slugs: Record<string, string>, genres: Record<string, string> = {}) => {
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects: slugs }));
	await writeFile(join(dataDir, "genre-redirects.json"), JSON.stringify({ redirects: genres }));
};

const run = (apply = true, manifest = manifestPath) =>
	runRescope({ cacheDir, apply, manifestPath: manifest, dataDir });

/** A project credited to `artist`. */
const album = (slug: string, artist: string, artistName: string, extra: Record<string, unknown> = {}) =>
	projectNode(slug, slug, { artists: [edge("artist", artist, artistName)], ...extra });

describe("rewrite to the work scoped on the artist (TRA-602)", () => {
	it("target ABSENT and scoped on a homonym: Pink Floyd's Wish You Were Here is rewritten", async () => {
		const wish = edge("project", "wish-you-were-here", "Wish You Were Here", {
			mbid: "11111111-1111-4111-8111-111111111111",
			year: "1975",
			releaseType: "album",
		});
		const other = edge("project", "animals", "Animals");
		await put(artistNode("pink-floyd", "Pink Floyd", { discography: [wish, other] }));
		await writeRedirects({
			"project:wish-you-were-here": "project:wish-you-were-here--american-hot-wax",
		});

		const result = await run();

		expect(result.exitCode).toBe(0);
		const node = await read("artist:pink-floyd");
		expect(node.discography).toEqual([{ ...wish, slug: "project:wish-you-were-here--pink-floyd" }, other]);
		expect((await manifestOf()).rewritten).toEqual([
			{
				artist: "artist:pink-floyd",
				field: "discography",
				from: "project:wish-you-were-here",
				to: "project:wish-you-were-here--pink-floyd",
				reason: "absent-other-scope",
			},
		]);
	});

	it("target CACHED and credited to another artist: Moderat's II is rewritten, 2 Unlimited's too", async () => {
		await put(artistNode("moderat", "Moderat", { discography: [edge("project", "ii", "II")] }));
		await put(artistNode("2-unlimited", "2 Unlimited", { discography: [edge("project", "ii", "II")] }));
		await put(album("ii--boyz-ii-men", "boyz-ii-men", "Boyz II Men"));
		await writeRedirects({ "project:ii": "project:ii--boyz-ii-men" });

		await run();

		expect(slugsOf(await read("artist:moderat"), "discography")).toEqual(["project:ii--moderat"]);
		expect(slugsOf(await read("artist:2-unlimited"), "discography")).toEqual(["project:ii--2-unlimited"]);
		// The homonym's own work is not touched.
		expect(await read("project:ii--boyz-ii-men")).toMatchObject({ name: "ii--boyz-ii-men" });
		const m = await manifestOf();
		expect(m.rewritten.map((r) => r.reason)).toEqual(["cached-not-credited", "cached-not-credited"]);
		expect(m.summary).toMatchObject({ redirectedEdges: 2, rewritten: 2, credited: 0 });
	});

	it("rewrites notable_tracks too, with the type of the old slug", async () => {
		await put(
			artistNode("daft-punk", "Daft Punk", {
				notable_tracks: [edge("track", "around-the-world", "Around the World")],
			}),
		);
		await writeRedirects({
			"track:around-the-world": "track:around-the-world--stanley-black-and-his-orchestra",
		});

		await run();

		expect(slugsOf(await read("artist:daft-punk"), "notable_tracks")).toEqual([
			"track:around-the-world--daft-punk",
		]);
	});

	it("keeps the edge's name, mbid and every other key; changes nothing else in the node", async () => {
		const e = edge("project", "temps-mort", "Temps mort", {
			mbid: "22222222-2222-4222-8222-222222222222",
			year: "2002",
			releaseType: "album",
			artist: "Booba",
		});
		const node = artistNode("booba", "Booba", { discography: [e], editorial_bio: "Bio kept." });
		await put(node);
		await writeRedirects({ "project:temps-mort": "project:temps-mort--corbillard" });

		await run();

		const after = await read("artist:booba");
		expect((after.discography as EdgeRef[])[0]).toEqual({ ...e, slug: "project:temps-mort--booba" });
		expect({ ...after, discography: undefined }).toEqual({ ...node, discography: undefined });
	});

	it("a live bare node wins over the redirect (the reads do not redirect it): left alone", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "bare", "Bare")] }));
		await put(album("bare", "flash", "Flash"));
		await writeRedirects({ "project:bare": "project:bare--somebody" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:bare"]);
		expect((await manifestOf()).summary.redirectedEdges).toBe(0);
	});

	it("an edge whose slug is not a redirect key is not examined", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "plain", "Plain")] }));
		const before = await raw("artist:flash");

		const result = await run();

		expect(await raw("artist:flash")).toBe(before);
		expect(result.written).toEqual([]);
	});
});

describe("canonical scope, whatever the flag (TRA-599 is open)", () => {
	// "Roeyksopp" spelled with a slashed o: the flag decides whether the o-slash is dropped or transliterated.
	const SLASHED = "Røyksopp";
	const UMLAUT = "Röyksopp";

	for (const flag of ["", "1"]) {
		for (const [label, name] of [
			["umlaut", UMLAUT],
			["slashed o", SLASHED],
		] as const) {
			it(`flag ${flag === "" ? "unset" : "on"}, ${label}: the scope is the transliterated form`, async () => {
				vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", flag);
				await put(
					artistNode("royksopp", name, { discography: [edge("project", "melody-am", "Melody A.M.")] }),
				);
				await writeRedirects({ "project:melody-am": "project:melody-am--somebody-else" });

				await run();

				expect(slugsOf(await read("artist:royksopp"), "discography")).toEqual([
					"project:melody-a-m--royksopp",
				]);
			});
		}
	}

	it("a title with a transliterated letter gets its canonical form too, flag unset", () => {
		expect(canonicalScopedSlug("project", "Mø", "Artist")).toBe("project:mo--artist");
		expect(canonicalScopedSlug("project", "Title", SLASHED)).toBe("project:title--royksopp");
	});

	it("is null when no scoped slug exists (empty title, a name with no Latin letter)", () => {
		expect(canonicalScopedSlug("project", "", "Artist")).toBeNull();
		expect(canonicalScopedSlug("project", "Title", "坂本龍一")).toBeNull();
	});

	it("an artist with no scope body leaves the edge, reported unjudged (no-scoped-slug)", async () => {
		await put(
			artistNode("ryuichi-sakamoto", "坂本龍一", {
				discography: [edge("project", "async", "async")],
			}),
		);
		await writeRedirects({ "project:async": "project:async--somebody" });

		await run();

		expect(slugsOf(await read("artist:ryuichi-sakamoto"), "discography")).toEqual(["project:async"]);
		expect((await manifestOf()).unjudged).toMatchObject([{ reason: "no-scoped-slug" }]);
	});
});

describe("no false positive: the artist's own work, aliases, members, groups", () => {
	it("a redirect to a work that credits the artist is not rewritten", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		await put(album("ii--flash", "flash", "Flash"));
		await writeRedirects({ "project:ii": "project:ii--flash" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii"]);
		const m = await manifestOf();
		expect(m.rewritten).toEqual([]);
		expect(m.summary).toMatchObject({ redirectedEdges: 1, credited: 1 });
	});

	it("credit by mbid counts, when both sides have one (the rule of reciprocates)", async () => {
		const mbid = "33333333-3333-4333-8333-333333333333";
		await put(artistNode("flash", "Flash", { mbid, discography: [edge("project", "ii", "II")] }));
		await put(
			album("ii--flash", "other-slug", "Flash", {
				artists: [edge("artist", "other-slug", "Flash", { mbid })],
			}),
		);
		await writeRedirects({ "project:ii": "project:ii--flash" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii"]);
	});

	it("an absent target scoped on the artist itself is correct", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		await writeRedirects({ "project:ii": "project:ii--flash" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii"]);
		expect((await manifestOf()).summary.credited).toBe(1);
	});

	it("an ALIAS: Richie Hawtin's Spastik (Plastikman's) is not rewritten, absent target", async () => {
		await put(
			artistNode("richie-hawtin", "Richie Hawtin", {
				aliases: [edge("artist", "plastikman", "Plastikman")],
				notable_tracks: [edge("track", "spastik", "Spastik")],
			}),
		);
		await writeRedirects({ "track:spastik": "track:spastik--plastikman" });

		await run();

		expect(slugsOf(await read("artist:richie-hawtin"), "notable_tracks")).toEqual(["track:spastik"]);
		expect((await manifestOf()).skippedAliasOrMember).toEqual([
			{
				artist: "artist:richie-hawtin",
				field: "notable_tracks",
				from: "track:spastik",
				target: "track:spastik--plastikman",
				relative: "artist:plastikman",
				reason: "alias",
			},
		]);
	});

	it("an alias, cached target credited to the alias: not rewritten either", async () => {
		await put(
			artistNode("richie-hawtin", "Richie Hawtin", {
				aliases: [edge("artist", "plastikman", "Plastikman")],
				notable_tracks: [edge("track", "spastik", "Spastik")],
			}),
		);
		await put(
			trackNode("spastik--plastikman", "Spastik", { artists: [edge("artist", "plastikman", "Plastikman")] }),
		);
		await writeRedirects({ "track:spastik": "track:spastik--plastikman" });

		await run();

		expect(slugsOf(await read("artist:richie-hawtin"), "notable_tracks")).toEqual(["track:spastik"]);
		expect((await manifestOf()).skippedAliasOrMember).toHaveLength(1);
	});

	it("a GROUP that lists the artist in its members: Sean Booth's Amber (Autechre's) is not rewritten", async () => {
		await put(artistNode("sean-booth", "Sean Booth", { discography: [edge("project", "amber", "Amber")] }));
		await put(
			artistNode("autechre", "Autechre", {
				members: [edge("artist", "sean-booth", "Sean Booth"), edge("artist", "rob-brown", "Rob Brown")],
			}),
		);
		await put(album("amber--autechre", "autechre", "Autechre"));
		await writeRedirects({ "project:amber": "project:amber--autechre" });

		await run();

		expect(slugsOf(await read("artist:sean-booth"), "discography")).toEqual(["project:amber"]);
		expect((await manifestOf()).skippedAliasOrMember).toMatchObject([
			{ relative: "artist:autechre", reason: "group" },
		]);
	});

	it("a group whose members are in `members`: Autechre's own edge to a member's work is not rewritten", async () => {
		await put(
			artistNode("autechre", "Autechre", {
				members: [edge("artist", "sean-booth", "Sean Booth")],
				discography: [edge("project", "solo", "Solo")],
			}),
		);
		await put(artistNode("sean-booth", "Sean Booth"));
		await writeRedirects({ "project:solo": "project:solo--sean-booth" });

		await run();

		expect(slugsOf(await read("artist:autechre"), "discography")).toEqual(["project:solo"]);
		expect((await manifestOf()).skippedAliasOrMember).toMatchObject([{ reason: "member" }]);
	});

	it("a relative is matched by mbid when slugs differ and both sides have one", async () => {
		const mbid = "44444444-4444-4444-8444-444444444444";
		await put(
			artistNode("richie-hawtin", "Richie Hawtin", {
				aliases: [edge("artist", "plastikman-old-slug", "Plastikman", { mbid })],
				discography: [edge("project", "closer", "Closer")],
			}),
		);
		await put(
			album("closer--plastikman", "plastikman", "Plastikman", {
				artists: [edge("artist", "plastikman", "Plastikman", { mbid })],
			}),
		);
		await writeRedirects({ "project:closer": "project:closer--plastikman" });

		await run();

		expect(slugsOf(await read("artist:richie-hawtin"), "discography")).toEqual(["project:closer"]);
		expect((await manifestOf()).skippedAliasOrMember).toHaveLength(1);
	});

	it("a stranger who merely shares a name part is rewritten (no loose matching)", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		await put(artistNode("flash-gordon", "Flash Gordon"));
		await writeRedirects({ "project:ii": "project:ii--flash-gordon" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii--flash"]);
	});

	it("a cached work that credits a homonym with the same name is NOT taken for ours (scope is a fallback)", async () => {
		// Two artists called Flash: the work's scope `--flash` matches ours, but it credits the other one.
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		await put(artistNode("flash-2", "Flash"));
		await put(album("ii--flash", "flash-2", "Flash"));
		await writeRedirects({ "project:ii": "project:ii--flash" });

		const result = await run();

		// Its scoped version is that very node, which credits the other Flash: a collision, not a silent pass.
		expect(result.exitCode).toBe(1);
		expect((await manifestOf()).collisions).toMatchObject([
			{ from: "project:ii", to: "project:ii--flash", reason: "credits-another-artist" },
		]);
		expect((await manifestOf()).summary.credited).toBe(0);
	});

	it("a cached work that credits nobody falls back to its scope", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		await put(projectNode("ii--flash", "II", { artists: [] }));
		await writeRedirects({ "project:ii": "project:ii--flash" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii"]);
		expect((await manifestOf()).summary.credited).toBe(1);
	});
});

describe("absent and unscoped: not judged", () => {
	it("an absent target with no scope is neither rewritten nor ignored: it is counted apart", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "old", "Old")] }));
		await writeRedirects({ "project:old": "project:old-renamed" });
		const before = await raw("artist:flash");

		const result = await run();

		expect(await raw("artist:flash")).toBe(before);
		const m = await manifestOf();
		expect(m.unjudged).toEqual([
			{
				artist: "artist:flash",
				field: "discography",
				from: "project:old",
				target: "project:old-renamed",
				reason: "absent-unscoped-target",
			},
		]);
		expect(m.summary).toMatchObject({ unjudged: 1, rewritten: 0 });
		expect(result.exitCode).toBe(0);
	});

	it("a cached target that cannot be read is unjudged too, never rewritten", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		const broken = pathOf(cacheDir, "project:ii--boyz-ii-men");
		await mkdir(dirname(broken), { recursive: true });
		await writeFile(broken, "{ not json");
		await writeRedirects({ "project:ii": "project:ii--boyz-ii-men" });

		const result = await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii"]);
		expect((await manifestOf()).unjudged).toMatchObject([{ reason: "unreadable-target" }]);
		expect(result.exitCode).toBe(0);
	});
});

describe("the artist's picks move with their list entry", () => {
	it("landmark_project and reference_track on the old slug follow the rewrite", async () => {
		const album1 = edge("project", "wish-you-were-here", "Wish You Were Here");
		const track1 = edge("track", "time", "Time");
		await put(
			artistNode("pink-floyd", "Pink Floyd", {
				discography: [album1],
				notable_tracks: [track1],
				landmark_project: album1,
				reference_track: track1,
			}),
		);
		await writeRedirects({
			"project:wish-you-were-here": "project:wish-you-were-here--american-hot-wax",
			"track:time": "track:time--the-time",
		});

		await run();

		const node = await read("artist:pink-floyd");
		expect(node.landmark_project).toEqual({ ...album1, slug: "project:wish-you-were-here--pink-floyd" });
		expect(node.reference_track).toEqual({ ...track1, slug: "track:time--pink-floyd" });
		// Still members of their lists, compared by slug (enforceArtistChoices).
		expect(slugsOf(node, "discography")).toContain((node.landmark_project as EdgeRef).slug);
		expect(slugsOf(node, "notable_tracks")).toContain((node.reference_track as EdgeRef).slug);
		expect((await manifestOf()).choicesMoved).toEqual([
			{
				artist: "artist:pink-floyd",
				field: "landmark_project",
				from: "project:wish-you-were-here",
				to: "project:wish-you-were-here--pink-floyd",
			},
			{
				artist: "artist:pink-floyd",
				field: "reference_track",
				from: "track:time",
				to: "track:time--pink-floyd",
			},
		]);
	});

	it("a pick on another slug is left alone", async () => {
		const other = edge("project", "animals", "Animals");
		await put(
			artistNode("pink-floyd", "Pink Floyd", {
				discography: [edge("project", "wish-you-were-here", "Wish You Were Here"), other],
				landmark_project: other,
			}),
		);
		await writeRedirects({ "project:wish-you-were-here": "project:wish-you-were-here--american-hot-wax" });

		await run();

		expect((await read("artist:pink-floyd")).landmark_project).toEqual(other);
		expect((await manifestOf()).choicesMoved).toEqual([]);
	});

	it("a pick on an alias's work (not rewritten) stays where it is", async () => {
		const spastik = edge("track", "spastik", "Spastik");
		await put(
			artistNode("richie-hawtin", "Richie Hawtin", {
				aliases: [edge("artist", "plastikman", "Plastikman")],
				notable_tracks: [spastik],
				reference_track: spastik,
			}),
		);
		await writeRedirects({ "track:spastik": "track:spastik--plastikman" });

		await run();

		expect((await read("artist:richie-hawtin")).reference_track).toEqual(spastik);
	});
});

describe("entries that converge on one scoped slug: only the best is kept (deduplicated)", () => {
	const REDIRECT = { "project:human-after-all": "project:human-after-all--twin-atlantic" };

	it("Daft Punk: the album wins over the two singles, which are listed in `deduplicated`", async () => {
		const medley = edge("project", "human-after-all", "Human After All (Medley)", {
			mbid: "00eb1335-7ff0-4dd6-8cee-51f395b06fd3",
			year: "2012",
			releaseType: "single",
		});
		const single = edge("project", "human-after-all", "Human After All", {
			mbid: "14d335b6-71e9-43a3-9ad8-cf8367990c23",
			year: "2005",
			releaseType: "single",
		});
		const albumEdge = edge("project", "human-after-all", "Human After All", {
			mbid: "f9e8042a-674e-3f01-80ec-7f0ab1c537df",
			year: "2005",
			releaseType: "album",
		});
		await put(artistNode("daft-punk", "Daft Punk", { discography: [medley, single, albumEdge] }));
		await writeRedirects(REDIRECT);

		await run();

		// The "(Medley)" title is another work (another scoped slug): it is rewritten, not merged. The two
		// editions of the same title converge, and the album stays where it was in the list.
		expect((await read("artist:daft-punk")).discography).toEqual([
			{ ...medley, slug: "project:human-after-all-medley--daft-punk" },
			{ ...albumEdge, slug: "project:human-after-all--daft-punk" },
		]);
		const m = await manifestOf();
		expect(m.deduplicated).toEqual([
			{
				artist: "artist:daft-punk",
				field: "discography",
				from: "project:human-after-all",
				to: "project:human-after-all--daft-punk",
				removed: {
					slug: "project:human-after-all",
					name: "Human After All",
					mbid: "14d335b6-71e9-43a3-9ad8-cf8367990c23",
					releaseType: "single",
					year: "2005",
				},
				kept: {
					slug: "project:human-after-all",
					name: "Human After All",
					mbid: "f9e8042a-674e-3f01-80ec-7f0ab1c537df",
					releaseType: "album",
					year: "2005",
				},
			},
		]);
		expect(m.rewritten.map((r) => r.to)).toEqual([
			"project:human-after-all-medley--daft-punk",
			"project:human-after-all--daft-punk",
		]);
		expect(m.summary).toMatchObject({ rewritten: 2, deduplicated: 1 });
	});

	it("a pick on the bare slug follows the slug, whichever entry is kept", async () => {
		const single = edge("project", "human-after-all", "Human After All", { releaseType: "single" });
		const albumEdge = edge("project", "human-after-all", "Human After All", { releaseType: "album" });
		await put(
			artistNode("daft-punk", "Daft Punk", { discography: [single, albumEdge], landmark_project: single }),
		);
		await writeRedirects(REDIRECT);

		await run();

		const node = await read("artist:daft-punk");
		expect(node.landmark_project).toEqual({ ...single, slug: "project:human-after-all--daft-punk" });
		expect(slugsOf(node, "discography")).toContain((node.landmark_project as EdgeRef).slug);
		expect((await manifestOf()).choicesMoved).toHaveLength(1);
	});

	it("the pick follows the title when one bare slug served several works", async () => {
		const medley = edge("project", "human-after-all", "Human After All (Medley)");
		const plain = edge("project", "human-after-all", "Human After All");
		await put(
			artistNode("daft-punk", "Daft Punk", { discography: [medley, plain], landmark_project: medley }),
		);
		await writeRedirects(REDIRECT);

		await run();

		expect(((await read("artist:daft-punk")).landmark_project as EdgeRef).slug).toBe(
			"project:human-after-all-medley--daft-punk",
		);
	});

	it("the list already holds the scoped slug: the best of the two is kept, the other listed", async () => {
		// The existing scoped entry is the album: it wins over the misdirected single, which is dropped.
		const scoped = edge("project", "wish-you-were-here--pink-floyd", "Wish You Were Here", {
			releaseType: "album",
		});
		const bare = edge("project", "wish-you-were-here", "Wish You Were Here", { releaseType: "single" });
		const other = edge("project", "animals", "Animals");
		await put(artistNode("pink-floyd", "Pink Floyd", { discography: [bare, other, scoped] }));
		await writeRedirects({ "project:wish-you-were-here": "project:wish-you-were-here--american-hot-wax" });

		await run();

		expect((await read("artist:pink-floyd")).discography).toEqual([other, scoped]);
		const m = await manifestOf();
		expect(m.rewritten).toEqual([]);
		expect(m.deduplicated).toMatchObject([
			{ from: "project:wish-you-were-here", to: "project:wish-you-were-here--pink-floyd" },
		]);
	});

	it("an equal pair keeps the first of the list, even when it is the one being rewritten", async () => {
		const scoped = edge("project", "wish-you-were-here--pink-floyd", "Wish You Were Here");
		const bare = edge("project", "wish-you-were-here", "Wish You Were Here");
		await put(artistNode("pink-floyd", "Pink Floyd", { discography: [bare, scoped] }));
		await writeRedirects({ "project:wish-you-were-here": "project:wish-you-were-here--american-hot-wax" });

		await run();

		expect(slugsOf(await read("artist:pink-floyd"), "discography")).toEqual([
			"project:wish-you-were-here--pink-floyd",
		]);
		expect((await manifestOf()).rewritten).toHaveLength(1);
	});

	it("a list that is not touched keeps its own duplicates (nothing to rescope there)", async () => {
		const a = edge("project", "plain", "Plain");
		await put(artistNode("flash", "Flash", { discography: [a, a] }));
		await writeRedirects({ "project:other": "project:other--someone" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:plain", "project:plain"]);
	});

	describe("pickBest", () => {
		const slot = (extra: Record<string, unknown>) => ({ edge: edge("project", "x", "X", extra) });

		it("ranks album, then ep, then single, then no type or another type", () => {
			const [none, single, ep, albumSlot, live] = [
				slot({}),
				slot({ releaseType: "single" }),
				slot({ releaseType: "ep" }),
				slot({ releaseType: "album" }),
				slot({ releaseType: "live" }),
			];
			expect(pickBest([none, single, ep, albumSlot, live])).toBe(albumSlot);
			expect(pickBest([none, single, ep, live])).toBe(ep);
			expect(pickBest([none, live, single])).toBe(single);
			expect(pickBest([live, none])).toBe(live);
		});

		it("on a tie of type, the oldest year wins; no year comes last; then the list order", () => {
			const [y2009, y2001, noYear, y2001bis] = [
				slot({ releaseType: "album", year: "2009" }),
				slot({ releaseType: "album", year: "2001" }),
				slot({ releaseType: "album" }),
				slot({ releaseType: "album", year: "2001" }),
			];
			expect(pickBest([y2009, y2001, noYear])).toBe(y2001);
			expect(pickBest([noYear, y2009])).toBe(y2009);
			expect(pickBest([y2001, y2001bis])).toBe(y2001);
			expect(pickBest([y2001bis, y2001])).toBe(y2001bis);
		});

		it("a better type beats an older year", () => {
			const [oldSingle, newAlbum] = [
				slot({ releaseType: "single", year: "1990" }),
				slot({ releaseType: "album", year: "2020" }),
			];
			expect(pickBest([oldSingle, newAlbum])).toBe(newAlbum);
		});
	});
});

describe("a group or leader the cache does not link, named in the article (projects only)", () => {
	const article = (text: string) => ({ editorial_article: text.repeat(3) });

	it("Mulligan: Birth of the Cool by Miles Davis is not rewritten, reason named-in-article", async () => {
		await put(
			artistNode("gerry-mulligan", "Gerry Mulligan", {
				...article("Gerry Mulligan played on the Birth of the Cool sessions led by Miles Davis. "),
				discography: [edge("project", "birth-of-the-cool", "Birth of the Cool")],
			}),
		);
		await put(album("birth-of-the-cool--miles-davis", "miles-davis", "Miles Davis"));
		await writeRedirects({ "project:birth-of-the-cool": "project:birth-of-the-cool--miles-davis" });

		await run();

		expect(slugsOf(await read("artist:gerry-mulligan"), "discography")).toEqual([
			"project:birth-of-the-cool",
		]);
		const m = await manifestOf();
		expect(m.rewritten).toEqual([]);
		expect(m.skippedAliasOrMember).toEqual([
			{
				artist: "artist:gerry-mulligan",
				field: "discography",
				from: "project:birth-of-the-cool",
				target: "project:birth-of-the-cool--miles-davis",
				relative: "artist:miles-davis",
				reason: "named-in-article",
			},
		]);
	});

	it("Booth: Amber by Autechre, which is absent from the cache as an artist, is not rewritten", async () => {
		await put(
			artistNode("sean-booth", "Sean Booth", {
				...article("Sean Booth is best known as one-half of the IDM duo Autechre. "),
				discography: [edge("project", "amber", "Amber")],
			}),
		);
		await put(album("amber--autechre", "autechre", "Autechre"));
		await writeRedirects({ "project:amber": "project:amber--autechre" });

		await run();

		expect(slugsOf(await read("artist:sean-booth"), "discography")).toEqual(["project:amber"]);
		expect((await manifestOf()).skippedAliasOrMember).toMatchObject([
			{ relative: "artist:autechre", reason: "named-in-article" },
		]);
	});

	it("compares like TRA-601: accents, case and punctuation do not matter", async () => {
		await put(
			artistNode("flash", "Flash", {
				...article("Flash, the long-time sideman of BJÖRK (and of nobody else). "),
				discography: [edge("project", "debut", "Debut")],
			}),
		);
		await put(album("debut--bjork", "bjork", "Björk"));
		await writeRedirects({ "project:debut": "project:debut--bjork" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:debut"]);
	});

	it("a TRACK in the same situation is rewritten: a cover is another recording", async () => {
		await put(
			artistNode("the-byrds", "The Byrds", {
				...article("The Byrds covered Bob Dylan on their first album. "),
				notable_tracks: [edge("track", "mr-tambourine-man", "Mr. Tambourine Man")],
			}),
		);
		await put(
			trackNode("mr-tambourine-man--bob-dylan", "Mr. Tambourine Man", {
				artists: [edge("artist", "bob-dylan", "Bob Dylan")],
			}),
		);
		await writeRedirects({ "track:mr-tambourine-man": "track:mr-tambourine-man--bob-dylan" });

		await run();

		expect(slugsOf(await read("artist:the-byrds"), "notable_tracks")).toEqual([
			"track:mr-tambourine-man--the-byrds",
		]);
		expect((await manifestOf()).skippedAliasOrMember).toEqual([]);
	});

	it("a name the article does not cite is rewritten", async () => {
		await put(
			artistNode("moderat", "Moderat", {
				...article("Moderat is a Berlin trio of electronic musicians. "),
				discography: [edge("project", "ii", "II")],
			}),
		);
		await put(album("ii--boyz-ii-men", "boyz-ii-men", "Boyz II Men"));
		await writeRedirects({ "project:ii": "project:ii--boyz-ii-men" });

		await run();

		expect(slugsOf(await read("artist:moderat"), "discography")).toEqual(["project:ii--moderat"]);
	});

	it("the name must be a whole expression, not a piece of a longer word", async () => {
		await put(
			artistNode("flash", "Flash", {
				...article("Flash grew up in Cherokee County. "),
				discography: [edge("project", "debut", "Debut")],
			}),
		);
		await put(album("debut--cher", "cher", "Cher"));
		await writeRedirects({ "project:debut": "project:debut--cher" });

		await run();

		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:debut--flash"]);
	});

	it("only a CACHED work that credits somebody: an absent target (Incunabula) stays rewritten", async () => {
		await put(
			artistNode("sean-booth", "Sean Booth", {
				...article("Sean Booth is one-half of Autechre and of Method of Defiance. "),
				discography: [edge("project", "incunabula", "Incunabula")],
			}),
		);
		await writeRedirects({ "project:incunabula": "project:incunabula--method-of-defiance" });

		await run();

		expect(slugsOf(await read("artist:sean-booth"), "discography")).toEqual([
			"project:incunabula--sean-booth",
		]);
	});

	it("a cached project that credits nobody is not told by the article either", async () => {
		await put(
			artistNode("sean-booth", "Sean Booth", {
				...article("Sean Booth is one-half of Autechre and of Method of Defiance. "),
				discography: [edge("project", "incunabula", "Incunabula")],
			}),
		);
		await put(projectNode("incunabula--method-of-defiance", "Incunabula", { artists: [] }));
		await writeRedirects({ "project:incunabula": "project:incunabula--method-of-defiance" });

		await run();

		expect(slugsOf(await read("artist:sean-booth"), "discography")).toEqual([
			"project:incunabula--sean-booth",
		]);
	});
});

describe("collision: the scoped slug is somebody else's node", () => {
	it("refuses the run and writes nothing, not even for the other artists", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		// An innocent artist with a fixable edge: it must not be written either.
		await put(artistNode("pink-floyd", "Pink Floyd", { discography: [edge("project", "wish", "Wish")] }));
		await put(album("ii--flash", "somebody-else", "Somebody Else"));
		await put(album("ii--boyz-ii-men", "boyz-ii-men", "Boyz II Men"));
		await writeRedirects({ "project:ii": "project:ii--boyz-ii-men", "project:wish": "project:wish--other" });
		const before = { flash: await raw("artist:flash"), floyd: await raw("artist:pink-floyd") };

		const result = await run(true);

		expect(result.exitCode).toBe(1);
		expect(result.written).toEqual([]);
		expect(await raw("artist:flash")).toBe(before.flash);
		expect(await raw("artist:pink-floyd")).toBe(before.floyd);
		expect((await manifestOf()).collisions).toEqual([
			{
				artist: "artist:flash",
				field: "discography",
				from: "project:ii",
				to: "project:ii--flash",
				reason: "credits-another-artist",
			},
		]);
	});

	it("the scoped slug exists and credits the artist: it is taken", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		await put(album("ii--flash", "flash", "Flash"));
		await put(album("ii--boyz-ii-men", "boyz-ii-men", "Boyz II Men"));
		await writeRedirects({ "project:ii": "project:ii--boyz-ii-men" });

		const result = await run();

		expect(result.exitCode).toBe(0);
		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii--flash"]);
		expect((await manifestOf()).collisions).toEqual([]);
	});

	it("a scoped node that cannot be read is a collision too", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		const broken = pathOf(cacheDir, "project:ii--flash");
		await mkdir(dirname(broken), { recursive: true });
		await writeFile(broken, "{ not json");
		await put(album("ii--boyz-ii-men", "boyz-ii-men", "Boyz II Men"));
		await writeRedirects({ "project:ii": "project:ii--boyz-ii-men" });

		const result = await run();

		expect(result.exitCode).toBe(1);
		expect((await manifestOf()).collisions).toMatchObject([{ reason: "unreadable" }]);
		expect(slugsOf(await read("artist:flash"), "discography")).toEqual(["project:ii"]);
	});
});

describe("a failed artist refuses the run too", () => {
	it("an artist the schema rejects: exit 1, listed in failed, nothing written for anybody", async () => {
		await put(artistNode("moderat", "Moderat", { discography: [edge("project", "ii", "II")] }));
		// Not a valid node (no bio): it cannot be rewritten safely.
		await put({
			...artistNode("broken", "Broken", { discography: [edge("project", "ii", "II")] }),
			editorial_bio: 42,
		});
		await put(album("ii--boyz-ii-men", "boyz-ii-men", "Boyz II Men"));
		await writeRedirects({ "project:ii": "project:ii--boyz-ii-men" });
		const before = await raw("artist:moderat");

		const result = await run();

		expect(result.exitCode).toBe(1);
		expect(result.written).toEqual([]);
		expect(await raw("artist:moderat")).toBe(before);
		const m = await manifestOf();
		expect(m.failed).toMatchObject([{ slug: "artist:broken" }]);
		// Counters add up: the failed artist contributes nothing to them.
		expect(m.summary).toMatchObject({ redirectedEdges: 1, rewritten: 1 });
	});
});

describe("dry-run, idempotence, determinism", () => {
	async function fixture() {
		await put(
			artistNode("pink-floyd", "Pink Floyd", {
				discography: [edge("project", "wish-you-were-here", "Wish You Were Here")],
				landmark_project: edge("project", "wish-you-were-here", "Wish You Were Here"),
			}),
		);
		await put(artistNode("moderat", "Moderat", { discography: [edge("project", "ii", "II")] }));
		await put(
			artistNode("richie-hawtin", "Richie Hawtin", {
				aliases: [edge("artist", "plastikman", "Plastikman")],
				notable_tracks: [edge("track", "spastik", "Spastik")],
			}),
		);
		await put(album("ii--boyz-ii-men", "boyz-ii-men", "Boyz II Men"));
		await writeRedirects({
			"project:wish-you-were-here": "project:wish-you-were-here--american-hot-wax",
			"project:ii": "project:ii--boyz-ii-men",
			"track:spastik": "track:spastik--plastikman",
		});
	}

	const tree = async () => ({
		floyd: await raw("artist:pink-floyd"),
		moderat: await raw("artist:moderat"),
		hawtin: await raw("artist:richie-hawtin"),
		ii: await raw("project:ii--boyz-ii-men"),
	});

	it("a dry-run writes no node file, and its manifest equals the apply's byte for byte", async () => {
		await fixture();
		const before = await tree();

		const dry = await run(false, join(root, "out", "dry.json"));
		expect(dry.written).toEqual([]);
		expect(await tree()).toEqual(before);

		const applied = await run(true, join(root, "out", "apply.json"));
		expect(applied.written).toHaveLength(2);
		expect(await tree()).not.toEqual(before);
		expect(await readFile(join(root, "out", "apply.json"), "utf8")).toBe(
			await readFile(join(root, "out", "dry.json"), "utf8"),
		);
	});

	it("a second apply changes nothing and rewrites nothing", async () => {
		await fixture();
		await run(true);
		const once = await tree();

		const again = await run(true, join(root, "out", "again.json"));

		expect(again.written).toEqual([]);
		expect(await tree()).toEqual(once);
		expect((await manifestOf(join(root, "out", "again.json"))).rewritten).toEqual([]);
		expect(again.exitCode).toBe(0);
	});

	it("the manifest carries the channel's constants and is sorted, with no timestamp", async () => {
		await fixture();
		await run(true);

		const m = await manifestOf();
		expect(m).toMatchObject({ migration: MIGRATION_NAME, removed: [], renamed: {}, redirects: {} });
		expect(m.rewritten.map((r) => r.artist)).toEqual(["artist:moderat", "artist:pink-floyd"]);
		expect(m.summary).toEqual({
			artists: 3,
			redirectedEdges: 3,
			credited: 0,
			rewritten: 2,
			deduplicated: 0,
			skippedAliasOrMember: 1,
			unjudged: 0,
			collisions: 0,
			choicesMoved: 1,
		});
		expect(JSON.stringify(m)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
	});

	it("the schema's output is what is written: the file is a valid node, nothing stripped", async () => {
		await fixture();
		const result = await run(true);
		expect(result.exitCode).toBe(0);
		const floyd = await read("artist:pink-floyd");
		expect(floyd.editorial_bio).toBe("A short bio.");
		expect(floyd.similar_artists).toEqual([]);
	});
});

describe("redirect tables and arguments", () => {
	it("refuses the run, before any write, when --data-dir has no slug table", async () => {
		await put(artistNode("flash", "Flash", { discography: [edge("project", "ii", "II")] }));
		await rm(join(dataDir, "slug-redirects.json"));

		await expect(run()).rejects.toThrow(/redirect table not found/);
	});

	it("refuses the run when a table is invalid", async () => {
		await put(artistNode("flash", "Flash"));
		await writeFile(join(dataDir, "slug-redirects.json"), "{ not json");

		await expect(run()).rejects.toThrow();
	});

	it("parseCliArgs accepts the channel's flags and rejects the rest", () => {
		expect(parseCliArgs(["c", "--apply", "--manifest", "m.json", "--data-dir", "d"])).toEqual({
			cacheDir: "c",
			apply: true,
			manifestPath: "m.json",
			dataDir: "d",
		});
		expect(parseCliArgs(["c"])).toMatchObject({ apply: false, dataDir: undefined });
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["c", "--apply", "--apply"])).toBeNull();
		expect(parseCliArgs(["c", "--data-dir"])).toBeNull();
		expect(parseCliArgs(["c", "--bogus"])).toBeNull();
	});
});
