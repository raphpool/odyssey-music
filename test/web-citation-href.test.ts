// TRA-503: citation URLs are untrusted (web search + LLM output) and `citationSchema` only requires
// z.string().url(), which accepts `javascript:` and a `"` that closes the href attribute. Loads the
// real web/index.html into jsdom (same pattern as web-safe-css-url.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type CitationWindow = Window &
	typeof globalThis & {
		show: (id: string) => void;
	};

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

let win: CitationWindow | null = null;
afterEach(() => {
	win?.close();
	win = null;
});

async function renderNodeWithCitations(
	citations: Array<{ url: string; title?: string }>,
): Promise<CitationWindow> {
	const data = {
		total: 1,
		edges: [],
		nodes: [{ id: "artist:roni-size", type: "artist", name: "Roni Size", teaser: "x", citations }],
	};
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.fetch = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch;
		},
	});
	const w = dom.window as unknown as CitationWindow;
	win = w;
	await vi.waitFor(() => {
		if ((w.document.getElementById("stat") as HTMLElement).textContent === "…") throw new Error("not ready");
	});
	w.show("artist:roni-size");
	return w;
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

describe("citations in the node view", () => {
	it("renders a javascript: citation as plain text, with no <a>", async () => {
		const w = await renderNodeWithCitations([{ url: "javascript:alert(1)", title: "Evil source" }]);
		const box = w.document.querySelector(".citations") as HTMLElement;
		expect(box.querySelectorAll("a")).toHaveLength(0);
		expect(box.textContent).toContain("Evil source");
		expect(w.document.querySelector('[href^="javascript:" i]')).toBeNull();
	});

	it("shows the (escaped) URL as text when a refused citation has no title", async () => {
		const w = await renderNodeWithCitations([{ url: "javascript:alert('<b>x</b>')" }]);
		const box = w.document.querySelector(".citations") as HTMLElement;
		expect(box.querySelectorAll("a, b")).toHaveLength(0);
		expect(box.textContent).toContain("javascript:alert('<b>x</b>')");
	});

	it("refuses data:, vbscript:, protocol-relative and unparsable URLs too", async () => {
		const w = await renderNodeWithCitations([
			{ url: "data:text/html,<script>alert(1)</script>", title: "d" },
			{ url: "vbscript:msgbox(1)", title: "v" },
			{ url: "not a url", title: "n" },
			{ url: "//evil.example/x", title: "p" },
		]);
		const box = w.document.querySelector(".citations") as HTMLElement;
		expect(box.querySelectorAll("a")).toHaveLength(0);
		expect(box.querySelectorAll("script")).toHaveLength(0);
	});

	it("never lets a double quote in the URL or title add an on* attribute", async () => {
		const w = await renderNodeWithCitations([
			{ url: 'https://a.com/" onmouseover="x', title: 'T" onclick="y' },
			{ url: "https://a.com/'><img src=x onerror=alert(1)>", title: "<img src=x onerror=alert(1)>" },
		]);
		expect(eventHandlerAttrs(w.document.body)).toEqual([]);
		const box = w.document.querySelector(".citations") as HTMLElement;
		expect(box.querySelectorAll("img")).toHaveLength(0);
		for (const a of Array.from(box.querySelectorAll("a"))) {
			expect(a.getAttributeNames().sort()).toEqual(["href", "rel", "target"]);
		}
	});

	it("keeps a plain https citation as a clickable link", async () => {
		const w = await renderNodeWithCitations([
			{ url: "https://en.wikipedia.org/wiki/Roni_Size", title: "Roni Size - Wikipedia" },
		]);
		const links = Array.from(w.document.querySelectorAll(".citations a"));
		expect(links).toHaveLength(1);
		const a = links[0] as HTMLAnchorElement;
		expect(a.getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Roni_Size");
		expect(a.getAttribute("target")).toBe("_blank");
		expect(a.getAttribute("rel")).toBe("noopener noreferrer");
		expect(a.textContent).toBe("[1]Roni Size - Wikipedia");
	});

	it("round-trips an `&` in a query string through the href unchanged", async () => {
		const u = "https://example.org/a?x=1&y=2";
		const w = await renderNodeWithCitations([{ url: u, title: "q" }]);
		expect(w.document.querySelector(".citations a")?.getAttribute("href")).toBe(u);
	});
});

describe("href interpolations in web/index.html", () => {
	// Every `href="...${expr}..."` must go through encodeURIComponent (relative `?node=` deep link) or
	// escapeHtml (absolute URL already validated). A bare `${c.url}` is what TRA-503 fixed.
	it("has no unescaped interpolation inside an href attribute", () => {
		const found = Array.from(indexHtml.matchAll(/href="([^"\n]*\$\{[^"\n]*)"/g)).map((m) => m[1] as string);
		expect(found.length).toBeGreaterThan(0);
		for (const value of found) {
			const exprs = Array.from(value.matchAll(/\$\{([^}]*)\}/g)).map((m) => m[1] as string);
			expect(exprs.length, value).toBeGreaterThan(0);
			for (const expr of exprs) {
				expect(expr, value).toMatch(/^(encodeURIComponent|escapeHtml)\(/);
			}
		}
	});
});
