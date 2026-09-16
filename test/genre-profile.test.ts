// Exercises the profile v1 -> v2 migration added to web/index.html's inline script
// (TRA-135 / D2a). We load the real script into jsdom rather than reimplementing its
// logic here, per the repo's front-end test convention: no copy of the migration
// functions, only the DOM/localStorage/fetch boundaries are simulated.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenreTaxonomyProjection } from "../src/genre-taxonomy-projection.js";

// PROFILE_KEY / PROFILE_V2_KEY are `const` bindings inside the inline script, so they
// never become properties of `window` (unlike its `function` declarations) and can't be
// read back from the test. These literals mirror the storage contract the ticket names.
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

type OdysseyWindow = Window &
	typeof globalThis & {
		migrateProfileToV2: (taxonomy?: GenreTaxonomyProjection) => MigratedProfile | null;
	};

const indexHtmlPath = fileURLToPath(new URL("../web/index.html", import.meta.url));
const indexHtml = readFileSync(indexHtmlPath, "utf8");

let win: OdysseyWindow;

beforeEach(() => {
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			// The real script's top-level init() IIFE awaits this fetch on its very first
			// line and never proceeds past it. A promise that never settles freezes init()
			// there harmlessly (no throw, no unhandled rejection) while the rest of the real
			// script -- including the migration functions under test -- still runs to
			// completion synchronously, without ever fetching data.json or rendering the graph.
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

// Ids are deliberately shaped unlike the graph slugs that map to them (e.g. "local:techno"
// vs. "genre:techno"), matching the real projection (src/genre-taxonomy-projection.ts):
// an entry's `id` is a QID/"local:" id, never the graph slug itself. Every graph slug --
// including ones that still resolve to the same genre, unrenamed -- goes through
// legacySelectionBySlug; production's migration table is exhaustive over known sources.
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

// jsdom's Storage exposes getItem/setItem as WebIDL named operations on its prototype:
// assigning `win.localStorage.setItem = ...` only adds an own named entry (per the spec's
// legacy platform object semantics) and never shadows the real method, so the throw would
// silently never fire. Overriding Storage.prototype directly is what actually intercepts it.
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

	it("computes a best-effort v2 without a taxonomy but never persists it", () => {
		const v1 = seedV1(["genre:techno"]);

		// No taxonomy yet (e.g. an older data.json still being served): the slug can't be
		// validated, so it's trusted as-is, but the result must not be written to storage --
		// otherwise the idempotency guard would lock in this unvalidated guess forever.
		const withoutTaxonomy = win.migrateProfileToV2();
		expect(withoutTaxonomy?.genres).toEqual(["genre:techno"]);
		expect(win.localStorage.getItem(PROFILE_V2_KEY)).toBeNull();

		// A later call with the real taxonomy still migrates properly, unblocked.
		const withTaxonomy = win.migrateProfileToV2(taxonomy);
		expect(withTaxonomy?.genres).toEqual(["local:techno"]);
		expect(win.localStorage.getItem(PROFILE_KEY)).toEqual(JSON.stringify(v1));
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
