import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry } from "../src/genre-registry.js";
import { enrichFromMusicBrainz, normalizeEdge, type PipelineDeps, runPipeline } from "../src/pipeline.js";
import type { GenreNode, Slug } from "../src/types.js";

// TRA-18: mock only the external MB boundary; genre-identity.ts is ours, so it runs for real
// against the committed catalog — "techno" resolves there, "not-a-real-genre-xyz" doesn't.
vi.mock("../src/musicbrainz.js", () => ({
	findArtistMbidByName: vi.fn(async () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
	fetchArtistDiscographyMb: vi.fn(async () => []),
	fetchEntityGenresMb: vi.fn(async () => [{ name: "techno" }, { name: "not-a-real-genre-xyz" }]),
}));

// Fixtures for the single runPipeline-level (TRA-32 review round 1, item 3) test below, which
// exercises the search -> fetch -> LLM boundaries `enrichFromMusicBrainz`-level tests skip
// entirely. vi.hoisted is required here: vi.mock factories run before any other module-scope
// code, so a factory can only reference values built through vi.hoisted, not a plain `const`
// declared further down this file (that would be a temporal-dead-zone ReferenceError).
const { TRA32_WIKI_URL, TRA32_GENRE_DRAFT } = vi.hoisted(() => ({
	TRA32_WIKI_URL: "https://en.wikipedia.org/wiki/Trap_TRA32_fixture",
	TRA32_GENRE_DRAFT: {
		name: "Trap (electronic)",
		editorial_article:
			"Trap (electronic) is a fictional test genre invented for the TRA-32 runPipeline " +
			"regression test. It has no real-world referent and exists only to exercise qid carryover.",
		editorial_definition: "A fictional test genre with no real musical characteristics.",
		parent_genres: [] as unknown[],
		subgenres: [] as unknown[],
		related_genres: [] as unknown[],
		key_artists: [] as unknown[],
		key_labels: [] as unknown[],
		landmark_tracks: [] as unknown[],
	},
}));

vi.mock("../src/tools/tavily.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/tools/tavily.js")>();
	return {
		...actual,
		tavilySearch: vi.fn(async () => [
			{ title: "Trap (electronic) fixture", url: TRA32_WIKI_URL, content: "Fixture search snippet." },
		]),
	};
});

vi.mock("../src/tools/local-fetcher.js", () => ({
	localFetch: vi.fn(async (url: string) => ({
		url,
		title: "Trap (electronic) fixture",
		markdown: "# Trap (electronic)\n\nFixture markdown for the TRA-32 runPipeline regression test.",
		httpStatus: 200,
		bytes: 80,
	})),
}));

vi.mock("@google/genai", () => ({
	GoogleGenAI: vi.fn(() => ({
		models: {
			generateContent: vi.fn(async () => ({
				text: JSON.stringify(TRA32_GENRE_DRAFT),
				usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
			})),
		},
	})),
	// Real values from @google/genai's Type enum — pipeline.ts's schema builders read
	// GType.STRING/OBJECT/ARRAY at call time, before generateContent is ever invoked.
	Type: {
		TYPE_UNSPECIFIED: "TYPE_UNSPECIFIED",
		STRING: "STRING",
		NUMBER: "NUMBER",
		INTEGER: "INTEGER",
		BOOLEAN: "BOOLEAN",
		ARRAY: "ARRAY",
		OBJECT: "OBJECT",
		NULL: "NULL",
	},
}));

describe("normalizeEdge — qid propagation (TRA-17)", () => {
	it("keeps a valid qid", () => {
		const out = normalizeEdge({ type: "genre", name: "Techno", qid: "Q170611" });
		expect(out).not.toBeNull();
		expect(out?.qid).toBe("Q170611");
	});

	it("discards a malformed qid without dropping the edge", () => {
		const out = normalizeEdge({ type: "genre", name: "Techno", qid: "170611" });
		expect(out).not.toBeNull();
		expect(out?.name).toBe("Techno");
		expect(out?.qid).toBeUndefined();
	});
});

describe("enrichFromMusicBrainz — MB genre producers stamp qid (TRA-18)", () => {
	it("stamps qid on a resolvable genre, omits it on an unresolvable one, keeps both edges", async () => {
		const node: Record<string, unknown> = {};
		await enrichFromMusicBrainz(node, { type: "artist", name: "Test Artist" }, () => undefined);
		const genres = node.genres as Array<{ name: string; slug: string; qid?: string }>;
		expect(genres).toHaveLength(2);
		expect(genres[0]?.qid).toBe("Q170611");
		expect(genres[0]?.name).toBe("Techno");
		expect(genres[1]?.qid).toBeUndefined();
		expect(genres[1]?.name).toBeTruthy();
		expect(genres[1]?.slug).toBeTruthy();
	});
});

describe("enrichFromMusicBrainz — genre node qid + parent_genres backfill from catalog (TRA-18)", () => {
	it("stamps the node's own qid even when parent_genres is already non-empty", async () => {
		const node: Record<string, unknown> = {
			slug: "genre:acid-techno",
			parent_genres: [{ type: "genre", name: "Placeholder", slug: "genre:placeholder" }],
		};
		await enrichFromMusicBrainz(node, { type: "genre", name: "Acid Techno" }, () => undefined);
		expect(node.qid).toBe("Q341395");
		// Backfill only fires when parent_genres is empty; the array is left untouched.
		expect(node.parent_genres).toEqual([{ type: "genre", name: "Placeholder", slug: "genre:placeholder" }]);
	});

	it("backfills parent_genres from the catalog, each parent edge carrying its own qid", async () => {
		const node: Record<string, unknown> = { slug: "genre:acid-techno", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Acid Techno" }, () => undefined);
		expect(node.qid).toBe("Q341395");
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		expect(bySlug.get("genre:acid")?.qid).toBe("Q106528337");
		expect(bySlug.get("genre:techno")?.qid).toBe("Q170611");
	});
});

describe("enrichFromMusicBrainz — genre node stamped via the resolver, not a slug-exact lookup (TRA-26)", () => {
	it("resolves genre:electronic via the resolver's 'music' suffix heuristic (catalog only has electronic-music)", async () => {
		const node: Record<string, unknown> = { slug: "genre:electronic", name: "Electronic" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Electronic" }, () => undefined);
		expect(node.qid).toBe("Q9778");
		// The catalog's "electronic-music" entry has no parents, so the backfill guard never
		// fires; parent_genres is simply left as-is (contains all zero of the entry's parents).
		expect(node.parent_genres).toBeUndefined();
	});

	it("resolves a node whose slug already matches the catalog slug, same as before the resolver (genre:techno)", async () => {
		const node: Record<string, unknown> = { slug: "genre:techno", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Techno" }, () => undefined);
		expect(node.qid).toBe("Q170611");
	});

	it("leaves an unresolvable genre name without qid or parent_genres (architecture decision 5)", async () => {
		const node: Record<string, unknown> = { slug: "genre:braindance", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Braindance" }, () => undefined);
		expect(node.qid).toBeUndefined();
		expect(node.parent_genres).toEqual([]);
	});

	it("resolves genre:idm via the hand-curated alias table", async () => {
		const node: Record<string, unknown> = { slug: "genre:idm", name: "IDM" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "IDM" }, () => undefined);
		expect(node.qid).toBe("Q660984");
	});

	it("resolves on the node's own materialized name (obj.name), not the original input.name", async () => {
		// canonicalizeDraft runs before enrichFromMusicBrainz and can let the LLM draft's name
		// override the requested one, so by the time we get here obj.name (not input.name) is
		// the node's real, persisted name. input.name is deliberately unresolvable here to prove
		// obj.name — not the request — drives resolution.
		const node: Record<string, unknown> = { slug: "genre:idm", name: "IDM" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Braindance" }, () => undefined);
		expect(node.qid).toBe("Q660984");
	});
});

describe("enrichFromMusicBrainz — parent_genres backfill expands the 'rb' token, scoped fix (TRA-34)", () => {
	it("derives a 'contemporary-rb' parent as 'Contemporary R&B' / genre:contemporary-r-and-b, not the mangled 'Contemporary Rb' / genre:contemporary-rb", async () => {
		// "alternative-rb" is a real catalog entry whose only parent is "contemporary-rb".
		const node: Record<string, unknown> = { slug: "genre:alternative-rb", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Alternative R&B" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		expect(bySlug.has("genre:contemporary-rb")).toBe(false);
		const parent = bySlug.get("genre:contemporary-r-and-b");
		expect(parent?.name).toBe("Contemporary R&B");
		expect(parent?.qid).toBe("Q850412");
	});

	it("derives an 'early-rb' parent as 'Early R&B' / genre:early-r-and-b", async () => {
		// "bluebeat"'s catalog parents include "early-rb".
		const node: Record<string, unknown> = { slug: "genre:bluebeat", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Bluebeat" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:early-r-and-b");
		expect(parent?.name).toBe("Early R&B");
		expect(parent?.qid).toBe("Q114907417");
	});

	it("derives a 'french-contemporary-rb' parent as 'French Contemporary R&B' / genre:french-contemporary-r-and-b", async () => {
		// "rainb"'s catalog parents include "french-contemporary-rb".
		const node: Record<string, unknown> = { slug: "genre:rainb", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Rai'n'B" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:french-contemporary-r-and-b");
		expect(parent?.name).toBe("French Contemporary R&B");
		expect(parent?.qid).toBe("Q113509746");
	});

	it("leaves a 'hip-hop' parent unchanged ('Hip Hop' / genre:hip-hop) — the fix is scoped to the 'rb' token only", async () => {
		// "abstract-hip-hop"'s only catalog parent is "hip-hop". Its catalog name ("hip-hop")
		// has an internal hyphen the slug-based derivation still discards deliberately: the
		// name-based approach that would have preserved it was reverted (see the comment on the
		// backfill in src/pipeline.ts) because it moved 143 unrelated slugs.
		const node: Record<string, unknown> = { slug: "genre:abstract-hip-hop", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Abstract Hip-Hop" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:hip-hop");
		expect(parent?.name).toBe("Hip Hop");
		expect(parent?.qid).toBe("Q11401");
	});

	it("leaves a non-R&B parent ('electronic-music') unchanged", async () => {
		// "acid"'s only catalog parent is "electronic-music"; neither its slug nor its catalog
		// name contain an "rb" token, so the fix must not move this.
		const node: Record<string, unknown> = { slug: "genre:acid", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Acid" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:electronic-music");
		expect(parent?.name).toBe("Electronic Music");
		expect(parent?.qid).toBe("Q9778");
	});

	it("leaves a 'bass-music-edm' parent unchanged — no collision with the distinct 'bass-music' entry", async () => {
		// "bass-house"'s catalog parents include "bass-music-edm", a genuinely distinct genre
		// (Q114880130) from "bass-music" (Q96740854). The reverted name-based approach folded
		// both onto genre:bass-music because makeSlug strips the "(EDM)" parenthetical; the
		// slug-based derivation (unaffected by the "rb" token fix) keeps them apart.
		const node: Record<string, unknown> = { slug: "genre:bass-house", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Bass House" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		expect(bySlug.has("genre:bass-music")).toBe(false);
		const parent = bySlug.get("genre:bass-music-edm");
		expect(parent?.name).toBe("Bass Music Edm");
		expect(parent?.qid).toBe("Q114880130");
	});
});

describe("enrichFromMusicBrainz — qid carried across rematerialization (TRA-32)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-pipeline-genre-qid-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** Minimal, schema-valid genre node for pre-seeding the cache. */
	function cachedGenreNode(overrides: Partial<GenreNode> & { slug: Slug; name: string }): GenreNode {
		return {
			type: "genre",
			editorial_article:
				"A real long article about this genre, well past the eighty character floor. ".repeat(2),
			editorial_definition: "A short definition.",
			citations: [{ url: "https://example.com/genre" }],
			materialized_at: new Date().toISOString(),
			parent_genres: [],
			subgenres: [],
			related_genres: [],
			key_artists: [],
			key_labels: [],
			landmark_projects: [],
			landmark_tracks: [],
			...overrides,
		};
	}

	it("falls back to the slug body when the name fails to resolve, same order as the backfill (genre:trap)", async () => {
		// Explicitly constructed so the name alone never resolves: since TRA-33 an alias resolves
		// "trap edm" (the normalized form of the real "Trap (EDM)" name), so that string can no
		// longer stand in for "resolution fails". The slug body "trap" still resolves via the
		// resolver's "music"-suffix heuristic ("trap" -> "trap music" -> Q2913982), same as the
		// backfill migration falls back to it.
		const node: Record<string, unknown> = { slug: "genre:trap", name: "Trap (Not A Real Genre)" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Trap (Not A Real Genre)" }, () => undefined);
		expect(node.qid).toBe("Q2913982");
	});

	it("reports the cached qid when rematerializing a node whose name and slug body both fail to resolve", async () => {
		await cache.write(
			cachedGenreNode({
				slug: "genre:not-a-real-genre-xyz",
				name: "Not A Real Genre Xyz",
				qid: "Q999999999",
			}),
		);
		const registry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const node: Record<string, unknown> = {
			slug: "genre:not-a-real-genre-xyz",
			name: "Not A Real Genre Xyz",
		};
		await enrichFromMusicBrainz(
			node,
			{ type: "genre", name: "Not A Real Genre Xyz" },
			() => undefined,
			registry,
		);
		expect(node.qid).toBe("Q999999999");
	});

	it("stamps no qid when nothing resolves and nothing is cached (unchanged behavior)", async () => {
		const registry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const node: Record<string, unknown> = {
			slug: "genre:not-a-real-genre-xyz",
			name: "Not A Real Genre Xyz",
		};
		await enrichFromMusicBrainz(
			node,
			{ type: "genre", name: "Not A Real Genre Xyz" },
			() => undefined,
			registry,
		);
		expect(node.qid).toBeUndefined();
	});

	it("keeps the cached qid over a disagreeing fresh resolve, logging the conflict (review round 1: policy flipped to match the backfill)", async () => {
		// scripts/migrations/2026-09-04-backfill-genre-qid.ts:206-217 PARKS on a cached/resolved
		// disagreement (keeps the existing qid, records a conflict) rather than overwriting it.
		// Runtime must match: identity corrections are a migration/curation concern (cache/ is the
		// committed knowledge base), never a silent refresh from a later LLM draft's name.
		await cache.write(cachedGenreNode({ slug: "genre:techno", name: "Techno", qid: "Q1" }));
		const registry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const logs: string[] = [];
		const node: Record<string, unknown> = { slug: "genre:techno", name: "Techno" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Techno" }, (line) => logs.push(line), registry);
		expect(node.qid).toBe("Q1");
		expect(logs.some((l) => l.includes("Q1") && l.includes("Q170611") && l.includes("cached kept"))).toBe(
			true,
		);
	});

	it("THE REPRO: a curated qid survives a rematerialization whose LLM draft name fails to resolve, WITHOUT backfilling the wrong lineage (genre:trap, review round 1 finding BLOCK 1)", async () => {
		// genre:trap carries Q47781397 (EDM lineage, curated by TRA-33's alias). A later
		// rematerialization drafts the name as "Trap (electronic)" -- unresolvable -- so the old
		// (pre-review-round-1) runtime policy would fall back to the slug body "trap", which
		// resolves by the "music"-suffix heuristic to Q2913982 (trap-music, HIP-HOP lineage) and
		// silently overwrite the curated EDM qid + backfill the wrong parent_genres. The
		// cached-wins policy must keep Q47781397 and its own (EDM) lineage instead.
		await cache.write(cachedGenreNode({ slug: "genre:trap", name: "Trap (EDM)", qid: "Q47781397" }));
		const registry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const node: Record<string, unknown> = {
			slug: "genre:trap",
			name: "Trap (electronic)",
			parent_genres: [],
		};
		await enrichFromMusicBrainz(
			node,
			{ type: "genre", name: "Trap (electronic)" },
			() => undefined,
			registry,
		);
		expect(node.qid).toBe("Q47781397");
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const byQid = new Map(parents.map((p) => [p.qid, p]));
		// edm-trap-music's (Q47781397) only catalog parent is bass-music-edm (Q114880130) -- the
		// EDM lineage. trap-music's (Q2913982) parents are hip-hop (Q11401) and us-bass-music --
		// the wrong, hip-hop lineage a name/slug-only resolve would have backfilled instead.
		expect(byQid.has("Q114880130")).toBe(true);
		expect(byQid.has("Q11401")).toBe(false);
	});

	it("existingGenreQid on an unreadable cache file doesn't stop resolution or backfill for the same node", async () => {
		// A corrupt/malformed genre file on disk for THIS SAME slug must not take down the qid
		// resolve + parent_genres backfill that follow it (review round 1, BLOCK 2) -- only
		// existingGenreQid's own read fails; the resolver-driven stamping never touched that file.
		const genreNodesDir = join(dir, "nodes", "genre");
		await mkdir(genreNodesDir, { recursive: true });
		await writeFile(join(genreNodesDir, "electronic.json"), "{ not valid json", "utf8");
		const registry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const node: Record<string, unknown> = { slug: "genre:electronic", name: "Electronic" };
		await expect(
			enrichFromMusicBrainz(node, { type: "genre", name: "Electronic" }, () => undefined, registry),
		).resolves.toBeUndefined();
		// The resolver still stamps the node's own qid via the "music"-suffix heuristic --
		// existingGenreQid's failure on the (unrelated-to-resolution) cache read is invisible here.
		expect(node.qid).toBe("Q9778");
	});
});

describe("runPipeline — cached qid wins on disk, not just in-memory (TRA-32 review round 1, item 3)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-pipeline-genre-qid-e2e-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("the node actually written to cache keeps its curated qid and EDM lineage, not the hip-hop one a fresh resolve would pick", async () => {
		await cache.write({
			type: "genre",
			slug: "genre:trap",
			name: "Trap (EDM)",
			editorial_article:
				"A real long article about this genre, well past the eighty character floor. ".repeat(2),
			editorial_definition: "A short definition.",
			citations: [{ url: "https://example.com/genre" }],
			materialized_at: new Date().toISOString(),
			qid: "Q47781397",
			parent_genres: [],
			subgenres: [],
			related_genres: [],
			key_artists: [],
			key_labels: [],
			landmark_projects: [],
			landmark_tracks: [],
		});
		const genreRegistry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const deps: PipelineDeps = {
			tavilyApiKey: "test",
			firecrawlApiKey: "test",
			geminiApiKey: "test",
			genreRegistry,
		};

		// input.slug pins the exact target slug (TRA-28 review B1/B2), same as a real caller
		// rematerializing an existing dangling/stale reference would.
		const result = await runPipeline({ type: "genre", name: "Trap (electronic)", slug: "genre:trap" }, deps);
		expect(result.node.type).toBe("genre");
		expect((result.node as GenreNode).qid).toBe("Q47781397");

		// Write it, same as a real caller (materialize-service.ts) would, and read back what's
		// actually on disk -- the whole point of this ticket is what gets PERSISTED.
		await cache.write(result.node);
		const onDisk = await cache.get("genre:trap");
		expect(onDisk.type === "genre" && onDisk.qid).toBe("Q47781397");
		if (onDisk.type === "genre") {
			const byQid = new Map(onDisk.parent_genres.map((p) => [p.qid, p]));
			expect(byQid.has("Q114880130")).toBe(true); // bass-music-edm, EDM lineage
			expect(byQid.has("Q11401")).toBe(false); // hip-hop, the wrong lineage
		}
	});
});
