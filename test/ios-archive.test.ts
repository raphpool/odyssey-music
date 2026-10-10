import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const archiveScript = resolve("ios/scripts/archive.sh");
const exportOptionsPath = resolve("ios/Configurations/ExportOptions-Preview.plist");
const teamId = "ABCDE12345";
const apiBaseUrl = "https://api.example.org/mobile/v1";

// Fake tools log their arguments into $TRACK1_TEST_LOG_DIR and are driven by environment variables,
// so the script runs on any platform without Xcode, a signing identity or a network.
const fakeTools: Record<string, string> = {
	xcodebuild: `#!/usr/bin/env bash
if [[ "$1" == "-version" ]]; then
  printf '%s\\n' "$TRACK1_TEST_XCODE_VERSION"
  exit 0
fi
printf '%s\\n' "$*" >> "$TRACK1_TEST_LOG_DIR/xcodebuild-calls"
while (($#)); do
  case "$1" in
    -archivePath) archive_path="$2"; shift 2 ;;
    -exportPath) export_path="$2"; shift 2 ;;
    -exportOptionsPlist) options_path="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "\${options_path:-}" ]]; then
  cp "$options_path" "$TRACK1_TEST_LOG_DIR/export-options.plist"
  mkdir -p "$export_path"
  : > "$export_path/Track1.ipa"
else
  mkdir -p "$archive_path"
fi
`,
	plutil: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TRACK1_TEST_LOG_DIR/plutil-calls"
case "$1" in
  -replace) printf '%s=%s\\n' "$2" "$4" >> "$5" ;;
  -extract)
    case "$2" in
      CFBundleShortVersionString) printf '1.0.0\\n' ;;
      CFBundleVersion) printf '202610101200\\n' ;;
    esac ;;
esac
`,
	unzip: `#!/usr/bin/env bash
mkdir -p "$4/Payload/Track1.app"
`,
	codesign: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TRACK1_TEST_LOG_DIR/codesign-calls"
printf 'Identifier=%s\\nTeamIdentifier=%s\\n' "$TRACK1_TEST_SIGNED_IDENTIFIER" "$TRACK1_TEST_SIGNED_TEAM" >&2
`,
	git: `#!/usr/bin/env bash
case "$*" in
  *"status --porcelain"*) printf '%s' "$TRACK1_TEST_GIT_STATUS" ;;
  *"rev-parse HEAD"*) printf '0123456789abcdef0123456789abcdef01234567\\n' ;;
  *) exit 1 ;;
esac
`,
};

type ArchiveOptions = {
	apiBaseUrl?: string | undefined;
	gitStatus?: string;
	outputInsideRepository?: boolean;
	signedIdentifier?: string;
	signedTeam?: string;
	teamId?: string | undefined;
	xcodeVersion?: string;
};

async function installedXcodeVersion() {
	const expected = (await readFile(resolve("ios/.xcode-version"), "utf8")).trim();
	const match = expected.match(/^Xcode (\S+) \((\S+)\)$/);
	expect(match, `Unexpected ios/.xcode-version: ${expected}`).not.toBeNull();
	return `Xcode ${match?.[1]}\nBuild version ${match?.[2]}`;
}

async function runArchive(options: ArchiveOptions = {}) {
	const directory = await mkdtemp(join(tmpdir(), "track1-ios-archive-"));
	const toolDirectory = join(directory, "tools");
	const logDirectory = join(directory, "logs");
	const outputDirectory = join(directory, "output");
	try {
		await mkdir(toolDirectory, { recursive: true });
		await mkdir(logDirectory, { recursive: true });
		for (const [name, contents] of Object.entries(fakeTools)) {
			await writeFile(join(toolDirectory, name), contents, { mode: 0o755 });
			await chmod(join(toolDirectory, name), 0o755);
		}
		const environment: NodeJS.ProcessEnv = {
			...process.env,
			PATH: `${toolDirectory}:${process.env.PATH ?? ""}`,
			TRACK1_TEST_GIT_STATUS: options.gitStatus ?? "",
			TRACK1_TEST_LOG_DIR: logDirectory,
			TRACK1_TEST_SIGNED_IDENTIFIER: options.signedIdentifier ?? "com.dropcliffs.track1.preview",
			TRACK1_TEST_SIGNED_TEAM: options.signedTeam ?? teamId,
			TRACK1_TEST_XCODE_VERSION: options.xcodeVersion ?? (await installedXcodeVersion()),
		};
		delete environment.TRACK1_TEAM_ID;
		delete environment.TRACK1_API_BASE_URL;
		if ("teamId" in options) {
			if (options.teamId !== undefined) environment.TRACK1_TEAM_ID = options.teamId;
		} else {
			environment.TRACK1_TEAM_ID = teamId;
		}
		if ("apiBaseUrl" in options) {
			if (options.apiBaseUrl !== undefined) environment.TRACK1_API_BASE_URL = options.apiBaseUrl;
		} else {
			environment.TRACK1_API_BASE_URL = apiBaseUrl;
		}
		const result = spawnSync(
			"bash",
			[archiveScript, options.outputInsideRepository ? resolve("ios") : outputDirectory],
			{ cwd: directory, encoding: "utf8", env: environment },
		);
		const read = (name: string) => readFile(join(logDirectory, name), "utf8").catch(() => "");
		return {
			codesignCalls: await read("codesign-calls"),
			exportOptions: await read("export-options.plist"),
			plutilCalls: await read("plutil-calls"),
			result,
			xcodebuildCalls: (await read("xcodebuild-calls")).split("\n").filter(Boolean),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe.sequential("Track1 signed Preview archive script", () => {
	it("archives the Preview scheme with the supplied team and API URL, then exports an ad hoc IPA", async () => {
		const { codesignCalls, exportOptions, plutilCalls, result, xcodebuildCalls } = await runArchive();

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(xcodebuildCalls).toHaveLength(2);
		const [archiveCall, exportCall] = xcodebuildCalls.map((call) => call.split(" "));
		expect(archiveCall?.[0]).toBe("archive");
		expect(archiveCall).toEqual(
			expect.arrayContaining([
				"-scheme",
				"Track1Preview",
				"-configuration",
				"Preview",
				"-destination",
				"generic/platform=iOS",
				"-allowProvisioningUpdates",
				"CODE_SIGNING_ALLOWED=YES",
				"CODE_SIGNING_REQUIRED=YES",
				"CODE_SIGN_STYLE=Automatic",
				`DEVELOPMENT_TEAM=${teamId}`,
				`TRACK1_API_BASE_URL=${apiBaseUrl}`,
			]),
		);
		expect(archiveCall?.some((argument) => /^CURRENT_PROJECT_VERSION=\d{12}$/.test(argument))).toBe(true);
		expect(archiveCall?.some((argument) => argument.endsWith("ios/Track1.xcodeproj"))).toBe(true);
		expect(exportCall).toContain("-exportArchive");
		expect(exportCall).toContain("-allowProvisioningUpdates");
		expect(plutilCalls).toContain(`-replace teamID -string ${teamId}`);
		expect(exportOptions).toContain("<string>release-testing</string>");
		expect(exportOptions).toContain("<string>automatic</string>");
		expect(exportOptions).toContain(`teamID=${teamId}`);
		expect(codesignCalls).toContain("Payload/Track1.app");
		expect(result.stdout).toContain("0123456789abcdef0123456789abcdef01234567");
		expect(result.stdout).toContain("1.0.0");
		expect(result.stdout).toContain("202610101200");
		expect(result.stdout).toContain(apiBaseUrl);
		expect(result.stdout).toMatch(/IPA: +\S+\/export\/Track1\.ipa/);
	});

	it.each([
		["a missing Team ID", { teamId: undefined }, "TRACK1_TEAM_ID is required"],
		["a short Team ID", { teamId: "ABCDE1234" }, "TRACK1_TEAM_ID is required"],
		["a lowercase Team ID", { teamId: "abcde12345" }, "TRACK1_TEAM_ID is required"],
		["a Team ID with a trailing newline", { teamId: "ABCDE12345\n" }, "TRACK1_TEAM_ID is required"],
		["a missing API URL", { apiBaseUrl: undefined }, "TRACK1_API_BASE_URL is required"],
		["an http API URL", { apiBaseUrl: "http://api.example.org/v1" }, "must start with https://"],
		["an API URL with credentials", { apiBaseUrl: "https://user:pw@api.example.org/v1" }, "credentials"],
		["an API URL with an explicit port", { apiBaseUrl: "https://api.example.org:8443/v1" }, "explicit port"],
		["a placeholder .example host", { apiBaseUrl: "https://preview.track1.example" }, "placeholder"],
		[
			"a placeholder .EXAMPLE host with a path",
			{ apiBaseUrl: "https://API.Track1.EXAMPLE/v1" },
			"placeholder",
		],
		["an API URL ending with .example", { apiBaseUrl: "https://api.example.org/v1.example" }, "placeholder"],
		["an API URL with a query", { apiBaseUrl: "https://api.example.org/v1?a=b" }, "plain path"],
		[
			"an API URL with a build-setting reference",
			{ apiBaseUrl: "https://api.example.org/$(HOME)" },
			"plain path",
		],
		["an API URL with a space", { apiBaseUrl: "https://api.example.org/a b" }, "plain path"],
		["an API URL with a trailing newline", { apiBaseUrl: "https://api.example.org/v1\n" }, "plain path"],
		["an API URL without a dotted host", { apiBaseUrl: "https://localhost/v1" }, "plain path"],
		["another Xcode version", { xcodeVersion: "Xcode 26.3\nBuild version 17C529" }, "Expected Xcode 26.4"],
		["a dirty git tree", { gitStatus: " M ios/Track1/App/AppContainer.swift\n" }, "uncommitted changes"],
		["an untracked file", { gitStatus: "?? ios/notes.txt\n" }, "uncommitted changes"],
		["an output directory inside the repository", { outputInsideRepository: true }, "outside the repository"],
	] as const satisfies ReadonlyArray<readonly [string, ArchiveOptions, string]>)(
		"stops before any xcodebuild archive for %s",
		async (_label, options, expectedError) => {
			const { result, xcodebuildCalls } = await runArchive(options);

			expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
			expect(result.stderr).toContain(expectedError);
			expect(xcodebuildCalls).toEqual([]);
		},
	);

	it.each([
		["another team", { signedTeam: "ZZZZZ99999" }, "signed by team 'ZZZZZ99999'"],
		[
			"another bundle identifier",
			{ signedIdentifier: "com.dropcliffs.track1" },
			"signed as 'com.dropcliffs.track1'",
		],
		["no identifier", { signedIdentifier: "" }, "signed as ''"],
	] as const satisfies ReadonlyArray<readonly [string, ArchiveOptions, string]>)(
		"fails when codesign reports %s",
		async (_label, options, expectedError) => {
			const { codesignCalls, result } = await runArchive(options);

			expect(codesignCalls).not.toBe("");
			expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
			expect(result.stderr).toContain(expectedError);
			expect(result.stdout).not.toContain("IPA:");
		},
	);

	it("keeps hosts out of the repository and signing out of the CI", async () => {
		const script = await readFile(archiveScript, "utf8");
		const exportOptions = await readFile(exportOptionsPath, "utf8");
		const checkScript = await readFile(resolve("ios/scripts/check.sh"), "utf8");
		const iosWorkflow = await readFile(resolve(".github/workflows/ios-ci.yml"), "utf8");
		const baseConfiguration = await readFile(resolve("ios/Configurations/Base.xcconfig"), "utf8");

		expect(script).not.toMatch(/dropcliffs\.com|https:\/\/[A-Za-z0-9]/);
		expect(exportOptions).not.toContain("dropcliffs");
		expect(exportOptions).not.toContain("teamID");
		expect(baseConfiguration).toContain("CODE_SIGNING_ALLOWED = NO");
		expect(baseConfiguration).toContain("CODE_SIGNING_REQUIRED = NO");
		for (const unchanged of [checkScript, iosWorkflow]) {
			expect(unchanged).not.toMatch(/archive\.sh|-exportArchive|TRACK1_TEAM_ID|allowProvisioningUpdates/);
			expect(unchanged).not.toContain("CODE_SIGNING_ALLOWED=YES");
		}
		expect(checkScript).toContain("CODE_SIGNING_ALLOWED=NO");
	});
});
