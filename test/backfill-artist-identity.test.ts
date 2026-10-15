import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	findCollisions,
	type IdentityManifest,
	parseCliArgs,
	runBackfill,
	withIdentity,
} from "../scripts/migrations/2026-10-15-backfill-artist-identity.js";
import {
	fetchArtistEntityMb,
	fetchArtistMembershipsMb,
	resolveArtist,
	resolveArtistDetailed,
} from "../src/musicbrainz.js";
import { nodePayloadSchema } from "../src/schemas.js";
import type { ArtistNode } from "../src/types.js";

// The three MusicBrainz entry points the migration uses stay real (they run against the fake below);
// they are spied on only so tests can count what the migration asks for. mbFetch memoizes by URL for
// the whole file, so counting fetch calls would hide requests.
vi.mock("../src/musicbrainz.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/musicbrainz.js")>();
	return {
		...actual,
		resolveArtistDetailed: vi.fn(actual.resolveArtistDetailed),
		fetchArtistEntityMb: vi.fn(actual.fetchArtistEntityMb),
		fetchArtistMembershipsMb: vi.fn(actual.fetchArtistMembershipsMb),
	};
});

// --- A fake MusicBrainz, behind fetch (the external boundary) ---

interface FakeArtist {
	id: string;
	name: string;
	type?: string;
	score?: number;
	disambiguation?: string;
	area?: string;
	aliases?: string[];
	/** [direction, type, mbid, name] */
	relations?: [string, string, string, string][];
}

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

/**
 * Answers MB's artist search (names and aliases containing the phrase), the entity lookup and the
 * artist-rels lookup from `artists`; collects every requested URL. `down` makes every request fail.
 * Note mbFetch memoizes by URL for the whole file: each test uses names and MBIDs of its own.
 */
function stubMb(artists: FakeArtist[], options: { down?: string[] } = {}): URL[] {
	const urls: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			urls.push(input);
			const [, , , kind, id] = input.pathname.split("/");
			if (kind !== "artist")
				return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
			if (id) {
				const artist = artists.find((a) => a.id === id);
				if (!artist || options.down?.includes(id)) {
					return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
				}
				if (input.searchParams.get("inc") === "artist-rels") {
					return jsonResponse({
						id,
						relations: (artist.relations ?? []).map(([direction, type, mbid, name]) => ({
							direction,
							type,
							artist: { id: mbid, name },
						})),
					});
				}
				return jsonResponse({
					id,
					name: artist.name,
					...(artist.type ? { type: artist.type } : {}),
					...(artist.disambiguation ? { disambiguation: artist.disambiguation } : {}),
				});
			}
			// Like MB: `artist:` matches canonical names, `alias:` matches aliases.
			const [, field = "artist", phrase = ""] =
				/^(artist|alias):"(.*)"$/.exec(input.searchParams.get("query") ?? "") ?? [];
			const indexed = (a: FakeArtist) => (field === "alias" ? (a.aliases ?? []) : [a.name]);
			return jsonResponse({
				artists: artists
					.filter((a) => indexed(a).some((n) => n.toLowerCase().includes(phrase.toLowerCase())))
					.map((a) => ({
						id: a.id,
						name: a.name,
						score: a.score ?? 100,
						...(a.type ? { type: a.type } : {}),
						...(a.disambiguation ? { disambiguation: a.disambiguation } : {}),
						...(a.area ? { area: { name: a.area } } : {}),
						...(a.aliases ? { aliases: a.aliases.map((name) => ({ name })) } : {}),
					})),
			});
		}),
	);
	return urls;
}

/** How many artists the migration sent to MusicBrainz: searches, entity lookups, membership lookups. */
const calls = () => ({
	searches: vi.mocked(resolveArtistDetailed).mock.calls.length,
	entities: vi.mocked(fetchArtistEntityMb).mock.calls.length,
	memberships: vi.mocked(fetchArtistMembershipsMb).mock.calls.length,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// --- resolveArtist ---

describe("resolveArtist", () => {
	it("returns the exact-name artist, not a higher-ranked near-name", async () => {
		stubMb([
			{ id: "a1a1a1a1-0000-4000-8000-000000000001", name: "Ibex Position", type: "Group" },
			{
				id: "a1a1a1a1-0000-4000-8000-000000000002",
				name: "Ibex",
				type: "Person",
				disambiguation: "German producer",
			},
		]);
		expect(await resolveArtist("Ibex")).toEqual({
			mbid: "a1a1a1a1-0000-4000-8000-000000000002",
			name: "Ibex",
			kind: "person",
			disambiguation: "German producer",
		});
	});

	it("ignores candidates under the score bar and null-resolves when none is left", async () => {
		stubMb([{ id: "a2a2a2a2-0000-4000-8000-000000000001", name: "Weakscore", score: 89 }]);
		expect(await resolveArtistDetailed("Weakscore")).toEqual({
			artist: null,
			candidates: 0,
			unavailable: false,
		});
	});

	it("is null with the candidate count when two exact homonyms cannot be told apart", async () => {
		stubMb([
			{ id: "a3a3a3a3-0000-4000-8000-000000000001", name: "Homonym", disambiguation: "UK band" },
			{ id: "a3a3a3a3-0000-4000-8000-000000000002", name: "Homonym", disambiguation: "US singer" },
		]);
		expect(await resolveArtistDetailed("Homonym")).toEqual({
			artist: null,
			candidates: 2,
			unavailable: false,
		});
		// A hint that matches neither is no hint.
		expect(await resolveArtist("Homonym", { origin: "Reykjavik, Iceland" })).toBeNull();
	});

	it("separates homonyms by the hint words found in MB's disambiguation and area", async () => {
		stubMb([
			{
				id: "a4a4a4a4-0000-4000-8000-000000000001",
				name: "Prismic",
				disambiguation: "noise producer",
				area: "Japan",
			},
			{
				id: "a4a4a4a4-0000-4000-8000-000000000002",
				name: "Prismic",
				disambiguation: "rock band",
				area: "Canada",
			},
		]);
		expect((await resolveArtist("Prismic", { origin: "Tokyo, Japan" }))?.mbid).toBe(
			"a4a4a4a4-0000-4000-8000-000000000001",
		);
		expect((await resolveArtist("Prismic", { disambiguator: "Canadian rock band" }))?.mbid).toBe(
			"a4a4a4a4-0000-4000-8000-000000000002",
		);
	});

	it("is null when the hints fit both homonyms equally", async () => {
		stubMb([
			{ id: "a5a5a5a5-0000-4000-8000-000000000001", name: "Twinned", area: "Japan" },
			{ id: "a5a5a5a5-0000-4000-8000-000000000002", name: "Twinned", area: "Japan" },
		]);
		expect(await resolveArtist("Twinned", { origin: "Japan" })).toBeNull();
	});

	it("matches a Latin name to an original-script artist through its alias, only as a fallback", async () => {
		stubMb([
			{
				id: "a6a6a6a6-0000-4000-8000-000000000001",
				name: "坂本龍一",
				type: "Person",
				aliases: ["Ryuichi Sakamotoh"],
			},
		]);
		const out = await resolveArtist("Ryuichi Sakamotoh");
		expect(out?.name).toBe("坂本龍一");
		expect(out?.kind).toBe("person");

		// Another artist merely carrying the name as an alias loses to the canonical name.
		stubMb([
			{ id: "a6a6a6a6-0000-4000-8000-000000000002", name: "Someone Else", aliases: ["Aliasonly"] },
			{ id: "a6a6a6a6-0000-4000-8000-000000000003", name: "Aliasonly" },
		]);
		expect((await resolveArtist("Aliasonly"))?.mbid).toBe("a6a6a6a6-0000-4000-8000-000000000003");
	});

	it("never equates names that normalize to the same Latin remainder across scripts", async () => {
		stubMb([{ id: "a7a7a7a7-0000-4000-8000-000000000001", name: "Группа Zyx" }]);
		expect(await resolveArtist("Rock Zyx")).toBeNull();
		expect(await resolveArtist("Группа Zyx")).not.toBeNull();
		// "ø" has no accent decomposition: slug normalization would turn "Mø" into "m".
		stubMb([{ id: "a7a7a7a7-0000-4000-8000-000000000002", name: "Mq" }]);
		expect(await resolveArtist("Mø")).toBeNull();
	});

	it("is null on a network failure and on a name with nothing to search", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		expect(await resolveArtistDetailed("Unreachable Act")).toEqual({
			artist: null,
			candidates: 0,
			unavailable: true,
		});
		const urls = stubMb([]);
		expect(await resolveArtist('"\\')).toBeNull();
		expect(urls).toHaveLength(0);
	});

	it("skips special-purpose artists and malformed entries one by one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					artists: [
						{ id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists", score: 100 },
						{ id: "not-an-mbid", name: "Brokenid", score: 100 },
						{ id: "a8a8a8a8-0000-4000-8000-000000000001", name: "Brokenid", score: 100 },
					],
				}),
			),
		);
		expect((await resolveArtist("Brokenid"))?.mbid).toBe("a8a8a8a8-0000-4000-8000-000000000001");
		expect(await resolveArtist("Various Artists")).toBeNull();
	});
});

// --- The migration ---

function artistNode(slug: string, overrides: Record<string, unknown> = {}): ArtistNode {
	const body = slug.replace(/^artist:/, "");
	return {
		type: "artist",
		slug,
		name: body,
		editorial_bio: "A test artist bio.",
		editorial_article: "A real long article about the test artist. ".repeat(4),
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
		...overrides,
	} as ArtistNode;
}

let root: string;
let manifestPath: string;

beforeEach(async () => {
	vi.mocked(resolveArtistDetailed).mockClear();
	vi.mocked(fetchArtistEntityMb).mockClear();
	vi.mocked(fetchArtistMembershipsMb).mockClear();
	root = await mkdtemp(join(tmpdir(), "artist-identity-"));
	manifestPath = join(root, "out", "artist-identity.json");
	await mkdir(join(root, "cache", "nodes", "artist"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const cacheDir = () => join(root, "cache");
const nodePath = (slug: string) =>
	join(cacheDir(), "nodes", "artist", `${slug.replace(/^artist:/, "")}.json`);

async function seed(node: ArtistNode): Promise<void> {
	await writeFile(nodePath(node.slug), `${JSON.stringify(node, null, 2)}\n`, "utf8");
}

async function readNode(slug: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(nodePath(slug), "utf8")) as Record<string, unknown>;
}

async function readManifestFile(): Promise<IdentityManifest> {
	return JSON.parse(await readFile(manifestPath, "utf8")) as IdentityManifest;
}

const run = (options: Partial<Parameters<typeof runBackfill>[0]> = {}) =>
	runBackfill({ cacheDir: cacheDir(), apply: false, manifestPath, ...options });

describe("runBackfill", () => {
	const POLE = "b1b1b1b1-0000-4000-8000-000000000001";
	const RONI = "b2b2b2b2-0000-4000-8000-000000000001";
	const REPRAZENT = "b2b2b2b2-0000-4000-8000-000000000002";

	it("reports two slugs resolved on one MBID as a collision and changes only mbid / artist_kind", async () => {
		stubMb([{ id: POLE, name: "Pole", type: "Person", disambiguation: "German electronic musician" }]);
		const a = artistNode("artist:pole", { name: "Pole", origin: "Düsseldorf, Germany" });
		const b = artistNode("artist:pole--stefan-betke", { name: "Pole", disambiguator: "Stefan Betke" });
		await seed(a);
		await seed(b);

		const result = await run({ apply: true });

		expect(result.exitCode).toBe(0);
		expect(result.manifest.collisions).toEqual([
			{ mbid: POLE, slugs: ["artist:pole", "artist:pole--stefan-betke"] },
		]);
		expect(await readNode(a.slug)).toEqual({ ...a, mbid: POLE, artist_kind: "person" });
		expect(await readNode(b.slug)).toEqual({ ...b, mbid: POLE, artist_kind: "person" });
		expect(await readManifestFile()).toEqual({ ...result.manifest });
	});

	it("records the person kind and the bands of Roni Size, and leaves an ambiguous artist intact", async () => {
		stubMb([
			{
				id: RONI,
				name: "Roni Size",
				type: "Person",
				relations: [
					["forward", "member of band", REPRAZENT, "Roni Size / Reprazent"],
					["forward", "collaboration", "b2b2b2b2-0000-4000-8000-000000000003", "Not A Band"],
				],
			},
			{ id: "b3b3b3b3-0000-4000-8000-000000000001", name: "Dupe", disambiguation: "UK band" },
			{ id: "b3b3b3b3-0000-4000-8000-000000000002", name: "Dupe", disambiguation: "US singer" },
		]);
		const roni = artistNode("artist:roni-size", { name: "Roni Size" });
		const dupe = artistNode("artist:dupe", { name: "Dupe" });
		await seed(roni);
		await seed(dupe);
		const dupeBefore = await readFile(nodePath(dupe.slug), "utf8");

		const result = await run({ apply: true });

		expect(result.manifest.resolved["artist:roni-size"]).toEqual({
			mbid: RONI,
			kind: "person",
			groups: [{ mbid: REPRAZENT, name: "Roni Size / Reprazent" }],
		});
		expect((await readNode(roni.slug)).artist_kind).toBe("person");
		expect(result.manifest.unresolved).toEqual([{ slug: "artist:dupe", name: "Dupe", candidates: 2 }]);
		expect(result.manifest.resolved["artist:dupe"]).toBeUndefined();
		expect(await readFile(nodePath(dupe.slug), "utf8")).toBe(dupeBefore);
		expect(result.exitCode).toBe(0);
	});

	it("dry-run writes the manifest and no node; --apply twice writes nothing the second time", async () => {
		stubMb([{ id: "b4b4b4b4-0000-4000-8000-000000000001", name: "Idem", type: "Group" }]);
		await seed(artistNode("artist:idem", { name: "Idem" }));
		const before = await readFile(nodePath("artist:idem"), "utf8");

		const dry = await run();
		expect(dry.written).toEqual([]);
		expect(await readFile(nodePath("artist:idem"), "utf8")).toBe(before);
		expect((await readManifestFile()).resolved["artist:idem"]?.kind).toBe("group");

		const first = await run({ apply: true });
		expect(first.written).toEqual([nodePath("artist:idem")]);
		const afterFirst = await readFile(nodePath("artist:idem"), "utf8");
		const mtime = (await stat(nodePath("artist:idem"))).mtimeMs;

		const second = await run({ apply: true });
		expect(second.written).toEqual([]);
		expect(await readFile(nodePath("artist:idem"), "utf8")).toBe(afterFirst);
		expect((await stat(nodePath("artist:idem"))).mtimeMs).toBe(mtime);
		expect(nodePayloadSchema.parse(await readNode("artist:idem"))).toMatchObject({
			mbid: "b4b4b4b4-0000-4000-8000-000000000001",
			artist_kind: "group",
		});
	});

	it("only writes nodes that still pass nodePayloadSchema, and refuses one that does not", async () => {
		stubMb([
			{ id: "b5b5b5b5-0000-4000-8000-000000000001", name: "Valid One", type: "Person" },
			{ id: "b5b5b5b5-0000-4000-8000-000000000002", name: "Invalid One", type: "Person" },
		]);
		await seed(artistNode("artist:valid-one", { name: "Valid One" }));
		await seed(artistNode("artist:invalid-one", { name: "Invalid One", editorial_article: "too short" }));
		const invalidBefore = await readFile(nodePath("artist:invalid-one"), "utf8");

		const result = await run({ apply: true });

		expect(result.written).toEqual([nodePath("artist:valid-one")]);
		expect(result.failed.map((f) => f.slug)).toEqual(["artist:invalid-one"]);
		expect(result.exitCode).toBe(1);
		expect(await readFile(nodePath("artist:invalid-one"), "utf8")).toBe(invalidBefore);
		expect(() => nodePayloadSchema.parse(JSON.parse(invalidBefore))).toThrow();
		expect(nodePayloadSchema.parse(await readNode("artist:valid-one"))).toMatchObject({
			mbid: "b5b5b5b5-0000-4000-8000-000000000001",
			artist_kind: "person",
		});
	});

	it("reports a failed search as a failure, not as an unknown artist", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => ({}) })),
		);
		await seed(artistNode("artist:search-outage", { name: "Search Outage" }));

		const result = await run({ apply: true });

		expect(result.failed).toEqual([
			{ slug: "artist:search-outage", reason: "MusicBrainz search unavailable" },
		]);
		expect(result.manifest.unresolved).toEqual([]);
		expect(result.exitCode).toBe(1);
	});

	it("refuses a write the schema would turn into more than the two new fields", async () => {
		stubMb([{ id: "b5b5b5b5-0000-4000-8000-000000000003", name: "Edge Extra", type: "Person" }]);
		const edge = { slug: "genre:techno", type: "genre", name: "Techno", undeclared_field: "kept on disk" };
		await seed(artistNode("artist:edge-extra", { name: "Edge Extra", genres: [edge] }));
		const before = await readFile(nodePath("artist:edge-extra"), "utf8");

		const result = await run({ apply: true });

		expect(result.written).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(await readFile(nodePath("artist:edge-extra"), "utf8")).toBe(before);
	});

	it("--resume reuses the manifest: a dry-run followed by --apply --resume asks MusicBrainz nothing", async () => {
		stubMb([
			{ id: "b6b6b6b6-0000-4000-8000-000000000001", name: "Resumable One", type: "Person" },
			{ id: "b6b6b6b6-0000-4000-8000-000000000002", name: "Resumable Two", type: "Group" },
		]);
		await seed(artistNode("artist:resumable-one", { name: "Resumable One" }));
		await seed(artistNode("artist:resumable-two", { name: "Resumable Two" }));
		await run();
		expect(calls()).toEqual({ searches: 2, entities: 2, memberships: 2 });

		const result = await run({ apply: true, resume: true });

		expect(calls()).toEqual({ searches: 2, entities: 2, memberships: 2 });
		expect(result.written).toHaveLength(2);
		expect((await readNode("artist:resumable-two")).artist_kind).toBe("group");
		expect(Object.keys(result.manifest.resolved)).toEqual(["artist:resumable-one", "artist:resumable-two"]);
	});

	it("--resume skips resolved slugs but retries unresolved ones", async () => {
		stubMb([
			{ id: "b7b7b7b7-0000-4000-8000-000000000001", name: "Retry Done", type: "Person" },
			{ id: "b7b7b7b7-0000-4000-8000-000000000002", name: "Retry Pending", area: "Elsewhere" },
			{ id: "b7b7b7b7-0000-4000-8000-000000000003", name: "Retry Pending", area: "Retryland", type: "Group" },
		]);
		await seed(artistNode("artist:retry-done", { name: "Retry Done" }));
		await seed(artistNode("artist:retry-pending", { name: "Retry Pending" }));
		await run();
		expect((await readManifestFile()).unresolved).toHaveLength(1);
		vi.mocked(resolveArtistDetailed).mockClear();

		// The node now carries a hint, as if it had been enriched in between.
		await seed(artistNode("artist:retry-pending", { name: "Retry Pending", origin: "Retryland" }));
		const result = await run({ resume: true });

		expect(vi.mocked(resolveArtistDetailed).mock.calls.map((c) => c[0])).toEqual(["Retry Pending"]);
		expect(result.manifest.unresolved).toEqual([]);
		expect(result.manifest.resolved["artist:retry-pending"]?.kind).toBe("group");
		expect(result.manifest.resolved["artist:retry-done"]?.mbid).toBe("b7b7b7b7-0000-4000-8000-000000000001");
	});

	it("re-queries an artist whose stored mbid disagrees with a reused manifest entry", async () => {
		const stored = "b8b8b8b8-0000-4000-8000-000000000009";
		stubMb([
			{ id: "b8b8b8b8-0000-4000-8000-000000000001", name: "Stale Entry", type: "Person" },
			{ id: stored, name: "Stale Other", type: "Group" },
		]);
		await seed(artistNode("artist:stale-entry", { name: "Stale Entry" }));
		await run();
		await seed(artistNode("artist:stale-entry", { name: "Stale Entry", mbid: stored }));

		const result = await run({ resume: true });

		expect(result.manifest.resolved["artist:stale-entry"]?.mbid).toBe(stored);
		expect(result.manifest.resolved["artist:stale-entry"]?.kind).toBe("group");
	});

	it("does not search for an artist that already has an mbid, and completes its missing kind", async () => {
		const mbid = "b9b9b9b9-0000-4000-8000-000000000001";
		stubMb([{ id: mbid, name: "Already Known", type: "Person" }]);
		await seed(artistNode("artist:already-known", { name: "Already Known", mbid }));

		const result = await run({ apply: true });

		expect(calls()).toEqual({ searches: 0, entities: 1, memberships: 1 });
		expect(await readNode("artist:already-known")).toMatchObject({ mbid, artist_kind: "person" });
		expect(result.written).toHaveLength(1);
	});

	it("also detects a collision with an artist that already carries the mbid", async () => {
		const mbid = "bababaca-0000-4000-8000-000000000001";
		stubMb([{ id: mbid, name: "Twin Name", type: "Person" }]);
		await seed(artistNode("artist:twin-name", { name: "Twin Name", mbid }));
		await seed(artistNode("artist:twin-name--b", { name: "Twin Name" }));

		const result = await run();

		expect(result.manifest.collisions).toEqual([
			{ mbid, slugs: ["artist:twin-name", "artist:twin-name--b"] },
		]);
	});

	it("leaves an artist whose MusicBrainz lookup fails untouched, out of the manifest, with exit code 1", async () => {
		const down = "bcbcbcbc-0000-4000-8000-000000000001";
		stubMb([{ id: down, name: "Flaky Entity", type: "Person" }], { down: [down] });
		await seed(artistNode("artist:flaky-entity", { name: "Flaky Entity" }));
		const before = await readFile(nodePath("artist:flaky-entity"), "utf8");

		const result = await run({ apply: true });

		expect(result.failed).toHaveLength(1);
		expect(result.exitCode).toBe(1);
		expect(result.manifest.resolved).toEqual({});
		expect(result.manifest.unresolved).toEqual([]);
		expect(await readFile(nodePath("artist:flaky-entity"), "utf8")).toBe(before);
	});

	it("--limit caps the artists sent to MusicBrainz, and --resume carries on with the next ones", async () => {
		stubMb([
			{ id: "bdbdbdbd-0000-4000-8000-000000000001", name: "Limit A", type: "Person" },
			{ id: "bdbdbdbd-0000-4000-8000-000000000002", name: "Limit B", type: "Person" },
			{ id: "bdbdbdbd-0000-4000-8000-000000000003", name: "Limit C", type: "Person" },
		]);
		for (const n of ["a", "b", "c"])
			await seed(artistNode(`artist:limit-${n}`, { name: `Limit ${n.toUpperCase()}` }));

		const first = await run({ limit: 2 });
		expect(Object.keys(first.manifest.resolved)).toEqual(["artist:limit-a", "artist:limit-b"]);
		expect(calls().searches).toBe(2);

		const second = await run({ limit: 2, resume: true });
		expect(calls().searches).toBe(3);
		expect(Object.keys(second.manifest.resolved)).toEqual([
			"artist:limit-a",
			"artist:limit-b",
			"artist:limit-c",
		]);
	});

	it("ignores non-artist nodes and refuses to overwrite a manifest it cannot read on --resume", async () => {
		stubMb([]);
		await mkdir(join(cacheDir(), "nodes", "genre"), { recursive: true });
		await writeFile(
			join(cacheDir(), "nodes", "genre", "techno.json"),
			JSON.stringify({ slug: "genre:techno" }),
		);
		await mkdir(join(root, "out"), { recursive: true });
		await writeFile(manifestPath, "{ not json", "utf8");

		await expect(run({ resume: true })).rejects.toThrow();
		expect(await readFile(manifestPath, "utf8")).toBe("{ not json");
		expect((await run()).manifest.resolved).toEqual({});
	});

	it("prints the request budget before the first request", async () => {
		stubMb([{ id: "bebebebe-0000-4000-8000-000000000001", name: "Budgeted", type: "Person" }]);
		await seed(artistNode("artist:budgeted", { name: "Budgeted" }));
		const lines: string[] = [];
		await run({ log: (line) => lines.push(line) });
		expect(lines[0]).toContain("1 artists");
		expect(lines[0]).toContain("3 MusicBrainz requests");
	});
});

describe("withIdentity", () => {
	const entry = { mbid: "c1c1c1c1-0000-4000-8000-000000000001", kind: null, groups: [] };

	it("never erases a kind already stored when MB gives none", () => {
		const node = { slug: "artist:x", artist_kind: "group" };
		expect(withIdentity(node, entry)).toEqual({ ...node, mbid: entry.mbid });
	});

	it("returns null when the node already carries both fields", () => {
		const node = { slug: "artist:x", mbid: entry.mbid, artist_kind: "person" };
		expect(withIdentity(node, { ...entry, kind: "person" })).toBeNull();
	});
});

describe("findCollisions", () => {
	it("lists only MBIDs shared by two slugs or more, sorted", () => {
		const one = { mbid: "c2c2c2c2-0000-4000-8000-000000000001", kind: null, groups: [] };
		const two = { mbid: "c2c2c2c2-0000-4000-8000-000000000002", kind: null, groups: [] };
		expect(findCollisions({ "artist:z": one, "artist:a": one, "artist:m": two })).toEqual([
			{ mbid: one.mbid, slugs: ["artist:a", "artist:z"] },
		]);
	});
});

describe("parseCliArgs", () => {
	it("defaults to a dry-run writing out/artist-identity.json", () => {
		expect(parseCliArgs(["cache"])).toEqual({
			cacheDir: "cache",
			apply: false,
			resume: false,
			manifestPath: DEFAULT_MANIFEST_PATH,
		});
	});

	it("reads every flag", () => {
		expect(parseCliArgs(["cache", "--apply", "--resume", "--limit", "5", "--manifest", "m.json"])).toEqual({
			cacheDir: "cache",
			apply: true,
			resume: true,
			limit: 5,
			manifestPath: "m.json",
		});
	});

	it.each([
		[[]],
		[["--apply"]],
		[["cache", "--aply"]],
		[["cache", "stray"]],
		[["cache", "--limit"]],
		[["cache", "--limit", "0"]],
		[["cache", "--limit", "abc"]],
		[["cache", "--limit", "5", "--limit", "6"]],
		[["cache", "--manifest", "--apply"]],
		[["cache", "--apply", "--apply"]],
	])("refuses %j", (argv) => {
		expect(parseCliArgs(argv)).toBeNull();
	});
});
