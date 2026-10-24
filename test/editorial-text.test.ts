import { describe, expect, it } from "vitest";
import { normalizeEditorialText, unescapeQuotes } from "../src/editorial-text.js";

// TRA-458: Gemini sometimes double-escapes newlines in its JSON, so generated prose carries a
// literal backslash + "n" instead of a line break. These are the contract cases.
describe("normalizeEditorialText", () => {
	it("turns literal backslash-n sequences into real newlines", () => {
		expect(normalizeEditorialText("A\\n\\nB")).toBe("A\n\nB");
		expect(normalizeEditorialText("A\\nB")).toBe("A\nB");
	});

	it("turns literal backslash-r backslash-n into a single newline", () => {
		expect(normalizeEditorialText("A\\r\\nB")).toBe("A\nB");
	});

	it("turns real CRLF and CR into LF", () => {
		expect(normalizeEditorialText("A\r\nB\rC")).toBe("A\nB\nC");
	});

	it("collapses three or more newlines into two", () => {
		expect(normalizeEditorialText("A\n\n\n\nB")).toBe("A\n\nB");
		expect(normalizeEditorialText("A\\n\\n\\n\\nB")).toBe("A\n\nB");
	});

	it("strips trailing spaces on each line and trims the text", () => {
		expect(normalizeEditorialText("  A  \nB \t\n\nC   ")).toBe("A\nB\n\nC");
	});

	it("is idempotent, including when blank lines only hold spaces", () => {
		for (const input of ["A\\n\\nB", "A\r\n\r\n\r\nB", "A\n \n\nB", "  \\n A \\r\\n\\n\\n B  ", "a\\b"]) {
			const once = normalizeEditorialText(input);
			expect(normalizeEditorialText(once)).toBe(once);
		}
		expect(normalizeEditorialText("A\n \n\nB")).toBe("A\n\nB");
	});

	it("returns an empty string for an empty or whitespace-only input", () => {
		expect(normalizeEditorialText("")).toBe("");
		expect(normalizeEditorialText("  \\n  ")).toBe("");
	});

	it("leaves text without escapes unchanged", () => {
		const text = "A plain paragraph.\n\nAnother one, with punctuation: yes.";
		expect(normalizeEditorialText(text)).toBe(text);
	});

	it("keeps backslashes that do not start a newline escape", () => {
		expect(normalizeEditorialText("AC\\DC and a\\b")).toBe("AC\\DC and a\\b");
		expect(normalizeEditorialText("trailing\\")).toBe("trailing\\");
		expect(normalizeEditorialText("a\\tb")).toBe("a\\tb");
	});
});

// TRA-577: the same double escaping turns a quotation mark into backslash + quote. The cache held 19
// articles printing `\"Seaqz\"`.
describe("normalizeEditorialText: literal escaped quotes", () => {
	it("turns a literal backslash-quote into a quote", () => {
		expect(normalizeEditorialText('Its \\"frenetic romp\\" is loud.')).toBe('Its "frenetic romp" is loud.');
	});

	it("handles quote escapes and newline escapes in the same text", () => {
		expect(normalizeEditorialText('\\"A\\"\\n\\n\\"B\\"')).toBe('"A"\n\n"B"');
	});

	it("leaves a clean quotation untouched", () => {
		const text = 'Tracks like "Foil" and "Montreal" stand out; the duo\'s "frenetic romp".';
		expect(normalizeEditorialText(text)).toBe(text);
	});

	it("keeps a backslash that is not followed by a quote", () => {
		const text = 'AC\\DC played "Back in Black" at C:\\temp\\';
		expect(normalizeEditorialText(text)).toBe(text);
	});

	it("keeps an escaped backslash before a quote (an even run is content)", () => {
		const text = 'path C:\\dir\\\\"x"';
		expect(normalizeEditorialText(text)).toBe(text);
	});

	it("drops only the last backslash of an odd run", () => {
		expect(normalizeEditorialText('a \\\\\\"b')).toBe('a \\\\"b');
	});

	it("keeps a quote escape inside a fenced code block", () => {
		const text = 'Outside \\"x\\".\n```\nprintf(\\"hi\\")\n```\nAfter \\"y\\".';
		expect(normalizeEditorialText(text)).toBe('Outside "x".\n```\nprintf(\\"hi\\")\n```\nAfter "y".');
	});

	it("is idempotent on texts holding quote escapes", () => {
		for (const input of ['\\"A\\"', 'a \\\\\\"b', '\\\\"c"', 'x \\\\\\\\\\"y']) {
			const once = normalizeEditorialText(input);
			expect(normalizeEditorialText(once)).toBe(once);
		}
	});
});

describe("unescapeQuotes", () => {
	it("returns the same text when there is nothing to do", () => {
		expect(unescapeQuotes('He said "no" and left.')).toBe('He said "no" and left.');
		expect(unescapeQuotes("")).toBe("");
	});

	it("changes nothing but the escaping backslash (no trim, no newline handling)", () => {
		expect(unescapeQuotes('  \\"a\\"  \\n\n\n\n')).toBe('  "a"  \\n\n\n\n');
	});
});
