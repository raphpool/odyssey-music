// TRA-821: the l10n.fr rules are strict on WRITE (TRA-802) but a block already on disk that fails them
// (older tool, hand edit, rule tightened since) must not make the whole node unreadable: the English card
// is served without l10n and the problem is logged. Same shape as the slug tolerance of TRA-501.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache, resetInvalidTranslationWarnings } from "../src/cache.js";
import { buildGraphFromCache } from "../src/graph.js";
import { createGraphService } from "../src/services/graph-service.js";
import type { ArtistNode } from "../src/types.js";

let dir: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	resetInvalidTranslationWarnings();
	dir = await mkdtemp(join(tmpdir(), "odyssey-l10n-read-"));
	// The logger writes warn/error to console.error.
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
	errorSpy.mockRestore();
	await rm(dir, { recursive: true, force: true });
});

const validFr = {
	teaser: "Un resume court.",
	article: "Un long article en francais sur ce noeud et sa portee culturelle. ".repeat(3),
	facts: { origin: "Cornouailles" },
	source_sha256: "a".repeat(64),
	model: "gemini-flash-lite",
	translated_at: "2026-11-23T10:00:00.000Z",
};
// `article` is 10 characters: below the 80-character floor.
const invalidFr = { ...validFr, article: "Trop court" };

function artist(slug: `artist:${string}`, l10n?: unknown): ArtistNode {
	const name = slug.slice("artist:".length);
	return {
		type: "artist",
		slug,
		name,
		editorial_bio: `Fixture bio for ${name}.`,
		editorial_article: `A real long article about ${name} for l10n tolerance coverage. `.repeat(4),
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
		...(l10n === undefined ? {} : { l10n }),
	} as ArtistNode;
}

const fileFor = (slug: string) => join(dir, "nodes", "artist", `${slug.slice("artist:".length)}.json`);

// Straight to disk, bypassing the write schema, as an older tool or a hand edit would have left it.
async function writeRaw(node: ArtistNode): Promise<void> {
	await mkdir(join(dir, "nodes", "artist"), { recursive: true });
	await writeFile(fileFor(node.slug), JSON.stringify(node), "utf8");
}

const loggedLines = () =>
	errorSpy.mock.calls
		.map(([line]) => String(line))
		.filter((line) => line.includes("invalid l10n"))
		.map((line) => JSON.parse(line) as { level: string; slug: string; fields: string[] });

describe("reading a cached node with an invalid l10n.fr (TRA-821)", () => {
	it("serves the node without l10n and without error, and logs a warning", async () => {
		await writeRaw(artist("artist:sick", { fr: invalidFr }));

		const node = await new NodeCache(dir).get("artist:sick");

		expect(node.slug).toBe("artist:sick");
		expect(node.editorial_article).toContain("for l10n tolerance coverage");
		expect("l10n" in node).toBe(false);
		expect(loggedLines()).toEqual([
			expect.objectContaining({ level: "warn", slug: "artist:sick", fields: ["l10n.fr.article"] }),
		]);
	});

	it("does not copy the offending content into the log", async () => {
		await writeRaw(artist("artist:sick", { fr: invalidFr }));

		await new NodeCache(dir).get("artist:sick");

		expect(errorSpy.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain("Trop court");
	});

	it("logs only the top-level key of a bad facts entry, never the record key", async () => {
		await writeRaw(artist("artist:sick", { fr: { ...validFr, facts: { "secret-looking key": "" } } }));

		await new NodeCache(dir).get("artist:sick");

		expect(loggedLines()).toEqual([expect.objectContaining({ fields: ["l10n.fr.facts"] })]);
	});

	it("also tolerates an l10n block that is not an object", async () => {
		await writeRaw(artist("artist:sick", "fr"));

		const node = await new NodeCache(dir).get("artist:sick");

		expect("l10n" in node).toBe(false);
		expect(loggedLines()).toHaveLength(1);
	});

	it("logs once per slug and process", async () => {
		await writeRaw(artist("artist:sick", { fr: invalidFr }));

		await new NodeCache(dir).get("artist:sick");
		await new NodeCache(dir).get("artist:sick");

		expect(loggedLines()).toHaveLength(1);
	});

	it("still throws when the node is invalid for another reason", async () => {
		await writeRaw({ ...artist("artist:sick", { fr: invalidFr }), editorial_article: "too short" });

		await expect(new NodeCache(dir).get("artist:sick")).rejects.toThrow(/Invalid cached node/);
	});

	it("refuses to WRITE the same node, and leaves nothing on disk", async () => {
		await expect(new NodeCache(dir).write(artist("artist:sick", { fr: invalidFr }))).rejects.toThrow();

		await expect(readFile(fileFor("artist:sick"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reads a node without l10n as before, with no warning", async () => {
		await writeRaw(artist("artist:plain"));

		const node = await new NodeCache(dir).get("artist:plain");

		expect("l10n" in node).toBe(false);
		expect(loggedLines()).toEqual([]);
	});

	it("reads a node with a valid l10n.fr as before, with no warning", async () => {
		await writeRaw(artist("artist:fr", { fr: validFr }));

		const node = await new NodeCache(dir).get("artist:fr");

		expect(node.l10n).toEqual({ fr: validFr });
		expect(loggedLines()).toEqual([]);
	});

	it("buildGraphFromCache and the HTTP graph service keep every node instead of failing", async () => {
		await writeRaw(artist("artist:sick", { fr: invalidFr }));
		await writeRaw(artist("artist:fr", { fr: validFr }));
		await writeRaw(artist("artist:plain"));

		const graph = await buildGraphFromCache(dir);
		const served = await createGraphService(dir).getGraph();

		expect(graph.nodes.map((n) => n.id).sort()).toEqual(["artist:fr", "artist:plain", "artist:sick"]);
		expect(served.total).toBe(3);
	});
});
