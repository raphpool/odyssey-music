import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// TRA-425 (plan ios-check-swift-package, D3 and D6): ios/Track1Core is tested by `swift test` on macOS, with
// no simulator. These guards keep it that way. Each one takes the root of a repository layout, so the same
// code reads the real repository and a temporary fixture that must be flagged.
const REAL_REPOSITORY = ".";

const CORE = "ios/Track1Core";
const CORE_TESTS = "ios/Track1Core/Tests";
const APP_TEST_ROOTS = ["ios/Track1Tests", "ios/Track1UITests"] as const;
const MANIFEST = "ios/Track1Core/Package.swift";

// Same exclusions as `filesUnder` in native-ci-triggers.test.ts, plus the SwiftPM editor state.
const SKIPPED_DIRECTORIES = new Set([".build", ".swiftpm", "DerivedData", "SourcePackages"]);

async function swiftFilesUnder(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : swiftFilesUnder(path);
			return entry.isFile() && entry.name.endsWith(".swift") ? [path] : [];
		}),
	);
	return nested.flat().sort();
}

/** Returns `file: label` for every file under `directories` (relative to `repository`) matching a rule. */
async function violationsUnder(
	repository: string,
	directories: readonly string[],
	rules: ReadonlyArray<{ label: string; pattern: RegExp }>,
): Promise<string[]> {
	const violations: string[] = [];
	for (const directory of directories) {
		for (const file of await swiftFilesUnder(join(repository, directory))) {
			const source = await readFile(file, "utf8");
			for (const { label, pattern } of rules) {
				if (pattern.test(source)) violations.push(`${relative(repository, file)}: ${label}`);
			}
		}
	}
	return violations;
}

// (a) The package is pure logic with no platform UI surface: UIKit does not exist on macOS and the Segment SDK
// belongs to the app, and SwiftUI is kept out as a policy choice (it would tie the logic to a view layer
// and slow `swift test`). Even a guarded `#if canImport(UIKit)` import is refused. The import is matched at the start of a line, so a comment that
// merely mentions a framework is fine, while `@preconcurrency import` and `import struct UIKit.UIColor` are not.
const forbiddenCoreImports = ["SwiftUI", "UIKit", "Segment"].map((framework) => ({
	label: `import ${framework}`,
	pattern: new RegExp(
		`^[ \\t]*(?:@\\w+[ \\t]+)*import[ \\t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \\t]+)?${framework}\\b`,
		"m",
	),
}));

const coreImportViolations = (repository: string) =>
	violationsUnder(repository, [CORE], forbiddenCoreImports);

// (b) `swift test` runs on macOS: a test under one of these conditions would vanish from the run without any
// error. Compound conditions (`os(iOS) || os(macOS)`) are refused too, so the rule stays easy to state; a
// negated condition (`!os(iOS)`) does run on macOS and is let through. Other conditions that are false on
// macOS (`os(Linux)`, `canImport(UIKit)`) are not modelled: the ticket names these two.
const platformConditions = [
	{
		label: "#if targetEnvironment(simulator)",
		pattern: /^[ \t]*#(?:if|elseif)\b[^\n]*(?<!!\s*)\btargetEnvironment\(\s*simulator\s*\)/m,
	},
	{ label: "#if os(iOS)", pattern: /^[ \t]*#(?:if|elseif)\b[^\n]*(?<!!\s*)\bos\(\s*iOS\s*\)/m },
] as const;

const platformConditionViolations = (repository: string) =>
	violationsUnder(repository, [CORE_TESTS], platformConditions);

// (c) The app must not rely on Xcode granting `@testable` access to a SwiftPM dependency: Track1Core is tested
// by its own test target, and the app tests go through its public API.
const testableCoreImport = [
	{
		label: "@testable import Track1Core",
		pattern:
			/^[ \t]*(?:@(?!testable\b)\w+[ \t]+)*@testable[ \t]+(?:@\w+[ \t]+)*import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?Track1Core\b/m,
	},
] as const;

const testableImportViolations = (repository: string) =>
	violationsUnder(repository, APP_TEST_ROOTS, testableCoreImport);

// (d) The manifest keeps the toolchain and the two platforms. Comments are dropped before the platform check
// so that a note mentioning `.macOS(.v14)` cannot stand in for the declaration itself; string literals are
// skipped over first, so a `//` inside a URL does not eat the rest of its line.
const toolsVersion = /^\/\/ swift-tools-version: 6\.0[ \t]*$/m;
const platformRequirements = [
	{ label: ".iOS(.v17)", pattern: /\.iOS\(\s*\.v17\s*\)/ },
	{ label: ".macOS(.v14)", pattern: /\.macOS\(\s*\.v14\s*\)/ },
] as const;

const withoutSwiftComments = (source: string): string =>
	source.replace(/"(?:\\.|[^"\\\n])*"|\/\/.*$|\/\*[\s\S]*?\*\//gm, (token) =>
		token.startsWith('"') ? token : "",
	);

async function manifestProblems(repository: string): Promise<string[]> {
	const source = (await readFile(join(repository, MANIFEST), "utf8")).replaceAll("\r\n", "\n");
	const code = withoutSwiftComments(source);
	const missing: string[] = platformRequirements
		.filter(({ pattern }) => !pattern.test(code))
		.map(({ label }) => label);
	if (!toolsVersion.test(source)) missing.unshift("swift-tools-version: 6.0");
	return missing.map((label) => `${MANIFEST}: missing ${label}`);
}

/** Builds a temporary repository layout from `{ path: contents }`, runs `inspect` on it, then removes it. */
async function withFixture<T>(files: Record<string, string>, inspect: (root: string) => Promise<T>) {
	const root = await mkdtemp(join(tmpdir(), "track1-core-package-"));
	try {
		for (const [path, contents] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), contents);
		}
		return await inspect(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const VALID_MANIFEST = [
	"// swift-tools-version: 6.0",
	"import PackageDescription",
	'let package = Package(name: "Track1Core", platforms: [.iOS(.v17), .macOS(.v14)])',
	"",
].join("\n");

describe("Track1Core imports (guard a)", () => {
	it("holds on the real package, which has sources to scan", async () => {
		const files = (await swiftFilesUnder(join(REAL_REPOSITORY, CORE))).map((file) => relative(CORE, file));
		expect(files).toContain("Sources/Track1Core/API/URLValidation.swift");
		expect(await coreImportViolations(REAL_REPOSITORY)).toEqual([]);
	});

	it("flags import SwiftUI in a source file", async () => {
		const violations = await withFixture(
			{ [`${CORE}/Sources/Track1Core/Fake.swift`]: "import Foundation\nimport SwiftUI\n" },
			coreImportViolations,
		);
		expect(violations).toEqual([`${CORE}/Sources/Track1Core/Fake.swift: import SwiftUI`]);
	});

	it.each([
		["import UIKit\n", "import UIKit"],
		["  @preconcurrency import Segment\n", "import Segment"],
		["import struct UIKit.UIColor\n", "import UIKit"],
		["#if canImport(UIKit)\nimport UIKit\n#endif\n", "import UIKit"],
	])("flags %j", async (source, label) => {
		const violations = await withFixture(
			{ [`${CORE}/Tests/Track1CoreTests/Fake.swift`]: source },
			coreImportViolations,
		);
		expect(violations).toEqual([`${CORE}/Tests/Track1CoreTests/Fake.swift: ${label}`]);
	});

	it("ignores mentions in comments, other modules and build folders", async () => {
		const violations = await withFixture(
			{
				[`${CORE}/Sources/Track1Core/Fine.swift`]:
					"import Foundation\n// import SwiftUI would break swift test\nlet SegmentCount = 1\nimport SegmentedControl\n",
				[`${CORE}/.build/checkouts/Dependency/Bad.swift`]: "import UIKit\n",
			},
			coreImportViolations,
		);
		expect(violations).toEqual([]);
	});
});

describe("Track1Core test conditions (guard b)", () => {
	it("holds on the real package tests, which exist", async () => {
		const files = (await swiftFilesUnder(join(REAL_REPOSITORY, CORE_TESTS))).map((file) =>
			relative(CORE_TESTS, file),
		);
		expect(files).toContain("Track1CoreTests/API/URLValidationTests.swift");
		expect(await platformConditionViolations(REAL_REPOSITORY)).toEqual([]);
	});

	it("flags #if os(iOS) in a package test", async () => {
		const violations = await withFixture(
			{
				[`${CORE_TESTS}/Track1CoreTests/FakeTests.swift`]: "#if os(iOS)\nfinal class FakeTests {}\n#endif\n",
			},
			platformConditionViolations,
		);
		expect(violations).toEqual([`${CORE_TESTS}/Track1CoreTests/FakeTests.swift: #if os(iOS)`]);
	});

	it.each([
		["#if targetEnvironment(simulator)\n#endif\n", "#if targetEnvironment(simulator)"],
		["#if targetEnvironment( simulator )\n#endif\n", "#if targetEnvironment(simulator)"],
		["#if os(macOS)\n#elseif os(iOS)\n#endif\n", "#if os(iOS)"],
		["#if canImport(Foundation) && os(iOS)\n#endif\n", "#if os(iOS)"],
	])("flags %j", async (source, label) => {
		const violations = await withFixture(
			{ [`${CORE_TESTS}/Track1CoreTests/FakeTests.swift`]: source },
			platformConditionViolations,
		);
		expect(violations).toEqual([`${CORE_TESTS}/Track1CoreTests/FakeTests.swift: ${label}`]);
	});

	it("only looks at the package tests, and lets other conditions through", async () => {
		const violations = await withFixture(
			{
				[`${CORE}/Sources/Track1Core/Platform.swift`]: "#if os(iOS)\n#endif\n",
				[`${CORE_TESTS}/Track1CoreTests/FineTests.swift`]:
					"#if os(macOS)\n#endif\n#if DEBUG\n#endif\n#if !os(iOS)\n#endif\n#if !targetEnvironment(simulator)\n#endif\n",
			},
			platformConditionViolations,
		);
		expect(violations).toEqual([]);
	});
});

describe("app tests and Track1Core (guard c)", () => {
	it("holds on the real app tests, which exist", async () => {
		for (const root of APP_TEST_ROOTS) {
			expect((await swiftFilesUnder(join(REAL_REPOSITORY, root))).length, root).toBeGreaterThan(0);
		}
		expect(await testableImportViolations(REAL_REPOSITORY)).toEqual([]);
	});

	it("flags @testable import Track1Core in Track1Tests", async () => {
		const violations = await withFixture(
			{
				"ios/Track1Tests/FakeTests.swift": "import XCTest\n@testable import Track1Core\n",
				// A missing root makes the guard throw instead of passing silently, so the fixture has both.
				"ios/Track1UITests/.keep": "",
			},
			testableImportViolations,
		);
		expect(violations).toEqual(["ios/Track1Tests/FakeTests.swift: @testable import Track1Core"]);
	});

	it("flags it in Track1UITests too, but not the app module or a plain import", async () => {
		const violations = await withFixture(
			{
				"ios/Track1Tests/Fine.swift": "@testable import Track1\nimport Track1Core\n",
				"ios/Track1UITests/FakeUITests.swift": "@preconcurrency @testable import Track1Core\n",
				"ios/Track1UITests/KindTests.swift": "@testable import struct Track1Core.URLValidation\n",
				"ios/Track1UITests/CommentTests.swift": "// never write @testable import Track1Core here\n",
			},
			testableImportViolations,
		);
		expect(violations).toEqual([
			"ios/Track1UITests/FakeUITests.swift: @testable import Track1Core",
			"ios/Track1UITests/KindTests.swift: @testable import Track1Core",
		]);
	});
});

describe("Track1Core manifest (guard d)", () => {
	it("holds on the real manifest", async () => {
		expect(await manifestProblems(REAL_REPOSITORY)).toEqual([]);
	});

	it("accepts a manifest with the tools version and both platforms", async () => {
		expect(await withFixture({ [MANIFEST]: VALID_MANIFEST }, manifestProblems)).toEqual([]);
	});

	it("flags a manifest without .macOS(.v14)", async () => {
		const manifest = VALID_MANIFEST.replace(", .macOS(.v14)", "");
		expect(await withFixture({ [MANIFEST]: manifest }, manifestProblems)).toEqual([
			`${MANIFEST}: missing .macOS(.v14)`,
		]);
	});

	it("keeps a declaration that follows a URL on its line, and ignores a block comment", async () => {
		const kept = VALID_MANIFEST.replace("let package", 'let source = "https://example.com" ; let package');
		expect(await withFixture({ [MANIFEST]: kept }, manifestProblems)).toEqual([]);
		const commented = VALID_MANIFEST.replace(", .macOS(.v14)", "").replace(
			"let package",
			"/* platforms: [.iOS(.v17), .macOS(.v14)] */ let package",
		);
		expect(await withFixture({ [MANIFEST]: commented }, manifestProblems)).toEqual([
			`${MANIFEST}: missing .macOS(.v14)`,
		]);
	});

	it("does not take a comment for the declaration", async () => {
		const manifest = VALID_MANIFEST.replace(", .macOS(.v14)", "\n// platforms: [.iOS(.v17), .macOS(.v14)]");
		expect(await withFixture({ [MANIFEST]: manifest }, manifestProblems)).toEqual([
			`${MANIFEST}: missing .macOS(.v14)`,
		]);
	});

	it.each([
		["a different macOS version", VALID_MANIFEST.replace(".macOS(.v14)", ".macOS(.v13)"), ".macOS(.v14)"],
		["a different iOS version", VALID_MANIFEST.replace(".iOS(.v17)", ".iOS(.v16)"), ".iOS(.v17)"],
		["an older tools version", VALID_MANIFEST.replace("6.0", "5.9"), "swift-tools-version: 6.0"],
	])("flags %s", async (_name, manifest, missing) => {
		expect(await withFixture({ [MANIFEST]: manifest }, manifestProblems)).toEqual([
			`${MANIFEST}: missing ${missing}`,
		]);
	});
});
