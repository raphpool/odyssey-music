import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// TRA-411: ios-ci and mobile-ci must run on pull requests only. Branch protection is strict, so the
// squash merge on main produces the tree the PR check already tested; a push run only occupied the
// two self-hosted runners (2026-10-12: ios-check of the next PR waited ~14 min behind it).
// No YAML parser is added as a dependency: the assertions read the top-level `on:` block as text.
const workflows = [
	{ name: "ios-ci", path: ".github/workflows/ios-ci.yml", job: "ios-check" },
	{ name: "mobile-ci", path: ".github/workflows/mobile-ci.yml", job: "mobile-check" },
] as const;

/** Drops full-line comments so a note such as "# no push trigger" is never read as configuration. */
function withoutComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/** Returns the top-level `on:` block, from its key up to the next top-level key. */
function onBlockOf(source: string): string {
	const match = source.match(/^on:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m);
	if (!match?.[1]) throw new Error("top-level on: block not found");
	return match[1];
}

describe.each(workflows)("$name triggers (TRA-411)", ({ path, job }) => {
	const source = withoutComments(readFileSync(path, "utf8").replaceAll("\r\n", "\n"));
	const onBlock = onBlockOf(source);

	it("runs on pull_request with the four lifecycle types", () => {
		expect(onBlock).toMatch(/^ {2}pull_request:\s*$/m);
		expect(onBlock).toMatch(/^ {4}types: \[opened, synchronize, reopened, ready_for_review\]\s*$/m);
	});

	it("does not run on push, so a merge to main does not re-run the check", () => {
		expect(onBlock).not.toMatch(/\bpush:/);
		expect(onBlock).not.toMatch(/\bbranches:/);
	});

	it("declares no other trigger", () => {
		const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
		expect(triggers).toEqual(["pull_request"]);
	});

	it("still skips draft pull requests", () => {
		const start = source.indexOf(`\n  ${job}:`);
		if (start === -1) throw new Error(`job ${job} not found in ${path}`);
		const jobBlock = source.slice(start);
		expect(jobBlock).toContain("github.event.pull_request.draft == false");
	});
});

// Two ios-check runs in parallel on the one Mac saturated it (2026-10-12, #335: load 274, simulator
// did not boot in 600 s), so ios-check is pinned to the single runner carrying the `ios` label.
describe("ios-check runner label (TRA-411)", () => {
	const runsOnOf = (source: string, job: string): string[] => {
		const start = source.indexOf(`\n  ${job}:`);
		if (start === -1) throw new Error(`job ${job} not found`);
		const match = source.slice(start + 1).match(/^ {4}runs-on: \[(.*)\]\s*$/m);
		if (!match?.[1]) throw new Error(`runs-on list not found for ${job}`);
		return match[1].split(",").map((label) => label.trim());
	};

	it("requires the ios label on ios-check", () => {
		const source = withoutComments(readFileSync(".github/workflows/ios-ci.yml", "utf8"));
		expect(runsOnOf(source, "ios-check")).toEqual(["self-hosted", "macOS", "ARM64", "ios"]);
	});

	it("does not require the ios label in any ci.yml job", () => {
		const source = withoutComments(readFileSync(".github/workflows/ci.yml", "utf8"));
		const runsOnLines = source.match(/^ {4}runs-on:.*$/gm) ?? [];
		expect(runsOnLines.length).toBeGreaterThan(0);
		for (const line of runsOnLines) expect(line).not.toMatch(/\bios\b/);
	});
});

// TRA-415: ios-check and mobile-check are not required checks, so they can be filtered by path
// (2026-10-12, #338: a 3-line change under .claude/ held the `ios` runner for 19 min and queued the
// light jobs behind each other on the other runner). Only `paths-ignore` is used: it fails safe, a path
// that is not listed still triggers the check. A path may be listed only if it is proven not to be an
// input of ios/scripts/check.sh, of the contract harness (and its import graph) or of the mobile steps.
const IGNORED_PATHS = [".claude/**", "docs/**", "*.md"];

/** Pulls the `- "glob"` items of `paths-ignore:` out of the pull_request block. */
function pathsIgnoreOf(onBlock: string): string[] {
	const match = onBlock.match(/^ {4}paths-ignore:\n((?: {6}- .*\n)+)/m);
	if (!match?.[1]) throw new Error("paths-ignore list not found under pull_request");
	return match[1]
		.trim()
		.split("\n")
		.map((line) => line.replace(/^\s*-\s*/, "").replace(/^"(.*)"$/, "$1"));
}

/** GitHub filter semantics: `*` stays inside a path segment, `**` crosses `/`. */
function matchesGlob(glob: string, path: string): boolean {
	let pattern = "";
	for (let i = 0; i < glob.length; i += 1) {
		const char = glob.charAt(i);
		if (char === "*" && glob.charAt(i + 1) === "*") {
			i += 1;
			if (glob.charAt(i + 1) === "/") {
				i += 1;
				pattern += "(?:.*/)?";
			} else pattern += ".*";
		} else if (char === "*") pattern += "[^/]*";
		else if (char === "?") pattern += "[^/]";
		else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${pattern}$`).test(path);
}

/** Lists files under a directory, pruning dependency and build folders instead of walking them. */
function filesUnder(directory: string): string[] {
	const skipped = new Set(["node_modules", "DerivedData", "SourcePackages", ".build"]);
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return skipped.has(entry.name) ? [] : filesUnder(path);
		return entry.isFile() ? [path] : [];
	});
}

/** Every repo file the contract harness loads through relative imports (what check.sh runs under tsx). */
function harnessImportGraph(entry: string): string[] {
	const seen = new Set<string>();
	const queue = [entry];
	const specifier = /(?:from\s*|import\s*\(?\s*)["'](\.[^"']*)["']/g;
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
			const base = resolve(dirname(file), match[1] ?? "");
			const candidates = [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
			const found = candidates.find((candidate) => candidate.endsWith(".ts") && existsSync(candidate));
			if (!found) throw new Error(`unresolved import ${match[1]} in ${file}`);
			queue.push(relative(".", found));
		}
	}
	return [...seen].sort();
}

// Files that ios/scripts/check.sh and the harness read without importing them: data/*.json is loaded at
// runtime by genre-identity.ts, genre-registry.ts, graph.ts and pipeline.ts; the root manifests drive
// `npm ci` and tsx; the root biome.json is the root of mobile/biome.json (`"root": false`).
const ROOT_INPUTS = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"biome.json",
	"vitest.config.ts",
	...filesUnder("data"),
	".github/workflows/ios-ci.yml",
	".github/workflows/mobile-ci.yml",
];

// Computed once: the walk is shared by both workflows.
const KNOWN_INPUTS = [
	...filesUnder("ios"),
	...filesUnder("mobile"),
	...harnessImportGraph("test/helpers/mobile-contract-server.ts"),
	...ROOT_INPUTS,
];

describe("path filters (TRA-415)", () => {
	it("matches globs like GitHub does", () => {
		expect(matchesGlob(".claude/**", ".claude/agents/implementer.md")).toBe(true);
		expect(matchesGlob("docs/**", "docs/plans/track1-mobile.md")).toBe(true);
		expect(matchesGlob("*.md", "README.md")).toBe(true);
		expect(matchesGlob("*.md", "ios/NOTES.md")).toBe(false);
		expect(matchesGlob("docs/**", "src/docs/x.ts")).toBe(false);
	});

	it("reads the harness import graph from src/", () => {
		const graph = harnessImportGraph("test/helpers/mobile-contract-server.ts");
		expect(graph).toContain("src/server.ts");
		expect(graph).toContain("src/mobile/router.ts");
		expect(graph).toContain("src/schemas.ts");
	});
});

describe.each(workflows)("$name path filter (TRA-415)", ({ path }) => {
	const raw = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
	const onBlock = onBlockOf(withoutComments(raw));

	it("ignores only the proven non-inputs, with paths-ignore under pull_request", () => {
		expect(pathsIgnoreOf(onBlock)).toEqual(IGNORED_PATHS);
	});

	it("uses no allow-list filter, which would fail open on a forgotten input", () => {
		expect(onBlock).not.toMatch(/^ {4}paths:/m);
	});

	it("keeps the four lifecycle types next to the filter", () => {
		expect(onBlock).toMatch(/^ {4}types: \[opened, synchronize, reopened, ready_for_review\]\s*$/m);
	});

	it("never ignores an input of check.sh, of the harness or of the mobile steps", () => {
		expect(KNOWN_INPUTS).toContain("ios/scripts/check.sh");
		expect(KNOWN_INPUTS).toContain("test/helpers/mobile-contract-server.ts");
		expect(KNOWN_INPUTS).toContain("src/server.ts");
		expect(KNOWN_INPUTS).toContain("mobile/package-lock.json");
		const ignoredInputs = KNOWN_INPUTS.filter((file) =>
			pathsIgnoreOf(onBlock).some((glob) => matchesGlob(glob, file)),
		);
		expect(ignoredInputs).toEqual([]);
	});

	it("documents the rule, its date and its symptom in a comment", () => {
		expect(raw).toContain("TRA-415");
		expect(raw).toContain("2026-10-12");
		expect(raw).toContain("#338");
		expect(raw).toContain("must never be an entry of ios/scripts/check.sh");
	});
});
