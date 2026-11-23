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

	describe("rule 5: markup", () => {
		it("flags a code fence", () => {
			const article = `\`\`\`\n${FRENCH_P1}\n\n${FRENCH_P2}`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article })), "markup", "article");
		});

		it("flags a markdown heading at the start of a line", () => {
			const article = `${FRENCH_P1}\n\n# ${FRENCH_P2}`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article })), "markup", "article");
		});

		it("flags ** and __ that the source does not have", () => {
			const bold = `**Le Marlow Quartet** ${FRENCH_P1.slice("Le Marlow Quartet ".length)}\n\n${FRENCH_P2}`;
			const under = `__${FRENCH_P1}__\n\n${FRENCH_P2}`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article: bold })), "markup", "article");
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article: under })), "markup", "article");
		});

		it("flags markup in the teaser", () => {
			const teaser = `**${FRENCH_TEASER}**`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ teaser })), "markup", "teaser");
		});

		it("accepts ** when the source field already contains it", () => {
			const source = makeSource({ article: `**${SOURCE_P1}**\n\n${SOURCE_P2}` });
			const candidate = makeCandidate({ article: `**${FRENCH_P1}**\n\n${FRENCH_P2}` });
			expect(validateTranslation(source, candidate)).toEqual([]);
		});
	});

	describe("rule 6: escape_leftover", () => {
		it("flags a literal backslash-n", () => {
			const article = `${FRENCH_P1.replace("mer. Ses", "mer.\\nSes")}\n\n${FRENCH_P2}`;
			expect(article).toContain("\\n");
			expectSingle(
				validateTranslation(makeSource(), makeCandidate({ article })),
				"escape_leftover",
				"article",
			);
		});

		it("flags a literal backslash-quote", () => {
			const teaser = FRENCH_TEASER.replace("la techno", 'la \\"techno\\"');
			expectSingle(validateTranslation(makeSource(), makeCandidate({ teaser })), "escape_leftover", "teaser");
		});

		it("does not flag a real line break", () => {
			expect(validateTranslation(makeSource(), makeCandidate())).toEqual([]);
		});
	});

	describe("rule 7: url_added", () => {
		it("flags a URL absent from the source field", () => {
			const article = `${FRENCH_P1}\n\n${FRENCH_P2} (https://example.com/marlow)`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article })), "url_added", "article");
		});

		it("accepts a URL that the source field already contains, ignoring trailing punctuation", () => {
			const source = makeSource({ article: `${SOURCE_P1}\n\n${SOURCE_P2} See https://example.com/marlow` });
			const candidate = makeCandidate({
				article: `${FRENCH_P1}\n\n${FRENCH_P2} Voir https://example.com/marlow.`,
			});
			expect(validateTranslation(source, candidate)).toEqual([]);
		});

		it("judges the URL against the same field only", () => {
			const source = makeSource({ teaser: `${SOURCE_TEASER} https://example.com/marlow` });
			const candidate = makeCandidate({ article: `${FRENCH_P1}\n\n${FRENCH_P2} https://example.com/marlow` });
			expectSingle(validateTranslation(source, candidate), "url_added", "article");
		});

		it("flags a URL smuggled into a fact", () => {
			const facts = { origin: "Cornouailles, Angleterre", status: "http://evil.test/x" };
			expectSingle(validateTranslation(makeSource(), makeCandidate({ facts })), "url_added", "facts.status");
		});
	});

	describe("rule 8: fact_keys", () => {
		it("accepts a source without facts and a candidate without facts", () => {
			const candidate = makeCandidate();
			delete candidate.facts;
			expect(validateTranslation(makeSource({ facts: {} }), candidate)).toEqual([]);
		});

		it("treats an absent candidate.facts as {} (every source fact is missing)", () => {
			const candidate = makeCandidate();
			delete candidate.facts;
			const issues = validateTranslation(makeSource(), candidate);
			expect(issues.map((issue) => `${issue.code}:${issue.field}`)).toEqual([
				"fact_keys:facts.origin",
				"fact_keys:facts.status",
			]);
		});

		it("flags a missing fact", () => {
			const facts = { origin: "Cornouailles, Angleterre" };
			expectSingle(validateTranslation(makeSource(), makeCandidate({ facts })), "fact_keys", "facts.status");
		});

		it("flags an extra fact", () => {
			const facts = { origin: "Cornouailles, Angleterre", status: "Actif depuis 1991", label: "Warp" };
			expectSingle(validateTranslation(makeSource(), makeCandidate({ facts })), "fact_keys", "facts.label");
		});

		it("flags an extra fact when the source has none", () => {
			const issues = validateTranslation(
				makeSource({ facts: {} }),
				makeCandidate({ facts: { label: "Warp" } }),
			);
			expectSingle(issues, "fact_keys", "facts.label");
		});

		it("flags an empty or blank fact value", () => {
			const facts = { origin: "Cornouailles, Angleterre", status: "  " };
			expectSingle(validateTranslation(makeSource(), makeCandidate({ facts })), "fact_keys", "facts.status");
		});

		it("does not confuse inherited object properties with facts", () => {
			const source = makeSource({ facts: { constructor: "Cornwall" } });
			const missing = validateTranslation(source, makeCandidate({ facts: {} }));
			expectSingle(missing, "fact_keys", "facts.constructor");
		});
	});

	describe("review findings (self-review, TRA-803)", () => {
		it("returns issues instead of throwing when the model output has the wrong runtime shape", () => {
			const broken = {
				teaser: undefined,
				article: 42,
				facts: { origin: 1991, status: null },
			} as unknown as TranslationCandidate;
			const issues = validateTranslation(makeSource(), broken);
			expect(issues.map((issue) => `${issue.code}:${issue.field}`)).toEqual([
				"empty:teaser",
				"empty:article",
				"fact_keys:facts.origin",
				"fact_keys:facts.status",
			]);
		});

		it("treats a non-object facts value as absent", () => {
			const broken = { ...makeCandidate(), facts: "oops" } as unknown as TranslationCandidate;
			expect(validateTranslation(makeSource({ facts: {} }), broken)).toEqual([]);
		});

		it("accepts a leading # that the source field also carries (e.g. a chart position)", () => {
			const source = makeSource({ facts: { peak: "#1 in the UK" } });
			const kept = validateTranslation(source, makeCandidate({ facts: { peak: "#1 au Royaume-Uni" } }));
			const invented = validateTranslation(
				makeSource({ facts: { peak: "number one in the UK" } }),
				makeCandidate({ facts: { peak: "#1 au Royaume-Uni" } }),
			);
			expect(kept).toEqual([]);
			expectSingle(invented, "markup", "facts.peak");
		});

		it("detects URLs whatever the case of the scheme", () => {
			const article = `${FRENCH_P1}\n\n${FRENCH_P2} HTTPS://evil.test/x`;
			expectSingle(validateTranslation(makeSource(), makeCandidate({ article })), "url_added", "article");
		});
	});

	describe("detail", () => {
		it("never exceeds 120 characters, even for huge offending excerpts", () => {
			const longUrl = `https://example.com/${"a".repeat(2000)}`;
			const longKey = "k".repeat(2000);
			const candidates: TranslationCandidate[] = [
				makeCandidate({ article: `${FRENCH_P1}\n\n${FRENCH_P2} ${longUrl}` }),
				makeCandidate({ article: `${"#".repeat(500)} ${FRENCH_P1}\n\n${FRENCH_P2}` }),
				makeCandidate({ article: `${FRENCH_P1}\n\n${FRENCH_P2} ${"\\n".repeat(500)}` }),
				makeCandidate({ facts: { origin: "x", status: "y", [longKey]: "z" } }),
				makeCandidate({ teaser: SOURCE_TEASER, article: `${SOURCE_P1}\n\n${SOURCE_P2}`.repeat(10) }),
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
