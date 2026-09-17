import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../scripts/propose-genre-seeds.js";
import type { GenreCoverageReport } from "../src/genre-coverage.js";
import {
	BATCH_BUDGETS,
	PRESCRIBED_GENRES,
	type ProposalCandidates,
	proposeGenreSeeds,
	proposeGenreSeedsFromMusicBrainz,
	resolveMusicBrainzCandidates,
	validateGenreSeedProposalInputs,
} from "../src/genre-seed-proposals.js";
import type { GenreSeeds } from "../src/genre-seeds.js";
import type { GenreTaxonomy } from "../src/genre-taxonomy.js";

function fixture(): { taxonomy: GenreTaxonomy; coverage: GenreCoverageReport; dossiers: GenreSeeds } {
	const taxonomy: GenreTaxonomy = {
		version: 2,
		families: [{ key: "fixture", label: "Fixture", order: 0 }],
		genres: PRESCRIBED_GENRES.map(({ id, name, qid, sourceSlugs }) => ({
			id,
			name,
			family: "fixture",
			published: false,
			...(qid === undefined ? {} : { qid }),
			...(sourceSlugs.length === 0 ? {} : { sourceSlugs: [...sourceSlugs] }),
		})),
	};
	const coverage: GenreCoverageReport = {
		entries: Object.fromEntries(
			PRESCRIBED_GENRES.map(({ id, sourceSlugs, existingNeighbours, deficit }) => [
				id,
				{
					resolvedSources: [...sourceSlugs],
					missingSources: [],
					quarantinedSources: [],
					neighbourCount: existingNeighbours,
					deficit,
					publishable: false,
				},
			]),
		),
		families: { fixture: { entries: PRESCRIBED_GENRES.length, publishable: 0, deficit: 0 } },
	};
	const dossiers: GenreSeeds = Object.fromEntries(
		PRESCRIBED_GENRES.map(({ id, name, qid, slug }) => [
			id,
			{ genre: { slug, name, ...(qid === undefined ? {} : { qid }) }, targets: [], anchors: [] },
		]),
	);
	return { taxonomy, coverage, dossiers };
}

describe("TRA-216 prescribed genre proposals", () => {
	it("defines 60 unique targets across five budgets, including absent, deficient, and Trap cases", () => {
		expect(PRESCRIBED_GENRES).toHaveLength(60);
		expect(new Set(PRESCRIBED_GENRES.map(({ id }) => id))).toHaveLength(60);
		expect(PRESCRIBED_GENRES.map(({ id }) => id).join(",")).toBe(
			"Q486263,Q723418,Q208239,Q11403,Q14390274,Q388296,Q3591962,Q2000173,Q963061,Q1752683,Q6942022,Q11307326,Q194492,Q131578,Q213665,Q4942839,Q336567,Q474027,Q54365,Q25099840,Q85741139,Q132438,Q483251,Q7118426,Q876171,Q2913982,Q106528337,Q481900,Q2866725,Q65937774,Q2406633,Q30917612,Q216961,Q820049,Q2748817,Q1521688,Q339906,Q223840,Q601235,Q105636940,local:leftfield-techno,Q3048168,Q438503,Q529742,Q2261628,Q19879476,Q16829781,Q141459,Q8560269,Q15697534,Q12362064,Q5421158,Q1045541,Q753679,Q255406,Q97265899,Q6010117,Q6918602,Q840065,Q850412",
		);
		expect(BATCH_BUDGETS).toEqual({ B4a: 58, B4b: 16, B4c: 20, B4e: 60, B4f: 67 });
		expect(PRESCRIBED_GENRES.find(({ id }) => id === "Q486263")).toMatchObject({
			sourceSlugs: [],
			existingNeighbours: 0,
			deficit: 3,
		});
		expect(PRESCRIBED_GENRES.find(({ id }) => id === "Q963061")).toMatchObject({
			sourceSlugs: ["genre:highlife"],
			existingNeighbours: 1,
			deficit: 2,
		});
		expect(PRESCRIBED_GENRES.find(({ id }) => id === "Q2913982")).toMatchObject({
			name: "Trap",
			slug: "genre:trap-hip-hop",
		});
	});

	// 2026-09-17 (TRA-247): the fixture above is built from PRESCRIBED_GENRES itself, so folding
	// Classic Disco and Rap into aliases and renaming Memphis left the real files out of step with
	// this list without any test noticing; propose-genre-seeds.ts then threw on the real taxonomy.
	it("stays in step with the committed taxonomy and seed dossiers", async () => {
		const { readFile } = await import("node:fs/promises");
		const taxonomy = JSON.parse(await readFile("data/genre-taxonomy.json", "utf8")) as GenreTaxonomy;
		const dossiers = JSON.parse(await readFile("data/genre-seeds.json", "utf8")) as GenreSeeds;
		const entries = new Map(taxonomy.genres.map((entry) => [entry.id, entry]));
		for (const target of PRESCRIBED_GENRES) {
			expect(entries.get(target.id)?.name, target.id).toBe(target.name);
			const dossier = dossiers[target.id];
			if (dossier !== undefined) {
				expect(dossier.genre.name, target.id).toBe(target.name);
				expect(dossier.genre.slug, target.id).toBe(target.slug);
			}
		}
	});

	it("accepts complete inputs with taxonomy families and publication flags", () => {
		expect(() => validateGenreSeedProposalInputs(fixture())).not.toThrow();
	});

	it.each([
		[
			"a missing dossier",
			(input: ReturnType<typeof fixture>) => {
				const dossiers = { ...input.dossiers };
				delete dossiers.Q486263;
				return dossiers;
			},
		],
		[
			"a foreign dossier",
			(input: ReturnType<typeof fixture>) => ({
				...input.dossiers,
				Q999: { genre: { slug: "genre:foreign", name: "Foreign", qid: "Q999" }, targets: [], anchors: [] },
			}),
		],
	])("rejects %s", (_label, dossiers) => {
		const input = fixture();
		input.dossiers = dossiers(input);
		expect(() => validateGenreSeedProposalInputs(input)).toThrow();
	});

	it("rejects incoherent dossier identities and incompatible coverage", () => {
		const incoherent = fixture();
		incoherent.dossiers = Object.fromEntries(
			PRESCRIBED_GENRES.map(({ id, name, qid, slug }) => [
				id,
				{ genre: { slug, name, ...(qid === undefined ? {} : { qid }) }, targets: [], anchors: [] },
			]),
		);
		const trapDossier = incoherent.dossiers.Q2913982;
		if (!trapDossier) throw new Error("Fixture must include Trap");
		incoherent.dossiers.Q2913982 = {
			...trapDossier,
			genre: { slug: "genre:wrong", name: "Trap", qid: "Q2913982" },
		};
		expect(() => validateGenreSeedProposalInputs(incoherent)).toThrow(/identity/i);

		const incompatible = fixture();
		const highlifeCoverage = incompatible.coverage.entries.Q963061;
		if (!highlifeCoverage) throw new Error("Fixture must include Highlife coverage");
		highlifeCoverage.deficit = 3;
		expect(() => validateGenreSeedProposalInputs(incompatible)).toThrow(/coverage deficit/i);

		const missingSource = fixture();
		const dancehallCoverage = missingSource.coverage.entries.Q474027;
		if (!dancehallCoverage) throw new Error("Fixture must include Dancehall coverage");
		dancehallCoverage.resolvedSources = [];
		dancehallCoverage.missingSources = ["genre:dancehall"];
		expect(() => validateGenreSeedProposalInputs(missingSource)).toThrow(/coverage sources/i);
	});
});

const proof = { url: "https://evidence.example.test/relation", verified: true };
const unverifiedProof = { ...proof, verified: "false" as never };
const anchor = {
	slug: "genre:jazz",
	name: "Jazz",
	qid: "Q8341",
	justification: "The cited source identifies Jazz as the documented parent context.",
	proofs: [proof],
};

function candidates(): Record<string, ProposalCandidates> {
	return Object.fromEntries(PRESCRIBED_GENRES.map(({ id }) => [id, { targets: [], anchors: [] }]));
}

function partialProposalInput(ids: readonly string[]): {
	taxonomy: GenreTaxonomy;
	coverage: GenreCoverageReport;
	candidates: Record<string, ProposalCandidates>;
} {
	const input = fixture();
	const entries = Object.fromEntries(
		ids.map((id) => {
			const entry = input.coverage.entries[id];
			if (!entry) throw new Error(`Fixture must include coverage for ${id}`);
			return [id, entry];
		}),
	);
	return {
		taxonomy: { ...input.taxonomy, genres: input.taxonomy.genres.filter(({ id }) => ids.includes(id)) },
		coverage: {
			...input.coverage,
			entries,
			families: { fixture: { entries: ids.length, publishable: 0, deficit: 0 } },
		},
		candidates: Object.fromEntries(ids.map((id) => [id, { targets: [], anchors: [] }])),
	};
}

describe("TRA-221 targeted genre proposals", () => {
	it("accepts multiple requested IDs from a partial taxonomy in explicit CLI mode", async () => {
		const directory = await mkdtemp(join(tmpdir(), "odyssey-tra-221-"));
		let stdout = "";
		let stderr = "";
		const output = {
			stdout: {
				write(value: string): void {
					stdout += value;
				},
			},
			stderr: {
				write(value: string): void {
					stderr += value;
				},
			},
		};
		try {
			const path = join(directory, "partial.json");
			await writeFile(path, JSON.stringify(partialProposalInput(["Q106528337", "Q481900"])));

			expect(await main([path, "--ids", "Q106528337,Q481900"], output)).toBe(0);
			const report = JSON.parse(stdout) as { entries: Record<string, unknown> };
			expect(Object.keys(report.entries)).toEqual(["Q106528337", "Q481900"]);
			expect(stderr).toBe("");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("still validates the identity of every requested genre", () => {
		const input = partialProposalInput(["Q106528337"]);
		input.taxonomy = {
			...input.taxonomy,
			genres: input.taxonomy.genres.map((genre) => ({ ...genre, name: "Wrong Acid" })),
		};

		expect(() =>
			proposeGenreSeeds(input.taxonomy, input.coverage, input.candidates, {
				trustedHosts: [],
				requestedIds: ["Q106528337"],
			}),
		).toThrow("Taxonomy identity does not match prescribed genre: Q106528337");
	});

	it("keeps the default mode strict and identifies an unknown requested ID", async () => {
		const directory = await mkdtemp(join(tmpdir(), "odyssey-tra-221-"));
		try {
			const path = join(directory, "partial.json");
			await writeFile(path, JSON.stringify(partialProposalInput(["Q106528337"])));

			let stdout = "";
			let stderr = "";
			const defaultOutput = {
				stdout: {
					write(value: string): void {
						stdout += value;
					},
				},
				stderr: {
					write(value: string): void {
						stderr += value;
					},
				},
			};
			expect(await main([path], defaultOutput)).toBe(1);
			expect(stdout).toBe("");
			expect(stderr).toMatch(/Unknown genre taxonomy id: Q486263/);

			stdout = "";
			stderr = "";
			const targetedOutput = {
				stdout: {
					write(value: string): void {
						stdout += value;
					},
				},
				stderr: {
					write(value: string): void {
						stderr += value;
					},
				},
			};
			expect(await main([path, "--ids", "Q999"], targetedOutput)).toBe(1);
			expect(stderr).toMatch(/Unknown requested genre id: Q999/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("TRA-217 justified seed proposals", () => {
	it("builds strict B1 seeds from distinct justified candidates without changing materialized publication", () => {
		const input = candidates();
		input.Q2913982 = {
			targets: [
				{
					type: "artist",
					name: "One",
					slug: "artist:one",
					mbid: "550e8400-e29b-41d4-a716-446655440000",
					proofs: [proof],
				},
				{ type: "project", name: "Two", slug: "project:two", proofs: [proof] },
				{ type: "track", name: "Three", slug: "track:three", proofs: [proof] },
			],
			anchors: [anchor],
		};
		const report = proposeGenreSeeds(fixture().taxonomy, fixture().coverage, input, {
			trustedHosts: ["evidence.example.test"],
		});

		expect(report.entries.Q2913982).toMatchObject({
			requiredTargets: 3,
			publishable: false,
			acceptedAnchors: [anchor],
		});
		expect(report.seeds.Q2913982).toMatchObject({
			anchors: [{ slug: "genre:jazz", name: "Jazz", qid: "Q8341" }],
		});
	});

	it("reports homonyms, untrusted evidence, duplicate targets, and a missing justified anchor", () => {
		const input = candidates();
		input.Q2913982 = {
			targets: [
				{ type: "artist", name: "Homonym", slug: "artist:homonym", homonym: true, proofs: [proof] },
				{
					type: "project",
					name: "Unsafe",
					slug: "project:unsafe",
					proofs: [{ ...proof, url: "http://bad.test" }],
				},
				{ type: "track", name: "Valid", slug: "track:valid", proofs: [proof] },
				{ type: "track", name: "Duplicate", slug: "track:valid", proofs: [proof] },
				{ type: "genre" as never, name: "Wrong type", slug: "genre:wrong", proofs: [proof] },
				{ type: "artist", name: "Unchecked", slug: "artist:unchecked", proofs: [unverifiedProof] },
			],
			anchors: [
				{ ...anchor, justification: "" },
				{ ...anchor, slug: "genre:untrusted", proofs: [{ ...proof, url: "https://bad.test/proof" }] },
			],
		};
		const report = proposeGenreSeeds(fixture().taxonomy, fixture().coverage, input, {
			trustedHosts: ["evidence.example.test"],
		});

		expect(report.entries.Q2913982).toMatchObject({
			missingTargets: 2,
			missingAnchors: 1,
		});
		expect(report.entries.Q2913982?.rejected.map(({ reason }) => reason)).toEqual([
			"homonym",
			"proof URL must be HTTPS with a plain host",
			"duplicate seed identity",
			"invalid target type",
			"proof is not verified",
			"missing anchor relation justification",
			"proof host is not trusted: bad.test",
		]);
	});
});

function musicBrainzResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TRA-218 MusicBrainz identity resolution", () => {
	it("keeps CLI stdout to JSON and distinguishes valid, invalid, and unreadable inputs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "odyssey-tra-218-"));
		let stdout = "";
		let stderr = "";
		const output = {
			stdout: {
				write: (value: string) => {
					stdout += value;
				},
			},
			stderr: {
				write: (value: string) => {
					stderr += value;
				},
			},
		};
		try {
			const valid = join(directory, "valid.json");
			const { taxonomy, coverage } = fixture();
			await writeFile(valid, JSON.stringify({ taxonomy, coverage, candidates: candidates() }));
			expect(await main([valid], output)).toBe(0);
			expect(() => JSON.parse(stdout)).not.toThrow();

			stdout = "";
			await writeFile(valid, "{}");
			expect(await main([valid], output)).toBe(2);
			expect(stdout).toBe("");
			expect(stderr).toMatch(/invalid proposal input/i);
			expect(await main([join(directory, "missing.json")], output)).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("resolves a same-name, same-type candidate at the HTTP boundary and adds its MB proof", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL) =>
			musicBrainzResponse({
				artists: [{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Boundary Artist" }],
			}),
		);
		vi.stubGlobal("fetch", fetch);

		const [resolved] = await resolveMusicBrainzCandidates([
			{ type: "artist", name: "Boundary Artist", slug: "artist:boundary-artist", proofs: [] },
		]);

		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toContain("/ws/2/artist");
		expect(resolved).toMatchObject({
			mbid: "550e8400-e29b-41d4-a716-446655440000",
			proofs: [
				{ url: "https://musicbrainz.org/artist/550e8400-e29b-41d4-a716-446655440000", verified: true },
			],
		});
	});

	it("does not look up homonyms and reports a failed network lookup without throwing", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("offline");
		});
		vi.stubGlobal("fetch", fetch);

		const [homonym, unavailable] = await resolveMusicBrainzCandidates([
			{
				type: "artist",
				name: "Ambiguous Artist",
				slug: "artist:ambiguous-artist",
				proofs: [],
				homonym: true,
			},
			{ type: "track", name: "Offline Track", slug: "track:offline-track", proofs: [] },
		]);

		expect(homonym?.homonym).toBe(true);
		expect(unavailable?.resolutionError).toMatch(/unresolved/i);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("rejects same-name MusicBrainz results with distinct MBIDs as unresolved homonyms", async () => {
		vi.stubGlobal("fetch", async () =>
			musicBrainzResponse({
				artists: [
					{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Duplicate Artist" },
					{ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", name: "Duplicate Artist" },
				],
			}),
		);
		const [candidate] = await resolveMusicBrainzCandidates([
			{ type: "artist", name: "Duplicate Artist", slug: "artist:duplicate-artist", proofs: [] },
		]);
		expect(candidate?.resolutionError).toBe("MusicBrainz identity ambiguous");
	});
});

describe("TRA-219 MusicBrainz proposal resolution pacing", () => {
	it("paces 172 candidates without a MusicBrainz request burst", async () => {
		let activeRequests = 0;
		let peakRequests = 0;
		let requestCount = 0;
		const wait = vi.fn(async () => undefined);
		vi.stubGlobal("fetch", async () => {
			const requestIndex = requestCount++;
			activeRequests += 1;
			peakRequests = Math.max(peakRequests, activeRequests);
			await Promise.resolve();
			activeRequests -= 1;
			if (requestIndex === 170)
				return musicBrainzResponse({
					artists: [
						{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Ambiguous Candidate" },
						{ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", name: "Ambiguous Candidate" },
					],
				});
			return musicBrainzResponse({
				artists: [
					{
						id: "550e8400-e29b-41d4-a716-446655440000",
						name: `Candidate ${requestIndex + 1}`,
					},
				],
			});
		});

		const resolved = await resolveMusicBrainzCandidates(
			[
				...Array.from({ length: 170 }, (_, index) => ({
					type: "artist" as const,
					name: `Candidate ${index + 1}`,
					slug: `artist:candidate-${index + 1}`,
					proofs: [],
				})),
				{
					type: "artist",
					name: "Known Homonym",
					slug: "artist:known-homonym",
					proofs: [],
					homonym: true,
				},
				{
					type: "artist",
					name: "Ambiguous Candidate",
					slug: "artist:ambiguous-candidate",
					proofs: [],
				},
			],
			{ wait },
		);

		expect(resolved).toHaveLength(172);
		expect(resolved[170]?.homonym).toBe(true);
		expect(resolved[171]?.resolutionError).toBe("MusicBrainz identity ambiguous");
		expect(requestCount).toBe(171);
		expect(peakRequests).toBe(1);
		expect(wait).toHaveBeenCalledTimes(170);
	});

	it("paces candidates globally when proposals span multiple dossiers", async () => {
		let activeRequests = 0;
		let peakRequests = 0;
		let requestCount = 0;
		const wait = vi.fn(async () => undefined);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const requestIndex = requestCount++;
			const name = new URL(String(input)).searchParams.get("query");
			if (!name) throw new Error("MusicBrainz request must include the candidate name");
			activeRequests += 1;
			peakRequests = Math.max(peakRequests, activeRequests);
			await Promise.resolve();
			activeRequests -= 1;
			return musicBrainzResponse({
				artists: [
					{
						id: `550e8400-e29b-41d4-a716-${String(requestIndex + 1).padStart(12, "0")}`,
						name,
					},
				],
			});
		});
		const input = candidates();
		let candidateIndex = 0;
		for (const prescribed of PRESCRIBED_GENRES) {
			const count = Math.min(3, 172 - candidateIndex);
			input[prescribed.id] = {
				targets: Array.from({ length: count }, () => {
					candidateIndex += 1;
					return {
						type: "artist" as const,
						name: `Distributed Candidate ${candidateIndex}`,
						slug: `artist:distributed-candidate-${candidateIndex}`,
						proofs: [],
					};
				}),
				anchors: [],
			};
		}

		await proposeGenreSeedsFromMusicBrainz(
			fixture().taxonomy,
			fixture().coverage,
			input,
			{ trustedHosts: ["musicbrainz.org"] },
			{ wait },
		);

		expect(candidateIndex).toBe(172);
		expect(requestCount).toBe(172);
		expect(peakRequests).toBe(1);
		expect(wait).toHaveBeenCalledTimes(171);
	});
});
