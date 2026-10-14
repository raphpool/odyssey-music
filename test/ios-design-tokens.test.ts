import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// TRA-409 (L.2, D4bis): the screens speak the Nocturne design system. A color, a font or a spacing that a
// screen needs is a token or a component in `ios/Track1/DesignSystem/`, which this policy does not scan.
// `ios/Track1/DesignSystem/` is also where the art-direction colors live (AmbientGlow, WelcomeBackdrop,
// NodeHero), so screens never need a raw color of their own.
const scannedRoots = ["ios/Track1/Features", "ios/Track1/App"] as const;

const skippedDirectories = new Set([".build", ".swiftpm", "DerivedData", "SourcePackages"]);

const dynamicTypeStyles =
	"largeTitle|title|title2|title3|headline|body|callout|subheadline|footnote|caption|caption2";

const forbidden = [
	{ label: "raw color", pattern: /\b(?:Color\(red:|Color\(\.sRGB|Color\(hex|UIColor\(red:)/ },
	{ label: "system font", pattern: /(?:\.font\(\s*\.system|\bFont\.system\()/ },
	{
		label: "dynamic type font",
		pattern: new RegExp(`\\.font\\(\\s*\\.(?:${dynamicTypeStyles})\\b`),
	},
	{ label: "Track1Theme", pattern: /\bTrack1Theme\b/ },
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

/** One entry per forbidden pattern found in `source`, as `line N: label`, in line order. */
function violationsInSource(source: string): string[] {
	const found: string[] = [];
	source.split("\n").forEach((line, index) => {
		for (const { label, pattern } of forbidden) {
			if (pattern.test(line)) {
				found.push(`line ${index + 1}: ${label}`);
			}
		}
	});
	return found;
}

/** Scans every policy root of a repository layout; paths are reported from that repository's root. */
async function violationsInRepository(repository: string) {
	const violations: string[] = [];
	for (const root of scannedRoots) {
		for (const file of await swiftFiles(join(repository, root))) {
			const path = relative(repository, file);
			for (const violation of violationsInSource(await readFile(file, "utf8"))) {
				violations.push(`${path}: ${violation}`);
			}
		}
	}
	return violations;
}

describe("Track1 design tokens policy", () => {
	it("scans the real screens and the app shell", async () => {
		const files = [...(await swiftFiles("ios/Track1/Features")), ...(await swiftFiles("ios/Track1/App"))].map(
			(file) => relative("ios/Track1", file),
		);
		expect(files).toContain("Features/Node/NodePageView.swift");
		expect(files).toContain("Features/Today/TodayView.swift");
		expect(files).toContain("App/RootView.swift");
	});

	it("keeps raw colors, system fonts and Track1Theme out of the screens", async () => {
		expect(await violationsInRepository(".")).toEqual([]);
	});

	it("fails when a faulty line is added to a screen, and ignores the design system and a build folder", async () => {
		const repository = await mkdtemp(join(tmpdir(), "track1-design-tokens-"));
		try {
			const features = join(repository, "ios/Track1/Features/Today");
			await mkdir(features, { recursive: true });
			await mkdir(join(repository, "ios/Track1/App"), { recursive: true });
			await mkdir(join(repository, "ios/Track1/DesignSystem"), { recursive: true });
			await mkdir(join(features, ".build"), { recursive: true });
			await writeFile(join(features, "Clean.swift"), 'Track1Text("a", role: .title1)\n');
			await writeFile(join(features, "Faulty.swift"), 'Text("a")\n\t.font(.headline)\n');
			await writeFile(join(features, ".build/Ignored.swift"), "Color(red: 1, green: 0, blue: 0)\n");
			await writeFile(
				join(repository, "ios/Track1/DesignSystem/Tokens.swift"),
				"Color(red: 1, green: 0, blue: 0)\n",
			);
			expect(await violationsInRepository(repository)).toEqual([
				"ios/Track1/Features/Today/Faulty.swift: line 2: dynamic type font",
			]);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	});
});

describe("Track1 design tokens detector", () => {
	it.each([
		["Color(red: 0, green: 0.4, blue: 0.9)", "raw color"],
		["Color(.sRGB, red: 1, green: 1, blue: 1)", "raw color"],
		["Color(hex: 0x443027)", "raw color"],
		["UIColor(red: 1, green: 0, blue: 0, alpha: 1)", "raw color"],
		['Text("a").font(.system(size: 13))', "system font"],
		["let font = Font.system(.body)", "system font"],
		['Text("a").font(.largeTitle)', "dynamic type font"],
		['Text("a").font(.title)', "dynamic type font"],
		['Text("a").font(.title2.bold())', "dynamic type font"],
		['Text("a").font(.headline)', "dynamic type font"],
		['Text("a").font(.body)', "dynamic type font"],
		['Text("a").font(.caption)', "dynamic type font"],
		['Text("a").font(.footnote)', "dynamic type font"],
		['Text("a").font(.subheadline.weight(.semibold))', "dynamic type font"],
		['Text("a").font(.callout)', "dynamic type font"],
		["VStack(spacing: Track1Theme.contentSpacing) {", "Track1Theme"],
		["// was Track1Theme.actionTint", "Track1Theme"],
	])("flags %j", (source, label) => {
		expect(violationsInSource(source)).toContain(`line 1: ${label}`);
	});

	it.each([
		'Track1Text("a", role: .title1)',
		'Text("a").font(Track1TextRole.bodyLarge.font)',
		"Color.clear",
		"Color(uiColor: .secondarySystemBackground)",
		"Track1Tokens.colorBackgroundBase.ignoresSafeArea()",
		"let theme = Track1ThemeName()",
	])("does not flag %j", (source) => {
		expect(violationsInSource(source)).toEqual([]);
	});
});
