// Exercises D3a's id-based family grid (TRA-211): rendered into #onb-genres behind
// GENRE_GRID_ENABLED, plus the flat picker it falls back to. Loads the real script into jsdom
// (same pattern as genre-profile.test.ts) instead of reimplementing its logic here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATIC_GRAPH_OPTIONS } from "../scripts/build-graph-json.js";
import type { GenreTaxonomyProjection } from "../src/genre-taxonomy-projection.js";
import { buildGraphFromCache } from "../src/graph.js";

// `const` bindings never become `window` properties (only `function` declarations do), so this
// storage-key literal is duplicated here, same as genre-profile.test.ts.
const PROFILE_V2_KEY = "odyssey.profile.v2";

interface MigratedProfile {
	name: string;
	genres: string[];
	unresolvedGenreSlugs?: string[];
	email?: string;
}

type OdysseyWindow = Window &
	typeof globalThis & {
		genrePickList: () => string[];
		genresByPopularity: () => [string, number][];
		familyGenres: (taxonomy: GenreTaxonomyProjection, familyKey: string) => GenreTaxonomyProjection["genres"];
		familyCheckState: (
			genres: GenreTaxonomyProjection["genres"],
			selection: Set<string>,
		) => "none" | "some" | "all";
		wireOnboarding: () => void;
		openOnboarding: (opts?: { mode?: "signup" | "edit" }) => void;
		closeOnboarding: () => void;
		v2EditUnavailable: () => boolean;
		loadActiveProfile: (taxonomy?: GenreTaxonomyProjection) => MigratedProfile | null;
	};

const indexHtmlPath = fileURLToPath(new URL("../web/index.html", import.meta.url));
const indexHtml = readFileSync(indexHtmlPath, "utf8");

const stylesCssPath = fileURLToPath(new URL("../web/styles.css", import.meta.url));
const stylesCss = readFileSync(stylesCssPath, "utf8");

// Finds `selector { ... }` and returns the raw declaration block, or null if the selector
// isn't present at all. Escapes selector text so literal `[`, `"`, `.` etc. match literally.
function declarationsFor(css: string, selector: string): string | null {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	return match ? (match[1] ?? "") : null;
}

let win: OdysseyWindow | null = null;

afterEach(() => {
	win?.close();
	win = null;
});

// A small, hand-built projection with an unpublished-everywhere family (no genres reference
// it) to exercise "groupes vides masqués sur cache incomplet" without depending on the real
// cache ever having such a gap.
const fixtureTaxonomy: GenreTaxonomyProjection = {
	version: 2,
	families: [
		{ key: "electronic", label: "Electronic", order: 1 },
		{ key: "nothing-published", label: "Nothing Published", order: 2 },
	],
	genres: [
		{ id: "local:techno", name: "Techno", family: "electronic", slugs: ["genre:techno"] },
		{ id: "local:house", name: "House", family: "electronic", slugs: ["genre:house"] },
		{ id: "local:idm", name: "IDM", family: "electronic", slugs: ["genre:idm"] },
	],
	legacySelectionBySlug: {
		"genre:techno": ["local:techno"],
		"genre:house": ["local:house"],
		"genre:idm": ["local:idm"],
	},
};

// init() does `DATA.nodes[0].id` unconditionally once no "tendency" node matches -- an empty
// `nodes` array crashes it, so every hand-built DATA fixture below needs at least one real node.
const fixtureNodes = [{ id: "artist:seed", type: "artist", name: "Seed" }];

// Builds a window with the grid enabled and a given DATA payload served from fetch. `v2Genres`,
// when given, seeds a v2 profile in localStorage before the script parses -- Profile.load()/the
// module's storage reads happen synchronously at parse time, matching a real returning visit.
function newGridWindow(data: unknown, v2Genres?: string[]): OdysseyWindow {
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.fetch = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch;
			const w = window as unknown as Record<string, unknown>;
			w.__PROFILE_V2_ENABLED__ = true;
			w.__GENRE_GRID_ENABLED__ = true;
			if (v2Genres) {
				const v2: MigratedProfile = { name: "Raph", genres: v2Genres };
				window.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(v2));
			}
		},
	});
	return dom.window as unknown as OdysseyWindow;
}

async function waitReady(w: OdysseyWindow): Promise<void> {
	await vi.waitFor(() => {
		if ((w.document.getElementById("stat") as HTMLElement).textContent === "…") throw new Error("not ready");
	});
}

async function newRealGridWindow(): Promise<{ win: OdysseyWindow; taxonomy: GenreTaxonomyProjection }> {
	const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
	const realTaxonomy = built.taxonomy;
	if (!realTaxonomy) throw new Error("cache built without a taxonomy");
	const w = newGridWindow(built);
	await waitReady(w);
	return { win: w, taxonomy: realTaxonomy };
}

describe("chiffres réels de la projection livrée (TRA-210/TRA-211)", () => {
	// No literal count here on purpose (TRA-211: "les tests doivent affirmer les chiffres réels
	// lus dans la projection du cache livré, pas un nombre codé en dur"): data/genre-taxonomy.json
	// is a moving target (e.g. TRA-272 republishing Afrobeats), so the expectation is read from
	// that file's own `published: true` entries, same source the ticket points at for the count.
	it("the real cache's taxonomy projection has exactly as many entries, per family, as data/genre-taxonomy.json's published:true entries", async () => {
		const rawPath = fileURLToPath(new URL("../data/genre-taxonomy.json", import.meta.url));
		const raw = JSON.parse(readFileSync(rawPath, "utf8")) as {
			genres: { family: string; published: boolean }[];
		};
		const publishedByFamily = new Map<string, number>();
		for (const g of raw.genres) {
			if (g.published !== true) continue;
			publishedByFamily.set(g.family, (publishedByFamily.get(g.family) ?? 0) + 1);
		}
		const publishedTotal = [...publishedByFamily.values()].reduce((a, b) => a + b, 0);
		// Sanity: the ticket names these two families specifically (one exhaustive, one near it) --
		// a fixture/parse regression that silently zeroes the raw count must fail loudly here
		// rather than letting an equally-empty projection pass the comparisons below.
		expect(publishedByFamily.get("house-techno")).toBeGreaterThan(0);
		expect(publishedByFamily.get("hip-hop-r-n-b")).toBeGreaterThan(0);

		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
		const taxonomy = built.taxonomy;
		expect(taxonomy).toBeDefined();
		if (!taxonomy) return;
		expect(taxonomy.genres.length).toBe(publishedTotal);
		for (const [family, count] of publishedByFamily) {
			expect(taxonomy.genres.filter((g) => g.family === family).length).toBe(count);
		}
	});
});

describe("id-based family grid (TRA-211/D3a), GENRE_GRID_ENABLED on", () => {
	it("renders every published family/genre from the real projection, house-techno and hip-hop-r-n-b at full count, collapsed initially", async () => {
		const { win: w, taxonomy } = await newRealGridWindow();
		w.wireOnboarding();
		w.openOnboarding({ mode: "edit" }); // "edit" jumps straight to step 2 -- renders the grid
		const grid = w.document.getElementById("onb-genres") as HTMLElement;

		const inFamily = (key: string) => taxonomy.genres.filter((g) => g.family === key).length;
		expect(grid.querySelectorAll(".genre-pick-id").length).toBe(taxonomy.genres.length);
		expect(grid.querySelectorAll('.genre-family[data-family="house-techno"] .genre-pick-id').length).toBe(
			inFamily("house-techno"),
		);
		expect(grid.querySelectorAll('.genre-family[data-family="hip-hop-r-n-b"] .genre-pick-id').length).toBe(
			inFamily("hip-hop-r-n-b"),
		);

		const childrenEl = grid.querySelector(
			'.genre-family[data-family="house-techno"] .genre-family-children',
		) as HTMLElement;
		expect((childrenEl as HTMLElement & { hidden: boolean }).hidden).toBe(true);
	});

	it("groupes vides masqués: a family with zero published genres never renders (no vacuous-truth 'all')", () => {
		const w = newGridWindow({
			generated_at: "x",
			total: 0,
			types: {},
			nodes: fixtureNodes,
			edges: [],
			taxonomy: fixtureTaxonomy,
		});
		return waitReady(w).then(() => {
			w.wireOnboarding();
			w.openOnboarding({ mode: "edit" });
			const grid = w.document.getElementById("onb-genres") as HTMLElement;
			expect(grid.querySelector('.genre-family[data-family="nothing-published"]')).toBeNull();
			expect(grid.querySelectorAll(".genre-family").length).toBe(1); // only "electronic"

			// parents sans enfant non cochés: the guard is unit-testable directly too, without
			// depending on a family actually being hidden by rendering to prove it.
			expect(w.familyCheckState([], new Set())).toBe("none");
			w.close();
		});
	});

	it("expand/collapse toggles the children panel via click and keyboard (Enter, Space)", async () => {
		const w = newGridWindow({
			generated_at: "x",
			total: 0,
			types: {},
			nodes: fixtureNodes,
			edges: [],
			taxonomy: fixtureTaxonomy,
		});
		await waitReady(w);
		w.wireOnboarding();
		w.openOnboarding({ mode: "edit" });
		const grid = w.document.getElementById("onb-genres") as HTMLElement;
		const expandBtn = grid.querySelector(".genre-family-expand") as HTMLElement;
		const childrenEl = grid.querySelector(".genre-family-children") as HTMLElement & { hidden: boolean };

		expandBtn.click();
		expect(childrenEl.hidden).toBe(false);
		expect(expandBtn.getAttribute("aria-expanded")).toBe("true");

		expandBtn.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(childrenEl.hidden).toBe(true);

		expandBtn.dispatchEvent(new w.KeyboardEvent("keydown", { key: " ", bubbles: true }));
		expect(childrenEl.hidden).toBe(false);
	});

	it("individual toggle (click and keyboard) updates aria-checked, the counter, and the threshold gate", async () => {
		const w = newGridWindow({
			generated_at: "x",
			total: 0,
			types: {},
			nodes: fixtureNodes,
			edges: [],
			taxonomy: fixtureTaxonomy,
		});
		await waitReady(w);
		w.wireOnboarding();
		w.openOnboarding({ mode: "edit" });
		const grid = w.document.getElementById("onb-genres") as HTMLElement;
		const picks = [...grid.querySelectorAll(".genre-pick-id")] as HTMLElement[];
		const countEl = w.document.getElementById("onb-count") as HTMLElement;
		const doneBtn = w.document.getElementById("onb-done") as HTMLButtonElement;

		expect(countEl.textContent).toBe("0/3 minimum");
		expect(doneBtn.disabled).toBe(true);

		(picks[0] as HTMLElement).click();
		(picks[1] as HTMLElement).dispatchEvent(new w.KeyboardEvent("keydown", { key: " ", bubbles: true }));
		expect(picks[0]?.getAttribute("aria-checked")).toBe("true");
		expect(picks[1]?.getAttribute("aria-checked")).toBe("true");
		expect(countEl.textContent).toBe("2/3 minimum");
		expect(doneBtn.disabled).toBe(true);

		(picks[2] as HTMLElement).click();
		expect(countEl.textContent).toBe("3 sélectionnés");
		expect(doneBtn.disabled).toBe(false);

		(picks[2] as HTMLElement).click(); // toggle back off
		expect(picks[2]?.getAttribute("aria-checked")).toBe("false");
		expect(countEl.textContent).toBe("2/3 minimum");
	});

	it("the family 'tout' control derives none/some/all from displayed children, is aria-checked=mixed when partial, and a partial click completes the family (individual and global selection, incl. full house-techno/hip-hop-r-n-b)", async () => {
		const { win: w, taxonomy } = await newRealGridWindow();
		w.wireOnboarding();
		w.openOnboarding({ mode: "edit" });
		const grid = w.document.getElementById("onb-genres") as HTMLElement;
		const inFamily = (key: string) => taxonomy.genres.filter((g) => g.family === key).length;
		const houseTechno = grid.querySelector('.genre-family[data-family="house-techno"]') as HTMLElement;
		const allBtn = houseTechno.querySelector(".genre-family-all") as HTMLElement;
		const picks = [...houseTechno.querySelectorAll(".genre-pick-id")] as HTMLElement[];
		// >1, not just >0: this exercises "mixed" after picks[0] alone, which needs a sibling
		// left unchecked to actually be partial rather than vacuously full.
		expect(picks.length).toBe(inFamily("house-techno"));
		expect(picks.length).toBeGreaterThan(1);
		expect(allBtn.getAttribute("aria-checked")).toBe("false");

		(picks[0] as HTMLElement).click(); // partial
		expect(allBtn.getAttribute("aria-checked")).toBe("mixed");

		allBtn.click(); // partial -> full family (criterion: cliquer partiel sélectionne tout)
		expect(allBtn.getAttribute("aria-checked")).toBe("true");
		expect(picks.every((p) => p.getAttribute("aria-checked") === "true")).toBe(true);

		allBtn.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // full -> none
		expect(allBtn.getAttribute("aria-checked")).toBe("false");
		expect(picks.every((p) => p.getAttribute("aria-checked") === "false")).toBe(true);

		// Same, for the other near-exhaustive family named in the ticket (hip-hop-r-n-b).
		const hipHop = grid.querySelector('.genre-family[data-family="hip-hop-r-n-b"]') as HTMLElement;
		const hipHopAll = hipHop.querySelector(".genre-family-all") as HTMLElement;
		const hipHopPicks = [...hipHop.querySelectorAll(".genre-pick-id")] as HTMLElement[];
		expect(hipHopPicks.length).toBe(inFamily("hip-hop-r-n-b"));
		hipHopAll.click();
		expect(hipHopPicks.every((p) => p.getAttribute("aria-checked") === "true")).toBe(true);
	});

	it("saves grid ids straight into v2 on #onb-done, preserving an id not present on the grid (off-picker/quarantined/stale local: pick)", async () => {
		const w = newGridWindow(
			{ generated_at: "x", total: 0, types: {}, nodes: fixtureNodes, edges: [], taxonomy: fixtureTaxonomy },
			["local:techno", "local:off-picker-choice"],
		);
		await waitReady(w);
		w.loadActiveProfile(fixtureTaxonomy);
		w.wireOnboarding();
		w.openOnboarding({ mode: "edit" });
		const grid = w.document.getElementById("onb-genres") as HTMLElement;
		const btn = (id: string) => grid.querySelector(`.genre-pick-id[data-id="${id}"]`) as HTMLElement;
		expect(btn("local:techno").getAttribute("aria-checked")).toBe("true"); // seeded from v2

		btn("local:house").click(); // check a second real grid id, MIN_GENRES=3 not yet reached
		expect((w.document.getElementById("onb-done") as HTMLButtonElement).disabled).toBe(true);
		btn("local:idm").click(); // third -> threshold cleared
		(w.document.getElementById("onb-done") as HTMLButtonElement).click();

		const saved = JSON.parse(w.localStorage.getItem(PROFILE_V2_KEY) ?? "null");
		expect(saved.genres.slice().sort()).toEqual(
			["local:techno", "local:house", "local:idm", "local:off-picker-choice"].sort(),
		);
	});
});

describe("flat picker fallback (decision 4): ONBOARDING_GENRES retired", () => {
	it("web/index.html no longer defines ONBOARDING_GENRES", () => {
		expect(indexHtml).not.toContain("ONBOARDING_GENRES");
	});

	it("genrePickList() is the 24 most-referenced genres via genresByPopularity(), the fallback used when the grid is off or unusable (TRA-282: no longer the default)", async () => {
		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
		// genrePickList() itself never reads GENRE_GRID_ENABLED (it's a pure function over the
		// graph), so its own correctness holds regardless of the flag -- explicitly forced false
		// here anyway, to document that this is the fallback path, not the TRA-282 default.
		const dom = new JSDOM(indexHtml, {
			url: "http://localhost/",
			runScripts: "dangerously",
			pretendToBeVisual: false,
			beforeParse(window) {
				window.fetch = (async () => new Response(JSON.stringify(built))) as unknown as typeof fetch;
				(window as unknown as Record<string, unknown>).__GENRE_GRID_ENABLED__ = false;
			},
		});
		win = dom.window as unknown as OdysseyWindow;
		await waitReady(win);
		const expected = win
			.genresByPopularity()
			.slice(0, 24)
			.map(([slug]) => slug);
		expect(win.genrePickList()).toEqual(expected);
		expect(win.genrePickList().length).toBeLessThanOrEqual(24);
	});

	it("falls back to the flat picker (locked message) when the taxonomy is unusable, even with a v2 profile already saved -- repli explicitement testé", async () => {
		// No `taxonomy` field on DATA at all: isUsableTaxonomy() rejects it, same as today's
		// stale deployed data.json (see loadActiveProfile).
		const w = newGridWindow({ generated_at: "x", total: 0, types: {}, nodes: fixtureNodes, edges: [] }, [
			"local:techno",
		]);
		await waitReady(w);
		expect(w.v2EditUnavailable()).toBe(true); // a v2 record exists but can't be driven
		w.wireOnboarding();
		w.openOnboarding({ mode: "edit" });
		const grid = w.document.getElementById("onb-genres") as HTMLElement;
		expect(grid.querySelector(".onb-locked")).toBeTruthy();
		expect(grid.querySelector(".genre-pick-id")).toBeNull();
		expect((w.document.getElementById("onb-done") as HTMLButtonElement).disabled).toBe(true);
	});
});

// D3b (TRA-212): CSS-only pass over the D3a grid. jsdom's getComputedStyle does not reliably
// resolve this file's CSS custom properties (var(--genre) etc. -- verified experimentally: it
// leaves several of them as the literal unresolved string, and can drop an entire shorthand
// declaration that references one), so computed-style assertions against the real stylesheet
// would be flaky rather than meaningful. Per the ticket's own allowance for what jsdom can't
// compute, these instead assert the actual rules are present in web/styles.css -- a mutation
// that deletes the asserted rule turns each of these red.
describe("grid styling (TRA-212/D3b)", () => {
	it("gives the family 'tout' toggle a mixed state visually distinct from both true and false", () => {
		const base = declarationsFor(stylesCss, ".genre-family-all");
		const trueState = declarationsFor(stylesCss, '.genre-family-all[aria-checked="true"]');
		const mixedState = declarationsFor(stylesCss, '.genre-family-all[aria-checked="mixed"]');
		expect(base).not.toBeNull();
		expect(trueState).not.toBeNull();
		expect(mixedState).not.toBeNull();
		// "mixed" must override at least one visual property, and not just restate "true"'s look.
		expect(mixedState?.trim().length).toBeGreaterThan(0);
		expect(mixedState?.replace(/\s+/g, " ").trim()).not.toBe(trueState?.replace(/\s+/g, " ").trim());
	});

	it("gives the grid's keyboard-operable controls a visible :focus-visible outline", () => {
		const focusRule = stylesCss.match(
			/\.genre-family-expand:focus-visible,\s*\n?\s*\.genre-family-all:focus-visible,\s*\n?\s*\.genre-pick-id:focus-visible\s*\{([^}]*)\}/,
		);
		expect(focusRule).not.toBeNull();
		expect(focusRule?.[1]).toMatch(/outline:\s*(?!none)\S/);
	});

	it("wraps grid content instead of overflowing at a 320px viewport: flex-wrap on children, min-width: 0 on grid items, max-width: 100% on picks, no nowrap labels", () => {
		expect(declarationsFor(stylesCss, ".genre-family-children")).toMatch(/flex-wrap:\s*wrap/);
		expect(declarationsFor(stylesCss, ".genre-family")).toMatch(/min-width:\s*0/);
		expect(declarationsFor(stylesCss, ".genre-pick-id")).toMatch(/max-width:\s*100%/);
		expect(declarationsFor(stylesCss, ".genre-family-expand")).not.toMatch(/white-space:\s*nowrap/);
		expect(declarationsFor(stylesCss, ".genre-pick-id")).not.toMatch(/white-space:\s*nowrap/);
	});

	it("introduces no dependency: no @import and no url() fetch in styles.css", () => {
		expect(stylesCss).not.toMatch(/@import/);
		expect(stylesCss).not.toMatch(/url\(/);
	});
});

// TRA-213 (D4): the "Tes genres" chips on the home page now open the same edit picker as the
// existing "modifier ma sélection" button, instead of navigating to the genre's node. Own
// describe block, appended at the end of the file -- D3b (CSS) adds tests to this same file in
// parallel, and two end-of-file additions merge without conflict.
// `const` bindings never become `window` properties (see PROFILE_V2_KEY above) -- these two
// storage keys are duplicated here for the same reason.
const PROFILE_KEY = "odyssey.profile.v1";
const RECO_KEY = "odyssey.reco.v1";

// TRA-282: flips GENRE_GRID_ENABLED's own default to true now that the sync-genre-cache
// precondition is met (see the ticket). Every window built below sets no __GENRE_GRID_ENABLED__/
// __PROFILE_V2_ENABLED__ override at all -- true production defaults, not the explicit-on
// windows the rest of this file uses (newGridWindow).
describe("GENRE_GRID_ENABLED true by default (TRA-282)", () => {
	function newDefaultsWindow(data: unknown): OdysseyWindow {
		const dom = new JSDOM(indexHtml, {
			url: "http://localhost/",
			runScripts: "dangerously",
			pretendToBeVisual: false,
			beforeParse(window) {
				window.fetch = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch;
			},
		});
		return dom.window as unknown as OdysseyWindow;
	}

	it("criterion 1: an existing v1 profile migrates to v2 on open, its historical pick shows checked on the grid, and an existing v2 is never rewritten", async () => {
		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
		const legacyMap = (built.taxonomy?.legacySelectionBySlug ?? {}) as Record<string, string[]>;

		// A throwaway probe, same reasoning as newSeededWindow above: a real, currently-resolving
		// picker slug so the migrated v2 genuinely lands an id the grid renders a checkbox for.
		const probe = newDefaultsWindow(built);
		await waitReady(probe);
		const slug = probe.genrePickList().find((s) => (legacyMap[s] ?? []).length > 0);
		expect(slug).toBeDefined();
		const id = legacyMap[slug as string]?.[0] as string;
		probe.close();

		const dom = new JSDOM(indexHtml, {
			url: "http://localhost/",
			runScripts: "dangerously",
			pretendToBeVisual: false,
			beforeParse(window) {
				window.fetch = (async () => new Response(JSON.stringify(built))) as unknown as typeof fetch;
				window.localStorage.setItem(
					PROFILE_KEY,
					JSON.stringify({ createdAt: "x", name: "Raph", genres: [slug] }),
				);
			},
		});
		const w = dom.window as unknown as OdysseyWindow;
		try {
			await waitReady(w);

			// Migrated to v2 during this open -- not left as a v1-only record.
			const migrated = JSON.parse(w.localStorage.getItem(PROFILE_V2_KEY) ?? "null");
			expect(migrated?.genres).toContain(id);

			w.wireOnboarding();
			w.openOnboarding({ mode: "edit" });
			const grid = w.document.getElementById("onb-genres") as HTMLElement;
			expect(grid.querySelector(`.genre-pick-id[data-id="${id}"]`)?.getAttribute("aria-checked")).toBe(
				"true",
			);
			w.closeOnboarding();

			// Mutation guard (criterion 1: "sans réécriture d'un v2 déjà présent"): seed a
			// different v2 and re-run the migration path a later open would take -- if
			// migrateProfileToV2 ever re-derived from v1 instead of keeping the stored v2
			// untouched, this record would change.
			const keptV2 = { name: "Kept", genres: ["local:kept-choice"] };
			w.localStorage.setItem(PROFILE_V2_KEY, JSON.stringify(keptV2));
			w.loadActiveProfile(built.taxonomy);
			expect(JSON.parse(w.localStorage.getItem(PROFILE_V2_KEY) ?? "null")).toEqual(keptV2);
		} finally {
			w.close();
		}
	});

	it("criterion 2: a new user sees the grid when the taxonomy is served, and the flat 24-genre repli when it isn't", async () => {
		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);

		// New user, empty storage, taxonomy served: the grid, not the flat picker. "edit" jumps
		// straight to the genre step (renderGenreGrid) -- same as every other test in this file --
		// where "signup" would stop at the name step first.
		const withTaxonomy = newDefaultsWindow(built);
		try {
			await waitReady(withTaxonomy);
			withTaxonomy.wireOnboarding();
			withTaxonomy.openOnboarding({ mode: "edit" });
			const grid = withTaxonomy.document.getElementById("onb-genres") as HTMLElement;
			expect(grid.querySelectorAll(".genre-family").length).toBeGreaterThan(0);
			expect(grid.querySelector(".genre-pick")).toBeNull();
		} finally {
			withTaxonomy.close();
		}

		// New user, empty storage, no `taxonomy` field at all on DATA (e.g. a deploy lag serving
		// a stale/degraded data.json): isUsableTaxonomy() rejects it, so GENRE_GRID_ENABLED alone
		// can't render the grid -- the flat repli takes over. Mutation: dropping the `else` branch
		// in renderGenreGrid() (web/index.html) would leave #onb-genres empty and this goes red.
		const noTaxonomy = { ...built, taxonomy: undefined };
		const withoutTaxonomy = newDefaultsWindow(noTaxonomy);
		try {
			await waitReady(withoutTaxonomy);
			withoutTaxonomy.wireOnboarding();
			withoutTaxonomy.openOnboarding({ mode: "edit" });
			const grid = withoutTaxonomy.document.getElementById("onb-genres") as HTMLElement;
			const expected = withoutTaxonomy.genrePickList();
			expect(expected.length).toBeGreaterThan(0);
			expect(expected.length).toBeLessThanOrEqual(24);
			expect(grid.querySelectorAll(".genre-pick").length).toBe(expected.length);
			expect(grid.querySelector(".genre-family")).toBeNull();
		} finally {
			withoutTaxonomy.close();
		}
	});
});

type HomeWindow = OdysseyWindow & {
	showHome: (opts?: { fromHistory?: boolean; replaceHistory?: boolean }) => void;
	closeOnboarding: () => void;
	show: (id: string, opts?: { fromHistory?: boolean; replaceHistory?: boolean }) => void;
	clearReco: () => void;
};

describe("home genre chips open edit (TRA-213/D4)", () => {
	// TRA-282: GENRE_GRID_ENABLED now defaults true, and the real cache ships a usable taxonomy
	// (see the precondition on TRA-282), so no override here means the grid -- not the old flat
	// picker -- is what a real deploy renders on this path today. D4's own wiring (chip opens the
	// same picker state as the button) is independent of which picker UI is active, so this suite
	// now asserts against the grid's id-based DOM (data-id/aria-checked) instead of the flat
	// picker's (data-slug/.on).
	function newDefaultWindow(data: unknown, v1?: { name: string; genres: string[] }): HomeWindow {
		const dom = new JSDOM(indexHtml, {
			url: "http://localhost/",
			runScripts: "dangerously",
			pretendToBeVisual: false,
			beforeParse(window) {
				window.fetch = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch;
				if (v1) window.localStorage.setItem(PROFILE_KEY, JSON.stringify(v1));
			},
		});
		return dom.window as unknown as HomeWindow;
	}

	function checkedIds(grid: HTMLElement): string[] {
		return [...grid.querySelectorAll('.genre-pick-id[aria-checked="true"]')]
			.map((el) => (el as HTMLElement).dataset.id as string)
			.sort();
	}

	// Two windows share one real build: a throwaway "probe" just to read a real, popular slug from
	// genrePickList() (not hardcoded -- same reasoning as TRA-211's own count assertions), and the
	// grid id it resolves to. genrePickList() only ever returns graph slugs (unlike a raw taxonomy
	// entry's `.slugs`, which can include a redirected/legacy alias with no node of its own), so
	// the home page's byId-backed chip filter is guaranteed to keep it. Then a fresh window seeded
	// with a v1 profile holding that slug, matching a returning visit whose v1 record migrates to
	// v2 (TRA-137/D2b) -- and onto the grid -- on this open.
	async function newSeededWindow(): Promise<{ w: HomeWindow; slug: string; id: string }> {
		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
		const legacyMap = (built.taxonomy?.legacySelectionBySlug ?? {}) as Record<string, string[]>;
		const probe = newDefaultWindow(built);
		await waitReady(probe);
		const slug = probe.genrePickList().find((s) => (legacyMap[s] ?? []).length > 0);
		expect(slug).toBeDefined();
		probe.close();
		const id = legacyMap[slug as string]?.[0] as string;
		expect(id).toBeDefined();

		const w = newDefaultWindow(built, { name: "Raph", genres: [slug as string] });
		win = w;
		await waitReady(w);
		// No explicit wireOnboarding() call: init() (web/index.html:596) already wires it once by
		// the time waitReady() resolves. Calling it again here would double-wire #onb-done and
		// double-fire its side effects (e.g. clearReco()), which the save test below spies on.
		w.showHome();
		return { w, slug: slug as string, id };
	}

	it("a home genre chip opens the picker in the same state as the existing button", async () => {
		const { w, slug, id } = await newSeededWindow();

		const chip = w.document.querySelector(".home-genres .chip[data-id]") as HTMLElement;
		expect(chip).toBeTruthy();
		expect(chip.dataset.id).toBe(slug); // home chips stay keyed by the graph slug either way
		chip.click();
		// Fails before the fix: the chip still just navigates via show(), so #onb never opens.
		expect((w.document.getElementById("onb") as HTMLElement).hidden).toBe(false);
		const viaChip = checkedIds(w.document.getElementById("onb-genres") as HTMLElement);
		w.closeOnboarding();

		w.showHome();
		(w.document.getElementById("home-edit") as HTMLElement).click();
		const viaButton = checkedIds(w.document.getElementById("onb-genres") as HTMLElement);

		expect(viaChip).toEqual(viaButton);
		expect(viaChip).toContain(id);
	});

	it("cancelling after opening via a home chip leaves the saved profile and today's reco untouched", async () => {
		const { w } = await newSeededWindow();
		w.localStorage.setItem(RECO_KEY, JSON.stringify({ date: "2026-01-01", id: "artist:seed", history: [] }));
		const beforeProfile = w.localStorage.getItem(PROFILE_V2_KEY);
		const beforeReco = w.localStorage.getItem(RECO_KEY);

		(w.document.querySelector(".home-genres .chip[data-id]") as HTMLElement).click();
		const grid = w.document.getElementById("onb-genres") as HTMLElement;
		const unchecked = grid.querySelector('.genre-pick-id[aria-checked="false"]') as HTMLElement | null;
		// Sanity: the picker actually rendered real choices (null before the fix -- #onb-genres
		// stays empty since openOnboarding() never ran).
		expect(unchecked).toBeTruthy();
		unchecked?.click();
		(w.document.getElementById("onb-back") as HTMLElement).click(); // "annuler" in edit mode

		expect((w.document.getElementById("onb") as HTMLElement).hidden).toBe(true);
		expect(w.localStorage.getItem(PROFILE_V2_KEY)).toBe(beforeProfile);
		expect(w.localStorage.getItem(RECO_KEY)).toBe(beforeReco);
	});

	it("saving after opening via a home chip calls clearReco() (mutation: dropping the call -> red)", async () => {
		const { w } = await newSeededWindow();
		// Spying directly on clearReco(), not just reading RECO_KEY afterwards: showHome() (called
		// right after, by #onb-done) recomputes and re-caches a reco unconditionally, so the key is
		// never actually null once the handler returns -- only the call itself is observable here.
		const clearRecoSpy = vi.fn();
		w.clearReco = clearRecoSpy;

		(w.document.querySelector(".home-genres .chip[data-id]") as HTMLElement).click();
		const grid = w.document.getElementById("onb-genres") as HTMLElement;
		const unchecked = [...grid.querySelectorAll('.genre-pick-id[aria-checked="false"]')] as HTMLElement[];
		// Sanity: at least two more choices to reach MIN_GENRES=3 (empty before the fix).
		expect(unchecked.length).toBeGreaterThanOrEqual(2);
		unchecked[0]?.click();
		unchecked[1]?.click();
		(w.document.getElementById("onb-done") as HTMLButtonElement).click();

		expect(clearRecoSpy).toHaveBeenCalledTimes(1);
	});

	it("a node card still navigates after the picker has been opened and closed via a home chip", async () => {
		const { w, slug } = await newSeededWindow();
		(w.document.querySelector(".home-genres .chip[data-id]") as HTMLElement).click(); // opens edit
		w.closeOnboarding();

		w.show(slug); // a node detail view, wired independently of the home chips (~L1777)
		const card = w.document.querySelector(".project-card[data-id], .chip[data-id]") as HTMLElement | null;
		// Sanity: the genre page has at least one other related, clickable node to click through.
		expect(card).toBeTruthy();
		card?.click();

		expect(w.location.search).toBe(`?node=${encodeURIComponent((card as HTMLElement).dataset.id as string)}`);
	});
});
