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
[[ "$1" == "-extract" ]] && printf '1.0.0\\n'
exit 0
`,
	git: `#!/usr/bin/env bash
[[ "$*" == *"rev-parse HEAD"* ]] && printf '0123456789abcdef0123456789abcdef01234567\\n'
exit 0
`,
};

async function run(overrides: Record<string, string | undefined> = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "track1-ios-testflight-")));
	try {
		await writeFile(join(directory, "AuthKey.p8"), keyBody);
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
	it("archives Production with manual distribution signing, then exports with the API key", async () => {
		const { calls, exportOptions, result } = await run();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		// The work directory is a fresh <run> folder under the output directory, itself outside the repository.
		expect(calls).toEqual([
			`archive|-project|<ios>/Track1.xcodeproj|-scheme|Track1|-configuration|Production|-destination|generic/platform=iOS|-archivePath|<tmp>/output/<run>/Track1.xcarchive|-onlyUsePackageVersionsFromResolvedFile|-disableAutomaticPackageResolution|CODE_SIGNING_ALLOWED=YES|CODE_SIGNING_REQUIRED=YES|CODE_SIGN_STYLE=Manual|CODE_SIGN_IDENTITY=Apple Distribution|DEVELOPMENT_TEAM=${teamId}|PROVISIONING_PROFILE_SPECIFIER=${profileName}|TRACK1_API_BASE_URL=${apiBaseUrl}|CURRENT_PROJECT_VERSION=<build>|`,
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
});
