// TRA-472: an artist page shows its landmark album (cover card) and reference track (chip) in a
// `.highlights` block above the discography, only when at least one of the two singular edges
// exists, and neither is repeated as a generic chip under "Connections".
// Fixtures only (the fields are empty in cache/ until the TRA-491 backfill). Loads the real
// web/index.html into jsdom (same pattern as web-hero-image.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type HighlightsWindow = Window &
	typeof globalThis & {
		show: (id: string) => void;
	};

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

const COVER = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Cover.jpg";

const NODES = [
	{
		id: "artist:full",
		type: "artist",
		name: "Full Artist",
		teaser: "a",
		edges: {
			landmark_project: { slug: "project:cached-album", name: "Cached Album", type: "project" },
			reference_track: { slug: "track:cached-track", name: "Cached Track", type: "track" },
			discography: [{ slug: "project:cached-album", name: "Cached Album", type: "project" }],
			notable_tracks: [{ slug: "track:cached-track", name: "Cached Track", type: "track" }],
		},
	},
	{
		id: "artist:album-only",
		type: "artist",
		name: "Album Only",
		teaser: "a",
		edges: { landmark_project: { slug: "project:cached-album", name: "Cached Album", type: "project" } },
	},
	{
		id: "artist:dangling",
		type: "artist",
		name: "Dangling",
		teaser: "a",
		edges: {
			landmark_project: {
				slug: "project:unknown-album",
				name: "Unknown Album",
				type: "project",
				year: "1999",
			},
			reference_track: { slug: "track:unknown-track", name: "Unknown Track", type: "track" },
		},
	},
	{
		id: "artist:hostile",
		type: "artist",
		name: "Hostile",
		teaser: "a",
		edges: {
			landmark_project: {
				slug: "project:cached-album",
				name: '<img src=x onerror="window.__xss=1">',
				type: "project",
			},
			reference_track: {
				slug: "track:unknown-evil",
				name: '"><script>window.__xss=2</script>',
				type: "track",
			},
		},
	},
	{
		id: "artist:evil-slugs",
		type: "artist",
		name: "Evil slugs",
		teaser: "a",
		edges: {
			landmark_project: {
				slug: 'project:x" onmouseover="window.__xss=3',
				name: "Evil album",
				type: 'project" onfocus="window.__xss=4',
			},
			reference_track: {
				slug: 'track:y" onmouseover="window.__xss=5',
				name: "Evil track",
				type: 'track" onfocus="window.__xss=6',
			},
		},
	},
	{ id: "artist:bare", type: "artist", name: "Bare", teaser: "a", edges: { discography: [] } },
	{
		id: "project:cached-album",
		type: "project",
		name: "Cached Album",
		teaser: "p",
		image_url: COVER,
		facts: { year: "2001", release_type: "album" },
	},
	{ id: "track:cached-track", type: "track", name: "Cached Track", teaser: "t" },
];

let win: HighlightsWindow | null = null;
afterEach(() => {
	win?.close();
	win = null;
});

function route(url: string): Response {
	if (url.endsWith("/health")) return new Response("{}");
	if (url.endsWith("/data.json"))
		return new Response(JSON.stringify({ total: NODES.length, edges: [], nodes: NODES }));
	return new Response("{}", { status: 404 });
}

async function boot(): Promise<HighlightsWindow> {
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/?api=/api",
		runScripts: "dangerously",
		beforeParse(window) {
			window.fetch = (async (input: unknown) => route(String(input))) as unknown as typeof fetch;
			window.requestAnimationFrame = ((cb: () => void) => setTimeout(cb, 0)) as never;
		},
	});
	win = dom.window as unknown as HighlightsWindow;
	await vi.waitFor(() => {
		if ((win?.document.getElementById("stat") as HTMLElement).textContent === "…")
			throw new Error("not ready");
	});
	return win;
}

const q = (w: HighlightsWindow, sel: string) => w.document.querySelector(sel) as HTMLElement | null;
const kinds = (w: HighlightsWindow) =>
	Array.from(w.document.querySelectorAll(".edge-group .kind")).map((e) => e.textContent);

describe("artist .highlights block", () => {
	it("shows the landmark album card and the reference track chip, with the KIND_LABEL labels", async () => {
		const w = await boot();
		w.show("artist:full");
		const block = q(w, ".highlights");
		expect(block).not.toBeNull();
		expect(Array.from(block?.querySelectorAll(".kind") ?? []).map((e) => e.textContent)).toEqual([
			"landmark album",
			"reference track",
		]);
		const card = block?.querySelector(".project-card") as HTMLElement;
		expect(card.dataset.id).toBe("project:cached-album");
		expect(card.getAttribute("href")).toBe("?node=project%3Acached-album");
		expect(card.querySelector(".cover")?.getAttribute("style")).toBe(`background-image: url('${COVER}');`);
		expect(card.querySelector(".year")?.textContent).toBe("2001");
		const chip = block?.querySelector(".chip") as HTMLElement;
		expect(chip.dataset.id).toBe("track:cached-track");
		expect(chip.getAttribute("href")).toBe("?node=track%3Acached-track");
	});

	it("sits before the discography carousel", async () => {
		const w = await boot();
		w.show("artist:full");
		const block = q(w, ".highlights") as HTMLElement;
		const carousel = q(w, ".project-carousel-section") as HTMLElement;
		expect(block.compareDocumentPosition(carousel) & w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("does not repeat the two fields as chips under Connections", async () => {
		const w = await boot();
		w.show("artist:full");
		expect(kinds(w)).toContain("notable tracks");
		expect(kinds(w)).not.toContain("landmark album");
		expect(kinds(w)).not.toContain("reference track");
	});

	it("is absent when neither field exists", async () => {
		const w = await boot();
		w.show("artist:bare");
		expect(q(w, ".highlights")).toBeNull();
	});

	it("renders only the field that exists", async () => {
		const w = await boot();
		w.show("artist:album-only");
		expect(q(w, ".highlights .project-card")).not.toBeNull();
		expect(q(w, ".highlights .chip")).toBeNull();
		expect(q(w, ".highlight-reference_track")).toBeNull();
	});

	it("never shows on a non-artist page", async () => {
		const w = await boot();
		w.show("project:cached-album");
		expect(q(w, ".highlights")).toBeNull();
	});
});

describe("navigation matches chips and cards", () => {
	it("a click on the cached card navigates to the album", async () => {
		const w = await boot();
		w.show("artist:full");
		(q(w, ".highlights .project-card") as HTMLElement).click();
		expect(q(w, ".node h1")?.textContent).toBe("Cached Album");
	});

	it("a click on the cached track chip navigates to the track", async () => {
		const w = await boot();
		w.show("artist:full");
		(q(w, ".highlights .chip") as HTMLElement).click();
		expect(q(w, ".node h1")?.textContent).toBe("Cached Track");
	});

	it("dangling targets carry the JIT attributes instead of data-id", async () => {
		const w = await boot();
		w.show("artist:dangling");
		const card = q(w, ".highlights .project-card") as HTMLElement;
		expect(card.classList.contains("dangling")).toBe(true);
		expect(card.dataset.id).toBeUndefined();
		expect(card.dataset.jitSlug).toBe("project:unknown-album");
		expect(card.dataset.jitType).toBe("project");
		const chip = q(w, ".highlights .chip") as HTMLElement;
		expect(chip.classList.contains("dangling")).toBe(true);
		expect(chip.dataset.jitSlug).toBe("track:unknown-track");
		expect(chip.dataset.jitType).toBe("track");
	});
});

describe("untrusted data stays inert", () => {
	it("escapes names: no element or script is created from them", async () => {
		const w = await boot();
		w.show("artist:hostile");
		const block = q(w, ".highlights") as HTMLElement;
		expect(block.querySelector("img")).toBeNull();
		expect(block.querySelector("script")).toBeNull();
		expect(block.querySelector(".project-card .name")?.textContent).toBe(
			'<img src=x onerror="window.__xss=1">',
		);
		expect(block.querySelector(".chip")?.textContent).toContain('"><script>window.__xss=2</script>');
		expect((w as unknown as { __xss?: number }).__xss).toBeUndefined();
	});

	it("slugs and types are attribute-escaped: no on* attribute can be injected", async () => {
		const w = await boot();
		w.show("artist:evil-slugs");
		const els = Array.from(w.document.querySelectorAll(".highlights .project-card, .highlights .chip"));
		expect(els).toHaveLength(2);
		for (const el of els) {
			expect(el.getAttributeNames().filter((n) => n.startsWith("on"))).toEqual([]);
		}
	});

	it("no href in the block points anywhere but an internal ?node= target", async () => {
		const w = await boot();
		for (const id of ["artist:full", "artist:dangling", "artist:hostile"]) {
			w.show(id);
			for (const a of Array.from(w.document.querySelectorAll(".highlights a"))) {
				expect(a.getAttribute("href")).toMatch(/^\?node=/);
			}
		}
	});
});
