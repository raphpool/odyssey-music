import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createGenreResolver,
	type GenreCatalogEntry,
	loadGenreResolver,
	normalizeGenreName,
} from "../src/genre-identity.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

function technoEntry(): GenreCatalogEntry {
	return { slug: "techno", name: "techno", wikidata_qid: "Q170611" };
}

function houseEntry(): GenreCatalogEntry {
	return { slug: "house", name: "house", wikidata_qid: "Q186361" };
}

function ambientMusicEntry(): GenreCatalogEntry {
	return { slug: "ambient-music", name: "ambient music", wikidata_qid: "Q193207" };
}

describe("normalizeGenreName", () => {
	it.each([
		["Drum & Bass", "drum and bass"],
		["Synth-pop", "synth pop"],
		["2-step garage", "2 step garage"],
		["Drill 'n' bass", "drill n bass"],
		["Ambient music", "ambient music"],
		["Musique concrète", "musique concrete"],
		["", ""],
	])("normalizes %j to %j", (raw, expected) => {
		expect(normalizeGenreName(raw)).toBe(expected);
	});
});

describe("createGenreResolver", () => {
	it('resolves a known MBID to its QID with via "mbid"', () => {
		const resolver = createGenreResolver({
			catalog: [technoEntry()],
			mbidToQid: new Map([["41fe3260-fcc1-450b-bd5a-803886c56912", "Q170611"]]),
			aliases: new Map(),
		});

		const identity = resolver.resolve({ name: "irrelevant", mbid: "41fe3260-fcc1-450b-bd5a-803886c56912" });

		expect(identity).toEqual({ qid: "Q170611", label: "techno", slug: "techno", via: "mbid" });
	});

	it("prefers a known MBID over a name that would otherwise match a different genre", () => {
		const resolver = createGenreResolver({
			catalog: [technoEntry(), houseEntry()],
			mbidToQid: new Map([["known-mbid", "Q170611"]]),
			aliases: new Map(),
		});

		const identity = resolver.resolve({ name: "House", mbid: "known-mbid" });

		expect(identity?.qid).toBe("Q170611");
		expect(identity?.via).toBe("mbid");
	});

	it("matches the catalog name across different casing and punctuation", () => {
		const resolver = createGenreResolver({
			catalog: [{ slug: "hip-hop", name: "hip hop", wikidata_qid: "Q500" }],
			mbidToQid: new Map(),
			aliases: new Map(),
		});

		const identity = resolver.resolve({ name: "  HIP-HOP!!  " });

		expect(identity).toEqual({ qid: "Q500", label: "hip hop", slug: "hip-hop", via: "name" });
	});

	it("matches the catalog slug when only the slug normalizes to the input", () => {
		// name normalizes to "drum n bass" but slug normalizes to "drum and bass" — distinct keys,
		// so this exercises a step-3 (slug-only) match in isolation.
		const resolver = createGenreResolver({
			catalog: [{ slug: "drum-and-bass", name: "drum'n'bass", wikidata_qid: "Q600" }],
			mbidToQid: new Map(),
			aliases: new Map(),
		});

		const identity = resolver.resolve({ name: "Drum and Bass" });

		expect(identity).toEqual({ qid: "Q600", label: "drum'n'bass", slug: "drum-and-bass", via: "name" });
	});

	it('resolves a curated alias with via "alias"', () => {
		const resolver = createGenreResolver({
			catalog: [ambientMusicEntry()],
			mbidToQid: new Map(),
			aliases: new Map([["amby", "Q193207"]]),
		});

		const identity = resolver.resolve({ name: "Amby" });

		expect(identity).toEqual({ qid: "Q193207", label: "ambient music", slug: "ambient-music", via: "alias" });
	});

	it("prefers a curated alias over a heuristic match for the same normalized name", () => {
		// "vaporwave" is also the squashed form of "vapor wave" below, so without the alias,
		// step 6 would resolve this to Q100 instead — the alias must win.
		const resolver = createGenreResolver({
			catalog: [
				{ slug: "vapor-wave", name: "vapor wave", wikidata_qid: "Q100" },
				{ slug: "vaporwave-revival", name: "vaporwave revival", wikidata_qid: "Q200" },
			],
			mbidToQid: new Map(),
			aliases: new Map([["vaporwave", "Q200"]]),
		});

		const identity = resolver.resolve({ name: "Vaporwave" });

		expect(identity?.qid).toBe("Q200");
		expect(identity?.via).toBe("alias");
	});

	it('resolves both with and without the " music" suffix to the same QID (step 5)', () => {
		const resolver = createGenreResolver({
			catalog: [ambientMusicEntry()],
			mbidToQid: new Map(),
			aliases: new Map(),
		});

		expect(resolver.resolve({ name: "Ambient music" })?.qid).toBe("Q193207");
		const withoutSuffix = resolver.resolve({ name: "Ambient" });
		expect(withoutSuffix?.qid).toBe("Q193207");
		expect(withoutSuffix?.via).toBe("heuristic");
	});

	it("resolves a squashed spelling to the same QID as the spaced one (step 6)", () => {
		const resolver = createGenreResolver({
			catalog: [{ slug: "synth-pop", name: "synth-pop", wikidata_qid: "Q1298934" }],
			mbidToQid: new Map(),
			aliases: new Map(),
		});

		expect(resolver.resolve({ name: "Synth-pop" })?.qid).toBe("Q1298934");
		const squashed = resolver.resolve({ name: "Synthpop" });
		expect(squashed?.qid).toBe("Q1298934");
		expect(squashed?.via).toBe("heuristic");
	});

	it("returns null for an unknown genre name, never throwing", () => {
		const resolver = createGenreResolver({
			catalog: [technoEntry()],
			mbidToQid: new Map(),
			aliases: new Map(),
		});

		expect(() => resolver.resolve({ name: "Braindance" })).not.toThrow();
		expect(resolver.resolve({ name: "Braindance" })).toBeNull();
	});

	it("returns null when a mapped MBID's QID has no catalog entry, rather than falling back to the name", () => {
		const resolver = createGenreResolver({
			catalog: [houseEntry()],
			mbidToQid: new Map([["orphan-mbid", "Q999999"]]),
			aliases: new Map(),
		});

		expect(resolver.resolve({ name: "House", mbid: "orphan-mbid" })).toBeNull();
	});

	it("lets the first catalog entry win a normalized-key collision, stably across two resolvers", () => {
		const catalog: GenreCatalogEntry[] = [
			{ slug: "duplicate-a", name: "Duplicate Genre", wikidata_qid: "Q1" },
			{ slug: "duplicate-b", name: "duplicate  genre", wikidata_qid: "Q2" },
		];

		const first = createGenreResolver({ catalog, mbidToQid: new Map(), aliases: new Map() });
		const second = createGenreResolver({ catalog, mbidToQid: new Map(), aliases: new Map() });

		expect(first.resolve({ name: "Duplicate Genre" })?.qid).toBe("Q1");
		expect(second.resolve({ name: "Duplicate Genre" })?.qid).toBe("Q1");
	});
});

describe("loadGenreResolver", () => {
	it('reads the three real data files, resolves "Techno", and memoizes the instance across calls', async () => {
		const first = await loadGenreResolver();
		const second = await loadGenreResolver();

		expect(second).toBe(first);
		const identity = first.resolve({ name: "Techno" });
		expect(identity?.qid).toBe("Q170611");
		expect(identity?.via).toBe("name");
	});

	it("resolves the five measured cases from the plan to a non-null identity", async () => {
		const resolver = await loadGenreResolver();

		for (const name of ["IDM", "R&B", "Minimalism", "Prog-Rock", "Ambient music"]) {
			expect(resolver.resolve({ name }), `expected "${name}" to resolve`).not.toBeNull();
		}
	});

	it("resolves Ambient/Ambient music, Electronic/Electronic music and Synth-pop/Synthpop pairs to the same QID", async () => {
		const resolver = await loadGenreResolver();

		for (const [a, b] of [
			["Ambient", "Ambient music"],
			["Electronic", "Electronic music"],
			["Synth-pop", "Synthpop"],
		]) {
			const identityA = resolver.resolve({ name: a as string });
			const identityB = resolver.resolve({ name: b as string });
			expect(identityA?.qid).not.toBeNull();
			expect(identityA?.qid).toBe(identityB?.qid);
		}
	});
});

describe("data/genre-aliases.json", () => {
	it("has entries whose alias is already normalized, whose qid exists in the catalog, and whose catalog_name matches", async () => {
		const [catalogRaw, aliasesRaw] = await Promise.all([
			readFile(join(dataDir, "genre-catalog.json"), "utf8"),
			readFile(join(dataDir, "genre-aliases.json"), "utf8"),
		]);

		const catalog = JSON.parse(catalogRaw) as { genres: GenreCatalogEntry[] };
		const aliases = JSON.parse(aliasesRaw) as {
			aliases: { alias: string; qid: string; catalog_name: string }[];
		};
		const catalogByQid = new Map(catalog.genres.map((entry) => [entry.wikidata_qid, entry]));

		for (const entry of aliases.aliases) {
			expect(normalizeGenreName(entry.alias)).toBe(entry.alias);
			const catalogEntry = catalogByQid.get(entry.qid);
			expect(catalogEntry).toBeDefined();
			expect(catalogEntry?.name).toBe(entry.catalog_name);
		}
	});
});
