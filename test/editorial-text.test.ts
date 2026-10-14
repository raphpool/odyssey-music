import { describe, expect, it } from "vitest";
import { normalizeEditorialText } from "../src/editorial-text.js";

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
