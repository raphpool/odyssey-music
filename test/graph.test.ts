import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraphFromCache, toVizNode } from "../src/graph.js";
import type { ArtistNode, EdgeRef, GenreNode, NodePayload } from "../src/types.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-graph-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

// Shared minimal-genre-node fixture (mirrors the one in test/cache.test.ts, TRA-18).
function genreNode(overrides: Partial<GenreNode> & Pick<GenreNode, "slug" | "name">): GenreNode {
	return {
		type: "genre",
		editorial_definition: `Test fixture definition for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for graph export coverage. `.repeat(4),
		citations: [{ url: `https://example.com/${overrides.slug.split(":")[1]}` }],
		materialized_at: new Date().toISOString(),
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
		...overrides,
	};
}

// Writes a node payload straight to the cache's on-disk layout, bypassing NodeCache.write's
// eager reverse-edge emission (src/cache.ts emitReverses). This simulates the realistic case —
// per TRA-19's measured 81%/19% split — where a genre node's reverse field was never populated
// on disk and only backfillGenreReverses (src/graph.ts) fills it in at export time.
async function writeRawNode(root: string, node: NodePayload): Promise<void> {
	const [type, ...rest] = node.slug.split(":");
	const file = join(root, "nodes", String(type), `${rest.join(":")}.json`);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(node), "utf8");
}

describe("toVizNode — node-level qid whitelist (TRA-19)", () => {
	it("keeps qid on a genre VizNode when the cached node has one", () => {
		const genre = genreNode({ slug: "genre:acid", name: "Acid", qid: "Q170611" });
		const viz = toVizNode(genre, {});
		expect(viz.qid).toBe("Q170611");
	});

	it("omits qid on a genre VizNode when the cached node has none", () => {
		const genre = genreNode({ slug: "genre:dub", name: "Dub" });
		const viz = toVizNode(genre, {});
		expect("qid" in viz).toBe(false);
	});

	it("never surfaces qid on a non-genre VizNode, even if present on the payload by error", () => {
		const artist: ArtistNode = {
			type: "artist",
			slug: "artist:brian-eno",
			name: "Brian Eno",
			editorial_bio: "British producer and ambient pioneer.",
			editorial_article: "A real long article about Brian Eno's ambient legacy. ".repeat(6),
			citations: [{ url: "https://example.com/brian-eno" }],
			materialized_at: new Date().toISOString(),
			genres: [],
			labels: [],
			discography: [],
			notable_tracks: [],
			influences: [],
			influenced: [],
			collaborators: [],
			aliases: [],
			members: [],
		};
		// ArtistNode doesn't declare qid; schemas.ts would already strip a stray one on write/read
		// (TRA-17/TRA-18). This asserts the node-level whitelist in toVizNode is its own guarantee,
		// not merely incidental coverage inherited from the schema layer.
		const corrupted = { ...artist, qid: "Q999999" } as unknown as ArtistNode;
		const viz = toVizNode(corrupted, {});
		expect("qid" in viz).toBe(false);
	});
});

describe("buildGraphFromCache — genre qid reaches the exported graph (TRA-19)", () => {
	it("keeps the node qid through the full cache-to-graph pipeline", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:acid", name: "Acid", qid: "Q170611" }));
		const graph = await buildGraphFromCache(dir);
		const node = graph.nodes.find((n) => n.id === "genre:acid");
		expect(node?.qid).toBe("Q170611");
	});
});

describe("buildGraphFromCache — genre redirects reach the exported graph (TRA-23)", () => {
	it("populates redirects from a genre-redirects.json-shaped fixture", async () => {
		const redirectsPath = join(dir, "redirects.json");
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:electronic-music": "genre:electronic" } }),
			"utf8",
		);
		const graph = await buildGraphFromCache(dir, { redirectsPath });
		expect(graph.redirects).toEqual({ "genre:electronic-music": "genre:electronic" });
	});

	it("leaves redirects undefined when the redirects file is absent", async () => {
		const graph = await buildGraphFromCache(dir, { redirectsPath: join(dir, "missing.json") });
		expect(graph.redirects).toBeUndefined();
	});

	it("propagates parseGenreRedirects' error for a table that isn't flattened", async () => {
		const redirectsPath = join(dir, "cyclic-redirects.json");
		await writeFile(
			redirectsPath,
			JSON.stringify({ redirects: { "genre:a": "genre:b", "genre:b": "genre:c" } }),
			"utf8",
		);
		await expect(buildGraphFromCache(dir, { redirectsPath })).rejects.toThrow(
			/appears as both key and value/,
		);
	});
});

describe("backfillGenreReverses — stamping self.qid on synthesized reverse edges (TRA-19)", () => {
	it("stamps the source genre's qid onto the reverse edge it synthesizes", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:acid", name: "Acid" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:acid-techno",
				name: "Acid Techno",
				qid: "Q341395",
				parent_genres: [{ type: "genre", slug: "genre:acid", name: "Acid" }],
			}),
		);
		const graph = await buildGraphFromCache(dir);
		const acidNode = graph.nodes.find((n) => n.id === "genre:acid");
		const subgenres = acidNode?.edges.subgenres as EdgeRef[] | undefined;
		const reverse = subgenres?.find((e) => e.slug === "genre:acid-techno");
		expect(reverse?.qid).toBe("Q341395");
	});

	it("omits the qid key on a synthesized reverse edge when the source genre has none", async () => {
		await writeRawNode(dir, genreNode({ slug: "genre:idm", name: "IDM" }));
		await writeRawNode(
			dir,
			genreNode({
				slug: "genre:braindance",
				name: "Braindance",
				parent_genres: [{ type: "genre", slug: "genre:idm", name: "IDM" }],
			}),
		);
		const graph = await buildGraphFromCache(dir);
		const idmNode = graph.nodes.find((n) => n.id === "genre:idm");
		const subgenres = idmNode?.edges.subgenres as EdgeRef[] | undefined;
		const reverse = subgenres?.find((e) => e.slug === "genre:braindance");
		expect(reverse).toBeDefined();
		expect(reverse && "qid" in reverse).toBe(false);
	});
});
