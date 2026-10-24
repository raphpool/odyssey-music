import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	creditPointers,
	limitMusicBrainzRequests,
	parseCliArgs,
	parseHints,
	runCredit,
	uncreditedWorks,
} from "../scripts/migrations/2026-10-24-credit-uncredited-releases.js";

// TRA-485: credit the works left with `artists: []` when MusicBrainz proves it. MusicBrainz is faked behind fetch (the
// external boundary); mbFetch memoizes by URL for the whole file, so every test uses titles and MBIDs of its own.

type Obj = Record<string, unknown>;
type CacheNode = Parameters<typeof uncreditedWorks>[0][number];

let nextId = 0;
const mbid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

interface FakeWork {
	kind: "release-group" | "recording";
	id: string;
	title: string;
	credit: { id: string; name: string }[];
	date: string;
	primaryType?: string;
}

/** Answers the title searches only: the credit-only mode never asks for a tracklist or a label. */
function stubMb(works: FakeWork[]): { urls: URL[] } {
	const urls: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			urls.push(input);
			const kind = input.pathname.split("/")[3];
			const phrase = /^\w+:"(.*?)"/.exec(input.searchParams.get("query") ?? "")?.[1] ?? "";
			const hits = works
				.filter((w) => w.kind === kind && w.title.toLowerCase() === phrase.toLowerCase())
				.map((w) => ({
					id: w.id,
					title: w.title,
					"artist-credit": w.credit.map((c) => ({ name: c.name, artist: c })),
					"first-release-date": w.date,
					...(w.primaryType ? { "primary-type": w.primaryType } : {}),
				}));
			const body = kind === "recording" ? { recordings: hits } : { "release-groups": hits };
			return { ok: true, status: 200, json: async () => body } as Response;
		}),
	);
	return { urls };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// --- Cache fixtures ---

const article = "A real long article about the test node. ".repeat(4);

const edge = (slug: string, name: string, extra: Obj = {}) => ({
	slug,
	type: slug.slice(0, slug.indexOf(":")),
	name,
	...extra,
});

function artistNode(slug: string, overrides: Obj = {}): Obj {
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

function projectNode(slug: string, name: string, overrides: Obj = {}): Obj {
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

function trackNode(slug: string, name: string, overrides: Obj = {}): Obj {
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

const asNode = (n: Obj): CacheNode => ({
	slug: n.slug as string,
	type: n.type as CacheNode["type"],
	path: `/dev/null/${n.slug}`,
	node: n,
});

let root: string;
let manifestPath: string;
let hintsPath: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "credit-uncredited-"));
	manifestPath = join(root, "out", "credit.json");
	hintsPath = join(root, "hints.json");
	await mkdir(join(root, "cache", "nodes"), { recursive: true });
	await writeHints({});
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const cacheDir = () => join(root, "cache");
const nodePath = (slug: string) => {
	const i = slug.indexOf(":");
	return join(cacheDir(), "nodes", slug.slice(0, i), `${slug.slice(i + 1)}.json`);
};

async function seed(...nodes: Obj[]): Promise<void> {
	for (const node of nodes) {
		await mkdir(join(nodePath(node.slug as string), ".."), { recursive: true });
		await writeFile(nodePath(node.slug as string), `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
}

const readNode = async (slug: string): Promise<Obj> =>
	JSON.parse(await readFile(nodePath(slug), "utf8")) as Obj;

async function writeHints(hints: Obj): Promise<void> {
	await writeFile(hintsPath, JSON.stringify({ source: "test", hints }), "utf8");
}

const run = (apply = false) => runCredit({ cacheDir: cacheDir(), apply, manifestPath, hintsPath });

describe("uncreditedWorks", () => {
	it("selects the projects and tracks whose credit is an empty list, and nothing else", () => {
		const nodes = [
			projectNode("project:empty", "Empty"),
			projectNode("project:credited", "Credited", { artists: [edge("artist:a", "A")] }),
			trackNode("track:empty", "Empty"),
			artistNode("artist:a", { discography: [] }),
		].map(asNode);
		expect([...uncreditedWorks(nodes)].sort()).toEqual(["project:empty", "track:empty"]);
	});
});

describe("creditPointers", () => {
	const artist = edge("artist:band", "Band");

	it("points an uncredited project at the credit of a credited track that names it as its project", () => {
		const nodes = [
			projectNode("project:lp", "LP"),
			trackNode("track:song", "Song", { artists: [artist], project: edge("project:lp", "LP") }),
		].map(asNode);
		const pointers = creditPointers(nodes, uncreditedWorks(nodes));
		expect([...(pointers.get("project:lp") ?? new Map()).keys()]).toEqual(["artist:band"]);
	});

	it("points an uncredited track at the first credit of its project, with the artist node's mbid", () => {
		const id = mbid();
		const nodes = [
			projectNode("project:lp2", "LP2", { artists: [artist] }),
			trackNode("track:song2", "Song2", { project: edge("project:lp2", "LP2") }),
			artistNode("artist:band", { mbid: id }),
		].map(asNode);
		const pointers = creditPointers(nodes, uncreditedWorks(nodes));
		expect(pointers.get("track:song2")?.get("artist:band")).toEqual({ name: "Band", mbid: id });
	});

	it("says nothing about a work that already has a credit", () => {
		const nodes = [
			projectNode("project:lp3", "LP3", { artists: [artist] }),
			trackNode("track:song3", "Song3", { artists: [artist], project: edge("project:lp3", "LP3") }),
		].map(asNode);
		expect(creditPointers(nodes, uncreditedWorks(nodes)).size).toBe(0);
	});
});

describe("parseHints", () => {
	const work = projectNode("project:hinted", "Hinted", { editorial_pitch: "The new album by The Hintees." });
	const nodes = () => [
		asNode(work),
		asNode(artistNode("artist:hintees", { mbid: "11111111-2222-4333-8444-555555555555" })),
	];
	const uncredited = new Set(["project:hinted"]);
	const hint = (extra: Obj = {}) => ({
		source: "test",
		hints: { "project:hinted": { name: "The Hintees", anchor: "The Hintees", why: "pitch", ...extra } },
	});

	it("lends the mbid of the cache artist a hint names", () => {
		const { hints, errors } = parseHints(hint({ artist: "artist:hintees" }), nodes(), uncredited);
		expect(errors).toEqual([]);
		expect(hints.get("project:hinted")).toEqual({
			name: "The Hintees",
			mbid: "11111111-2222-4333-8444-555555555555",
		});
	});

	it("refuses a hint whose anchor is no longer in the work's own text (re-materialized as something else)", () => {
		const { hints, errors } = parseHints(hint({ anchor: "Somebody Else" }), nodes(), uncredited);
		expect(hints.size).toBe(0);
		expect(errors[0]).toContain("anchor");
	});

	it("refuses a hint that names an artist the cache does not hold", () => {
		const { errors } = parseHints(hint({ artist: "artist:nobody" }), nodes(), uncredited);
		expect(errors[0]).toContain("artist:nobody");
	});

	it("ignores a hint for a work that has been credited since (a second run stays quiet)", () => {
		const { hints, errors } = parseHints(hint({ anchor: "Somebody Else" }), nodes(), new Set());
		expect(errors).toEqual([]);
		expect(hints.size).toBe(0);
	});

	it("refuses a file that is not shaped like the hints file", () => {
		expect(parseHints({ hints: { "artist:x": {} } }, nodes(), uncredited).errors).not.toEqual([]);
	});
});

describe("runCredit", () => {
	it("credits a work from the one artist listing it, and writes the credit and the mbid only", async () => {
		const id = mbid();
		const rg = mbid();
		await seed(
			artistNode("artist:acme", { mbid: id, discography: [edge("project:the-acme-lp", "The Acme LP")] }),
			projectNode("project:the-acme-lp", "The Acme LP", { year: "1999" }),
		);
		const mb = stubMb([
			{
				kind: "release-group",
				id: rg,
				title: "The Acme LP",
				credit: [{ id, name: "Acme" }],
				date: "1999-05-01",
				primaryType: "Album",
			},
		]);
		const before = await readNode("project:the-acme-lp");

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		const after = await readNode("project:the-acme-lp");
		expect(after.artists).toEqual([{ slug: "artist:acme", type: "artist", name: "acme", mbid: id }]);
		// The credit and the work's mbid, no year or release type. (The schema may add its empty defaults,
		// `personnel` for instance.)
		const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
		expect(changed.filter((k) => k !== "personnel").sort()).toEqual(["artists", "mbid"]);
		expect(after.mbid).toBe(rg);
		// One search, and no lookup of a tracklist or a label.
		expect(mb.urls).toHaveLength(1);
	});

	it("a dry-run writes the manifest and no node", async () => {
		const id = mbid();
		await seed(
			artistNode("artist:dry", { mbid: id, discography: [edge("project:dry-run-lp", "Dry Run LP")] }),
			projectNode("project:dry-run-lp", "Dry Run LP"),
		);
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Dry Run LP",
				credit: [{ id, name: "Dry" }],
				date: "2001",
				primaryType: "Album",
			},
		]);

		const result = await run(false);

		expect(result.written).toEqual([]);
		expect((await readNode("project:dry-run-lp")).artists).toEqual([]);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { resolved: Obj };
		expect(Object.keys(manifest.resolved)).toEqual(["project:dry-run-lp"]);
	});

	it("takes the hint of a credited track that names the project as its own", async () => {
		const id = mbid();
		await seed(
			artistNode("artist:trackman", { mbid: id }),
			projectNode("project:tracked-lp", "Tracked LP"),
			trackNode("track:tracked-song", "Tracked Song", {
				artists: [edge("artist:trackman", "Trackman")],
				project: edge("project:tracked-lp", "Tracked LP"),
			}),
		);
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Tracked LP",
				credit: [{ id, name: "Trackman" }],
				date: "2010",
				primaryType: "Album",
			},
		]);

		await run(true);

		expect(((await readNode("project:tracked-lp")).artists as Obj[]).map((a) => a.slug)).toEqual([
			"artist:trackman",
		]);
	});

	it("uses a judged hint for a work two artists list, and MusicBrainz still has to confirm it", async () => {
		const bandId = mbid();
		await seed(
			artistNode("artist:the-band", { mbid: bandId, discography: [edge("project:shared-lp", "Shared LP")] }),
			artistNode("artist:the-bassist", { discography: [edge("project:shared-lp", "Shared LP")] }),
			projectNode("project:shared-lp", "Shared LP", { editorial_pitch: "The Band's second album." }),
		);
		await writeHints({
			"project:shared-lp": { name: "The Band", artist: "artist:the-band", anchor: "The Band", why: "pitch" },
		});
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Shared LP",
				credit: [{ id: bandId, name: "The Band" }],
				date: "2003",
				primaryType: "Album",
			},
		]);

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(((await readNode("project:shared-lp")).artists as Obj[]).map((a) => a.slug)).toEqual([
			"artist:the-band",
		]);
	});

	it("leaves a work uncredited when MusicBrainz credits someone else than the hint", async () => {
		const id = mbid();
		await seed(
			artistNode("artist:wrong", {
				mbid: id,
				discography: [edge("project:borrowed-title", "Borrowed Title")],
			}),
			projectNode("project:borrowed-title", "Borrowed Title"),
		);
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Borrowed Title",
				credit: [{ id: mbid(), name: "Another Act" }],
				date: "1990",
				primaryType: "Album",
			},
		]);
		const before = await readFile(nodePath("project:borrowed-title"), "utf8");

		const result = await run(true);

		expect(result.manifest.unresolved.map((u) => `${u.slug} ${u.reason}`)).toEqual([
			"project:borrowed-title credit-mismatch",
		]);
		expect(await readFile(nodePath("project:borrowed-title"), "utf8")).toBe(before);
	});

	it("does not search a work that two artists list and no hint settles", async () => {
		await seed(
			artistNode("artist:one", { discography: [edge("project:two-owners", "Two Owners")] }),
			artistNode("artist:two", { discography: [edge("project:two-owners", "Two Owners")] }),
			projectNode("project:two-owners", "Two Owners"),
		);
		const mb = stubMb([]);

		const result = await run(true);

		expect(result.manifest.ambiguous.map((a) => a.slug)).toEqual(["project:two-owners"]);
		expect(mb.urls).toHaveLength(0);
	});

	it("never looks at a work that already has a credit", async () => {
		await seed(
			artistNode("artist:fine", { discography: [edge("project:fine-lp", "Fine LP")] }),
			projectNode("project:fine-lp", "Fine LP", { artists: [edge("artist:fine", "Fine")] }),
		);
		const mb = stubMb([]);

		const result = await run(true);

		expect(result.exitCode).toBe(0);
		expect(mb.urls).toHaveLength(0);
	});

	it("stays quiet on a second run: a credited work and its hint are not looked at again", async () => {
		const id = mbid();
		await seed(
			artistNode("artist:again", { mbid: id, discography: [edge("project:again-lp", "Again LP")] }),
			projectNode("project:again-lp", "Again LP", { editorial_pitch: "Again, by Again." }),
		);
		await writeHints({ "project:again-lp": { name: "Again", anchor: "by Again", why: "pitch" } });
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Again LP",
				credit: [{ id, name: "Again" }],
				date: "2005",
				primaryType: "Album",
			},
		]);
		await run(true);
		const after = await readFile(nodePath("project:again-lp"), "utf8");

		const second = await run(true);

		expect(second.exitCode).toBe(0);
		expect(second.errors).toEqual([]);
		expect(second.written).toEqual([]);
		expect(await readFile(nodePath("project:again-lp"), "utf8")).toBe(after);
	});

	it("--resume applies what the dry-run resolved and makes no request, not even for the works it left", async () => {
		const id = mbid();
		await seed(
			artistNode("artist:resumed", { mbid: id, discography: [edge("project:resumed-lp", "Resumed LP")] }),
			projectNode("project:resumed-lp", "Resumed LP"),
			artistNode("artist:unknown", { discography: [edge("project:unknown-lp", "Unknown LP")] }),
			projectNode("project:unknown-lp", "Unknown LP"),
		);
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Resumed LP",
				credit: [{ id, name: "Resumed" }],
				date: "2011",
				primaryType: "Album",
			},
		]);
		await run(false);
		const mb = stubMb([]);

		const result = await runCredit({
			cacheDir: cacheDir(),
			apply: true,
			manifestPath,
			hintsPath,
			resume: true,
		});

		expect(result.exitCode).toBe(0);
		expect(mb.urls).toHaveLength(0);
		expect(((await readNode("project:resumed-lp")).artists as Obj[]).map((a) => a.slug)).toEqual([
			"artist:resumed",
		]);
		expect((await readNode("project:unknown-lp")).artists).toEqual([]);
	});

	it("reports a lookup past the request budget as a failure, not as an unknown work", async () => {
		const id = mbid();
		await seed(
			artistNode("artist:capped", { mbid: id, discography: [edge("project:capped-lp", "Capped LP")] }),
			projectNode("project:capped-lp", "Capped LP"),
		);
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Capped LP",
				credit: [{ id, name: "Capped" }],
				date: "2007",
				primaryType: "Album",
			},
		]);
		const meter = limitMusicBrainzRequests(0);
		let result: Awaited<ReturnType<typeof run>>;
		try {
			result = await run(true);
		} finally {
			meter.restore();
		}

		expect(result.exitCode).toBe(1);
		expect(result.failed.map((f) => f.slug)).toEqual(["project:capped-lp"]);
		expect(result.manifest.unresolved).toEqual([]);
		expect((await readNode("project:capped-lp")).artists).toEqual([]);
	});

	it("counts the MusicBrainz requests it lets through", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 }) as Response),
		);
		const meter = limitMusicBrainzRequests(2);
		try {
			await fetch("https://musicbrainz.org/ws/2/release-group?query=a");
			await fetch("https://example.com/not-counted");
			await fetch("https://musicbrainz.org/ws/2/recording?query=b");
			await expect(fetch("https://musicbrainz.org/ws/2/recording?query=c")).rejects.toThrow("budget of 2");
			expect(meter.used()).toBe(2);
		} finally {
			meter.restore();
		}
	});
});

describe("parseCliArgs", () => {
	it("reads the flags", () => {
		expect(parseCliArgs(["cache", "--apply", "--resume", "--budget", "60", "--manifest", "m.json"])).toEqual({
			cacheDir: "cache",
			apply: true,
			resume: true,
			manifestPath: "m.json",
			budget: 60,
		});
	});

	it("refuses an unknown flag, a repeated one and a budget that is not a positive integer", () => {
		expect(parseCliArgs(["cache", "--force"])).toBeNull();
		expect(parseCliArgs(["cache", "--apply", "--apply"])).toBeNull();
		expect(parseCliArgs(["cache", "--budget", "0"])).toBeNull();
		expect(parseCliArgs(["--apply"])).toBeNull();
	});
});
