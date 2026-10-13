import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// The app and the sources of the package it links: code moved to Track1Core must keep the policy (TRA-425).
// The package tests (ios/Track1Core/Tests) are not listed: TRA-425 scopes this policy to the sources.
const scannedRoots = ["ios/Track1", "ios/Track1Core/Sources"] as const;

// Same exclusions as `filesUnder` in native-ci-triggers.test.ts, plus the SwiftPM editor state.
const skippedDirectories = new Set([".build", ".swiftpm", "DerivedData", "SourcePackages"]);

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
				return skippedDirectories.has(entry.name) ? [] : swiftFiles(path);
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

/** Scans every policy root of a repository layout; paths are reported from that repository's root. */
async function violationsInRepository(repository: string) {
	const violations: string[] = [];
	for (const root of scannedRoots) {
		const found = await violationsIn(join(repository, root));
		violations.push(...found.map((violation) => `${root}/${violation}`));
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
		const files = (await swiftFiles("ios/Track1")).map((file) => relative("ios/Track1", file));
		expect(files).toContain("Features/Node/NodeArticleView.swift");
	});

	it("scans the real Track1Core sources", async () => {
		const files = (await swiftFiles("ios/Track1Core/Sources")).map((file) =>
			relative("ios/Track1Core/Sources", file),
		);
		expect(files).toContain("Track1Core/API/URLValidation.swift");
	});

	it("keeps WebKit, SafariServices and web view types out of the app and the package", async () => {
		expect(await violationsInRepository(".")).toEqual([]);
	});

	it("flags a web view in a Track1Core source file, and ignores a build folder", async () => {
		const repository = await mkdtemp(join(tmpdir(), "track1-no-webview-core-"));
		try {
			const sources = join(repository, "ios/Track1Core/Sources/Track1Core");
			await mkdir(join(repository, "ios/Track1"), { recursive: true });
			await mkdir(join(sources, ".build"), { recursive: true });
			await writeFile(join(sources, "Fake.swift"), "import WebKit\n");
			await writeFile(join(sources, ".build/Ignored.swift"), "import WebKit\n");
			expect(await violationsInRepository(repository)).toEqual([
				"ios/Track1Core/Sources/Track1Core/Fake.swift: import WebKit",
			]);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
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
