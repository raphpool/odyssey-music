import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeRedirects } from "../scripts/migrations/2026-09-04-merge-genre-duplicates.js";
import {
	type FixManifest,
	parseCliArgs,
	releaseTypeFromProse,
	runFix,
	withoutWrongIdentity,
} from "../scripts/migrations/2026-10-20-fix-homonym-work-identity.js";

// TRA-604: the correction end to end, on a temp cache, against a fake MusicBrainz behind fetch (the external
// boundary; the resolvers, the identity code and the cache code are the real ones). The pure detector has its own
// file. mbFetch memoizes by URL for the whole file: every scenario has a title and MBIDs of its own.

// --- A fake MusicBrainz, behind fetch (the external boundary) ---
// mbFetch memoizes by URL for the whole file: every test uses titles and MBIDs of its own.

let nextId = 0;
/** A fresh, valid MBID. */
const mbid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

interface FakeCredit {
	id: string;
	name: string;
	/** What the credit says when it differs from the canonical name. */
	creditedAs?: string;
}

interface FakeWork {
	kind: "release-group" | "recording";
	id: string;
	title: string;
	credit: FakeCredit[];
	date?: string;
	primaryType?: string;
	/** Release groups: MB's secondary types ("Compilation", "Live"...). */
	secondaryTypes?: string[];
	/** MB's note on a recording ("live, Detroit 1998", "DJ-mix"...). */
	disambiguation?: string;
	label?: { id: string; name: string };
	/** Release groups: the tracklist of their earliest release. */
	tracks?: { id: string; title: string }[];
	/** Recordings: the release group they first appeared on. */
	project?: { id: string; title: string };
}

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

const refused = () =>
	({ ok: false, status: 400, headers: new Headers(), json: async () => ({}) }) as Response;

/** A 200 whose body is not JSON (an HTML error page behind a proxy): HTTP says ok, the payload says no. */
const unreadable = () =>
	({
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => {
			throw new SyntaxError("Unexpected token < in JSON at position 0");
		},
	}) as unknown as Response;

interface Stub {
	urls: URL[];
	/** Search queries only. */
	searches: () => string[];
}

/**
 * Answers MB's release-group / recording search (by title only: like MB, it returns look-alikes the
 * migration must sift), and the lookups behind fetchProjectMetaMb / fetchTrackMetaMb. `fail` makes
 * the matching requests fail without a usable answer (`unreadable`: with a 200 that is not JSON). `filterByArtist` makes the `artist:` clause
 * work as MB's does: it only matches the credited names, never an artist's other-script name.
 */
function stubMb(
	works: FakeWork[],
	options: {
		fail?: (url: URL) => boolean;
		unreadable?: (url: URL) => boolean;
		filterByArtist?: boolean;
	} = {},
): Stub {
	const urls: URL[] = [];
	const creditOf = (w: FakeWork) =>
		w.credit.map((c) => ({ name: c.creditedAs ?? c.name, artist: { id: c.id, name: c.name } }));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			urls.push(input);
			if (options.fail?.(input)) return refused();
			if (options.unreadable?.(input)) return unreadable();
			const [, , , kind, id] = input.pathname.split("/");
			if (!id && (kind === "release-group" || kind === "recording")) {
				const [, phrase = "", artist] =
					/^\w+:"(.*?)"(?: AND artist:"(.*)")?$/.exec(input.searchParams.get("query") ?? "") ?? [];
				const credited = (w: FakeWork) =>
					artist === undefined ||
					!options.filterByArtist ||
					w.credit.some((c) => (c.creditedAs ?? c.name).toLowerCase().includes(artist.toLowerCase()));
				const hits = works
					.filter(
						(w) => w.kind === kind && w.title.toLowerCase().includes(phrase.toLowerCase()) && credited(w),
					)
					.map((w) => ({
						id: w.id,
						title: w.title,
						"artist-credit": creditOf(w),
						...(w.date ? { "first-release-date": w.date } : {}),
						...(w.disambiguation ? { disambiguation: w.disambiguation } : {}),
						...(w.primaryType ? { "primary-type": w.primaryType } : {}),
						...(w.secondaryTypes ? { "secondary-types": w.secondaryTypes } : {}),
					}));
				return jsonResponse(kind === "recording" ? { recordings: hits } : { "release-groups": hits });
			}
			const work = works.find((w) => w.id === id);
			if (!work) return refused();
			if (kind === "release-group") {
				return jsonResponse({
					"first-release-date": work.date,
					"primary-type": work.primaryType,
					releases: [{ id: work.id, date: work.date }],
				});
			}
			if (kind === "recording") {
				return jsonResponse({
					"artist-credit": creditOf(work),
					releases: work.project
						? [
								{
									id: work.id,
									date: work.date,
									"release-group": { ...work.project, "primary-type": "Album" },
								},
							]
						: [],
				});
			}
			// /release/<id>: the earliest release of a release group, or of a recording's release group.
			return jsonResponse({
				date: work.date,
				"label-info": work.label ? [{ label: work.label }] : [],
				"artist-credit": creditOf(work),
				media: [
					{ tracks: (work.tracks ?? []).map((t) => ({ id: t.id, recording: { id: t.id, title: t.title } })) },
				],
			});
		}),
	);
	return {
		urls,
		searches: () =>
			urls
				.filter((u) => /\/(release-group|recording)$/.test(u.pathname))
				.map((u) => u.searchParams.get("query") ?? ""),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// --- Cache fixtures ---

const article = "A real long article about the test node. ".repeat(4);

function artistNode(slug: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "artist",
		slug,
		name: slug.replace(/^artist:/, ""),
		editorial_bio: "A test artist bio.",
		editorial_article: article,
		citations: [{ url: "https://example.com/artist", title: "Artist" }],
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
	};
}

function projectNode(slug: string, name: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "project",
		slug,
		name,
		editorial_pitch: "A pitch.",
		editorial_article: article,
		citations: [{ url: "https://example.com/project", title: "Project" }],
		materialized_at: "2026-05-13T13:51:00.910Z",
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		related_projects: [],
		...overrides,
	};
}

function trackNode(slug: string, name: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "track",
		slug,
		name,
		editorial_teaser: "A teaser.",
		editorial_article: article,
		citations: [{ url: "https://example.com/track", title: "Track" }],
		materialized_at: "2026-05-14T09:33:56.770Z",
		artists: [],
		genres: [],
		producers: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
		...overrides,
	};
}

const edge = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
	slug,
	type: slug.slice(0, slug.indexOf(":")),
	name,
	...extra,
});

// --- The scenario: the prod nodes of 2026-10-17, parameterized by title ---

type Obj = Record<string, unknown>;

let root: string;
let manifestPath: string;
let dataDir: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "homonym-identity-"));
	manifestPath = join(root, "out", "fix.json");
	dataDir = join(root, "data");
	await mkdir(join(root, "cache", "nodes"), { recursive: true });
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "genre-redirects.json"), JSON.stringify({ redirects: {} }));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

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

async function seed(...nodes: { slug: string; [key: string]: unknown }[]): Promise<void> {
	for (const node of nodes) {
		await mkdir(join(nodePath(node.slug), ".."), { recursive: true });
		await writeFile(nodePath(node.slug), `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
}
const readNode = async (slug: string): Promise<Obj> =>
	JSON.parse(await readFile(nodePath(slug), "utf8")) as Obj;
const readRedirects = async (): Promise<Record<string, string>> =>
	(
		JSON.parse(await readFile(join(dataDir, "slug-redirects.json"), "utf8")) as {
			redirects: Record<string, string>;
		}
	).redirects;
const readManifest = async (): Promise<FixManifest> =>
	JSON.parse(await readFile(manifestPath, "utf8")) as FixManifest;

const run = (apply: boolean) => runFix({ cacheDir: cacheDir(), apply, manifestPath, dataDir });

const bodyOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const labelNode = (slug: string, name: string) => ({
	type: "label",
	slug,
	name,
	editorial_description: "A label.",
	editorial_article: article,
	citations: [{ url: "https://example.com/label", title: "Label" }],
	materialized_at: "2026-10-01T00:00:00.000Z",
	genres: [],
	roster: [],
	notable_releases: [],
});

interface Scenario {
	title: string;
	old: string;
	next: string;
	hotWax: string;
	floyd: string;
	works: FakeWork[];
}

/**
 * `<title>` by Pink Floyd, in the cache as prod holds it: the node is credited to American Hot Wax, scoped on
 * them, with their mbid, year, release type, tracklist and cover. Pink Floyd lists it twice (the wrong slug
 * and its own) and has it as landmark.
 */
async function homonym(
	title: string,
	options: { floydLists?: boolean; ownNode?: boolean; floydRelease?: boolean } = {},
): Promise<Scenario> {
	const { floydLists = true, ownNode = false, floydRelease = true } = options;
	const hotWax = mbid();
	const floyd = mbid();
	const old = `project:${bodyOf(title)}--american-hot-wax`;
	const next = `project:${bodyOf(title)}--pink-floyd`;
	const works: FakeWork[] = [
		{
			kind: "release-group",
			id: mbid(),
			title,
			credit: [{ id: hotWax, name: "American Hot Wax" }],
			date: "2001-05-01",
			primaryType: "EP",
		},
	];
	if (floydRelease) {
		works.push({
			kind: "release-group",
			id: mbid(),
			title,
			credit: [{ id: floyd, name: "Pink Floyd" }],
			date: "1975-09-12",
			primaryType: "Album",
			label: { id: mbid(), name: "Harvest" },
			tracks: [{ id: mbid(), title: "Have a Cigar" }],
		});
	}
	await seed(
		projectNode(old, title, {
			mbid: works[0]?.id,
			year: "2001",
			release_type: "ep",
			editorial_article: `Pink Floyd's ninth studio album, ${title}, was released in 1975. ${article}`,
			editorial_pitch: `Pink Floyd's 1975 concept album ${title}.`,
			artists: [edge("artist:american-hot-wax", "American Hot Wax", { mbid: hotWax })],
			producers: [edge("artist:pink-floyd", "Pink Floyd")],
			label: edge("label:harvest-records", "Harvest Records"),
			tracklist: [edge("track:six-day-bike-rider", "Six Day Bike Rider", { mbid: mbid() })],
			image_url: "https://coverartarchive.org/release-group/x/front-500",
			image_source: "caa",
		}),
		trackNode("track:six-day-bike-rider", "Six Day Bike Rider", {
			project: edge(old, title),
			artists: [edge("artist:american-hot-wax", "American Hot Wax", { mbid: hotWax })],
		}),
		artistNode("artist:american-hot-wax", {
			name: "American Hot Wax",
			mbid: hotWax,
			discography: [edge(old, title)],
		}),
		artistNode("artist:pink-floyd", {
			name: "Pink Floyd",
			mbid: floyd,
			editorial_article: `Pink Floyd were an English rock band. ${article}`,
			discography: floydLists
				? [
						edge(old, title, { releaseType: "album", year: "1975" }),
						...(ownNode ? [edge(next, title, { releaseType: "album", year: "1975" })] : []),
					]
				: [],
			...(floydLists ? { landmark_project: edge(old, title) } : {}),
		}),
		labelNode("label:harvest-records", "Harvest Records"),
	);
	if (ownNode) {
		await seed(
			projectNode(next, title, {
				artists: [edge("artist:pink-floyd", "Pink Floyd", { mbid: floyd })],
				editorial_article: `${title} is an album by Pink Floyd. ${article}`,
			}),
		);
	}
	await writeFile(
		join(dataDir, "slug-redirects.json"),
		JSON.stringify({
			source: "release slug scoping",
			generated_at: "2026-10-16T00:00:00.000Z",
			redirects: { [`project:${bodyOf(title)}`]: old },
		}),
	);
	return { title, old, next, hotWax, floyd, works };
}

describe("runFix: Wish You Were Here, credited to American Hot Wax", () => {
	it("gives the album Pink Floyd's identity, scope and edges, and lists it once on Pink Floyd's page", async () => {
		const s = await homonym("Wish You Were Here", { ownNode: true });
		stubMb(s.works, { filterByArtist: true });

		const result = await run(true);

		expect(result.manifest.failed).toEqual([]);
		expect(result.exitCode).toBe(0);
		expect(result.manifest.fixed).toHaveLength(1);
		expect(await exists(s.old)).toBe(false);
		const fixed = await readNode(s.next);
		expect(fixed).toMatchObject({
			slug: s.next,
			mbid: s.works[1]?.id,
			year: "1975",
			release_type: "album",
			artists: [{ slug: "artist:pink-floyd", name: "Pink Floyd", mbid: s.floyd }],
			// What the LLM wrote stays: the prose, the producers, and the label without an MB id.
			producers: [{ slug: "artist:pink-floyd" }],
			label: { slug: "label:harvest-records" },
		});
		expect(String(fixed.editorial_article)).toContain("ninth studio album");
		// What the wrong identity gave is gone: its cover and its tracklist (replaced by the right release's).
		expect(fixed.image_url).toBeUndefined();
		expect(fixed.image_source).toBeUndefined();
		expect((fixed.tracklist as Obj[]).map((t) => t.name)).toEqual(["Have a Cigar"]);

		const floyd = await readNode("artist:pink-floyd");
		expect((floyd.discography as Obj[]).map((e) => e.slug)).toEqual([s.next]);
		expect((floyd.landmark_project as Obj).slug).toBe(s.next);
		expect((await readNode("artist:american-hot-wax")).discography).toEqual([]);
		// A track of the wrong release no longer points at the album.
		expect((await readNode("track:six-day-bike-rider")).project).toBeUndefined();

		const redirects = await readRedirects();
		expect(redirects[s.old]).toBe(s.next);
		expect(redirects["project:wish-you-were-here"]).toBe(s.next);
		const manifest = await readManifest();
		expect(manifest.renamed).toEqual({ [s.old]: s.next });
		expect(manifest.redirects).toMatchObject({ [s.old]: s.next, "project:wish-you-were-here": s.next });
		expect(manifest.fixed[0]).toMatchObject({ merged: true, artist: "artist:pink-floyd" });
	});

	it("moves the slug to a new file when no node of Pink Floyd's own exists yet", async () => {
		const s = await homonym("Wish Two");
		stubMb(s.works, { filterByArtist: true });

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(await exists(s.old)).toBe(false);
		expect((await readNode(s.next)).mbid).toBe(s.works[1]?.id);
		expect(result.manifest.fixed[0]?.merged).toBe(false);
		const floyd = await readNode("artist:pink-floyd");
		expect((floyd.discography as Obj[]).map((e) => e.slug)).toEqual([s.next]);
	});

	it("writes nothing in a dry-run and reports the same manifest as the apply", async () => {
		const s = await homonym("Wish Three");
		stubMb(s.works, { filterByArtist: true });
		const before = await readFile(nodePath(s.old), "utf8");
		const redirectsBefore = await readFile(join(dataDir, "slug-redirects.json"), "utf8");

		const dry = await run(false);

		expect(dry.written).toEqual([]);
		expect(await readFile(nodePath(s.old), "utf8")).toBe(before);
		expect(await readFile(join(dataDir, "slug-redirects.json"), "utf8")).toBe(redirectsBefore);
		const applied = await run(true);
		expect(applied.manifest).toEqual(dry.manifest);
	});

	it("is idempotent: a second run finds nothing to do", async () => {
		const s = await homonym("Wish Four");
		stubMb(s.works, { filterByArtist: true });
		await run(true);

		const again = await run(true);

		expect(again.exitCode).toBe(0);
		expect(again.written).toEqual([]);
		expect(again.manifest.summary).toMatchObject({ suspects: 0, fixed: 0, stripped: 0 });
	});

	it("removes the wrong mbid and credit, and reports the node, when MusicBrainz has no release of Pink Floyd", async () => {
		const s = await homonym("Wish Five", { floydRelease: false });
		stubMb(s.works, { filterByArtist: true });

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(result.manifest.stripped).toEqual([
			{ slug: s.old, artist: "artist:pink-floyd", reason: "no-match", droppedEdges: 2 },
		]);
		const node = await readNode(s.old);
		expect(node.mbid).toBeUndefined();
		expect(node.artists).toEqual([]);
		expect(node.year).toBeUndefined();
		expect(node.release_type).toBeUndefined();
		expect(node.image_url).toBeUndefined();
		expect(node.tracklist).toEqual([]);
		// The slug stays (no replacement identity, no redirect) and the homonym stops listing the work.
		expect(result.manifest.renamed).toEqual({});
		expect((await readNode("artist:american-hot-wax")).discography).toEqual([]);
		expect((await readNode("artist:pink-floyd")).discography).toHaveLength(1);
	});

	it("leaves a work alone when the article's artist is only a producer and MusicBrainz has nothing", async () => {
		const s = await homonym("Wish Six", { floydLists: false, floydRelease: false });
		stubMb(s.works, { filterByArtist: true });
		const before = await readFile(nodePath(s.old), "utf8");

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(result.manifest.skipped).toEqual([
			{ slug: s.old, reason: "no-replacement-weak-evidence", artists: ["artist:pink-floyd"] },
		]);
		expect(await readFile(nodePath(s.old), "utf8")).toBe(before);
	});

	it("does not re-credit a work to an artist its prose only mentions further down (Jah Wobble for a PiL single)", async () => {
		const s = await homonym("Wish Ten");
		const node = await readNode(s.old);
		await seed({
			...node,
			slug: s.old,
			editorial_pitch: "A confrontational post-punk anthem.",
			editorial_article: `${article.repeat(4)} The bass was played by Pink Floyd.`,
		});
		stubMb(s.works, { filterByArtist: true });
		const before = await readFile(nodePath(s.old), "utf8");

		const result = await run(true);

		expect(result.manifest.skipped).toEqual([
			{ slug: s.old, reason: "article-artist-not-in-lead", artists: ["artist:pink-floyd"] },
		]);
		expect(result.exitCode).toBe(0);
		expect(await readFile(nodePath(s.old), "utf8")).toBe(before);
	});

	it("writes nothing and exits 1 while MusicBrainz does not answer", async () => {
		const s = await homonym("Wish Seven");
		stubMb(s.works, { fail: (url) => /release-group$/.test(url.pathname) });
		const before = await readFile(nodePath(s.old), "utf8");

		const result = await run(true);

		expect(result.exitCode).toBe(1);
		expect(result.manifest.failed).toEqual([{ slug: s.old, reason: "MusicBrainz search unavailable" }]);
		expect(result.written).toEqual([]);
		expect(await readFile(nodePath(s.old), "utf8")).toBe(before);
	});

	it("refuses to merge into a node of another identity and lists the conflict", async () => {
		const s = await homonym("Wish Eight", { ownNode: true });
		stubMb(s.works, { filterByArtist: true });
		await seed(
			projectNode(s.next, s.title, {
				mbid: mbid(),
				artists: [edge("artist:pink-floyd", "Pink Floyd", { mbid: s.floyd })],
			}),
		);
		const before = await readFile(nodePath(s.old), "utf8");

		const result = await run(true);

		expect(result.manifest.conflicts).toEqual([{ slug: s.old, to: s.next, reason: "target-other-identity" }]);
		expect(await readFile(nodePath(s.old), "utf8")).toBe(before);
	});

	it("keeps a bare slug where it is and only fixes the identity", async () => {
		const s = await homonym("Wish Nine");
		const bare = `project:${bodyOf(s.title)}`;
		// The same work, under its bare slug: nothing in the slug names the homonym.
		const node = await readNode(s.old);
		await rm(nodePath(s.old));
		await seed(
			{ ...node, slug: bare } as { slug: string },
			artistNode("artist:american-hot-wax", {
				name: "American Hot Wax",
				mbid: s.hotWax,
				discography: [edge(bare, s.title)],
			}),
			artistNode("artist:pink-floyd", {
				name: "Pink Floyd",
				mbid: s.floyd,
				editorial_article: `Pink Floyd were an English rock band. ${article}`,
				discography: [edge(bare, s.title, { releaseType: "album", year: "1975" })],
			}),
		);
		await writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects: {} }));
		stubMb(s.works, { filterByArtist: true });

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(result.manifest.renamed).toEqual({});
		expect((await readNode(bare)).mbid).toBe(s.works[1]?.id);
		expect(await readRedirects()).toEqual({});
	});
});

describe("runFix: Around the World, credited to Stanley Black", () => {
	it("re-credits the track to Daft Punk and drops the project and label MusicBrainz gave it", async () => {
		const stanley = mbid();
		const daft = mbid();
		const old = "track:around-the-world--stanley-black";
		const next = "track:around-the-world--daft-punk";
		const works: FakeWork[] = [
			{
				kind: "recording",
				id: mbid(),
				title: "Around the World",
				credit: [{ id: stanley, name: "Stanley Black" }],
				date: "1958",
			},
			{
				kind: "recording",
				id: mbid(),
				title: "Around the World",
				credit: [{ id: daft, name: "Daft Punk" }],
				date: "1997-01-20",
				project: { id: mbid(), title: "Homework" },
				label: { id: mbid(), name: "Virgin" },
			},
		];
		await seed(
			trackNode(old, "Around the World", {
				mbid: works[0]?.id,
				year: "1958",
				editorial_article: `Released in 1997, Around the World is a single by Daft Punk. ${article}`,
				editorial_teaser: "A French house classic.",
				artists: [edge("artist:stanley-black", "Stanley Black", { mbid: stanley })],
				producers: [edge("artist:daft-punk", "Daft Punk")],
				project: edge("project:hollywood-love-themes", "Hollywood Love Themes", { mbid: mbid() }),
				label: edge("label:london-records", "London Records", { mbid: mbid() }),
			}),
			artistNode("artist:stanley-black", {
				name: "Stanley Black",
				mbid: stanley,
				notable_tracks: [edge(old, "Around the World")],
			}),
			artistNode("artist:daft-punk", {
				name: "Daft Punk",
				mbid: daft,
				notable_tracks: [edge("track:around-the-world", "Around the World")],
			}),
			projectNode("project:hollywood-love-themes", "Hollywood Love Themes", {
				tracklist: [edge(old, "Around the World")],
			}),
			labelNode("label:london-records", "London Records"),
		);
		await writeFile(
			join(dataDir, "slug-redirects.json"),
			JSON.stringify({ redirects: { "track:around-the-world": old } }),
		);
		stubMb(works, { filterByArtist: true });

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(await exists(old)).toBe(false);
		const fixed = await readNode(next);
		expect(fixed).toMatchObject({
			mbid: works[1]?.id,
			year: "1997",
			artists: [{ slug: "artist:daft-punk", mbid: daft }],
			label: { name: "Virgin" },
			project: { name: "Homework" },
		});
		// Daft Punk listed the BARE slug, which the table sent to the homonym: it now reads the right track.
		expect((await readRedirects())["track:around-the-world"]).toBe(next);
		expect((await readNode("artist:stanley-black")).notable_tracks).toEqual([]);
		expect((await readNode("project:hollywood-love-themes")).tracklist).toEqual([]);
	});
});

describe("releaseTypeFromProse", () => {
	it("reads the one release type the prose names, and nothing when it names none or several", () => {
		const of = (pitch: string, article = "") =>
			releaseTypeFromProse({ editorial_pitch: pitch, editorial_article: article });
		expect(of("Pink Floyd's 1975 concept album.", "Pink Floyd's ninth studio album, released in 1975.")).toBe(
			"album",
		);
		expect(of("A 1983 single by Tears for Fears.")).toBe("single");
		expect(of("A four-track EP.")).toBe("ep");
		expect(of("An album and its single.")).toBeUndefined();
		// Whole words only: a hyphenated compound names no release type.
		expect(of("A single-minded record.")).toBeUndefined();
		expect(of("Explore Bill Laswell's dub compilation.")).toBeUndefined();
	});
});

describe("withoutWrongIdentity: year and release type", () => {
	it("keeps a year and a release type the node's own prose states, drops the ones it contradicts", () => {
		const prose = { editorial_article: "A studio album, released in 1975." };
		expect(withoutWrongIdentity({ ...prose, year: "1975", release_type: "album" })).toMatchObject({
			year: "1975",
			release_type: "album",
		});
		const dropped = withoutWrongIdentity({ ...prose, year: "2001", release_type: "ep" });
		expect(dropped.year).toBeUndefined();
		expect(dropped.release_type).toBeUndefined();
	});
});

describe("withoutWrongIdentity", () => {
	it("keeps the edges the LLM wrote (no mbid) and the prose, and removes what carries an MB id", () => {
		const node = {
			mbid: "x",
			year: "2001",
			release_type: "ep",
			artists: [{ slug: "artist:a" }],
			label: { slug: "label:l", name: "L" },
			project: { slug: "project:p", name: "P", mbid: "y" },
			tracklist: [{ slug: "track:t", mbid: "z" }, { slug: "track:u" }],
			editorial_article: "text",
			image_url: "https://cover.example/x.jpg",
			image_source: "itunes",
		};
		expect(withoutWrongIdentity(node)).toEqual({
			artists: [],
			label: node.label,
			tracklist: node.tracklist,
			editorial_article: "text",
			image_url: node.image_url,
			image_source: "itunes",
		});
	});
});

describe("parseCliArgs", () => {
	it("accepts the channel's flags and refuses anything else", () => {
		expect(parseCliArgs(["cache", "--apply", "--manifest", "m.json", "--data-dir", "d"])).toEqual({
			cacheDir: "cache",
			apply: true,
			manifestPath: "m.json",
			dataDir: "d",
		});
		expect(parseCliArgs(["cache"])?.manifestPath).toBe("out/fix-homonym-work-identity.json");
		expect(parseCliArgs(["cache", "--apply", "--apply"])).toBeNull();
		expect(parseCliArgs(["cache", "--manifest"])).toBeNull();
		expect(parseCliArgs(["cache", "--bogus"])).toBeNull();
		expect(parseCliArgs([])).toBeNull();
	});
});

// --- TRA-610: the latent defects the deep review of #535 found, and the tests it said were missing ---

const writePending = (pending: Record<string, unknown>) =>
	writeFile(join(cacheDir(), "pending-reverses.json"), JSON.stringify(pending));
const readPending = async (): Promise<Record<string, unknown[]>> =>
	JSON.parse(await readFile(join(cacheDir(), "pending-reverses.json"), "utf8")) as Record<string, unknown[]>;

/** The channel's step between the preview and the apply: the pairs the preview lists are committed (flattened). */
async function commitRedirects(pairs: Record<string, string>): Promise<void> {
	const path = join(dataDir, "slug-redirects.json");
	const table = JSON.parse(await readFile(path, "utf8")) as { redirects: Record<string, string> };
	await writeFile(path, JSON.stringify({ ...table, redirects: mergeRedirects(table.redirects, pairs) }));
}

describe("runFix: latent defects of #535 (TRA-610)", () => {
	it("(a) takes the artist's mbid from its node, never from its list entry, which carries the WORK's", async () => {
		const s = await homonym("Latent A");
		const floyd = (await readNode("artist:pink-floyd")) as Obj;
		const entry = (floyd.discography as Obj[])[0] as Obj;
		// The cache has no mbid for the artist; the entry of its discography has the release group's.
		await seed({
			...floyd,
			slug: "artist:pink-floyd",
			mbid: undefined,
			discography: [{ ...entry, mbid: s.works[1]?.id }],
		});
		stubMb(s.works, { filterByArtist: true });

		const result = await run(true);

		expect(result.manifest.stripped).toEqual([]);
		expect(result.manifest.fixed).toHaveLength(1);
		expect((await readNode(s.next)).mbid).toBe(s.works[1]?.id);
	});

	/**
	 * `project:<body>--hot-wax` (A) is Pink Floyd's, credited to a homonym. `project:<body>--pink-floyd` (T) is
	 * credited to Pink Floyd but is Roger Waters' work, so it is a suspect of its own, whose right slug is
	 * `--roger-waters`. A's right slug is T's: A would be merged into a node that is itself being moved.
	 */
	async function mergeIntoSuspect(title: string, rogerInLead: boolean) {
		const body = bodyOf(title);
		const [hotWax, floyd, roger] = [mbid(), mbid(), mbid()];
		const a = `project:${body}--hot-wax`;
		const t = `project:${body}--pink-floyd`;
		const works: FakeWork[] = [
			{
				kind: "release-group",
				id: mbid(),
				title,
				credit: [{ id: floyd, name: "Pink Floyd" }],
				date: "1975",
				primaryType: "Album",
			},
			{
				kind: "release-group",
				id: mbid(),
				title,
				credit: [{ id: roger, name: "Roger Waters" }],
				date: "1992",
				primaryType: "Album",
			},
		];
		await seed(
			projectNode(a, title, {
				mbid: mbid(),
				editorial_pitch: `Pink Floyd's 1975 album ${title}.`,
				artists: [edge("artist:hot-wax", "Hot Wax", { mbid: hotWax })],
			}),
			projectNode(t, title, {
				editorial_pitch: rogerInLead ? `Roger Waters' 1992 album ${title}.` : "A record.",
				editorial_article: `${article.repeat(rogerInLead ? 1 : 4)} Roger Waters wrote it.`,
				artists: [edge("artist:pink-floyd", "Pink Floyd", { mbid: floyd })],
				producers: [edge("artist:roger-waters", "Roger Waters")],
			}),
			artistNode("artist:hot-wax", { name: "Hot Wax", mbid: hotWax, discography: [edge(a, title)] }),
			artistNode("artist:pink-floyd", {
				name: "Pink Floyd",
				mbid: floyd,
				editorial_bio: "Pink Floyd were an English rock band.",
				editorial_article: `Pink Floyd were an English rock band. ${article}`,
				discography: [
					edge(a, title, { releaseType: "album", year: "1975" }),
					edge(t, title, { releaseType: "album", year: "1975" }),
				],
			}),
			artistNode("artist:roger-waters", {
				name: "Roger Waters",
				mbid: roger,
				editorial_bio: "Roger Waters is a bassist.",
				editorial_article: `Roger Waters is a bassist. ${article}`,
				discography: [edge(t, title, { releaseType: "album", year: "1992" })],
			}),
		);
		await writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects: {} }));
		stubMb(works, { filterByArtist: true });
		return { a, t, moved: `project:${body}--roger-waters` };
	}

	it("(b) raises a conflict instead of merging into a node that is itself renamed (a node was lost)", async () => {
		const s = await mergeIntoSuspect("Latent B", true);
		const before = await readFile(nodePath(s.a), "utf8");

		const result = await run(true);

		expect(result.manifest.conflicts).toEqual([{ slug: s.a, to: s.t, reason: "target-is-renamed" }]);
		expect(result.manifest.renamed).toEqual({ [s.t]: s.moved });
		// Nothing of A was merged into T and then deleted with it: A is where it was.
		expect(await readFile(nodePath(s.a), "utf8")).toBe(before);
		expect(await exists(s.moved)).toBe(true);
	});

	it("(b) raises a conflict instead of merging into a node that is itself suspect and left as it is", async () => {
		const s = await mergeIntoSuspect("Latent B2", false);
		const before = await readFile(nodePath(s.t), "utf8");

		const result = await run(true);

		expect(result.manifest.skipped).toMatchObject([{ slug: s.t, reason: "article-artist-not-in-lead" }]);
		expect(result.manifest.conflicts).toEqual([{ slug: s.a, to: s.t, reason: "target-is-suspect" }]);
		expect(await readFile(nodePath(s.t), "utf8")).toBe(before);
		expect(await exists(s.a)).toBe(true);
	});

	it("(c) finds the same suspect in the apply as in the preview once the preview's redirects are committed", async () => {
		const s = await homonym("Latent C");
		// Pink Floyd lists the BARE slug only, and nothing in the work names Pink Floyd as a producer: the redirect
		// is the only evidence there is.
		const bare = `project:${bodyOf(s.title)}`;
		const floyd = (await readNode("artist:pink-floyd")) as Obj;
		await seed(
			{
				...floyd,
				slug: "artist:pink-floyd",
				discography: [edge(bare, s.title, { releaseType: "album", year: "1975" })],
			},
			{ ...(await readNode(s.old)), slug: s.old, producers: [] },
		);
		stubMb(s.works, { filterByArtist: true });

		const preview = await run(false);
		expect(preview.manifest.fixed).toHaveLength(1);
		await commitRedirects(preview.manifest.redirects);
		const applied = await run(true);

		expect(applied.manifest.summary.suspects).toBe(1);
		expect(applied.manifest.renamed).toEqual(preview.manifest.renamed);
		expect(await exists(s.old)).toBe(false);
		expect((await readNode(s.next)).mbid).toBe(s.works[1]?.id);
	});

	it("(d) applies the reverse edges waiting under the new slug, and keeps the ones the runtime does not emit", async () => {
		const [stanley, daft] = [mbid(), mbid()];
		const old = "track:latent-d--stanley-black";
		const next = "track:latent-d--daft-punk";
		const works: FakeWork[] = [
			{ kind: "recording", id: mbid(), title: "Latent D", credit: [{ id: stanley, name: "Stanley Black" }] },
			{
				kind: "recording",
				id: mbid(),
				title: "Latent D",
				credit: [{ id: daft, name: "Daft Punk" }],
				date: "1997",
			},
		];
		await seed(
			trackNode(old, "Latent D", {
				mbid: works[0]?.id,
				editorial_article: `Released in 1997, Latent D is a single by Daft Punk. ${article}`,
				artists: [edge("artist:stanley-black", "Stanley Black", { mbid: stanley })],
				producers: [edge("artist:daft-punk", "Daft Punk")],
			}),
			artistNode("artist:stanley-black", {
				name: "Stanley Black",
				mbid: stanley,
				notable_tracks: [edge(old, "Latent D")],
			}),
			artistNode("artist:daft-punk", { name: "Daft Punk", mbid: daft }),
		);
		await writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects: {} }));
		// A track that samples the work, and a credit from a namesake's list (a direction the runtime no longer emits).
		const safe = { field: "sampled_by", cardinality: "list", edge: edge("track:sampler", "Sampler") };
		const unsafe = { field: "artists", cardinality: "list", edge: edge("artist:namesake", "Namesake") };
		await writePending({ [next]: [safe, unsafe] });
		stubMb(works, { filterByArtist: true });

		const result = await run(true);

		expect(result.manifest.fixed).toHaveLength(1);
		expect(((await readNode(next)).sampled_by as Obj[]).map((e) => e.slug)).toEqual(["track:sampler"]);
		expect(await readPending()).toEqual({ [next]: [unsafe] });
	});

	it("(e) reports the edges of one slug that carry two mbids when a rename folds them, and keeps both", async () => {
		const s = await homonym("Latent E", { ownNode: true });
		const floyd = (await readNode("artist:pink-floyd")) as Obj;
		const [wrongMbid, rightMbid] = [mbid(), mbid()];
		await seed({
			...floyd,
			slug: "artist:pink-floyd",
			discography: [
				edge(s.old, s.title, { mbid: wrongMbid, releaseType: "album", year: "1975" }),
				edge(s.next, s.title, { mbid: rightMbid, releaseType: "album", year: "1975" }),
			],
		});
		stubMb(s.works, { filterByArtist: true });

		const result = await run(true);

		expect(result.manifest.edgeConflicts).toEqual([
			expect.objectContaining({ at: "artist:pink-floyd.discography", slug: s.next }),
		]);
		expect(result.manifest.summary.edgeConflicts).toBe(1);
		const kept = ((await readNode("artist:pink-floyd")).discography as Obj[]).map((e) => e.mbid);
		expect(kept).toEqual([wrongMbid, rightMbid]);
	});

	// The redirect keys of the work lead to the old slug before the preview's pairs are committed, to the new one after.
	describe.each([
		["before", false],
		["after", true],
	])("(f) with the preview's redirects committed: %s", (_, committed) => {
		/** The sequence of the channel: preview, the pairs committed or not, apply. */
		async function previewThenApply(works: FakeWork[]) {
			stubMb(works, { filterByArtist: true });
			if (committed) await commitRedirects((await run(false)).manifest.redirects);
			return run(true);
		}

		it("folds an edge naming the bare slug with the one naming the renamed work (Harvest Records)", async () => {
			const s = await homonym(`Latent F ${committed}`);
			const bare = `project:${bodyOf(s.title)}`;
			const label = (await readNode("label:harvest-records")) as Obj;
			await seed({
				...label,
				slug: "label:harvest-records",
				notable_releases: [edge(bare, s.title), edge(s.old, s.title)],
			});

			const result = await previewThenApply(s.works);

			expect(result.exitCode).toBe(0);
			const listed = (await readNode("label:harvest-records")).notable_releases as Obj[];
			expect(listed.map((e) => e.slug)).toEqual([s.next]);
		});

		it("drops the wrong artist's edge when it names the work by its bare slug", async () => {
			const s = await homonym(`Latent F2 ${committed}`);
			const bare = `project:${bodyOf(s.title)}`;
			const hotWax = (await readNode("artist:american-hot-wax")) as Obj;
			await seed({ ...hotWax, slug: "artist:american-hot-wax", discography: [edge(bare, s.title)] });

			await previewThenApply(s.works);

			expect((await readNode("artist:american-hot-wax")).discography).toEqual([]);
		});
	});

	it("(g) does not pick the studio album when the prose says the work is a compilation, and strips nothing", async () => {
		const s = await homonym("Latent G", { floydRelease: false });
		const node = (await readNode(s.old)) as Obj;
		await seed({ ...node, slug: s.old, editorial_pitch: "Pink Floyd's 2011 compilation album Latent G." });
		const before = await readFile(nodePath(s.old), "utf8");
		const release = (date: string, secondaryTypes?: string[]): FakeWork => ({
			kind: "release-group",
			id: mbid(),
			title: s.title,
			credit: [{ id: s.floyd, name: "Pink Floyd" }],
			date,
			primaryType: "Album",
			...(secondaryTypes ? { secondaryTypes } : {}),
		});
		stubMb([...s.works, release("1975-09-12"), release("2011-09-26", ["Compilation"])], {
			filterByArtist: true,
		});

		const result = await run(true);

		expect(result.manifest.fixed).toEqual([]);
		expect(result.manifest.stripped).toEqual([]);
		expect(result.manifest.skipped).toEqual([
			{ slug: s.old, reason: "compilation-unsettled", artists: ["artist:pink-floyd"] },
		]);
		expect(await readFile(nodePath(s.old), "utf8")).toBe(before);
	});
});

describe("runFix: cases the review of #535 found untested (TRA-610)", () => {
	it("removes the wrong identity when MusicBrainz is ambiguous about the article artist's release", async () => {
		const s = await homonym("Untested One", { floydRelease: false });
		// Two plain albums of Pink Floyd on the same date: MusicBrainz cannot tell which is the work.
		const twin = (): FakeWork => ({
			kind: "release-group",
			id: mbid(),
			title: s.title,
			credit: [{ id: s.floyd, name: "Pink Floyd" }],
			date: "1975-09-12",
			primaryType: "Album",
		});
		stubMb([...s.works, twin(), twin()], { filterByArtist: true });

		const result = await run(true);

		expect(result.manifest.fixed).toEqual([]);
		expect(result.manifest.stripped).toMatchObject([{ slug: s.old, reason: "ambiguous-candidates" }]);
		const node = await readNode(s.old);
		expect(node.mbid).toBeUndefined();
		expect(node.artists).toEqual([]);
	});

	it("leaves the work alone (already-consistent) when MusicBrainz finds the very identity it carries", async () => {
		const s = await homonym("Untested Two");
		const node = (await readNode(s.old)) as Obj;
		// The mbid is the right release group's: only the credit edge is the homonym's.
		await seed({ ...node, slug: s.old, mbid: s.works[1]?.id });
		stubMb(s.works, { filterByArtist: true });
		const before = await readFile(nodePath(s.old), "utf8");

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(result.manifest.skipped).toEqual([
			{ slug: s.old, reason: "already-consistent", artists: ["artist:pink-floyd"] },
		]);
		expect(await readFile(nodePath(s.old), "utf8")).toBe(before);
		expect(result.written).toEqual([]);
	});

	it("drops the pending reverse edges that pointed at the wrong work, and the keys they leave empty", async () => {
		const s = await homonym("Untested Three");
		const node = (await readNode(s.old)) as Obj;
		const ghost = (name: string) => edge(`track:${name}`, name, { mbid: mbid() });
		// Two neighbours of the wrong release whose own node was never written: reverse edges wait for them.
		await seed({
			...node,
			slug: s.old,
			tracklist: [...(node.tracklist as Obj[]), ghost("ghost-one"), ghost("ghost-two")],
		});
		const toWrong = { field: "project", cardinality: "single", edge: edge(s.old, s.title) };
		const other = { field: "project", cardinality: "single", edge: edge("project:another", "Another") };
		await writePending({
			"track:ghost-one": [toWrong, other],
			"track:ghost-two": [toWrong],
			"track:unrelated": [other],
		});
		stubMb(s.works, { filterByArtist: true });

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(await readPending()).toEqual({ "track:ghost-one": [other], "track:unrelated": [other] });
	});

	it("gives the same result when the preview's redirects are committed before the apply (preview, commit, apply)", async () => {
		const s = await homonym("Untested Four");
		stubMb(s.works, { filterByArtist: true });
		const preview = await run(false);
		expect(preview.manifest.redirects).toMatchObject({ [s.old]: s.next });

		await commitRedirects(preview.manifest.redirects);
		const applied = await run(true);

		expect(applied.exitCode).toBe(0);
		expect(applied.manifest.renamed).toEqual(preview.manifest.renamed);
		expect(applied.manifest.fixed).toEqual(preview.manifest.fixed);
		expect(applied.manifest.summary).toEqual(preview.manifest.summary);
		// The pairs are committed already: the apply has none left to ask for.
		expect(applied.manifest.redirects).toEqual({});
		expect(await exists(s.old)).toBe(false);
		expect((await readRedirects())[s.old]).toBe(s.next);
		expect((await run(true)).written).toEqual([]);
	});
});
