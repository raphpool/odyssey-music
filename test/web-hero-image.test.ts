// TRA-466: every node type shows the `image_url` the graph already carries (hero, carousel card,
// reco card) without a JIT `/image` round-trip, a materialized node keeps its image, and a
// `derived-cover` hero is marked so the stylesheet can keep the type gradient behind it.
// TRA-593: a hero borrows the cover of a listed work only when that work points back at the node
// (label / artist / genre, same predicate as src/images/reciprocity.ts), else the gradient and the JIT.
// Loads the real web/index.html into jsdom (same pattern as web-safe-css-url.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type HeroWindow = Window &
	typeof globalThis & {
		show: (id: string) => void;
		renderRecoCard: (node: unknown) => string;
		resolveHeroImage: (node: unknown) => string | null;
	};

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

const IMG = (name: string) => `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}.jpg`;

const NODES = [
	{
		id: "genre:jungle",
		type: "genre",
		name: "Jungle",
		teaser: "g",
		image_url: IMG("Jungle"),
		image_source: "derived-cover",
	},
	{
		id: "label:ram",
		type: "label",
		name: "RAM",
		teaser: "l",
		image_url: IMG("Ram"),
		image_source: "wikidata-p154",
	},
	{
		id: "project:new-forms",
		type: "project",
		name: "New Forms",
		teaser: "p",
		image_url: IMG("NewForms"),
		image_source: "caa",
		edges: {
			artists: [{ slug: "artist:roni-size", name: "Roni Size" }],
			label: { slug: "label:talkin-loud", name: "Talkin' Loud" },
			genres: [
				{ slug: "genre:no-image", name: "No image" },
				{ slug: "genre:bad-own", name: "Bad own" },
			],
		},
	},
	{
		id: "artist:roni-size",
		type: "artist",
		name: "Roni Size",
		teaser: "a",
		image_url: IMG("RoniSize"),
		image_source: "derived-cover",
		edges: { discography: [{ slug: "project:new-forms", name: "New Forms" }] },
	},
	{
		id: "track:brown-paper-bag",
		type: "track",
		name: "Brown Paper Bag",
		teaser: "t",
		image_url: IMG("Bag"),
		image_source: "itunes-verified",
	},
	// no image of its own: must keep the existing chain, then the JIT
	{
		id: "genre:no-image",
		type: "genre",
		name: "No image",
		teaser: "x",
		edges: { landmark_projects: [{ slug: "project:new-forms", name: "New Forms" }] },
	},
	{ id: "artist:bare", type: "artist", name: "Bare", teaser: "x" },
	// own image_url refused by safeCssUrl (http:) -> falls back to the chain instead of a blank hero
	{
		id: "genre:bad-own",
		type: "genre",
		name: "Bad own",
		teaser: "x",
		image_url: "http://upload.wikimedia.org/a.jpg",
		edges: { landmark_projects: [{ slug: "project:new-forms", name: "New Forms" }] },
	},
	{
		id: "artist:bad-alone",
		type: "artist",
		name: "Bad alone",
		teaser: "x",
		image_url: "javascript:alert(1)",
	},
	// TRA-593: works that list the wrong node, and the nodes whose lists they pollute.
	{
		id: "project:electric-ladyland",
		type: "project",
		name: "Electric Ladyland",
		teaser: "p",
		image_url: IMG("Ladyland"),
		image_source: "caa",
		edges: {
			artists: [{ slug: "artist:jimi-hendrix", name: "Jimi Hendrix" }],
			label: { slug: "label:reprise", name: "Reprise" },
			genres: [{ slug: "genre:rock", name: "Rock" }],
		},
	},
	{
		id: "project:paradise",
		type: "project",
		name: "Paradise",
		teaser: "p",
		image_url: IMG("Paradise"),
		image_source: "caa",
		edges: {
			artists: [{ slug: "artist:inner-city", name: "Inner City" }],
			label: { slug: "label:ten", name: "Ten" },
			genres: [{ slug: "genre:house", name: "House" }],
		},
	},
	{
		id: "label:mille-plateaux",
		type: "label",
		name: "Mille Plateaux",
		teaser: "l",
		edges: { notable_releases: [{ slug: "project:electric-ladyland", name: "Electric Ladyland" }] },
	},
	{
		id: "label:talkin-loud",
		type: "label",
		name: "Talkin' Loud",
		teaser: "l",
		edges: {
			notable_releases: [
				{ slug: "project:electric-ladyland", name: "Electric Ladyland" },
				{ slug: "project:new-forms", name: "New Forms" },
			],
		},
	},
	{
		id: "artist:inner-city",
		type: "artist",
		name: "Inner City",
		teaser: "a",
		edges: {
			discography: [
				{ slug: "project:electric-ladyland", name: "Electric Ladyland" },
				{ slug: "project:paradise", name: "Paradise" },
			],
		},
	},
	{
		id: "artist:strangers-only",
		type: "artist",
		name: "Strangers Only",
		teaser: "a",
		edges: {
			discography: [{ slug: "project:electric-ladyland", name: "Electric Ladyland" }],
			notable_tracks: [{ slug: "track:stranger", name: "Stranger" }],
		},
	},
	{
		id: "track:stranger",
		type: "track",
		name: "Stranger",
		teaser: "t",
		image_url: IMG("Stranger"),
		image_source: "itunes-verified",
		edges: { artists: [{ slug: "artist:someone-else", name: "Someone Else" }] },
	},
	{
		id: "genre:house",
		type: "genre",
		name: "House",
		teaser: "g",
		edges: {
			subgenres: [{ slug: "genre:acid-house", name: "Acid house" }],
			landmark_projects: [
				{ slug: "project:electric-ladyland", name: "Electric Ladyland" },
				{ slug: "project:acid-album", name: "Acid album" },
				{ slug: "project:paradise", name: "Paradise" },
			],
		},
	},
	{
		id: "genre:garage",
		type: "genre",
		name: "Garage",
		teaser: "g",
		edges: {
			subgenres: [{ slug: "genre:speed-garage", name: "Speed garage" }],
			landmark_projects: [
				{ slug: "project:electric-ladyland", name: "Electric Ladyland" },
				{ slug: "project:speed-album", name: "Speed album" },
			],
		},
	},
	{
		id: "genre:stranger-only",
		type: "genre",
		name: "Stranger only",
		teaser: "g",
		edges: {
			landmark_projects: [{ slug: "project:electric-ladyland", name: "Electric Ladyland" }],
			landmark_tracks: [{ slug: "track:stranger", name: "Stranger" }],
		},
	},
	{
		id: "project:acid-album",
		type: "project",
		name: "Acid album",
		teaser: "p",
		image_url: IMG("Acid"),
		image_source: "caa",
		edges: { genres: [{ slug: "genre:acid-house", name: "Acid house" }] },
	},
	{
		id: "project:speed-album",
		type: "project",
		name: "Speed album",
		teaser: "p",
		image_url: IMG("Speed"),
		image_source: "caa",
		edges: { genres: [{ slug: "genre:speed-garage", name: "Speed garage" }] },
	},
];

let win: HeroWindow | null = null;
let requests: string[] = [];
afterEach(() => {
	win?.close();
	win = null;
});

function route(url: string, init?: RequestInit): Response {
	requests.push(`${init?.method ?? "GET"} ${url}`);
	if (url.endsWith("/health")) return new Response("{}");
	if (url.endsWith("/data.json"))
		return new Response(JSON.stringify({ total: NODES.length, edges: [], nodes: NODES }));
	if (url.includes("/search?"))
		return new Response(
			JSON.stringify({ hits: [{ type: "artist", name: "Fresh Artist", source: "catalog" }] }),
		);
	if (url.endsWith("/materialize"))
		return new Response(
			JSON.stringify({
				node: {
					slug: "artist:fresh-artist",
					type: "artist",
					name: "Fresh Artist",
					editorial_bio: "bio",
					citations: [],
					image_url: IMG("Fresh"),
					image_source: "derived-cover",
				},
			}),
		);
	return new Response("{}", { status: 404 });
}

async function boot(): Promise<HeroWindow> {
	requests = [];
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/?api=/api",
		runScripts: "dangerously",
		beforeParse(window) {
			window.fetch = (async (input: unknown, init?: RequestInit) =>
				route(String(input), init)) as unknown as typeof fetch;
			window.requestAnimationFrame = ((cb: () => void) => setTimeout(cb, 0)) as never;
		},
	});
	win = dom.window as unknown as HeroWindow;
	await vi.waitFor(() => {
		if ((win?.document.getElementById("stat") as HTMLElement).textContent === "…")
			throw new Error("not ready");
	});
	return win;
}

const imageRequests = () => requests.filter((r) => r.includes("/image/"));
const heroOf = (w: HeroWindow) => w.document.querySelector(".hero") as HTMLElement;

describe("hero uses the node's own image_url, for every type", () => {
	for (const node of NODES.slice(0, 5)) {
		it(`${node.type}: image painted, no /image request`, async () => {
			const w = await boot();
			w.show(node.id);
			const hero = heroOf(w);
			expect(hero.classList.contains("no-image")).toBe(false);
			expect(hero.getAttribute("style")).toBe(`background-image: url('${node.image_url}');`);
			await new Promise((r) => setTimeout(r, 20));
			expect(imageRequests()).toEqual([]);
		});
	}
});

describe("hero-derived", () => {
	it("marks a derived-cover hero", async () => {
		const w = await boot();
		w.show("artist:roni-size");
		expect(heroOf(w).classList.contains("hero-derived")).toBe(true);
	});

	it("leaves a real image unmarked", async () => {
		const w = await boot();
		w.show("label:ram");
		expect(heroOf(w).classList.contains("hero-derived")).toBe(false);
	});

	it("does not mark a hero whose own image was refused and replaced by a related cover", async () => {
		const w = await boot();
		w.show("genre:bad-own");
		expect(heroOf(w).classList.contains("hero-derived")).toBe(false);
	});
});

describe("fallbacks keep working", () => {
	it("no image at all: gradient placeholder, then the JIT is asked", async () => {
		const w = await boot();
		w.show("artist:bare");
		expect(heroOf(w).classList.contains("no-image")).toBe(true);
		await vi.waitFor(() => expect(imageRequests()).toEqual(["GET /api/image/artist%3Abare"]));
	});

	it("no own image: the landmark project cover is used, without /image", async () => {
		const w = await boot();
		w.show("genre:no-image");
		expect(heroOf(w).getAttribute("style")).toBe(`background-image: url('${IMG("NewForms")}');`);
		await new Promise((r) => setTimeout(r, 20));
		expect(imageRequests()).toEqual([]);
	});

	it("a refused own image_url falls back to the chain instead of leaving a blank hero", async () => {
		const w = await boot();
		w.show("genre:bad-own");
		expect(heroOf(w).getAttribute("style")).toBe(`background-image: url('${IMG("NewForms")}');`);
		expect(imageRequests()).toEqual([]);
	});

	it("a refused own image_url with nothing else asks the JIT", async () => {
		const w = await boot();
		w.show("artist:bad-alone");
		expect(heroOf(w).classList.contains("no-image")).toBe(true);
		await vi.waitFor(() => expect(imageRequests()).toHaveLength(1));
	});
});

describe("a hero borrows a cover only from a work that points back at the node (TRA-593)", () => {
	const style = (url: string) => `background-image: url('${url}');`;

	it("label: a release on another label is never borrowed, the gradient and the JIT answer", async () => {
		const w = await boot();
		w.show("label:mille-plateaux");
		expect(heroOf(w).classList.contains("no-image")).toBe(true);
		expect(w.resolveHeroImage(NODES.find((n) => n.id === "label:mille-plateaux"))).toBeNull();
		await vi.waitFor(() => expect(imageRequests()).toEqual(["GET /api/image/label%3Amille-plateaux"]));
	});

	it("label: skips the unrelated release and borrows the one that declares the label", async () => {
		const w = await boot();
		w.show("label:talkin-loud");
		expect(heroOf(w).getAttribute("style")).toBe(style(IMG("NewForms")));
		await new Promise((r) => setTimeout(r, 20));
		expect(imageRequests()).toEqual([]);
	});

	it("artist: a release credited to another artist is skipped, the credited one is borrowed", async () => {
		const w = await boot();
		w.show("artist:inner-city");
		expect(heroOf(w).getAttribute("style")).toBe(style(IMG("Paradise")));
	});

	it("artist: neither a stranger's release nor a stranger's track is borrowed", async () => {
		const w = await boot();
		w.show("artist:strangers-only");
		expect(heroOf(w).classList.contains("no-image")).toBe(true);
		await vi.waitFor(() => expect(imageRequests()).toHaveLength(1));
	});

	it("genre: a work that declares the genre beats a neighbour listed before it", async () => {
		const w = await boot();
		w.show("genre:house");
		expect(heroOf(w).getAttribute("style")).toBe(style(IMG("Paradise")));
	});

	it("genre: a direct subgenre's work is accepted when no work declares the genre itself", async () => {
		const w = await boot();
		w.show("genre:garage");
		expect(heroOf(w).getAttribute("style")).toBe(style(IMG("Speed")));
	});

	it("genre: works that carry unrelated genres lend nothing", async () => {
		const w = await boot();
		w.show("genre:stranger-only");
		expect(heroOf(w).classList.contains("no-image")).toBe(true);
		await vi.waitFor(() => expect(imageRequests()).toHaveLength(1));
	});
});

describe("carousel and reco card", () => {
	it("a carousel card whose project has an image_url needs no /image request", async () => {
		const w = await boot();
		w.show("artist:roni-size");
		const card = w.document.querySelector(".project-card") as HTMLElement;
		expect(card.classList.contains("no-image")).toBe(false);
		expect(card.dataset.needsImage).toBe("0");
		expect(card.querySelector(".cover")?.getAttribute("style")).toBe(
			`background-image: url('${IMG("NewForms")}');`,
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(imageRequests()).toEqual([]);
	});

	it("the reco card shows the image of a genre / label / artist / track", async () => {
		const w = await boot();
		for (const node of [NODES[0], NODES[1], NODES[3], NODES[4]]) {
			const holder = w.document.createElement("div");
			holder.innerHTML = w.renderRecoCard(node);
			const cover = holder.querySelector(".reco-cover") as HTMLElement;
			expect(cover.classList.contains("no-image"), node?.id).toBe(false);
			expect(cover.getAttribute("style"), node?.id).toBe(`background-image: url('${node?.image_url}');`);
		}
		expect(imageRequests()).toEqual([]);
	});
});

describe("a node inserted by /materialize", () => {
	it("keeps image_url and image_source: hero shown at once, no /image request", async () => {
		const w = await boot();
		const search = w.document.getElementById("search") as HTMLInputElement;
		search.value = "fresh";
		search.dispatchEvent(new w.Event("input"));
		const row = await vi.waitFor(() => {
			const el = w.document.querySelector("#search-results .row[data-idx]") as HTMLElement | null;
			if (!el) throw new Error("no hit yet");
			return el;
		});
		row.click();
		await vi.waitFor(() => {
			if (w.document.querySelector(".hero h1")?.textContent !== "Fresh Artist")
				throw new Error("not shown yet");
		});
		const hero = heroOf(w);
		expect(hero.querySelector("h1")?.textContent).toBe("Fresh Artist");
		expect(hero.classList.contains("no-image")).toBe(false);
		expect(hero.getAttribute("style")).toBe(`background-image: url('${IMG("Fresh")}');`);
		expect(hero.classList.contains("hero-derived")).toBe(true);
		await new Promise((r) => setTimeout(r, 20));
		expect(imageRequests()).toEqual([]);
	});
});
