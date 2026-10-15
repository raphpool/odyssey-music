// TRA-501: a slug is untrusted text (forged POST /materialize body, JIT node, legacy cache entry) and
// web/index.html builds chips, cards and crumbs with innerHTML. `data-id="${ref.slug}"` left a `"` free
// to close the attribute, so `artist:x" onmouseover="alert(1)` became a stored XSS. Loads the real
// web/index.html into jsdom (same method as web-safe-css-url.test.ts); the hostile slugs reach the page
// through data.json, bypassing the Zod rule that would now refuse them on write.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type SlugWindow = Window & typeof globalThis & { show: (id: string) => void };

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

const EVIL_ARTIST = 'artist:x" onmouseover="alert(1)';
const EVIL_PROJECT = 'project:p" onclick="alert(2)';
const EVIL_DANGLING_ARTIST = 'artist:y" onfocus="alert(3)" autofocus="';
const EVIL_DANGLING_PROJECT = "project:q'><img src=x onerror=alert(4)>";
const EVIL_DANGLING_GENRE = 'genre:g" onmouseenter="alert(5)';
const EVIL_MBID = 'm" onclick="alert(6)';
const EVIL_QID = 'Q1" onclick="alert(7)';

let win: SlugWindow | null = null;
afterEach(() => {
	win?.close();
	win = null;
});

function newWindow(data: unknown): SlugWindow {
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.fetch = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch;
		},
	});
	win = dom.window as unknown as SlugWindow;
	return win;
}

function eventHandlerAttrs(root: ParentNode): string[] {
	const found: string[] = [];
	for (const el of Array.from(root.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			if (attr.name.toLowerCase().startsWith("on")) found.push(`${el.tagName}.${attr.name}`);
		}
	}
	return found;
}

const ref = (type: string, slug: string, name: string, extra: Record<string, unknown> = {}) => ({
	type,
	slug,
	name,
	...extra,
});

const DATA = {
	total: 4,
	edges: [],
	nodes: [
		{
			id: "artist:safe",
			type: "artist",
			name: "Safe",
			teaser: "x",
			edges: {
				collaborators: [
					// in cache under a hostile id -> `<a data-id>` chip
					ref("artist", EVIL_ARTIST, "Evil In Cache"),
					// not in cache -> dangling chip carrying data-jit-slug / -mbid
					ref("artist", EVIL_DANGLING_ARTIST, "Evil Dangling", { mbid: EVIL_MBID }),
				],
				// project carousel: one card in cache (data-id), one dangling (data-jit-*)
				discography: [
					ref("project", EVIL_PROJECT, "Evil Project In Cache"),
					ref("project", EVIL_DANGLING_PROJECT, "Evil Project Dangling", { mbid: EVIL_MBID }),
				],
				genres: [ref("genre", EVIL_DANGLING_GENRE, "Evil Genre", { qid: EVIL_QID })],
			},
		},
		{ id: EVIL_ARTIST, type: "artist", name: "Evil In Cache", teaser: "x", edges: {} },
		{ id: EVIL_PROJECT, type: "project", name: "Evil Project In Cache", teaser: "x", edges: {} },
		{ id: "genre:plain", type: "genre", name: "Plain", teaser: "x", edges: {} },
	],
};

async function ready(w: SlugWindow): Promise<void> {
	await vi.waitFor(() => {
		if ((w.document.getElementById("stat") as HTMLElement).textContent === "…") throw new Error("not ready");
	});
}

describe("slugs interpolated into attributes (TRA-501)", () => {
	it("an edge slug containing a double quote renders no on* attribute", async () => {
		const w = newWindow(DATA);
		await ready(w);
		w.show("artist:safe");

		expect(eventHandlerAttrs(w.document.body)).toEqual([]);
	});

	it("keeps every hostile slug as the attribute VALUE, byte for byte, never as markup", async () => {
		const w = newWindow(DATA);
		await ready(w);
		w.show("artist:safe");
		const attr = (name: string) =>
			Array.from(w.document.querySelectorAll(`[${name}]`)).map((el) => el.getAttribute(name));

		expect(attr("data-id")).toEqual(expect.arrayContaining([EVIL_ARTIST, EVIL_PROJECT]));
		expect(attr("data-jit-slug")).toEqual(
			expect.arrayContaining([EVIL_DANGLING_ARTIST, EVIL_DANGLING_PROJECT, EVIL_DANGLING_GENRE]),
		);
		expect(attr("data-jit-mbid")).toContain(EVIL_MBID);
		expect(attr("data-jit-qid")).toContain(EVIL_QID);
		// the `'><img ...>` slug must not have produced an element
		expect(w.document.querySelector("img[src='x']")).toBeNull();
	});

	it("breadcrumbs escape the id of a node already visited", async () => {
		const w = newWindow(DATA);
		await ready(w);
		w.show(EVIL_ARTIST);
		w.show("artist:safe");

		const crumbIds = Array.from(w.document.querySelectorAll("#crumbs a[data-id]")).map((a) =>
			a.getAttribute("data-id"),
		);
		expect(crumbIds).toContain(EVIL_ARTIST);
		expect(eventHandlerAttrs(w.document.body)).toEqual([]);
	});

	it("the stat line escapes the seed id (first node of data.json)", async () => {
		const evilSeed = "artist:x<img src=x onerror=alert(1)>";
		const w = newWindow({
			...DATA,
			nodes: [{ id: evilSeed, type: "artist", name: "Evil Seed", teaser: "x", edges: {} }, ...DATA.nodes],
		});
		await ready(w);

		const stat = w.document.getElementById("stat") as HTMLElement;
		expect(stat.querySelector("img")).toBeNull();
		expect(stat.textContent).toContain(evilSeed);
		expect(eventHandlerAttrs(w.document.body)).toEqual([]);
	});

	it("escapes a forged edge type in the chip badge", async () => {
		const forged = "genre<img src=x onerror=alert(1)>";
		const w = newWindow({
			...DATA,
			nodes: [
				{
					id: "artist:safe",
					type: "artist",
					name: "Safe",
					teaser: "x",
					edges: { genres: [ref(forged, "genre:forged", "Forged")] },
				},
			],
		});
		await ready(w);
		w.show("artist:safe");

		expect(w.document.querySelector("img[src='x']")).toBeNull();
		expect(eventHandlerAttrs(w.document.body)).toEqual([]);
	});
});
