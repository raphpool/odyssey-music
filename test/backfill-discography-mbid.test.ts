import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ArtistEntry,
	type BackfillOptions,
	type DiscographyManifest,
	formatSummary,
	MIGRATION_NAME,
	parseCliArgs,
	runBackfill,
} from "../scripts/migrations/2026-10-21-backfill-discography-mbid.js";
import { musicBrainzConfig } from "../src/config.js";
import { VARIOUS_ARTISTS_MBID } from "../src/discography-policy.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";
import { artistNode, edge, projectNode } from "./images/helpers.js";

// TRA-618: the discography backfill, offline. Only the network boundary is replaced (the injected `fetch`,
// MusicBrainz answers built here); the client, the policy, the merge, the cache layout and the node schema
// are the real ones.

vi.hoisted(() => {
	// The client memoizes answers per URL for five minutes: a second run of a test would never reach the fetch.
	process.env.MB_CACHE_TTL_MS = "0";
});

const mb = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KODE9 = mb(1);
const SPACEAPE = mb(2);
const DAFT = mb(3);
const BURIAL = mb(4);
const PRINCE = mb(5);

interface Rg {
	id: string;
	title: string;
	type: "Album" | "EP" | "Single";
	date?: string;
	secondary?: string[];
	votes?: number;
	credits: { id: string; name: string }[];
}
const rg = (
	n: number,
	title: string,
	type: Rg["type"],
	date: string,
	credits: Rg["credits"],
	secondary: string[] = [],
): Rg => ({ id: mb(1000 + n), title, type, date, credits, secondary });

const page = (groups: Rg[]): Response =>
	new Response(
		JSON.stringify({
			"release-group-count": groups.length,
			"release-groups": groups.map((g) => ({
				id: g.id,
				title: g.title,
				"primary-type": g.type,
				"secondary-types": g.secondary ?? [],
				"first-release-date": g.date ?? "",
				rating: { "votes-count": g.votes ?? 0 },
				"artist-credit": g.credits.map((c) => ({ name: c.name, artist: { id: c.id, name: c.name } })),
			})),
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);

/** What `/artist/<mbid>?inc=aliases` answers (TRA-630). */
interface Names {
	name: string;
	sortName?: string;
	aliases?: { name: string; sortName?: string; type?: string }[];
}
const namesBody = (n: Names): Response =>
	new Response(
		JSON.stringify({
			id: "ignored",
			name: n.name,
			"sort-name": n.sortName ?? n.name,
			aliases: (n.aliases ?? []).map((a) => ({
				name: a.name,
				"sort-name": a.sortName ?? a.name,
				type: a.type ?? "Artist name",
			})),
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);

interface World {
	byArtist: Map<string, Rg[] | "down">;
	/** The names MusicBrainz holds for an artist; no entry = it does not know the MBID (404). */
	names: Map<string, Names | "down">;
	/** The alias lookups, in order: the extra request the identity guard may make, one per failed guard. */
	aliasRequests: { artist: string; inc: string | null }[];
	requests: { artist: string; type: string }[];
	inFlight: number;
	maxInFlight: number;
	onRequest?: (artist: string) => void;
}
function world(): World {
	return {
		byArtist: new Map(),
		names: new Map(),
		aliasRequests: [],
		requests: [],
		inFlight: 0,
		maxInFlight: 0,
	};
}
function mbFetch(w: World): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const lookup = /\/artist\/([^/]+)$/.exec(url.pathname)?.[1];
		const artist = lookup ?? url.searchParams.get("artist") ?? "";
		const type = url.searchParams.get("type") ?? "";
		if (lookup === undefined) w.requests.push({ artist, type });
		else w.aliasRequests.push({ artist, inc: url.searchParams.get("inc") });
		w.onRequest?.(artist);
		w.inFlight++;
		w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
		await new Promise((resolve) => setTimeout(resolve, 2));
		w.inFlight--;
		if (lookup !== undefined) {
			const names = w.names.get(lookup);
			if (names === undefined) return new Response("", { status: 404 });
			return names === "down" ? new Response("", { status: 503 }) : namesBody(names);
		}
		const answer = w.byArtist.get(artist);
		if (answer === undefined || answer === "down") return new Response("", { status: 503 });
		return page(answer.filter((g) => g.type.toLowerCase() === type));
	}) as typeof fetch;
}

let scratch: string;
let dir: string;
let dataDir: string;
const suiteInterval = musicBrainzConfig.minIntervalMs;
const suiteAttempts = process.env.MB_MAX_ATTEMPTS;

beforeEach(async () => {
	// No spacing in tests (the queue is the client's), and a 503 is not retried: nothing waits.
	musicBrainzConfig.minIntervalMs = 0;
	process.env.MB_MAX_ATTEMPTS = "1";
	scratch = await mkdtemp(join(tmpdir(), "odyssey-backfill-discography-"));
	dir = join(scratch, "cache");
	await mkdir(join(dir, "nodes"), { recursive: true });
	dataDir = join(scratch, "data");
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects: {} }), "utf8");
	await writeFile(join(dataDir, "identity-exclusions.json"), JSON.stringify({ artists: {} }), "utf8");
});

afterEach(async () => {
	musicBrainzConfig.minIntervalMs = suiteInterval;
	if (suiteAttempts === undefined) delete process.env.MB_MAX_ATTEMPTS;
	else process.env.MB_MAX_ATTEMPTS = suiteAttempts;
	await rm(scratch, { recursive: true, force: true });
});

const pathOf = (slug: string): string => {
	const { type, body } = parseSlug(slug);
	return join(dir, "nodes", type, `${body}.json`);
};
const manifestFile = (name = "discography-mbid.json"): string => join(scratch, "out", name);
async function put(node: { slug: string }): Promise<void> {
	await mkdir(dirname(pathOf(node.slug)), { recursive: true });
	await writeFile(pathOf(node.slug), `${JSON.stringify(node, null, 2)}\n`, "utf8");
}
async function putExclusions(artists: Record<string, string>): Promise<void> {
	await writeFile(join(dataDir, "identity-exclusions.json"), JSON.stringify({ artists }), "utf8");
}
const readManifest = async (path = manifestFile()): Promise<DiscographyManifest> =>
	JSON.parse(await readFile(path, "utf8")) as DiscographyManifest;
const entryOf = (manifest: DiscographyManifest, slug: string): ArtistEntry => {
	const entry = manifest.artists[slug];
	if (entry === undefined) throw new Error(`no manifest entry for ${slug}`);
	return entry;
};
const readNode = async (slug: string): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(pathOf(slug), "utf8")) as Record<string, unknown>;

// Every file under cache/ with its bytes and mtime: what "nothing was touched" compares.
async function snapshot(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (folder: string): Promise<void> => {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) await walk(path);
			else out[path.slice(dir.length)] = `${(await stat(path)).mtimeMs}|${await readFile(path, "utf8")}`;
		}
	};
	await walk(dir);
	return out;
}

function options(w: World, extra: Partial<BackfillOptions> = {}): BackfillOptions {
	return {
		cacheDir: dir,
		apply: false,
		manifestPath: manifestFile(),
		dataDir,
		fetch: mbFetch(w),
		currentYear: 2026,
		currentDate: "2026-10-24",
		...extra,
	};
}

const kode9Credit = { id: KODE9, name: "Kode9" };
const spaceapeCredit = { id: SPACEAPE, name: "The Spaceape" };
const dpCredit = { id: DAFT, name: "Daft Punk" };

/** Kode9 as the prod node has it (TRA-612): two works without mbid, one of them a "Sine of the Dub / Stalker" single. */
async function putKode9(): Promise<void> {
	await put(
		artistNode("kode9", "Kode9", {
			mbid: KODE9,
			artist_kind: "person",
			discography: [
				edge("project", "memories-of-the-future--kode9", "Memories of the Future", {
					artist: "Kode9",
					year: "2006",
				}),
				edge("project", "sine-of-the-dub-stalker--kode9", "Sine of the Dub / Stalker", { artist: "Kode9" }),
			],
		}),
	);
}
function kode9World(w: World): void {
	w.byArtist.set(KODE9, [
		rg(1, "Memories of the Future", "Album", "2006-05-08", [kode9Credit, spaceapeCredit]),
		rg(2, "Black Sun", "Album", "2015-06-02", [kode9Credit]),
		rg(3, "Nothing", "EP", "2013-04-09", [kode9Credit]),
		rg(4, "Sine of the Dub", "Single", "2005-01-01", [kode9Credit]),
		rg(5, "Fabric 62 (DJ mix)", "Album", "2012-01-01", [kode9Credit], ["Compilation", "DJ-mix"]),
		rg(6, "Gift", "Album", "2019-01-01", [kode9Credit, spaceapeCredit, { id: mb(77), name: "Third" }]),
	]);
}

async function putDaftPunk(): Promise<void> {
	await put(
		artistNode("daft-punk", "Daft Punk", {
			mbid: DAFT,
			artist_kind: "group",
			discography: [
				edge("project", "discovery--daft-punk", "Discovery", {
					artist: "Daft Punk",
					year: "2001",
					releaseType: "album",
					mbid: mb(1010),
				}),
			],
		}),
	);
}
function daftWorld(w: World): void {
	w.byArtist.set(DAFT, [
		rg(10, "Discovery", "Album", "2001-03-12", [dpCredit]),
		rg(11, "Random Access Memories", "Album", "2013-05-17", [dpCredit]),
		rg(12, "One More Time (radio edit)", "Single", "2000-11-13", [dpCredit]),
		rg(13, "Around the World", "Single", "1997-04-01", [dpCredit], ["Remix"]),
		rg(14, "Now That's What I Call Dance", "Album", "2009-01-01", [
			{ id: VARIOUS_ARTISTS_MBID, name: "Various Artists" },
		]),
	]);
}

describe("dry-run (default)", () => {
	it("writes no node and no pending-reverses.json, writes the manifest and prints (DRY RUN)", async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		await put(projectNode("black-sun--kode9", "Black Sun", { artists: [edge("artist", "kode9", "Kode9")] }));
		await writeFile(join(dir, "pending-reverses.json"), "{}\n", "utf8");
		const before = await snapshot();

		const result = await runBackfill(options(w));

		expect(await snapshot()).toEqual(before);
		expect(result.written).toBe(0);
		expect(result.exitCode).toBe(0);
		expect(entryOf(await readManifest(), "artist:kode9").added?.length).toBeGreaterThan(0);
		expect(formatSummary(result, false, "out/x.json")).toContain("(DRY RUN)");
		expect(formatSummary(result, true, "out/x.json")).not.toContain("(DRY RUN)");
	});

	it("emits the channel's fixed fields", async () => {
		const w = world();
		await putKode9();
		kode9World(w);
		await runBackfill(options(w));
		const manifest = await readManifest();
		expect(manifest).toMatchObject({ migration: MIGRATION_NAME, removed: [], renamed: {}, redirects: {} });
	});
});

describe("--apply", () => {
	it("rewrites the node by schema-validated atomic write, never touches project nodes or pending-reverses.json", async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		const project = projectNode("black-sun--kode9", "Black Sun", {
			artists: [edge("artist", "kode9", "Kode9")],
		});
		await put(project);
		await writeFile(join(dir, "pending-reverses.json"), "{}\n", "utf8");
		const projectBefore = (await snapshot())["/nodes/project/black-sun--kode9.json"];
		const pendingBefore = (await snapshot())["/pending-reverses.json"];

		const result = await runBackfill(options(w, { apply: true }));

		expect(result).toMatchObject({ written: 1, exitCode: 0 });
		const node = await readNode("artist:kode9");
		const list = node.discography as {
			slug: string;
			name: string;
			mbid?: string;
			year?: string;
			releaseType?: string;
		}[];
		// Posed on the existing entries (name and slug untouched), added for the missing works.
		expect(list.find((e) => e.slug === "project:memories-of-the-future--kode9")).toMatchObject({
			name: "Memories of the Future",
			mbid: mb(1001),
			year: "2006",
			releaseType: "album",
		});
		expect(list.map((e) => e.name)).toEqual(
			expect.arrayContaining(["Memories of the Future", "Black Sun", "Nothing", "Sine of the Dub"]),
		);
		// A compilation (secondary type), a three-artist credit: not works of Kode9.
		expect(list.map((e) => e.name)).not.toContain("Fabric 62 (DJ mix)");
		expect(list.map((e) => e.name)).not.toContain("Gift");
		expect(list.find((e) => e.name === "Nothing")).toMatchObject({
			mbid: mb(1003),
			releaseType: "ep",
			year: "2013",
		});
		// The existing entry with a stored slug is kept as it was.
		expect(list.find((e) => e.slug === "project:sine-of-the-dub-stalker--kode9")?.mbid).toBeUndefined();

		const after = await snapshot();
		expect(after["/nodes/project/black-sun--kode9.json"]).toBe(projectBefore);
		expect(after["/pending-reverses.json"]).toBe(pendingBefore);
	});

	it("does not rewrite a node the merge leaves intact (same bytes, same mtime)", async () => {
		const w = world();
		daftWorld(w);
		// Everything MusicBrainz offers is already there.
		await put(
			artistNode("daft-punk", "Daft Punk", {
				mbid: DAFT,
				artist_kind: "group",
				discography: [
					edge("project", "random-access-memories--daft-punk", "Random Access Memories", {
						artist: "Daft Punk",
						year: "2013",
						releaseType: "album",
						mbid: mb(1011),
					}),
					edge("project", "discovery--daft-punk", "Discovery", {
						artist: "Daft Punk",
						year: "2001",
						releaseType: "album",
						mbid: mb(1010),
					}),
				],
			}),
		);
		const before = await snapshot();

		const result = await runBackfill(options(w, { apply: true }));

		expect(result.written).toBe(0);
		expect(await snapshot()).toEqual(before);
		expect(entryOf(await readManifest(), "artist:daft-punk")).toMatchObject({
			before: 2,
			after: 2,
			posed: [],
			added: [],
		});
	});

	it("keeps remixes, edits, secondary types and Various Artists out, and counts them by reason", async () => {
		const w = world();
		daftWorld(w);
		await putDaftPunk();
		await runBackfill(options(w, { apply: true }));
		const manifest = await readManifest();
		const entry = entryOf(manifest, "artist:daft-punk");
		expect(entry.added?.map((a) => a.title)).toEqual(["Random Access Memories"]);
		expect(entry.excluded).toEqual({
			"secondary-type": 1,
			credit: 0,
			"various-artists": 1,
			"non-canonical": 1,
			"primary-type": 0,
			unrated: 0,
			future: 0,
		});
		expect(manifest.totals.excluded["various-artists"]).toBe(1);
	});

	it("mints the slugs in the flag-on form whatever the environment says, and restores both globals", async () => {
		const w = world();
		w.byArtist.set(KODE9, [rg(20, "Ørsted", "Album", "2020-01-01", [{ id: KODE9, name: "Mø" }])]);
		await put(artistNode("mo", "Mø", { mbid: KODE9, discography: [] }));
		const flag = process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
		delete process.env.ODYSSEY_SCOPED_RELEASE_SLUGS;
		const originalFetch = globalThis.fetch;
		try {
			await runBackfill(options(w, { apply: true }));
			expect(process.env.ODYSSEY_SCOPED_RELEASE_SLUGS).toBeUndefined();
			expect(globalThis.fetch).toBe(originalFetch);
		} finally {
			if (flag !== undefined) process.env.ODYSSEY_SCOPED_RELEASE_SLUGS = flag;
		}
		const list = (await readNode("artist:mo")).discography as { slug: string }[];
		expect(list.map((e) => e.slug)).toEqual(["project:orsted--mo"]);
	});

	it("attaches an added work to the project node that holds its mbid, or to the redirect of its slug", async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		// "Black Sun" already exists as a node under another slug; "Nothing" was renamed (redirect table).
		await put(projectNode("black-sun-2015--kode9", "Black Sun", { mbid: mb(1002) }));
		await put(projectNode("nothing-ep--kode9", "Nothing EP"));
		await writeFile(
			join(dataDir, "slug-redirects.json"),
			JSON.stringify({ redirects: { "project:nothing--kode9": "project:nothing-ep--kode9" } }),
			"utf8",
		);
		await runBackfill(options(w, { apply: true }));
		const list = (await readNode("artist:kode9")).discography as { slug: string; name: string }[];
		expect(list.find((e) => e.name === "Black Sun")?.slug).toBe("project:black-sun-2015--kode9");
		expect(list.find((e) => e.name === "Nothing")?.slug).toBe("project:nothing-ep--kode9");
	});

	// TRA-647 (measured 2026-10-20 on the cache of PR #562): "Vrioon" was posed the 2022 reissue's mbid while the
	// project node of the album held another one. The migration hands the merge the mbid of every project node.
	it("does not pose an mbid against the one the project node of an entry without type or year holds", async () => {
		const sakamoto = mb(20);
		const credit = { id: sakamoto, name: "Ryuichi Sakamoto" };
		const w = world();
		w.byArtist.set(sakamoto, [rg(80, "Vrioon", "Album", "2022-04-08", [credit])]);
		await put(
			artistNode("ryuichi-sakamoto", "Ryuichi Sakamoto", {
				mbid: sakamoto,
				artist_kind: "person",
				discography: [edge("project", "vrioon--ryuichi-sakamoto", "Vrioon", { artist: "Ryuichi Sakamoto" })],
			}),
		);
		await put(projectNode("vrioon--ryuichi-sakamoto", "Vrioon", { mbid: mb(3001) }));

		await runBackfill(options(w, { apply: true }));

		const entry = entryOf(await readManifest(), "artist:ryuichi-sakamoto");
		expect(entry.posed).toEqual([]);
		expect(entry.added).toEqual([]);
		expect(entry.ambiguous).toEqual([{ slug: "project:vrioon--ryuichi-sakamoto", reason: "node-conflict" }]);
		const list = (await readNode("artist:ryuichi-sakamoto")).discography as { mbid?: string }[];
		expect(list.map((e) => e.mbid)).toEqual([undefined]);

		// The node holds the mbid MusicBrainz gives: it is posed.
		await put(projectNode("vrioon--ryuichi-sakamoto", "Vrioon", { mbid: mb(1080) }));
		await runBackfill(options(w, { apply: true }));
		const posed = entryOf(await readManifest(), "artist:ryuichi-sakamoto").posed;
		expect(posed?.map((p) => p.mbid)).toEqual([mb(1080)]);
	});

	it("does not follow a redirect to a work scoped on another artist", async () => {
		const w = world();
		const twin = mb(11);
		w.byArtist.set(twin, [
			rg(70, "Human After All", "Album", "2011-01-01", [{ id: twin, name: "Twin Atlantic" }]),
		]);
		await put(artistNode("twin-atlantic", "Twin Atlantic", { mbid: twin }));
		// Daft Punk's node was renamed: the table sends the Twin Atlantic spelling of the slug to Daft Punk's work.
		await put(projectNode("human-after-all--daft-punk", "Human After All"));
		await writeFile(
			join(dataDir, "slug-redirects.json"),
			JSON.stringify({
				redirects: { "project:human-after-all--twin-atlantic": "project:human-after-all--daft-punk" },
			}),
			"utf8",
		);

		await runBackfill(options(w, { apply: true }));

		const list = (await readNode("artist:twin-atlantic")).discography as { slug: string }[];
		expect(list.map((e) => e.slug)).toEqual(["project:human-after-all--twin-atlantic"]);
	});
});

describe("exit code", () => {
	async function putMany(w: World, count: number, down: number[]): Promise<void> {
		for (let i = 1; i <= count; i++) {
			const n = String(i).padStart(2, "0");
			const id = mb(7200 + i);
			await put(artistNode(`e${n}`, `E${n}`, { mbid: id }));
			w.byArtist.set(
				id,
				down.includes(i)
					? "down"
					: [rg(250 + i, `Record ${n}`, "Album", "2020-01-01", [{ id, name: `E${n}` }])],
			);
		}
	}

	it("is 0 when only a few artists are unavailable, which the manifest lists and the summary counts", async () => {
		const w = world();
		await putMany(w, 10, [3]);
		const result = await runBackfill(options(w, { apply: true }));
		expect(result.exitCode).toBe(0);
		expect(result.requests).toEqual({ asked: 10, unavailable: 1 });
		expect(entryOf(await readManifest(), "artist:e03").skipped).toBe("unavailable");
		expect(formatSummary(result, true, "m.json")).toContain("1 of 10 artist(s) unavailable");
		expect((await readNode("artist:e03")).discography).toEqual([]);
	});

	it("passes at exactly the rate and fails above it", async () => {
		const exact = world();
		await putMany(exact, 10, [3, 4]);
		expect((await runBackfill(options(exact))).exitCode).toBe(0);

		const above = world();
		await putMany(above, 10, [3, 4, 5]);
		const result = await runBackfill(options(above));
		expect(result.exitCode).toBe(1);
		expect(formatSummary(result, false, "m.json")).toContain("the service is down");
	});
});

describe("skipped artists", () => {
	it("skips no-mbid, excluded, name-mismatch, unavailable and cap with their reason, and writes nothing", async () => {
		const w = world();
		w.byArtist.set(PRINCE, [
			rg(30, "Purple Rain", "Album", "1984-06-25", [{ id: PRINCE, name: "Prince Buster" }]),
		]);
		w.names.set(PRINCE, { name: "Prince Buster", sortName: "Buster, Prince" });
		w.byArtist.set(BURIAL, "down");
		w.byArtist.set(mb(6), [rg(31, "Anything", "Album", "2000-01-01", [{ id: mb(6), name: "Excluded One" }])]);
		await put(
			artistNode("aphex-twin", "Aphex Twin", { discography: [edge("project", "syro--aphex-twin", "Syro")] }),
		);
		await put(artistNode("excluded-one", "Excluded One", { mbid: mb(6) }));
		await put(
			artistNode("prince", "Prince", {
				mbid: PRINCE,
				discography: [edge("project", "purple-rain--prince", "Purple Rain")],
			}),
		);
		await put(
			artistNode("burial", "Burial", {
				mbid: BURIAL,
				discography: [edge("project", "untrue--burial", "Untrue")],
			}),
		);
		const capEdges = Array.from({ length: 40 }, (_, i) =>
			edge("project", `album-${i}--capped`, `Album ${i}`, { artist: "Capped", mbid: mb(2000 + i) }),
		);
		await put(artistNode("capped", "Capped", { mbid: mb(7), discography: capEdges }));
		w.byArtist.set(mb(7), []);
		await putExclusions({ "artist:excluded-one": "Stored mbid belongs to somebody else." });
		const before = await snapshot();

		const result = await runBackfill(options(w, { apply: true }));

		const manifest = await readManifest();
		expect(entryOf(manifest, "artist:aphex-twin").skipped).toBe("no-mbid");
		expect(entryOf(manifest, "artist:excluded-one").skipped).toBe("excluded");
		expect(entryOf(manifest, "artist:prince").skipped).toBe("name-mismatch");
		expect(entryOf(manifest, "artist:burial").skipped).toBe("unavailable");
		expect(entryOf(manifest, "artist:capped").skipped).toBe("cap");
		expect(manifest.totals.skipped).toEqual({
			"no-mbid": 1,
			excluded: 1,
			"name-mismatch": 1,
			unavailable: 1,
			cap: 1,
		});
		expect(await snapshot()).toEqual(before);
		expect(result).toMatchObject({ written: 0, exitCode: 1 });
		// Asked about: Prince and Burial only. Nothing for no-mbid, excluded or capped. Burial's list never
		// came, so it has no credit to doubt: only Prince's failed guard costs the alias lookup.
		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([PRINCE, BURIAL]));
		expect(w.aliasRequests.map((r) => r.artist)).toEqual([PRINCE]);
		expect(formatSummary(result, true, "out/x.json")).toContain("unavailable artist:burial");
	});

	it("refuses to run without the exclusion list", async () => {
		const w = world();
		await rm(join(dataDir, "identity-exclusions.json"));
		await putKode9();
		await expect(runBackfill(options(w))).rejects.toThrow(/exclusion list/);
	});
});

describe("the identity guard reads the artist's own names (TRA-630)", () => {
	const SAKAMOTO = mb(8001);
	const ATOM = mb(8002);
	const SMITH = mb(8003);
	const OTHER = mb(8004);

	async function putArtist(slug: string, name: string, mbid: string): Promise<void> {
		await put(artistNode(slug, name, { mbid, artist_kind: "person", discography: [] }));
	}
	const credited = (id: string, name: string, n: number): Rg[] => [
		rg(n, `Record ${n}`, "Album", "2001-01-01", [{ id, name }]),
	];
	async function sakamotoWorld(w: World): Promise<void> {
		await putArtist("ryuichi-sakamoto", "Ryuichi Sakamoto", SAKAMOTO);
		w.byArtist.set(SAKAMOTO, credited(SAKAMOTO, "坂本龍一", 40));
		w.names.set(SAKAMOTO, {
			name: "坂本龍一",
			sortName: "Sakamoto, Ryuichi",
			aliases: [{ name: "Ryuichi Sakamoto", sortName: "Sakamoto, Ryuichi" }],
		});
	}
	async function smithWorld(w: World): Promise<void> {
		await putArtist("john-smith", "John Smith", SMITH);
		w.byArtist.set(SMITH, credited(SMITH, "Jane Doe", 43));
		w.names.set(SMITH, {
			name: "Jane Doe",
			sortName: "Doe, Jane",
			aliases: [{ name: "J. Doe" }, { name: "Smith Jane", sortName: "Jane, Smith" }],
		});
	}

	it("accepts Ryuichi Sakamoto credited in 坂本龍一 on an alias of the artist, and says so in the manifest", async () => {
		const w = world();
		await sakamotoWorld(w);

		const result = await runBackfill(options(w, { apply: true }));

		const entry = entryOf(await readManifest(), "artist:ryuichi-sakamoto");
		expect(entry.skipped).toBeUndefined();
		expect(entry.identity).toBe("alias");
		expect(entry.added?.map((a) => a.title)).toEqual(["Record 40"]);
		expect((await readNode("artist:ryuichi-sakamoto")).discography).toHaveLength(1);
		expect((await readManifest()).totals.identity).toEqual({ credit: 0, alias: 1 });
		expect(result.exitCode).toBe(0);
		expect(w.aliasRequests).toEqual([{ artist: SAKAMOTO, inc: "aliases" }]);
	});

	it("accepts the inverted sort-name alone, when no alias spells the name", async () => {
		const w = world();
		await sakamotoWorld(w);
		w.names.set(SAKAMOTO, { name: "坂本龍一", sortName: "Sakamoto, Ryuichi" });
		await runBackfill(options(w));
		expect(entryOf(await readManifest(), "artist:ryuichi-sakamoto").identity).toBe("alias");
	});

	it("accepts the artist's native-script name for a node written in the same script", async () => {
		const w = world();
		await putArtist("sakamoto-native", "坂本龍一", SAKAMOTO);
		w.byArtist.set(SAKAMOTO, credited(SAKAMOTO, "Ryuichi Sakamoto", 40));
		w.names.set(SAKAMOTO, { name: "坂本龍一" });
		await runBackfill(options(w));
		expect(entryOf(await readManifest(), "artist:sakamoto-native").identity).toBe("alias");
	});

	it('accepts "Atom TM" against the MusicBrainz name "Atom™"', async () => {
		const w = world();
		await putArtist("atom-tm", "Atom TM", ATOM);
		w.byArtist.set(ATOM, credited(ATOM, "Uwe Schmidt", 41));
		w.names.set(ATOM, { name: "Atom™" });
		await runBackfill(options(w));
		expect(entryOf(await readManifest(), "artist:atom-tm").identity).toBe("alias");
	});

	it("takes the credits' own Atom™ and Tronikhouse for the nodes Atom TM and Tronik House, with no extra request", async () => {
		const w = world();
		await putArtist("atom-tm", "Atom TM", ATOM);
		w.byArtist.set(ATOM, credited(ATOM, "Atom™", 41));
		await putArtist("tronik-house", "Tronik House", SMITH);
		w.byArtist.set(SMITH, credited(SMITH, "Tronikhouse", 53));
		await runBackfill(options(w));
		const manifest = await readManifest();
		expect(entryOf(manifest, "artist:atom-tm").identity).toBe("credit");
		expect(entryOf(manifest, "artist:tronik-house").identity).toBe("credit");
		expect(w.aliasRequests).toEqual([]);
	});

	// The Latin spellings the credits' own normalization does not fold (it folds accents, not "oe" or a
	// nickname), a script change, a spacing variant, a sort-name only: the artist's names say who it is.
	const variants: [string, string, Names][] = [
		[
			"Arnold Schoenberg",
			"Arnold Sch\u00f6nberg",
			{ name: "Arnold Sch\u00f6nberg", aliases: [{ name: "Arnold Schoenberg" }] },
		],
		["Tronik House", "Tronik Haus Project", { name: "Tronikhouse" }],
		["Junko Ohashi", "\u5927\u6a4b\u7d14\u5b50", { name: "Junko \u014chashi" }],
		["Mike Golding", "Michael Golding", { name: "Michael Golding", aliases: [{ name: "Mike Golding" }] }],
		["Atom", "Atom\u2122", { name: "Atom\u2122" }],
		[
			"Hikaru Utada",
			"\u5b87\u591a\u7530\u30d2\u30ab\u30eb",
			{ name: "\u5b87\u591a\u7530\u30d2\u30ab\u30eb", sortName: "Utada, Hikaru" },
		],
	];
	it.each(variants)(
		"accepts the node %s credited %s on the names of the artist",
		async (node, credit, names) => {
			const w = world();
			await putArtist("subject", node, ATOM);
			w.byArtist.set(ATOM, credited(ATOM, credit, 42));
			w.names.set(ATOM, names);
			await runBackfill(options(w));
			expect(entryOf(await readManifest(), "artist:subject").identity).toBe("alias");
		},
	);

	it("still skips a John Smith that carries the MBID of another artist: name-mismatch", async () => {
		const w = world();
		await smithWorld(w);
		// Names made of nothing but punctuation have an empty key, which never matches.
		await putArtist("bangs", "!!!", OTHER);
		w.byArtist.set(OTHER, credited(OTHER, "???", 44));
		w.names.set(OTHER, { name: "???" });

		const result = await runBackfill(options(w, { apply: true }));

		const manifest = await readManifest();
		expect(entryOf(manifest, "artist:john-smith")).toMatchObject({
			skipped: "name-mismatch",
			aliasesChecked: true,
		});
		expect(entryOf(manifest, "artist:bangs").skipped).toBe("name-mismatch");
		expect(result.written).toBe(0);
		expect((await readNode("artist:john-smith")).discography).toEqual([]);
	});

	it("ignores the 'Search hint' aliases, whatever their case: too generic to name the artist", async () => {
		const w = world();
		// H.A.W.K. has the search hints "Hawk" and "John Hawkins" (measured 2026-10-19); a node named so is not him.
		await putArtist("hint-one", "John Hawkins", SMITH);
		w.byArtist.set(SMITH, credited(SMITH, "H.A.W.K.", 47));
		w.names.set(SMITH, {
			name: "H.A.W.K.",
			aliases: [{ name: "John Hawkins", type: "Search hint" }],
		});
		await putArtist("hint-two", "Hawk", OTHER);
		w.byArtist.set(OTHER, credited(OTHER, "H.A.W.K.", 48));
		w.names.set(OTHER, { name: "H.A.W.K.", aliases: [{ name: "Hawk", type: "search HINT" }] });
		// The same alias with another type is a name of the artist.
		await putArtist("not-a-hint", "Big Hawk", ATOM);
		w.byArtist.set(ATOM, credited(ATOM, "H.A.W.K.", 49));
		w.names.set(ATOM, { name: "H.A.W.K.", aliases: [{ name: "Big Hawk", type: "Artist name" }] });

		await runBackfill(options(w));

		const manifest = await readManifest();
		expect(entryOf(manifest, "artist:hint-one").skipped).toBe("name-mismatch");
		expect(entryOf(manifest, "artist:hint-two").skipped).toBe("name-mismatch");
		expect(entryOf(manifest, "artist:not-a-hint").identity).toBe("alias");
	});

	it("accepts a node on the sort-name of an alias alone, name and sort-name of the artist being other", async () => {
		const w = world();
		await putArtist("haruomi-hosono", "Haruomi Hosono", SAKAMOTO);
		w.byArtist.set(SAKAMOTO, credited(SAKAMOTO, "細野晴臣", 50));
		w.names.set(SAKAMOTO, {
			name: "細野晴臣",
			sortName: "細野晴臣",
			aliases: [{ name: "細野 晴臣", sortName: "Hosono, Haruomi" }],
		});
		await runBackfill(options(w));
		expect(entryOf(await readManifest(), "artist:haruomi-hosono").identity).toBe("alias");
	});

	// Dots stay in the key (TRA-630): an initialism is not the word its letters spell, in either direction.
	it.each([
		["H.A.W.K.", "Hawk"],
		["Hawk", "H.A.W.K."],
		["M.I.A.", "Mia"],
		["Mia", "M.I.A."],
	])("does not take the node %s for the artist named %s", async (node, name) => {
		const w = world();
		await putArtist("subject", node, SMITH);
		w.byArtist.set(SMITH, credited(SMITH, "Someone Else", 51));
		w.names.set(SMITH, { name });
		await runBackfill(options(w));
		expect(entryOf(await readManifest(), "artist:subject").skipped).toBe("name-mismatch");
	});

	it.each([
		["H.A.W.K.", "H. A. W. K."],
		["Guns N' Roses", "Guns N’ Roses"],
		["Jay-Z", "Jay‐Z"],
		["Atom TM", "Atom™"],
		["Tronik House", "Tronikhouse"],
	])("still takes the node %s for the artist named %s", async (node, name) => {
		const w = world();
		await putArtist("subject", node, SMITH);
		w.byArtist.set(SMITH, credited(SMITH, "Someone Else", 52));
		w.names.set(SMITH, { name });
		await runBackfill(options(w));
		expect(entryOf(await readManifest(), "artist:subject").identity).toBe("alias");
	});

	it("compares a name that mixes scripts whole, and inverts a sort-name only around a single comma", async () => {
		const w = world();
		// "Hikaru 宇多田" must not pass for the artist named just "Hikaru".
		await putArtist("mixed", "Hikaru 宇多田", SMITH);
		w.byArtist.set(SMITH, credited(SMITH, "Someone Else", 45));
		w.names.set(SMITH, { name: "Hikaru", sortName: "Hikaru" });
		// "Wind, Earth" is a "Last, First" form; a name with two commas is not inverted at all.
		await putArtist("comma", "Wind and Fire Earth", OTHER);
		w.byArtist.set(OTHER, credited(OTHER, "Someone Else", 46));
		w.names.set(OTHER, { name: "Earth, Wind, Fire" });

		await runBackfill(options(w));

		const manifest = await readManifest();
		expect(entryOf(manifest, "artist:mixed").skipped).toBe("name-mismatch");
		expect(entryOf(manifest, "artist:comma").skipped).toBe("name-mismatch");
	});

	it("makes one extra request per artist whose credits fail the guard, and none for the others", async () => {
		const w = world();
		await putKode9();
		kode9World(w);
		await putDaftPunk();
		daftWorld(w);
		await sakamotoWorld(w);
		await smithWorld(w);
		// No credited release group at all: nothing to doubt, nothing to look up.
		await putArtist("quiet", "Quiet", OTHER);
		w.byArtist.set(OTHER, []);

		await runBackfill(options(w));

		expect(w.aliasRequests.map((r) => r.artist).sort()).toEqual([SAKAMOTO, SMITH].sort());
		const manifest = await readManifest();
		expect(entryOf(manifest, "artist:kode9").identity).toBe("credit");
		expect(entryOf(manifest, "artist:daft-punk").identity).toBe("credit");
		expect(entryOf(manifest, "artist:quiet").identity).toBeUndefined();
		expect(manifest.totals.identity).toEqual({ credit: 2, alias: 1 });
	});

	it("is unavailable, never accepted, when the alias request fails, whatever the credits say", async () => {
		for (const failure of ["down", undefined] as const) {
			const w = world();
			await sakamotoWorld(w);
			// "down" is a 503, undefined a 404 (no entry for the MBID): neither is an answer.
			if (failure === undefined) w.names.delete(SAKAMOTO);
			else w.names.set(SAKAMOTO, failure);
			const before = await snapshot();

			const result = await runBackfill(options(w, { apply: true }));

			expect(entryOf(await readManifest(), "artist:ryuichi-sakamoto")).toMatchObject({
				skipped: "unavailable",
			});
			expect(result.requests).toEqual({ asked: 1, unavailable: 1 });
			expect(result).toMatchObject({ written: 0, exitCode: 1 });
			expect(await snapshot()).toEqual(before);
		}
	});

	it("gives the same manifest bytes twice, and in a dry-run and an apply, with an alias acceptance", async () => {
		const w = world();
		await sakamotoWorld(w);
		await smithWorld(w);
		await runBackfill(options(w, { manifestPath: manifestFile("dry.json") }));
		await runBackfill(options(w, { manifestPath: manifestFile("dry2.json") }));
		await runBackfill(options(w, { apply: true, manifestPath: manifestFile("apply.json") }));
		const bytes = async (name: string): Promise<string> => readFile(manifestFile(name), "utf8");
		expect(await bytes("dry2.json")).toBe(await bytes("dry.json"));
		expect(await bytes("apply.json")).toBe(await bytes("dry.json"));
	});

	describe("--resume", () => {
		it("carries what a run settled, the alias acceptance and the refusal alike, without a request", async () => {
			const w = world();
			await sakamotoWorld(w);
			await smithWorld(w);
			await runBackfill(options(w, { apply: true }));
			const first = await readFile(manifestFile(), "utf8");
			// Same answers, same cache: only the fetch counters are fresh.
			const w2 = world();
			w2.byArtist = w.byArtist;
			w2.names = w.names;

			const result = await runBackfill(options(w2, { apply: true, resume: true }));

			expect(w2.requests).toEqual([]);
			expect(w2.aliasRequests).toEqual([]);
			expect(result.requests).toEqual({ asked: 0, unavailable: 0 });
			expect(await readFile(manifestFile(), "utf8")).toBe(first);
		});

		it("decides again a name-mismatch recorded before the alias check existed", async () => {
			const w = world();
			await sakamotoWorld(w);
			await runBackfill(options(w));
			const manifest = await readManifest();
			const legacy = entryOf(manifest, "artist:ryuichi-sakamoto");
			// The entry as the pre-TRA-630 run wrote it: a mismatch, no `aliasesChecked`.
			manifest.artists["artist:ryuichi-sakamoto"] = {
				mbid: SAKAMOTO,
				before: legacy.before,
				after: legacy.before,
				withMbidBefore: legacy.withMbidBefore,
				withMbidAfter: legacy.withMbidBefore,
				skipped: "name-mismatch",
				...(legacy.fingerprint === undefined ? {} : { fingerprint: legacy.fingerprint }),
			};
			await writeFile(manifestFile(), JSON.stringify(manifest), "utf8");
			const w2 = world();
			w2.byArtist = w.byArtist;
			w2.names = w.names;

			await runBackfill(options(w2, { resume: true }));

			expect(w2.aliasRequests.map((r) => r.artist)).toEqual([SAKAMOTO]);
			expect(entryOf(await readManifest(), "artist:ryuichi-sakamoto").identity).toBe("alias");
		});
	});
});

describe("determinism and re-runs", () => {
	it("gives the same manifest bytes twice, and the same in a dry-run and in an apply", async () => {
		const w = world();
		kode9World(w);
		daftWorld(w);
		await putKode9();
		await putDaftPunk();
		await runBackfill(options(w, { manifestPath: manifestFile("one.json") }));
		await runBackfill(options(w, { manifestPath: manifestFile("two.json") }));
		await runBackfill(options(w, { apply: true, manifestPath: manifestFile("three.json") }));
		const one = await readFile(manifestFile("one.json"), "utf8");
		expect(await readFile(manifestFile("two.json"), "utf8")).toBe(one);
		expect(await readFile(manifestFile("three.json"), "utf8")).toBe(one);
		expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}T|odyssey-backfill/); // no timestamp, no scratch path
	});

	it("after an apply, a re-run poses and adds nothing for any artist", async () => {
		const w = world();
		kode9World(w);
		daftWorld(w);
		await putKode9();
		await putDaftPunk();
		await runBackfill(options(w, { apply: true }));
		const afterApply = await snapshot();

		const rerun = await runBackfill(options(w, { apply: true, manifestPath: manifestFile("rerun.json") }));

		const manifest = await readManifest(manifestFile("rerun.json"));
		for (const entry of Object.values(manifest.artists)) {
			expect(entry.posed).toEqual([]);
			expect(entry.added).toEqual([]);
		}
		expect(manifest.totals).toMatchObject({ posed: 0, added: 0, written: 0 });
		expect(rerun.written).toBe(0);
		expect(await snapshot()).toEqual(afterApply);
	});

	it("reports the share of edges with an mbid before and after", async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		await runBackfill(options(w));
		const { totals } = await readManifest();
		expect(totals.edges).toMatchObject({ before: 2, withMbidBefore: 0, mbidShareBefore: 0 });
		expect(totals.edges.after).toBe(5);
		expect(totals.edges.withMbidAfter).toBe(4);
		expect(totals.edges.mbidShareAfter).toBe(0.8);
	});
});

describe("--only", () => {
	it("processes only the named artist: one discography, no other node in the manifest", async () => {
		const w = world();
		kode9World(w);
		daftWorld(w);
		await putKode9();
		await putDaftPunk();

		await runBackfill(options(w, { only: ["artist:kode9" as Slug] }));

		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([KODE9]));
		expect(w.requests).toHaveLength(3); // album, ep, single of that one artist
		expect(Object.keys((await readManifest()).artists)).toEqual(["artist:kode9"]);
	});

	it("is a usage error (exit 2, nothing written) when a slug is not an artist of the cache", async () => {
		const w = world();
		await putKode9();
		const result = await runBackfill(options(w, { only: ["artist:nobody" as Slug] }));
		expect(result.exitCode).toBe(2);
		expect(w.requests).toEqual([]);
		await expect(stat(manifestFile())).rejects.toThrow();
	});
});

describe("--resume", () => {
	it("skips an artist whose list is the one the manifest decided, and processes one that changed since", async () => {
		const w = world();
		kode9World(w);
		daftWorld(w);
		await putKode9();
		await putDaftPunk();
		await runBackfill(options(w, { apply: true }));
		const first = await readManifest();

		// Daft Punk's list changes after the run (somebody removed an entry); Kode9's is what was decided.
		const daft = await readNode("artist:daft-punk");
		await writeFile(
			pathOf("artist:daft-punk"),
			`${JSON.stringify({ ...daft, discography: (daft.discography as unknown[]).slice(1) }, null, 2)}\n`,
			"utf8",
		);
		w.requests.length = 0;

		await runBackfill(options(w, { apply: true, resume: true }));

		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([DAFT]));
		const second = await readManifest();
		// The carried artist is in the manifest exactly as decided.
		expect(entryOf(second, "artist:kode9")).toEqual(entryOf(first, "artist:kode9"));
		expect(entryOf(second, "artist:daft-punk").added?.length).toBe(1);
	});

	it("does not take a dry-run's decision for a done job when applying, and retries an unavailable artist", async () => {
		const w = world();
		kode9World(w);
		w.byArtist.set(BURIAL, "down");
		await putKode9();
		await put(
			artistNode("burial", "Burial", {
				mbid: BURIAL,
				discography: [edge("project", "untrue--burial", "Untrue")],
			}),
		);
		await runBackfill(options(w));
		w.requests.length = 0;

		w.byArtist.set(BURIAL, [rg(40, "Untrue", "Album", "2007-11-05", [{ id: BURIAL, name: "Burial" }])]);
		const result = await runBackfill(options(w, { apply: true, resume: true }));

		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([KODE9, BURIAL]));
		expect(result).toMatchObject({ written: 2, exitCode: 0 });
		expect((await readNode("artist:burial")).discography).toMatchObject([{ mbid: mb(1040) }]);
	});

	it("writes a checkpoint of the manifest every 25 artists, while the run goes on", async () => {
		const w = world();
		for (let i = 1; i <= 26; i++) {
			const n = String(i).padStart(2, "0");
			const id = mb(5000 + i);
			await put(artistNode(`a${n}`, `A${n}`, { mbid: id }));
			w.byArtist.set(id, [rg(50 + i, `Record ${n}`, "Album", "2020-01-01", [{ id, name: `A${n}` }])]);
		}
		let midRun = 0;
		w.onRequest = (artist) => {
			if (artist === mb(5026) && midRun === 0) {
				midRun = Object.keys(JSON.parse(readFileSyncOrEmpty(manifestFile())).artists ?? {}).length;
			}
		};
		await runBackfill(options(w, { apply: true }));
		expect(midRun).toBeGreaterThanOrEqual(24);
		expect(Object.keys((await readManifest()).artists)).toHaveLength(26);
	});

	it("keeps the previous decisions of the artists not reached yet in a checkpoint of a resumed run", async () => {
		const w = world();
		for (let i = 1; i <= 26; i++) {
			const n = String(i).padStart(2, "0");
			const id = mb(5100 + i);
			await put(artistNode(`c${n}`, `C${n}`, { mbid: id }));
			w.byArtist.set(id, [rg(150 + i, `Record ${n}`, "Album", "2020-01-01", [{ id, name: `C${n}` }])]);
		}
		// The dry-run decides everything and writes nothing: the apply that resumes from it must redo every artist.
		await runBackfill(options(w));
		let midRun = 0;
		w.onRequest = (artist) => {
			if (artist === mb(5126) && midRun === 0) {
				midRun = Object.keys(JSON.parse(readFileSyncOrEmpty(manifestFile())).artists ?? {}).length;
			}
		};
		await runBackfill(options(w, { apply: true, resume: true }));
		expect(midRun).toBe(26);
	});

	it("decides an artist again when its identity changed, even if its list did not", async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		await runBackfill(options(w, { apply: true }));
		const node = await readNode("artist:kode9");
		const corrected = mb(9);
		await writeFile(
			pathOf("artist:kode9"),
			`${JSON.stringify({ ...node, mbid: corrected }, null, 2)}\n`,
			"utf8",
		);
		w.byArtist.set(corrected, [
			rg(90, "Another Record", "Album", "2020-01-01", [{ id: corrected, name: "Kode9" }]),
		]);
		w.requests.length = 0;

		await runBackfill(options(w, { apply: true, resume: true }));

		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([corrected]));
		expect(entryOf(await readManifest(), "artist:kode9").mbid).toBe(corrected);
	});

	it("gives the manifest of a run in one go after a cut, even for an artist that reached the cap during the run", async () => {
		const w = world();
		// d01 holds 39 entries, all with their mbid: the run adds the 40th, and from then on it is at the cap.
		const d01 = mb(7301);
		const oldWorks = Array.from({ length: 39 }, (_, i) =>
			rg(400 + i, `Old ${i}`, "Album", "2000-01-01", [{ id: d01, name: "D01" }]),
		);
		await put(
			artistNode("d01", "D01", {
				mbid: d01,
				discography: oldWorks.map((g) =>
					edge("project", `${g.title.toLowerCase().replace(" ", "-")}--d01`, g.title, {
						artist: "D01",
						mbid: g.id,
						year: "2000",
						releaseType: "album",
					}),
				),
			}),
		);
		w.byArtist.set(d01, [...oldWorks, rg(500, "New One", "Album", "2021-01-01", [{ id: d01, name: "D01" }])]);
		await putKode9();
		kode9World(w);
		await putDaftPunk();
		daftWorld(w);

		// The reference: one go, dry-run (same bytes as an apply).
		await runBackfill(options(w, { manifestPath: manifestFile("one-go.json") }));
		// The cut: only the first two artists were decided and written, then the rest is resumed.
		await runBackfill(
			options(w, {
				apply: true,
				only: ["artist:d01", "artist:daft-punk"] as Slug[],
				manifestPath: manifestFile("cut.json"),
			}),
		);
		const cut = await readManifest(manifestFile("cut.json"));
		expect(entryOf(cut, "artist:d01").after).toBe(40);
		w.requests.length = 0;
		await runBackfill(options(w, { apply: true, resume: true, manifestPath: manifestFile("cut.json") }));

		// d01 and Daft Punk were carried (not asked again), and the manifest is the one of the run in one go.
		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([KODE9]));
		expect(await readFile(manifestFile("cut.json"), "utf8")).toBe(
			await readFile(manifestFile("one-go.json"), "utf8"),
		);
		expect(entryOf(await readManifest(manifestFile("cut.json")), "artist:d01").skipped).toBeUndefined();
	});

	it("does not replay a manifest written under another policy version", async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		await runBackfill(options(w, { apply: true }));
		w.requests.length = 0;

		// Same cache, same answers, same manifest, but the policy says it decides differently now.
		vi.resetModules();
		vi.doMock("../src/discography-policy.js", async (importOriginal) => ({
			...(await importOriginal<typeof import("../src/discography-policy.js")>()),
			DISCOGRAPHY_POLICY_VERSION: 99,
		}));
		try {
			const next = await import("../scripts/migrations/2026-10-21-backfill-discography-mbid.js");
			(await import("../src/config.js")).musicBrainzConfig.minIntervalMs = 0;
			await next.runBackfill(options(w, { apply: true, resume: true }));
		} finally {
			vi.doUnmock("../src/discography-policy.js");
			vi.resetModules();
		}

		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([KODE9]));
	});
});

describe("one MusicBrainz request at a time", () => {
	it("never has two requests in flight, whatever the number of artists", async () => {
		const w = world();
		for (let i = 1; i <= 6; i++) {
			const id = mb(6000 + i);
			await put(artistNode(`b${i}`, `B${i}`, { mbid: id }));
			w.byArtist.set(id, [rg(60 + i, `Record ${i}`, "Album", "2020-01-01", [{ id, name: `B${i}` }])]);
		}
		await runBackfill(options(w));
		expect(w.requests.length).toBeGreaterThanOrEqual(18);
		expect(w.maxInFlight).toBe(1);
	});
});

describe("near duplicates", () => {
	it('counts "Sine of the Dub" against the existing "Sine of the Dub / Stalker"', async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		await runBackfill(options(w));
		const manifest = await readManifest();
		expect(entryOf(manifest, "artist:kode9").nearDuplicates).toEqual([
			{ added: "project:sine-of-the-dub--kode9", existing: "project:sine-of-the-dub-stalker--kode9" },
		]);
		expect(manifest.totals.nearDuplicate).toBe(1);
	});
});

describe("the year handed to the policy (TRA-628)", () => {
	// 10 voted albums switch the unrated cut on: from then on an unvoted release is kept only if it is recent.
	async function putVotedArtist(w: World): Promise<string> {
		const id = mb(7500);
		const voted = Array.from({ length: 10 }, (_, i) => ({
			...rg(800 + i, `Voted ${i}`, "Album", `${1990 + i}-01-01`, [{ id, name: "G01" }]),
			votes: 3,
		}));
		w.byArtist.set(id, [
			...voted,
			rg(850, "Recent Unvoted", "Album", "2025-03-01", [{ id, name: "G01" }]),
			rg(851, "Old Unvoted", "Album", "2010-03-01", [{ id, name: "G01" }]),
		]);
		await put(artistNode("g01", "G01", { mbid: id }));
		return id;
	}

	it("uses the injected year: a release of last year is spared, an old unvoted one is cut", async () => {
		const w = world();
		await putVotedArtist(w);

		await runBackfill(options(w, { currentYear: 2026 }));
		let entry = entryOf(await readManifest(), "artist:g01");
		expect(entry.added?.map((a) => a.title)).toContain("Recent Unvoted");
		expect(entry.added?.map((a) => a.title)).not.toContain("Old Unvoted");
		expect(entry.excluded?.unrated).toBe(1);

		// Fifteen years on, the same answers: neither is recent any more.
		await runBackfill(options(w, { currentYear: 2040 }));
		entry = entryOf(await readManifest(), "artist:g01");
		expect(entry.added?.map((a) => a.title)).not.toContain("Recent Unvoted");
		expect(entry.excluded?.unrated).toBe(2);
	});

	it("does not replay a resume made under another year", async () => {
		const w = world();
		const id = await putVotedArtist(w);
		await runBackfill(options(w, { apply: true, currentYear: 2026 }));

		w.requests.length = 0;
		await runBackfill(options(w, { apply: true, resume: true, currentYear: 2026 }));
		expect(w.requests).toEqual([]);

		await runBackfill(options(w, { apply: true, resume: true, currentYear: 2027 }));
		expect(new Set(w.requests.map((r) => r.artist))).toEqual(new Set([id]));
	});
});

describe("the date handed to the policy (TRA-654)", () => {
	async function putArtistWithAnnouncedSingle(w: World): Promise<string> {
		const id = mb(7600);
		w.byArtist.set(id, [
			rg(860, "Out Already", "Album", "2020-05-01", [{ id, name: "H01" }]),
			rg(861, "Announced", "Single", "2026-11-20", [{ id, name: "H01" }]),
		]);
		await put(artistNode("h01", "H01", { mbid: id }));
		return id;
	}

	it("uses the injected date: a release group announced for later is counted `future`, not added", async () => {
		const w = world();
		await putArtistWithAnnouncedSingle(w);

		await runBackfill(options(w, { currentDate: "2026-10-24" }));
		let manifest = await readManifest();
		let entry = entryOf(manifest, "artist:h01");
		expect(entry.added?.map((a) => a.title)).toEqual(["Out Already"]);
		expect(entry.excluded?.future).toBe(1);
		expect(manifest.totals.excluded.future).toBe(1);

		// The day after the announced one: the same answers, and it is a release like another.
		await runBackfill(options(w, { currentDate: "2026-11-21" }));
		manifest = await readManifest();
		entry = entryOf(manifest, "artist:h01");
		expect(entry.added?.map((a) => a.title).sort()).toEqual(["Announced", "Out Already"]);
		expect(entry.excluded?.future).toBe(0);
	});

	// The version is in the fingerprint (test above, version 99); the date is not: a resume after midnight UTC
	// would redo every artist for a `future` that rarely changes.
	it("replays a resume made under another date: only the version invalidates it", async () => {
		const w = world();
		await putArtistWithAnnouncedSingle(w);
		await runBackfill(options(w, { apply: true, currentDate: "2026-10-24" }));

		w.requests.length = 0;
		await runBackfill(options(w, { apply: true, resume: true, currentDate: "2026-10-25" }));
		expect(w.requests).toEqual([]);
	});
});

describe("the cap order (TRA-625)", () => {
	it("keeps the voted classic of 1969 over the unvoted records of 2020 when the list is full", async () => {
		const w = world();
		const id = mb(7400);
		const recent = Array.from({ length: 45 }, (_, i) =>
			rg(600 + i, `Archive ${i}`, "Album", `${2020 + (i % 3)}-01-01`, [{ id, name: "F01" }]),
		);
		const classic = { ...rg(700, "Abbey Roadish", "Album", "1969-09-26", [{ id, name: "F01" }]), votes: 12 };
		w.byArtist.set(id, [...recent, classic]);
		await put(artistNode("f01", "F01", { mbid: id }));

		await runBackfill(options(w, { apply: true }));

		const list = (await readNode("artist:f01")).discography as { name: string }[];
		expect(list).toHaveLength(40);
		expect(list.map((e) => e.name)).toContain("Abbey Roadish");
	});
});

describe("the prod node of Kode9 (measured 2026-10-19)", () => {
	it("gains its works, keeps both of its own entries, and flags the single MusicBrainz titles with a suffix", async () => {
		const w = world();
		// Prod: two bare entries (no artist, no year, no type); MusicBrainz has "Sine of the Dub / Stalker".
		await put(
			artistNode("kode9", "Kode9", {
				mbid: KODE9,
				artist_kind: "person",
				discography: [
					{ slug: "project:sine-of-the-dub--kode9" as Slug, type: "project", name: "Sine of the Dub" },
					{ slug: "project:hyperdub-10-3" as Slug, type: "project", name: "Hyperdub 10.3" },
				],
			}),
		);
		w.byArtist.set(KODE9, [
			rg(1, "Memories of the Future", "Album", "2006-05-08", [kode9Credit, spaceapeCredit]),
			rg(2, "Black Sun", "Album", "2011-06-02", [kode9Credit]),
			rg(3, "Nothing", "Album", "2015-04-09", [kode9Credit]),
			rg(4, "Sine of the Dub / Stalker", "Single", "2004-01-01", [kode9Credit]),
		]);

		await runBackfill(options(w, { apply: true }));

		const manifest = await readManifest();
		const entry = entryOf(manifest, "artist:kode9");
		expect(entry.added?.map((a) => a.title)).toEqual(
			expect.arrayContaining(["Memories of the Future", "Black Sun", "Nothing"]),
		);
		expect(entry.nearDuplicates).toEqual([
			{ added: "project:sine-of-the-dub-stalker--kode9", existing: "project:sine-of-the-dub--kode9" },
		]);
		const names = ((await readNode("artist:kode9")).discography as { name: string }[]).map((e) => e.name);
		expect(names).toEqual(
			expect.arrayContaining(["Sine of the Dub", "Hyperdub 10.3", "Sine of the Dub / Stalker"]),
		);
	});
});

describe("an existing node that does not validate", () => {
	it("is counted refused, not rewritten, and the run exits 1", async () => {
		const w = world();
		kode9World(w);
		await putKode9();
		const broken = { ...artistNode("broken", "Broken", { mbid: mb(8) }), editorial_bio: 42 };
		await put(broken);
		const before = await snapshot();

		const result = await runBackfill(options(w, { apply: true }));

		expect(entryOf(await readManifest(), "artist:broken").refused).toBe("invalid-node");
		expect((await readManifest()).totals.refused).toBe(1);
		expect(result.exitCode).toBe(1);
		const after = await snapshot();
		expect(after["/nodes/artist/broken.json"]).toBe(before["/nodes/artist/broken.json"]);
		expect(w.requests.some((r) => r.artist === mb(8))).toBe(false);
	});

	it("refuses a write that the schema would alter (an undeclared field on a discography edge)", async () => {
		const w = world();
		kode9World(w);
		const node = artistNode("kode9", "Kode9", {
			mbid: KODE9,
			discography: [
				edge("project", "memories-of-the-future--kode9", "Memories of the Future", { artist: "Kode9" }),
			],
		});
		const edges = node.discography as unknown as Record<string, unknown>[];
		edges[0] = { ...edges[0], hand_written_note: "kept by a human" };
		await put(node);
		const before = await snapshot();

		const result = await runBackfill(options(w, { apply: true }));

		expect(entryOf(await readManifest(), "artist:kode9").refused).toBeDefined();
		expect(result.exitCode).toBe(1);
		expect(await snapshot()).toEqual(before);
	});
});

describe("parseCliArgs", () => {
	it("parses the usage of the contract", () => {
		expect(
			parseCliArgs([
				"cache",
				"--apply",
				"--manifest",
				"m.json",
				"--data-dir",
				"d",
				"--resume",
				"--only",
				"artist:kode9,artist:burial",
			]),
		).toEqual({
			cacheDir: "cache",
			apply: true,
			resume: true,
			manifestPath: "m.json",
			dataDir: "d",
			only: ["artist:kode9", "artist:burial"],
		});
		expect(parseCliArgs(["cache"])).toMatchObject({
			apply: false,
			resume: false,
			manifestPath: "out/discography-mbid.json",
		});
	});

	it.each([
		[[]],
		[["--apply"]],
		[["cache", "--unknown"]],
		[["cache", "--apply", "--apply"]],
		[["cache", "--only", "artist:a", "--only", "artist:b"]],
		[["cache", "--manifest"]],
		[["cache", "--manifest", "--apply"]],
		[["cache", "--only", "genre:jazz"]],
		[["cache", "--only", "artist:a,,artist:b"]],
		[["cache", "stray"]],
	])("rejects %j", (argv) => {
		expect(parseCliArgs(argv)).toBeNull();
	});
});

function readFileSyncOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "{}";
	}
}
