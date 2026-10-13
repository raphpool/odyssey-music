import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// TRA-437: the app icon is an Icon Composer bundle compiled by actool. These guards run without Xcode: they
// check that the bundle is self-consistent and wired into the Xcode project. The XCTest in the app
// (testCompiledInfoPlistDeclaresAppIconAsPrimaryIcon, Track1Tests/AppConfigurationTests.swift) proves that
// actool really compiled it.
const ICON = "ios/Track1/Resources/AppIcon.icon";
const PROJECT = "ios/Track1.xcodeproj/project.pbxproj";

interface IconManifest {
	groups?: Array<{ layers?: Array<{ "image-name"?: string }> }>;
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
	const list = line.match(new RegExp(`${key} = \\(([^)]*)\\)`))?.[1] ?? "";
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

async function findDirectories(root: string, name: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === ".build") continue;
		const path = join(root, entry.name);
		if (entry.name === name) found.push(path);
		else found.push(...(await findDirectories(path, name)));
	}
	return found.sort();
}

describe("iOS app icon (Icon Composer bundle)", () => {
	it("has an icon.json that parses and whose every image-name exists in Assets/", async () => {
		const manifest = JSON.parse(await readFile(join(ICON, "icon.json"), "utf8")) as IconManifest;
		const imageNames = (manifest.groups ?? [])
			.flatMap((group) => group.layers ?? [])
			.map((layer) => layer["image-name"])
			.filter((name): name is string => name !== undefined);
		const assets = new Set(await readdir(join(ICON, "Assets")));

		expect(imageNames.length).toBeGreaterThan(0);
		for (const name of imageNames) expect(assets.has(name), `missing Assets/${name}`).toBe(true);
	});

	it("is referenced as an Icon Composer folder and listed in the Resources phase of the app only", async () => {
		const project = await readFile(PROJECT, "utf8");

		expect(project).toMatch(/lastKnownFileType = folder\.iconcomposer\.icon; path = AppIcon\.icon;/);
		expect(appResourcePaths(project)).toContain("AppIcon.icon");
		// One build file and its entry in the app phase: no test target compiles the icon.
		expect(project.match(/AppIcon\.icon in Resources/g)).toHaveLength(2);
	});

	it("declares ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon on every app build configuration", async () => {
		const project = await readFile(PROJECT, "utf8");
		const target = appTarget(project);
		const listId = target.match(/buildConfigurationList = ([A-F0-9]{24})/)?.[1];
		if (listId === undefined) throw new Error("Track1 target has no configuration list");
		const configurationIds = listedIds(objectLine(project, listId), "buildConfigurations");

		expect(configurationIds.length).toBeGreaterThan(0);
		for (const id of configurationIds) {
			expect(objectLine(project, id), id).toContain("ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;");
		}
	});

	it("leaves no AppIcon.appiconset, whose name would clash with AppIcon.icon", async () => {
		expect(await findDirectories("ios", "AppIcon.appiconset")).toEqual([]);
	});
});
