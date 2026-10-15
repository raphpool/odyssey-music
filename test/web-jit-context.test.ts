// TRA-481: a click that triggers a JIT materialization from a page (chip, project card, "précacher
// tout", search rail) sends the artist context and the originating edge to POST /materialize
// (contract: TRA-477, #452), never a `disambiguator`. Loads the real web/index.html into jsdom (same
// method as web-slug-escape.test.ts) with a stub fetch that records every request body.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type JitWindow = Window &
	typeof globalThis & {
		show: (id: string) => void;
		precacheAllDangling: (node: unknown, btn: unknown) => Promise<void>;
	};

interface Call {
	url: string;
	body: Record<string, unknown> | null;
}

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

let win: JitWindow | null = null;
afterEach(() => {
	win?.close();
	win = null;
});

const ref = (type: string, slug: string, name: string, extra: Record<string, unknown> = {}) => ({
	type,
	slug,
	name,
	...extra,
});

const FITNA_ROHFF = "track:fitna--rohff";

function makeData() {
	return {
		total: 2,
		edges: [],
		nodes: [
			{
				id: "artist:rohff",
				type: "artist",
				name: "Rohff",
				teaser: "x",
				edges: {
					notable_tracks: [
						// no `artist` on the ref: the artist page itself is the context
						ref("track", FITNA_ROHFF, "Fitna"),
						// the ref's own credit wins over the page's artist
						ref("track", "track:feat--akuma", "Feat", { artist: "Akuma" }),
						// a credit the server would refuse (no Latin letter or digit): not sent
						ref("track", "track:kanji--x", "Kanji", { artist: "坂本龍一" }),
					],
					discography: [ref("project", "project:anthologie--rohff", "Anthologie", { year: "2004" })],
					genres: [ref("genre", "genre:rap", "Rap")],
					collaborators: [ref("artist", "artist:akuma", "Akuma")],
				},
			},
			{ id: "genre:plain", type: "genre", name: "Plain", teaser: "x", edges: {} },
		],
	};
}

interface Stub {
	w: JitWindow;
	calls: Call[];
	materialize: () => Call[];
}

function newWindow(opts: { materializeResponse?: unknown; hits?: unknown[] } = {}): Stub {
	const calls: Call[] = [];
	const data = makeData();
	const json = (v: unknown) => new Response(JSON.stringify(v));
	const dom = new JSDOM(indexHtml, {
		url: "http://localhost/",
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			// the chip / overlay progress bars animate through requestAnimationFrame, absent without pretendToBeVisual
			window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
				setTimeout(() => cb(0), 0) as unknown as number) as typeof window.requestAnimationFrame;
			window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const body =
					typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				calls.push({ url, body });
				if (url.endsWith("/data.json")) return json(data);
				if (url.includes("/search?")) return json({ hits: opts.hits ?? [] });
				if (url.endsWith("/materialize"))
					return json(opts.materializeResponse ?? { error: "stub: no response" });
				return json({});
			}) as unknown as typeof fetch;
		},
	});
	const w = dom.window as unknown as JitWindow;
	win = w;
	return { w, calls, materialize: () => calls.filter((c) => c.url.endsWith("/materialize")) };
}

async function ready(w: JitWindow): Promise<void> {
	await vi.waitFor(() => {
		if ((w.document.getElementById("stat") as HTMLElement).textContent === "…") throw new Error("not ready");
	});
}

function chip(w: JitWindow, slug: string): HTMLElement {
	const el = Array.from(w.document.querySelectorAll<HTMLElement>("[data-jit-slug]")).find(
		(e) => e.dataset.jitSlug === slug,
	);
	if (!el) throw new Error(`no dangling element for ${slug}`);
	return el;
}

describe("dangling chips carry the artist context in the DOM (TRA-481)", () => {
	it("a track chip on an artist page gets data-jit-artist (the page's artist) and data-jit-field", async () => {
		const { w } = newWindow();
		await ready(w);
		w.show("artist:rohff");

		const el = chip(w, FITNA_ROHFF);
		expect(el.dataset.jitArtist).toBe("Rohff");
		expect(el.dataset.jitField).toBe("notable_tracks");
	});

	it("the ref's own artist wins; a credit without a Latin letter is omitted", async () => {
		const { w } = newWindow();
		await ready(w);
		w.show("artist:rohff");

		expect(chip(w, "track:feat--akuma").dataset.jitArtist).toBe("Akuma");
		expect(chip(w, "track:kanji--x").dataset.jitArtist).toBeUndefined();
	});

	it("a dangling project card of the carousel carries the artist and the discography field", async () => {
		const { w } = newWindow();
		await ready(w);
		w.show("artist:rohff");

		const card = chip(w, "project:anthologie--rohff");
		expect(card.dataset.jitArtist).toBe("Rohff");
		expect(card.dataset.jitField).toBe("discography");
	});

	it("an artist or genre chip carries the field but no artist", async () => {
		const { w } = newWindow();
		await ready(w);
		w.show("artist:rohff");

		expect(chip(w, "genre:rap").dataset.jitArtist).toBeUndefined();
		expect(chip(w, "genre:rap").dataset.jitField).toBe("genres");
		expect(chip(w, "artist:akuma").dataset.jitArtist).toBeUndefined();
	});

	it("never emits data-jit-disambig", async () => {
		const { w } = newWindow();
		await ready(w);
		w.show("artist:rohff");

		expect(w.document.querySelector("[data-jit-disambig]")).toBeNull();
	});
});

describe("the click body sent to POST /materialize (TRA-481)", () => {
	it("a track chip sends artist, slug and source { slug, field }, and no disambiguator", async () => {
		const { w, materialize } = newWindow();
		await ready(w);
		w.show("artist:rohff");
		chip(w, FITNA_ROHFF).click();

		await vi.waitFor(() => expect(materialize()).toHaveLength(1));
		const body = materialize()[0]?.body;
		expect(body).toEqual({
			type: "track",
			name: "Fitna",
			artist: "Rohff",
			slug: FITNA_ROHFF,
			source: { slug: "artist:rohff", field: "notable_tracks" },
		});
		expect(body).not.toHaveProperty("disambiguator");
	});

	it("a carousel card sends artist and the discography source", async () => {
		const { w, materialize } = newWindow();
		await ready(w);
		w.show("artist:rohff");
		chip(w, "project:anthologie--rohff").click();

		await vi.waitFor(() => expect(materialize()).toHaveLength(1));
		expect(materialize()[0]?.body).toMatchObject({
			type: "project",
			artist: "Rohff",
			source: { slug: "artist:rohff", field: "discography" },
		});
	});

	it("a genre chip sends source but no artist", async () => {
		const { w, materialize } = newWindow();
		await ready(w);
		w.show("artist:rohff");
		chip(w, "genre:rap").click();

		await vi.waitFor(() => expect(materialize()).toHaveLength(1));
		const body = materialize()[0]?.body;
		expect(body).toMatchObject({ type: "genre", source: { slug: "artist:rohff", field: "genres" } });
		expect(body).not.toHaveProperty("artist");
	});
});

describe("requested_slug in the response (TRA-481)", () => {
	const servedNode = {
		slug: "track:fitna--akuma",
		type: "track",
		name: "Fitna",
		editorial_teaser: "Served teaser",
		citations: [],
	};

	it("repoints the clicked edge, so the chip then opens the served node without a reload", async () => {
		const { w, materialize } = newWindow({
			materializeResponse: { node: servedNode, source: "jit", requested_slug: FITNA_ROHFF, wallMs: 1 },
		});
		await ready(w);
		w.show("artist:rohff");
		chip(w, FITNA_ROHFF).click();
		await vi.waitFor(() => expect(materialize()).toHaveLength(1));
		await vi.waitFor(() =>
			expect(w.document.getElementById("content")?.textContent).toContain("Served teaser"),
		);

		w.show("artist:rohff");
		const rendered = Array.from(w.document.querySelectorAll<HTMLElement>("a.chip[data-id]")).find((a) =>
			a.textContent?.includes("Fitna"),
		);
		expect(rendered?.dataset.id).toBe("track:fitna--akuma");
		expect(w.document.querySelector(`[data-jit-slug="${FITNA_ROHFF}"]`)).toBeNull();
	});

	it("leaves the edge alone when the response has no requested_slug", async () => {
		const { w, materialize } = newWindow({
			materializeResponse: { node: servedNode, source: "jit", wallMs: 1 },
		});
		await ready(w);
		w.show("artist:rohff");
		chip(w, FITNA_ROHFF).click();
		await vi.waitFor(() => expect(materialize()).toHaveLength(1));
		await vi.waitFor(() =>
			expect(w.document.getElementById("content")?.textContent).toContain("Served teaser"),
		);

		w.show("artist:rohff");
		const rendered = Array.from(w.document.querySelectorAll<HTMLElement>("a.chip[data-id]")).find((a) =>
			a.textContent?.includes("Fitna"),
		);
		// still the slug the edge names (the local alias only resolves it), not rewritten
		expect(rendered?.dataset.id).toBe(FITNA_ROHFF);
	});
});

describe('"précacher tout" (TRA-481)', () => {
	it("sends artist and source for every dangling work of an artist page, and no disambiguator", async () => {
		const { w, materialize } = newWindow();
		await ready(w);
		const node = makeData().nodes[0];
		const btn = w.document.createElement("button");
		await w.precacheAllDangling(node, btn);

		const bodies = materialize().map((c) => c.body ?? {});
		const bySlug = (slug: string) => bodies.find((b) => b.slug === slug);
		expect(bodies).toHaveLength(6);
		expect(bySlug(FITNA_ROHFF)).toMatchObject({
			artist: "Rohff",
			source: { slug: "artist:rohff", field: "notable_tracks" },
		});
		expect(bySlug("track:feat--akuma")).toMatchObject({ artist: "Akuma" });
		expect(bySlug("track:kanji--x")).not.toHaveProperty("artist");
		expect(bySlug("project:anthologie--rohff")).toMatchObject({
			artist: "Rohff",
			source: { slug: "artist:rohff", field: "discography" },
		});
		expect(bySlug("genre:rap")).not.toHaveProperty("artist");
		for (const b of bodies) expect(b).not.toHaveProperty("disambiguator");
	});
});

describe("search rail (TRA-481)", () => {
	async function clickHit(hit: Record<string, unknown>) {
		const stub = newWindow({ hits: [hit] });
		const { w } = stub;
		await ready(w);
		const search = w.document.getElementById("search") as HTMLInputElement;
		search.value = "fitna";
		search.dispatchEvent(new w.Event("input"));
		await vi.waitFor(() => {
			if (!w.document.querySelector("#search-results .row[data-idx]")) throw new Error("no hit yet");
		});
		(w.document.querySelector("#search-results .row[data-idx]") as HTMLElement).click();
		await vi.waitFor(() => expect(stub.materialize()).toHaveLength(1));
		return stub.materialize()[0]?.body;
	}

	it("a catalog track hit sends the joined credit (subtitle) as artist, with its mbid", async () => {
		const body = await clickHit({
			source: "catalog",
			type: "track",
			name: "Fitna",
			subtitle: "Rohff & Akuma",
			mbid: "11111111-2222-3333-4444-555555555555",
		});
		expect(body).toEqual({
			type: "track",
			name: "Fitna",
			artist: "Rohff & Akuma",
			mbid: "11111111-2222-3333-4444-555555555555",
		});
	});

	it("a catalog artist hit never sends its sort-name subtitle as artist", async () => {
		const body = await clickHit({
			source: "catalog",
			type: "artist",
			name: "Rohff",
			subtitle: "Rohff",
			mbid: "11111111-2222-3333-4444-555555555555",
		});
		expect(body).not.toHaveProperty("artist");
	});
});
