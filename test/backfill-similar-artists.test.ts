import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BackfillOptions,
	formatSummary,
	MAX_UNAVAILABLE_RATE,
	MIGRATION_NAME,
	parseCliArgs,
	runBackfill,
	type SimilarManifest,
} from "../scripts/migrations/2026-10-19-backfill-similar-artists.js";
import { listenBrainzConfig } from "../src/config.js";
import { parseSlug } from "../src/slug.js";
import type { ArtistNode } from "../src/types.js";
import { artistNode, edge } from "./images/helpers.js";

// TRA-490: the similar_artists backfill, offline. Only the network boundary is replaced (the injected
// `fetch`); the resolver (TRA-468), the cache layout and the node schema are the real ones.

const mb = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const row = (n: number, name: string, score: number) => ({
	artist_mbid: mb(n),
	name,
	comment: "",
	type: "Group",
	gender: null,
	score,
	reference_mbid: mb(1),
});

type Answer = (mbid: string) => Response | Promise<Response>;
type MockFetch = typeof fetch & ReturnType<typeof vi.fn>;
function lbFetch(answer: Answer): MockFetch {
	return vi.fn(async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		return answer(url.searchParams.get("artist_mbids") ?? "");
	}) as unknown as MockFetch;
}
const lbDown = (): MockFetch => lbFetch(() => new Response("", { status: 503 }));
// The strong link of the graph fallback (TRA-603): a common collaborator. One shared genre is no longer enough.
const shared = (): ReturnType<typeof edge>[] => [edge("artist", "go-between", "Go Between")];

let dir: string;
let scratch: string;
let dataDir: string;
const suiteInterval = listenBrainzConfig.minIntervalMs;

beforeEach(async () => {
	listenBrainzConfig.minIntervalMs = 0;
	scratch = await mkdtemp(join(tmpdir(), "odyssey-backfill-similar-"));
	dir = join(scratch, "cache");
	await mkdir(join(dir, "nodes"), { recursive: true });
	dataDir = join(scratch, "data");
	await writeRedirects({});
});

afterEach(async () => {
	listenBrainzConfig.minIntervalMs = suiteInterval;
	await rm(scratch, { recursive: true, force: true });
});

async function writeRedirects(redirects: Record<string, string>): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "slug-redirects.json"), JSON.stringify({ redirects }), "utf8");
}

const manifestFile = (): string => join(scratch, "out", "similar.json");
const pathOf = (slug: string): string => {
	const { type, body } = parseSlug(slug);
	return join(dir, "nodes", type, `${body}.json`);
};
const serialize = (node: unknown): string => `${JSON.stringify(node, null, 2)}\n`;
async function put(node: unknown, slug: string): Promise<void> {
	await mkdir(dirname(pathOf(slug)), { recursive: true });
	await writeFile(pathOf(slug), serialize(node), "utf8");
}
async function putArtist(slug: string, name: string, extra: Partial<ArtistNode> = {}): Promise<ArtistNode> {
	const node = artistNode(slug, name, extra);
	await put(node, node.slug);
	return node;
}
const raw = (slug: string): Promise<string> => readFile(pathOf(slug), "utf8");
const read = async (slug: string): Promise<ArtistNode> => JSON.parse(await raw(slug)) as ArtistNode;

async function snapshot(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const type of await readdir(join(dir, "nodes"))) {
		for (const f of await readdir(join(dir, "nodes", type))) {
			out[`${type}/${f}`] = await readFile(join(dir, "nodes", type, f), "utf8");
		}
	}
	return out;
}

function run(options: Partial<BackfillOptions> = {}) {
	return runBackfill({ cacheDir: dir, apply: true, manifestPath: manifestFile(), dataDir, ...options });
}

describe("similar_artists backfill (TRA-490)", () => {
	describe("ListenBrainz", () => {
		it("writes 10 edges for an artist with an mbid, on the cached slug when the MBID is cached", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			// A cached artist reachable by MBID, under a slug makeSlug(name) would NOT reproduce.
			await putArtist("the-cure--uk", "The Cure", { mbid: mb(2) });
			const rows = [
				row(2, "The Cure", 100),
				...Array.from({ length: 11 }, (_, i) => row(i + 3, `Act ${i + 3}`, 90 - i)),
			];
			const fetchFn = lbFetch(() => jsonResponse(rows));

			const result = await run({ fetch: fetchFn });

			const seed = await read("artist:seed");
			expect(seed.similar_artists).toHaveLength(10);
			expect(seed.similar_artists[0]).toEqual({
				slug: "artist:the-cure--uk",
				type: "artist",
				name: "The Cure",
				mbid: mb(2),
			});
			expect(seed.similar_artists[1]).toMatchObject({ slug: "artist:act-3", mbid: mb(3) });
			expect(result.manifest.listenbrainz).toContain("artist:seed");
			expect(result.exitCode).toBe(0);
			expect(fetchFn).toHaveBeenCalledWith(
				expect.objectContaining({ hostname: "labs.api.listenbrainz.org" }),
				expect.objectContaining({ redirect: "error" }),
			);
		});

		it("falls back to the graph for an artist without mbid, without any request", async () => {
			await putArtist("seed", "Seed", { collaborators: shared() });
			await putArtist("peer", "Peer", { collaborators: shared() });
			const fetchFn = lbDown();

			const result = await run({ fetch: fetchFn });

			expect(fetchFn).not.toHaveBeenCalled();
			expect((await read("artist:seed")).similar_artists).toEqual([
				{ slug: "artist:peer", type: "artist", name: "Peer" },
			]);
			expect(result.manifest.graph).toContainEqual({ slug: "artist:seed", reason: "no-mbid" });
		});

		it.each([
			["429", () => new Response("", { status: 429, headers: { "Retry-After": "1" } }), "lb-unavailable"],
			["503", () => new Response("", { status: 503 }), "lb-unavailable"],
			["a network error", () => Promise.reject(new TypeError("fetch failed")), "lb-unavailable"],
			["a 404", () => new Response("", { status: 404 }), "lb-rejected"],
		] as const)("falls back to the graph on %s: counted, not an error", async (_label, answer, reason) => {
			await putArtist("seed", "Seed", { mbid: mb(1), collaborators: shared() });
			await putArtist("peer", "Peer", { collaborators: shared() });
			// Five more artists ListenBrainz answers (nothing): 1 request in 6 unavailable stays under the threshold.
			for (let i = 20; i < 25; i++) await putArtist(`calm-${i}`, `Calm ${i}`, { mbid: mb(i) });

			const result = await run({ fetch: lbFetch((id) => (id === mb(1) ? answer() : jsonResponse([]))) });

			expect(result.manifest.errors).toEqual([]);
			expect(result.exitCode).toBe(0);
			expect(result.manifest.graph).toContainEqual({ slug: "artist:seed", reason });
			expect(result.manifest.counts.errors).toBe(0);
			expect(result.manifest.fallbacks[reason]).toBeGreaterThanOrEqual(1);
			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:peer"]);
			expect(result.listenbrainzRequests).toEqual({
				asked: 6,
				unavailable: reason === "lb-unavailable" ? 1 : 0,
			});
		});

		it("never uses an invalid answer: not an array, or rows that fail the schema", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1), collaborators: shared() });
			await putArtist("peer", "Peer", { collaborators: shared() });
			await putArtist("other", "Other", { mbid: mb(9), collaborators: shared() });
			const answers: Record<string, unknown> = {
				[mb(1)]: { error: "oops", artists: [row(5, "Evil", 9)] },
				[mb(9)]: [
					{ artist_mbid: "not-an-mbid", name: "Evil One", score: 9 },
					{ artist_mbid: mb(6), name: "", score: 9 },
					{ artist_mbid: mb(7), name: "No Score" },
					"junk",
					null,
				],
			};

			const result = await run({ fetch: lbFetch((id) => jsonResponse(answers[id])) });

			expect(result.manifest.errors).toEqual([]);
			expect(result.manifest.listenbrainz).toEqual([]);
			expect(result.manifest.graph).toEqual([
				{ slug: "artist:other", reason: "lb-no-usable-edge" },
				{ slug: "artist:peer", reason: "no-mbid" },
				{ slug: "artist:seed", reason: "lb-no-usable-edge" },
			]);
			const slugs = (await read("artist:seed")).similar_artists.map((e) => e.slug);
			expect(slugs).toEqual(["artist:other", "artist:peer"]);
			expect((await read("artist:other")).similar_artists.map((e) => e.slug)).not.toContain(
				"artist:evil-one",
			);
		});

		it("lists an artist with nothing safe in none, and leaves its file untouched", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			const before = await raw("artist:seed");

			const result = await run({ fetch: lbFetch(() => jsonResponse([])) });

			expect(result.manifest.none).toEqual([{ slug: "artist:seed", reason: "lb-no-usable-edge" }]);
			expect(result.written).toEqual([]);
			expect(await raw("artist:seed")).toBe(before);
		});
	});

	describe("safety: no edge to a cached artist on a name alone", () => {
		it("drops a candidate whose name slug is a cached homonym with another (or no) mbid", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await putArtist("nirvana", "Nirvana", { mbid: mb(50) }); // the band; LB means another Nirvana
			await putArtist("genesis", "Genesis"); // cached, no mbid at all
			await putArtist("yes", "Yes", { mbid: mb(3) }); // same artist: the MBID agrees
			const rows = [
				row(2, "Nirvana", 100),
				row(4, "Genesis", 90),
				row(3, "Yes", 80),
				row(5, "Fresh Act", 70),
			];

			// Only the seed is asked about these rows; the cached artists get an empty answer.
			const result = await run({ fetch: lbFetch((id) => jsonResponse(id === mb(1) ? rows : [])) });

			expect((await read("artist:seed")).similar_artists.map((e) => [e.slug, e.mbid])).toEqual([
				["artist:yes", mb(3)],
				["artist:fresh-act", mb(5)],
			]);
			expect(result.manifest.unsafeCandidates).toBe(2);
			expect(result.manifest.listenbrainz).toContain("artist:seed");
		});

		it("falls back to the graph when every candidate was unsafe", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1), collaborators: shared() });
			await putArtist("nirvana", "Nirvana", { mbid: mb(50), collaborators: shared() });

			const result = await run({ fetch: lbFetch(() => jsonResponse([row(2, "Nirvana", 100)])) });

			// The edge is the graph's, to the cached Nirvana, found by structure and carrying ITS mbid.
			expect((await read("artist:seed")).similar_artists).toEqual([
				{ slug: "artist:nirvana", type: "artist", name: "Nirvana", mbid: mb(50) },
			]);
			expect(result.manifest.graph).toContainEqual({ slug: "artist:seed", reason: "lb-no-usable-edge" });
		});

		it("refuses an mbid that the cache holds for a node that is not an artist", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			const label = { ...artistNode("x", "Some Label"), type: "label", slug: "label:somelabel", mbid: mb(2) };
			await put(label, "label:somelabel");

			const result = await run({ fetch: lbFetch(() => jsonResponse([row(2, "Some Label", 100)])) });

			expect(result.manifest.unsafeCandidates).toBe(1);
			expect((await read("artist:seed")).similar_artists).toEqual([]);
		});
	});

	describe("writing", () => {
		it("changes similar_artists and nothing else, key order and bytes included", async () => {
			const seed = await putArtist("seed", "Seed", {
				mbid: mb(1),
				editorial_bio: 'Bio with "quotes", accents éè and a\nnewline.',
				collaborators: shared(),
			});
			// A key order that is NOT the schema's: similar_artists first.
			const { similar_artists, ...rest } = seed;
			await put({ similar_artists, ...rest }, "artist:seed");
			const before = await raw("artist:seed");

			await run({ fetch: lbFetch(() => jsonResponse([row(2, "Peer", 5)])) });

			const after = await raw("artist:seed");
			const expected = before.replace(
				'"similar_artists": []',
				'"similar_artists": [\n    {\n      "slug": "artist:peer",\n      "type": "artist",\n      "name": "Peer",\n      "mbid": "' +
					mb(2) +
					'"\n    }\n  ]',
			);
			expect(after).toBe(expected);
			expect(after).not.toBe(before);
		});

		it("adds the field to a file that predates it, and touches no other file (no inverse edge)", async () => {
			const { similar_artists: _gone, ...old } = artistNode("seed", "Seed", { mbid: mb(1) });
			await put(old, "artist:seed");
			await putArtist("bystander", "Bystander", { mbid: mb(8) });
			const bystander = await raw("artist:bystander");

			await run({ fetch: lbFetch((id) => jsonResponse(id === mb(1) ? [row(2, "Peer", 5)] : [])) });

			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:peer"]);
			expect(await raw("artist:bystander")).toBe(bystander);
			expect(await readdir(join(dir, "nodes", "artist"))).toEqual(["bystander.json", "seed.json"]);
			expect(await readdir(dir)).toEqual(["nodes"]);
		});

		it("refuses to write a node the schema would alter, and exits 1", async () => {
			await put(
				{ ...artistNode("seed", "Seed", { mbid: mb(1) }), undeclared_field: "by hand" },
				"artist:seed",
			);
			const before = await raw("artist:seed");

			const result = await run({ fetch: lbFetch(() => jsonResponse([row(2, "Peer", 5)])) });

			expect(result.exitCode).toBe(1);
			expect(result.manifest.errors).toEqual([
				{ slug: "artist:seed", reason: "refusing to write: validation would alter fields the node carries" },
			]);
			expect(await raw("artist:seed")).toBe(before);
		});

		it("lists an unreadable artist file in errors and exits 1, still resolving the others", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await writeFile(pathOf("artist:broken"), "{ not json", "utf8");

			const result = await run({ fetch: lbFetch(() => jsonResponse([row(2, "Peer", 5)])) });

			expect(result.exitCode).toBe(1);
			expect(result.manifest.errors.map((e) => e.slug)).toEqual(["artist:broken"]);
			expect((await read("artist:seed")).similar_artists).toHaveLength(1);
		});

		it("writes nothing without --apply, and the manifest is the one an apply gives", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await putArtist("loner", "Loner");
			const fetchFn = lbFetch(() => jsonResponse([row(2, "Peer", 5)]));
			const before = await snapshot();

			const dry = await run({ apply: false, fetch: fetchFn });
			expect(await snapshot()).toEqual(before);
			expect(dry.written).toEqual([]);
			const dryManifest = await readFile(manifestFile(), "utf8");

			const applied = await run({ apply: true, fetch: fetchFn });
			expect(applied.written).toHaveLength(1);
			expect(await readFile(manifestFile(), "utf8")).toBe(dryManifest);
		});
	});

	describe("idempotence and the manifest", () => {
		it("a second run changes no byte and asks ListenBrainz nothing", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await run({ fetch: lbFetch(() => jsonResponse([row(2, "Peer", 5)])) });
			const after = await snapshot();

			const fetchFn = lbFetch(() => jsonResponse([row(3, "Someone Else", 9)]));
			const again = await run({ fetch: fetchFn });

			expect(await snapshot()).toEqual(after);
			expect(again.written).toEqual([]);
			expect(fetchFn).not.toHaveBeenCalled();
		});

		it("gives the channel's contract and the distribution, sorted, with no timestamp", async () => {
			await putArtist("zed", "Zed", { mbid: mb(1) });
			await putArtist("alpha", "Alpha", { mbid: mb(2) });
			await putArtist("mid", "Mid", { mbid: mb(3), collaborators: shared() });
			await putArtist("friend", "Friend", { collaborators: shared() });
			await putArtist("lonely", "Lonely");
			const answers: Record<string, () => Response> = {
				[mb(1)]: () => jsonResponse([row(10, "Out One", 3)]),
				[mb(2)]: () => jsonResponse([row(11, "Out Two", 3)]),
				[mb(3)]: () => new Response("", { status: 429 }),
			};

			const result = await run({ fetch: lbFetch((id) => answers[id]?.() ?? jsonResponse([])) });
			const onDisk = JSON.parse(await readFile(manifestFile(), "utf8")) as SimilarManifest;

			expect(onDisk).toEqual(result.manifest);
			expect(onDisk).toEqual({
				migration: MIGRATION_NAME,
				removed: [],
				renamed: {},
				redirects: {},
				counts: { listenbrainz: 2, graph: 2, none: 1, kept: 0, errors: 0 },
				fallbacks: { "no-mbid": 2, "lb-unavailable": 1, "lb-rejected": 0, "lb-no-usable-edge": 0 },
				unsafeCandidates: 0,
				ambiguousSlugs: [],
				edgeDigests: {
					"artist:alpha": expect.stringMatching(/^[0-9a-f]{16}$/),
					"artist:friend": expect.stringMatching(/^[0-9a-f]{16}$/),
					"artist:mid": expect.stringMatching(/^[0-9a-f]{16}$/),
					"artist:zed": expect.stringMatching(/^[0-9a-f]{16}$/),
				},
				listenbrainz: ["artist:alpha", "artist:zed"],
				graph: [
					{ slug: "artist:friend", reason: "no-mbid" },
					{ slug: "artist:mid", reason: "lb-unavailable" },
				],
				none: [{ slug: "artist:lonely", reason: "no-mbid" }],
				kept: [],
				errors: [],
			});
			expect(JSON.stringify(onDisk)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("--force and --resume", () => {
		it("--force replaces a fallback by ListenBrainz's answer once it is back", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1), collaborators: shared() });
			await putArtist("peer", "Peer", { collaborators: shared() });
			await run({ fetch: lbDown() });
			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:peer"]);

			const result = await run({ force: true, fetch: lbFetch(() => jsonResponse([row(2, "Real Peer", 5)])) });

			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:real-peer"]);
			expect(result.manifest.listenbrainz).toEqual(["artist:seed"]);
			expect(result.manifest.graph.map((g) => g.slug)).not.toContain("artist:seed");
		});

		it("--force never trades existing edges for a fallback or for nothing", async () => {
			const existing = [edge("artist", "kept", "Kept", { mbid: mb(7) })];
			await putArtist("seed", "Seed", { mbid: mb(1), similar_artists: existing });
			await putArtist("other", "Other", { similar_artists: existing });
			const before = await snapshot();

			const result = await run({ force: true, fetch: lbDown() });

			expect(await snapshot()).toEqual(before);
			expect(result.written).toEqual([]);
			expect(result.manifest.kept).toEqual([
				{ slug: "artist:other", reason: "no-mbid" },
				{ slug: "artist:seed", reason: "lb-unavailable" },
			]);
			// An outage during a --force run is visible even for nodes that kept their edges.
			expect(result.manifest.fallbacks).toMatchObject({ "no-mbid": 1, "lb-unavailable": 1 });
			expect(result.manifest.none).toEqual([]);
		});

		it("--force rewrites nothing when ListenBrainz gives the edges the node already has", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			const fetchFn = lbFetch(() => jsonResponse([row(2, "Peer", 5)]));
			await run({ fetch: fetchFn });

			const result = await run({ force: true, fetch: fetchFn });

			expect(result.written).toEqual([]);
			expect(result.manifest.listenbrainz).toEqual(["artist:seed"]);
		});

		it("--resume keeps what the previous manifest settled and does not ask for it again", async () => {
			await putArtist("done", "Done", { mbid: mb(1) });
			await putArtist("todo", "Todo", { mbid: mb(2) });
			// Dry-runs: nothing on disk, only the manifest remembers. First run: `todo` meets an outage.
			await run({
				apply: false,
				fetch: lbFetch((id) =>
					id === mb(1) ? jsonResponse([row(5, "A", 1)]) : new Response("", { status: 503 }),
				),
			});

			const fetchFn = lbFetch(() => jsonResponse([row(6, "B", 1)]));
			const result = await run({ apply: false, force: true, resume: true, fetch: fetchFn });

			expect(fetchFn).toHaveBeenCalledTimes(1);
			expect(String(fetchFn.mock.calls[0]?.[0])).toContain(mb(2));
			expect(result.manifest.listenbrainz).toEqual(["artist:done", "artist:todo"]);
			expect(result.manifest.graph).toEqual([]);
		});
	});

	describe("--apply --resume from a dry-run's manifest", () => {
		it("writes what the dry-run only decided, and asks again for nothing it already wrote", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await putArtist("loner", "Loner");
			await run({ apply: false, fetch: lbFetch(() => jsonResponse([row(2, "Peer", 5)])) });
			expect((await read("artist:seed")).similar_artists).toEqual([]);

			const fetchFn = lbFetch(() => jsonResponse([row(2, "Peer", 5)]));
			const applied = await run({ apply: true, resume: true, fetch: fetchFn });
			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:peer"]);
			expect(applied.written).toHaveLength(1);

			// Now on disk: a further --resume skips it and keeps it in the manifest.
			const again = await run({ apply: true, resume: true, force: true, fetch: fetchFn });
			expect(fetchFn).toHaveBeenCalledTimes(1);
			expect(again.written).toEqual([]);
			expect(again.manifest.listenbrainz).toEqual(["artist:seed"]);
		});
	});

	describe("a timeout while the body is coming", () => {
		it("is an outage (lb-unavailable), not an invalid body", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			const stalled = vi.fn(async (_input: unknown, init?: RequestInit) => {
				// Headers arrive, then the body stalls until the client's own timeout aborts the request.
				const body = new Promise<unknown>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				});
				return { ok: true, status: 200, json: () => body } as unknown as Response;
			}) as unknown as typeof fetch;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const pending = run({ fetch: stalled });
				// The file reads are real I/O: wait until the request is out before moving the clock.
				while ((stalled as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				await vi.advanceTimersByTimeAsync(6_000);
				const result = await pending;

				expect(result.manifest.none).toEqual([{ slug: "artist:seed", reason: "lb-unavailable" }]);
				expect(result.manifest.errors).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// 2026-10-17, deep review of PR #522. None of these tests sets ODYSSEY_SCOPED_RELEASE_SLUGS, like the
	// channel (flag off): the slugs they expect are the canonical (flag-on) ones, the cache's.
	describe("canonical slugs and the redirect table", () => {
		it("drops Gokhan Kirdar (dotless i) when another artist holds artist:gokhan-kirdar, redirect key included", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await putArtist("gokhan-kirdar", "Gökhan Kırdar", { mbid: mb(60) });
			await writeRedirects({ "artist:gokhan-k-rdar": "artist:gokhan-kirdar" });

			const result = await run({
				fetch: lbFetch((id) => jsonResponse(id === mb(1) ? [row(61, "Gökhan Kırdar", 9)] : [])),
			});

			expect((await read("artist:seed")).similar_artists).toEqual([]);
			expect(result.manifest.unsafeCandidates).toBe(1);
			expect(result.manifest.none).toContainEqual({ slug: "artist:seed", reason: "lb-no-usable-edge" });
		});

		it("drops Laetitia Sadier (ae ligature) when another artist holds artist:laetitia-sadier", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1), collaborators: shared() });
			await putArtist("laetitia-sadier", "Lætitia Sadier", { mbid: mb(70) });
			// No redirect entry here: the cached node alone, found under its canonical slug, must stop it.

			const result = await run({
				fetch: lbFetch((id) => jsonResponse(id === mb(1) ? [row(71, "Lætitia Sadier", 9)] : [])),
			});

			expect((await read("artist:seed")).similar_artists).toEqual([]);
			expect(result.manifest.unsafeCandidates).toBe(1);
		});

		it("writes the canonical slug of a name the flag-off slug would mangle: MO is artist:mo, not artist:m", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await putArtist("m", "M", { mbid: mb(80) }); // somebody else, who owns artist:m
			const rows = [row(81, "MØ", 9), row(82, "Trentemøller", 8), row(83, "Mgła", 7), row(84, "Straße", 6)];

			await run({ fetch: lbFetch((id) => jsonResponse(id === mb(1) ? rows : [])) });

			expect((await read("artist:seed")).similar_artists.map((e) => [e.slug, e.mbid])).toEqual([
				["artist:mo", mb(81)],
				["artist:trentemoller", mb(82)],
				["artist:mgla", mb(83)],
				["artist:strasse", mb(84)],
			]);
		});

		it("keeps the cached slug of an artist reached by MBID, and the graph's edges, untouched by the rewrite", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1), collaborators: shared() });
			await putArtist("lindstrom", "Hans-Peter Lindstrøm", { mbid: mb(90), collaborators: shared() });

			await run({
				fetch: lbFetch((id) => jsonResponse(id === mb(1) ? [row(90, "Hans-Peter Lindstrøm", 9)] : [])),
			});

			expect((await read("artist:seed")).similar_artists).toEqual([
				{ slug: "artist:lindstrom", type: "artist", name: "Hans-Peter Lindstrøm", mbid: mb(90) },
			]);
		});

		it("drops a candidate whose slug is a redirect key to another artist (another mbid)", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			await putArtist("new-name", "New Name", { mbid: mb(100) });
			await writeRedirects({ "artist:old-name": "artist:new-name" });

			const result = await run({
				fetch: lbFetch((id) =>
					jsonResponse(id === mb(1) ? [row(101, "Old Name", 9), row(102, "Free Name", 8)] : []),
				),
			});

			// artist:old-name would open artist:new-name (mbid 100), not the candidate (mbid 101).
			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:free-name"]);
			expect(result.manifest.unsafeCandidates).toBe(1);
		});

		it("refuses the run, before any write, on a missing or invalid redirect table (fail closed)", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1) });
			const before = await snapshot();
			const fetchFn = lbFetch(() => jsonResponse([row(2, "Peer", 5)]));

			await rm(join(dataDir, "slug-redirects.json"));
			await expect(run({ fetch: fetchFn })).rejects.toThrow(/redirect table not found/);

			await writeFile(join(dataDir, "slug-redirects.json"), "{ not json", "utf8");
			await expect(run({ fetch: fetchFn })).rejects.toThrow();
			await writeRedirects({ "artist:a": "artist:b", "artist:b": "artist:c" }); // not flattened
			await expect(run({ fetch: fetchFn })).rejects.toThrow(/flattened/);

			expect(await snapshot()).toEqual(before);
			expect(fetchFn).not.toHaveBeenCalled();
		});
	});

	describe("--force: a dry-run's manifest then --force --apply --resume", () => {
		it("does not skip a node that carries graph edges while the manifest announced ListenBrainz's", async () => {
			await putArtist("seed", "Seed", { mbid: mb(1), collaborators: shared() });
			await putArtist("peer", "Peer", { collaborators: shared() });
			await run({ fetch: lbDown() }); // apply, service down: seed carries the graph's edge
			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:peer"]);

			await run({ apply: false, force: true, fetch: lbFetch(() => jsonResponse([row(2, "Real Peer", 5)])) });
			const applied = await run({
				apply: true,
				force: true,
				resume: true,
				fetch: lbFetch(() => jsonResponse([row(2, "Real Peer", 5)])),
			});

			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:real-peer"]);
			expect(applied.manifest.listenbrainz).toEqual(["artist:seed"]);
			expect(applied.written).toHaveLength(1);
		});
	});

	describe("a canonical slug that stands for two MBIDs (TRA-603)", () => {
		const winks = (id: string) => {
			if (id === mb(1)) return [row(60, "Wink", 9), row(61, "Only For One", 8)];
			if (id === mb(2)) return [row(62, "Wink", 9), row(63, "Only For Two", 8)];
			return [];
		};

		it("drops every edge to artist:wink when two nodes of the run name two different MBIDs, and lists it", async () => {
			await putArtist("juan-atkins", "Juan Atkins", { mbid: mb(1) });
			await putArtist("junko-ohashi", "Junko Ohashi", { mbid: mb(2) });

			const result = await run({ fetch: lbFetch((id) => jsonResponse(winks(id))) });

			expect((await read("artist:juan-atkins")).similar_artists.map((e) => e.slug)).toEqual([
				"artist:only-for-one",
			]);
			expect((await read("artist:junko-ohashi")).similar_artists.map((e) => e.slug)).toEqual([
				"artist:only-for-two",
			]);
			expect(result.manifest.ambiguousSlugs).toEqual([
				{ slug: "artist:wink", mbids: [mb(60), mb(62)].sort(), dropped: 2 },
			]);
			expect(result.manifest.listenbrainz).toEqual(["artist:juan-atkins", "artist:junko-ohashi"]);
		});

		it("does not depend on the order of the run: the first one seen is dropped too", async () => {
			await putArtist("a-first", "A First", { mbid: mb(2) });
			await putArtist("z-last", "Z Last", { mbid: mb(1) });

			await run({ fetch: lbFetch((id) => jsonResponse(winks(id))) });

			for (const slug of ["artist:a-first", "artist:z-last"]) {
				expect((await read(slug)).similar_artists.map((e) => e.slug)).not.toContain("artist:wink");
			}
		});

		it("also counts the edges already in the cache: a new edge to a slug held there under another MBID is dropped", async () => {
			const existing = [edge("artist", "wink", "Wink", { mbid: mb(60) })];
			await putArtist("old", "Old", { similar_artists: existing });
			await putArtist("seed", "Seed", { mbid: mb(2) });
			const before = await raw("artist:old");

			const result = await run({ fetch: lbFetch((id) => jsonResponse(winks(id))) });

			expect(await raw("artist:old")).toBe(before); // what is already there is not this run's to rewrite
			expect((await read("artist:seed")).similar_artists.map((e) => e.slug)).toEqual(["artist:only-for-two"]);
			expect(result.manifest.ambiguousSlugs).toEqual([
				{ slug: "artist:wink", mbids: [mb(60), mb(62)].sort(), dropped: 1 },
			]);
		});

		it("is not a collision when the two edges name the same MBID", async () => {
			await putArtist("one", "One", { mbid: mb(1) });
			await putArtist("two", "Two", { mbid: mb(2) });
			const same = (id: string) => jsonResponse(id === mb(1) || id === mb(2) ? [row(60, "Wink", 9)] : []);

			const result = await run({ fetch: lbFetch(same) });

			expect(result.manifest.ambiguousSlugs).toEqual([]);
			for (const slug of ["artist:one", "artist:two"]) {
				expect((await read(slug)).similar_artists.map((e) => e.slug)).toEqual(["artist:wink"]);
			}
		});

		it("counts the edges a --force node keeps on disk even when its ListenBrainz answer is all discarded (review of #527)", async () => {
			// A already carries artist:wink -> MBID 60. Its ListenBrainz answer is a single row ("MO") that the
			// client turns into artist:m and the script then drops (artist:mo, the canonical slug, is an alias of A):
			// source stays listenbrainz with no edge, A falls back to the graph, finds nothing, and keeps its old edges.
			const kept = [edge("artist", "wink", "Wink", { mbid: mb(60) })];
			await putArtist("a", "A", {
				mbid: mb(1),
				similar_artists: kept,
				aliases: [edge("artist", "mo", "MØ")],
			});
			await putArtist("b", "B", { mbid: mb(2) });
			const before = await raw("artist:a");
			const answer = (id: string) =>
				jsonResponse(id === mb(1) ? [row(61, "MØ", 9)] : id === mb(2) ? [row(62, "Wink", 9)] : []);

			const result = await run({ force: true, fetch: lbFetch(answer) });

			expect(await raw("artist:a")).toBe(before); // A keeps MBID 60 on disk
			expect(result.manifest.kept.map((k) => k.slug)).toEqual(["artist:a"]);
			// B proposed MBID 62 for the same slug: dropped, so artist:wink never stands for two people.
			expect((await read("artist:b")).similar_artists).toEqual([]);
			expect(result.manifest.ambiguousSlugs).toEqual([
				{ slug: "artist:wink", mbids: [mb(60), mb(62)].sort(), dropped: 1 },
			]);
		});

		it("falls back to the graph when the collision leaves nothing of ListenBrainz's answer", async () => {
			await putArtist("one", "One", { mbid: mb(1), collaborators: shared() });
			await putArtist("peer", "Peer", { collaborators: shared() });
			await putArtist("two", "Two", { mbid: mb(2) });
			const onlyWink = (id: string) =>
				jsonResponse(id === mb(1) ? [row(60, "Wink", 9)] : id === mb(2) ? [row(62, "Wink", 9)] : []);

			const result = await run({ fetch: lbFetch(onlyWink) });

			expect((await read("artist:one")).similar_artists.map((e) => e.slug)).toEqual(["artist:peer"]);
			expect(result.manifest.graph).toContainEqual({ slug: "artist:one", reason: "lb-no-usable-edge" });
			expect(result.manifest.none).toContainEqual({ slug: "artist:two", reason: "lb-no-usable-edge" });
			expect(result.manifest.ambiguousSlugs.map((a) => a.slug)).toEqual(["artist:wink"]);
		});
	});

	describe("ListenBrainz outage (MAX_UNAVAILABLE_RATE)", () => {
		async function fiveArtists(): Promise<void> {
			for (let i = 1; i <= 5; i++) await putArtist(`a${i}`, `A ${i}`, { mbid: mb(i) });
		}
		const down = (...ids: number[]) =>
			lbFetch((id) =>
				ids.some((n) => mb(n) === id)
					? new Response("", { status: 503 })
					: jsonResponse([row(50, "Peer", 5)]),
			);

		it("is 20 % exactly: exit 0", async () => {
			expect(MAX_UNAVAILABLE_RATE).toBe(0.2);
			await fiveArtists();

			const result = await run({ fetch: down(1) });

			expect(result.listenbrainzRequests).toEqual({ asked: 5, unavailable: 1 });
			expect(result.exitCode).toBe(0);
		});

		it("exits 1 above it, yet keeps the counts, the fallbacks and an empty errors", async () => {
			await fiveArtists();

			const result = await run({ fetch: down(1, 2) });

			expect(result.listenbrainzRequests).toEqual({ asked: 5, unavailable: 2 });
			expect(result.exitCode).toBe(1);
			expect(result.manifest.errors).toEqual([]);
			expect(result.manifest.fallbacks["lb-unavailable"]).toBe(2);
			expect(formatSummary(result, true, "m.json")).toContain(
				"2 of 5 ListenBrainz request(s) unavailable (more than 20 %",
			);
		});

		it("does not count the artists it never asked about (no mbid)", async () => {
			await putArtist("loner", "Loner");

			const result = await run({ fetch: lbDown() });

			expect(result.listenbrainzRequests).toEqual({ asked: 0, unavailable: 0 });
			expect(result.exitCode).toBe(0);
		});
	});

	describe("command line", () => {
		it("parses the contract and the channel's flags", () => {
			expect(parseCliArgs(["cache"])).toEqual({
				cacheDir: "cache",
				apply: false,
				force: false,
				resume: false,
				manifestPath: "out/similar.json",
				dataDir: undefined,
			});
			expect(
				parseCliArgs(["cache", "--apply", "--manifest", "m.json", "--data-dir", "d", "--resume", "--force"]),
			).toEqual({
				cacheDir: "cache",
				apply: true,
				force: true,
				resume: true,
				manifestPath: "m.json",
				dataDir: "d",
			});
		});

		it.each([
			[[]],
			[["--apply"]],
			[["cache", "--manifest"]],
			[["cache", "--manifest", "--apply"]],
			[["cache", "--apply", "--apply"]],
			[["cache", "--data-dir"]],
			[["cache", "extra"]],
			[["cache", "--types", "artist"]],
		])("refuses an ambiguous command line %j", (argv) => {
			expect(parseCliArgs(argv)).toBeNull();
		});
	});
});
