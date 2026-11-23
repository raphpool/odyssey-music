import { describe, expect, it } from "vitest";
import {
	type TranslationCandidate,
	type TranslationIssue,
	type TranslationSource,
	validateTranslation,
} from "../../src/translation/validate.js";

const SOURCE_P1 =
	"Marlow Quartet is the project of Elias Marlow, a composer born in Cornwall and raised in a small town " +
	"near the sea. His early records for Warp shaped the sound of ambient techno in the early nineties.";
const SOURCE_P2 =
	"Over the following decades he released a long series of albums, singles and strange side projects, " +
	"and he became known as much for his humour as for the complexity of his rhythms, which still influence " +
	"many producers today.";

const FRENCH_P1 =
	"Le Marlow Quartet est le projet du compositeur Elias Marlow, né en Cornouailles et élevé dans une " +
	"petite ville près de la mer. Ses premiers disques pour le label Warp ont façonné le son de la techno " +
	"ambient dans les années quatre-vingt-dix.";
const FRENCH_P2 =
	"Au fil des décennies, il a publié une longue série d'albums, de singles et de projets parallèles " +
	"étranges, et il est devenu aussi célèbre pour son humour que pour la complexité de ses rythmes, qui " +
	"influencent encore de nombreux producteurs.";

const SOURCE_TEASER =
	"A restless electronic project from Cornwall that turned ambient techno into a playground of strange " +
	"rhythms and warm melodies.";
const FRENCH_TEASER =
	"Un projet électronique agité de Cornouailles qui a transformé la techno ambient en terrain de jeu " +
	"pour des rythmes étranges et des mélodies chaleureuses.";

const FILLER = "Elle est dans le monde et le temps. ";

function makeSource(overrides: Partial<TranslationSource> = {}): TranslationSource {
	return {
		type: "artist",
		name: "Marlow Quartet",
		teaser: SOURCE_TEASER,
		article: `${SOURCE_P1}\n\n${SOURCE_P2}`,
		facts: { origin: "Cornwall, England", status: "Active since 1991" },
		properNouns: ["Marlow Quartet", "Elias Marlow", "Warp"],
		...overrides,
	};
}

function makeCandidate(overrides: Partial<TranslationCandidate> = {}): TranslationCandidate {
	return {
		teaser: FRENCH_TEASER,
		article: `${FRENCH_P1}\n\n${FRENCH_P2}`,
		facts: { origin: "Cornouailles, Angleterre", status: "Actif depuis 1991" },
		...overrides,
	};
}

/** Asserts the result is exactly one issue, with the expected code and field. */
function expectSingle(issues: TranslationIssue[], code: string, field: string): TranslationIssue {
	expect(issues.map((issue) => ({ code: issue.code, field: issue.field }))).toEqual([{ code, field }]);
	return issues[0] as TranslationIssue;
}

describe("validateTranslation", () => {
	describe("well-formed translation", () => {
		it("accepts a French two-paragraph article with teaser and facts", () => {
			expect(validateTranslation(makeSource(), makeCandidate())).toEqual([]);
		});

		it("is pure: same input gives the same output and inputs are left untouched", () => {
			const source = makeSource();
			const candidate = makeCandidate({ article: `${FRENCH_P1}\n\n${FRENCH_P2} ${FILLER.repeat(40)}` });
			const sourceBefore = structuredClone(source);
			const candidateBefore = structuredClone(candidate);
			const first = validateTranslation(source, candidate);
			expect(validateTranslation(source, candidate)).toEqual(first);
			expect(first.length).toBeGreaterThan(0);
			expect(source).toEqual(sourceBefore);
			expect(candidate).toEqual(candidateBefore);
		});
	});

	describe("rule 1: empty / too_short", () => {
		it("flags a blank teaser as empty, and only that", () => {
			expectSingle(validateTranslation(makeSource(), makeCandidate({ teaser: "  \n " })), "empty", "teaser");
		});

		it("flags an empty article as empty, and only that", () => {
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article: "" })), "empty", "article");
		});

		it("flags an article under 80 characters as too_short, and only that", () => {
			const source = makeSource({
				article: "The group formed in a small coastal town.\n\nThey toured Europe for years.",
			});
			const candidate = makeCandidate({
				article: "Le groupe est né dans une ville côtière.\n\nIl a tourné en Europe.",
			});
			expectSingle(validateTranslation(source, candidate), "too_short", "article");
		});
	});

	describe("rule 2: length_ratio", () => {
		it("flags an article that is too long", () => {
			const article = `${FRENCH_P1}\n\n${FRENCH_P2} ${FILLER.repeat(30)}`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article })), "length_ratio", "article");
		});

		it("flags an article that is too short relative to the source (but over 80 characters)", () => {
			const article =
				"Le Marlow Quartet est le projet d'un compositeur de Cornouailles.\n\n" +
				"Il a publié de nombreux albums et reste une référence pour les producteurs.";
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article })), "length_ratio", "article");
		});

		it("flags a teaser that is too long", () => {
			const teaser = `${FRENCH_TEASER} ${FILLER.repeat(8)}`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ teaser })), "length_ratio", "teaser");
		});

		it("flags a teaser that is too short", () => {
			const teaser = "Un projet électronique de Cornouailles, dans la techno.";
			expectSingle(validateTranslation(makeSource(), makeCandidate({ teaser })), "length_ratio", "teaser");
		});

		it("flags a fact longer than 3x the source + 20", () => {
			const facts = {
				origin: "Cornouailles, Angleterre",
				status: `Actif depuis ${"très longtemps ".repeat(6)}`,
			};
			expectSingle(
				validateTranslation(makeSource(), makeCandidate({ facts })),
				"length_ratio",
				"facts.status",
			);
		});

		it("accepts a fact exactly at the 3x + 20 bound", () => {
			const source = makeSource({ facts: { status: "Active" } }); // 6 chars -> bound is 38
			const ok = validateTranslation(source, makeCandidate({ facts: { status: "a".repeat(38) } }));
			const tooLong = validateTranslation(source, makeCandidate({ facts: { status: "a".repeat(39) } }));
			expect(ok).toEqual([]);
			expectSingle(tooLong, "length_ratio", "facts.status");
		});
	});

	describe("rule 3: paragraph_count", () => {
		it("flags an article with fewer paragraphs than the source", () => {
			const article = `${FRENCH_P1} ${FRENCH_P2}`;
			expectSingle(
				validateTranslation(makeSource(), makeCandidate({ article })),
				"paragraph_count",
				"article",
			);
		});

		it("flags an article with more paragraphs than the source", () => {
			const article = `${FRENCH_P1}\n\n${FRENCH_P2.replace(", et il", ".\n\nIl")}`;
			expectSingle(
				validateTranslation(makeSource(), makeCandidate({ article })),
				"paragraph_count",
				"article",
			);
		});

		it("counts several consecutive blank lines (even with spaces) as one separator", () => {
			const article = `${FRENCH_P1}\n \n\n${FRENCH_P2}`;
			expect(validateTranslation(makeSource(), makeCandidate({ article }))).toEqual([]);
		});

		it("flags a line break inside the teaser", () => {
			const teaser = FRENCH_TEASER.replace("en terrain", "\nen terrain");
			expectSingle(validateTranslation(makeSource(), makeCandidate({ teaser })), "paragraph_count", "teaser");
		});
	});

	describe("rule 4: not_french", () => {
		it("flags English text returned as-is (teaser and article)", () => {
			const candidate = makeCandidate({
				teaser: SOURCE_TEASER,
				article: `${SOURCE_P1}\n\n${SOURCE_P2}`,
			});
			const issues = validateTranslation(makeSource(), candidate);
			expect(issues.map((issue) => `${issue.code}:${issue.field}`)).toEqual([
				"not_french:teaser",
				"not_french:article",
			]);
		});

		it("flags an English-only article on its own", () => {
			const article = `${SOURCE_P1}\n\n${SOURCE_P2}`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article })), "not_french", "article");
		});

		const QUOTED_TITLES =
			"Au fil des décennies, il a publié {a}, {b} et {c}, et il est devenu aussi célèbre pour son humour " +
			"que pour la complexité de ses rythmes, qui influencent encore de nombreux producteurs.";
		const TITLES = [
			"The Sound of the Sea and the Wind",
			"Songs from the Heart of the City",
			"Dreams of the Past and the Future",
		] as const;
		const [titleA, titleB, titleC] = TITLES;

		it("ignores three English titles inside quotes (straight, curly and guillemets)", () => {
			const p2 = QUOTED_TITLES.replace("{a}", `« ${titleA} »`)
				.replace("{b}", `“${titleB}”`)
				.replace("{c}", `"${titleC}"`);
			expect(validateTranslation(makeSource(), makeCandidate({ article: `${FRENCH_P1}\n\n${p2}` }))).toEqual(
				[],
			);
		});

		it("control: the same sentence without quotes is flagged", () => {
			const p2 = QUOTED_TITLES.replace("{a}", titleA).replace("{b}", titleB).replace("{c}", titleC);
			expectSingle(
				validateTranslation(makeSource(), makeCandidate({ article: `${FRENCH_P1}\n\n${p2}` })),
				"not_french",
				"article",
			);
		});

		it("does not judge a teaser of 8 words", () => {
			const text = "Ambient techno pioneer from the rainy Cornish coast";
			const source = makeSource({ teaser: text });
			expect(validateTranslation(source, makeCandidate({ teaser: text }))).toEqual([]);
		});

		it("judges a teaser of 12 words but not one of 11", () => {
			const twelve = "Ambient techno pioneer from the rainy Cornish coast, with strange warm melodies";
			const eleven = "Ambient techno pioneer from the rainy Cornish coast, with strange melodies";
			expect(twelve.split(" ")).toHaveLength(12);
			expect(eleven.split(" ")).toHaveLength(11);
			expectSingle(
				validateTranslation(makeSource({ teaser: twelve }), makeCandidate({ teaser: twelve })),
				"not_french",
				"teaser",
			);
			expect(validateTranslation(makeSource({ teaser: eleven }), makeCandidate({ teaser: eleven }))).toEqual(
				[],
			);
		});
	});

	describe("detail", () => {
		it("never exceeds 120 characters, even for huge candidates", () => {
			const candidates: TranslationCandidate[] = [
				makeCandidate({ teaser: SOURCE_TEASER, article: `${SOURCE_P1}\n\n${SOURCE_P2}`.repeat(10) }),
				makeCandidate({ article: `${FRENCH_P1}\n\n${FRENCH_P2} ${FILLER.repeat(500)}` }),
				makeCandidate({ facts: { origin: "x".repeat(5000), status: "y" } }),
			];
			let checked = 0;
			for (const candidate of candidates) {
				for (const issue of validateTranslation(makeSource(), candidate)) {
					if (issue.detail !== undefined) {
						expect(issue.detail.length).toBeLessThanOrEqual(120);
						checked++;
					}
				}
			}
			expect(checked).toBeGreaterThan(0);
		});
	});
});
