import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(".codex/scripts/publish-review-status.sh");
const sha = "0123456789012345678901234567890123456789";
const baseEnv = {
	...process.env,
	CODEX_REVIEW_DRY_RUN: "1",
	CODEX_REVIEW_REPO: "raphpool/odyssey-music",
};

describe("publish-review-status", () => {
	it.each([
		["pending", "pending"],
		["pass", "success"],
		["block", "failure"],
	])("maps %s to %s", (verdict, state) => {
		const output = execFileSync("bash", [script, "53", verdict, sha], {
			encoding: "utf8",
			env: baseEnv,
		});
		expect(output).toContain(`state=${state}`);
		expect(output).toContain("context=codex-review");
		expect(output).toContain(`sha=${sha}`);
	});

	it("refuses a verdict after the PR head changes", () => {
		const result = spawnSync("bash", [script, "53", "pass", sha], {
			encoding: "utf8",
			env: { ...baseEnv, CODEX_REVIEW_CURRENT_SHA: "different" },
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("pas sur le SHA reviewé");
	});
});
