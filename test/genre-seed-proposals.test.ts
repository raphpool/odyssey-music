import { describe, expect, it } from "vitest";

import type { GenreCoverageReport } from "../src/genre-coverage.js";
import {
	BATCH_BUDGETS,
	PRESCRIBED_GENRES,
	type ProposalCandidates,
	proposeGenreSeeds,
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
	it("defines 62 unique targets across five budgets, including absent, deficient, and Trap cases", () => {
		expect(PRESCRIBED_GENRES).toHaveLength(62);
		expect(new Set(PRESCRIBED_GENRES.map(({ id }) => id))).toHaveLength(62);
		expect(PRESCRIBED_GENRES.map(({ id }) => id).join(",")).toBe(
			"Q486263,Q723418,Q208239,Q11403,Q14390274,Q388296,local:ethiopian-jazz,Q2000173,Q963061,Q1752683,local:bollywood,Q11307326,Q194492,Q131578,Q213665,Q4942839,local:classic-disco,Q336567,Q474027,Q54365,Q25099840,Q85741139,Q132438,Q483251,Q7118426,Q876171,Q2913982,Q106528337,Q481900,local:balearic-house,Q65937774,Q2406633,local:euro-house,Q216961,Q820049,Q2748817,Q1521688,Q339906,Q223840,Q601235,Q105636940,local:leftfield-techno,Q3048168,Q438503,Q529742,local:chopped-n-screwed,Q19879476,Q16829781,Q141459,Q8560269,Q15697534,Q12362064,Q5421158,Q1045541,Q753679,Q255406,Q97265899,local:memphis,Q6918602,Q840065,local:rap,local:rnb",
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
