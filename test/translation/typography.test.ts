import { describe, expect, it } from "vitest";
import { normalizeEditorialText } from "../../src/editorial-text.js";
import { normalizeFrenchText } from "../../src/translation/typography.js";

const NBSP = " ";

describe("normalizeFrenchText", () => {
	it("puts a no-break space after « and before » and before : and ?", () => {
		expect(normalizeFrenchText("« Idioteque » sort en 2000 : un tournant ?")).toBe(
			`«${NBSP}Idioteque${NBSP}» sort en 2000${NBSP}: un tournant${NBSP}?`,
		);
	});

	it("adds the space inside the guillemets when there is none", () => {
		expect(normalizeFrenchText("«Idioteque» sort")).toBe(`«${NBSP}Idioteque${NBSP}» sort`);
	});

	it("promotes the space before ; and !", () => {
		expect(normalizeFrenchText("Oui ; non ! Peut-être")).toBe(`Oui${NBSP}; non${NBSP}! Peut-être`);
	});

	it("never adds a space before : ; ! ?", () => {
		expect(normalizeFrenchText("Quoi? Oui! Bien; ok: fin")).toBe("Quoi? Oui! Bien; ok: fin");
	});

	it("does not touch a URL, a time or an inch mark", () => {
		for (const text of ["https://example.com", "12:30", '12" vinyl', 'un "disque" de 12" vinyl']) {
			expect(normalizeFrenchText(text)).toBe(text);
		}
	});

	it("does not convert straight quotes into guillemets", () => {
		expect(normalizeFrenchText('Le "titre" du 12"')).toBe('Le "titre" du 12"');
	});

	it("leaves other characters alone, including other spaces and line breaks", () => {
		expect(normalizeFrenchText("a  b\n\nc d")).toBe("a  b\n\nc d");
		expect(normalizeFrenchText("a  : b")).toBe(`a ${NBSP}: b`);
	});

	it("does not move a guillemet at the start of a line or already spaced", () => {
		expect(normalizeFrenchText(`Il dit :\n« Salut »`)).toBe(`Il dit${NBSP}:\n«${NBSP}Salut${NBSP}»`);
		expect(normalizeFrenchText(`«${NBSP}a${NBSP}»`)).toBe(`«${NBSP}a${NBSP}»`);
	});

	it("applies normalizeEditorialText first", () => {
		const raw = "Un \\n« titre »  \r\n\r\n\r\n\r\nFin ?  ";
		expect(normalizeFrenchText(raw)).toBe(
			normalizeEditorialText(raw)
				.replace(/« /g, `«${NBSP}`)
				.replace(/ »/g, `${NBSP}»`)
				.replace(/ \?/g, `${NBSP}?`),
		);
		expect(normalizeFrenchText(raw)).not.toContain("\\n");
	});

	it("is idempotent", () => {
		const cases = [
			"« Idioteque » sort en 2000 : un tournant ?",
			"«Idioteque» sort",
			"Oui ; non ! Peut-être",
			'https://example.com 12:30 12" vinyl',
			"a  : b",
			"«  a  »",
			"«»",
			"« »",
			"Il dit :\n« Salut »\n\n\n\nFin ?",
			"Un \\n« titre »  \r\n",
			"",
		];
		for (const text of cases) {
			const once = normalizeFrenchText(text);
			expect(normalizeFrenchText(once), JSON.stringify(text)).toBe(once);
		}
	});
});
