import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRatchet, compareThresholds, THRESHOLDS_PATH } from "../scripts/ci/threshold-ratchet.js";

describe("compareThresholds (TRA-461)", () => {
	it("flags a raised ceiling", () => {
		expect(compareThresholds({ a: 5 }, { a: 6 })).toEqual(["a: 5 → 6 (increase)"]);
	});

	it("accepts an equal or lowered ceiling", () => {
		expect(compareThresholds({ a: 5 }, { a: 5 })).toEqual([]);
		expect(compareThresholds({ a: 5 }, { a: 4 })).toEqual([]);
	});

	it("flags a removed metric", () => {
		expect(compareThresholds({ a: 5 }, {})).toEqual(["a: removed"]);
	});

	it("compares per-type metrics key by key", () => {
		const base = { m: { artist: 10, track: 12 } };
		expect(compareThresholds(base, { m: { artist: 9, track: 12 } })).toEqual([]);
		expect(compareThresholds(base, { m: { artist: 10, track: 20 } })).toEqual([
			"m[track]: 12 → 20 (increase)",
		]);
		expect(compareThresholds(base, { m: { artist: 10 } })).toEqual(["m[track]: removed"]);
	});

	it("reports one line per violation, across metrics", () => {
		const base = { a: 1, b: { x: 1, y: 1 }, c: 3 };
		expect(compareThresholds(base, { a: 2, b: { x: 2, y: 0 } })).toEqual([
			"a: 1 → 2 (increase)",
			"b[x]: 1 → 2 (increase)",
			"c: removed",
		]);
	});

	it("flags a metric that switches between a scalar and a per-key ceiling", () => {
		expect(compareThresholds({ a: 5 }, { a: { x: 1 } })).toHaveLength(1);
		expect(compareThresholds({ a: { x: 5 } }, { a: 1 })).toHaveLength(1);
	});

	it("allows new metrics and new keys, which only tighten the audit", () => {
		expect(compareThresholds({ a: 1, m: { x: 1 } }, { a: 1, m: { x: 1, y: 99 }, z: 7 })).toEqual([]);
	});
});

describe("checkRatchet against a real git repository (TRA-461)", () => {
	let dir: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
	const writeThresholds = (value: unknown) => {
		mkdirSync(join(dir, "data"), { recursive: true });
		writeFileSync(join(dir, THRESHOLDS_PATH), JSON.stringify(value));
	};
	const commitBase = (value: unknown) => {
		writeThresholds(value);
		git("add", "-A");
		git("commit", "-q", "-m", "base");
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ratchet-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		git("config", "commit.gpgsign", "false");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("exits 1 and names the metric when a PR raises a ceiling", () => {
		commitBase({ "self-edges": 13, "empty-artists": { project: 92 } });
		writeThresholds({ "self-edges": 20, "empty-artists": { project: 92 } });
		const result = checkRatchet("main", dir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("self-edges: 13 → 20 (increase)");
	});

	it("exits 0 when a PR lowers a ceiling", () => {
		commitBase({ "self-edges": 13 });
		writeThresholds({ "self-edges": 4 });
		expect(checkRatchet("main", dir).exitCode).toBe(0);
	});

	it("exits 2 with a warning when the base has no thresholds file", () => {
		writeFileSync(join(dir, "README.md"), "x");
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		writeThresholds({ a: 1 });
		const result = checkRatchet("main", dir);
		expect(result.exitCode).toBe(2);
		expect(result.output).toMatch(/^::warning::/);
	});

	it("throws on an unknown base ref instead of passing silently", () => {
		commitBase({ a: 1 });
		expect(() => checkRatchet("origin/nope", dir)).toThrow();
	});
});
