// TRA-495: image URLs are untrusted (LLM output, JIT nodes). `safeCssUrl` used to leave `"`
// untouched, so the value closed the `style="..."` attribute it was interpolated into and an
// `onmouseover=` ran on hover. Loads the real web/index.html into jsdom (same pattern as
// genre-picker.test.ts) rather than re-implementing the helper.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type SafeWindow = Window &
	typeof globalThis & {
		safeCssUrl: (u: unknown) => string | null;
		bgStyleAttr: (u: unknown) => string;
		show: (id: string) => void;
	};

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

const EVIL = 'https://upload.wikimedia.org/a"onmouseover="alert(1)//';

let win: SafeWindow | null = null;
afterEach(() => {
	win?.close();
	win = null;
});

function newWindow(data?: unknown): SafeWindow {
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.fetch = (data === undefined
				? () => new Promise<Response>(() => {})
				: async () => new Response(JSON.stringify(data))) as unknown as typeof fetch;
		},
	});
	win = dom.window as unknown as SafeWindow;
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

describe("safeCssUrl", () => {
	it("returns the canonical form of a plain https URL", () => {
		const w = newWindow();
		expect(w.safeCssUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/Roni_Size.jpg")).toBe(
			"https://upload.wikimedia.org/wikipedia/commons/a/ab/Roni_Size.jpg",
		);
	});

	it("never lets a double quote through: the URL stays text, no attribute is added", () => {
		const w = newWindow();
		const safe = w.safeCssUrl(EVIL);
		// Either refused or canonicalised (`"` -> %22); both keep it inside the attribute.
		expect(safe === null || !safe.includes('"')).toBe(true);
		const attr = w.bgStyleAttr(EVIL);
		const holder = w.document.createElement("div");
		holder.innerHTML = `<div ${attr}></div>`;
		expect(eventHandlerAttrs(holder)).toEqual([]);
		expect(holder.firstElementChild?.getAttributeNames()).toEqual(attr ? ["style"] : []);
	});

	it("refuses http: and javascript: URLs", () => {
		const w = newWindow();
		expect(w.safeCssUrl("http://upload.wikimedia.org/a.jpg")).toBeNull();
		expect(w.safeCssUrl("javascript:alert(1)")).toBeNull();
		expect(w.bgStyleAttr("http://upload.wikimedia.org/a.jpg")).toBe("");
		expect(w.bgStyleAttr("javascript:alert(1)")).toBe("");
	});

	it("keeps a Wikimedia URL with percent-encoded parentheses", () => {
		const w = newWindow();
		const u = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Roni_Size_%28cropped%29.jpg";
		expect(w.safeCssUrl(u)).toBe(u);
	});

	it("re-encodes raw parentheses and quotes instead of dropping the image", () => {
		const w = newWindow();
		expect(w.safeCssUrl("https://upload.wikimedia.org/a/Roni_Size_(cropped)'s.jpg")).toBe(
			"https://upload.wikimedia.org/a/Roni_Size_%28cropped%29%27s.jpg",
		);
	});

	it("refuses non-strings, empty and unparsable input", () => {
		const w = newWindow();
		for (const bad of [undefined, null, 42, {}, "", "not a url", "https://"]) {
			expect(w.safeCssUrl(bad)).toBeNull();
		}
	});

	it("neutralises characters that would break out of the CSS literal or the attribute", () => {
		const w = newWindow();
		for (const u of [
			"https://upload.wikimedia.org/a');background:url('https://evil.example/x",
			'https://upload.wikimedia.org/a\\"><img src=x onerror=alert(1)>',
			"https://upload.wikimedia.org/a?q=1&quot;onmouseover=&quot;x",
			'https://upload.wikimedia.org/a\u0000\n".jpg',
		]) {
			const attr = w.bgStyleAttr(u);
			const holder = w.document.createElement("div");
			holder.innerHTML = `<div ${attr}></div>`;
			expect(eventHandlerAttrs(holder), u).toEqual([]);
			expect(holder.querySelectorAll("*").length, u).toBe(1);
			const style = holder.firstElementChild?.getAttribute("style") ?? "";
			if (attr) expect(style, u).toMatch(/^background-image: url\('[^'"()\\<>\s]*'\);$/);
		}
	});

	it("round-trips an `&` in a query string through the attribute unchanged", () => {
		const w = newWindow();
		const u = "https://upload.wikimedia.org/a.jpg?w=300&h=300";
		const holder = w.document.createElement("div");
		holder.innerHTML = `<div ${w.bgStyleAttr(u)}></div>`;
		expect(holder.firstElementChild?.getAttribute("style")).toBe(`background-image: url('${u}');`);
	});
});

describe("rendered hero and cards", () => {
	it("a hostile image_url on a node renders no on* handler", async () => {
		const data = {
			total: 2,
			edges: [],
			nodes: [
				{
					id: "artist:evil",
					type: "artist",
					name: "Evil",
					teaser: "x",
					image_url: EVIL,
					edges: { discography: [{ slug: "project:evil-ep", name: "Evil EP" }] },
				},
				{ id: "project:evil-ep", type: "project", name: "Evil EP", image_url: "http://a.example/x.jpg" },
			],
		};
		const w = newWindow(data);
		await vi.waitFor(() => {
			if ((w.document.getElementById("stat") as HTMLElement).textContent === "…")
				throw new Error("not ready");
		});
		w.show("artist:evil");
		expect(eventHandlerAttrs(w.document.body)).toEqual([]);
		const hero = w.document.querySelector(".hero") as HTMLElement;
		expect(hero).not.toBeNull();
		// the http: cover is refused outright
		const card = w.document.querySelector(".project-card") as HTMLElement | null;
		if (card) {
			expect(card.classList.contains("no-image")).toBe(true);
			expect(card.querySelector(".cover")?.getAttribute("style")).toBeNull();
		}
	});
});
