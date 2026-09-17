// Exercises the profile v1 -> v2 migration and the v2 scoring adapter in web/index.html's
// inline script (TRA-135/D2a and TRA-136/D5): loads the real script into jsdom instead of
// reimplementing its logic here, only simulating the DOM/localStorage/fetch boundaries.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATIC_GRAPH_OPTIONS } from "../scripts/build-graph-json.js";
import type { GenreTaxonomyProjection } from "../src/genre-taxonomy-projection.js";
import { buildGraphFromCache } from "../src/graph.js";

// `const` bindings in the inline script never become `window` properties (unlike its
// `function` declarations), so these storage-key literals can't be read back from the
// script and are duplicated here.
const PROFILE_KEY = "odyssey.profile.v1";
const PROFILE_V2_KEY = "odyssey.profile.v2";

interface ProfileV1Fixture {
	createdAt: string;
	name: string;
	email?: string;
	genres: string[];
}

interface MigratedProfile {
	name: string;
	genres: string[];
	unresolvedGenreSlugs?: string[];
	[key: string]: unknown;
}

// Minimal shape for the scoring adapter's graph parameter (byId's own shape in the real
// script): just enough of a VizNode for scoreAffinityFromChoices to read.
interface GraphEdgeRef {
	slug: string;
}
type GraphEdgeKind =
	| "subgenres"
	| "related_genres"
	| "landmark_projects"
	| "landmark_tracks"
	| "key_artists"
	| "genres";
interface GraphNode {
	id: string;
	type: "genre" | "label" | "artist" | "project" | "track";
	edges?: Partial<Record<GraphEdgeKind, GraphEdgeRef[]>>;
}
type ScoringGraph = Map<string, GraphNode>;
interface ScoringChoice {
	id: string;
	slugs: string[];
}

type OdysseyWindow = Window &
	typeof globalThis & {
		migrateProfileToV2: (taxonomy?: GenreTaxonomyProjection) => MigratedProfile | null;
		selectedFamilySlugs: (genreIds: string[], taxonomy: GenreTaxonomyProjection) => string[];
		resolveScoringChoices: (
			genreIds: string[],
			taxonomy: GenreTaxonomyProjection,
			unresolvedGenreSlugs: string[] | undefined,
			graph: ScoringGraph,
			resolveSlug: (slug: string) => string,
		) => ScoringChoice[];
		scoreAffinityFromChoices: (choices: ScoringChoice[], graph: ScoringGraph) => string[];
	};

function makeGraph(nodes: GraphNode[]): ScoringGraph {
	return new Map(nodes.map((n) => [n.id, n]));
}

const indexHtmlPath = fileURLToPath(new URL("../web/index.html", import.meta.url));
const indexHtml = readFileSync(indexHtmlPath, "utf8");

let win: OdysseyWindow;

beforeEach(() => {
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			// init()'s first line awaits this; a promise that never settles freezes it there
			// harmlessly (no throw, no timer) while the rest of the real script -- including
			// the migration functions under test -- still runs to completion.
			window.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
		},
	});
	win = dom.window as unknown as OdysseyWindow;
});

afterEach(() => {
	win.close();
});

function seedV1(genres: string[], overrides: Partial<ProfileV1Fixture> = {}): ProfileV1Fixture {
	const v1: ProfileV1Fixture = {
		createdAt: "2026-01-01T00:00:00.000Z",
		name: "Raph",
		genres,
		...overrides,
	};
	win.localStorage.setItem(PROFILE_KEY, JSON.stringify(v1));
	return v1;
}

// Ids are shaped unlike the graph slugs that map to them ("local:techno" vs. "genre:techno"),
// matching the real projection: an entry's `id` is never the graph slug itself, and every
// slug -- even an unrenamed one -- goes through legacySelectionBySlug.
const taxonomy: GenreTaxonomyProjection = {
	version: 2,
	families: [{ key: "electronic", label: "Electronic", order: 1 }],
	genres: [
		{ id: "local:techno", name: "Techno", family: "electronic", slugs: ["genre:techno"] },
		{ id: "local:house", name: "House", family: "electronic", slugs: ["genre:house"] },
		{ id: "local:idm", name: "IDM", family: "electronic", slugs: ["genre:idm"] },
	],
	legacySelectionBySlug: {
		"genre:techno": ["local:techno"], // current slug, unrenamed
		"genre:old-techno-name": ["local:techno"], // redirected/renamed slug
		"genre:old-electronic-family": ["local:house", "local:idm"], // family -> published children
		"genre:discontinued": [], // explicitly excluded by the migration table
	},
};

// jsdom's Storage is a WebIDL legacy platform object: assigning `win.localStorage.setItem =
// ...` only adds an unrelated own property, it never shadows the real method. Overriding
// Storage.prototype is what actually intercepts calls.
function stubStorageMethod(name: "getItem" | "setItem", impl: () => never): void {
	win.Storage.prototype[name] = impl;
}

describe("profile v1 -> v2 migration (TRA-135)", () => {
	it("keeps v1 intact after migrating", () => {
		const v1 = seedV1(["genre:techno"]);
		win.migrateProfileToV2(taxonomy);
		const rawV1AfterMigration = win.localStorage.getItem(PROFILE_KEY);
		expect(rawV1AfterMigration).toEqual(JSON.stringify(v1));
	});

	it("prefers an existing v2 record over re-deriving from v1", () => {
		seedV1(["genre:old-techno-name"]);
		const existingV2: MigratedProfile = { name: "Raph", genres: ["local:house"] };
		win.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));

		const result = win.migrateProfileToV2(taxonomy);

		expect(result).toEqual(existingV2);
		// v1's redirect would have produced local:techno; v2 must not be recomputed.
		expect(win.localStorage.getItem(PROFILE_V2_KEY)).toEqual(JSON.stringify(existingV2));
	});

	it("follows a known redirect from the legacy migration table", () => {
		seedV1(["genre:old-techno-name"]);
		const result = win.migrateProfileToV2(taxonomy);
		expect(result?.genres).toEqual(["local:techno"]);
	});

	it("expands an old family slug into its published children", () => {
		seedV1(["genre:old-electronic-family"]);
		const result = win.migrateProfileToV2(taxonomy);
		expect(result?.genres.sort()).toEqual(["local:house", "local:idm"]);
		// No family id/key is ever persisted, only its children.
		expect(result?.genres).not.toContain("electronic");
	});

	it("keeps excluded/unresolved legacy genres in unresolvedGenreSlugs, deduped, never dropped", () => {
		seedV1(["genre:techno", "genre:discontinued", "genre:never-existed", "genre:never-existed"]);
		const result = win.migrateProfileToV2(taxonomy);
		expect(result?.genres).toEqual(["local:techno"]);
		expect(result?.unresolvedGenreSlugs?.sort()).toEqual(["genre:discontinued", "genre:never-existed"]);
	});

	it("returns null without a taxonomy, leaving v1 as the caller's source of truth", () => {
		const v1 = seedV1(["genre:techno"]);

		// No taxonomy yet (e.g. an older data.json still being served): nothing can be
		// resolved, so the caller must keep reading v1. Persisting a guess here would let
		// the idempotency guard above freeze it in, unvalidated, forever.
		expect(win.migrateProfileToV2()).toBeNull();
		expect(win.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();

		// A later call with the real taxonomy still migrates properly, unblocked.
		const withTaxonomy = win.migrateProfileToV2(taxonomy);
		expect(withTaxonomy?.genres).toEqual(["local:techno"]);
		expect(win.localStorage.getItem(PROFILE_KEY)).toEqual(JSON.stringify(v1));
	});

	it("treats a malformed taxonomy (wrong version, or no legacySelectionBySlug) like no taxonomy", () => {
		seedV1(["genre:techno"]);
		const noLegacyMap = { version: 2, families: [], genres: [] } as unknown as GenreTaxonomyProjection;
		const wrongVersion = { ...taxonomy, version: 1 } as unknown as GenreTaxonomyProjection;

		expect(win.migrateProfileToV2(noLegacyMap)).toBeNull();
		expect(win.migrateProfileToV2(wrongVersion)).toBeNull();
		expect(win.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();
	});

	it("preserves every personal v1 field (name, email, createdAt) in the migrated v2 record", () => {
		const v1 = seedV1(["genre:techno"], { email: "raph@example.com" });
		const result = win.migrateProfileToV2(taxonomy);
		// A migration that dropped a field (e.g. only copied `name`) would still pass every
		// other assertion in this file; only a full-record comparison catches that.
		expect(result).toEqual({ ...v1, genres: ["local:techno"] });
	});

	it("drops non-string entries from a corrupted v1.genres instead of surfacing them as unresolved", () => {
		win.localStorage.setItem(
			PROFILE_KEY,
			JSON.stringify({ name: "Raph", genres: ["genre:techno", null, 7] }),
		);
		const result = win.migrateProfileToV2(taxonomy);
		expect(result?.genres).toEqual(["local:techno"]);
		expect(result?.unresolvedGenreSlugs).toBeUndefined();
	});

	it("recomputes from v1 when the stored v2 has the wrong shape (e.g. a non-string name)", () => {
		const v1 = seedV1(["genre:techno"]);
		win.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify({ name: 42, genres: ["local:house"] }));
		const result = win.migrateProfileToV2(taxonomy);
		expect(result).toEqual({ ...v1, genres: ["local:techno"] });
	});

	it("returns null and leaves storage untouched when v1 itself is corrupt json", () => {
		win.localStorage.setItem(PROFILE_KEY, "{not valid json");

		const result = win.migrateProfileToV2(taxonomy);

		expect(result).toBeNull();
		expect(win.localStorage.getItem(PROFILE_KEY)).toEqual("{not valid json");
		expect(win.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();
	});

	it("recovers from a corrupt v2 record without losing the v1 backup", () => {
		const v1 = seedV1(["genre:techno"]);
		win.localStorage.setItem(PROFILE_V2_KEY, "{not valid json");

		const result = win.migrateProfileToV2(taxonomy);

		expect(result?.genres).toEqual(["local:techno"]);
		expect(win.localStorage.getItem(PROFILE_KEY)).toEqual(JSON.stringify(v1));
		// Self-healed: a later read now finds a valid v2 instead of the corrupt one.
		expect(win.localStorage.getItem(PROFILE_V2_KEY)).toEqual(JSON.stringify(result));
	});

	it("still returns the migrated profile in memory when storage can't be written (quota)", () => {
		const v1 = seedV1(["genre:techno"]);
		stubStorageMethod("setItem", () => {
			throw new DOMException("quota exceeded", "QuotaExceededError");
		});

		const result = win.migrateProfileToV2(taxonomy);

		expect(result?.genres).toEqual(["local:techno"]);
		// v1 was never touched by the migration, quota or not.
		expect(win.localStorage.getItem(PROFILE_KEY)).toEqual(JSON.stringify(v1));
	});

	it("does not throw when localStorage.getItem itself is unavailable", () => {
		stubStorageMethod("getItem", () => {
			throw new DOMException("storage disabled", "SecurityError");
		});

		expect(() => win.migrateProfileToV2(taxonomy)).not.toThrow();
		expect(win.migrateProfileToV2(taxonomy)).toBeNull();
	});
});

describe("scoreAffinityFromChoices — weights match the pre-existing scoreAffinity (TRA-136/D5)", () => {
	it("applies each weight exactly once for a single-source choice (direct +3, near +1, landmark +4, key_artist +3)", () => {
		const graph = makeGraph([
			{
				id: "genre:techno",
				type: "genre",
				edges: {
					subgenres: [{ slug: "genre:techno-sub" }],
					landmark_projects: [{ slug: "project:landmark_only" }],
					key_artists: [{ slug: "artist:keyartist_only" }, { slug: "artist:hero" }],
				},
			},
			{ id: "genre:techno-sub", type: "genre" },
			{ id: "artist:direct_only", type: "artist", edges: { genres: [{ slug: "genre:techno" }] } },
			{ id: "artist:near_only", type: "artist", edges: { genres: [{ slug: "genre:techno-sub" }] } },
			{ id: "project:landmark_only", type: "project" },
			{ id: "artist:keyartist_only", type: "artist" },
			// Also techno's key artist (curated +3) as well as directly tagged (+3): bonuses stack.
			{ id: "artist:hero", type: "artist", edges: { genres: [{ slug: "genre:techno" }] } },
		]);

		const choices: ScoringChoice[] = [{ id: "local:techno", slugs: ["genre:techno"] }];
		const ranked = win.scoreAffinityFromChoices(choices, graph);

		expect(ranked).toEqual([
			"artist:hero", // 3 (direct) + 3 (key_artist) = 6
			"project:landmark_only", // 4
			"artist:direct_only", // 3
			"artist:keyartist_only", // 3, tied with direct_only -- alphabetical tie-break
			"artist:near_only", // 1
		]);
	});

	it("does not double a choice's bonuses across its two source slugs (decision 4: editorial duplicates)", () => {
		const graph = makeGraph([
			{
				id: "genre:a",
				type: "genre",
				edges: {
					landmark_tracks: [{ slug: "track:shared" }],
					key_artists: [{ slug: "artist:kshared" }],
				},
			},
			{
				id: "genre:b",
				type: "genre",
				// Same curated targets as genre:a -- the merged choice's two sources agree editorially.
				edges: {
					landmark_tracks: [{ slug: "track:shared" }],
					key_artists: [{ slug: "artist:kshared" }],
				},
			},
			{ id: "track:shared", type: "track" },
			{ id: "artist:kshared", type: "artist" },
			// Tagged with both of the merged choice's source slugs -- a doubled direct bonus would
			// score this 6 instead of 3.
			{
				id: "artist:double_tagged",
				type: "artist",
				edges: { genres: [{ slug: "genre:a" }, { slug: "genre:b" }] },
			},
			{
				id: "genre:calib",
				type: "genre",
				edges: {
					landmark_projects: [{ slug: "project:calib4" }],
					key_artists: [{ slug: "artist:calib3" }],
				},
			},
			{ id: "project:calib4", type: "project" },
			{ id: "artist:calib3", type: "artist" },
			{ id: "artist:calib3b", type: "artist", edges: { genres: [{ slug: "genre:calib" }] } },
		]);

		const choices: ScoringChoice[] = [
			{ id: "local:merged", slugs: ["genre:a", "genre:b"] },
			{ id: "local:calib", slugs: ["genre:calib"] },
		];
		const ranked = win.scoreAffinityFromChoices(choices, graph);

		// Every merged-choice score ties its single-source calibration counterpart. A doubled
		// bonus (the bug this adapter fixes) would instead outrank the +4/+3 calibration nodes.
		expect(ranked).toEqual([
			"project:calib4", // 4
			"track:shared", // 4, tied -- alphabetical tie-break
			"artist:calib3", // 3
			"artist:calib3b", // 3
			"artist:double_tagged", // 3
			"artist:kshared", // 3, all tied -- alphabetical tie-break
		]);
	});

	it("counts a direct-tag bonus once even when a node lists the same source slug twice (decision 4: editorial duplicates)", () => {
		const graph = makeGraph([
			{ id: "genre:x", type: "genre" },
			// The same slug tagged twice on one node -- a data duplicate, not two choices.
			{
				id: "artist:dup_tag",
				type: "artist",
				edges: { genres: [{ slug: "genre:x" }, { slug: "genre:x" }] },
			},
			{ id: "genre:calib", type: "genre" },
			{ id: "artist:calib", type: "artist", edges: { genres: [{ slug: "genre:calib" }] } },
		]);

		const choices: ScoringChoice[] = [
			{ id: "local:x", slugs: ["genre:x"] },
			{ id: "local:calib", slugs: ["genre:calib"] },
		];
		const ranked = win.scoreAffinityFromChoices(choices, graph);

		// Ties its single-tag calibration counterpart at +3. A duplicate-tag double bump would
		// instead score it +6 and outrank artist:calib.
		expect(ranked).toEqual(["artist:calib", "artist:dup_tag"]);
	});

	it("does not double a curated bonus when two distinct choices happen to share a source slug", () => {
		const graph = makeGraph([
			{
				id: "genre:shared",
				type: "genre",
				edges: { landmark_projects: [{ slug: "project:shared" }] },
			},
			{ id: "project:shared", type: "project" },
			{
				id: "genre:calib",
				type: "genre",
				edges: { landmark_projects: [{ slug: "project:calib" }] },
			},
			{ id: "project:calib", type: "project" },
		]);

		// Pathological input (resolveScoringChoices guards its own family/child case so this
		// shouldn't happen via that path, but scoreAffinityFromChoices must stay defensive):
		// two distinct choices both listing "genre:shared" as a source.
		const choices: ScoringChoice[] = [
			{ id: "local:a", slugs: ["genre:shared"] },
			{ id: "local:b", slugs: ["genre:shared"] },
			{ id: "local:calib", slugs: ["genre:calib"] },
		];
		const ranked = win.scoreAffinityFromChoices(choices, graph);

		// project:shared ties its single-claim calibration counterpart at +4. A double bump
		// (last-write-wins re-scoring the shared slug under local:b too) would instead score
		// it +8 and outrank project:calib.
		expect(ranked).toEqual(["project:calib", "project:shared"]);
	});

	it.each([
		["artist", { id: "artist:only", type: "artist" as const, edges: { genres: [{ slug: "genre:x" }] } }],
		["project", { id: "project:only", type: "project" as const, edges: { genres: [{ slug: "genre:x" }] } }],
		["track", { id: "track:only", type: "track" as const, edges: { genres: [{ slug: "genre:x" }] } }],
	])("recommends a %s tagged with the selected genre", (_label, neighbor) => {
		const graph = makeGraph([{ id: "genre:x", type: "genre" }, neighbor]);
		const ranked = win.scoreAffinityFromChoices([{ id: "local:x", slugs: ["genre:x"] }], graph);
		expect(ranked).toEqual([neighbor.id]);
	});
});

describe("resolveScoringChoices — family umbrella and legacy sources (TRA-136/D5)", () => {
	const familyTaxonomy: GenreTaxonomyProjection = {
		version: 2,
		families: [{ key: "electronic", label: "Electronic", order: 1, slug: "genre:electronic" }],
		genres: [
			{ id: "local:techno", name: "Techno", family: "electronic", slugs: ["genre:techno"] },
			{ id: "local:house", name: "House", family: "electronic", slugs: ["genre:house"] },
		],
		legacySelectionBySlug: {},
	};

	const identity = (slug: string) => slug;

	it("includes the family's umbrella slug only once every published child is selected", () => {
		const graph = makeGraph([
			{ id: "genre:techno", type: "genre" },
			{ id: "genre:house", type: "genre" },
		]);

		const partial = win.resolveScoringChoices(["local:techno"], familyTaxonomy, [], graph, identity);
		expect(partial.map((c) => c.id)).not.toContain("family:genre:electronic");

		const complete = win.resolveScoringChoices(
			["local:techno", "local:house"],
			familyTaxonomy,
			[],
			graph,
			identity,
		);
		expect(complete).toContainEqual({ id: "family:genre:electronic", slugs: ["genre:electronic"] });
		// No family id is ever a genres[] entry itself (decision 4) -- only its own umbrella slug.
		expect(complete.some((c) => c.id === "electronic")).toBe(false);
	});

	it("does not add a second choice for a family umbrella slug already covered by a selected child (family == child slug)", () => {
		// Unusual but possible taxonomy shape: the family's own resolved umbrella slug happens to
		// equal one of its published children's own source slug.
		const collidingTaxonomy: GenreTaxonomyProjection = {
			version: 2,
			families: [{ key: "electronic", label: "Electronic", order: 1, slug: "genre:techno" }],
			genres: [
				{ id: "local:techno", name: "Techno", family: "electronic", slugs: ["genre:techno"] },
				{ id: "local:house", name: "House", family: "electronic", slugs: ["genre:house"] },
			],
			legacySelectionBySlug: {},
		};
		const graph = makeGraph([
			{ id: "genre:techno", type: "genre" },
			{ id: "genre:house", type: "genre" },
		]);

		const choices = win.resolveScoringChoices(
			["local:techno", "local:house"],
			collidingTaxonomy,
			[],
			graph,
			identity,
		);

		// Both children selected, so the family qualifies -- but its slug is already
		// local:techno's own source. A second "family:genre:techno" choice sharing that slug
		// would double genre:techno's curated edges/tag matches in scoreAffinityFromChoices.
		expect(choices.filter((c) => c.slugs.includes("genre:techno"))).toHaveLength(1);
		expect(choices.some((c) => c.id === "family:genre:techno")).toBe(false);
	});

	it("keeps a still-resolving unresolvedGenreSlugs entry, deduped against already-selected sources", () => {
		const graph = makeGraph([
			{ id: "genre:techno", type: "genre" },
			{ id: "genre:old-standalone", type: "genre" },
		]);

		const choices = win.resolveScoringChoices(
			["local:techno"],
			familyTaxonomy,
			["genre:techno", "genre:old-standalone", "genre:gone"],
			graph,
			identity,
		);

		// genre:techno is already a source of the selected choice -- not added a second time.
		expect(choices.filter((c) => c.slugs.includes("genre:techno"))).toHaveLength(1);
		// genre:old-standalone still resolves in the graph -- kept as its own choice.
		expect(choices).toContainEqual({ id: "genre:old-standalone", slugs: ["genre:old-standalone"] });
		// genre:gone resolves nowhere -- dropped, not turned into a bogus choice.
		expect(choices.some((c) => c.id === "genre:gone")).toBe(false);
	});

	it("resolves a redirected legacy slug through resolveSlug before checking the graph", () => {
		const graph = makeGraph([{ id: "genre:techno", type: "genre" }]);
		const resolveSlug = (slug: string) => (slug === "genre:old-techno-name" ? "genre:techno" : slug);

		const choices = win.resolveScoringChoices(
			[],
			familyTaxonomy,
			["genre:old-techno-name"],
			graph,
			resolveSlug,
		);

		expect(choices).toContainEqual({ id: "genre:old-techno-name", slugs: ["genre:techno"] });
	});
});

describe("scoreAffinityFromChoices — every published choice in the shipped cache (TRA-136/D5)", () => {
	it("recommends at least one node for every choice the strict-taxonomy projection publishes", async () => {
		// Same path npm run build:graph uses (scripts/build-graph-json.ts), strict taxonomy
		// mode, against the committed cache/ -- not a fixture, so this catches an actually
		// published choice left with no admissible neighbor to recommend. ~140 choices are
		// published today; the 210 target lands after E4, so this iterates whatever the
		// projection exports rather than asserting a fixed count.
		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
		const taxonomy = built.taxonomy;
		expect(taxonomy).toBeDefined();
		if (!taxonomy) return;
		expect(taxonomy.genres.length).toBeGreaterThan(0);

		const graph = new Map(built.nodes.map((n) => [n.id, n])) as unknown as ScoringGraph;
		const empty = taxonomy.genres.filter(
			(genre) => win.scoreAffinityFromChoices([{ id: genre.id, slugs: genre.slugs }], graph).length === 0,
		);

		expect(empty.map((g) => g.id)).toEqual([]);
	}, 20000);
});
