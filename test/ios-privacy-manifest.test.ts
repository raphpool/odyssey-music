import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// TRA-707: App Store Connect asks the export-compliance question on every build until
// ITSAppUsesNonExemptEncryption is declared, and rejects an upload whose code calls a "required reason" API
// without a privacy manifest declaring it. These guards run without Xcode. They keep the declarations honest in
// both directions: a category used by the sources must be declared, and a declared category must be used (an
// invented reason is a false declaration). Segment ships its own manifest, so it is not declared here.
const INFO_PLIST = "ios/Track1/Resources/Info.plist";
const MANIFEST = "ios/Track1/Resources/PrivacyInfo.xcprivacy";
const MANIFEST_NAME = "PrivacyInfo.xcprivacy";
const PROJECT = "ios/Track1.xcodeproj/project.pbxproj";
// The app and its pure-logic package. Test targets are not shipped, so they are not scanned.
const SOURCE_ROOTS = ["ios/Track1", "ios/Track1Core/Sources"];

const USER_DEFAULTS = "NSPrivacyAccessedAPICategoryUserDefaults";
const FILE_TIMESTAMP = "NSPrivacyAccessedAPICategoryFileTimestamp";
const DISK_SPACE = "NSPrivacyAccessedAPICategoryDiskSpace";
const SYSTEM_BOOT_TIME = "NSPrivacyAccessedAPICategorySystemBootTime";

// Source patterns per category. A match in a comment still counts: reword the comment rather than weaken this.
const CATEGORY_PATTERNS: ReadonlyArray<readonly [category: string, pattern: RegExp]> = [
	[USER_DEFAULTS, /\bUserDefaults\b|@AppStorage\b/],
	[FILE_TIMESTAMP, /\b(?:creationDate(?:Key)?|modificationDate|contentModificationDate(?:Key)?)\b/],
	[DISK_SPACE, /\bvolume(?:Available|Total)Capacity\w*|\bsystemFreeSize\b/],
	[SYSTEM_BOOT_TIME, /\bsystemUptime\b|\bmach_absolute_time\b/],
];

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
type PlistDict = { [key: string]: PlistValue };

/** Minimal XML plist reader (dict, array, string, integer, true, false): enough for Info.plist and manifests. */
function parsePlist(xml: string): PlistValue {
	const start = xml.indexOf("<plist");
	if (start === -1) throw new Error("Not an XML plist");
	const tokens = (xml.slice(start).match(/<[^>]+>|[^<]+/g) ?? [])
		.map((token) => token.trim())
		.filter(Boolean);
	let position = 1; // tokens[0] is the <plist> opening tag

	const take = (): string => {
		const token = tokens[position];
		if (token === undefined) throw new Error("Unexpected end of plist");
		position += 1;
		return token;
	};

	const readValue = (): PlistValue => {
		const token = take();
		switch (token) {
			case "<true/>":
				return true;
			case "<false/>":
				return false;
			case "<dict/>":
				return {};
			case "<array/>":
				return [];
			case "<dict>": {
				const dict: PlistDict = {};
				while (tokens[position] !== "</dict>") {
					if (take() !== "<key>") throw new Error("Expected <key> in a dict");
					const key = take();
					take(); // </key>
					dict[key] = readValue();
				}
				take(); // </dict>
				return dict;
			}
			case "<array>": {
				const items: PlistValue[] = [];
				while (tokens[position] !== "</array>") items.push(readValue());
				take(); // </array>
				return items;
			}
			case "<string>": {
				const text = tokens[position] === "</string>" ? "" : take();
				take(); // </string>
				return text;
			}
			case "<integer>": {
				const value = Number(take());
				take(); // </integer>
				return value;
			}
			default:
				throw new Error(`Unsupported plist token ${token}`);
		}
	};

	return readValue();
}

function asDict(value: PlistValue | undefined, what: string): PlistDict {
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} is not a dict`);
	return value;
}

/** Required-reason categories whose APIs appear in `source`. */
function detectCategories(source: string): Set<string> {
	return new Set(
		CATEGORY_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([category]) => category),
	);
}

/** Declared categories, rejecting duplicates since the App Store treats one entry per category as the contract. */
function declaredCategories(manifest: PlistDict): Map<string, string[]> {
	const entries = manifest.NSPrivacyAccessedAPITypes;
	if (!Array.isArray(entries)) throw new Error("NSPrivacyAccessedAPITypes is missing or not an array");
	const declared = new Map<string, string[]>();
	for (const entry of entries) {
		const dict = asDict(entry, "NSPrivacyAccessedAPITypes entry");
		const category = dict.NSPrivacyAccessedAPIType;
		const reasons = dict.NSPrivacyAccessedAPITypeReasons;
		if (typeof category !== "string") throw new Error("Entry without NSPrivacyAccessedAPIType");
		if (declared.has(category)) throw new Error(`Category ${category} is declared twice`);
		declared.set(
			category,
			Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [],
		);
	}
	return declared;
}

/** The pbxproj writes one object per line, so an object is found by the id that starts its line. */
function objectLine(project: string, id: string): string {
	const line = project.split("\n").find((candidate) => candidate.trimStart().startsWith(`${id} `));
	if (line === undefined) throw new Error(`No pbxproj object with id ${id}`);
	return line;
}

function appTarget(project: string): string {
	const line = project
		.split("\n")
		.find((candidate) => candidate.includes("isa = PBXNativeTarget") && candidate.includes("name = Track1;"));
	if (line === undefined) throw new Error("No Track1 native target in the pbxproj");
	return line;
}

// Ids of the entries in the `key = ( ... )` list of an object line; each entry is an id then a comment.
function listedIds(line: string, key: string): string[] {
	const list = line.match(new RegExp(`${key} = \\((.*?)\\);`))?.[1] ?? "";
	return [...list.matchAll(/([A-F0-9]{24}) \/\*/g)].map((match) => match[1] as string);
}

/** `path` of every file in the Resources build phase of the Track1 app target. */
function appResourcePaths(project: string): string[] {
	const phaseId = listedIds(appTarget(project), "buildPhases").find((id) =>
		objectLine(project, id).includes("isa = PBXResourcesBuildPhase"),
	);
	if (phaseId === undefined) throw new Error("Track1 target has no Resources build phase");
	return listedIds(objectLine(project, phaseId), "files").map((buildFileId) => {
		const fileRefId = objectLine(project, buildFileId).match(/fileRef = ([A-F0-9]{24})/)?.[1];
		if (fileRefId === undefined) throw new Error(`Build file ${buildFileId} has no fileRef`);
		return objectLine(project, fileRefId).match(/path = ([^;]+);/)?.[1] ?? "";
	});
}

async function swiftFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== ".build") found.push(...(await swiftFiles(path)));
		} else if (entry.name.endsWith(".swift")) {
			found.push(path);
		}
	}
	return found.sort();
}

async function categoriesUsedBySources(): Promise<Set<string>> {
	const used = new Set<string>();
	for (const root of SOURCE_ROOTS) {
		for (const file of await swiftFiles(root)) {
			for (const category of detectCategories(await readFile(file, "utf8"))) used.add(category);
		}
	}
	return used;
}

describe("export compliance (Info.plist)", () => {
	it("declares ITSAppUsesNonExemptEncryption as false: the app only uses HTTPS", async () => {
		const info = asDict(parsePlist(await readFile(INFO_PLIST, "utf8")), INFO_PLIST);

		// Absent would re-ask the question on every build; true would claim non-exempt encryption.
		expect(info.ITSAppUsesNonExemptEncryption).toBe(false);
	});
});

describe("privacy manifest wiring (pbxproj)", () => {
	it("lists PrivacyInfo.xcprivacy in the Resources phase of the Track1 app target, once", async () => {
		const project = await readFile(PROJECT, "utf8");

		expect(appResourcePaths(project)).toContain(MANIFEST_NAME);
		// One build file and its entry in the app phase: no test target bundles the manifest.
		expect(project.match(/PrivacyInfo\.xcprivacy in Resources/g)).toHaveLength(2);
	});

	it("references the manifest from the Resources group, next to Info.plist", async () => {
		const project = await readFile(PROJECT, "utf8");
		const reference = project
			.split("\n")
			.find((line) => line.includes("isa = PBXFileReference") && line.includes(`path = ${MANIFEST_NAME};`));
		const fileRefId = reference?.trimStart().match(/^([A-F0-9]{24}) /)?.[1];
		const resourcesGroup = project
			.split("\n")
			.find((line) => line.includes("isa = PBXGroup") && line.includes("path = Resources;"));

		expect(fileRefId, "no PBXFileReference for the manifest").toBeDefined();
		expect(reference).toContain('sourceTree = "<group>"');
		expect(listedIds(resourcesGroup ?? "", "children")).toContain(fileRefId);
	});
});

describe("privacy manifest content", () => {
	it("declares no tracking, no tracking domain and no collected data", async () => {
		const manifest = asDict(parsePlist(await readFile(MANIFEST, "utf8")), MANIFEST);

		expect(manifest.NSPrivacyTracking).toBe(false);
		expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
		expect(manifest.NSPrivacyCollectedDataTypes).toEqual([]);
	});

	it("declares UserDefaults with reason CA92.1 (data read and written by the app itself)", async () => {
		const declared = declaredCategories(asDict(parsePlist(await readFile(MANIFEST, "utf8")), MANIFEST));

		expect(declared.get(USER_DEFAULTS)).toEqual(["CA92.1"]);
	});

	it("declares every required-reason category found in the sources, and only those", async () => {
		const declared = declaredCategories(asDict(parsePlist(await readFile(MANIFEST, "utf8")), MANIFEST));
		const used = await categoriesUsedBySources();

		const undeclared = [...used].filter((category) => !declared.has(category)).sort();
		const unused = [...declared.keys()].filter((category) => !used.has(category)).sort();
		expect(undeclared, "used by the sources but not declared").toEqual([]);
		expect(unused, "declared but not used by the sources").toEqual([]);
	});
});

describe("required-reason API detection", () => {
	it.each([
		["UserDefaults.standard.set(1, forKey: key)", USER_DEFAULTS],
		["UserDefaults(suiteName: name)", USER_DEFAULTS],
		['@AppStorage("flag") var flag = false', USER_DEFAULTS],
		["try FileManager.default.attributesOfItem(atPath: p)[.creationDate]", FILE_TIMESTAMP],
		["let date = attributes[.modificationDate] as? Date", FILE_TIMESTAMP],
		["url.resourceValues(forKeys: [.contentModificationDateKey])", FILE_TIMESTAMP],
		["values.volumeAvailableCapacityForImportantUsage", DISK_SPACE],
		["values.volumeAvailableCapacity", DISK_SPACE],
		["let up = ProcessInfo.processInfo.systemUptime", SYSTEM_BOOT_TIME],
	])("detects %s as %s", (source, category) => {
		expect([...detectCategories(source)]).toEqual([category]);
	});

	it("does not flag ProcessInfo arguments or environment, nor a plain Date", () => {
		const source =
			"ProcessInfo.processInfo.arguments.contains(flag); ProcessInfo.processInfo.environment; Date()";

		expect(detectCategories(source).size).toBe(0);
	});
});

describe("plist reader", () => {
	it("reads nested dicts, arrays, empty containers and booleans", () => {
		const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
			<key>a</key><array><string>x</string><string></string></array>
			<key>b</key><false/><key>c</key><array/><key>d</key><dict><key>n</key><integer>3</integer></dict>
		</dict></plist>`;

		expect(parsePlist(xml)).toEqual({ a: ["x", ""], b: false, c: [], d: { n: 3 } });
	});
});
