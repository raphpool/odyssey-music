// TRA-501: slugs are canonical on WRITE (node schema, POST /materialize) but a node already on disk
// keeps the old "known type + non-empty body" rule on READ. A deployed server's cache holds nodes this
// repository has never seen (deploy excludes cache/); one legacy slug must not 500 /data.json or a node
// page. The front escapes every slug it interpolates (test/web-slug-escape.test.ts), so serving it is safe.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import { buildGraphFromCache } from "../src/graph.js";
import { createGraphService } from "../src/services/graph-service.js";
import type { ArtistNode, EdgeRef, ProjectNode, Slug } from "../src/types.js";

const EVIL_SLUG = 'artist:x" onmouseover="alert(1)' as Slug;
const EVIL_EDGE: EdgeRef = { type: "artist", slug: EVIL_SLUG, name: "Evil" };

let dir: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-slug-read-"));
	// The logger writes warn/error to console.error.
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
	errorSpy.mockRestore();
	await rm(dir, { recursive: true, force: true });
});

function artist(overrides: Partial<ArtistNode> & Pick<ArtistNode, "slug" | "name">): ArtistNode {
	return {
		type: "artist",
		editorial_bio: `Fixture bio for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for slug tolerance coverage. `.repeat(4),
		citations: [{ url: "https://example.com/fixture" }],
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
		similar_artists: [],
		...overrides,
	};
}

function project(overrides: Partial<ProjectNode> & Pick<ProjectNode, "slug" | "name">): ProjectNode {
	return {
		type: "project",
		editorial_pitch: `Fixture pitch for ${overrides.name}.`,
		editorial_article: `A real long article about ${overrides.name} for slug tolerance coverage. `.repeat(4),
		citations: [{ url: "https://example.com/fixture" }],
		materialized_at: new Date().toISOString(),
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
		...overrides,
	};
}

// Straight to disk, as a deployed server's earlier version would have written it.
async function writeRaw(node: ArtistNode | ProjectNode): Promise<void> {
	const [type, ...rest] = node.slug.split(":");
	const file = join(dir, "nodes", String(type), `${rest.join(":")}.json`);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(node), "utf8");
}

const loggedSlugs = () =>
	errorSpy.mock.calls
		.map(([line]) => String(line))
		.filter((line) => line.includes("non-canonical slug"))
		.map((line) => (JSON.parse(line) as { slug: string }).slug);

describe("reading a cached node with a non-canonical slug (TRA-501)", () => {
	it("NodeCache.get serves a node whose own slug is non-canonical, and logs it", async () => {
		await writeRaw(artist({ slug: EVIL_SLUG, name: "Evil" }));

		const node = await new NodeCache(dir).get(EVIL_SLUG);

		expect(node.slug).toBe(EVIL_SLUG);
		expect(loggedSlugs()).toEqual([EVIL_SLUG]);
	});

	it("NodeCache.get serves a canonical node that carries a non-canonical edge slug", async () => {
		await writeRaw(artist({ slug: "artist:fine", name: "Fine", aliases: [EVIL_EDGE] }));

		const node = await new NodeCache(dir).get("artist:fine");

		expect(node.type === "artist" && node.aliases[0]?.slug).toBe(EVIL_SLUG);
		expect(loggedSlugs()).toEqual(["artist:fine"]);
	});

	it("does not log for a canonical node", async () => {
		await writeRaw(artist({ slug: "artist:fine", name: "Fine" }));

		await new NodeCache(dir).get("artist:fine");

		expect(loggedSlugs()).toEqual([]);
	});

	it("still throws on a node that is invalid for another reason", async () => {
		await writeRaw({ ...artist({ slug: EVIL_SLUG, name: "Evil" }), editorial_article: "too short" });

		await expect(new NodeCache(dir).get(EVIL_SLUG)).rejects.toThrow(/Invalid cached node/);
	});

	it("buildGraphFromCache and the HTTP graph service keep both nodes instead of failing", async () => {
		await writeRaw(artist({ slug: EVIL_SLUG, name: "Evil" }));
		await writeRaw(artist({ slug: "artist:fine", name: "Fine", aliases: [EVIL_EDGE] }));

		const graph = await buildGraphFromCache(dir);
		const served = await createGraphService(dir).getGraph();

		expect(graph.nodes.map((n) => n.id).sort()).toEqual(["artist:fine", EVIL_SLUG].sort());
		expect(served.total).toBe(2);
	});
});

describe("writing a non-canonical slug (TRA-501)", () => {
	it("NodeCache.write rejects a node whose own slug is non-canonical", async () => {
		await expect(new NodeCache(dir).write(artist({ slug: EVIL_SLUG, name: "Evil" }))).rejects.toThrow(
			/invalid slug/,
		);
	});

	it("NodeCache.write rejects a node with a non-canonical edge slug", async () => {
		await expect(
			new NodeCache(dir).write(artist({ slug: "artist:fine", name: "Fine", aliases: [EVIL_EDGE] })),
		).rejects.toThrow(/invalid slug/);
	});

	it("NodeCache.replace rejects it too", async () => {
		await expect(new NodeCache(dir).replace(artist({ slug: EVIL_SLUG, name: "Evil" }))).rejects.toThrow(
			/invalid slug/,
		);
	});

	it("a valid write still reverses into a legacy node without failing on what it already had", async () => {
		// artist:fine is canonical but its own aliases edge is legacy: re-validating it after the
		// reverse update must not turn writing a perfectly valid project into an error.
		await writeRaw(artist({ slug: "artist:fine", name: "Fine", aliases: [EVIL_EDGE] }));
		const cache = new NodeCache(dir);

		await cache.write(
			project({
				slug: "project:album--fine",
				name: "Album",
				artists: [{ type: "artist", slug: "artist:fine", name: "Fine" }],
			}),
		);

		const reversed = await cache.get("artist:fine");
		expect(reversed.type === "artist" && reversed.discography.map((e) => e.slug)).toEqual([
			"project:album--fine",
		]);
	});
});
