import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkRatchet,
	compareThresholds,
	formatFailure,
	type NodeGrowth,
	THRESHOLDS_PATH,
} from "../scripts/ci/threshold-ratchet.js";
import { NODE_TYPES, type NodeType } from "../src/node-spec.js";

const counts = (overrides: Partial<Record<NodeType, number>>): Record<NodeType, number> =>
	({ ...Object.fromEntries(NODE_TYPES.map((t) => [t, 0])), ...overrides }) as Record<NodeType, number>;

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

describe("compareThresholds node-growth valve (TRA-498)", () => {
	const growth = (base: number, head: number): NodeGrowth => ({
		base: counts({ artist: base }),
		head: counts({ artist: head }),
	});
	const baseCeilings = { "missing-image": { artist: 417 } };
	const headCeilings = (artist: number) => ({ "missing-image": { artist } });

	it("accepts a coverage ceiling that rises by no more than the node growth of its type", () => {
		expect(compareThresholds(baseCeilings, headCeilings(420), growth(581, 584))).toEqual([]);
		expect(compareThresholds(baseCeilings, headCeilings(418), growth(581, 584))).toEqual([]);
	});

	it("rejects a rise that no added node explains", () => {
		const violations = compareThresholds(baseCeilings, headCeilings(420), growth(581, 581));
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("missing-image[artist]: 417 → 420");
	});

	it("rejects a rise larger than the growth, and never counts node removals as credit", () => {
		expect(compareThresholds(baseCeilings, headCeilings(421), growth(581, 584))).toHaveLength(1);
		expect(compareThresholds(baseCeilings, headCeilings(418), growth(581, 570))).toHaveLength(1);
	});

	it("only counts the growth of the type the metric measures", () => {
		const other: NodeGrowth = { base: counts({ artist: 581 }), head: counts({ artist: 581, track: 50 }) };
		expect(compareThresholds(baseCeilings, headCeilings(420), other)).toHaveLength(1);
		expect(
			compareThresholds({ "missing-image": { track: 10 } }, { "missing-image": { track: 20 } }, other),
		).toEqual([]);
	});

	it("applies to the scalar coverage metrics of artists and to single-citation", () => {
		for (const metric of ["missing-similar-artists", "missing-landmark-project", "missing-reference-track"]) {
			expect(compareThresholds({ [metric]: 581 }, { [metric]: 584 }, growth(581, 584))).toEqual([]);
			expect(compareThresholds({ [metric]: 581 }, { [metric]: 585 }, growth(581, 584))).toHaveLength(1);
		}
		const genres: NodeGrowth = { base: counts({ genre: 100 }), head: counts({ genre: 101 }) };
		const single = (genre: number) => ({ "single-citation": { genre } });
		expect(compareThresholds(single(10), single(11), genres)).toEqual([]);
		expect(compareThresholds(single(10), single(12), genres)).toHaveLength(1);
	});

	it("keeps correctness metrics strict however many nodes were added", () => {
		const g = growth(581, 700);
		expect(compareThresholds({ "self-edges": 13 }, { "self-edges": 14 }, g)).toEqual([
			"self-edges: 13 → 14 (increase)",
		]);
		for (const metric of [
			"homonym-release-links",
			"duplicate-names",
			"zero-edge-nodes",
			"literal-newlines",
		]) {
			expect(compareThresholds({ [metric]: 1 }, { [metric]: 2 }, g)).toHaveLength(1);
		}
		const projects: NodeGrowth = { base: counts({ project: 1 }), head: counts({ project: 9 }) };
		expect(
			compareThresholds({ "empty-artists": { project: 1 } }, { "empty-artists": { project: 2 } }, projects),
		).toHaveLength(1);
		const pair = (n: number) => ({ "reciprocity-missing": { "artist.labels->label.roster": n } });
		expect(compareThresholds(pair(1), pair(2), g)).toHaveLength(1);
	});

	it("stays strict without node counts", () => {
		expect(compareThresholds(baseCeilings, headCeilings(418))).toHaveLength(1);
	});

	it("still flags removals of coverage ceilings", () => {
		const g = growth(581, 700);
		expect(compareThresholds(baseCeilings, {}, g)).toEqual(["missing-image: removed"]);
		expect(compareThresholds(baseCeilings, { "missing-image": { genre: 1 } }, g)).toEqual([
			"missing-image[artist]: removed",
		]);
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

	const writeNodes = (type: NodeType, count: number, from = 0) => {
		const nodeDir = join(dir, "cache", "nodes", type);
		mkdirSync(nodeDir, { recursive: true });
		for (let i = from; i < from + count; i++) writeFileSync(join(nodeDir, `n${i}.json`), "{}");
	};

	it("exits 1 and names the metric when a PR raises a ceiling", async () => {
		commitBase({ "self-edges": 13, "empty-artists": { project: 92 } });
		writeThresholds({ "self-edges": 20, "empty-artists": { project: 92 } });
		const result = await checkRatchet("main", dir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("self-edges: 13 → 20 (increase)");
	});

	it("exits 0 when a PR lowers a ceiling", async () => {
		commitBase({ "self-edges": 13 });
		writeThresholds({ "self-edges": 4 });
		expect((await checkRatchet("main", dir)).exitCode).toBe(0);
	});

	it("exits 2 with a warning when the base has no thresholds file", async () => {
		writeFileSync(join(dir, "README.md"), "x");
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		writeThresholds({ a: 1 });
		const result = await checkRatchet("main", dir);
		expect(result.exitCode).toBe(2);
		expect(result.output).toMatch(/^::warning::/);
	});

	it("throws on an unknown base ref instead of passing silently", async () => {
		commitBase({ a: 1 });
		await expect(checkRatchet("origin/nope", dir)).rejects.toThrow();
	});

	describe("node-growth valve, from the node files of the base and of HEAD (TRA-498)", () => {
		const imageCeiling = (artist: number) => ({ "missing-image": { artist }, "self-edges": 13 });

		it("accepts a coverage ceiling raised by exactly the artists a PR added", async () => {
			writeNodes("artist", 5);
			commitBase(imageCeiling(417));
			writeNodes("artist", 3, 5);
			writeThresholds(imageCeiling(420));
			const result = await checkRatchet("main", dir);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("missing-image[artist]: 417 → 420");
			// No self-contradiction: the header says the rise is absorbed, not that no ceiling was raised.
			expect(result.output).toContain("Ratchet respected; coverage rises absorbed by node growth");
			expect(result.output).not.toContain("no ceiling raised");
			expect(result.output).not.toContain("Node counts unavailable");
		});

		it("keeps the plain message when nothing was raised", async () => {
			writeNodes("artist", 5);
			commitBase(imageCeiling(417));
			writeThresholds(imageCeiling(400));
			const result = await checkRatchet("main", dir);
			expect(result.output).toContain("Ratchet respected: no ceiling raised or removed.");
			expect(result.output).not.toContain("absorbed");
		});

		it("rejects the same rise when the PR added no artist", async () => {
			writeNodes("artist", 5);
			commitBase(imageCeiling(417));
			writeThresholds(imageCeiling(420));
			const result = await checkRatchet("main", dir);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("missing-image[artist]: 417 → 420 (increase)");
			// Node counts were available: the explanation of a refused valve would be wrong here.
			expect(result.output).not.toContain("Node counts unavailable");
		});

		it("rejects a correctness ceiling raised alongside added nodes", async () => {
			writeNodes("artist", 5);
			commitBase(imageCeiling(417));
			writeNodes("artist", 3, 5);
			writeThresholds({ ...imageCeiling(420), "self-edges": 14 });
			const result = await checkRatchet("main", dir);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("self-edges: 13 → 14 (increase)");
		});

		it("stays strict when the base has no nodes to count from", async () => {
			commitBase(imageCeiling(417));
			writeNodes("artist", 3);
			writeThresholds(imageCeiling(418));
			const result = await checkRatchet("main", dir);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("Node counts unavailable");
			expect(result.output).toContain("every rise is refused");
		});

		it("does not mention unavailable counts when nothing needed them", async () => {
			commitBase(imageCeiling(417));
			writeThresholds(imageCeiling(400));
			const result = await checkRatchet("main", dir);
			expect(result.exitCode).toBe(0);
			expect(result.output).not.toContain("Node counts unavailable");
		});
	});

	describe("failure report (TRA-498)", () => {
		it("formats an unexpected error as markdown for stdout, with the message and an annotation", () => {
			const output = formatFailure(new Error("fatal: bad revision 'origin/nope'"));
			expect(output).toContain("ratchet failed");
			expect(output).toContain("bad revision 'origin/nope'");
			expect(output).toContain("::error::");
		});

		it("prints the failure on stdout and exits 1 when the base ref is unknown", () => {
			commitBase({ a: 1 });
			const script = join(process.cwd(), "scripts/ci/threshold-ratchet.ts");
			const run = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), [script, "origin/nope"], {
				cwd: dir,
				encoding: "utf8",
			});
			expect(run.status).toBe(1);
			expect(run.stdout).toContain("ratchet failed");
			expect(run.stdout).toContain("origin/nope");
		});
	});
});
