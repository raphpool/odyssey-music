import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMobileCatalog, parseMobileIdentities } from "../../src/mobile/catalog.js";

const fixturePath = fileURLToPath(new URL("../fixtures/mobile-contracts.json", import.meta.url));

async function loadGraph(): Promise<unknown> {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { graph: unknown };
	return fixture.graph;
}

describe("mobile catalog", () => {
	it("projects only mobile-safe music nodes and creates a stable SHA-256 revision", async () => {
		const graph = await loadGraph();
		const catalog = createMobileCatalog({ getGraph: async () => graph });

		const first = await catalog.getCatalog();
		const changedTimestamp = {
			...(graph as Record<string, unknown>),
			generated_at: "2030-01-01T00:00:00.000Z",
		};
		const second = await createMobileCatalog({ getGraph: async () => changedTimestamp }).getCatalog();

		expect(first).toEqual({
			version: "v1",
			revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			taxonomy: { mode: "degraded", available: true },
			nodes: [
				{
					identity: "artist:massive-attack",
					type: "artist",
					name: "Massive Attack",
					teaser: "Bristol collective.",
				},
				{
					identity: "artist:massive-attack--bristol-group",
					type: "artist",
					name: "Massive Attack (Bristol group)",
					teaser: "Disambiguated identity.",
				},
				{
					identity: "project:blue-lines",
					type: "project",
					name: "Blue Lines",
					teaser: "A foundational trip hop record.",
				},
			],
			edges: [
				{
					source: "artist:massive-attack",
					target: "project:blue-lines",
					type: "discography",
				},
			],
		});
		expect(first.revision).toBe(second.revision);
	});

	it("filters catalog data to requested valid identities", async () => {
		const graph = await loadGraph();
		const catalog = createMobileCatalog({ getGraph: async () => graph });

		const result = await catalog.getCatalog(["project:blue-lines"]);

		expect(result.nodes.map((node) => node.identity)).toEqual(["project:blue-lines"]);
		expect(result.edges).toEqual([]);
	});

	it("rejects malformed, duplicate, and over-limit identity filters", () => {
		expect(() => parseMobileIdentities("artist:massive-attack,artist:massive-attack")).toThrow(
			"identities must be unique",
		);
		expect(() => parseMobileIdentities("article:ignored")).toThrow("unsupported identity type");
		expect(() => parseMobileIdentities("artist:bad identity")).toThrow("invalid identity");
		expect(parseMobileIdentities("artist:massive-attack--bristol-group")).toEqual([
			"artist:massive-attack--bristol-group",
		]);
		expect(() =>
			parseMobileIdentities(Array.from({ length: 21 }, (_, index) => `artist:item-${index}`).join(",")),
		).toThrow("at most 20 identities");
	});

	it("accepts exactly 8 KiB and rejects an identities filter above the limit before splitting it", () => {
		const atLimit = `artist:${"a".repeat(8 * 1024 - "artist:".length)}`;
		expect(parseMobileIdentities(atLimit)).toEqual([atLimit]);
		expect(() => parseMobileIdentities(`${atLimit}a`)).toThrow("at most 8192 bytes");
	});
});
