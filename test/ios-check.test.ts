import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function runCheckScript(failingAction?: "build-for-testing" | "test-without-building") {
	const directory = await mkdtemp(join(tmpdir(), "track1-ios-check-"));
	const callsPath = join(directory, "xcodebuild-calls");
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
  "simctl bootstatus"* | "simctl shutdown"* | "simctl delete"* | "swift-format lint"*) exit 0 ;;
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
			},
		});
		const calls = await readFile(callsPath, "utf8").catch(() => "");
		return { calls, result };
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

	it.each(["build-for-testing", "test-without-building"] as const)(
		"propagates a failing %s action",
		async (failingAction) => {
			const { result } = await runCheckScript(failingAction);
			expect(result.status).not.toBe(0);
		},
	);
});
