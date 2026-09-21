// Exercises the profile v1 -> v2 migration and the v2 scoring adapter in web/index.html's
// inline script (TRA-135/D2a and TRA-136/D5): loads the real script into jsdom instead of
// reimplementing its logic here, only simulating the DOM/localStorage/fetch boundaries.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	name?: string;
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
		scoreAffinity: (genreSlugs: string[]) => string[];
		loadActiveProfile: (taxonomy?: GenreTaxonomyProjection) => MigratedProfile | null;
		currentProfile: () => MigratedProfile | ProfileV1Fixture | null;
		v2EditUnavailable: () => boolean;
		v2PickerChoiceSlugs: (profile: MigratedProfile) => Set<string>;
		distinctPickerChoiceCount: (onSlugs: Iterable<string>, legacyMap: Record<string, string[]>) => number;
		distinctPickerChoiceSlugs: (onSlugs: Iterable<string>, legacyMap: Record<string, string[]>) => string[];
		renderProfileChip: () => void;
		showHome: () => void;
		idsToPickerSlugs: (
			ids: string[],
			unresolvedSlugs: string[] | undefined,
			pickerSlugs: string[],
			legacyMap: Record<string, string[]>,
		) => Set<string>;
		mergePickerSelectionIntoV2: (
			current: MigratedProfile,
			initialSlugs: Iterable<string>,
			finalSlugs: Iterable<string>,
			taxonomy?: GenreTaxonomyProjection,
		) => MigratedProfile | null;
		pickDailyReco: (opts?: { reroll?: boolean }) => { id: string } | null;
		wireOnboarding: () => void;
		openOnboarding: (opts?: { mode?: "signup" | "edit" }) => void;
		genrePickList: () => string[];
		renderGenreGrid: () => void;
		recoReasons: (node: GraphNode) => GraphEdgeRef[];
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
		"genre:house": ["local:house"], // current slug, unrenamed
		"genre:idm": ["local:idm"], // current slug, unrenamed
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

// Profile.load() runs synchronously while the script parses, so seedV1() (which writes to
// the shared `win` after it already exists) never reaches Profile.data -- only functions
// that re-read storage themselves (migrateProfileToV2 & friends) see it. A test exercising
// the v1 *fallback* (currentProfile() falling back to Profile.data, e.g. the old picker's
// open/save flow) needs v1 seeded before the script parses instead, matching a real browser
// visit where localStorage already holds whatever a previous session left there.
// PROFILE_V2_ENABLED defaults true (TRA-251); pass v2Enabled: false to regression-test the
// kill switch itself.
function newWindowWithV1(genres: string[], overrides: Partial<ProfileV1Fixture> = {}, v2Enabled = true) {
	const v1: ProfileV1Fixture = { createdAt: "2026-01-01T00:00:00.000Z", name: "Raph", genres, ...overrides };
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
			window.localStorage.setItem(PROFILE_KEY, JSON.stringify(v1));
			if (!v2Enabled) (window as unknown as Record<string, unknown>).__PROFILE_V2_ENABLED__ = false;
		},
	});
	return { win: dom.window as unknown as OdysseyWindow, v1 };
}

// PROFILE_V2_ENABLED gates the whole v2 path behind a `const` the script reads once at parse
// time (TRA-137/D2b-1), so a test can't flip it after construction the way it can window.fetch
// -- window.__PROFILE_V2_ENABLED__ must already be set in beforeParse. No v1 record at all:
// decision 4's "v2 profile with no v1 backing" case.
function newV2Window(): OdysseyWindow {
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
			(window as unknown as Record<string, unknown>).__PROFILE_V2_ENABLED__ = true;
		},
	});
	return dom.window as unknown as OdysseyWindow;
}

// Seeds v1 post-construction -- fine for storage-reading functions (migrateProfileToV2 & co),
// unlike Profile.data (see newWindowWithV1 above).
function seedV1On(w: OdysseyWindow, genres: string[]): void {
	w.localStorage.setItem(PROFILE_KEY, JSON.stringify({ createdAt: "x", name: "Raph", genres }));
}

// Real graph + real taxonomy (same path as the D5 "shipped cache" test), for tests that must
// exercise our own code instead of stubbing it (nit, 3rd review: don't mock what we own).
// TRA-282: GENRE_GRID_ENABLED now defaults true, and the real cache ships a usable taxonomy, so
// leaving `gridEnabled` at its default renders the id-based grid, same as a real deploy. Pass
// `gridEnabled: false` only to exercise the flat picker's own functions (mergePickerSelectionIntoV2,
// idsToPickerSlugs) directly -- the rollback lever, no longer the default path.
async function newRealGraphWindow({
	gridEnabled = true,
}: {
	gridEnabled?: boolean;
} = {}): Promise<{ win: OdysseyWindow; taxonomy: GenreTaxonomyProjection }> {
	const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
	const realTaxonomy = built.taxonomy;
	if (!realTaxonomy) throw new Error("cache built without a taxonomy");
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.fetch = (async () => new Response(JSON.stringify(built))) as unknown as typeof fetch;
			(window as unknown as Record<string, unknown>).__PROFILE_V2_ENABLED__ = true;
			(window as unknown as Record<string, unknown>).__GENRE_GRID_ENABLED__ = gridEnabled;
		},
	});
	const w = dom.window as unknown as OdysseyWindow;
	// "…" is the static placeholder in the markup itself -- wait for init() to replace it.
	await vi.waitFor(() => {
		if ((w.document.getElementById("stat") as HTMLElement).textContent === "…") throw new Error("not ready");
	});
	return { win: w, taxonomy: realTaxonomy };
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

describe("PROFILE_V2_ENABLED — defaults true (TRA-251), still forceable off as a rollback lever", () => {
	it("true by default: an existing v2 activates", () => {
		const v2 = newV2Window();
		try {
			v2.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify({ name: "Raph", genres: ["local:house"] }));
			expect(v2.loadActiveProfile(taxonomy)).not.toBeNull();
		} finally {
			v2.close();
		}
	});

	it("forced false: loadActiveProfile stays a no-op, currentProfile only ever reflects v1, and v2 storage stays untouched", () => {
		const { win: w, v1 } = newWindowWithV1(["genre:techno"], {}, false);
		try {
			expect(w.loadActiveProfile(taxonomy)).toBeNull();
			expect(w.currentProfile()).toEqual(v1);
			expect(w.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();
		} finally {
			w.close();
		}
	});
});

describe("loadActiveProfile / currentProfile — v2 activation after the graph is ready (TRA-137/D2b, flag on)", () => {
	it("migrates/activates only once called (criterion 1), never without a usable taxonomy (criterion 2)", () => {
		const v2 = newV2Window();
		try {
			seedV1On(v2, ["genre:techno"]);
			// init() only calls this after DATA/byId are populated by the graph fetch -- nothing
			// promotes v2 on its own before that.
			expect(v2.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();
			expect(v2.loadActiveProfile(undefined)).toBeNull(); // no taxonomy: still nothing written
			expect(v2.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();

			const activated = v2.loadActiveProfile(taxonomy);

			expect(activated?.genres).toEqual(["local:techno"]);
			expect(v2.currentProfile()).toEqual(activated);
			expect(v2.localStorage.getItem(PROFILE_V2_KEY)).not.toBeNull();

			// B3: showHome renders from currentProfile(), not a stale Profile.data.
			v2.showHome();
			expect((v2.document.querySelector(".home-hello") as HTMLElement).textContent).toContain("Raph");
		} finally {
			v2.close();
		}
	});

	it("B2: keeps an already-existing v2 in storage (never overwritten/back-migrated) but not *active* without a usable taxonomy this session", () => {
		const v2 = newV2Window();
		try {
			const existingV2: MigratedProfile = { name: "Raph", genres: ["local:house"] };
			v2.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));

			// activeV2 (what the app reads/scores/writes against) stays inactive.
			expect(v2.loadActiveProfile(undefined)).toBeNull();
			expect(v2.v2EditUnavailable()).toBe(true);
			expect(v2.localStorage.getItem(PROFILE_V2_KEY)).toEqual(JSON.stringify(existingV2));

			// The actual crash path: both used to feed a null TAXONOMY straight into
			// resolveScoringChoices via activeV2.genres and throw a TypeError.
			expect(() => v2.pickDailyReco()).not.toThrow();
			expect(() => v2.recoReasons({ id: "artist:hero", type: "artist", edges: {} })).not.toThrow();
		} finally {
			v2.close();
		}
	});
});

describe("pickDailyReco — v2 scoring adapter vs. v1 wrapper (TRA-137/D2b, flag on)", () => {
	it("routes through resolveScoringChoices + scoreAffinityFromChoices when a v2 profile is active", () => {
		const v2 = newV2Window();
		try {
			seedV1On(v2, ["genre:techno"]);
			v2.loadActiveProfile(taxonomy); // activates v2 (genres: ["local:techno"])

			const resolveSpy = vi.fn(() => []);
			const scoreSpy = vi.fn(() => []);
			const v1WrapperSpy = vi.fn(() => []);
			v2.resolveScoringChoices = resolveSpy;
			v2.scoreAffinityFromChoices = scoreSpy;
			v2.scoreAffinity = v1WrapperSpy;

			v2.pickDailyReco();

			expect(resolveSpy).toHaveBeenCalledTimes(1);
			expect(scoreSpy).toHaveBeenCalledTimes(1);
			expect(v1WrapperSpy).not.toHaveBeenCalled();
		} finally {
			v2.close();
		}
	});

	it("keeps the v1 wrapper when no v2 profile is active", () => {
		// currentProfile()'s v1 fallback reads Profile.data, which only reflects storage
		// seeded before the script parses (see newWindowWithV1's comment) -- unlike the v2
		// activation test above, which reads storage directly and doesn't need that.
		const { win: w, v1 } = newWindowWithV1(["genre:techno"]);
		try {
			const resolveSpy = vi.fn(() => []);
			const v1WrapperSpy = vi.fn(() => []);
			w.resolveScoringChoices = resolveSpy;
			w.scoreAffinity = v1WrapperSpy;

			w.pickDailyReco();

			expect(v1WrapperSpy).toHaveBeenCalledWith(v1.genres);
			expect(resolveSpy).not.toHaveBeenCalled();
		} finally {
			w.close();
		}
	});
});

// A picker slug that expands to several ids (an old family slug) -- exercises B1 without
// needing the real cache's full 16/8-id families. Only legacySelectionBySlug is read here.
const rockJazzTaxonomy: GenreTaxonomyProjection = {
	version: 2,
	families: [],
	genres: [],
	legacySelectionBySlug: {
		"genre:rock": ["local:rock-1", "local:rock-2", "local:rock-3"],
		"genre:jazz": ["local:jazz-1", "local:jazz-2"],
		"genre:techno": ["local:techno"],
	},
};

// Nested/overlapping expansions (3rd review, B5): genre:rock's ids fully contain
// genre:krautrock's/psychedelic-rock's, mirroring the taxonomy shape that broke unchecking rock
// alone. local:rock-4 is "pure rock", covered by no subfamily.
const nestedRockTaxonomy: GenreTaxonomyProjection = {
	version: 2,
	families: [],
	genres: [],
	legacySelectionBySlug: {
		"genre:rock": ["local:rock-1", "local:rock-2", "local:rock-3", "local:rock-4"],
		"genre:krautrock": ["local:rock-1", "local:rock-2"],
		"genre:psychedelic-rock": ["local:rock-3"],
		"genre:techno": ["local:techno"],
		"genre:house": ["local:house"],
	},
};

describe("idsToPickerSlugs — old picker checkbox state (TRA-251, review B1 & B4)", () => {
	it("marks a picker slug 'on' only when its resolved id is selected -- ids and slugs are never compared directly", () => {
		const on = win.idsToPickerSlugs(
			["local:techno"],
			[],
			["genre:techno", "genre:house", "genre:idm"],
			taxonomy.legacySelectionBySlug,
		);
		// `on` is a Set built in the jsdom realm -- cross-realm Sets don't compare via toEqual.
		expect([...on]).toEqual(["genre:techno"]);
	});

	it("shows no checkbox for a selected id the picker can't represent (a merged/off-picker choice)", () => {
		const on = win.idsToPickerSlugs(
			["local:off-picker-choice"],
			[],
			["genre:techno"],
			taxonomy.legacySelectionBySlug,
		);
		expect(on.size).toBe(0);
	});

	it("B1: a family/multi-id slug is 'on' only once every one of its ids is selected, never on a partial match", () => {
		// One of three rock ids selected (the real-world "Blues rock without Q379033" report).
		const partial = win.idsToPickerSlugs(
			["local:rock-1"],
			[],
			["genre:rock"],
			rockJazzTaxonomy.legacySelectionBySlug,
		);
		expect(partial.size).toBe(0);
		const complete = win.idsToPickerSlugs(
			["local:rock-1", "local:rock-2", "local:rock-3"],
			[],
			["genre:rock"],
			rockJazzTaxonomy.legacySelectionBySlug,
		);
		expect([...complete]).toEqual(["genre:rock"]);
	});

	it("B4: a slug the taxonomy can't resolve at all is 'on' when tracked in unresolvedGenreSlugs", () => {
		const on = win.idsToPickerSlugs(
			[],
			["genre:pop"],
			["genre:pop", "genre:techno"],
			taxonomy.legacySelectionBySlug,
		);
		expect([...on]).toEqual(["genre:pop"]);
	});
});

describe("mergePickerSelectionIntoV2 — delta-only save (TRA-251, review B1 & B4)", () => {
	it("returns null without a usable taxonomy -- v2 is never written without one (criterion 2)", () => {
		const current: MigratedProfile = { name: "Raph", genres: ["local:techno"] };
		expect(
			win.mergePickerSelectionIntoV2(current, ["genre:house"], ["genre:house", "genre:techno"], undefined),
		).toBeNull();
	});

	it("B1: an untouched save changes nothing, even for a partially-selected family (reproduces the Blues rock report)", () => {
		const current: MigratedProfile = { name: "Raph", genres: ["local:rock-1", "local:techno"] };
		const initial = win.idsToPickerSlugs(
			current.genres,
			[],
			["genre:rock", "genre:techno"],
			rockJazzTaxonomy.legacySelectionBySlug,
		);
		const next = win.mergePickerSelectionIntoV2(current, initial, initial, rockJazzTaxonomy); // no toggles this round
		expect(next?.genres.slice().sort()).toEqual(["local:rock-1", "local:techno"]);
	});

	it("B1: checking a family slug adds every one of its ids; unchecking another removes only its own, leaving an untouched partial family and an untouched off-picker id alone", () => {
		const current: MigratedProfile = {
			name: "Raph",
			genres: ["local:rock-1", "local:techno", "local:off-picker-choice"],
		};
		const initial = win.idsToPickerSlugs(
			current.genres,
			[],
			["genre:rock", "genre:jazz", "genre:techno"],
			rockJazzTaxonomy.legacySelectionBySlug,
		);
		expect([...initial]).toEqual(["genre:techno"]); // rock starts partial (unchecked), jazz unchecked

		const final = new Set(["genre:jazz"]); // check jazz, uncheck techno; rock and the off-picker id untouched
		const next = win.mergePickerSelectionIntoV2(current, initial, final, rockJazzTaxonomy);
		// Mutation guard: reverting to a full recompute-from-final would drop both local:rock-1
		// (untouched partial family) and local:off-picker-choice (no picker slug covers it).
		expect(next?.genres.slice().sort()).toEqual(
			["local:jazz-1", "local:jazz-2", "local:off-picker-choice", "local:rock-1"].sort(),
		);
	});

	it("keeps an id the picker never offered a checkbox for untouched (criterion 7: choices outside the v1 picker)", () => {
		const current: MigratedProfile = { name: "Raph", genres: ["local:techno", "local:off-picker-choice"] };
		const next = win.mergePickerSelectionIntoV2(current, ["genre:techno"], ["genre:techno"], taxonomy);
		expect(next?.genres.slice().sort()).toEqual(["local:off-picker-choice", "local:techno"]);
	});

	it("B4: carries forward existing unresolvedGenreSlugs untouched, and drops one once its checkbox is unchecked", () => {
		const current: MigratedProfile = {
			name: "Raph",
			genres: ["local:techno"],
			unresolvedGenreSlugs: ["genre:long-gone", "genre:pop"],
		};
		// genre:pop started checked (it's in unresolvedGenreSlugs); this session unchecks it.
		const next = win.mergePickerSelectionIntoV2(
			current,
			["genre:techno", "genre:pop"],
			["genre:techno"],
			taxonomy,
		);
		expect(next?.unresolvedGenreSlugs).toEqual(["genre:long-gone"]);
	});

	it("adds a newly checked slug that still fails to resolve to unresolvedGenreSlugs instead of silently dropping it", () => {
		const current: MigratedProfile = { name: "Raph", genres: [] };
		const next = win.mergePickerSelectionIntoV2(current, [], ["genre:discontinued"], taxonomy);
		expect(next?.genres).toEqual([]);
		expect(next?.unresolvedGenreSlugs).toEqual(["genre:discontinued"]);
	});

	it("B5: unchecking an overlapping chip only drops ids no still-checked chip covers", () => {
		const current: MigratedProfile = {
			name: "Raph",
			genres: ["local:rock-1", "local:rock-2", "local:rock-3", "local:rock-4", "local:techno"],
		};
		const initial = new Set(["genre:rock", "genre:krautrock", "genre:psychedelic-rock", "genre:techno"]);
		const final = new Set(["genre:krautrock", "genre:psychedelic-rock", "genre:techno", "genre:house"]); // uncheck rock, check house
		const next = win.mergePickerSelectionIntoV2(current, initial, final, nestedRockTaxonomy);
		// rock-1/2/3 (covered by krautrock/psychedelic-rock, still checked) survive; rock-4 ("pure
		// rock") is dropped; house is added; techno stays untouched.
		expect(next?.genres.slice().sort()).toEqual(
			["local:house", "local:rock-1", "local:rock-2", "local:rock-3", "local:techno"].sort(),
		);
	});

	// TRA-270 (3rd review of #237, reported as a non-blocking nit): B5 above computed
	// stillCoveredIds once from every slug left in `final`, genre:rock included -- so unchecking
	// genre:krautrock alone, with genre:rock still checked, removed nothing: rock's own
	// completeness always "covers" krautrock's ids back, since they're a subset of it. The bug
	// report's exact repro (profile holding all 16 genre:rock ids, uncheck genre:krautrock only).
	it("TRA-270: unchecking a subfamily removes its own ids even while its family stays checked, without touching a sibling's", () => {
		const current: MigratedProfile = {
			name: "Raph",
			genres: ["local:rock-1", "local:rock-2", "local:rock-3", "local:rock-4", "local:techno"],
		};
		const initial = new Set(["genre:rock", "genre:krautrock", "genre:psychedelic-rock", "genre:techno"]);
		const final = new Set(["genre:rock", "genre:psychedelic-rock", "genre:techno"]); // uncheck krautrock only
		const next = win.mergePickerSelectionIntoV2(current, initial, final, nestedRockTaxonomy);
		// krautrock's own rock-1/rock-2 are gone; rock-3 survives (psychedelic-rock still claims
		// it); rock-4 and techno are untouched (neither's slug left `final`).
		expect(next?.genres.slice().sort()).toEqual(["local:rock-3", "local:rock-4", "local:techno"].sort());
	});
});

describe("distinctPickerChoiceCount — nit (3rd review): a chip's count doesn't inflate from nested taxonomy overlap", () => {
	it("collapses a subfamily fully covered by another checked chip", () => {
		const on = new Set(["genre:rock", "genre:krautrock", "genre:psychedelic-rock", "genre:techno"]);
		// krautrock/psychedelic-rock are dominated by rock's expansion -> not counted. 2, not 4.
		expect(win.distinctPickerChoiceCount(on, nestedRockTaxonomy.legacySelectionBySlug)).toBe(2);
	});
});

// TRA-270 criterion 4: a fuzz generalizing the bug report (genre:rock's 16 ids, uncheck
// genre:krautrock alone) across many random nested-family shapes. Two things must both hold on
// every run: the unchecked subfamily's own ids are actually gone (criterion 1, generalized), and
// every OTHER still-checked subfamily's ids -- plus any "pure family" id no subfamily covers --
// are never touched. Deterministic PRNG (mulberry32, no new dependency): reproducible seed, no
// CI flakiness, still many pseudo-random cases.
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("mergePickerSelectionIntoV2 fuzz — TRA-270 criterion 4: unchecking a subfamily loses exactly its own ids", () => {
	it("holds across 205 randomized nested families (mirrors the review's own fuzz sample size)", () => {
		const rng = mulberry32(270);
		for (let run = 0; run < 205; run++) {
			// 2-4 disjoint subfamilies (like genre:krautrock/genre:psychedelic-rock: no id shared
			// between them), each 1-3 ids, plus an optional "pure family" residual (like rock-4)
			// covered by genre:family alone. genre:family is every id's union, always fully checked.
			const subfamilyCount = 2 + Math.floor(rng() * 3);
			const groups: string[][] = [];
			let idCursor = 0;
			for (let g = 0; g < subfamilyCount; g++) {
				const size = 1 + Math.floor(rng() * 3);
				const group: string[] = [];
				for (let i = 0; i < size; i++) group.push(`local:id-${idCursor++}`);
				groups.push(group);
			}
			const residualSize = rng() < 0.5 ? 1 + Math.floor(rng() * 2) : 0;
			const residual: string[] = [];
			for (let i = 0; i < residualSize; i++) residual.push(`local:id-${idCursor++}`);

			const legacyMap: Record<string, string[]> = { "genre:family": [...groups.flat(), ...residual] };
			groups.forEach((group, g) => {
				legacyMap[`genre:sub-${g}`] = group;
			});
			const fuzzTaxonomy: GenreTaxonomyProjection = {
				version: 2,
				families: [],
				genres: [],
				legacySelectionBySlug: legacyMap,
			};
			const allSlugs = Object.keys(legacyMap);
			const current: MigratedProfile = { name: "Raph", genres: legacyMap["genre:family"] as string[] };

			const initial = win.idsToPickerSlugs(current.genres, [], allSlugs, legacyMap);
			// Sanity: the full family being checked also lights up every subfamily (same nesting
			// as B5) -- otherwise this run doesn't exercise the bug at all.
			expect([...initial].sort()).toEqual(allSlugs.sort());

			const victim = Math.floor(rng() * subfamilyCount);
			const final = new Set([...initial].filter((slug) => slug !== `genre:sub-${victim}`));

			const next = win.mergePickerSelectionIntoV2(current, initial, final, fuzzTaxonomy);
			expect(next).not.toBeNull();

			for (const id of groups[victim] as string[]) {
				expect(
					next?.genres,
					`run ${run}: victim id ${id} survived unchecking genre:sub-${victim} even though genre:family stayed checked`,
				).not.toContain(id);
			}
			groups.forEach((group, g) => {
				if (g === victim) return;
				for (const id of group) {
					expect(next?.genres, `run ${run}: sibling id ${id} (genre:sub-${g}) was wrongly lost`).toContain(
						id,
					);
				}
			});
			for (const id of residual) {
				expect(next?.genres, `run ${run}: residual "pure family" id ${id} was wrongly lost`).toContain(id);
			}
		}
	});
});

// TRA-270 criterion 2 (3rd review of #237): web/index.html:1367-1368 rendered showHome()'s
// "Tes genres" list from the raw, un-deduplicated v2PickerChoiceSlugs set while its own comment
// claimed it matched the profile chip's count above -- distinctPickerChoiceCount already folded
// a dominated subfamily (e.g. genre:krautrock, fully covered by a checked genre:rock) into its
// family, but the list still rendered it as its own separate pill. Real graph (nit, don't mock
// what we own): genre:rock's real 16-id expansion genuinely nests a real subfamily's.
// TRA-282 (2026-09-19): gridEnabled: false -- this test exercises v2PickerChoiceSlugs()/
// distinctPickerChoiceSlugs()'s own dedup logic (a flat-picker-slug concept: one *slug* can
// expand to several ids, so a dominated child slug folds into its parent's). That nesting doesn't
// exist in the grid's id space -- a grid pick is always one atomic leaf id -- so once
// GENRE_GRID_ENABLED defaults on, showHome()/renderProfileChip() route a grid-driven profile
// through gridChoiceChips() instead (one id, one chip, no folding: see the "grid-driven home
// chips/badge" describe block below for that path's own coverage). This test stays pinned to the
// flat repli to keep asserting the legacy dedup path unchanged.
describe("home genre list vs. profile chip counter — TRA-270: same deduplicated set", () => {
	it("renders exactly as many home chips as the profile chip's own count, collapsing a dominated subfamily", async () => {
		const { win: w, taxonomy: realTaxonomy } = await newRealGraphWindow({ gridEnabled: false });
		try {
			const legacyMap = realTaxonomy.legacySelectionBySlug as Record<string, string[]>;
			const rockIds = legacyMap["genre:rock"] ?? [];
			expect(rockIds.length).toBeGreaterThan(1); // sanity: a real multi-id family exists

			const existingV2: MigratedProfile = { name: "Raph", genres: [...rockIds] };
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			const profile = w.loadActiveProfile(realTaxonomy);
			expect(profile).not.toBeNull();

			const onSlugs = w.v2PickerChoiceSlugs(profile as MigratedProfile);
			const deduped = w.distinctPickerChoiceSlugs(onSlugs, legacyMap);
			// Sanity: this profile really does exercise the nesting -- otherwise the assertions
			// below would pass even without the fix.
			expect(onSlugs.size).toBeGreaterThan(deduped.length);

			w.renderProfileChip();
			w.showHome();
			const chipText = (w.document.getElementById("profile-chip") as HTMLElement).textContent ?? "";
			const chipCount = Number(chipText.match(/(\d+) genres/)?.[1]);
			const listedCount = w.document.querySelectorAll(".home-genres .chip[data-id]").length;

			expect(chipCount).toBe(deduped.length);
			// Mutation guard: reverting web/index.html:1368 to the raw `onSlugs` set would render
			// onSlugs.size chips here instead, which the sanity check above already proved is
			// strictly more than deduped.length.
			expect(listedCount).toBe(deduped.length);
		} finally {
			w.close();
		}
	}, 20000);
});

describe("pickDailyReco — B4: recommendable through unresolved slugs with no resolved id", () => {
	// Nit (3rd review): resolveScoringChoices is code we own, so this exercises the real
	// computation against the real graph instead of stubbing it out.
	it("still scores (a real, non-empty reco) when every pick is an unresolved-but-graph-existing slug", async () => {
		const { win: w, taxonomy: realTaxonomy } = await newRealGraphWindow();
		try {
			const [unresolvedSlug] = w.genrePickList(); // any real, graph-existing genre slug
			expect(unresolvedSlug).toBeDefined();
			const noIdV2: MigratedProfile = {
				name: "Raph",
				genres: [],
				unresolvedGenreSlugs: [unresolvedSlug as string],
			};
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(noIdV2));
			w.loadActiveProfile(realTaxonomy);

			// Reaches the real scoring engine and finds something -- before the fix,
			// genres.length === 0 bailed out before resolveScoringChoices (which would have
			// found this slug) ever ran.
			expect(w.pickDailyReco()).not.toBeNull();
		} finally {
			w.close();
		}
	}, 20000);
});

describe("onboarding UI wiring — old picker still operates (TRA-137/D2b, criteria 3 & 4)", () => {
	it("the v1 picker/save flow works unchanged when no v2 is active (criterion 3)", () => {
		const { win: w, v1 } = newWindowWithV1(["genre:techno", "genre:house", "genre:idm"]);
		try {
			w.wireOnboarding();
			w.openOnboarding({ mode: "edit" });
			(w.document.getElementById("onb-done") as HTMLButtonElement).click();

			const saved = JSON.parse(w.localStorage.getItem(PROFILE_KEY) ?? "null");
			expect(saved.genres.slice().sort()).toEqual(v1.genres.slice().sort());
			expect(w.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();
		} finally {
			w.close();
		}
	});

	it("cancelling (edit mode's back button) writes nothing (criterion 4)", () => {
		const v1 = seedV1(["genre:techno", "genre:house", "genre:idm"]);
		win.wireOnboarding();
		win.openOnboarding({ mode: "edit" });
		(win.document.getElementById("onb-back") as HTMLButtonElement).click();

		expect(win.localStorage.getItem(PROFILE_KEY)).toEqual(JSON.stringify(v1));
		expect(win.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();
	});

	it("B2: locks editing out (chip message, disabled done, guard rejects even a non-empty selection) when taxonomy is unusable", () => {
		// v1 seeded pre-parse (>= MIN_GENRES) so onbSelection ends up non-empty -- otherwise
		// "done" staying disabled could just be the unrelated MIN_GENRES gate, not the lock.
		const { win: w, v1 } = newWindowWithV1(["genre:techno", "genre:house", "genre:idm"]);
		try {
			const existingV2: MigratedProfile = { name: "Raph", genres: ["local:house"] };
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			w.loadActiveProfile(undefined); // v2 stays stored (decision 4), TAXONOMY null this run

			w.wireOnboarding();
			w.renderProfileChip();
			expect((w.document.getElementById("profile-chip") as HTMLElement).textContent).toContain("conservées");

			w.openOnboarding({ mode: "edit" }); // onbSelection seeded from the v1 fallback: 3 slugs
			const done = w.document.getElementById("onb-done") as HTMLButtonElement;
			expect(done.disabled).toBe(true);
			// A disabled button's own .click() no-ops before the listener runs -- dispatching the
			// event directly is what actually proves the handler's index.html guard, not just the
			// disabled attribute, rejects the write (removing either must fail this test).
			done.dispatchEvent(new w.Event("click", { bubbles: true }));

			expect(w.localStorage.getItem(PROFILE_V2_KEY)).toEqual(JSON.stringify(existingV2));
			expect(w.localStorage.getItem(PROFILE_KEY)).toEqual(JSON.stringify(v1)); // v1 untouched too
		} finally {
			w.close();
		}
	});

	it("nit 3 (2nd review): a v2-only user (no v1) locked out by a missing taxonomy isn't treated as a new visitor on ?view=home", () => {
		const v2 = newV2Window();
		try {
			const existingV2: MigratedProfile = { name: "Raph", genres: ["local:house", "local:idm"] };
			v2.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			v2.loadActiveProfile(undefined);

			v2.showHome();
			const html = v2.document.querySelector(".home")?.textContent ?? "";
			expect(html).toContain("Raph");
			expect(html).not.toContain("Bienvenue");
			expect(html).not.toContain("Créer mon compte");
		} finally {
			v2.close();
		}
	});

	it("nit 4 (2nd review): v1 and v2 both present, taxonomy missing -- shows the stored v2's name/count read-only, not the stale v1", () => {
		const { win: w } = newWindowWithV1(["genre:techno", "genre:house", "genre:idm"], { name: "Old Name" });
		try {
			const existingV2: MigratedProfile = { name: "New Name", genres: ["local:house"] };
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			w.loadActiveProfile(undefined);

			w.showHome();
			const html = w.document.querySelector(".home")?.textContent ?? "";
			expect(html).toContain("New Name");
			expect(html).not.toContain("Old Name");
		} finally {
			w.close();
		}
	});

	// nit 5: genrePickList/renderGenreGrid are code we own -- run the real graph (built from
	// cache/, the same path the D5 "shipped cache" test above uses) through a real fetch
	// instead of stubbing them.
	it("saves through the real onb-done handler and the real picker/graph, preserving an off-picker id (criteria 5, 6, 7)", async () => {
		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
		const realTaxonomy = built.taxonomy;
		expect(realTaxonomy).toBeDefined();
		if (!realTaxonomy) return;

		const dom = new JSDOM(indexHtml, {
			url: "http://localhost/",
			runScripts: "dangerously",
			pretendToBeVisual: false,
			beforeParse(window) {
				window.fetch = (async () => new Response(JSON.stringify(built))) as unknown as typeof fetch;
				(window as unknown as Record<string, unknown>).__PROFILE_V2_ENABLED__ = true;
			},
		});
		const w = dom.window as unknown as OdysseyWindow;
		try {
			// "…" is the static placeholder in the markup itself -- wait for init() to replace it.
			await vi.waitFor(() => {
				if ((w.document.getElementById("stat") as HTMLElement).textContent === "…")
					throw new Error("not ready");
			});

			// Three real, currently-resolving picker slugs (whatever their legacySelectionBySlug
			// expansion is -- single or multi-id) plus a fake off-picker id that must survive.
			const picks: string[] = [];
			let checked = 0;
			const legacyMap = realTaxonomy.legacySelectionBySlug as Record<string, string[]>;
			for (const slug of w.genrePickList()) {
				const ids = legacyMap[slug];
				if (Array.isArray(ids) && ids.length > 0) {
					picks.push(...ids);
					checked++;
				}
				if (checked === 3) break;
			}
			expect(checked).toBe(3); // sanity: the curated picker always has resolving entries
			const existingV2: MigratedProfile = { name: "Raph", genres: [...picks, "local:off-picker-choice"] };
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			w.loadActiveProfile(realTaxonomy); // re-read storage with the seeded v2 now in it

			w.wireOnboarding();
			w.openOnboarding({ mode: "edit" }); // real renderGenreGrid(): seeds onbSelection from the real graph
			(w.document.getElementById("onb-done") as HTMLButtonElement).click(); // untouched save

			const saved = JSON.parse(w.localStorage.getItem(PROFILE_V2_KEY) ?? "null");
			expect(saved.genres.slice().sort()).toEqual([...picks, "local:off-picker-choice"].sort());
		} finally {
			w.close();
		}
	}, 20000);

	// Trous de test (3rd review): the test above only exercises an *untouched* save, which can't
	// tell a proper clone of onbInitialSelection apart from an aliased one (onbSelection ===
	// onbInitialSelection) or an always-empty one. This one clicks for real: unchecks a checked
	// chip, checks an off one, and saves.
	it("a real #onb-done edit (uncheck + check) persists the delta, and open-time seeding reflects unresolvedGenreSlugs (kills the onbInitialSelection aliasing/empty-Set/ignored-unresolved mutants)", async () => {
		// gridEnabled: false -- this test exercises mergePickerSelectionIntoV2's own slug-space
		// delta logic (data-slug chips), which TRA-282 no longer runs by default; the grid's
		// equivalent (mergeGridSelectionIntoV2) has its own id-space coverage in genre-picker.test.ts.
		const { win: w, taxonomy: realTaxonomy } = await newRealGraphWindow({ gridEnabled: false });
		try {
			const legacyMap = realTaxonomy.legacySelectionBySlug as Record<string, string[]>;
			const resolving = w.genrePickList().filter((slug) => (legacyMap[slug] ?? []).length > 0);
			expect(resolving.length).toBeGreaterThanOrEqual(3);
			const [slugA, slugB, slugC] = resolving as [string, string, string];
			const unresolvedSlug = w.genrePickList().find((s) => s !== slugA && s !== slugB && s !== slugC);
			expect(unresolvedSlug).toBeDefined();

			const existingV2: MigratedProfile = {
				name: "Raph",
				genres: [...(legacyMap[slugA] ?? []), ...(legacyMap[slugB] ?? []), "local:off-picker-choice"],
				unresolvedGenreSlugs: [unresolvedSlug as string],
			};
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			w.loadActiveProfile(realTaxonomy);

			w.wireOnboarding();
			w.openOnboarding({ mode: "edit" });
			const btn = (slug: string) =>
				w.document.querySelector(`.genre-pick[data-slug="${slug}"]`) as HTMLElement;
			// nits 4/5: open-time seeding must reflect both the resolved ids and the unresolved
			// slug -- openOnboarding / v2PickerChoiceSlugs must not ignore unresolvedGenreSlugs.
			expect(btn(slugA).classList.contains("on")).toBe(true);
			expect(btn(slugB).classList.contains("on")).toBe(true);
			expect(btn(unresolvedSlug as string).classList.contains("on")).toBe(true);
			expect(btn(slugC).classList.contains("on")).toBe(false);

			btn(slugB).click(); // uncheck a genuinely-checked chip
			btn(slugC).click(); // check a genuinely-unchecked chip
			(w.document.getElementById("onb-done") as HTMLButtonElement).click();

			const saved = JSON.parse(w.localStorage.getItem(PROFILE_V2_KEY) ?? "null");
			const expectedIds = [
				...new Set([...(legacyMap[slugA] ?? []), ...(legacyMap[slugC] ?? []), "local:off-picker-choice"]),
			];
			expect(saved.genres.slice().sort()).toEqual(expectedIds.sort());
			expect(saved.unresolvedGenreSlugs).toEqual([unresolvedSlug]);
			expect(w.v2PickerChoiceSlugs(saved).has(unresolvedSlug as string)).toBe(true);
		} finally {
			w.close();
		}
	}, 20000);

	// TRA-270 (nit, 3rd review of #237): web/index.html:975's `email ? {...} : {...}` guard had no
	// test -- a mutant deleting it (always writing `email`) passed the suite untouched.
	it("TRA-270: an empty email field never writes an 'email' key onto a v2 record that never had one", async () => {
		const { win: w, taxonomy: realTaxonomy } = await newRealGraphWindow();
		try {
			const legacyMap = realTaxonomy.legacySelectionBySlug as Record<string, string[]>;
			const picks: string[] = [];
			let checked = 0;
			for (const slug of w.genrePickList()) {
				const ids = legacyMap[slug];
				if (Array.isArray(ids) && ids.length > 0) {
					picks.push(...ids);
					checked++;
				}
				if (checked === 3) break;
			}
			expect(checked).toBe(3); // sanity: enough real picks to clear MIN_GENRES

			const existingV2: MigratedProfile = { name: "Raph", genres: picks }; // no `email` key at all
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			w.loadActiveProfile(realTaxonomy);

			w.wireOnboarding();
			w.openOnboarding({ mode: "edit" });
			expect((w.document.getElementById("onb-email") as HTMLInputElement).value).toBe(""); // nothing to prefill
			(w.document.getElementById("onb-done") as HTMLButtonElement).click(); // untouched save, email left blank

			const saved = JSON.parse(w.localStorage.getItem(PROFILE_V2_KEY) ?? "null");
			expect(Object.hasOwn(saved, "email")).toBe(false);
		} finally {
			w.close();
		}
	}, 20000);
});

describe("reload preserves every genre after a v2 save (TRA-137/D2b, criterion 5)", () => {
	it("keeps resolved, off-picker, and unresolved genres intact across a save + reload cycle", () => {
		const v2 = newV2Window();
		try {
			seedV1On(v2, ["genre:techno"]);
			v2.loadActiveProfile(taxonomy); // v2: genres ["local:techno"]

			const current = v2.currentProfile() as MigratedProfile;
			const withOffPicker = { ...current, genres: [...current.genres, "local:off-picker-choice"] };
			const picked = ["genre:techno", "genre:house"];
			const merged = v2.mergePickerSelectionIntoV2(withOffPicker, picked, [...picked, "genre:idm"], taxonomy);
			expect(merged).not.toBeNull();
			v2.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(merged));

			// Reload: a fresh loadActiveProfile call (as init() makes on every page load) -- idempotent,
			// must return the saved record unchanged, not recompute or drop anything.
			const reloaded = v2.loadActiveProfile(taxonomy);
			expect(reloaded?.genres.slice().sort()).toEqual(merged?.genres.slice().sort());
			expect(reloaded?.genres).toContain("local:off-picker-choice");
		} finally {
			v2.close();
		}
	});
});

describe("recoReasons — the 'why' line stays populated for a v2 profile (TRA-137/D2b regression)", () => {
	it("matches a v2 profile's chosen genre against a recommended node (bug: comparing ids, not source slugs, always misses)", () => {
		// A v2 record with no v1 backing at all (decision 4's "profil v2 existant" case) --
		// recoReasons must resolve "local:techno" through the taxonomy to reach the graph slug
		// "genre:techno" that actually tags nodes, the same way pickDailyReco scores against it.
		// Before the fix, recoReasons only ever read Profile.data (v1), which is null here, so
		// this returned [] unconditionally regardless of what the v2 profile chose.
		const v2 = newV2Window();
		try {
			const existingV2: MigratedProfile = { name: "Raph", genres: ["local:techno"] };
			v2.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(existingV2));
			v2.loadActiveProfile(taxonomy);

			const node: GraphNode = {
				id: "artist:hero",
				type: "artist",
				edges: { genres: [{ slug: "genre:techno", name: "Techno" }] },
			};
			const reasons = v2.recoReasons(node);

			expect(reasons.length).toBeGreaterThan(0);
			expect(reasons[0]?.slug).toBe("genre:techno");
		} finally {
			v2.close();
		}
	});

	it("still matches for a v1 profile (unchanged behavior)", () => {
		const { win: w } = newWindowWithV1(["genre:techno"]);
		try {
			const node: GraphNode = {
				id: "artist:hero",
				type: "artist",
				edges: { genres: [{ slug: "genre:techno", name: "Techno" }] },
			};
			const reasons = w.recoReasons(node);
			expect(reasons.length).toBeGreaterThan(0);
			expect(reasons[0]?.slug).toBe("genre:techno");
		} finally {
			w.close();
		}
	});
});
