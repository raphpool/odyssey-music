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
		v2EditUnavailable: () => boolean;
		loadActiveProfile: (taxonomy?: GenreTaxonomyProjection) => MigratedProfile | null;
	};

const indexHtmlPath = fileURLToPath(new URL("../web/index.html", import.meta.url));
const indexHtml = readFileSync(indexHtmlPath, "utf8");

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

	it("genrePickList() is the 24 most-referenced genres via genresByPopularity(), used when the grid is off (default)", async () => {
		const built = await buildGraphFromCache("cache", STATIC_GRAPH_OPTIONS);
		// __GENRE_GRID_ENABLED__ is read once at parse time and left unset here -- GENRE_GRID_ENABLED
		// defaults false, exercising the same "grid off" path a real deploy is on today.
		const dom = new JSDOM(indexHtml, {
			url: "http://localhost/",
			runScripts: "dangerously",
			pretendToBeVisual: false,
			beforeParse(window) {
				window.fetch = (async () => new Response(JSON.stringify(built))) as unknown as typeof fetch;
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
