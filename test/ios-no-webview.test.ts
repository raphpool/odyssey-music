import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appRoot = resolve("ios/Track1");

// Track1 renders API text natively: a web view would interpret markup that the API does not control.
const forbidden = [
	{
		label: "import WebKit",
		pattern: /\bimport\s+(?:(?:struct|class|enum|protocol|func|var|let|typealias)\s+)?WebKit\b/,
	},
	{
		label: "import SafariServices",
		pattern: /\bimport\s+(?:(?:struct|class|enum|protocol|func|var|let|typealias)\s+)?SafariServices\b/,
	},
	{ label: "WKWebView", pattern: /\bWKWebView\b/ },
	{ label: "SFSafariViewController", pattern: /\bSFSafariViewController\b/ },
] as const;

async function swiftFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				return swiftFiles(path);
			}
			return entry.isFile() && entry.name.endsWith(".swift") ? [path] : [];
		}),
	);
	return nested.flat().sort();
}

async function violationsIn(root: string) {
	const violations: string[] = [];
	for (const file of await swiftFiles(root)) {
		const source = await readFile(file, "utf8");
		for (const { label, pattern } of forbidden) {
			if (pattern.test(source)) {
				violations.push(`${relative(root, file)}: ${label}`);
			}
		}
	}
	return violations;
}

async function violationsInSource(source: string) {
	const directory = await mkdtemp(join(tmpdir(), "track1-no-webview-"));
	try {
		await writeFile(join(directory, "Sample.swift"), source);
		return await violationsIn(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("Track1 native text policy", () => {
	it("scans the real app sources", async () => {
		const files = (await swiftFiles(appRoot)).map((file) => relative(appRoot, file));
		expect(files).toContain("Features/Node/NodeArticleView.swift");
	});

	it("keeps WebKit, SafariServices and web view types out of the app", async () => {
		expect(await violationsIn(appRoot)).toEqual([]);
	});
});

describe("Track1 web view detector", () => {
	it.each([
		["import WebKit\n", "import WebKit"],
		["@preconcurrency import WebKit\n", "import WebKit"],
		["import struct WebKit.WKWebViewConfiguration\n", "import WebKit"],
		["import SafariServices\n", "import SafariServices"],
		["let view = WKWebView()\n", "WKWebView"],
		["let controller: SFSafariViewController? = nil\n", "SFSafariViewController"],
		["// WKWebView would run markup\n", "WKWebView"],
	])("flags %j", async (source, label) => {
		expect(await violationsInSource(source)).toContain(`Sample.swift: ${label}`);
	});

	it("does not flag unrelated frameworks", async () => {
		expect(await violationsInSource("import SwiftUI\nimport Foundation\nlet webKitten = 1\n")).toEqual([]);
	});
});
