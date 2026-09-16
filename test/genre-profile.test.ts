// Exercises the profile v1 -> v2 migration in web/index.html's inline script (TRA-135 /
// D2a): loads the real script into jsdom instead of reimplementing its logic here, only
// simulating the DOM/localStorage/fetch boundaries.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenreTaxonomyProjection } from "../src/genre-taxonomy-projection.js";

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
