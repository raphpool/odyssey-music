// TRA-596: a project card whose node is not in the bundle ("dangling": it carries data-jit-slug
// but no data-id) must ask GET /image like a cached card does. 2026-10-16 symptom: on
// artist:squarepusher (regenerated data.json) 3 discography cards out of 4 never called /image,
// although those works without a node are exactly what `?from=` (plan 3b-D1) serves.
// Loads the real web/index.html into jsdom with a scripted fetch (same method as
// web-image-pending.test.ts); the retry delays run on fake timers installed after boot.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type DanglingWindow = Window &
	typeof globalThis & {
		show: (id: string) => void;
		eval: (code: string) => unknown;
	};

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

const COVER = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Cover.jpg";
const DANGLING = "project:go-plastic";
const CACHED = "project:hard-normal-daddy";
const PAGE = "artist:squarepusher";

const NODES = [
	// first node = the seed the page opens on boot: a neutral page without any card to resolve
	{ id: "artist:autechre", type: "artist", name: "Autechre", teaser: "a" },
	{
		id: PAGE,
		type: "artist",
		name: "Squarepusher",
		teaser: "a",
		edges: {
			discography: [
				// no node for this one: the card is rendered with data-jit-slug only
				{ type: "project", slug: DANGLING, name: "Go Plastic" },
				{ type: "project", slug: CACHED, name: "Hard Normal Daddy" },
			],
		},
	},
	{ id: CACHED, type: "project", name: "Hard Normal Daddy", teaser: "p" },
];

type Reply = { status?: number; body: unknown };
const found = (url = COVER): Reply => ({ body: { state: "found", image_url: url, source: "caa" } });
const pending = (retryAfter = 2): Reply => ({
	status: 202,
	body: { image_url: null, source: "pending", state: "pending", retry_after_seconds: retryAfter },
});
const none: Reply = { body: { state: "none", image_url: null, source: "no-match" } };

let win: DanglingWindow | null = null;
let imageUrls: string[] = [];
// replies per slug, consumed in order; the last one repeats
const script = new Map<string, Reply[]>();

afterEach(() => {
	script.clear();
	vi.useRealTimers();
	win?.close();
	win = null;
});

function route(url: string): Response {
	if (url.endsWith("/health")) return new Response("{}");
	if (url.endsWith("/data.json"))
		return new Response(JSON.stringify({ total: NODES.length, edges: [], nodes: NODES }));
	const m = /\/image\/([^?]+)/.exec(url);
	if (m) {
		imageUrls.push(url);
		const queue = script.get(decodeURIComponent(m[1] ?? ""));
		const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0];
		if (!reply) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
	}
	return new Response("{}", { status: 404 });
}

async function boot(): Promise<DanglingWindow> {
	imageUrls = [];
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/?api=/api",
		runScripts: "dangerously",
		beforeParse(window) {
			window.fetch = (async (input: unknown) => route(String(input))) as unknown as typeof fetch;
			window.requestAnimationFrame = ((cb: () => void) => setTimeout(cb, 0)) as never;
		},
	});
	win = dom.window as unknown as DanglingWindow;
	await vi.waitFor(() => {
		if ((win?.document.getElementById("stat") as HTMLElement).textContent === "…")
			throw new Error("not ready");
	});
	// From here on the page's retry delays are driven by the test.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	win.setTimeout = globalThis.setTimeout as never;
	return win;
}

/** Lets fetch / Response.json / promise chains settle without moving the fake clock. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function advance(seconds: number): Promise<void> {
	await settle();
	await vi.advanceTimersByTimeAsync(seconds * 1000);
	await settle();
}

const danglingCard = (w: DanglingWindow) =>
	w.document.querySelector(`.project-card[data-jit-slug="${DANGLING}"]`) as HTMLElement;
const requestsFor = (slug: string) =>
	imageUrls.filter((u) => u.split("?")[0] === `/api/image/${encodeURIComponent(slug)}`);

describe("a card without a node asks GET /image", () => {
	it("is rendered dangling: data-jit-slug, no data-id, waiting for an image", async () => {
		script.set(DANGLING, [none]);
		script.set(CACHED, [none]);
		const w = await boot();
		w.show(PAGE);
		await settle();
		const card = danglingCard(w);
		expect(card.dataset.id).toBeUndefined();
		expect(card.classList.contains("dangling")).toBe(true);
		expect(card.dataset.needsImage).toBe("1");
	});

	it("sends /image/<jit-slug>?from=<page>", async () => {
		script.set(DANGLING, [none]);
		script.set(CACHED, [none]);
		const w = await boot();
		w.show(PAGE);
		await settle();
		expect(requestsFor(DANGLING)).toEqual([
			`/api/image/${encodeURIComponent(DANGLING)}?from=${encodeURIComponent(PAGE)}`,
		]);
	});

	it("202 then 200: ends painted after the relaunch, and stays a dangling card (click = materialize)", async () => {
		script.set(DANGLING, [pending(2), pending(2), found()]);
		script.set(CACHED, [none]);
		const w = await boot();
		w.show(PAGE);
		await settle();
		const card = danglingCard(w);
		expect(card.classList.contains("no-image")).toBe(true);
		expect(requestsFor(DANGLING)).toHaveLength(1);

		await advance(2);
		expect(requestsFor(DANGLING)).toHaveLength(2);
		expect(card.classList.contains("no-image")).toBe(true);
		await advance(2);

		expect(requestsFor(DANGLING)).toHaveLength(3);
		const cover = card.querySelector(".cover") as HTMLElement;
		expect(cover.style.backgroundImage).toContain(COVER);
		expect(card.classList.contains("no-image")).toBe(false);
		expect(card.dataset.needsImage).toBe("0");
		// still the materialize path: no data-id, jit attributes intact
		expect(card.dataset.id).toBeUndefined();
		expect(card.dataset.jitSlug).toBe(DANGLING);
		expect(card.classList.contains("dangling")).toBe(true);
	});

	it("a URL the page does not trust is never painted on a dangling card", async () => {
		script.set(DANGLING, [found("javascript:alert(1)")]);
		script.set(CACHED, [none]);
		const w = await boot();
		w.show(PAGE);
		await settle();
		const card = danglingCard(w);
		expect(requestsFor(DANGLING)).toHaveLength(1);
		expect(card.classList.contains("no-image")).toBe(true);
		expect((card.querySelector(".cover") as HTMLElement).getAttribute("style")).toBeNull();
	});

	it("a dead card (materialization already failed) does not ask", async () => {
		script.set(DANGLING, [found()]);
		script.set(CACHED, [none]);
		const w = await boot();
		w.eval(`deadCache.add(${JSON.stringify(DANGLING)})`);
		w.show(PAGE);
		await settle();
		const card = danglingCard(w);
		expect(card.classList.contains("dead")).toBe(true);
		expect(requestsFor(DANGLING)).toEqual([]);
		expect(requestsFor(CACHED)).toHaveLength(1);
	});

	it("a card with a node still asks by data-id (unchanged)", async () => {
		script.set(DANGLING, [none]);
		script.set(CACHED, [none]);
		const w = await boot();
		w.show(PAGE);
		await settle();
		expect(requestsFor(CACHED)).toEqual([
			`/api/image/${encodeURIComponent(CACHED)}?from=${encodeURIComponent(PAGE)}`,
		]);
	});
});
