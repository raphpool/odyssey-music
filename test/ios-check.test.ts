import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
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

// 2026-10-21 (TRA-650): PlistBuddy and plutil only exist on macOS, so on the Linux CI host the real ones were
// missing (45 tests of this file failed there). Both are doubles, first in PATH like the other tools.
// PlistBuddy logs its calls to TRACK1_TEST_PLISTBUDDY_CALLS when set.
async function writePlistTools(directory: string) {
	await writeTool(
		directory,
		"PlistBuddy",
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${TRACK1_TEST_PLISTBUDDY_CALLS:-/dev/null}"
`,
	);
	// Stands for `plutil -convert json -o - -` on the `simctl listapps` text: the top-level keys (four-space
	// indent, as in the fixture) become the keys of a JSON object, which is all check.sh reads.
	await writeTool(
		directory,
		"plutil",
		`#!/usr/bin/env bash
awk 'BEGIN { printf "{" }
  /^    "[^"]+" = \\{/ { key = $0; sub(/^    "/, "", key); sub(/" = \\{.*$/, "", key); printf "%s\\"%s\\":{}", separator, key; separator = "," }
  END { print "}" }'
`,
	);
}

// A fake `swift` (check.sh takes it from PATH, not through xcrun). Every call is logged to
// TRACK1_TEST_SWIFT_CALLS and, when set, to the shared TRACK1_TEST_TIMELINE. TRACK1_TEST_SWIFT_MODE=fail makes
// it exit 7; =hang makes it never return, with a child `sleep` like the real build tools have, and records both
// pids in TRACK1_TEST_SWIFT_PIDS so that a test can check that nothing was left behind.
const fakeSwift = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TRACK1_TEST_SWIFT_CALLS"
printf 'swift\\n' >> "\${TRACK1_TEST_TIMELINE:-/dev/null}"
case "\${TRACK1_TEST_SWIFT_MODE:-}" in
  fail) echo "swift test: simulated failure" >&2; exit 7 ;;
  hang)
    sleep 600 &
    printf '%s\\n%s\\n' "$$" "$!" >> "$TRACK1_TEST_SWIFT_PIDS"
    wait ;;
esac
`;

type SwiftFixtureOptions = {
	badSource?: boolean;
	discoveryFailure?: boolean;
	empty?: boolean;
	missingRoot?: "Track1" | "Track1Tests" | "Track1UITests" | "Track1Core";
};

function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

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
	const swiftCallsPath = join(fixtureRoot, "swift-calls");
	const outputDirectory = join(fixtureRoot, "output");
	const tsxDirectory = join(fixtureRoot, "node_modules/.bin");
	const sourceRoots = ["Track1", "Track1Tests", "Track1UITests", "Track1Core"] as const;
	const appContainerPath = join(iosDirectory, "Track1", "AppContainer.swift");
	const newSourcePath = join(iosDirectory, "Track1", "Feature Area", "New Source.swift");
	const ordinarySourcePath = join(iosDirectory, "Track1", "Feature", "Ordinary.swift");
	const newTestPath = join(iosDirectory, "Track1Tests", "NewTest.swift");
	const newUITestPath = join(iosDirectory, "Track1UITests", "NewUITest.swift");
	const coreSourcePath = join(iosDirectory, "Track1Core", "Sources", "Track1Core", "CoreSource.swift");
	const coreTestPath = join(iosDirectory, "Track1Core", "Tests", "Track1CoreTests", "CoreTest.swift");
	const expectedSwiftFiles = [
		appContainerPath,
		newSourcePath,
		ordinarySourcePath,
		newTestPath,
		newUITestPath,
		coreSourcePath,
		coreTestPath,
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
				[coreSourcePath, "struct CoreSource {}\n"],
				[coreTestPath, "struct CoreTest {}\n"],
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
			// SwiftPM's scratch folder of the package: whatever it checks out must never be linted.
			const packageBuildPath = join(iosDirectory, "Track1Core", ".build", "checkouts", "Ignored.swift");
			await mkdir(join(packageBuildPath, ".."), { recursive: true });
			await writeFile(packageBuildPath, "struct BAD_FORMAT {}\n");
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
  "simctl list devices -j") printf '{"devices":{}}\\n' ;;
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
		await writeTool(toolDirectory, "swift", fakeSwift);
		await writePlistTools(toolDirectory);
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
				TRACK1_DERIVED_DATA_CACHE_DIR: join(fixtureRoot, "derived-data-cache"),
				TRACK1_SIMULATOR_LOCK_DIR: join(fixtureRoot, "simulator.lock"),
				TRACK1_TEST_XCODEBUILD_CALLS: callsPath,
				TRACK1_TEST_SWIFT_FORMAT_CALLS: swiftFormatCallsPath,
				TRACK1_TEST_SWIFT_CALLS: swiftCallsPath,
			},
		});
		const calls = await readFile(callsPath, "utf8").catch(() => "");
		const swiftCalls = (await readFile(swiftCallsPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
		const swiftFormatArguments = (await readFile(swiftFormatCallsPath, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean);
		return { calls, expectedSwiftFiles, fixtureRoot, result, swiftCalls, swiftFormatArguments };
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
}

type CheckScriptPaths = {
	cacheDirectory: string;
	outputDirectory: string;
	// The machine-wide lock around the reusable simulator (TRACK1_SIMULATOR_LOCK_DIR).
	simulatorLockDirectory: string;
};

type CheckScriptOptions = {
	// Output of the faked `xcrun simctl list devices`.
	devices?: string;
	// Output of the faked `xcrun simctl list devices -j`, where the reusable device is looked up.
	devicesJson?: string;
	// Output of the faked `xcrun simctl listapps`.
	apps?: string;
	env?: Record<string, string>;
	// Puts a `node` first in PATH that runs this shell snippet when check.sh starts the contract harness, then runs
	// the real node: `sleep 6` is a cold tsx start on a loaded machine, `exit 3` a harness that crashes at boot.
	harnessStartPrelude?: string;
	// Runs before the script, to seed the persistent derived-data cache.
	beforeRun?: (paths: CheckScriptPaths) => Promise<void>;
};

// Independent of check.sh on purpose: the cache key is Xcode version, Package.resolved hash, ISO week.
function isoWeek(date: Date) {
	const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
	const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function expectedCacheKey() {
	const resolved = await readFile(
		resolve("ios/Track1.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"),
	);
	const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
	return `Xcode-26.4-17E192-${hash}-${isoWeek(new Date())}`;
}

// The `-derivedDataPath` argument of every logged `build-for-testing` call of a scheme.
function derivedDataPaths(calls: string, scheme: string) {
	return calls
		.split("\n")
		.filter((call) => /(^| )build-for-testing( |$)/.test(call) && call.includes(`-scheme ${scheme} `))
		.map((call) => call.match(/-derivedDataPath (\S+)/)?.[1] ?? "");
}

function testActions(calls: string) {
	return calls.split("\n").filter((call) => /(^| )test-without-building( |$)/.test(call));
}

// A live process (this vitest worker) holds the lock of the reusable simulator, like a concurrent check.sh.
async function holdSimulatorLock({ simulatorLockDirectory }: CheckScriptPaths) {
	await mkdir(simulatorLockDirectory, { recursive: true });
	await writeFile(join(simulatorLockDirectory, "pid"), `${process.pid}\n`);
}

async function runCheckScript(
	failingAction?: "build-for-testing" | "test-without-building",
	options: CheckScriptOptions = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "track1-ios-check-"));
	const callsPath = join(directory, "xcodebuild-calls");
	const simctlCallsPath = join(directory, "simctl-calls");
	const swiftFormatCallsPath = join(directory, "swift-format-calls");
	const curlCallsPath = join(directory, "curl-calls");
	const plistBuddyCallsPath = join(directory, "plistbuddy-calls");
	const outputDirectory = join(directory, "output");
	const cacheDirectory = join(directory, "derived-data-cache");
	const simulatorLockDirectory = join(directory, "simulator.lock");
	try {
		await options.beforeRun?.({ cacheDirectory, outputDirectory, simulatorLockDirectory });
		await writeTool(
			directory,
			"xcodebuild",
			`#!/usr/bin/env bash
if [[ "$1" == "-version" ]]; then
	  printf 'Xcode 26.4\\nBuild version 17E192\\n'
	  exit 0
fi
printf '%s\\n' "$*" >> "$TRACK1_TEST_XCODEBUILD_CALLS"
printf 'xcodebuild\\n' >> "$TRACK1_TEST_TIMELINE"
arguments=" $* "
# Lets the tests order the test runs against the simctl calls.
[[ "$arguments" != *" test-without-building "* ]] || printf 'xcodebuild test-without-building\\n' >> "$TRACK1_TEST_SIMCTL_CALLS"
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
	  # A build that starts from a non-empty derived-data folder fails, like a corrupted cache would.
	  if [[ -n "\${TRACK1_TEST_FAIL_WARM_BUILD:-}" && -d "$derived_data/Build/Products" ]]; then
		  exit 18
	  fi
	  mkdir -p "$derived_data/Build/Products"
	  printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Track1Tests</key><dict/></dict></plist>' > "$derived_data/Build/Products/$scheme.xctestrun"
fi
if [[ "\${TRACK1_TEST_FAIL_ACTION:-}" == "build-for-testing" && "$arguments" == *" build-for-testing "* ]]; then
	  exit 17
fi
if [[ "\${TRACK1_TEST_FAIL_ACTION:-}" == "test-without-building" && "$arguments" == *" test-without-building "* && "$arguments" == *"\${TRACK1_TEST_FAIL_XCTESTRUN:-}"* ]]; then
	  exit 19
fi
`,
		);
		await writeTool(
			directory,
			"xcrun",
			`#!/usr/bin/env bash
[[ "$1" == "simctl" ]] && printf '%s\\n' "$*" >> "$TRACK1_TEST_SIMCTL_CALLS"
# What starts a simulator, for the order against swift test.
case "$*" in "simctl create"* | "simctl bootstatus"*) printf 'simctl %s\\n' "$2" >> "$TRACK1_TEST_TIMELINE" ;; esac
case "$*" in
  "simctl list runtimes available -j") printf '{"runtimes":[{"name":"iOS 26.4","identifier":"runtime-id"}]}' ;;
  "simctl list devices") printf '%s\\n' "\${TRACK1_TEST_SIMCTL_DEVICES:-}" ;;
  "simctl list devices -j")
    devices_json="\${TRACK1_TEST_SIMCTL_DEVICES_JSON:-}"
    [[ -n "$devices_json" ]] || devices_json='{"devices":{}}'
    # A deleted device is gone from the next listing, as with the real simctl.
    for deleted in "$TRACK1_TEST_DELETED_DIR"/*; do
      [[ -e "$deleted" ]] || continue
      devices_json="$(printf '%s' "$devices_json" | sed "s/\\"name\\":\\"[^\\"]*\\",\\"udid\\":\\"\${deleted##*/}\\"/\\"name\\":\\"gone\\"/")"
    done
    printf '%s\\n' "$devices_json" ;;
  "simctl listapps"*) printf '%s\\n' "\${TRACK1_TEST_SIMCTL_APPS:-}" ;;
  "simctl uninstall"*) [[ -z "\${TRACK1_TEST_FAIL_UNINSTALL:-}" ]] || exit 165 ;;
  "simctl keychain"* | "simctl privacy"*) ;;
  "simctl create"*) printf 'simulator-id\\n' ;;
  "swift-format lint"*) printf '%s\\n' "$@" >> "$TRACK1_TEST_SWIFT_FORMAT_CALLS" ;;
  "simctl shutdown"*) [[ -z "\${TRACK1_TEST_FAIL_SHUTDOWN:-}" ]] || exit 164 ;;
  "simctl bootstatus"*) [[ " \${TRACK1_TEST_FAIL_BOOT_UDIDS:-} " != *" $3 "* ]] || exit 166 ;;
  "simctl delete"*)
    [[ " \${TRACK1_TEST_FAIL_DELETE_UDIDS:-} " != *" $3 "* ]] || exit 167
    mkdir -p "$TRACK1_TEST_DELETED_DIR" && touch "$TRACK1_TEST_DELETED_DIR/$3" ;;
  *) exit 1 ;;
esac
`,
		);
		await writeTool(directory, "swift", fakeSwift);
		await writeTool(directory, "jq", "#!/usr/bin/env bash\ncat >/dev/null\nprintf 'runtime-id\\n'\n");
		await writePlistTools(directory);
		await writeTool(
			directory,
			"curl",
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TRACK1_TEST_CURL_CALLS"
if [[ "$*" == *"__track1_contract_report"* ]]; then
	  printf '{"catalogRequests":2,"notModifiedCatalogRequests":1,"nodeRequests":1,"generationPosts":1,"providerFetchAttempts":0}'
fi
`,
		);
		if (options.harnessStartPrelude !== undefined) {
			// Only the harness start (the one call with --ready-file) is affected; the other node calls of check.sh are not.
			await writeTool(
				directory,
				"node",
				`#!/bin/sh
case "$*" in *--ready-file*) ${options.harnessStartPrelude} ;; esac
exec "${process.execPath}" "$@"
`,
			);
		}
		const swiftCallsPath = join(directory, "swift-calls");
		const swiftPidsPath = join(directory, "swift-pids");
		const timelinePath = join(directory, "timeline");
		const startedAt = Date.now();
		const result = spawnSync("bash", [checkScript], {
			cwd: resolve("."),
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${directory}:${process.env.PATH ?? ""}`,
				TRACK1_TEST_SWIFT_CALLS: swiftCallsPath,
				TRACK1_TEST_SWIFT_PIDS: swiftPidsPath,
				TRACK1_TEST_TIMELINE: timelinePath,
				TRACK1_CI_OUTPUT_DIR: outputDirectory,
				TRACK1_DERIVED_DATA_CACHE_DIR: cacheDirectory,
				TRACK1_TEST_CURL_CALLS: curlCallsPath,
				TRACK1_TEST_PLISTBUDDY_CALLS: plistBuddyCallsPath,
				TRACK1_TEST_FAIL_ACTION: failingAction ?? "",
				TRACK1_TEST_XCODEBUILD_CALLS: callsPath,
				TRACK1_TEST_SWIFT_FORMAT_CALLS: swiftFormatCallsPath,
				TRACK1_TEST_SIMCTL_CALLS: simctlCallsPath,
				TRACK1_TEST_SIMCTL_DEVICES: options.devices ?? "",
				TRACK1_TEST_SIMCTL_DEVICES_JSON: options.devicesJson ?? "",
				TRACK1_TEST_SIMCTL_APPS: options.apps ?? "",
				TRACK1_TEST_DELETED_DIR: join(directory, "deleted-devices"),
				TRACK1_SIMULATOR_LOCK_DIR: simulatorLockDirectory,
				...options.env,
			},
		});
		const elapsedMilliseconds = Date.now() - startedAt;
		const calls = await readFile(callsPath, "utf8").catch(() => "");
		const lines = async (path: string) =>
			(await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);
		const swiftCalls = await lines(swiftCallsPath);
		// The fake swift and its child, if check.sh left them running; the finally block kills them.
		const swiftSurvivors: number[] = [];
		for (const pid of (await lines(swiftPidsPath)).map(Number)) {
			for (let attempt = 0; attempt < 20 && isAlive(pid); attempt++) {
				await new Promise((done) => setTimeout(done, 100));
			}
			if (isAlive(pid)) swiftSurvivors.push(pid);
		}
		const timeline = await lines(timelinePath);
		const simctlCalls = (await readFile(simctlCallsPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
		const swiftFormatArguments = (await readFile(swiftFormatCallsPath, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean);
		const curlCalls = (await readFile(curlCallsPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
		const plistBuddyCalls = await lines(plistBuddyCallsPath);
		const cacheEntries = await readdir(cacheDirectory).catch(() => [] as string[]);
		const cacheFiles = await readdir(cacheDirectory, { recursive: true }).catch(() => [] as string[]);
		const simulatorLockLeft = await pathExists(simulatorLockDirectory);
		return {
			cacheDirectory,
			cacheEntries,
			cacheFiles,
			calls,
			curlCalls,
			elapsedMilliseconds,
			outputDirectory,
			plistBuddyCalls,
			result,
			simctlCalls,
			simulatorLockLeft,
			swiftCalls,
			swiftFormatArguments,
			swiftSurvivors,
			timeline,
		};
	} finally {
		// A fake swift that hung must not outlive the test, whatever check.sh did.
		for (const pid of (await readFile(join(directory, "swift-pids"), "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map(Number)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
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

	it("bounds every test with a per-test timeout so a hanging test fails by name", async () => {
		const { calls, result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		const tests = calls.split("\n").filter((call) => /(^| )test-without-building( |$)/.test(call));
		expect(tests).toHaveLength(2);
		for (const test of tests) {
			expect(test).toMatch(/(^| )-test-timeouts-enabled YES( |$)/);
			const allowance = test.match(/(^| )-default-test-execution-time-allowance (\d+)( |$)/);
			expect(allowance, `Missing default allowance in: ${test}`).not.toBeNull();
			const seconds = Number(allowance?.[2]);
			// XCTest rounds allowances up to the next minute, so only whole minutes mean what they say.
			expect(seconds % 60).toBe(0);
			// Longest legitimate test measured on CI is 48 s (UI); keep at least a 3x margin over it.
			expect(seconds).toBeGreaterThanOrEqual(180);
			// A test is bounded by the default allowance; a cap would silently shorten tests that ask for more.
			expect(test).not.toContain("-maximum-test-execution-time-allowance");
		}
		const builds = calls.split("\n").filter((call) => /(^| )build-for-testing( |$)/.test(call));
		for (const build of builds) {
			expect(build).not.toContain("test-execution-time-allowance");
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

// 2026-10-12: ios-check took about 10 min because it compiled and ran the whole suite twice, once per scheme,
// each time from an empty DerivedData in the job's temporary folder (TRA-420).
async function swiftFiles(directory: string) {
	const entries = await readdir(directory, { recursive: true });
	return entries.filter((entry) => entry.endsWith(".swift")).map((entry) => join(directory, entry));
}

describe.sequential("Track1 scheme passes", () => {
	// Tests whose result can differ under Track1Preview; each one is justified in check.sh.
	const previewOnlyTesting = [
		"Track1Tests/AppConfigurationTests/testApplicationBundleDeclaresAModernLaunchScreen",
		"Track1UITests/NavigationTests/testThreeTabsKeepTheirIndependentNavigationStacks",
		"Track1Tests/AnalyticsClientTests/testRealSegmentAdapterSendsOnlyAfterGrantAndPurgesAfterWithdrawal",
		"Track1Tests/AnalyticsClientTests/testRealSegmentAdapterMapsEventIDToMessageIDAndStripsContext",
		"Track1Tests/AnalyticsClientTests/testRealSegmentWaitsForDelayedStartupBeforeSendingTheFirstEvent",
		"Track1Tests/AnalyticsClientTests/testRealSegmentWithdrawalCancelsDelayedUploadAndPurgesSDKIdentity",
		"Track1Tests/AnalyticsClientTests/testRealSegmentAdapterReusesItsSingleSDKInstanceAfterRapidRegrant",
	];

	it("compiles both schemes completely but runs the whole suite for Track1 only", async () => {
		const { calls, result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		const builds = calls.split("\n").filter((call) => /(^| )build-for-testing( |$)/.test(call));
		expect(builds).toHaveLength(2);
		for (const build of builds) {
			expect(build).not.toContain("-only-testing");
		}
		const tests = testActions(calls);
		expect(tests).toHaveLength(2);
		const [full, preview] = tests;
		expect(full).toContain("Track1.xctestrun");
		expect(full).not.toContain("-only-testing");
		expect(preview).toContain("Track1Preview.xctestrun");
		const selected = (preview ?? "").match(/-only-testing:\S+/g) ?? [];
		expect(selected).toEqual(previewOnlyTesting.map((test) => `-only-testing:${test}`));
	});

	it("injects the contract base URL into the xctestrun of each scheme through PlistBuddy", async () => {
		const { calls, plistBuddyCalls, result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		for (const scheme of ["Track1", "Track1Preview"]) {
			const injection = plistBuddyCalls.find((call) =>
				new RegExp(
					`TRACK1_CONTRACT_BASE_URL string http://127\\.0\\.0\\.1:\\d+/mobile/v1/ \\S+/${scheme}\\.xctestrun$`,
				).test(call),
			);
			expect(injection, `${scheme}: ${plistBuddyCalls.join("\n")}`).toBeDefined();
		}
	});

	it("verifies the contract report after the full pass only", async () => {
		const { calls, curlCalls, result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(curlCalls.filter((call) => call.includes("__track1_contract_report"))).toHaveLength(1);
		expect(curlCalls.filter((call) => call.includes("__track1_contract_reset"))).toHaveLength(1);
	});

	it("fails when the targeted Track1Preview pass fails, and only then", async () => {
		const { calls, result } = await runCheckScript("test-without-building", {
			env: { TRACK1_TEST_FAIL_XCTESTRUN: "Track1Preview.xctestrun" },
		});

		expect(result.status).not.toBe(0);
		// The full Track1 pass went through before the Preview pass failed.
		expect(testActions(calls)).toHaveLength(2);
	});

	it("lists only tests that exist in the Swift sources", async () => {
		for (const identifier of previewOnlyTesting) {
			const [target, className, testName] = identifier.split("/");
			const files = await swiftFiles(resolve("ios", target ?? ""));
			let found = false;
			for (const file of files) {
				const source = await readFile(file, "utf8");
				found ||= source.includes(`class ${className}:`) && source.includes(`func ${testName}(`);
			}
			expect(found, `${identifier} is not in ios/${target}`).toBe(true);
		}
	});

	// The files of `directory` that read the scheme-dependent configuration and are not in `covered`.
	async function bundleOffenders(directory: string, covered: string[]) {
		const sensitive =
			/Bundle\.main|infoDictionary|bundleIdentifier|SEGMENT_CDN|SegmentAdapter\(|invalid-configuration/;
		const offenders: string[] = [];
		for (const file of await swiftFiles(directory)) {
			const name = file.split("/").pop() ?? "";
			if (sensitive.test(await readFile(file, "utf8")) && !covered.includes(name)) {
				offenders.push(file);
			}
		}
		return offenders;
	}

	it("notices a new test that reads the bundle, a compilation flag or the app identifier", async () => {
		// These files are covered by the Preview list (see check.sh); anything else reading the
		// scheme-dependent configuration must be added to that list first.
		const covered = ["AnalyticsClientTests.swift", "AppConfigurationTests.swift", "NavigationTests.swift"];
		const offenders = [
			...(await bundleOffenders(resolve("ios/Track1Tests"), covered)),
			...(await bundleOffenders(resolve("ios/Track1UITests"), covered)),
			// The package tests run on the host, where no scheme exists: nothing there is covered.
			...(await bundleOffenders(resolve("ios/Track1Core/Tests"), [])),
		];
		expect(offenders).toEqual([]);
	});

	it("fails the bundle guard for Bundle.main under Track1Core/Tests, even in a file named like a covered one", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "track1-bundle-guard-"));
		try {
			const tests = join(fixture, "ios", "Track1Core", "Tests", "Track1CoreTests");
			await mkdir(tests, { recursive: true });
			await writeFile(
				join(tests, "AnalyticsClientTests.swift"),
				'let url = Bundle.main.url(forResource: "a")\n',
			);
			await writeFile(join(tests, "OrdinaryTests.swift"), "struct OrdinaryTests {}\n");

			expect(await bundleOffenders(join(fixture, "ios", "Track1Core", "Tests"), [])).toEqual([
				join(tests, "AnalyticsClientTests.swift"),
			]);
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});
});

describe.sequential("Track1 persistent derived-data cache", () => {
	const dayMilliseconds = 86_400_000;

	it("keys the cache on Xcode, Package.resolved and the ISO week, outside the job output", async () => {
		const key = await expectedCacheKey();
		const { cacheDirectory, calls, outputDirectory, result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(derivedDataPaths(calls, "Track1")).toEqual([join(cacheDirectory, key, "Track1")]);
		expect(derivedDataPaths(calls, "Track1Preview")).toEqual([join(cacheDirectory, key, "Track1Preview")]);
		for (const test of testActions(calls)) {
			expect(test).toContain(`-resultBundlePath ${outputDirectory}/`);
		}
	});

	// 2026-10-12: ios-ci.yml sets HOME=$RUNNER_TEMP/home, emptied at every job, so a cache under HOME would
	// always be cold in CI. The cache root is, by priority: TRACK1_DERIVED_DATA_CACHE_DIR, then
	// $RUNNER_TOOL_CACHE/track1-ci/DerivedData, then $HOME/Library/Caches/track1-ci/DerivedData.
	describe("cache root", () => {
		async function withDirectories<T>(run: (toolCache: string, home: string) => Promise<T>) {
			const toolCache = await mkdtemp(join(tmpdir(), "track1-tool-cache-"));
			const home = await mkdtemp(join(tmpdir(), "track1-home-"));
			try {
				return await run(toolCache, home);
			} finally {
				await rm(toolCache, { recursive: true, force: true });
				await rm(home, { recursive: true, force: true });
			}
		}

		it("uses the runner tool cache, not HOME, when RUNNER_TOOL_CACHE is set", async () => {
			const key = await expectedCacheKey();
			await withDirectories(async (toolCache, home) => {
				const { calls, result } = await runCheckScript(undefined, {
					env: { TRACK1_DERIVED_DATA_CACHE_DIR: "", RUNNER_TOOL_CACHE: toolCache, HOME: home },
				});

				expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
				const root = join(toolCache, "track1-ci", "DerivedData", key);
				expect(derivedDataPaths(calls, "Track1")).toEqual([join(root, "Track1")]);
				expect(derivedDataPaths(calls, "Track1Preview")).toEqual([join(root, "Track1Preview")]);
				expect(await readdir(home)).toEqual([]);
			});
		});

		it("lets TRACK1_DERIVED_DATA_CACHE_DIR win over RUNNER_TOOL_CACHE and HOME", async () => {
			const key = await expectedCacheKey();
			await withDirectories(async (toolCache, home) => {
				const { cacheDirectory, calls, result } = await runCheckScript(undefined, {
					env: { RUNNER_TOOL_CACHE: toolCache, HOME: home },
				});

				expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
				expect(derivedDataPaths(calls, "Track1")).toEqual([join(cacheDirectory, key, "Track1")]);
				expect(await readdir(toolCache)).toEqual([]);
				expect(await readdir(home)).toEqual([]);
			});
		});

		it("falls back to the home directory cache for a local run", async () => {
			const key = await expectedCacheKey();
			await withDirectories(async (toolCache, home) => {
				const { calls, result } = await runCheckScript(undefined, {
					env: { TRACK1_DERIVED_DATA_CACHE_DIR: "", RUNNER_TOOL_CACHE: "", HOME: home },
				});

				expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
				const root = join(home, "Library", "Caches", "track1-ci", "DerivedData", key);
				expect(derivedDataPaths(calls, "Track1")).toEqual([join(root, "Track1")]);
				expect(await readdir(toolCache)).toEqual([]);
			});
		});
	});

	it("builds once on top of a warm cache that works, without falling back", async () => {
		const key = await expectedCacheKey();
		const { calls, result } = await runCheckScript(undefined, {
			beforeRun: async ({ cacheDirectory }) => {
				await mkdir(join(cacheDirectory, key, "Track1", "Build", "Products"), { recursive: true });
			},
		});

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(derivedDataPaths(calls, "Track1")).toHaveLength(1);
		expect(`${result.stdout}${result.stderr}`).not.toContain("cold build");
	});

	it("retries once from an empty folder when a build with the cache fails, and logs it", async () => {
		const key = await expectedCacheKey();
		const { cacheDirectory, calls, result } = await runCheckScript(undefined, {
			env: { TRACK1_TEST_FAIL_WARM_BUILD: "1" },
			beforeRun: async ({ cacheDirectory }) => {
				const warm = join(cacheDirectory, key, "Track1", "Build", "Products");
				await mkdir(warm, { recursive: true });
				await writeFile(join(warm, "stale-object"), "stale\n");
			},
		});

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		const track1Paths = derivedDataPaths(calls, "Track1");
		expect(track1Paths).toEqual([join(cacheDirectory, key, "Track1"), join(cacheDirectory, key, "Track1")]);
		expect(`${result.stdout}${result.stderr}`).toContain("cold build");
		// Track1Preview had no cache: a single attempt, no retry.
		expect(derivedDataPaths(calls, "Track1Preview")).toHaveLength(1);
	});

	it("does not retry a failing build that started from an empty folder", async () => {
		const { calls, result } = await runCheckScript("build-for-testing");

		expect(result.status).not.toBe(0);
		expect(derivedDataPaths(calls, "Track1")).toHaveLength(1);
		expect(`${result.stdout}${result.stderr}`).not.toContain("cold build");
	});

	it("fails after a single cold retry when the build keeps failing", async () => {
		const key = await expectedCacheKey();
		const { calls, result } = await runCheckScript("build-for-testing", {
			beforeRun: async ({ cacheDirectory }) => {
				await mkdir(join(cacheDirectory, key, "Track1", "Build", "Products"), { recursive: true });
			},
		});

		expect(result.status).not.toBe(0);
		expect(derivedDataPaths(calls, "Track1")).toHaveLength(2);
		expect(derivedDataPaths(calls, "Track1Preview")).toHaveLength(0);
	});

	it("keeps the previous cache when the cold retry fails too, since the sources are at fault", async () => {
		const key = await expectedCacheKey();
		const { cacheFiles, result } = await runCheckScript("build-for-testing", {
			beforeRun: async ({ cacheDirectory }) => {
				const products = join(cacheDirectory, key, "Track1", "Build", "Products");
				await mkdir(products, { recursive: true });
				await writeFile(join(products, "warm-object"), "warm\n");
			},
		});

		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("cold build");
		expect(cacheFiles).toContain(join(key, "Track1", "Build", "Products", "warm-object"));
		expect(cacheFiles.filter((file) => file.includes(".failed-"))).toEqual([]);
	});

	it("takes the cache lock for the run and releases it at the end", async () => {
		const key = await expectedCacheKey();
		const { cacheEntries, result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(cacheEntries).toContain(key);
		expect(cacheEntries).not.toContain(`${key}.lock`);
	});

	it("releases the cache lock when the run fails", async () => {
		const key = await expectedCacheKey();
		const { cacheEntries, result } = await runCheckScript("build-for-testing");

		expect(result.status).not.toBe(0);
		expect(cacheEntries).not.toContain(`${key}.lock`);
	});

	it("builds in a private folder while another live check.sh holds the cache lock", async () => {
		const key = await expectedCacheKey();
		const { cacheEntries, calls, outputDirectory, result } = await runCheckScript(undefined, {
			beforeRun: async ({ cacheDirectory }) => {
				const lock = join(cacheDirectory, `${key}.lock`);
				await mkdir(lock, { recursive: true });
				// The vitest worker is alive for the whole test, like a concurrent check.sh would be.
				await writeFile(join(lock, "pid"), `${process.pid}\n`);
			},
		});

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(derivedDataPaths(calls, "Track1")).toEqual([join(outputDirectory, "DerivedData", "Track1")]);
		expect(derivedDataPaths(calls, "Track1Preview")).toEqual([
			join(outputDirectory, "DerivedData", "Track1Preview"),
		]);
		expect(`${result.stdout}${result.stderr}`).toContain("locked by another check.sh");
		// The other run's lock is not ours to release.
		expect(cacheEntries).toContain(`${key}.lock`);
	});

	it("takes over a lock left behind by a process that is gone", async () => {
		const key = await expectedCacheKey();
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		const { cacheDirectory, calls, cacheEntries, result } = await runCheckScript(undefined, {
			beforeRun: async ({ cacheDirectory }) => {
				const lock = join(cacheDirectory, `${key}.lock`);
				await mkdir(lock, { recursive: true });
				await writeFile(join(lock, "pid"), `${deadPid}\n`);
			},
		});

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(derivedDataPaths(calls, "Track1")).toEqual([join(cacheDirectory, key, "Track1")]);
		expect(cacheEntries).not.toContain(`${key}.lock`);
	});

	it("treats a lock without a pid as held while it is young and takes it over once it is old", async () => {
		const key = await expectedCacheKey();
		const old = new Date(Date.now() - 10 * 60_000);
		for (const [date, expectedRoot] of [
			[new Date(), "private"],
			[old, "cache"],
		] as const) {
			const { cacheDirectory, calls, outputDirectory, result } = await runCheckScript(undefined, {
				beforeRun: async ({ cacheDirectory }) => {
					const lock = join(cacheDirectory, `${key}.lock`);
					await mkdir(lock, { recursive: true });
					await utimes(lock, date, date);
				},
			});

			expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
			const root =
				expectedRoot === "cache" ? join(cacheDirectory, key) : join(outputDirectory, "DerivedData");
			expect(derivedDataPaths(calls, "Track1")).toEqual([join(root, "Track1")]);
		}
	});

	it("purges cache keys unused for more than 14 days and keeps the others", async () => {
		const key = await expectedCacheKey();
		const old = new Date(Date.now() - 15 * dayMilliseconds);
		const recent = new Date(Date.now() - 13 * dayMilliseconds);
		const { cacheEntries, result } = await runCheckScript(undefined, {
			beforeRun: async ({ cacheDirectory }) => {
				for (const [name, date] of [
					["Xcode-26.3-OLD-aaaaaaaaaaaa-2026-W01", old],
					["Xcode-26.3-RECENT-bbbbbbbbbbbb-2026-W02", recent],
				] as const) {
					const path = join(cacheDirectory, name);
					await mkdir(join(path, "Track1"), { recursive: true });
					await utimes(path, date, date);
				}
			},
		});

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(cacheEntries).not.toContain("Xcode-26.3-OLD-aaaaaaaaaaaa-2026-W01");
		expect(cacheEntries).toContain("Xcode-26.3-RECENT-bbbbbbbbbbbb-2026-W02");
		expect(cacheEntries).toContain(key);
	});

	it("never purges the key of the current run, even when its folder looks old", async () => {
		const key = await expectedCacheKey();
		const old = new Date(Date.now() - 20 * dayMilliseconds);
		const { cacheEntries, result } = await runCheckScript(undefined, {
			beforeRun: async ({ cacheDirectory }) => {
				const path = join(cacheDirectory, key);
				await mkdir(path, { recursive: true });
				await utimes(path, old, old);
			},
		});

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(cacheEntries).toContain(key);
	});
});

// 2026-10-11: cancelled ios-check runs skipped their cleanup and left booted simulators behind, which
// starved the single macOS runner of memory and made the following runs time out (PR #330).
// 2026-10-12: the first cleanup deleted the simulator of a live run on the second runner of the same Mac
// ("Test crashed with signal term"), so a device is only removed once the process that created it is gone.
describe.sequential("Track1 stale simulator cleanup", () => {
	const ownRun = { GITHUB_RUN_ID: "111", GITHUB_RUN_ATTEMPT: "1" };
	// The pid of a process that has already exited, as left in the name of an abandoned simulator.
	const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
	// The vitest worker running this test is alive for the whole run.
	const livePid = process.pid;
	const ids = {
		iphone: "11111111-1111-1111-1111-111111111111",
		deadA: "22222222-2222-2222-2222-222222222222",
		deadB: "33333333-3333-3333-3333-333333333333",
		ownRun: "44444444-4444-4444-4444-444444444444",
		lookalike: "55555555-5555-5555-5555-555555555555",
		live: "66666666-6666-6666-6666-666666666666",
		noPid: "77777777-7777-7777-7777-777777777777",
	};
	const devices = [
		"== Devices ==",
		"-- iOS 26.4 --",
		`    iPhone 17 Pro (${ids.iphone}) (Booted)`,
		`    track1-ci-222-1-${deadPid} (${ids.deadA}) (Booted)`,
		`    track1-ci-222-2-${deadPid} (${ids.deadB}) (Booted)`,
		`    track1-ci-111-1-${deadPid} (${ids.ownRun}) (Booted)`,
		`    My track1-ci-fake (${ids.lookalike}) (Shutdown)`,
		`    track1-ci-333-1-${livePid} (${ids.live}) (Booted)`,
		`    track1-ci-444-1-abc (${ids.noPid}) (Booted)`,
	].join("\n");
	const staleIds = [ids.deadA, ids.deadB];

	it("shuts down and deletes the track1-ci devices of dead processes and nothing else", async () => {
		const { result, simctlCalls } = await runCheckScript(undefined, { devices, env: ownRun });

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		for (const id of staleIds) {
			expect(simctlCalls).toContain(`simctl shutdown ${id}`);
			expect(simctlCalls).toContain(`simctl delete ${id}`);
		}
		for (const untouched of [ids.iphone, ids.ownRun, ids.lookalike, ids.live, ids.noPid]) {
			expect(simctlCalls.filter((call) => call.includes(untouched))).toEqual([]);
		}
		// Two stale devices (shutdown + delete each), plus a single shutdown of the reusable device at the end.
		expect(simctlCalls.filter((call) => /^simctl (shutdown|delete)/.test(call))).toHaveLength(5);
		// Cleanup happens before the run creates its own simulator.
		const firstCreate = simctlCalls.findIndex((call) => call.startsWith("simctl create"));
		const lastStaleCall = Math.max(...staleIds.map((id) => simctlCalls.lastIndexOf(`simctl delete ${id}`)));
		expect(lastStaleCall).toBeGreaterThanOrEqual(0);
		expect(lastStaleCall).toBeLessThan(firstCreate);
	});

	it("leaves a device alone while the process that created it is alive", async () => {
		const liveDevices = ["== Devices ==", `    track1-ci-333-1-${livePid} (${ids.live}) (Booted)`].join("\n");
		const { result, simctlCalls } = await runCheckScript(undefined, { devices: liveDevices, env: ownRun });

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(simctlCalls.filter((call) => call.includes(ids.live))).toEqual([]);
		expect(simctlCalls.some((call) => call.startsWith("simctl create"))).toBe(true);
	});

	it("keeps the end-of-run cleanup of the ephemeral simulator it creates", async () => {
		const { result, simctlCalls } = await runCheckScript(undefined, {
			devices,
			env: ownRun,
			// A live process holds the reusable device, so this run creates an ephemeral one.
			beforeRun: holdSimulatorLock,
		});

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(simctlCalls.slice(-2)).toEqual(["simctl shutdown simulator-id", "simctl delete simulator-id"]);
	});

	it("continues, logs and still deletes when simctl shutdown fails", async () => {
		const { result, simctlCalls } = await runCheckScript(undefined, {
			devices,
			env: { ...ownRun, TRACK1_TEST_FAIL_SHUTDOWN: "1" },
		});

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stderr).toContain(ids.deadA);
		for (const id of staleIds) {
			expect(simctlCalls).toContain(`simctl delete ${id}`);
		}
		expect(simctlCalls.some((call) => call.startsWith("simctl create"))).toBe(true);
	});

	it("continues when the device list is empty", async () => {
		const { result, simctlCalls } = await runCheckScript(undefined, { env: ownRun });

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(simctlCalls.some((call) => call.startsWith("simctl create"))).toBe(true);
	});
});

// 2026-10-12: ios-check took 7 min 40 warm (TRA-420) and 3 min 50 of it were the boot of a simulator that
// check.sh had just created: the first boot of a device initialises its data container. The device is now
// created once (`track1-ci-pool`) and reused, which only works if nothing leaks from one run to the next.
describe.sequential("Track1 reusable simulator", () => {
	const ownRun = { GITHUB_RUN_ID: "111", GITHUB_RUN_ATTEMPT: "1" };
	const poolUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
	const phoneType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
	const developmentApp = "com.dropcliffs.track1.development";
	const uiTestRunner = "com.dropcliffs.track1.development.uitests.xctrunner";
	const appsListing = [
		"{",
		'    "com.apple.mobilesafari" = {',
		'        CFBundleIdentifier = "com.apple.mobilesafari";',
		"    };",
		`    "${developmentApp}" = {`,
		`        CFBundleIdentifier = "${developmentApp}";`,
		'        GroupContainers = { "group.com.dropcliffs.track1.shared" = "file:///shared"; };',
		// Not installed apps, so not something simctl can uninstall.
		'        CFBundleURLSchemes = ( "com.dropcliffs.track1.oauth" );',
		"    };",
		`    "${uiTestRunner}" = {`,
		`        CFBundleIdentifier = "${uiTestRunner}";`,
		"    };",
		"}",
	].join("\n");

	type FakeDevice = { name?: string; runtime?: string; state?: string; type?: string; udid?: string };
	function devicesJson(...devices: FakeDevice[]) {
		const byRuntime: Record<string, unknown[]> = {};
		for (const device of devices) {
			const runtime = device.runtime ?? "runtime-id";
			byRuntime[runtime] ??= [];
			byRuntime[runtime].push({
				name: device.name ?? "track1-ci-pool",
				udid: device.udid ?? poolUdid,
				state: device.state ?? "Shutdown",
				deviceTypeIdentifier: device.type ?? phoneType,
				isAvailable: true,
			});
		}
		return JSON.stringify({ devices: byRuntime });
	}
	const output = (run: { result: { stdout: string; stderr: string } }) =>
		`${run.result.stdout}\n${run.result.stderr}`;
	const creations = (calls: string[]) => calls.filter((call) => call.startsWith("simctl create"));
	const deletions = (calls: string[]) => calls.filter((call) => call.startsWith("simctl delete"));
	const stateCalls = (calls: string[]) =>
		calls.filter((call) => /^simctl (listapps|uninstall|keychain|privacy)/.test(call));

	it("creates the reusable device on the first run, then boots it", async () => {
		const run = await runCheckScript(undefined, { env: ownRun });

		expect(run.result.status, output(run)).toBe(0);
		expect(creations(run.simctlCalls)).toEqual(["simctl create track1-ci-pool iPhone 17 Pro runtime-id"]);
		expect(run.simctlCalls).toContain("simctl bootstatus simulator-id -b");
		// A brand-new device holds no state: nothing to reset.
		expect(stateCalls(run.simctlCalls)).toEqual([]);
	});

	it("starts the existing device on the next run, without creating one", async () => {
		const run = await runCheckScript(undefined, { env: ownRun, devicesJson: devicesJson({}) });

		expect(run.result.status, output(run)).toBe(0);
		expect(creations(run.simctlCalls)).toEqual([]);
		expect(run.simctlCalls).toContain(`simctl bootstatus ${poolUdid} -b`);
		expect(testActions(run.calls)).toHaveLength(2);
		expect(testActions(run.calls)[0]).toContain(`id=${poolUdid}`);
	});

	it.each([
		["runtime", { runtime: "another-runtime" }],
		["model", { type: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" }],
	])("deletes and recreates the device when its %s is not the expected one", async (_label, device) => {
		const run = await runCheckScript(undefined, { env: ownRun, devicesJson: devicesJson(device) });

		expect(run.result.status, output(run)).toBe(0);
		const deletion = run.simctlCalls.indexOf(`simctl delete ${poolUdid}`);
		const creation = run.simctlCalls.findIndex((call) => call.startsWith("simctl create track1-ci-pool"));
		expect(deletion).toBeGreaterThanOrEqual(0);
		expect(creation).toBeGreaterThan(deletion);
		expect(run.simctlCalls).not.toContain(`simctl bootstatus ${poolUdid} -b`);
		expect(run.simctlCalls).toContain("simctl bootstatus simulator-id -b");
	});

	// 2026-10-15 (TRA-530): this test failed once in CI with `EADDRINUSE`, and the message made it look like it
	// shared the simulator with the other runners. It does not: `xcrun` here is the double written by
	// runCheckScript (first in PATH, with its own device list in TRACK1_TEST_SIMCTL_DEVICES_JSON and its own lock
	// folder in TRACK1_SIMULATOR_LOCK_DIR), so no real simctl call is made and no real `track1-ci-pool` is read or
	// deleted. What it shared was the port of the contract harness, which check.sh starts for real.
	it("keeps only one device named track1-ci-pool", async () => {
		const spare = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
		const run = await runCheckScript(undefined, {
			env: ownRun,
			devicesJson: devicesJson({}, { udid: spare }),
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(run.simctlCalls).toContain(`simctl delete ${spare}`);
		expect(run.simctlCalls).not.toContain(`simctl delete ${poolUdid}`);
		expect(creations(run.simctlCalls)).toEqual([]);
	});

	it("shuts the reusable device down at the end of the run and does not delete it", async () => {
		const run = await runCheckScript(undefined, {
			env: ownRun,
			devicesJson: devicesJson({ state: "Booted" }),
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(run.simctlCalls.at(-1)).toBe(`simctl shutdown ${poolUdid}`);
		expect(deletions(run.simctlCalls)).toEqual([]);
	});

	it("shuts the reusable device down without deleting it when the tests fail", async () => {
		const run = await runCheckScript("test-without-building", {
			env: ownRun,
			devicesJson: devicesJson({}),
		});

		expect(run.result.status).not.toBe(0);
		expect(run.simctlCalls.at(-1)).toBe(`simctl shutdown ${poolUdid}`);
		expect(deletions(run.simctlCalls)).toEqual([]);
	});

	it("uninstalls the Track1 apps and resets keychain and privacy before the first test", async () => {
		const run = await runCheckScript(undefined, {
			env: ownRun,
			devicesJson: devicesJson({}),
			apps: appsListing,
		});

		expect(run.result.status, output(run)).toBe(0);
		const bootedAt = run.simctlCalls.indexOf(`simctl bootstatus ${poolUdid} -b`);
		const firstTestAt = run.simctlCalls.indexOf("xcodebuild test-without-building");
		expect(bootedAt).toBeGreaterThanOrEqual(0);
		expect(firstTestAt).toBeGreaterThan(bootedAt);
		const expectedCalls = [
			`simctl keychain ${poolUdid} reset`,
			...[developmentApp, uiTestRunner].flatMap((bundle) => [
				`simctl privacy ${poolUdid} reset all ${bundle}`,
				`simctl uninstall ${poolUdid} ${bundle}`,
			]),
		];
		for (const call of expectedCalls) {
			const at = run.simctlCalls.indexOf(call);
			expect(at, call).toBeGreaterThan(bootedAt);
			expect(at, call).toBeLessThan(firstTestAt);
		}
		// Neither a system app nor an app group is ours to uninstall, and an erase would bring back the slow first boot.
		expect(run.simctlCalls.filter((call) => call.startsWith("simctl uninstall"))).toHaveLength(2);
		expect(run.simctlCalls.filter((call) => /\berase\b/.test(call))).toEqual([]);
	});

	it("takes the simulator lock for the run and releases it at the end, success or failure", async () => {
		const succeeded = await runCheckScript(undefined, { env: ownRun });
		const failed = await runCheckScript("build-for-testing", { env: ownRun });

		expect(succeeded.result.status, output(succeeded)).toBe(0);
		expect(creations(succeeded.simctlCalls)).toEqual([
			"simctl create track1-ci-pool iPhone 17 Pro runtime-id",
		]);
		expect(succeeded.simulatorLockLeft).toBe(false);
		expect(failed.result.status).not.toBe(0);
		expect(failed.simulatorLockLeft).toBe(false);
	});

	it("uses an ephemeral device while another live check.sh holds the lock, and leaves the lock alone", async () => {
		const run = await runCheckScript(undefined, {
			env: ownRun,
			devicesJson: devicesJson({}),
			apps: appsListing,
			beforeRun: holdSimulatorLock,
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(creations(run.simctlCalls)).toEqual([
			expect.stringMatching(/^simctl create track1-ci-111-1-\d+ iPhone 17 Pro runtime-id$/),
		]);
		expect(output(run)).toContain("ephemeral");
		expect(run.simctlCalls.filter((call) => call.includes(poolUdid))).toEqual([]);
		expect(stateCalls(run.simctlCalls)).toEqual([]);
		expect(run.simctlCalls.slice(-2)).toEqual(["simctl shutdown simulator-id", "simctl delete simulator-id"]);
		expect(run.simulatorLockLeft).toBe(true);
	});

	it("takes over a simulator lock left behind by a process that is gone", async () => {
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		const run = await runCheckScript(undefined, {
			env: ownRun,
			devicesJson: devicesJson({}),
			beforeRun: async ({ simulatorLockDirectory }) => {
				await mkdir(simulatorLockDirectory, { recursive: true });
				await writeFile(join(simulatorLockDirectory, "pid"), `${deadPid}\n`);
			},
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(run.simctlCalls).toContain(`simctl bootstatus ${poolUdid} -b`);
		expect(run.simulatorLockLeft).toBe(false);
	});

	it("deletes a reusable device that does not boot and starts over with a new one, and says so", async () => {
		const run = await runCheckScript(undefined, {
			env: { ...ownRun, TRACK1_TEST_FAIL_BOOT_UDIDS: poolUdid },
			devicesJson: devicesJson({}),
			apps: appsListing,
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(output(run)).toContain("falling back");
		const deletion = run.simctlCalls.indexOf(`simctl delete ${poolUdid}`);
		const creation = run.simctlCalls.findIndex((call) => call.startsWith("simctl create track1-ci-pool"));
		expect(deletion).toBeGreaterThanOrEqual(0);
		expect(creation).toBeGreaterThan(deletion);
		expect(run.simctlCalls).toContain("simctl bootstatus simulator-id -b");
		expect(testActions(run.calls)[0]).toContain("id=simulator-id");
		expect(run.simctlCalls.at(-1)).toBe("simctl shutdown simulator-id");
	});

	it("starts over with a new device when the reusable one cannot be cleaned", async () => {
		const run = await runCheckScript(undefined, {
			env: { ...ownRun, TRACK1_TEST_FAIL_UNINSTALL: "1" },
			devicesJson: devicesJson({}),
			apps: appsListing,
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(output(run)).toContain("falling back");
		expect(run.simctlCalls).toContain(`simctl delete ${poolUdid}`);
		expect(testActions(run.calls)[0]).toContain("id=simulator-id");
	});

	it("uses an ephemeral device when the broken reusable device cannot even be deleted", async () => {
		const run = await runCheckScript(undefined, {
			env: {
				...ownRun,
				TRACK1_TEST_FAIL_BOOT_UDIDS: poolUdid,
				TRACK1_TEST_FAIL_DELETE_UDIDS: poolUdid,
			},
			devicesJson: devicesJson({}),
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(output(run)).toContain("ephemeral");
		expect(creations(run.simctlCalls)).toEqual([
			expect.stringMatching(/^simctl create track1-ci-111-1-\d+ iPhone 17 Pro runtime-id$/),
		]);
		expect(testActions(run.calls)[0]).toContain("id=simulator-id");
		expect(run.simctlCalls.slice(-2)).toEqual(["simctl shutdown simulator-id", "simctl delete simulator-id"]);
		expect(run.simulatorLockLeft).toBe(false);
	});

	it("fails without running any test when the new device does not boot either, and removes it", async () => {
		const run = await runCheckScript(undefined, {
			env: { ...ownRun, TRACK1_TEST_FAIL_BOOT_UDIDS: `${poolUdid} simulator-id` },
			devicesJson: devicesJson({}),
		});

		expect(run.result.status).not.toBe(0);
		expect(testActions(run.calls)).toEqual([]);
		// The reused device is replaced once, and the replacement is removed rather than kept as the pool.
		expect(run.simctlCalls).toContain(`simctl delete ${poolUdid}`);
		expect(creations(run.simctlCalls)).toEqual(["simctl create track1-ci-pool iPhone 17 Pro runtime-id"]);
		expect(run.simctlCalls).toContain("simctl delete simulator-id");
		expect(run.simulatorLockLeft).toBe(false);
	});

	it("does not start over a second time when a device created by this run does not boot", async () => {
		const run = await runCheckScript(undefined, {
			env: { ...ownRun, TRACK1_TEST_FAIL_BOOT_UDIDS: "simulator-id" },
		});

		expect(run.result.status).not.toBe(0);
		expect(creations(run.simctlCalls)).toEqual(["simctl create track1-ci-pool iPhone 17 Pro runtime-id"]);
		expect(run.simctlCalls).toContain("simctl delete simulator-id");
	});

	it("is not touched by the stale simulator cleanup, whichever state the previous run left it in", async () => {
		const devices = ["== Devices ==", "-- iOS 26.4 --", `    track1-ci-pool (${poolUdid}) (Booted)`].join(
			"\n",
		);
		const run = await runCheckScript(undefined, {
			env: ownRun,
			devices,
			devicesJson: devicesJson({ state: "Booted" }),
		});

		expect(run.result.status, output(run)).toBe(0);
		expect(output(run)).not.toContain("Removing stale simulator");
		expect(run.simctlCalls).not.toContain(`simctl delete ${poolUdid}`);
		// It is the device the run reuses, not one it replaces.
		expect(run.simctlCalls).toContain(`simctl bootstatus ${poolUdid} -b`);
		expect(creations(run.simctlCalls)).toEqual([]);
	});
});

// 2026-10-13: a logic error was only known after 4 to 5 min of simulator (TRA-424): the package tests run
// first, on the host, so that a broken one fails the job in under a minute and frees the runner.
describe.sequential("Track1 package tests before the simulator", () => {
	const startsSimulator = (entry: string) => entry === "simctl create" || entry === "simctl bootstatus";

	it("runs swift test once, in the cache, before any simulator or xcodebuild call", async () => {
		const { cacheDirectory, calls, result, swiftCalls, timeline } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(swiftCalls).toEqual([
			`test --package-path ${resolve("ios/Track1Core")} --scratch-path ${join(cacheDirectory, await expectedCacheKey(), "Track1Core", ".build")} --skip-update`,
		]);
		expect(timeline[0]).toBe("swift");
		expect(timeline.filter((entry) => entry === "swift")).toHaveLength(1);
		expect(timeline.findIndex(startsSimulator)).toBeGreaterThan(0);
		// Unchanged: two builds and two test runs, nothing else.
		const actions = calls
			.split("\n")
			.filter((call) => /(^| )(build-for-testing|test-without-building)( |$)/.test(call));
		expect(actions).toHaveLength(4);
		expect(actions.filter((call) => /(^| )build-for-testing( |$)/.test(call))).toHaveLength(2);
		expect(testActions(calls)).toHaveLength(2);
	});

	it("falls back to a private scratch folder when the cache is unusable, still under DerivedData", async () => {
		const { calls, result, swiftCalls } = await runCheckScript(undefined, {
			env: { TRACK1_DERIVED_DATA_CACHE_DIR: "", RUNNER_TOOL_CACHE: "", HOME: "" },
		});

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(swiftCalls[0]).toMatch(/--scratch-path \S+\/DerivedData\/Track1Core\/\.build /);
	});

	it("stops with a failing swift test before any simulator, build or test action, and still cleans up", async () => {
		const run = await runCheckScript(undefined, { env: { TRACK1_TEST_SWIFT_MODE: "fail" } });

		expect(run.result.status).toBe(1);
		expect(run.swiftCalls).toHaveLength(1);
		expect(run.calls).toBe("");
		expect(run.timeline.filter(startsSimulator)).toEqual([]);
		expect(run.simctlCalls.filter((call) => /^simctl (create|bootstatus)/.test(call))).toEqual([]);
		// cleanup ran: the lock of the DerivedData cache, taken before swift test, is released.
		expect(run.cacheEntries.filter((entry) => entry.endsWith(".lock"))).toEqual([]);
		expect(run.simulatorLockLeft).toBe(false);
	});

	it("kills the process group of a swift test that never returns, and names the delay", async () => {
		const run = await runCheckScript(undefined, {
			env: { TRACK1_TEST_SWIFT_MODE: "hang", TRACK1_SWIFT_TEST_TIMEOUT_SECONDS: "1" },
		});

		expect(run.result.status).toBe(1);
		expect(run.elapsedMilliseconds).toBeLessThan(10_000);
		expect(run.result.stderr).toContain("TRACK1_SWIFT_TEST_TIMEOUT_SECONDS");
		expect(run.result.stderr).toContain("within 1s");
		// The fake swift and the `sleep` it started: both gone.
		expect(run.swiftSurvivors).toEqual([]);
		expect(run.calls).toBe("");
		expect(run.cacheEntries.filter((entry) => entry.endsWith(".lock"))).toEqual([]);
	});

	// 2026-10-19 (TRA-643): on a loaded Mac the cold start of tsx took longer than the 5 s that check.sh waited for
	// the ready file, so ios-check failed with "did not publish its XCTest base URL" on a diff that touched no TS.
	it("waits for a slow harness start, 6 s here, instead of giving up after 5 s", async () => {
		const run = await runCheckScript(undefined, { harnessStartPrelude: "sleep 6" });

		const output = `${run.result.stdout}\n${run.result.stderr}`;
		expect(output).not.toContain("did not publish its XCTest base URL");
		// The harness is started in the simulator-boot step. The assertion stops there on purpose: the steps after it
		// need a real Xcode, and the other tests of this file already check that a whole run succeeds.
		expect(output).toMatch(/\[check\] simulator-boot: \d+s\n/);
		expect(run.elapsedMilliseconds).toBeGreaterThanOrEqual(6_000);
	});

	it("fails at once when the harness dies before it publishes its URL, without waiting for the budget", async () => {
		const run = await runCheckScript(undefined, {
			harnessStartPrelude: "echo 'harness crashed at boot' >&2; exit 3",
		});

		expect(run.result.status).not.toBe(0);
		expect(run.result.stderr).toContain("harness crashed at boot");
		expect(run.result.stderr).not.toContain("did not publish its XCTest base URL");
		// The wait is 30 s; a harness that is already dead must not use any of it.
		expect(run.elapsedMilliseconds).toBeLessThan(15_000);
	});

	it("rejects a timeout that is not a number of seconds, before running anything", async () => {
		const run = await runCheckScript(undefined, { env: { TRACK1_SWIFT_TEST_TIMEOUT_SECONDS: "soon" } });

		expect(run.result.status).toBe(1);
		expect(run.result.stderr).toContain("TRACK1_SWIFT_TEST_TIMEOUT_SECONDS");
		expect(run.swiftCalls).toEqual([]);
	});

	it("lints the package sources and tests, but not its .build folder", async () => {
		const { result, swiftFormatArguments } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const swiftSources = swiftFormatArguments.filter((argument) => argument.endsWith(".swift"));
		const coreRoot = resolve("ios/Track1Core");
		expect(swiftSources.some((file) => file.startsWith(join(coreRoot, "Sources") + "/"))).toBe(true);
		expect(swiftSources.some((file) => file.startsWith(join(coreRoot, "Tests") + "/"))).toBe(true);
		expect(swiftSources.filter((file) => file.includes("/.build/"))).toEqual([]);
	});
});

// 2026-10-13: nothing told which step of ios-check was slow; each step now ends with a `[check]` line.
describe.sequential("Track1 step durations", () => {
	const stepLines = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("[check] "));

	it("prints one duration line per step, then the total", async () => {
		const { result } = await runCheckScript();

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(stepLines(result.stdout).map((line) => line.replace(/\d+s$/, "<n>s"))).toEqual([
			"[check] lint: <n>s",
			"[check] package-tests: <n>s",
			"[check] resolve: <n>s",
			"[check] simulator-boot: <n>s",
			"[check] build-Track1: <n>s",
			"[check] tests-Track1: <n>s",
			"[check] build-Track1Preview: <n>s",
			"[check] tests-Track1Preview: <n>s",
			"[check] total: <n>s",
		]);
	});

	it("names the step that failed and still prints the total", async () => {
		const { result } = await runCheckScript(undefined, { env: { TRACK1_TEST_SWIFT_MODE: "fail" } });

		expect(result.status).toBe(1);
		expect(stepLines(result.stdout).map((line) => line.replace(/\d+s/, "<n>s"))).toEqual([
			"[check] lint: <n>s",
			"[check] package-tests: <n>s (failed)",
			"[check] total: <n>s",
		]);
	});
});

describe.sequential("Track1 Swift format coverage", () => {
	it("discovers every first-party Swift file and stops before build actions on a violation", async () => {
		const { calls, expectedSwiftFiles, fixtureRoot, result, swiftCalls, swiftFormatArguments } =
			await runSwiftFixtureCheck({ badSource: true });

		expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
		expect(calls).toBe("");
		expect(swiftCalls).toEqual([]);
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
		expect(swiftFormatArguments).not.toContain(
			join(fixtureRoot, "ios", "Track1Core", ".build", "checkouts", "Ignored.swift"),
		);
		expect(await pathExists(fixtureRoot)).toBe(false);
	});

	it("passes the same fixture when the newly discovered source is conforming", async () => {
		const { calls, expectedSwiftFiles, fixtureRoot, result, swiftCalls, swiftFormatArguments } =
			await runSwiftFixtureCheck();

		expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
		expect(swiftFormatArguments.slice(5)).toEqual([...expectedSwiftFiles].sort());
		expect(swiftCalls).toHaveLength(1);
		expect(await pathExists(fixtureRoot)).toBe(false);
	});

	it.each([
		[
			"a missing source root",
			{ missingRoot: "Track1UITests" as const },
			"Expected Swift source root is missing or is a symlink",
		],
		[
			"a missing package root",
			{ missingRoot: "Track1Core" as const },
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

// 2026-10-15 (TRA-530): the job `test` of #426 failed with `listen EADDRINUSE :::56773`, and the runner of the
// Mac hosted four contract harnesses whose job was long gone (parent 1, 4 h to 2 days old, each one listening on
// two ports). Two causes:
// - the harness picked the port of its upstream server with a probe (bind 127.0.0.1:0, close, hand the number
//   to src/server.ts, which listens on every interface). On macOS a bind on 127.0.0.1:N succeeds while another
//   process holds *:N, so the probe could return a port that the real listen then found taken;
// - a job killed with SIGKILL (a cancelled run) never reaches the trap of check.sh, so nothing stopped the harness.
// These tests start the real harness (the doubles of the other tests only replace Xcode and simctl).
describe.sequential("Track1 contract harness lifecycle", () => {
	const harness = resolve("test/helpers/mobile-contract-server.ts");
	// 2026-10-21 (TRA-650): lsof lives in /usr/sbin on macOS and /usr/bin on Ubuntu (spawnSync ENOENT there), so it
	// is looked up in PATH when the macOS location does not exist.
	const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
	// The same environment as start_contract_harness in check.sh.
	function harnessEnvironment(directory: string) {
		return {
			PATH: process.env.PATH ?? "",
			ODYSSEY_CACHE_DIR: join(directory, "cache"),
			MOBILE_STATE_DIR: join(directory, "mobile-state"),
			STREAM_CACHE_DIR: join(directory, "stream-cache"),
			MB_BASE_URL: "http://127.0.0.1:1",
			MOBILE_PUSH_ENABLED: "false",
			MOBILE_APNS_PUSH_ENABLED: "false",
			GEMINI_API_KEY: "contract-test-only",
			TAVILY_API_KEY: "contract-test-only",
			FIRECRAWL_API_KEY: "contract-test-only",
		};
	}

	async function waitFor(condition: () => Promise<boolean> | boolean, what: string, seconds = 60) {
		for (let attempt = 0; attempt < seconds * 20; attempt++) {
			if (await condition()) return;
			await new Promise((done) => setTimeout(done, 50));
		}
		throw new Error(`Timed out waiting for ${what}.`);
	}

	async function readyBaseURL(readyFile: string) {
		await waitFor(async () => (await readFile(readyFile, "utf8").catch(() => "")).endsWith("\n"), readyFile);
		return (await readFile(readyFile, "utf8")).trim();
	}

	// Never 0 or 1: kill(0) signals the whole process group, the vitest worker included.
	function killQuietly(pid: number | undefined) {
		if (pid === undefined || pid <= 1) return;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}

	// The addresses a process listens on, as `lsof -Fn` prints them (`n127.0.0.1:62796`, `n*:62794`).
	function listeningAddresses(pid: number) {
		const listing = spawnSync(lsof, ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-nP", "-Fn"], {
			encoding: "utf8",
		});
		expect(listing.error, `${lsof} is required by this test`).toBeUndefined();
		return listing.stdout
			.split("\n")
			.filter((line) => line.startsWith("n"))
			.map((line) => line.slice(1));
	}

	it("listens on loopback only, with ports chosen by the system and published through the ready file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "track1-harness-"));
		const readyFiles = [join(directory, "ready-1"), join(directory, "ready-2"), join(directory, "ready-3")];
		const children = readyFiles.map((readyFile, index) =>
			spawn(process.execPath, ["--import", "tsx", harness, "--ready-file", readyFile], {
				cwd: resolve("."),
				env: harnessEnvironment(join(directory, `run-${index}`)),
				stdio: "ignore",
			}),
		);
		try {
			const baseURLs = await Promise.all(readyFiles.map(readyBaseURL));
			const published = baseURLs.map((url) =>
				Number(url.match(/^http:\/\/127\.0\.0\.1:(\d+)\/mobile\/v1\/$/)?.[1]),
			);
			expect(published.every((port) => port > 0)).toBe(true);
			expect(new Set(published).size).toBe(3);
			const addresses = children.flatMap((child) => listeningAddresses(child.pid as number));
			// The upstream server and the proxy of each harness, none of them reachable from the network.
			expect(addresses).toHaveLength(6);
			for (const address of addresses) {
				expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
			}
			expect(new Set(addresses).size).toBe(6);
		} finally {
			for (const child of children) killQuietly(child.pid);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("dies with its parent when the parent is killed without a chance to clean up", async () => {
		const directory = await mkdtemp(join(tmpdir(), "track1-harness-"));
		const readyFile = join(directory, "ready");
		const pidFile = join(directory, "harness-pid");
		// A stand-in for check.sh: it starts the harness in the background, then waits.
		const parent = spawn(
			"bash",
			[
				"-c",
				'node --import tsx "$1" --ready-file "$2" >/dev/null 2>&1 & echo $! >"$3"; wait',
				"bash",
				harness,
				readyFile,
				pidFile,
			],
			{ cwd: resolve("."), env: { ...harnessEnvironment(directory) }, stdio: "ignore" },
		);
		let harnessPid: number | undefined;
		try {
			await readyBaseURL(readyFile);
			harnessPid = Number((await readFile(pidFile, "utf8")).trim());
			expect(harnessPid).toBeGreaterThan(1);
			expect(isAlive(harnessPid)).toBe(true);
			// SIGKILL: the same as a cancelled job, no trap runs.
			parent.kill("SIGKILL");
			await waitFor(
				() => !isAlive(harnessPid as number),
				"the harness to exit after its parent was killed",
				15,
			);
		} finally {
			killQuietly(parent.pid);
			killQuietly(harnessPid);
			await rm(directory, { recursive: true, force: true });
		}
	});

	describe("orphan cleanup at the start of check.sh", () => {
		const pids: number[] = [];
		// A process whose command line looks like a harness of `path`. Orphan: its parent is gone (pid 1).
		function decoy(path: string, orphan: boolean) {
			const code = "setTimeout(() => {}, 600000)";
			if (!orphan) {
				const child = spawn(process.execPath, ["-e", code, path, "--ready-file", "decoy"], {
					stdio: "ignore",
				});
				pids.push(child.pid ?? 0);
				return child.pid ?? 0;
			}
			const launched = spawnSync(
				"bash",
				[
					"-c",
					'"$1" -e "$2" "$3" --ready-file decoy >/dev/null 2>&1 & echo $!',
					"bash",
					process.execPath,
					code,
					path,
				],
				{ encoding: "utf8" },
			);
			const pid = Number(launched.stdout.trim());
			expect(pid).toBeGreaterThan(1);
			pids.push(pid);
			return pid;
		}
		async function waitUntilOrphan(pid: number) {
			await waitFor(
				() => spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim() === "1",
				`process ${pid} to be reparented`,
				10,
			);
		}

		it("stops the orphaned harnesses of its own checkout and leaves every other process alone", async () => {
			const ownOrphan = decoy(harness, true);
			const ownLive = decoy(harness, false);
			const otherCheckout = "/nonexistent/actions-runner-other/_work/odyssey-music/odyssey-music";
			const otherOrphan = decoy(`${otherCheckout}/test/helpers/mobile-contract-server.ts`, true);
			// The folder of this checkout is a prefix of this one, but it is another checkout.
			const siblingOrphan = decoy(`${harness.replace("/test/helpers/", "-2/test/helpers/")}`, true);
			try {
				await Promise.all([ownOrphan, otherOrphan, siblingOrphan].map(waitUntilOrphan));
				const run = await runCheckScript(undefined, {
					env: { GITHUB_RUN_ID: "112", GITHUB_RUN_ATTEMPT: "1" },
				});

				expect(run.result.status, `${run.result.stdout}\n${run.result.stderr}`).toBe(0);
				expect(run.result.stdout).toContain(`Removing orphan contract harness ${ownOrphan}`);
				await waitFor(() => !isAlive(ownOrphan), "the orphan to be stopped", 10);
				expect(isAlive(ownLive), "a harness whose job is alive").toBe(true);
				expect(isAlive(otherOrphan), "the orphan of another checkout").toBe(true);
				expect(isAlive(siblingOrphan), "the orphan of a sibling folder").toBe(true);
			} finally {
				for (const pid of pids.splice(0)) killQuietly(pid);
			}
		});
	});
});
