// TRA-469: the artist page renders `similar_artists` (declared by TRA-456) as an ordinary edge group labelled
// "similar artists", after "members", with the same chips as the other artist lists. The names come from
// ListenBrainz (third party): they must reach the DOM as text. Loads the real web/index.html into jsdom (same
// pattern as web-safe-css-url.test.ts); the fixture graph lives in the test, never in cache/.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const indexHtml = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

interface EdgeRef {
	slug: string;
	type: "artist";
	name: string;
}

const ref = (slug: string, name: string): EdgeRef => ({ slug: `artist:${slug}`, type: "artist", name });

function node(slug: string, name: string, edges: Record<string, EdgeRef[]> = {}) {
	return {
		id: `artist:${slug}`,
		type: "artist",
		name,
		teaser: "",
		article: "",
		citations: [],
		edges,
	};
}

let dom: JSDOM | null = null;
afterEach(() => {
	dom?.window.close();
	dom = null;
});

async function openArtist(nodes: ReturnType<typeof node>[], id: string): Promise<Document> {
	const data = { nodes, edges: [], total: nodes.length, redirects: {} };
	dom = new JSDOM(indexHtml, {
		url: `http://localhost/?node=${encodeURIComponent(id)}`,
		runScripts: "dangerously",
		pretendToBeVisual: false,
		beforeParse(window) {
			window.scrollTo = () => {};
			// No API: `/health` fails, so the page reads ./data.json and chips are not JIT-clickable.
			window.fetch = (async (input: RequestInfo | URL) => {
				if (String(input).endsWith("data.json")) return new Response(JSON.stringify(data));
				throw new Error("offline");
			}) as unknown as typeof fetch;
		},
	});
	const doc = dom.window.document;
	for (let i = 0; i < 200 && !doc.querySelector(".edge-group"); i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	return doc;
}

function groupLabels(doc: Document): string[] {
	return Array.from(doc.querySelectorAll(".edge-group > .kind")).map((el) => el.textContent ?? "");
}

describe("similar_artists on the web artist page", () => {
	it("renders a 'similar artists' group after 'members', with clickable artist chips", async () => {
		const others = [ref("a", "Artist A"), ref("b", "Artist B"), ref("c", "Artist C")];
		const doc = await openArtist(
			[
				node("src", "Source", { members: [ref("m", "Member M")], similar_artists: others }),
				...others.map((o) => node(o.slug.slice("artist:".length), o.name)),
			],
			"artist:src",
		);

		expect(groupLabels(doc)).toEqual(["members", "similar artists"]);
		const group = Array.from(doc.querySelectorAll(".edge-group")).find(
			(g) => g.querySelector(".kind")?.textContent === "similar artists",
		);
		const chips = Array.from(group?.querySelectorAll(".chips > .chip") ?? []);
		expect(chips.map((c) => c.textContent)).toEqual(["artistArtist A", "artistArtist B", "artistArtist C"]);
		// In the graph: a real link to the node, same as a collaborator chip.
		expect(chips.map((c) => c.getAttribute("href"))).toEqual([
			"?node=artist%3Aa",
			"?node=artist%3Ab",
			"?node=artist%3Ac",
		]);
		expect(chips.every((c) => c.classList.contains("t-artist"))).toBe(true);
	});

	it("keeps a similar artist that has no page yet as a non-link chip (pending, like any other edge)", async () => {
		const doc = await openArtist(
			[node("src", "Source", { similar_artists: [ref("ghost", "Not Generated Yet")] })],
			"artist:src",
		);

		const chip = doc.querySelector(".edge-group .chips > .chip");
		expect(chip?.tagName).toBe("SPAN");
		expect(chip?.textContent).toBe("artistNot Generated Yet");
		expect(chip?.getAttribute("href")).toBeNull();
	});

	it("draws no 'similar artists' group while the edge is empty or absent", async () => {
		const doc = await openArtist(
			[node("src", "Source", { members: [ref("m", "Member M")], similar_artists: [] })],
			"artist:src",
		);

		expect(groupLabels(doc)).toEqual(["members"]);
	});

	it("treats a hostile artist name as text, not markup", async () => {
		const evil = ref("evil", '<img src=x onerror="alert(1)"><script>alert(2)</script>');
		const doc = await openArtist([node("src", "Source", { similar_artists: [evil] })], "artist:src");

		const group = doc.querySelector(".edge-group");
		expect(group?.querySelector("img, script")).toBeNull();
		expect(group?.querySelector(".chip")?.textContent).toContain('<img src=x onerror="alert(1)">');
		const handlers = Array.from(doc.querySelectorAll("*")).flatMap((el) =>
			el.getAttributeNames().filter((n) => n.startsWith("on")),
		);
		expect(handlers).toEqual([]);
	});
});
