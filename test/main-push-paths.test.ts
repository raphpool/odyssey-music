import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TRA-441: a merge to main that only touches paths the server never reads must not start `ci` and
// `deploy` (2026-10-13: both occupied the self-hosted runners right when the next iOS PR went ready).
// `paths-ignore` goes on the `push` trigger ONLY. The `pull_request` trigger stays unfiltered, because
// the required checks must run on every PR. No YAML parser is a dependency (neither direct nor
// transitive), so the guard reads the top-level `on:` block as text, as test/native-ci-triggers.test.ts does.

const IGNORED_ON_PUSH = ["ios/**", "docs/**", ".claude/**", ".codex/**", "*.md"];

type TriggerProps = Map<string, string[]>;
type Triggers = Map<string, TriggerProps>;

/** Drops full-line comments and trailing ` # ...` comments that follow an unquoted value. */
function withoutComments(source: string): string {
	return source
		.replaceAll("\r\n", "\n")
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.map((line) => (/["']/.test(line) ? line : line.replace(/\s+#.*$/, "")))
		.join("\n");
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = trimmed.match(/^(["'])(.*)\1$/);
	return quoted?.[2] ?? trimmed;
}

/** Parses `[a, b]` or a bare scalar into a list; an empty string gives an empty list. */
function inlineValues(value: string): string[] {
	const trimmed = value.trim();
	if (trimmed === "") return [];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map(unquote)
			.filter((item) => item !== "");
	}
	return [unquote(trimmed)];
}

/**
 * Reads the top-level `on:` block into trigger -> property -> values. It supports the shapes this repo
 * uses (2-space indent, block or flow lists) and throws on anything else rather than guessing.
 */
function parseTriggers(source: string): Triggers {
	const match = withoutComments(source).match(/^on:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m);
	if (!match?.[1]) throw new Error("TRA-441 guard: top-level on: block not found");
	const triggers: Triggers = new Map();
	let trigger: TriggerProps | undefined;
	let property: string[] | undefined;
	for (const line of match[1].split("\n")) {
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		const text = line.trim();
		if (indent === 2) {
			const key = text.match(/^([a-z_]+):\s*$/)?.[1];
			if (!key) throw new Error(`unsupported trigger line: ${line}`);
			trigger = new Map();
			property = undefined;
			triggers.set(key, trigger);
		} else if (indent === 4 && trigger) {
			const kv = text.match(/^([a-z_-]+):(.*)$/);
			if (!kv?.[1]) throw new Error(`unsupported property line: ${line}`);
			property = inlineValues(kv[2] ?? "");
			trigger.set(kv[1], property);
		} else if (indent >= 6 && text.startsWith("- ") && property) {
			property.push(unquote(text.slice(2)));
		} else {
			throw new Error(`unsupported on: line: ${line}`);
		}
	}
	return triggers;
}

/** Each function returns the violations it finds; an empty list means the workflow is conforming. */
function pushViolations(source: string): string[] {
	const push = parseTriggers(source).get("push");
	if (!push) return ["push trigger missing"];
	const violations: string[] = [];
	const ignored = push.get("paths-ignore") ?? [];
	if (JSON.stringify([...ignored].sort()) !== JSON.stringify([...IGNORED_ON_PUSH].sort())) {
		violations.push(`push paths-ignore is [${ignored.join(", ")}], expected [${IGNORED_ON_PUSH.join(", ")}]`);
	}
	if (push.has("paths")) violations.push("push must not combine paths with paths-ignore");
	if (JSON.stringify(push.get("branches")) !== JSON.stringify(["main"])) {
		violations.push("push must stay limited to branches [main]");
	}
	return violations;
}

function pullRequestViolations(source: string): string[] {
	const pullRequest = parseTriggers(source).get("pull_request");
	if (!pullRequest) return ["pull_request trigger missing"];
	return ["paths", "paths-ignore"]
		.filter((key) => pullRequest.has(key))
		.map((key) => `pull_request must not carry ${key}: required checks run on every PR`);
}

function dispatchViolations(source: string): string[] {
	return parseTriggers(source).has("workflow_dispatch") ? [] : ["workflow_dispatch missing"];
}

/** GitHub filter globs: `**` crosses directories, `*` does not cross `/`. */
function globToRegExp(glob: string): RegExp {
	const body = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", "\u0000")
		.replaceAll("*", "[^/]*")
		.replaceAll("\u0000", ".*");
	return new RegExp(`^${body}$`);
}

/** GitHub starts a push run as soon as one changed file is outside `paths-ignore`. */
function pushStartsRun(changedFiles: string[], ignore: string[]): boolean {
	const matchers = ignore.map(globToRegExp);
	return changedFiles.some((file) => !matchers.some((re) => re.test(file)));
}

/** The `paths-ignore` list the workflow really carries on push, as parsed from its YAML text. */
const ignoredOnPush = (source: string): string[] =>
	parseTriggers(source).get("push")?.get("paths-ignore") ?? [];

const read = (path: string): string => readFileSync(path, "utf8");
const ci = read(".github/workflows/ci.yml");
const deploy = read(".github/workflows/deploy.yml");
const BLOCK_PATHS_IGNORE = / {4}paths-ignore:\n(?: {6}- .*\n)+/;

describe.each([
	{ name: "ci.yml", source: ci },
	{ name: "deploy.yml", source: deploy },
])("$name push trigger (TRA-441)", ({ source }) => {
	it("ignores exactly the paths the server never reads", () => {
		expect(pushViolations(source)).toEqual([]);
	});
});

describe("pull_request and workflow_dispatch triggers (TRA-441)", () => {
	it("keeps ci.yml pull_request unfiltered", () => {
		expect(pullRequestViolations(ci)).toEqual([]);
	});

	it("keeps deploy.yml free of pull_request, with workflow_dispatch still available", () => {
		expect(parseTriggers(deploy).has("pull_request")).toBe(false);
		expect(dispatchViolations(deploy)).toEqual([]);
	});
});

describe("guard negative cases (TRA-441)", () => {
	it("fails when paths-ignore appears on the ci.yml pull_request trigger", () => {
		const mutated = ci.replace("  pull_request:\n", '  pull_request:\n    paths-ignore:\n      - "ios/**"\n');
		expect(mutated).not.toBe(ci);
		expect(pullRequestViolations(mutated)).toEqual([
			"pull_request must not carry paths-ignore: required checks run on every PR",
		]);
	});

	it("fails when paths appears on the ci.yml pull_request trigger", () => {
		const mutated = ci.replace("  pull_request:\n", '  pull_request:\n    paths:\n      - "src/**"\n');
		expect(mutated).not.toBe(ci);
		expect(pullRequestViolations(mutated)).toHaveLength(1);
	});

	it.each([
		{ name: "ci.yml", source: ci },
		{ name: "deploy.yml", source: deploy },
	])("fails when ios/** disappears from the $name push trigger", ({ source }) => {
		const mutated = source.replace(/^ {6}- "ios\/\*\*"\n/m, "");
		expect(mutated).not.toBe(source);
		expect(pushViolations(mutated)).toHaveLength(1);
	});

	it("fails when the push list gains an extra path or loses its filter", () => {
		const extra = ci.replace('      - "*.md"\n', '      - "*.md"\n      - "src/**"\n');
		expect(extra).not.toBe(ci);
		expect(pushViolations(extra)).toHaveLength(1);
		const unfiltered = deploy.replace(BLOCK_PATHS_IGNORE, "");
		expect(unfiltered).not.toBe(deploy);
		expect(pushViolations(unfiltered)).toHaveLength(1);
	});

	it("fails when deploy.yml loses workflow_dispatch", () => {
		const mutated = deploy.replace("  workflow_dispatch:\n", "");
		expect(mutated).not.toBe(deploy);
		expect(dispatchViolations(mutated)).toEqual(["workflow_dispatch missing"]);
	});

	it("reads flow-style lists and is not fooled by comments", () => {
		const flow = ci.replace(
			BLOCK_PATHS_IGNORE,
			'    paths-ignore: ["ios/**", docs/**, ".claude/**", ".codex/**", "*.md"]\n',
		);
		expect(flow).not.toBe(ci);
		expect(pushViolations(flow)).toEqual([]);
		const commented = ci.replace("  pull_request:\n", "  pull_request:\n    # paths-ignore: nope\n");
		expect(pullRequestViolations(commented)).toEqual([]);
	});
});

describe("push run decision (TRA-441)", () => {
	const ignored = ignoredOnPush(ci);

	it("is the same list in ci.yml and deploy.yml", () => {
		expect(ignoredOnPush(deploy)).toEqual(ignored);
	});

	it("skips a merge that only touches ignored paths", () => {
		const files = ["ios/Track1/App.swift", "docs/plans/x.md", "README.md", ".claude/agents/a.md"];
		expect(pushStartsRun(files, ignored)).toBe(false);
	});

	it("still runs when the squash commit also touches the server, web, cache, deploy or CI", () => {
		const live = [
			"src/server.ts",
			"web/index.html",
			"cache/nodes/a.json",
			"deploy/deploy-server.sh",
			".github/workflows/ci.yml",
			"package.json",
		];
		for (const file of live) expect(pushStartsRun(["ios/Track1/App.swift", file], ignored)).toBe(true);
	});

	it("treats *.md as root-only, so a markdown file under src/ still runs", () => {
		expect(pushStartsRun(["src/mobile/NOTES.md"], ignored)).toBe(true);
	});
});
