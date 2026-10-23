import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineDeps } from "../src/pipeline.js";
import {
	artistDraftFixture,
	DEFAULT_ARTIST_MBID,
	FIXTURE_WIKI_URL,
	installPipelineMocks,
} from "./helpers/pipeline-mocks.js";

// TRA-487: the script imports runPipeline, so it is loaded dynamically, after pipeline-mocks.ts has
// registered its vi.mock() calls (see the note in test/pipeline-e2e.test.ts on import order).
async function loadTavilySearch() {
	return (await import("../src/tools/tavily.js")).tavilySearch;
}

async function loadScript() {
	return await import("../scripts/reenrich-thin-nodes.js");
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;

const OTHER_PAGE_URL = "https://www.discogs.com/artist/1-Fixture-Artist";
const OLD_STAMP = "2026-01-01T00:00:00.000Z";
const NEW_STAMP = "2026-10-24T12:00:00.000Z";
const LABEL_MBID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

const OLD_ARTICLE =
	"An old, thin article about a fixture artist, long enough to pass the schema floor. ".repeat(2);
const NEW_ARTICLE = "A new article, written from two pages, about the same fixture entity. ".repeat(3);
const NEW_ARTICLE_WITH_ESCAPE = `${NEW_ARTICLE.trim()}\\n\\nA second paragraph.`;

function artistNode(slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const body = slug.replace("artist:", "");
	return {
		slug,
		type: "artist",
		name: `Artist ${body}`,
		editorial_article: OLD_ARTICLE,
		editorial_bio: "Old bio.",
		citations: [{ url: "https://en.wikipedia.org/wiki/Old", title: "Old" }],
		materialized_at: OLD_STAMP,
		mbid: DEFAULT_ARTIST_MBID,
		artist_kind: "person",
		origin: "Old origin",
		image_url: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Old.jpg",
		image_source: "wikidata-p18",
		genres: [{ type: "genre", slug: "genre:techno", name: "Techno", qid: "Q170611" }],
		labels: [{ type: "label", slug: "label:old-records", name: "Old Records" }],
		discography: [{ type: "project", slug: "project:old-lp--old", name: "Old LP", artist: "Old" }],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [{ type: "artist", slug: "artist:friend", name: "Friend" }],
		aliases: [],
		members: [],
		similar_artists: [],
		...overrides,
	};
}

function labelNode(slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		slug,
		type: "label",
		name: `Label ${slug.replace("label:", "")}`,
		editorial_article: OLD_ARTICLE,
		editorial_description: "Old description.",
		citations: [{ url: "https://en.wikipedia.org/wiki/Old", title: "Old" }],
		materialized_at: OLD_STAMP,
		mbid: LABEL_MBID,
		founded: "1990",
		location: "Old City",
		genres: [{ type: "genre", slug: "genre:techno", name: "Techno", qid: "Q170611" }],
		roster: [{ type: "artist", slug: "artist:signed", name: "Signed" }],
		notable_releases: [],
		...overrides,
	};
}

function genreNode(slug: string): Record<string, unknown> {
	return {
		slug,
		type: "genre",
		name: "Old Genre",
		editorial_article: OLD_ARTICLE,
		editorial_definition: "Old definition.",
		citations: [{ url: "https://en.wikipedia.org/wiki/Old", title: "Old" }],
		materialized_at: OLD_STAMP,
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
	};
}

/** Two search results and two readable pages: Wikipedia plus Discogs (TRA-459 reads both). */
async function armTwoPages(): Promise<void> {
	const { localFetch } = await import("../src/tools/local-fetcher.js");
	const tavilySearch = await loadTavilySearch();
	const pages: Record<string, string> = {
		[FIXTURE_WIKI_URL]: "# Fixture Artist\n\nFixture Artist is a fictional musician. ".repeat(4),
		[OTHER_PAGE_URL]: "# Fixture Artist on Discogs\n\nProfile, aliases and discography. ".repeat(4),
	};
	vi.mocked(tavilySearch).mockImplementation(async () => [
		{ title: "Fixture - Wikipedia", url: FIXTURE_WIKI_URL, content: "Fixture Artist is a musician." },
		{ title: "Fixture - Discogs", url: OTHER_PAGE_URL, content: "Discography." },
	]);
	vi.mocked(localFetch).mockImplementation(async (url: string) => {
		const markdown = pages[url];
		if (markdown === undefined) throw new Error(`unexpected call: localFetch(${url})`);
		return { url, title: "Fixture", markdown, httpStatus: 200, bytes: markdown.length };
	});
}

const TWO_CITATIONS = [
	{ url: FIXTURE_WIKI_URL, title: "Fixture Artist - Wikipedia" },
	{ url: OTHER_PAGE_URL, title: "Fixture Artist - Discogs" },
];

/** What the nodes below cite before the run, and after a rewrite: the original source stays, first. */
const OLD_CITATION = { url: "https://en.wikipedia.org/wiki/Old", title: "Old" };
const WITH_ORIGINAL = [OLD_CITATION, ...TWO_CITATIONS];

describe("reenrich-thin-nodes (TRA-487)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-reenrich-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function put(node: Record<string, unknown>): Promise<string> {
		const [type, body] = String(node.slug).split(":") as [string, string];
		await mkdir(join(dir, "nodes", type), { recursive: true });
		const file = join(dir, "nodes", type, `${body}.json`);
		await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
		return file;
	}

	const readJson = async (file: string): Promise<Record<string, unknown>> =>
		JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

	describe("selection", () => {
		it("takes the artists and labels under two citations, in slug order, and nothing else", async () => {
			const { selectThinNodes } = await loadScript();
			const thin = (slug: string) => ({
				path: "",
				slug,
				type: slug.split(":")[0],
				node: { citations: [{}] },
			});
			const rich = (slug: string) => ({
				path: "",
				slug,
				type: slug.split(":")[0],
				node: { citations: [{}, {}] },
			});
			const nodes = [
				thin("label:zeta"),
				thin("artist:bravo"),
				rich("artist:rich"),
				thin("genre:thin-genre"),
				thin("artist:alpha"),
			] as never[];

			const all = selectThinNodes(nodes, { types: ["artist", "label"] });
			expect(all.map((n) => n.slug)).toEqual(["artist:alpha", "artist:bravo", "label:zeta"]);
			expect(selectThinNodes(nodes, { types: ["label"] }).map((n) => n.slug)).toEqual(["label:zeta"]);
			expect(selectThinNodes(nodes, { types: ["artist", "label"], limit: 2 }).map((n) => n.slug)).toEqual([
				"artist:alpha",
				"artist:bravo",
			]);
			expect(
				selectThinNodes(nodes, { types: ["artist", "label"], only: ["artist:bravo", "artist:rich"] }).map(
					(n) => n.slug,
				),
			).toEqual(["artist:bravo"]);
		});
	});

	describe("merge", () => {
		it("copies the text fields only, and keeps a fact the fresh node does not carry", async () => {
			const { mergeFreshText } = await loadScript();
			const existing = artistNode("artist:merge", { active_years: "1990-2000" });
			const fresh = {
				...artistNode("artist:merge"),
				editorial_article: NEW_ARTICLE,
				editorial_bio: "New bio.",
				citations: TWO_CITATIONS,
				origin: "New origin",
				active_years: undefined,
				mbid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
				labels: [],
				image_url: undefined,
			};

			const { node, changed } = mergeFreshText(existing, fresh, "artist", NEW_STAMP);

			expect(changed.sort()).toEqual(["citations", "editorial_article", "editorial_bio", "origin"]);
			expect(node).toEqual({
				...existing,
				editorial_article: NEW_ARTICLE,
				editorial_bio: "New bio.",
				citations: TWO_CITATIONS,
				origin: "New origin",
				materialized_at: NEW_STAMP,
			});
		});

		it("refuses a fresh node that is not the same entity", async () => {
			const { identityMismatch } = await loadScript();
			const existing = artistNode("artist:same");
			expect(identityMismatch(existing, artistNode("artist:same"))).toBeNull();
			expect(identityMismatch(existing, artistNode("artist:other"))).toMatch(/slug/);
			expect(identityMismatch(existing, { ...existing, type: "label" })).toMatch(/type/);
			expect(identityMismatch(existing, { ...existing, mbid: LABEL_MBID })).toMatch(/mbid/);
			// No mbid on either side is not a mismatch: the slug and the pinned search carry the identity.
			const { mbid: _mbid, ...unidentified } = existing;
			expect(identityMismatch(unidentified, existing)).toBeNull();
		});
	});

	// Decision of the dispatcher, 2026-10-24: add a source without impoverishing the card.
	describe("guards", () => {
		const fresh = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
			...artistNode("artist:g"),
			editorial_article: NEW_ARTICLE,
			editorial_bio: "New bio.",
			citations: TWO_CITATIONS,
			...overrides,
		});
		const withoutMbid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
			const { mbid: _mbid, ...rest } = artistNode("artist:g", overrides);
			return rest;
		};

		it("keeps the stored citation, first, and appends the fresh ones without repeating a source", async () => {
			const { evaluateCandidate } = await loadScript();
			const repeated = { url: "HTTPS://en.wikipedia.org/wiki/Old/", title: "Old again" };

			const verdict = evaluateCandidate(
				artistNode("artist:g"),
				fresh({ citations: [repeated, ...TWO_CITATIONS] }),
				"artist",
				NEW_STAMP,
			);

			expect(verdict).toMatchObject({ ok: true });
			expect(verdict.ok && verdict.node.citations).toEqual(WITH_ORIGINAL);
		});

		it("refuses a new source from a social network or a streaming platform", async () => {
			const { evaluateCandidate, isBlockedCitationUrl } = await loadScript();
			for (const url of [
				"https://www.facebook.com/groups/x/posts/1",
				"https://m.facebook.com/x",
				"https://www.instagram.com/reel/abc",
				"https://x.com/someone",
				"https://twitter.com/someone",
				"https://www.tiktok.com/@someone",
				"https://www.youtube.com/watch?v=abc",
				"https://music.youtube.com/channel/abc",
				"https://youtu.be/abc",
				"https://open.spotify.com/artist/abc",
				"https://music.apple.com/ca/artist/x/1",
				"https://www.deezer.com/en/artist/1",
				"https://soundcloud.com/someone",
				"not a url",
			]) {
				expect(isBlockedCitationUrl(url), url).toBe(true);
			}
			for (const url of [
				"https://en.wikipedia.org/wiki/X",
				"https://www.discogs.com/artist/1",
				"https://notfacebook.com/x",
				"https://box.com/x",
				"https://www.apple.com/newsroom",
				"https://someone.bandcamp.com/",
			]) {
				expect(isBlockedCitationUrl(url), url).toBe(false);
			}
			const social = { url: "https://www.facebook.com/x/posts/1", title: "Post" };
			const video = { url: "https://www.youtube.com/watch?v=abc", title: "Video" };

			// Only blocked sources to add: the node gains none, so it stays thin and untouched.
			expect(
				evaluateCandidate(artistNode("artist:g"), fresh({ citations: [social, video] }), "artist", NEW_STAMP),
			).toEqual({ ok: false, reason: "still-thin" });
			// One allowed source among them: it is added, the social one is not.
			const verdict = evaluateCandidate(
				artistNode("artist:g"),
				fresh({ citations: [social, TWO_CITATIONS[1]] }),
				"artist",
				NEW_STAMP,
			);
			expect(verdict.ok && verdict.node.citations).toEqual([OLD_CITATION, TWO_CITATIONS[1]]);
		});

		it("refuses an article under 80 % of the stored one, and accepts one at 80 %", async () => {
			const { evaluateCandidate } = await loadScript();
			const stored = artistNode("artist:g", { editorial_article: "x".repeat(100) });

			expect(
				evaluateCandidate(stored, fresh({ editorial_article: "y".repeat(79) }), "artist", NEW_STAMP),
			).toEqual({ ok: false, reason: "shorter-article" });
			expect(
				evaluateCandidate(stored, fresh({ editorial_article: "y".repeat(80) }), "artist", NEW_STAMP).ok,
			).toBe(true);
		});

		it("without an mbid, wants the text to name an entity the node is linked to", async () => {
			const { evaluateCandidate } = await loadScript();
			const verdictFor = (stored: Record<string, unknown>, article: string) =>
				evaluateCandidate(stored, fresh({ editorial_article: article }), "artist", NEW_STAMP);
			const refused = { ok: false, reason: "identity-unconfirmed" };

			// A homonym's text: no label, project, track, member or alias of the node in it.
			expect(verdictFor(withoutMbid(), "A folk singer who plays the concertina. ".repeat(6))).toEqual(
				refused,
			);
			// A genre is not a confirmation: any text on any artist names one.
			expect(verdictFor(withoutMbid(), "A Techno producer from somewhere far away. ".repeat(6))).toEqual(
				refused,
			);
			// Whole words only.
			expect(verdictFor(withoutMbid(), "Released the old lps in a box. ".repeat(8))).toEqual(refused);
			// Nothing to confirm with.
			expect(
				verdictFor(withoutMbid({ labels: [], discography: [] }), "Signed to Old Records. ".repeat(10)),
			).toEqual(refused);
			// Named, whatever the case and the accents.
			expect(verdictFor(withoutMbid(), "Signed to OLD records, an old label. ".repeat(6)).ok).toBe(true);
			expect(verdictFor(withoutMbid(), "Debut on the Old LP, a record. ".repeat(6)).ok).toBe(true);
			// With an mbid the identity is pinned: the check does not apply.
			expect(
				verdictFor(artistNode("artist:g"), "A folk singer who plays the concertina. ".repeat(6)).ok,
			).toBe(true);
		});
	});

	describe("run", () => {
		it(
			"rewrites a one-citation artist with two citations and a new article, edges and mbid untouched",
			async () => {
				installPipelineMocks({
					draft: artistDraftFixture({
						editorial_article: NEW_ARTICLE_WITH_ESCAPE,
						editorial_bio: "New bio.",
						origin: "New origin",
						active_years: "2001-present",
						citations: TWO_CITATIONS,
					}),
				});
				await armTwoPages();
				const before = artistNode("artist:thin-one");
				const file = await put(before);
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({
					cacheDir: dir,
					types: ["artist", "label"],
					apply: true,
					deps: DEPS,
					now: () => new Date(NEW_STAMP),
				});

				const after = await readJson(file);
				expect(after.citations).toEqual(WITH_ORIGINAL);
				// TRA-458's normalization applied by the pipeline: a real paragraph break, not a literal escape.
				expect(after.editorial_article).toBe(`${NEW_ARTICLE.trim()}\n\nA second paragraph.`);
				expect(after.editorial_bio).toBe("New bio.");
				expect(after.origin).toBe("New origin");
				expect(after.active_years).toBe("2001-present");
				expect(after.materialized_at).toBe(NEW_STAMP);
				expect(after.materialized_at).not.toBe(before.materialized_at);
				// Everything but the text: strictly the same value as before (deep-equal), key by key.
				const textKeys = new Set([
					"editorial_article",
					"editorial_bio",
					"citations",
					"origin",
					"active_years",
					"materialized_at",
				]);
				for (const key of Object.keys(before)) {
					if (textKeys.has(key)) continue;
					expect(after[key], key).toStrictEqual(before[key]);
				}
				expect(Object.keys(after).filter((k) => !(k in before) && !textKeys.has(k))).toEqual([]);
				expect(after.mbid).toBe(DEFAULT_ARTIST_MBID);

				expect(manifest).toMatchObject({
					mode: "apply",
					selected: 1,
					rewritten: 1,
					rewrittenSlugs: ["artist:thin-one"],
					stillThin: [],
					errors: [],
					budgetExhausted: false,
				});
				expect(manifest.costUsd).toBeGreaterThan(0);
			},
			TIMEOUT_MS,
		);

		it(
			"leaves the node intact and lists its slug in stillThin when the pipeline still gives one citation",
			async () => {
				// The default fixture search has a single Wikipedia page, which the node already cites: no new source.
				installPipelineMocks({ draft: artistDraftFixture({ editorial_article: NEW_ARTICLE }) });
				const file = await put(
					artistNode("artist:still-thin", { citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture" }] }),
				);
				const bytesBefore = await readFile(file, "utf8");
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({
					cacheDir: dir,
					types: ["artist", "label"],
					apply: true,
					deps: DEPS,
				});

				expect(await readFile(file, "utf8")).toBe(bytesBefore);
				expect(manifest.stillThin).toEqual(["artist:still-thin"]);
				expect(manifest.rewritten).toBe(0);
				expect(manifest.errors).toEqual([]);
			},
			TIMEOUT_MS,
		);

		it(
			"rewrites a label with its text facts, and keeps its roster and mbid",
			async () => {
				installPipelineMocks({
					draft: {
						name: "Label x",
						editorial_article: NEW_ARTICLE,
						citations: TWO_CITATIONS,
						editorial_description: "New description.",
						founded: "1991",
						location: "New City",
						founders: "Someone",
						active_years: "1991-present",
						genres: [],
						roster: [],
						notable_releases: [],
					},
				});
				await armTwoPages();
				const { fetchLabelMetaMb } = await import("../src/musicbrainz.js");
				vi.mocked(fetchLabelMetaMb).mockImplementation(async () => ({ roster: [], notableReleases: [] }));
				const before = labelNode("label:thin-label");
				const file = await put(before);
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({
					cacheDir: dir,
					types: ["label"],
					apply: true,
					deps: DEPS,
					now: () => new Date(NEW_STAMP),
				});

				const after = await readJson(file);
				expect(after).toEqual({
					...before,
					editorial_article: NEW_ARTICLE.trim(),
					editorial_description: "New description.",
					citations: WITH_ORIGINAL,
					founded: "1991",
					location: "New City",
					founders: "Someone",
					active_years: "1991-present",
					materialized_at: NEW_STAMP,
				});
				expect(manifest.rewrittenSlugs).toEqual(["label:thin-label"]);
			},
			TIMEOUT_MS,
		);

		it(
			"dry-run lists the candidates with the estimated cost and calls nothing",
			async () => {
				installPipelineMocks({ draft: artistDraftFixture() });
				const files = [
					await put(artistNode("artist:a-thin")),
					await put(labelNode("label:b-thin")),
					await put(artistNode("artist:c-rich", { citations: TWO_CITATIONS })),
					await put(genreNode("genre:d-thin")),
				];
				const bytesBefore = await Promise.all(files.map((f) => readFile(f, "utf8")));
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({ cacheDir: dir, types: ["artist", "label"], apply: false });

				expect(manifest).toMatchObject({
					mode: "dry-run",
					selected: 2,
					candidates: ["artist:a-thin", "label:b-thin"],
					estimatedCostUsd: 0.012,
					rewritten: 0,
					costUsd: 0,
				});
				expect(vi.mocked(await loadTavilySearch())).not.toHaveBeenCalled();
				expect(await Promise.all(files.map((f) => readFile(f, "utf8")))).toEqual(bytesBefore);
			},
			TIMEOUT_MS,
		);

		it(
			"records a pipeline failure per node, keeps the file, and carries on with the others",
			async () => {
				let calls = 0;
				installPipelineMocks({
					draft: artistDraftFixture({ editorial_article: NEW_ARTICLE, citations: TWO_CITATIONS }),
					generateContent: async () => {
						calls++;
						if (calls === 1) throw new Error("503 unavailable");
						return {
							text: JSON.stringify(
								artistDraftFixture({ editorial_article: NEW_ARTICLE, citations: TWO_CITATIONS }),
							),
							usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 42 },
						};
					},
				});
				await armTwoPages();
				const first = await put(artistNode("artist:a-fails"));
				const second = await put(artistNode("artist:b-works"));
				const bytesFirst = await readFile(first, "utf8");
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({
					cacheDir: dir,
					types: ["artist"],
					apply: true,
					deps: DEPS,
					concurrency: 1,
				});

				expect(await readFile(first, "utf8")).toBe(bytesFirst);
				expect((await readJson(second)).citations).toEqual(WITH_ORIGINAL);
				expect(manifest.rewrittenSlugs).toEqual(["artist:b-works"]);
				expect(manifest.errors).toEqual([{ slug: "artist:a-fails", error: expect.stringContaining("503") }]);
			},
			TIMEOUT_MS,
		);

		it(
			"stops starting nodes once --max-cost is reached and lists the ones not run",
			async () => {
				installPipelineMocks({
					draft: artistDraftFixture({ editorial_article: NEW_ARTICLE, citations: TWO_CITATIONS }),
				});
				await armTwoPages();
				await put(artistNode("artist:a-first"));
				await put(artistNode("artist:b-second"));
				await put(artistNode("artist:c-third"));
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({
					cacheDir: dir,
					types: ["artist"],
					apply: true,
					deps: DEPS,
					concurrency: 1,
					maxCostUsd: 1e-9,
				});

				expect(manifest.rewrittenSlugs).toEqual(["artist:a-first"]);
				expect(manifest.notRun).toEqual(["artist:b-second", "artist:c-third"]);
				expect(manifest.budgetExhausted).toBe(true);
			},
			TIMEOUT_MS,
		);

		it(
			"refuses an article under 80 % of the stored one and leaves the file as it is",
			async () => {
				installPipelineMocks({
					draft: artistDraftFixture({
						editorial_article:
							"A short article, far under the stored one, but still past the eighty character schema floor.",
						citations: TWO_CITATIONS,
					}),
				});
				await armTwoPages();
				const file = await put(artistNode("artist:shrunk", { editorial_article: OLD_ARTICLE.repeat(2) }));
				const bytesBefore = await readFile(file, "utf8");
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({
					cacheDir: dir,
					types: ["artist"],
					apply: true,
					deps: DEPS,
				});

				expect(await readFile(file, "utf8")).toBe(bytesBefore);
				expect(manifest.refused).toEqual([{ slug: "artist:shrunk", reason: "shorter-article" }]);
				expect(manifest.rewritten).toBe(0);
			},
			TIMEOUT_MS,
		);

		it(
			"without an mbid, writes only the node whose text names an entity it is linked to (the Aim / folk singer case)",
			async () => {
				installPipelineMocks({
					draft: artistDraftFixture({
						editorial_article: `${NEW_ARTICLE}Signed to Old Records, a label of the period.`,
						citations: TWO_CITATIONS,
					}),
				});
				await armTwoPages();
				const { mbid: _a, ...linked } = artistNode("artist:a-linked");
				const { mbid: _b, ...homonym } = artistNode("artist:b-homonym", {
					labels: [{ type: "label", slug: "label:grand-central", name: "Grand Central" }],
					discography: [],
				});
				const linkedFile = await put(linked);
				const homonymFile = await put(homonym);
				const homonymBefore = await readFile(homonymFile, "utf8");
				const { reenrichThinNodes } = await loadScript();

				const manifest = await reenrichThinNodes({
					cacheDir: dir,
					types: ["artist"],
					apply: true,
					deps: DEPS,
					concurrency: 1,
				});

				expect((await readJson(linkedFile)).citations).toEqual(WITH_ORIGINAL);
				expect(await readFile(homonymFile, "utf8")).toBe(homonymBefore);
				expect(manifest.rewrittenSlugs).toEqual(["artist:a-linked"]);
				expect(manifest.refused).toEqual([{ slug: "artist:b-homonym", reason: "identity-unconfirmed" }]);
			},
			TIMEOUT_MS,
		);

		it(
			"is idempotent: a second run selects nothing, the first having made the node two-sourced",
			async () => {
				installPipelineMocks({
					draft: artistDraftFixture({ editorial_article: NEW_ARTICLE, citations: TWO_CITATIONS }),
				});
				await armTwoPages();
				await put(artistNode("artist:once"));
				const { reenrichThinNodes } = await loadScript();
				const opts = { cacheDir: dir, types: ["artist" as const], apply: true, deps: DEPS };

				expect((await reenrichThinNodes(opts)).rewritten).toBe(1);
				expect((await reenrichThinNodes(opts)).selected).toBe(0);
			},
			TIMEOUT_MS,
		);
	});

	describe("parseCliArgs", () => {
		it("reads the contract of the ticket and refuses what it does not know", async () => {
			const { parseCliArgs } = await loadScript();
			expect(parseCliArgs(["cache"])).toMatchObject({
				cacheDir: "cache",
				types: ["artist", "label"],
				apply: false,
				manifest: "out/reenrich.json",
				searchProvider: "tavily",
			});
			expect(
				parseCliArgs(["cache", "--types", "label", "--apply", "--limit", "5", "--manifest", "m.json"]),
			).toMatchObject({ types: ["label"], apply: true, limit: 5, manifest: "m.json" });
			expect(parseCliArgs([])).toBeNull();
			expect(parseCliArgs(["cache", "--types", "genre"])).toBeNull();
			expect(parseCliArgs(["cache", "--limit", "zero"])).toBeNull();
			expect(parseCliArgs(["cache", "--bogus"])).toBeNull();
			expect(parseCliArgs(["cache", "other"])).toBeNull();
			expect(parseCliArgs(["cache", "--search-provider", "bing"])).toBeNull();
		});
	});
});
