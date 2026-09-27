import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/verify-e2e.sh");
const expectedSha = "a".repeat(40);
const validGenreNode = JSON.stringify({
	source: "cache",
	node: {
		id: "genre:ambient",
		type: "genre",
		name: "Ambient",
		teaser: "Ambient music",
		article: "Ambient music fixture.",
		citations: [],
		edges: {},
		facts: {},
		materialized_at: "2026-09-27T00:00:00.000Z",
	},
});
let directory = "";

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "odyssey-mobile-smoke-"));
	const curl = join(directory, "curl");
	await writeFile(curl, mockCurl());
	await chmod(curl, 0o755);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("verify-e2e mobile smoke", () => {
	it("requires the recipe identity before issuing a request", async () => {
		const result = run({ MOBILE_SMOKE_IDENTITY: undefined });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("MOBILE_SMOKE_IDENTITY must name an existing genre node");
		expect(await calls()).toBe("");
	});

	it("refuses an HTTP base without issuing a request", async () => {
		const result = run({ MOBILE_API_URL: "http://track1.example.test/mobile/v1" });

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("HTTPS DNS URL");
		expect(await calls()).toBe("");
	});

	it.each([
		"https://localhost./mobile/v1",
		"https://track1/mobile/v1",
		"https://0.0.0.0/mobile/v1",
		"https://169.254.169.254/mobile/v1",
		"https://100.64.0.1/mobile/v1",
		"https://192.0.0.9/mobile/v1",
		"https://192.0.0.10/mobile/v1",
		"https://192.0.2.1/mobile/v1",
		"https://192.0.8.1/mobile/v1",
		"https://192.88.99.2/mobile/v1",
		"https://198.51.1.1/mobile/v1",
		"https://198.51.100.1/mobile/v1",
		"https://[::1]/mobile/v1",
		"https://[fd00::1]/mobile/v1",
		"https://[fe80::1]/mobile/v1",
		"https://[fec0::1]/mobile/v1",
		"https://[::ffff:127.0.0.1]/mobile/v1",
		"https://user:password@track1.example.test/mobile/v1",
		"https://track1.example.test:8443/mobile/v1",
	])("refuses the invalid or literal HTTPS base %s without issuing a request", async (baseUrl) => {
		const result = run({ MOBILE_API_URL: baseUrl });

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("HTTPS DNS URL");
		expect(await calls()).toBe("");
	});

	it("bounds every public request and limits the recipe read to its required genre node", async () => {
		const result = run();

		expect(result.status).toBe(0);
		const recorded = await calls();
		const requests = recorded.trim().split("\n");
		expect(requests).toHaveLength(5);
		for (const request of requests) expect(request).toContain("--connect-timeout 5 --max-time 15");
		expect(recorded).toContain("/nodes/genre%3Aambient");
		expect(recorded).not.toContain("/image");
		expect(recorded).not.toContain("/links");
	});

	it("rejects an otherwise-successful node request whose JSON is not a canonical genre response", () => {
		const result = run({ MOCK_NODE_BODY: "{}" });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("canonical genre contract");
	});

	it("fails when the deployed SHA differs from the revision being attested", async () => {
		const result = run({ MOCK_VERSION_SHA: "b".repeat(40) });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("does not match MOBILE_EXPECTED_SHA exactly");
	});

	it("reports a bounded network failure instead of treating a timeout as a pass", async () => {
		const result = run({ MOCK_CURL_MODE: "timeout" });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("network request failed within 15s");
	});
});

function run(overrides: Record<string, string | undefined> = {}) {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${directory}:${process.env.PATH ?? ""}`,
		MOCK_CALLS: join(directory, "calls.log"),
		MOBILE_API_URL: "https://track1.example.test/mobile/v1",
		MOBILE_SMOKE_IDENTITY: "genre:ambient",
		MOBILE_EXPECTED_SHA: expectedSha,
		MOCK_VERSION_SHA: expectedSha,
		MOCK_CURL_MODE: "",
		MOCK_NODE_BODY: validGenreNode,
		...overrides,
	};
	return spawnSync("bash", [script, "--mobile-smoke"], {
		cwd: process.cwd(),
		env: environment,
		encoding: "utf8",
	});
}

async function calls(): Promise<string> {
	return readFile(join(directory, "calls.log"), "utf8").catch(() => "");
}

function mockCurl(): string {
	return String.raw`#!/usr/bin/env bash
set -euo pipefail
headers=""
body=""
previous=""
if_none_match=0
url=""
for arg in "$@"; do
  url="$arg"
  if [[ "$previous" == "headers" ]]; then headers="$arg"; previous=""; continue; fi
  if [[ "$previous" == "body" ]]; then body="$arg"; previous=""; continue; fi
  if [[ "$previous" == "header" && "$arg" == If-None-Match:* ]]; then if_none_match=1; previous=""; continue; fi
  case "$arg" in
    --dump-header) previous="headers" ;;
    --output) previous="body" ;;
    -H) previous="header" ;;
  esac
done
printf '%s\n' "$*" >> "$MOCK_CALLS"
if [[ "$MOCK_CURL_MODE" == "timeout" ]]; then exit 28; fi
if [[ "$url" == */catalog && "$if_none_match" == 1 ]]; then
  printf 'HTTP/1.1 304 Not Modified\r\nETag: "sha256-fixture"\r\n\r\n' > "$headers"
  : > "$body"
  printf '304'
  exit 0
fi
printf 'HTTP/1.1 200 OK\r\n' > "$headers"
case "$url" in
  */catalog)
    printf 'ETag: "sha256-fixture"\r\n\r\n' >> "$headers"
    printf '%s' '{"version":"v1","revision":"sha256:fixture","nodes":[]}' > "$body"
    ;;
  */search*) printf '%s' '{"hits":[],"sources":{"cache":0,"catalog":0}}' > "$body" ;;
  */nodes/*) printf '%s' "$MOCK_NODE_BODY" > "$body" ;;
  */version) printf '{"sha":"%s"}' "$MOCK_VERSION_SHA" > "$body" ;;
  *) printf '{}' > "$body" ;;
esac
printf '200'
`;
}
