import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Logger } from "../../src/logger.js";
import { createMobileCatalog, parseMobileIdentities } from "../../src/mobile/catalog.js";

const fixturePath = fileURLToPath(new URL("../fixtures/mobile-contracts.json", import.meta.url));

async function loadGraph(): Promise<unknown> {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { graph: unknown };
	return fixture.graph;
}

const expectedTaxonomy = {
	mode: "editorial",
	version: 2,
	families: [
		{ key: "rock", label: "Rock", order: 1, slug: "genre:rock" },
		{ key: "electronic", label: "Electronic", order: 2 },
	],
	genres: [
		{ id: "Q11366", name: "Alternative rock", family: "rock", slugs: ["genre:alternative-rock"] },
		{
			id: "Q205049",
			name: "Trip hop",
			family: "electronic",
			slugs: ["genre:trip-hop", "genre:bristol-sound"],
		},
		{ id: "local:dub", name: "Dub", family: "electronic", slugs: ["genre:dub"] },
	],
	legacySelectionBySlug: {
		"genre:alternative-rock": ["Q11366"],
		"genre:rock": ["Q11366"],
		"genre:bristol-sound": ["Q205049"],
		"genre:trip-hop-music": ["Q205049"],
	},
};

const degraded = { mode: "degraded", available: false };

function withTaxonomy(graph: unknown, patch: Record<string, unknown> | undefined): unknown {
	const base = graph as { taxonomy: Record<string, unknown> };
	return { ...base, taxonomy: patch === undefined ? undefined : { ...base.taxonomy, ...patch } };
}

interface RecordedWarn {
	message: string;
	meta: Record<string, unknown> | undefined;
}

// A real Logger that records warnings instead of writing them: we own the Logger interface, so no mock.
function recordingLogger(): { logger: Logger; warns: RecordedWarn[] } {
	const warns: RecordedWarn[] = [];
	const logger: Logger = {
		debug: () => undefined,
		info: () => undefined,
		warn: (message, meta) => {
			warns.push({ message, meta });
		},
		error: () => undefined,
		child: () => logger,
	};
	return { logger, warns };
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
			taxonomy: expectedTaxonomy,
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

	it("emits the editorial taxonomy field by field, without qid, in a stable revision", async () => {
		const graph = await loadGraph();
		const catalog = createMobileCatalog({ getGraph: async () => graph });

		const first = await catalog.getCatalog();
		const second = await catalog.getCatalog();

		expect(first.taxonomy).toStrictEqual(expectedTaxonomy);
		expect(JSON.stringify(first.taxonomy)).not.toContain("qid");
		expect(first.revision).toBe(second.revision);
	});

	it("degrades to available:false when the graph carries no taxonomy", async () => {
		const graph = withTaxonomy(await loadGraph(), undefined);

		const result = await createMobileCatalog({ getGraph: async () => graph }).getCatalog();

		expect(result.taxonomy).toEqual(degraded);
	});

	it.each([
		["an unknown version", { version: 3 }],
		["a non-genre slug in a genre", { genres: [{ id: "x", name: "X", family: "f", slugs: ["artist:x"] }] }],
		["a non-genre family slug", { families: [{ key: "f", label: "F", order: 1, slug: "artist:x" }] }],
		["a non-numeric family order", { families: [{ key: "f", label: "F", order: "1" }] }],
		["a fractional family order", { families: [{ key: "f", label: "F", order: 1.5 }] }],
		[
			"a non-canonical genre slug in a genre",
			{ genres: [{ id: "x", name: "X", family: "f", slugs: ["genre:Trip Hop"] }] },
		],
		[
			"a non-canonical family slug",
			{ families: [{ key: "f", label: "F", order: 1, slug: "genre:Trip Hop" }] },
		],
		["a non-string id in the legacy table", { legacySelectionBySlug: { "genre:rock": [1] } }],
		["a non-string id under a non-canonical legacy key", { legacySelectionBySlug: { "genre:r&b": [1] } }],
		["a legacy table that is not an object", { legacySelectionBySlug: ["genre:rock"] }],
	])("degrades without throwing on %s", async (_label, patch) => {
		const graph = withTaxonomy(await loadGraph(), patch);

		const result = await createMobileCatalog({ getGraph: async () => graph }).getCatalog();

		expect(result.taxonomy).toEqual(degraded);
	});

	it("changes the revision when only the taxonomy changes", async () => {
		const graph = await loadGraph();
		const other = withTaxonomy(graph, { families: [{ key: "rock", label: "Rock 'n' roll", order: 1 }] });

		const first = await createMobileCatalog({ getGraph: async () => graph }).getCatalog();
		const second = await createMobileCatalog({ getGraph: async () => other }).getCatalog();

		expect(second.taxonomy.mode).toBe("editorial");
		expect(second.revision).not.toBe(first.revision);
	});

	it("emits the same taxonomy with or without an identities filter", async () => {
		const graph = await loadGraph();
		const catalog = createMobileCatalog({ getGraph: async () => graph });

		const filtered = await catalog.getCatalog(["project:blue-lines"]);

		expect(filtered.taxonomy).toStrictEqual((await catalog.getCatalog()).taxonomy);
	});

	it.each([
		["a non-canonical key", "genre:r&b"],
		["a key that is not a genre identity", "artist:x"],
		["a key with a space", "genre:Trip Hop"],
		["a key without namespace", "rock"],
	])("drops %s from the legacy table and keeps the editorial taxonomy", async (_label, key) => {
		const graph = withTaxonomy(await loadGraph(), {
			legacySelectionBySlug: { ...expectedTaxonomy.legacySelectionBySlug, [key]: ["Q205560"] },
		});
		const { logger, warns } = recordingLogger();

		const result = await createMobileCatalog({ getGraph: async () => graph, logger }).getCatalog();

		expect(result.taxonomy).toStrictEqual(expectedTaxonomy);
		expect(warns).toEqual([]);
	});

	it("keeps the redirected slug that no genre lists in its slugs", async () => {
		const result = await createMobileCatalog({ getGraph: async () => loadGraph() }).getCatalog();

		const taxonomy = result.taxonomy;
		if (taxonomy.mode !== "editorial") throw new Error("expected an editorial taxonomy");
		const listed = taxonomy.genres.flatMap((genre) => genre.slugs);
		expect(listed).not.toContain("genre:trip-hop-music");
		expect(taxonomy.legacySelectionBySlug["genre:trip-hop-music"]).toEqual(["Q205049"]);
	});

	it("warns with a fixed reason, without third-party data, when a present taxonomy is rejected", async () => {
		const graph = withTaxonomy(await loadGraph(), {
			genres: [{ id: "x", name: "X", family: "f", slugs: ["genre:SECRET <script>"] }],
		});
		const { logger, warns } = recordingLogger();

		const result = await createMobileCatalog({ getGraph: async () => graph, logger }).getCatalog();

		expect(result.taxonomy).toEqual(degraded);
		expect(warns).toHaveLength(1);
		expect(warns[0]?.meta).toEqual({ reason: "invalid_genres" });
		expect(JSON.stringify(warns)).not.toContain("SECRET");
	});

	it.each([
		["an unknown version", { version: 3 }, "unsupported_version"],
		["a bad family", { families: [{ key: "f", label: "F", order: 1.5 }] }, "invalid_families"],
		["a bad legacy table", { legacySelectionBySlug: ["genre:rock"] }, "invalid_legacy_selection"],
	])("names the reason of the rejection for %s", async (_label, patch, reason) => {
		const graph = withTaxonomy(await loadGraph(), patch);
		const { logger, warns } = recordingLogger();

		await createMobileCatalog({ getGraph: async () => graph, logger }).getCatalog();

		expect(warns.map((warn) => warn.meta)).toEqual([{ reason }]);
	});

	it("does not warn when the taxonomy is absent or valid", async () => {
		const { logger, warns } = recordingLogger();

		await createMobileCatalog({ getGraph: async () => loadGraph(), logger }).getCatalog();
		await createMobileCatalog({
			getGraph: async () => withTaxonomy(await loadGraph(), undefined),
			logger,
		}).getCatalog();

		expect(warns).toEqual([]);
	});

	it.each([
		["null", null],
		["a string", "genre:rock"],
		["an array", []],
	])("warns when the taxonomy is %s rather than an object", async (_label, taxonomy) => {
		const graph = { ...((await loadGraph()) as Record<string, unknown>), taxonomy };
		const { logger, warns } = recordingLogger();

		const result = await createMobileCatalog({ getGraph: async () => graph, logger }).getCatalog();

		expect(result.taxonomy).toEqual(degraded);
		expect(warns.map((warn) => warn.meta)).toEqual([{ reason: "not_an_object" }]);
	});
});
