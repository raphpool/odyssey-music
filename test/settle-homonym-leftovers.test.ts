import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFix } from "../scripts/migrations/2026-10-20-fix-homonym-work-identity.js";
import {
	CANONICAL_TARGETS,
	FORCED,
	MIGRATION_NAME,
} from "../scripts/migrations/2026-10-24-settle-homonym-leftovers.js";

// TRA-610 (PR 2): the closed-list migration, on a temp cache shaped like the prod nodes of the 2026-10-24 export
// (data.json). No MusicBrainz: fetch is a trap that fails the test if anything asks.

type Obj = Record<string, unknown>;

const article = "A real long article about the test node. ".repeat(4);
const DAFT = "11111111-1111-4111-8111-111111111111";
const STANLEY = "981aa60f-7cc0-4b0a-abab-808107deeac9";

const edge = (slug: string, name: string, extra: Obj = {}): Obj => ({
	slug,
	type: slug.slice(0, slug.indexOf(":")),
	name,
	...extra,
});

const artistNode = (slug: string, name: string, extra: Obj = {}): Obj => ({
	type: "artist",
	slug,
	name,
	editorial_bio: "A test artist bio.",
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
	...extra,
});

const workNode = (type: "project" | "track", slug: string, name: string, extra: Obj = {}): Obj => ({
	type,
	slug,
	name,
	...(type === "project" ? { editorial_pitch: "A pitch." } : { editorial_teaser: "A teaser." }),
	editorial_article: article,
	citations: [{ url: "https://example.com/w", title: "W" }],
	materialized_at: "2026-05-13T13:51:00.910Z",
	artists: [],
	genres: [],
	producers: [],
	...(type === "project"
		? { tracklist: [], related_projects: [] }
		: { samples: [], sampled_by: [], remixed_by: [] }),
	...extra,
});

const labelNode = (slug: string, name: string, extra: Obj = {}): Obj => ({
	type: "label",
	slug,
	name,
	editorial_description: "A label.",
	editorial_article: article,
	citations: [{ url: "https://example.com/l", title: "L" }],
	materialized_at: "2026-10-01T00:00:00.000Z",
	genres: [],
	roster: [],
	notable_releases: [],
	...extra,
});

let root: string;
let dataDir: string;
let manifestPath: string;
const cacheDir = () => join(root, "cache");
const nodePath = (slug: string) => {
	const i = slug.indexOf(":");
	return join(cacheDir(), "nodes", slug.slice(0, i), `${slug.slice(i + 1)}.json`);
};
const exists = (slug: string) =>
	stat(nodePath(slug)).then(
		() => true,
		() => false,
	);
const seed = async (...nodes: Obj[]) => {
	for (const node of nodes) {
		const slug = String(node.slug);
		await mkdir(join(nodePath(slug), ".."), { recursive: true });
		await writeFile(nodePath(slug), `${JSON.stringify(node, null, 2)}\n`);
	}
};
const read = async (slug: string): Promise<Obj> => JSON.parse(await readFile(nodePath(slug), "utf8")) as Obj;
const slugsOf = (value: unknown): string[] => (value as Obj[]).map((e) => String(e.slug));
const writeRedirects = (redirects: Record<string, string>) =>
	writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects }));
const readRedirects = async (): Promise<Record<string, string>> =>
	(
		JSON.parse(await readFile(join(dataDir, "slug-redirects.json"), "utf8")) as {
			redirects: Record<string, string>;
		}
	).redirects;
const run = (apply: boolean) =>
	runFix({
		cacheDir: cacheDir(),
		apply,
		manifestPath,
		dataDir,
		forced: FORCED,
		canonicalTargets: CANONICAL_TARGETS,
		onlyForced: true,
		migrationName: MIGRATION_NAME,
	});

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "settle-homonym-"));
	manifestPath = join(root, "out", "settle.json");
	dataDir = join(root, "data");
	await mkdir(join(cacheDir(), "nodes"), { recursive: true });
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "genre-redirects.json"), JSON.stringify({ redirects: {} }));
	await writeRedirects({});
	// The migration is offline: anything that reaches MusicBrainz is a failure.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("the closed-list migration must not call the network");
		}),
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

const ATW = "track:around-the-world--stanley-black-and-his-orchestra";
const ATW_RIGHT = "track:around-the-world--daft-punk";

/** Around the World as prod holds it: the stripped duplicate of Daft Punk's own node. */
async function seedAroundTheWorld() {
	await seed(
		workNode("track", ATW, "Around the World", {
			editorial_article: `Released in April 1997, Around the World is a single by Daft Punk. ${article}`,
			duration: "2:54",
			cover_url:
				"https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/48/3c/c0/x/0822231913023.png/1500x1500bb.jpg",
			genres: [edge("genre:disco", "Disco")],
			producers: [edge("artist:daft-punk", "Daft Punk")],
			personnel: [
				edge("artist:stanley-black", "Stanley Black", { mbid: "c1632a1f-2c7c-4da4-a4f6-ba05d9690055" }),
				edge("artist:stanley-black-and-his-orchestra", "Stanley Black & His Orchestra", { mbid: STANLEY }),
			],
		}),
		workNode("track", ATW_RIGHT, "Around the World", {
			mbid: "22222222-2222-4222-8222-222222222222",
			duration: "7:09",
			artists: [edge("artist:daft-punk", "Daft Punk", { mbid: DAFT })],
			project: edge("project:homework", "Homework"),
			label: edge("label:virgin", "Virgin"),
			producers: [edge("artist:daft-punk", "Daft Punk")],
		}),
		artistNode("artist:daft-punk", "Daft Punk", {
			mbid: DAFT,
			notable_tracks: [
				edge("track:around-the-world", "Around the World"),
				edge(ATW_RIGHT, "Around the World"),
			],
		}),
	);
	await writeRedirects({ "track:around-the-world": ATW });
}

describe("settle-homonym-leftovers: Around the World", () => {
	it("merges the stripped duplicate into Daft Punk's own node, which wins, and leaves nothing of Stanley Black", async () => {
		await seedAroundTheWorld();

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(await exists(ATW)).toBe(false);
		const survivor = await read(ATW_RIGHT);
		expect(survivor).toMatchObject({
			mbid: "22222222-2222-4222-8222-222222222222",
			duration: "7:09",
			artists: [{ slug: "artist:daft-punk" }],
			project: { slug: "project:homework" },
			label: { slug: "label:virgin" },
		});
		expect(survivor.cover_url).toBeUndefined();
		expect(JSON.stringify(survivor)).not.toContain("stanley");
		expect(slugsOf(survivor.genres)).toEqual(["genre:disco"]);
		// Daft Punk listed the duplicate (through the bare slug) and the node itself: one edge.
		expect(slugsOf((await read("artist:daft-punk")).notable_tracks)).toEqual([ATW_RIGHT]);
		expect(await readRedirects()).toEqual({ "track:around-the-world": ATW_RIGHT, [ATW]: ATW_RIGHT });
		expect(result.manifest).toMatchObject({
			migration: MIGRATION_NAME,
			renamed: { [ATW]: ATW_RIGHT },
			summary: { fixed: 1, conflicts: 0, failed: 0, suspects: 0 },
		});
	});

	it("lets the target keep its own year and image even when the duplicate's prose states a year and has a Wikidata image", async () => {
		await seedAroundTheWorld();
		const dup = await read(ATW);
		await seed({
			...dup,
			editorial_article: `Released in 1996, Around the World is a single by Daft Punk. ${article}`,
			year: "1996",
			image_url: "https://upload.wikimedia.org/wikipedia/commons/a/a0/x.jpg",
			image_source: "wikidata-p18",
		});
		const right = await read(ATW_RIGHT);
		await seed({
			...right,
			year: "1997",
			image_url: "https://is1-ssl.mzstatic.com/image/thumb/Features115/x/600x600bb.jpg",
			image_source: "itunes-verified",
		});

		await run(true);

		expect(await read(ATW_RIGHT)).toMatchObject({ year: "1997", image_source: "itunes-verified" });
	});

	it("is a dry-run that writes nothing, and a second apply finds nothing left to do", async () => {
		await seedAroundTheWorld();
		const before = await readFile(nodePath(ATW), "utf8");

		const dry = await run(false);
		expect(dry.written).toEqual([]);
		expect(await readFile(nodePath(ATW), "utf8")).toBe(before);

		await run(true);
		const again = await run(true);
		expect(again.written).toEqual([]);
		expect(again.manifest.summary.fixed).toBe(0);
	});

	it("reports a missing target and keeps the duplicate when Daft Punk's node is not there", async () => {
		await seedAroundTheWorld();
		await rm(nodePath(ATW_RIGHT));

		const result = await run(true);

		expect(result.manifest.skipped).toEqual([{ slug: ATW, reason: "forced-target-absent", artists: [] }]);
		expect(await exists(ATW)).toBe(true);
	});
});

describe("settle-homonym-leftovers: right prose, homonym's identity", () => {
	it("re-credits Digital Love to Daft Punk and removes what Logistics' track gave it", async () => {
		const old = "track:digital-love--logistics";
		const next = "track:digital-love--daft-punk";
		await seed(
			workNode("track", old, "Digital Love", {
				editorial_article: `Released 11 June 2001 via Virgin Records, Daft Punk's 'Digital Love' is a single. ${article}`,
				mbid: "33333333-3333-4333-8333-333333333333",
				year: "2005",
				duration: "2:33",
				image_url: "https://coverartarchive.org/release-group/p/front-500",
				image_source: "caa",
				artists: [edge("artist:logistics", "Logistics", { mbid: "44444444-4444-4444-8444-444444444444" })],
				producers: [edge("artist:thomas-bangalter", "Thomas Bangalter")],
				project: edge("project:weapons-of-mass-creation-two", "Weapons of Mass Creation Two", {
					mbid: "55555555-5555-4555-8555-555555555555",
				}),
				label: edge("label:hospital-records", "Hospital Records", {
					mbid: "66666666-6666-4666-8666-666666666666",
				}),
			}),
			workNode("project", "project:weapons-of-mass-creation-two", "Weapons of Mass Creation Two", {
				tracklist: [edge(old, "Digital Love", { mbid: "33333333-3333-4333-8333-333333333333" })],
			}),
			artistNode("artist:daft-punk", "Daft Punk", { mbid: DAFT }),
		);
		await writeRedirects({ "track:digital-love": old });

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(await exists(old)).toBe(false);
		const fixed = await read(next);
		expect(fixed).toMatchObject({ slug: next, artists: [{ slug: "artist:daft-punk", mbid: DAFT }] });
		for (const gone of ["mbid", "year", "duration", "image_url", "image_source", "project", "label"]) {
			expect(fixed[gone], gone).toBeUndefined();
		}
		// What the LLM wrote stays.
		expect(String(fixed.editorial_article)).toContain("Daft Punk's 'Digital Love'");
		expect(slugsOf(fixed.producers)).toEqual(["artist:thomas-bangalter"]);
		expect((await read("project:weapons-of-mass-creation-two")).tracklist).toEqual([]);
		expect(await readRedirects()).toEqual({ "track:digital-love": next, [old]: next });
	});

	it("mints the credit of an artist with no node yet (Public Image Ltd) and its scoped slug", async () => {
		const old = "track:public-image--fraebbblarnir";
		await seed(
			workNode("track", old, "Public Image", {
				editorial_article: `Released in October 1978, the debut single Public Image introduced the band Public Image Ltd. ${article}`,
				artists: [
					edge("artist:fraebbblarnir", "Fraebbblarnir", { mbid: "77777777-7777-4777-8777-777777777777" }),
				],
			}),
		);

		const result = await run(true);

		expect(result.manifest.renamed).toEqual({ [old]: "track:public-image--public-image-ltd" });
		expect((await read("track:public-image--public-image-ltd")).artists).toEqual([
			{ slug: "artist:public-image-ltd", type: "artist", name: "Public Image Ltd" },
		]);
	});
});

describe("settle-homonym-leftovers: the corrected works", () => {
	const HAA = "project:human-after-all--daft-punk";
	const TM = "project:temps-mort--booba";
	const TWIN =
		"https://is1-ssl.mzstatic.com/image/thumb/Music128/v4/dc/fa/c1/dcfac16a-2e52-4034-979c-69280b9c06c2/884977687170.jpg/1500x1500bb.jpg";

	it("removes the homonym's cover and edges, and only those", async () => {
		await seed(
			workNode("project", HAA, "Human After All", {
				cover_url: TWIN,
				artists: [edge("artist:daft-punk", "Daft Punk", { mbid: DAFT })],
				personnel: [
					edge("artist:twin-atlantic", "Twin Atlantic"),
					edge("artist:nilesh-patel", "Nilesh Patel"),
				],
			}),
			// A cover that is not the homonym's stays.
			workNode("project", TM, "Temps mort", {
				cover_url:
					"https://is1-ssl.mzstatic.com/image/thumb/Music1/v4/aa/bb/cc/other/cover.jpg/1500x1500bb.jpg",
			}),
		);

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		const haa = await read(HAA);
		expect(haa.cover_url).toBeUndefined();
		expect(slugsOf(haa.personnel)).toEqual(["artist:nilesh-patel"]);
		expect(await exists(HAA)).toBe(true);
		expect((await read(TM)).cover_url).toContain("other/cover.jpg");
		expect(result.manifest.renamed).toEqual({});
	});

	it("removes an itunes-verified image that is the homonym's, and keeps one that is not", async () => {
		const wrong = TWIN.replace("1500x1500bb", "600x600bb");
		await seed(
			workNode("project", HAA, "Human After All", { image_url: wrong, image_source: "itunes-verified" }),
			workNode("project", TM, "Temps mort", {
				image_url: "https://is1-ssl.mzstatic.com/image/thumb/Music1/v4/aa/bb/cc/other/600x600bb.jpg",
				image_source: "itunes-verified",
			}),
		);

		await run(true);

		const haa = await read(HAA);
		expect([haa.image_url, haa.image_source]).toEqual([undefined, undefined]);
		expect((await read(TM)).image_source).toBe("itunes-verified");
	});

	it("removes the derived images of a re-credited work, whatever their URL (Digital Love)", async () => {
		const old = "track:digital-love--logistics";
		await seed(
			workNode("track", old, "Digital Love", {
				editorial_article: `Released in 2001, Daft Punk's Digital Love is a single. ${article}`,
				artists: [edge("artist:logistics", "Logistics")],
				image_url: "https://is1-ssl.mzstatic.com/image/thumb/Music1/v4/aa/bb/cc/x/600x600bb.jpg",
				image_source: "itunes-verified",
			}),
			artistNode("artist:daft-punk", "Daft Punk", { mbid: DAFT }),
		);

		await run(true);

		const fixed = await read("track:digital-love--daft-punk");
		expect([fixed.image_url, fixed.image_source]).toEqual([undefined, undefined]);
	});

	it("folds the bare and the scoped slug a label lists for the same work (Harvest Records)", async () => {
		const wywh = "project:wish-you-were-here--pink-floyd";
		await seed(
			workNode("project", wywh, "Wish You Were Here", {
				label: edge("label:harvest-records", "Harvest Records"),
			}),
			labelNode("label:harvest-records", "Harvest Records", {
				notable_releases: [
					edge("project:wish-you-were-here", "Wish You Were Here"),
					edge(wywh, "Wish You Were Here"),
				],
			}),
		);
		await writeRedirects({ "project:wish-you-were-here": wywh });

		await run(true);

		expect(slugsOf((await read("label:harvest-records")).notable_releases)).toEqual([wywh]);
	});

	it("rewrites a waiting reverse edge that names the bare slug, which would bring the duplicate back on a write", async () => {
		const wywh = "project:wish-you-were-here--pink-floyd";
		await seed(
			workNode("project", wywh, "Wish You Were Here"),
			labelNode("label:harvest-records", "Harvest Records", {
				notable_releases: [edge(wywh, "Wish You Were Here")],
			}),
		);
		await writeRedirects({ "project:wish-you-were-here": wywh });
		const waiting = {
			field: "notable_releases",
			cardinality: "list",
			edge: edge("project:wish-you-were-here", "Wish You Were Here"),
		};
		await writeFile(
			join(cacheDir(), "pending-reverses.json"),
			JSON.stringify({ "label:harvest-records": [waiting] }),
		);

		await run(true);

		const pending = JSON.parse(await readFile(join(cacheDir(), "pending-reverses.json"), "utf8")) as Record<
			string,
			{ edge: { slug: string } }[]
		>;
		expect(pending["label:harvest-records"]?.map((e) => e.edge.slug)).toEqual([wywh]);
	});

	it("rewrites the bare slug to the work when the label lists only that (the repo's Harvest Records)", async () => {
		const wywh = "project:wish-you-were-here--pink-floyd";
		await seed(
			workNode("project", wywh, "Wish You Were Here"),
			labelNode("label:harvest-records", "Harvest Records", {
				notable_releases: [edge("project:wish-you-were-here", "Wish You Were Here")],
			}),
		);
		await writeRedirects({ "project:wish-you-were-here": wywh });

		await run(true);

		expect(slugsOf((await read("label:harvest-records")).notable_releases)).toEqual([wywh]);
		// The redirect table is not rewritten: nothing moved.
		expect(await readRedirects()).toEqual({ "project:wish-you-were-here": wywh });
	});
});

describe("settle-homonym-leftovers: the closed list", () => {
	it("does nothing on a cache that holds none of the works (the repo run), and exits 0", async () => {
		await seed(artistNode("artist:daft-punk", "Daft Punk", { mbid: DAFT }));
		const before = await readFile(nodePath("artist:daft-punk"), "utf8");

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(result.written).toEqual([]);
		expect(await readFile(nodePath("artist:daft-punk"), "utf8")).toBe(before);
		expect(result.manifest.renamed).toEqual({});
	});

	it("keeps the identity of the works whose prose is wrong and removes only what the prose and the cover brought in", async () => {
		const CLEAN_BANDIT =
			"https://is1-ssl.mzstatic.com/image/thumb/Music30/v4/89/ce/7a/89ce7a97-bfea-c31b-ae6d-9bc6587097a4/190295927530.jpg/1500x1500bb.jpg";
		const lou = edge("artist:lou-johnson", "Lou Johnson", { mbid: "99999999-9999-4999-8999-999999999999" });
		await seed(
			workNode("track", "track:tears--lou-johnson", "Tears", {
				mbid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				year: "1969",
				duration: "2:37",
				cover_url: CLEAN_BANDIT,
				artists: [lou],
				producers: [edge("artist:mike-howlett", "Mike Howlett")],
				personnel: [
					edge("artist:roland-orzabal", "Roland Orzabal"),
					edge("artist:curt-smith", "Curt Smith"),
					edge("artist:a-session-man", "A Session Man"),
				],
			}),
			workNode("track", "track:noble-art--iam", "Noble Art", {
				artists: [edge("artist:iam", "IAM", { mbid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })],
				producers: [
					edge("artist:kamijo", "Kamijo"),
					edge("artist:hizaki", "Hizaki"),
					edge("artist:teru", "Teru"),
				],
				personnel: [edge("artist:jasmine-you", "Jasmine You")],
			}),
			artistNode("artist:iam", "IAM", {
				reference_track: edge("track:noble-art--iam", "Noble Art"),
				notable_tracks: [edge("track:noble-art--iam", "Noble Art")],
			}),
			workNode("project", "project:freddie-mercury--de-cylinders", "Freddie Mercury", {
				artists: [
					edge("artist:de-cylinders", "De Cylinders", { mbid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
				],
				producers: [edge("artist:giorgio-moroder", "Giorgio Moroder"), edge("artist:mack", "Mack")],
				personnel: [edge("artist:montserrat-caballe", "Montserrat Caballé")],
				related_projects: [edge("project:queen--mia", "Queen MIA")],
			}),
		);

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(result.manifest.renamed).toEqual({});
		const tears = await read("track:tears--lou-johnson");
		expect(tears).toMatchObject({
			mbid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			year: "1969",
			duration: "2:37",
		});
		expect(slugsOf(tears.artists)).toEqual(["artist:lou-johnson"]);
		expect(tears.cover_url).toBeUndefined();
		expect(slugsOf(tears.personnel)).toEqual(["artist:a-session-man"]);
		expect(slugsOf(tears.producers)).toEqual([]);
		const noble = await read("track:noble-art--iam");
		expect(slugsOf(noble.producers)).toEqual([]);
		expect(slugsOf(noble.personnel)).toEqual([]);
		// IAM does have this track (its identity is right): only the flagship pick goes.
		const iam = await read("artist:iam");
		expect(iam.reference_track).toBeUndefined();
		expect(slugsOf(iam.notable_tracks)).toEqual(["track:noble-art--iam"]);
		const freddie = await read("project:freddie-mercury--de-cylinders");
		expect(slugsOf(freddie.producers)).toEqual(["artist:mack"]);
		expect(slugsOf(freddie.personnel)).toEqual([]);
		expect(freddie.related_projects).toEqual([]);
	});

	it("clears a reference track only while it still holds the work (a pick made since is not ours to undo)", async () => {
		await seed(
			workNode("track", "track:noble-art--iam", "Noble Art"),
			artistNode("artist:iam", "IAM", { reference_track: edge("track:another-song--iam", "Another Song") }),
		);

		await run(true);

		expect((await read("artist:iam")).reference_track).toMatchObject({ slug: "track:another-song--iam" });
	});

	it("leaves The Essential alone: its edges are Earth, Wind and Fire's own", async () => {
		const slug = "project:the-essential--earth-wind-and-fire";
		await seed(
			workNode("project", slug, "The Essential", {
				producers: [edge("artist:maurice-white", "Maurice White")],
			}),
		);
		const before = await readFile(nodePath(slug), "utf8");

		const result = await run(true);

		expect(result.written).toEqual([]);
		expect(await readFile(nodePath(slug), "utf8")).toBe(before);
	});

	it("has its redirect pairs committed in data/slug-redirects.json, the bare slugs included (the channel refuses otherwise)", async () => {
		const committed = (
			JSON.parse(await readFile("data/slug-redirects.json", "utf8")) as { redirects: Record<string, string> }
		).redirects;
		const pairs: [string, string, string][] = [
			["track:around-the-world", ATW, ATW_RIGHT],
			["track:digital-love", "track:digital-love--logistics", "track:digital-love--daft-punk"],
			["track:human-after-all", "track:human-after-all--twin-atlantic", "track:human-after-all--daft-punk"],
			["track:public-image", "track:public-image--fraebbblarnir", "track:public-image--public-image-ltd"],
		];
		for (const [bare, old, right] of pairs) expect([committed[bare], committed[old]]).toEqual([right, right]);
		// Tears is not re-credited: its bare slug still reads as Lou Johnson's track, and there is no pair for it.
		expect(committed["track:tears"]).toBe("track:tears--lou-johnson");
		expect(committed["track:tears--lou-johnson"]).toBeUndefined();
	});

	it("carries a migration name the channel accepts", () => {
		expect(MIGRATION_NAME).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/);
	});
});
