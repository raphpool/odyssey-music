// TRA-585 (3b.8): GET /image answers 202 "pending" while the server resolves a cover in the
// background (TRA-583, plan 3b-D5/D6). The page sends the displayed page as `?from=`, retries a
// pending answer within a bounded budget, and never remembers the wait. Loads the real
// web/index.html into jsdom (same method as web-hero-image.test.ts) with a scripted fetch; the
// retry delays run on fake timers installed after boot (jsdom has its own setTimeout).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type PendingWindow = Window &
	typeof globalThis & {
		show: (id: string) => void;
		jitResolveImage: (slug: string) => Promise<string | null>;
		eval: (code: string) => unknown;
	};

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

const COVER = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Cover.jpg";
const PROJECT = "project:feed-me-weird-things";
const OTHER_PROJECT = "project:hard-normal-daddy";

const NODES = [
	// first node = the seed the page opens on boot: a neutral page without any card to resolve
	{ id: "artist:autechre", type: "artist", name: "Autechre", teaser: "a" },
	{
		id: "artist:squarepusher",
		type: "artist",
		name: "Squarepusher",
		teaser: "a",
		edges: {
			discography: [
				{ type: "project", slug: PROJECT, name: "Feed Me Weird Things" },
				{ type: "project", slug: OTHER_PROJECT, name: "Hard Normal Daddy" },
			],
		},
	},
	// in the bundle but without any image_url: the card asks /image
	{ id: PROJECT, type: "project", name: "Feed Me Weird Things", teaser: "p" },
	{ id: OTHER_PROJECT, type: "project", name: "Hard Normal Daddy", teaser: "p" },
];

type Reply = { status?: number; body: unknown } | "network-error";
const found = (url = COVER): Reply => ({ body: { state: "found", image_url: url, source: "caa" } });
const pending = (retryAfter?: number): Reply => ({
	status: 202,
	body: {
		image_url: null,
		source: "pending",
		state: "pending",
		...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
	},
});
const none: Reply = { body: { state: "none", image_url: null, source: "no-match" } };

let win: PendingWindow | null = null;
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
		if (!reply || reply === "network-error") throw new TypeError("network down");
		return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
	}
	return new Response("{}", { status: 404 });
}

async function boot(opts: { health?: boolean } = {}): Promise<PendingWindow> {
	imageUrls = [];
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/?api=/api",
		runScripts: "dangerously",
		beforeParse(window) {
			window.fetch = (async (input: unknown) => {
				if (opts.health === false && String(input).endsWith("/health")) throw new TypeError("down");
				return route(String(input));
			}) as unknown as typeof fetch;
			window.requestAnimationFrame = ((cb: () => void) => setTimeout(cb, 0)) as never;
		},
	});
	win = dom.window as unknown as PendingWindow;
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

const cardOf = (w: PendingWindow, slug: string) =>
	w.document.querySelector(`.project-card[data-id="${slug}"]`) as HTMLElement;
const storedImage = (w: PendingWindow) => w.eval(`byId.get(${JSON.stringify(PROJECT)})?.image_url`);
const requestsFor = (slug: string) =>
	imageUrls.filter((u) => u.includes(`/image/${encodeURIComponent(slug)}`));

describe("?from= carries the displayed page", () => {
	it("a card of the artist page sends from=<artist slug>", async () => {
		script.set(PROJECT, [none]);
		script.set(OTHER_PROJECT, [none]);
		const w = await boot();
		w.show("artist:squarepusher");
		await settle();
		expect(requestsFor(PROJECT)).toEqual([
			`/api/image/${encodeURIComponent(PROJECT)}?from=artist%3Asquarepusher`,
		]);
	});

	it("the hero of the page itself goes without from (it has a node of its own)", async () => {
		script.set("artist:squarepusher", [none]);
		const w = await boot();
		w.show("artist:squarepusher");
		await settle();
		expect(requestsFor("artist:squarepusher")).toEqual(["/api/image/artist%3Asquarepusher"]);
	});

	it("no page displayed: no from parameter", async () => {
		script.set(PROJECT, [none]);
		const w = await boot();
		w.eval("crumbs = []");
		expect(await w.jitResolveImage(PROJECT)).toBeNull();
		expect(requestsFor(PROJECT)).toEqual([`/api/image/${encodeURIComponent(PROJECT)}`]);
	});
});

describe("pending is retried, then painted", () => {
	it("202 then 200 found: card painted after the advertised delay, two requests", async () => {
		script.set(PROJECT, [pending(2), found()]);
		script.set(OTHER_PROJECT, [none]);
		const w = await boot();
		w.show("artist:squarepusher");
		await settle();
		const card = cardOf(w, PROJECT);
		expect(card.dataset.needsImage).toBe("1");
		expect(card.classList.contains("no-image")).toBe(true);
		expect(requestsFor(PROJECT)).toHaveLength(1);

		await advance(1.9);
		expect(requestsFor(PROJECT)).toHaveLength(1);
		await advance(0.2);

		expect(requestsFor(PROJECT)).toHaveLength(2);
		const cover = card.querySelector(".cover") as HTMLElement;
		expect(cover.style.backgroundImage).toContain(COVER);
		expect(card.classList.contains("no-image")).toBe(false);
		expect(card.dataset.needsImage).toBe("0");
		expect(storedImage(w)).toBe(COVER);
	});

	it("6 x 202: the placeholder stays, 6 requests, and nothing is remembered (a 7th is sent)", async () => {
		script.set(PROJECT, [pending(2)]);
		script.set(OTHER_PROJECT, [none]);
		const w = await boot();
		w.show("artist:squarepusher");
		await settle();
		for (let i = 0; i < 10; i++) await advance(2);
		expect(requestsFor(PROJECT)).toHaveLength(6);
		expect(cardOf(w, PROJECT).classList.contains("no-image")).toBe(true);
		expect(storedImage(w)).toBeUndefined();

		script.set(PROJECT, [found()]);
		expect(await w.jitResolveImage(PROJECT)).toBe(COVER);
		expect(requestsFor(PROJECT)).toHaveLength(7);
	});

	it("a pending without the 202 status is still pending", async () => {
		script.set(PROJECT, [{ body: { state: "pending", image_url: null } }, found()]);
		const w = await boot();
		const p = w.jitResolveImage(PROJECT);
		await advance(5);
		expect(await p).toBe(COVER);
		expect(requestsFor(PROJECT)).toHaveLength(2);
	});
});

describe("retry delay", () => {
	const delayFor = async (retryAfter: number | undefined): Promise<number> => {
		script.set(PROJECT, [pending(retryAfter), found()]);
		const w = await boot();
		void w.jitResolveImage(PROJECT);
		await settle();
		expect(requestsFor(PROJECT)).toHaveLength(1);
		let waited = 0;
		// step by 0.5 s until the second request shows up
		while (requestsFor(PROJECT).length < 2 && waited < 40) {
			await advance(0.5);
			waited += 0.5;
		}
		return waited;
	};

	it("0 is raised to 2 s", async () => expect(await delayFor(0)).toBe(2));
	it("120 is capped at 30 s", async () => expect(await delayFor(120)).toBe(30));
	it("absent means 5 s", async () => expect(await delayFor(undefined)).toBe(5));
	it("a value in range is followed as is", async () => expect(await delayFor(7)).toBe(7));
});

describe("leaving the page", () => {
	it("navigating to another page between two attempts stops the requests, and nothing is remembered", async () => {
		script.set(PROJECT, [pending(2)]);
		script.set(OTHER_PROJECT, [pending(2)]);
		const w = await boot();
		w.show("artist:squarepusher");
		await settle();
		expect(requestsFor(PROJECT)).toHaveLength(1);

		w.show("artist:autechre");
		await advance(2);
		await advance(30);
		expect(requestsFor(PROJECT)).toHaveLength(1);

		// coming back (or any later ask) gets a fresh budget
		script.set(PROJECT, [found()]);
		expect(await w.jitResolveImage(PROJECT)).toBe(COVER);
		expect(requestsFor(PROJECT)).toHaveLength(2);
	});

	it("a network error while retrying is not remembered either", async () => {
		script.set(PROJECT, [pending(2), "network-error"]);
		const w = await boot();
		const p = w.jitResolveImage(PROJECT);
		await advance(2);
		expect(await p).toBeNull();
		script.set(PROJECT, [found()]);
		expect(await w.jitResolveImage(PROJECT)).toBe(COVER);
		expect(requestsFor(PROJECT)).toHaveLength(3);
	});
});

describe("final answers are remembered (existing behaviour)", () => {
	it("state none: null remembered, no second request", async () => {
		script.set(PROJECT, [none]);
		const w = await boot();
		expect(await w.jitResolveImage(PROJECT)).toBeNull();
		expect(await w.jitResolveImage(PROJECT)).toBeNull();
		expect(requestsFor(PROJECT)).toHaveLength(1);
	});

	it("older server, image_url without state: found", async () => {
		script.set(PROJECT, [{ body: { slug: PROJECT, image_url: COVER, source: "itunes" } }]);
		const w = await boot();
		expect(await w.jitResolveImage(PROJECT)).toBe(COVER);
		expect(await w.jitResolveImage(PROJECT)).toBe(COVER);
		expect(requestsFor(PROJECT)).toHaveLength(1);
	});

	it("older server, null image_url without state: null remembered", async () => {
		script.set(PROJECT, [{ body: { slug: PROJECT, image_url: null, source: "none" } }]);
		const w = await boot();
		expect(await w.jitResolveImage(PROJECT)).toBeNull();
		expect(await w.jitResolveImage(PROJECT)).toBeNull();
		expect(requestsFor(PROJECT)).toHaveLength(1);
	});

	it("a refused URL from the server is never painted", async () => {
		script.set(PROJECT, [found("javascript:alert(1)"), found("javascript:alert(1)")]);
		script.set(OTHER_PROJECT, [none]);
		const w = await boot();
		w.show("artist:squarepusher");
		await settle();
		const card = cardOf(w, PROJECT);
		expect(card.classList.contains("no-image")).toBe(true);
		expect((card.querySelector(".cover") as HTMLElement).getAttribute("style")).toBeNull();
	});
});

describe("sharing and switch", () => {
	it("two callers for one slug during a wait share one series of requests", async () => {
		script.set(PROJECT, [pending(2), found()]);
		const w = await boot();
		const a = w.jitResolveImage(PROJECT);
		await settle();
		const b = w.jitResolveImage(PROJECT);
		await advance(2);
		expect(await Promise.all([a, b])).toEqual([COVER, COVER]);
		expect(requestsFor(PROJECT)).toHaveLength(2);
	});

	it("JIT disabled (API unreachable): no /image request", async () => {
		script.set(PROJECT, [found()]);
		const w = await boot({ health: false });
		expect(await w.jitResolveImage(PROJECT)).toBeNull();
		expect(imageUrls).toEqual([]);
	});
});
