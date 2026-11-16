import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// TRA-707: App Store Connect asks the export-compliance question on every build until
// ITSAppUsesNonExemptEncryption is declared, and rejects an upload whose code calls a "required reason" API
// without a manifest declaring it. These guards run without Xcode and keep the declaration honest both ways:
// a category used by the sources must be declared, and a declared one must be used (an invented reason is a
// false declaration). Only first-party sources are scanned; Swift packages bundle their own manifests.
const INFO_PLIST = "ios/Track1/Resources/Info.plist";
const MANIFEST = "ios/Track1/Resources/PrivacyInfo.xcprivacy";
const PROJECT = "ios/Track1.xcodeproj/project.pbxproj";
const SOURCE_ROOTS = ["ios/Track1", "ios/Track1Core/Sources"];

// The categories the ticket asks to detect, with the API names Apple lists for each. A match in a comment
// still counts: reword the comment rather than weaken the pattern. Add a category here when the code needs it.
const CATEGORY_PATTERNS: ReadonlyArray<readonly [category: string, pattern: RegExp]> = [
	["NSPrivacyAccessedAPICategoryUserDefaults", /\bUserDefaults\b|@AppStorage\b/],
	[
		"NSPrivacyAccessedAPICategoryFileTimestamp",
		/\b(?:creationDate|modificationDate|contentModificationDate)(?:Key)?\b/,
	],
	["NSPrivacyAccessedAPICategoryDiskSpace", /\bvolume(?:Available|Total)Capacity\w*|\bsystemFreeSize\b/],
	["NSPrivacyAccessedAPICategorySystemBootTime", /\bsystemUptime\b|\bmach_absolute_time\b/],
];

function detectCategories(source: string): Set<string> {
	return new Set(
		CATEGORY_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([category]) => category),
	);
}

/** The pbxproj writes one object per line, so an object is found by the id that starts its line. */
function objectLine(project: string, id: string): string {
	const line = project.split("\n").find((candidate) => candidate.trimStart().startsWith(`${id} `));
	if (line === undefined) throw new Error(`No pbxproj object with id ${id}`);
	return line;
}

// Ids of the entries in the `key = ( ... )` list of an object line; each entry is an id then a comment.
function listedIds(line: string, key: string): string[] {
	const list = line.match(new RegExp(`${key} = \\((.*?)\\);`))?.[1] ?? "";
	return [...list.matchAll(/([A-F0-9]{24}) \/\*/g)].map((match) => match[1] as string);
}

/** `path` of every file in the Resources build phase of the Track1 app target. */
function appResourcePaths(project: string): string[] {
	const target = project
		.split("\n")
		.find((line) => line.includes("isa = PBXNativeTarget") && line.includes("name = Track1;"));
	const phaseId = listedIds(target ?? "", "buildPhases").find((id) =>
		objectLine(project, id).includes("isa = PBXResourcesBuildPhase"),
	);
	if (phaseId === undefined) throw new Error("No Track1 target with a Resources build phase in the pbxproj");
	return listedIds(objectLine(project, phaseId), "files").map((buildFileId) => {
		const fileRefId = objectLine(project, buildFileId).match(/fileRef = ([A-F0-9]{24})/)?.[1] ?? "";
		return objectLine(project, fileRefId).match(/path = ([^;]+);/)?.[1] ?? "";
	});
}

async function categoriesUsedBySources(): Promise<Set<string>> {
	const used = new Set<string>();
	for (const root of SOURCE_ROOTS) {
		for (const file of await readdir(root, { recursive: true })) {
			if (!file.endsWith(".swift") || file.includes(".build")) continue;
			for (const category of detectCategories(await readFile(join(root, file), "utf8"))) used.add(category);
		}
	}
	return used;
}

describe("export compliance and privacy manifest (TRA-707)", () => {
	it("declares ITSAppUsesNonExemptEncryption as false in Info.plist", async () => {
		const info = await readFile(INFO_PLIST, "utf8");

		// Absent would re-ask the question on every build; true would claim non-exempt encryption.
		expect(info).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
	});

	it("lists PrivacyInfo.xcprivacy in the Resources phase of the Track1 app target", async () => {
		const project = await readFile(PROJECT, "utf8");

		expect(appResourcePaths(project)).toContain("PrivacyInfo.xcprivacy");
	});

	it("declares no tracking and no collected data, and UserDefaults with reason CA92.1", async () => {
		const manifest = await readFile(MANIFEST, "utf8");

		expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
		expect(manifest).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
		expect(manifest).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
		expect(manifest).toMatch(
			/NSPrivacyAccessedAPICategoryUserDefaults<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>CA92\.1<\/string>\s*<\/array>/,
		);
	});

	it("declares every required-reason category the sources use, and only those", async () => {
		const manifest = await readFile(MANIFEST, "utf8");
		const declared = new Set(
			[...manifest.matchAll(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/g)].map(
				(match) => match[1] as string,
			),
		);
		const used = await categoriesUsedBySources();

		expect([...used].filter((category) => !declared.has(category)).sort(), "used, not declared").toEqual([]);
		expect([...declared].filter((category) => !used.has(category)).sort(), "declared, not used").toEqual([]);
	});

	it.each([
		["UserDefaults.standard.set(1, forKey: key)", "UserDefaults"],
		["attributes[.modificationDate] as? Date", "FileTimestamp"],
		["url.resourceValues(forKeys: [.contentModificationDateKey])", "FileTimestamp"],
		["values.volumeAvailableCapacityForImportantUsage", "DiskSpace"],
		["ProcessInfo.processInfo.systemUptime", "SystemBootTime"],
	])("detects %s as %s", (source, name) => {
		expect([...detectCategories(source)]).toEqual([`NSPrivacyAccessedAPICategory${name}`]);
	});
});
