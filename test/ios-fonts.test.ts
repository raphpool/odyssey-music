import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// TRA-384 / TRA-724: the seven embedded fonts are the only ones the app ships, and each one is the exact
// file that the README documents (source, version, SHA-256). A swapped or added font fails here, not in a
// review.
const fontsDirectory = "ios/Track1/Resources/Fonts";
const infoPlist = "ios/Track1/Resources/Info.plist";
const typography = "ios/Track1/DesignSystem/Track1Typography.swift";

interface DocumentedFont {
	readonly file: string;
	readonly postScriptName: string;
	readonly sha256: string;
}

async function documentedFonts(): Promise<DocumentedFont[]> {
	const readme = await readFile(join(fontsDirectory, "README.md"), "utf8");
	const row = /^\| `([^`]+\.ttf)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm;
	return [...readme.matchAll(row)].map((match) => ({
		file: match[1] ?? "",
		postScriptName: match[2] ?? "",
		sha256: match[3] ?? "",
	}));
}

/** Reads the PostScript name (name ID 6) from the `name` table of a TrueType file. */
function postScriptName(font: Buffer): string | undefined {
	const tableCount = font.readUInt16BE(4);
	for (let index = 0; index < tableCount; index += 1) {
		const record = 12 + index * 16;
		if (font.toString("latin1", record, record + 4) !== "name") continue;
		const table = font.readUInt32BE(record + 8);
		const recordCount = font.readUInt16BE(table + 2);
		const strings = table + font.readUInt16BE(table + 4);
		for (let nameIndex = 0; nameIndex < recordCount; nameIndex += 1) {
			const name = table + 6 + nameIndex * 12;
			if (font.readUInt16BE(name + 6) !== 6) continue;
			const start = strings + font.readUInt16BE(name + 10);
			const bytes = font.subarray(start, start + font.readUInt16BE(name + 8));
			const platform = font.readUInt16BE(name);
			return platform === 0 || platform === 3
				? Buffer.from(bytes).swap16().toString("utf16le")
				: bytes.toString("latin1");
		}
	}
	return undefined;
}

describe("embedded fonts (TRA-384, TRA-724)", () => {
	it("ships exactly the seven documented TTF files and no other font", async () => {
		const documented = (await documentedFonts()).map((font) => font.file).sort();
		const shipped = (await readdir(fontsDirectory))
			.filter((name) => /\.(ttf|otf|ttc|woff2?)$/i.test(name))
			.sort();
		expect(documented).toHaveLength(7);
		expect(shipped).toEqual(documented);
	});

	it("matches the SHA-256 of every committed file with the README", async () => {
		for (const font of await documentedFonts()) {
			const bytes = await readFile(join(fontsDirectory, font.file));
			expect(createHash("sha256").update(bytes).digest("hex"), font.file).toBe(font.sha256);
		}
	});

	it("documents the PostScript name that the file really carries", async () => {
		for (const font of await documentedFonts()) {
			const bytes = await readFile(join(fontsDirectory, font.file));
			expect(postScriptName(bytes), font.file).toBe(font.postScriptName);
		}
	});

	it("registers the seven files in UIAppFonts", async () => {
		const plist = await readFile(infoPlist, "utf8");
		const block = /<key>UIAppFonts<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "";
		const registered = [...block.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]).sort();
		expect(registered).toEqual((await documentedFonts()).map((font) => font.file).sort());
	});

	it("uses the documented PostScript names as the raw values of Track1FontFace", async () => {
		const source = await readFile(typography, "utf8");
		const body = /enum Track1FontFace[^{]*\{([\s\S]*?)\n\t?\}/.exec(source)?.[1] ?? "";
		const rawValues = [...body.matchAll(/case \w+ = "([^"]+)"/g)].map((match) => match[1]).sort();
		expect(rawValues).toEqual((await documentedFonts()).map((font) => font.postScriptName).sort());
	});
});
