import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectPath = resolve("ios/Track1.xcodeproj/project.pbxproj");
const checkScript = resolve("ios/scripts/check.sh");

function buildSettingsFor(project: string, identifier: string) {
	const match = project.match(
		new RegExp(
			`${identifier} /\\* [^*]+ \\*/ = \\{isa = XCBuildConfiguration;[\\s\\S]*?buildSettings = \\{([^}]*)\\}; name = [^;]+; \\};`,
		),
	);
	expect(match, `Missing build settings for ${identifier}`).not.toBeNull();
	return match?.[1] ?? "";
}

async function writeTool(directory: string, name: string, contents: string) {
	const path = join(directory, name);
	await writeFile(path, contents, { mode: 0o755 });
	await chmod(path, 0o755);
}

type SwiftFixtureOptions = {
	badSource?: boolean;
	discoveryFailure?: boolean;
	empty?: boolean;
	missingRoot?: "Track1" | "Track1Tests" | "Track1UITests";
};

async function pathExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function runSwiftFixtureCheck(options: SwiftFixtureOptions = {}) {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "track1-ios-swift-fixture-"));
	const toolDirectory = join(fixtureRoot, "tools");
	const iosDirectory = join(fixtureRoot, "ios");
	const callsPath = join(fixtureRoot, "xcodebuild-calls");
	const swiftFormatCallsPath = join(fixtureRoot, "swift-format-calls");
	const outputDirectory = join(fixtureRoot, "output");
	const tsxDirectory = join(fixtureRoot, "node_modules/.bin");
	const sourceRoots = ["Track1", "Track1Tests", "Track1UITests"] as const;
	const appContainerPath = join(iosDirectory, "Track1", "AppContainer.swift");
	const newSourcePath = join(iosDirectory, "Track1", "Feature Area", "New Source.swift");
	const ordinarySourcePath = join(iosDirectory, "Track1", "Feature", "Ordinary.swift");
	const newTestPath = join(iosDirectory, "Track1Tests", "NewTest.swift");
	const newUITestPath = join(iosDirectory, "Track1UITests", "NewUITest.swift");
	const expectedSwiftFiles = [
		appContainerPath,
		newSourcePath,
		ordinarySourcePath,
		newTestPath,
		newUITestPath,
	];
	try {
		await mkdir(toolDirectory, { recursive: true });
		await mkdir(join(iosDirectory, "scripts"), { recursive: true });
		await mkdir(join(iosDirectory, "Track1.xcodeproj"), { recursive: true });
		await writeFile(join(iosDirectory, "scripts/check.sh"), await readFile(checkScript), { mode: 0o755 });
		await chmod(join(iosDirectory, "scripts/check.sh"), 0o755);
		await writeFile(join(iosDirectory, ".xcode-version"), "Xcode 26.4 (17E192)\n");
		await writeFile(join(iosDirectory, ".swift-format"), "{}\n");
		await writeFile(join(iosDirectory, "Track1.xcodeproj/project.pbxproj"), "");
		await writeFile(join(fixtureRoot, "package-lock.json"), "{}\n");
		await mkdir(tsxDirectory, { recursive: true });
		await writeTool(tsxDirectory, "tsx", "#!/usr/bin/env bash\nexit 0\n");

		for (const sourceRoot of sourceRoots) {
			if (sourceRoot === options.missingRoot) {
				continue;
			}
			await mkdir(join(iosDirectory, sourceRoot), { recursive: true });
		}

		if (!options.empty && !options.missingRoot) {
			const swiftSources: Array<[string, string]> = [
				[appContainerPath, "struct AppContainer {}\n"],
				[newSourcePath, options.badSource ? "struct NewSource { BAD_FORMAT }\n" : "struct NewSource {}\n"],
				[ordinarySourcePath, "struct Ordinary {}\n"],
				[newTestPath, "struct NewTest {}\n"],
				[newUITestPath, "struct NewUITest {}\n"],
			];
			for (const [path, contents] of swiftSources) {
				await mkdir(join(path, ".."), { recursive: true });
				await writeFile(path, contents);
			}

			for (const excludedDirectory of ["DerivedData", "SourcePackages", ".build"]) {
				const excludedPath = join(iosDirectory, "Track1", "Feature", excludedDirectory, "Ignored.swift");
				await mkdir(join(excludedPath, ".."), { recursive: true });
				await writeFile(excludedPath, "struct BAD_FORMAT {}\n");
			}
			const outsidePath = join(fixtureRoot, "outside.swift");
			await writeFile(outsidePath, "struct BAD_FORMAT {}\n");
			await symlink(outsidePath, join(iosDirectory, "Track1", "External.swift"));
		}

		await writeTool(
			toolDirectory,
			"xcodebuild",
			`#!/usr/bin/env bash
if [[ "$1" == "-version" ]]; then
  printf 'Xcode 26.4\\nBuild version 17E192\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "$TRACK1_TEST_XCODEBUILD_CALLS"
arguments=" $* "
if [[ "$arguments" == *" build-for-testing "* ]]; then
  scheme=""
  derived_data=""
  while (($#)); do
    case "$1" in
      -scheme) scheme="$2"; shift 2 ;;
      -derivedDataPath) derived_data="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$derived_data/Build/Products"
  printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Track1Tests</key><dict/></dict></plist>' > "$derived_data/Build/Products/$scheme.xctestrun"
fi
if [[ "\${TRACK1_TEST_FAIL_ACTION:-}" == "build-for-testing" && "$arguments" == *" build-for-testing "* ]]; then
  exit 17
fi
if [[ "\${TRACK1_TEST_FAIL_ACTION:-}" == "test-without-building" && "$arguments" == *" test-without-building "* ]]; then
  exit 19
fi
`,
		);
		await writeTool(
			toolDirectory,
			"xcrun",
			`#!/usr/bin/env bash
case "$*" in
  "simctl list runtimes available -j") printf '{"runtimes":[{"name":"iOS 26.4","identifier":"runtime-id"}]}' ;;
  "simctl create"*) printf 'simulator-id\\n' ;;
  "swift-format lint"*)
    printf '%s\\n' "$@" >> "$TRACK1_TEST_SWIFT_FORMAT_CALLS"
    for argument in "$@"; do
      if [[ "$argument" == *.swift ]] && grep -q 'BAD_FORMAT' "$argument"; then
        exit 23
      fi
    done
    ;;
  "simctl bootstatus"* | "simctl shutdown"* | "simctl delete"*) ;;
  *) exit 1 ;;
esac
`,
		);
		await writeTool(toolDirectory, "jq", "#!/usr/bin/env bash\ncat >/dev/null\nprintf 'runtime-id\\n'\n");
		await writeTool(
			toolDirectory,
			"curl",
			`#!/usr/bin/env bash
if [[ "$*" == *"__track1_contract_report"* ]]; then
  printf '{"catalogRequests":2,"notModifiedCatalogRequests":1,"nodeRequests":1,"generationPosts":1,"providerFetchAttempts":0}'
fi
`,
		);
		await writeTool(
			toolDirectory,
			"node",
			`#!/usr/bin/env bash
if [[ "\${1:-}" == "-p" || "\${1:-}" == "-e" ]]; then
  [[ "\${1:-}" == "-p" ]] && printf '20\\n'
  exit 0
fi
ready_file=""
while (($#)); do
  case "$1" in
    --ready-file) ready_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$ready_file" ]] || exit 1
printf 'http://127.0.0.1:1/mobile/v1/\\n' > "$ready_file"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
		);
		if (options.discoveryFailure) {
			await writeTool(toolDirectory, "find", "#!/usr/bin/env bash\nexit 73\n");
		}

		const result = spawnSync("bash", [join(iosDirectory, "scripts/check.sh")], {
			cwd: fixtureRoot,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${toolDirectory}:${process.env.PATH ?? ""}`,
				TRACK1_CI_OUTPUT_DIR: outputDirectory,
				TRACK1_TEST_XCODEBUILD_CALLS: callsPath,
				TRACK1_TEST_SWIFT_FORMAT_CALLS: swiftFormatCallsPath,
			},
		});
		const calls = await readFile(callsPath, "utf8").catch(() => "");
		const swiftFormatArguments = (await readFile(swiftFormatCallsPath, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean);
		return { calls, expectedSwiftFiles, fixtureRoot, result, swiftFormatArguments };
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
}

async function runCheckScript(failingAction?: "build-for-testing" | "test-without-building") {
	const directory = await mkdtemp(join(tmpdir(), "track1-ios-check-"));
	const callsPath = join(directory, "xcodebuild-calls");
	const swiftFormatCallsPath = join(directory, "swift-format-calls");
	const outputDirectory = join(directory, "output");
	try {
		await writeTool(
			directory,
			"xcodebuild",
			`#!/usr/bin/env bash
if [[ "$1" == "-version" ]]; then
	  printf 'Xcode 26.4\\nBuild version 17E192\\n'
	  exit 0
fi
printf '%s\\n' "$*" >> "$TRACK1_TEST_XCODEBUILD_CALLS"
arguments=" $* "
if [[ "$arguments" == *" build-for-testing "* ]]; then
	  scheme=""
	  derived_data=""
	  while (($#)); do
		  case "$1" in
			-scheme) scheme="$2"; shift 2 ;;
			-derivedDataPath) derived_data="$2"; shift 2 ;;
			*) shift ;;
		  esac
	  done
	  mkdir -p "$derived_data/Build/Products"
	  printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Track1Tests</key><dict/></dict></plist>' > "$derived_data/Build/Products/$scheme.xctestrun"
fi
if [[ "\${TRACK1_TEST_FAIL_ACTION:-}" == "build-for-testing" && "$arguments" == *" build-for-testing "* ]]; then
	  exit 17
fi
if [[ "\${TRACK1_TEST_FAIL_ACTION:-}" == "test-without-building" && "$arguments" == *" test-without-building "* ]]; then
	  exit 19
fi
`,
		);
		await writeTool(
			directory,
			"xcrun",
			`#!/usr/bin/env bash
case "$*" in
  "simctl list runtimes available -j") printf '{"runtimes":[{"name":"iOS 26.4","identifier":"runtime-id"}]}' ;;
  "simctl create"*) printf 'simulator-id\\n' ;;
  "swift-format lint"*) printf '%s\\n' "$@" >> "$TRACK1_TEST_SWIFT_FORMAT_CALLS" ;;
  "simctl bootstatus"* | "simctl shutdown"* | "simctl delete"*) ;;
  *) exit 1 ;;
esac
`,
		);
		await writeTool(directory, "jq", "#!/usr/bin/env bash\ncat >/dev/null\nprintf 'runtime-id\\n'\n");
		await writeTool(
			directory,
			"curl",
			`#!/usr/bin/env bash
if [[ "$*" == *"__track1_contract_report"* ]]; then
	  printf '{"catalogRequests":2,"notModifiedCatalogRequests":1,"nodeRequests":1,"generationPosts":1,"providerFetchAttempts":0}'
fi
`,
		);
		const result = spawnSync("bash", [checkScript], {
			cwd: resolve("."),
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${directory}:${process.env.PATH ?? ""}`,
				TRACK1_CI_OUTPUT_DIR: outputDirectory,
				TRACK1_TEST_FAIL_ACTION: failingAction ?? "",
				TRACK1_TEST_XCODEBUILD_CALLS: callsPath,
				TRACK1_TEST_SWIFT_FORMAT_CALLS: swiftFormatCallsPath,
			},
		});
		const calls = await readFile(callsPath, "utf8").catch(() => "");
		const swiftFormatArguments = (await readFile(swiftFormatCallsPath, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean);
		return { calls, result, swiftFormatArguments };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe.sequential("Track1 simulator architecture policy", () => {
	it("keeps the simulator-local architecture setting at project level for Development and Preview", async () => {
		const project = await readFile(projectPath, "utf8");

		for (const identifier of ["C10000000000000000000001", "C10000000000000000000002"]) {
			expect(buildSettingsFor(project, identifier)).toContain(
				'"ONLY_ACTIVE_ARCH[sdk=iphonesimulator*]" = YES;',
			);
		}
		expect(buildSettingsFor(project, "C10000000000000000000003")).not.toContain("ONLY_ACTIVE_ARCH");
		expect(project).not.toContain("ONLY_ACTIVE_ARCH[sdk=iphoneos*");
		expect(project).not.toMatch(/\bARCHS(?:\[| =)/);
		expect(project).not.toMatch(/\bEXCLUDED_ARCHS(?:\[| =)/);

		for (const identifier of [
			"C20000000000000000000001",
			"C20000000000000000000002",
			"C30000000000000000000001",
			"C30000000000000000000002",
			"C40000000000000000000001",
			"C40000000000000000000002",
		]) {
			expect(buildSettingsFor(project, identifier)).not.toContain("ONLY_ACTIVE_ARCH");
		}
	});

	it("passes the multiarchitecture override to every compilation and test action", async () => {
		const { calls, result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		const actions = calls
			.split("\n")
			.filter((call) => /(^| )(build-for-testing|test-without-building)( |$)/.test(call));
		expect(actions).toHaveLength(4);
		for (const action of actions) {
			expect(action).toContain("ONLY_ACTIVE_ARCH=NO");
		}
		const builds = actions.filter((action) => /(^| )build-for-testing( |$)/.test(action));
		const tests = actions.filter((action) => /(^| )test-without-building( |$)/.test(action));
		expect(builds).toHaveLength(2);
		expect(tests).toHaveLength(2);
		expect(builds.filter((action) => action.includes("-scheme Track1 "))).toHaveLength(1);
		expect(builds.filter((action) => action.includes("-scheme Track1Preview "))).toHaveLength(1);
		for (const test of tests) {
			expect(test).toContain("-resultBundlePath");
		}
	});

	it("passes AppContainer from the real source tree to swift-format", async () => {
		const { result, swiftFormatArguments } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(swiftFormatArguments).toContain(resolve("ios/Track1/App/AppContainer.swift"));
	});

	it.each(["build-for-testing", "test-without-building"] as const)(
		"propagates a failing %s action",
		async (failingAction) => {
			const { result } = await runCheckScript(failingAction);
			expect(result.status).not.toBe(0);
		},
	);
});

describe.sequential("Track1 Swift format coverage", () => {
	it("discovers every first-party Swift file and stops before build actions on a violation", async () => {
		const { calls, expectedSwiftFiles, fixtureRoot, result, swiftFormatArguments } =
			await runSwiftFixtureCheck({ badSource: true });

		expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
		expect(calls).toBe("");
		expect(swiftFormatArguments.slice(0, 4)).toEqual(["swift-format", "lint", "--strict", "--configuration"]);
		expect(swiftFormatArguments.slice(5)).toEqual([...expectedSwiftFiles].sort());
		expect(swiftFormatArguments).not.toContain(join(fixtureRoot, "ios", "Track1", "External.swift"));
		expect(swiftFormatArguments).not.toContain(
			join(fixtureRoot, "ios", "Track1", "Feature", "DerivedData", "Ignored.swift"),
		);
		expect(swiftFormatArguments).not.toContain(
			join(fixtureRoot, "ios", "Track1", "Feature", "SourcePackages", "Ignored.swift"),
		);
		expect(swiftFormatArguments).not.toContain(
			join(fixtureRoot, "ios", "Track1", "Feature", ".build", "Ignored.swift"),
		);
		expect(await pathExists(fixtureRoot)).toBe(false);
	});

	it("passes the same fixture when the newly discovered source is conforming", async () => {
		const { calls, expectedSwiftFiles, fixtureRoot, result, swiftFormatArguments } =
			await runSwiftFixtureCheck();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(swiftFormatArguments.slice(5)).toEqual([...expectedSwiftFiles].sort());
		expect(await pathExists(fixtureRoot)).toBe(false);
	});

	it.each([
		[
			"a missing source root",
			{ missingRoot: "Track1UITests" as const },
			"Expected Swift source root is missing or is a symlink",
		],
		["a discovery error", { discoveryFailure: true }, "Could not discover Swift source files under"],
		[
			"an empty source list",
			{ empty: true },
			"No Swift source files were discovered under the expected roots.",
		],
	] as const)("fails explicitly for %s and cleans the fixture", async (_label, options, expectedError) => {
		const { calls, fixtureRoot, result } = await runSwiftFixtureCheck(options);

		expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
		expect(result.stderr).toContain(expectedError);
		expect(calls).toBe("");
		expect(await pathExists(fixtureRoot)).toBe(false);
	});
});
