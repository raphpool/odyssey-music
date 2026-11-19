import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const script = resolve("ios/scripts/testflight.sh");
const teamId = "ABCDE12345";
const apiBaseUrl = "https://api.example.org/mobile/v1";
const profileName = "Track1 App & Store";
const keyBody = "-----BEGIN PRIVATE KEY-----TOP-SECRET-KEY-BODY";

// Fake tools log their arguments (each followed by "|") into $TRACK1_TEST_LOG_DIR; no Xcode is needed.
const fakeTools: Record<string, string> = {
	xcodebuild: `#!/usr/bin/env bash
[[ "$1" == "-version" ]] && { read -r _ v b < <(tr -d '()' < "$TRACK1_TEST_XCODE_FILE"); printf 'Xcode %s\\nBuild version %s\\n' "$v" "$b"; exit 0; }
{ printf '%s|' "$@"; echo; } >> "$TRACK1_TEST_LOG_DIR/xcodebuild-calls"
if [[ "$1" == archive ]]; then
  mkdir -p "\${11}/Products/Applications/Track1.app"
else
  cp "$7" "$TRACK1_TEST_LOG_DIR/export-options.plist"; mkdir -p "$5"; : > "$5/Track1.ipa"
fi
`,
	plutil: `#!/usr/bin/env bash
[[ "$1" == "-replace" ]] && printf '%s=%s\\n' "$2" "$4" >> "$5"
url="\${TRACK1_TEST_PLIST_API_URL-$TRACK1_API_BASE_URL}"
[[ "$*" == *.xcarchive* ]] || url="\${TRACK1_TEST_EXPORTED_URL-$url}"
[[ "$1" == "-extract" && "$2" == Track1APIBaseURL ]] && printf '%s\\n' "$url"
[[ "$1" == "-extract" && "$2" != Track1APIBaseURL ]] && printf '1.0.0\\n'
exit 0
`,
	git: `#!/usr/bin/env bash
[[ "$*" == *"status --porcelain"* ]] && printf '%s' "$TRACK1_TEST_GIT_STATUS"
[[ "$*" == *"rev-parse HEAD"* ]] && printf '0123456789abcdef0123456789abcdef01234567\\n'
exit 0
`,
	unzip: `#!/usr/bin/env bash
mkdir -p "$4/Payload/Track1.app"
`,
	codesign: `#!/usr/bin/env bash
team="\${TRACK1_TEST_SIGNED_TEAM-ABCDE12345}"; identifier="\${TRACK1_TEST_SIGNED_IDENTIFIER-com.dropcliffs.track1}"
# Only the app inside the .xcarchive is the archived one; any other path is the exported IPA.
[[ "$*" == *.xcarchive* ]] || { team="\${TRACK1_TEST_EXPORTED_TEAM-$team}"; identifier="\${TRACK1_TEST_EXPORTED_IDENTIFIER-$identifier}"; }
printf 'Identifier=%s\\nTeamIdentifier=%s\\n' "$identifier" "$team" >&2
`,
};

async function run(overrides: Record<string, string | undefined> = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "track1-ios-testflight-")));
	try {
		await writeFile(join(directory, "AuthKey.p8"), keyBody);
		await writeFile(join(directory, "other-xcode"), "Xcode 1.0 (1A1)");
		for (const [name, body] of Object.entries(fakeTools))
			await writeFile(join(directory, name), body, { mode: 0o755 });
		const result = spawnSync("bash", [script, join(directory, "output")], {
			cwd: directory,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${directory}:${process.env.PATH ?? ""}`,
				TRACK1_TEAM_ID: teamId,
				TRACK1_API_BASE_URL: apiBaseUrl,
				TRACK1_PROFILE_NAME: profileName,
				TRACK1_UPLOAD: undefined,
				ASC_KEY_PATH: join(directory, "AuthKey.p8"),
				ASC_KEY_ID: "KEYID12345",
				ASC_ISSUER_ID: "issuer-uuid",
				TRACK1_TEST_LOG_DIR: directory,
				TRACK1_TEST_XCODE_FILE: resolve("ios/.xcode-version"),
				...overrides,
			},
		});
		const read = (name: string) => readFile(join(directory, name), "utf8").catch(() => "");
		const normalize = (line: string) =>
			line
				.replaceAll(directory, "<tmp>")
				.replaceAll(/track1-testflight\.\w+/g, "<run>")
				.replace(resolve("ios"), "<ios>")
				.replace(/CURRENT_PROJECT_VERSION=\d{12}/, "CURRENT_PROJECT_VERSION=<build>");
		const calls = (await read("xcodebuild-calls")).split("\n").filter(Boolean).map(normalize);
		return { calls, exportOptions: await read("export-options.plist"), result };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe.sequential("Track1 TestFlight archive script", () => {
	it("archives Production with the team and profile for its xcconfig, then exports with the API key", async () => {
		const { calls, exportOptions, result } = await run();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		// The work directory is a fresh <run> folder under the output directory, itself outside the repository.
		expect(calls).toEqual([
			`archive|-project|<ios>/Track1.xcodeproj|-scheme|Track1|-configuration|Production|-destination|generic/platform=iOS|-archivePath|<tmp>/output/<run>/Track1.xcarchive|-onlyUsePackageVersionsFromResolvedFile|-disableAutomaticPackageResolution|TRACK1_TEAM_ID=${teamId}|TRACK1_PROFILE_NAME=${profileName}|TRACK1_API_BASE_URL=${apiBaseUrl}|CURRENT_PROJECT_VERSION=<build>|`,
			"-exportArchive|-archivePath|<tmp>/output/<run>/Track1.xcarchive|-exportPath|<tmp>/output/<run>/export|-exportOptionsPlist|<tmp>/output/<run>/ExportOptions-AppStore.plist|-authenticationKeyPath|<tmp>/AuthKey.p8|-authenticationKeyID|KEYID12345|-authenticationKeyIssuerID|issuer-uuid|",
		]);
		expect(exportOptions).toContain("<string>app-store-connect</string>");
		expect(exportOptions).toContain("<string>manual</string>");
		expect(exportOptions).toContain(`teamID=${teamId}`);
		expect(exportOptions).toContain(
			"provisioningProfiles=<dict><key>com.dropcliffs.track1</key><string>Track1 App &amp; Store</string></dict>",
		);
		expect(result.stdout).toMatch(
			/Git SHA: +0123456789abcdef0123456789abcdef01234567\nVersion: +1\.0\.0\nBuild: +\d{12}\nAPI URL: +https:\/\/api\.example\.org\/mobile\/v1\n/,
		);
		expect(result.stdout).toMatch(/IPA: +\S+\/export\/Track1\.ipa/);
	});

	it.each([
		[undefined, false],
		["0", false],
		["1", true],
	])("TRACK1_UPLOAD=%s: destination=upload in the export options is %s", async (value, uploads) => {
		const { exportOptions, result } = await run({ TRACK1_UPLOAD: value });
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(exportOptions.match(/destination=\w+/)?.[0]).toBe(uploads ? "destination=upload" : undefined);
		expect(result.stdout.includes("IPA:")).toBe(!uploads);
		expect(result.stdout + result.stderr).not.toContain(keyBody);
	});

	it.each([
		[
			"an API path other than /mobile/v1",
			{ TRACK1_API_BASE_URL: "https://a.example.org/v1" },
			"TRACK1_API_BASE_URL must end with /mobile/v1",
		],
		[
			"a placeholder .example host",
			{ TRACK1_API_BASE_URL: "https://a.track1.example/mobile/v1" },
			"TRACK1_API_BASE_URL must not end with .example",
		],
		["an invalid Team ID", { TRACK1_TEAM_ID: "abc" }, "TRACK1_TEAM_ID is required"],
		["a dirty git tree", { TRACK1_TEST_GIT_STATUS: "?? notes.txt\n" }, "uncommitted changes"],
		["another Xcode version", { TRACK1_TEST_XCODE_FILE: "other-xcode" }, "Expected Xcode"],
		["a missing key file", { ASC_KEY_PATH: "/nonexistent/AuthKey.p8" }, "ASC_KEY_PATH must be a readable"],
		["an unset key path", { ASC_KEY_PATH: undefined }, "ASC_KEY_PATH must be a readable"],
		["an empty profile name", { TRACK1_PROFILE_NAME: "" }, "TRACK1_PROFILE_NAME is required"],
		["a profile name with a $", { TRACK1_PROFILE_NAME: "$(HOME)" }, "TRACK1_PROFILE_NAME must not contain"],
		["a missing key ID", { ASC_KEY_ID: "" }, "ASC_KEY_ID is required"],
		["a missing issuer ID", { ASC_ISSUER_ID: "" }, "ASC_ISSUER_ID is required"],
		["an unknown upload value", { TRACK1_UPLOAD: "yes" }, "TRACK1_UPLOAD must be 0 or 1"],
	])("stops before any xcodebuild archive for %s", async (_label, overrides, expectedError) => {
		const { calls, result } = await run(overrides);

		expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
		expect(result.stderr).toContain(expectedError);
		expect(result.stdout + result.stderr).not.toContain(keyBody);
		expect(calls).toEqual([]);
	});

	it.each([
		["another team", { TRACK1_TEST_SIGNED_TEAM: "ZZZZZ99999" }, "signed by team 'ZZZZZ99999'"],
		["another identifier", { TRACK1_TEST_SIGNED_IDENTIFIER: "com.x.y" }, "signed as 'com.x.y'"],
		[
			"another API URL",
			{ TRACK1_TEST_PLIST_API_URL: "https://b.example.org/mobile/v1" },
			"embeds API URL 'https://b.example.org",
		],
	])(
		"stops before the export when the archived app has %s, with or without an upload",
		async (_label, overrides, expectedError) => {
			for (const TRACK1_UPLOAD of [undefined, "1"]) {
				const { calls, result } = await run({ ...overrides, TRACK1_UPLOAD });

				expect(result.status, result.stdout).not.toBe(0);
				expect(result.stderr).toContain("The archived app");
				expect(result.stderr).toContain(expectedError);
				expect(calls.some((call) => call.startsWith("-exportArchive"))).toBe(false);
			}
		},
	);

	it.each([
		["team", { TRACK1_TEST_EXPORTED_TEAM: "ZZZZZ99999" }, "signed by team 'ZZZZZ99999'"],
		["identifier", { TRACK1_TEST_EXPORTED_IDENTIFIER: "com.x.y" }, "signed as 'com.x.y'"],
		[
			"API URL",
			{ TRACK1_TEST_EXPORTED_URL: "https://b.example.org/mobile/v1" },
			"embeds API URL 'https://b.example.org",
		],
	])("without an upload, also checks the exported IPA: %s", async (_label, overrides, expectedError) => {
		const exported = await run(overrides);
		const uploaded = await run({ ...overrides, TRACK1_UPLOAD: "1" });

		expect(exported.result.status).not.toBe(0);
		expect(exported.result.stderr).toContain("The exported app");
		expect(exported.result.stderr).toContain(expectedError);
		// With an upload there is no IPA to read: only the archive was checked, and it is fine.
		expect(uploaded.result.status, uploaded.result.stderr).toBe(0);
	});

	// TRA-792 (2026-11-19): the first TestFlight run failed at the archive. The profile, passed on the command line,
	// reached the Swift packages, and Xcode refuses a profile on a package target.
	it("signs the app target only: no signing setting on the command line, device-only settings in Production", async () => {
		const { calls, result } = await run();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const archive = calls.find((call) => call.startsWith("archive|")) ?? "";
		expect(archive).not.toMatch(/\|(CODE_SIGN\w*|DEVELOPMENT_TEAM|PROVISIONING_PROFILE\w*)=/);

		const configuration = (name: string) => readFile(resolve(`ios/Configurations/${name}.xcconfig`), "utf8");
		const signingLines = (text: string) =>
			text.split("\n").filter((line) => /^(CODE_SIGN|DEVELOPMENT_TEAM|PROVISIONING_PROFILE)/.test(line));
		expect(signingLines(await configuration("Production"))).toEqual([
			"CODE_SIGNING_ALLOWED[sdk=iphoneos*] = YES",
			"CODE_SIGNING_REQUIRED[sdk=iphoneos*] = YES",
			"CODE_SIGN_STYLE[sdk=iphoneos*] = Manual",
			"CODE_SIGN_IDENTITY[sdk=iphoneos*] = Apple Distribution",
			"DEVELOPMENT_TEAM[sdk=iphoneos*] = $(TRACK1_TEAM_ID)",
			"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*] = $(TRACK1_PROFILE_NAME)",
		]);
		// Simulator builds of Production, and the other configurations, keep the unsigned build of Base.xcconfig.
		expect(signingLines(await configuration("Base"))).toEqual([
			"CODE_SIGNING_ALLOWED = NO",
			"CODE_SIGNING_REQUIRED = NO",
		]);
		expect(signingLines(await configuration("Development"))).toEqual([]);
		expect(signingLines(await configuration("Preview"))).toEqual([]);

		// Only the app target's Production configuration is based on Production.xcconfig, so no package sees it.
		const project = await readFile(resolve("ios/Track1.xcodeproj/project.pbxproj"), "utf8");
		const basedOnProduction = project
			.split("\n")
			.filter((line) => line.includes("baseConfigurationReference") && line.includes("Production.xcconfig"));
		expect(basedOnProduction).toHaveLength(1);
		expect(basedOnProduction[0]).toContain("PRODUCT_MODULE_NAME = Track1;");
	});
});
