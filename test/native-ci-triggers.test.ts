import { execFileSync } from "node:child_process";
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

// TRA-411 pinned ios-check to the single Mac carrying the `ios` label (2026-10-12, #335: two parallel runs
// saturated it, load 274, simulator not booted in 600 s). TRA-705 (2026-11-16): that Mac is presumed off, so
// ios-check runs on the GitHub-hosted macOS image whose Xcode is the one pinned in ios/.xcode-version.
describe("ios-check runner label (TRA-411, TRA-705)", () => {
	const iosCi = readFileSync(".github/workflows/ios-ci.yml", "utf8").replaceAll("\r\n", "\n");
	const runsOnOf = (source: string, job: string): string[] => {
		const start = source.indexOf(`\n  ${job}:`);
		if (start === -1) throw new Error(`job ${job} not found`);
		const match = source.slice(start + 1).match(/^ {4}runs-on: (.*?)\s*$/m);
		if (!match?.[1]) throw new Error(`runs-on not found for ${job}`);
		return match[1]
			.replace(/^\[(.*)\]$/, "$1")
			.split(",")
			.map((label) => label.trim());
	};

	it("runs ios-check on the hosted macos-26 image", () => {
		expect(runsOnOf(withoutComments(iosCi), "ios-check")).toEqual(["macos-26"]);
	});

	// Raw source on purpose: a comment must not keep describing a self-hosted runner either.
	it("no longer mentions self-hosted anywhere in ios-ci.yml", () => {
		expect(iosCi).not.toContain("self-hosted");
	});

	it("gives ios-check 45 minutes, for the cold DerivedData of a hosted runner", () => {
		expect(withoutComments(iosCi)).toMatch(/^ {4}timeout-minutes: 45\s*$/m);
	});

	it("selects the pinned Xcode before check.sh and lists the installed ones when it is missing", () => {
		const source = withoutComments(iosCi);
		const select = source.indexOf("- name: Select Xcode");
		expect(select).toBeGreaterThan(-1);
		expect(select).toBeLessThan(source.indexOf("ios/scripts/check.sh"));
		const step = source.slice(select, source.indexOf("- name:", select + 1));
		expect(step).toContain("ios/.xcode-version");
		expect(step).toContain("xcode-select -s");
		// check.sh compares the whole pin, build id included: the step must fail early on the same comparison.
		expect(step).toContain('[ "$actual" != "$pin" ]');
		expect(step).toContain("/Applications/Xcode*.app");
		expect(step).toContain("exit 1");
	});

	it("does not require the ios label in any ci.yml job", () => {
		const source = withoutComments(readFileSync(".github/workflows/ci.yml", "utf8"));
		const runsOnLines = source.match(/^ {4}runs-on:.*$/gm) ?? [];
		expect(runsOnLines.length).toBeGreaterThan(0);
		for (const line of runsOnLines) expect(line).not.toMatch(/\bios\b/);
	});
});

// TRA-650 (2026-10-20): jobs waited ~3.7x longer for a runner than they ran, and 74% of runner minutes were
// Node jobs that do not need macOS. Only ios-check does, so every other workflow targets the Linux runners.
// TRA-703 (2026-11-16): the self-hosted runners have been off since 2026-10-24, so every required check of main
// stayed queued and no PR could merge. The workflows a PR triggers moved to GitHub-hosted runners; the
// ones below stay self-hosted until their own ticket (ios-ci.yml: 1.3). Both tables are explicit on purpose:
// a new workflow file must be filed in one of them, or the "known workflows" test fails.
const HOSTED = ["ci.yml", "mobile-ci.yml", "review-gate.yml", "ai-review.yml", "claude.yml"];
const SELF_HOSTED = ["deploy.yml", "pull-cache.yml", "sync-genre-cache.yml", "top-up-genres.yml"];
// TRA-729 (2026-11-17): ios-testflight.yml signs and uploads, so it needs the same hosted macOS image as ios-ci.yml.
const MACOS = ["ios-ci.yml", "ios-testflight.yml"];

describe("runner labels by workflow (TRA-650, TRA-703)", () => {
	const workflowFiles = readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file));
	const runsOnLinesOf = (file: string): string[] =>
		withoutComments(readFileSync(join(".github/workflows", file), "utf8")).match(/^\s*runs-on:.*$/gm) ?? [];

	it("finds the workflows and their runs-on lines", () => {
		expect(workflowFiles).toContain("ci.yml");
		for (const file of workflowFiles) expect(runsOnLinesOf(file).length).toBeGreaterThan(0);
	});

	it("files every workflow in exactly one table", () => {
		expect(HOSTED.filter((file) => SELF_HOSTED.includes(file))).toEqual([]);
		expect([...HOSTED, ...SELF_HOSTED, ...MACOS].sort()).toEqual([...workflowFiles].sort());
	});

	it("runs the hosted workflows on ubuntu-latest in every job", () => {
		for (const file of HOSTED) {
			for (const line of runsOnLinesOf(file))
				expect(`${file}: ${line}`).toMatch(/runs-on: ubuntu-latest\s*$/);
		}
	});

	it("keeps the other workflows on the self-hosted Linux runners, so a typo cannot queue forever", () => {
		for (const file of SELF_HOSTED) {
			for (const line of runsOnLinesOf(file))
				expect(`${file}: ${line}`).toMatch(/runs-on: \[self-hosted, linux\]\s*$/);
		}
	});

	it("requests the macOS label in no workflow outside the macOS table", () => {
		for (const file of workflowFiles.filter((name) => !MACOS.includes(name))) {
			for (const line of runsOnLinesOf(file)) expect(`${file}: ${line}`).not.toMatch(/macOS/i);
		}
	});

	// TRA-705 (2026-11-16): was "keeps the ios label"; ios-ci.yml now targets the hosted macOS image.
	it("keeps every runs-on of the macOS workflows on the hosted macOS image", () => {
		for (const line of MACOS.flatMap(runsOnLinesOf)) expect(line).toMatch(/runs-on: macos-26\s*$/);
	});
});

// TRA-703 (2026-11-16): the repository is public. A hosted runner executes whatever a pull request carries, and
// `@claude` runs with write permissions, so both jobs are gated: the review skips fork PRs (they cannot reach
// the secrets anyway, and a fork author must not drive the agent), and `@claude` answers members only.
describe("hosted job conditions (TRA-703)", () => {
	/** The job-level `if:` (four-space indent), so a step-level `if:` is never read instead. */
	const jobIfOf = (file: string, job: string): string => {
		const source = withoutComments(readFileSync(join(".github/workflows", file), "utf8"));
		const start = source.indexOf(`\n  ${job}:`);
		if (start === -1) throw new Error(`job ${job} not found in ${file}`);
		// Cut at the next job header so a later job's `if:` is never read for this one.
		const rest = source.slice(start + 1);
		const next = rest.slice(1).search(/^ {2}[\w-]+:/m);
		const jobBlock = next === -1 ? rest : rest.slice(0, next + 1);
		const match = jobBlock.match(/^ {4}if: (.*)$/m);
		if (!match?.[1]) throw new Error(`job-level if not found for ${job}`);
		return match[1].trim();
	};

	it("reviews only non-draft pull requests that come from this repository, not from a fork", () => {
		expect(jobIfOf("ai-review.yml", "review")).toBe(
			"github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository",
		);
	});

	it("answers @claude only to an owner, a member or a collaborator", () => {
		expect(jobIfOf("claude.yml", "claude")).toBe(
			'contains(github.event.comment.body, \'@claude\') && contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.comment.author_association)',
		);
	});
});

// TRA-415 / TRA-417 (2026-10-12, #341): ios-check and mobile-check are not required checks, so `paths` lists
// their inputs. A forgotten input silently skips a check, so these tests compute the inputs they can (harness
// import graph, ios/, mobile/, check.sh reads) and fail if one is uncovered; they refuse unmodelled glob syntax.
const IOS_WORKFLOW = ".github/workflows/ios-ci.yml";
const MOBILE_WORKFLOW = ".github/workflows/mobile-ci.yml";
const HARNESS = "test/helpers/mobile-contract-server.ts";

/** Pulls the `- "glob"` items of `paths:` (not `paths-ignore:`) out of the pull_request block. */
function pathsOf(onBlock: string): string[] {
	const list = onBlock.match(/^ {4}paths:\n((?: {6}- .*\n)+)/m)?.[1];
	if (!list) throw new Error("paths list not found under pull_request");
	return list
		.trim()
		.split("\n")
		.map((line) => {
			const glob = line.match(/^\s*- "([^"]+)"$/)?.[1];
			if (!glob) throw new Error(`paths item is not a double-quoted glob: ${line}`);
			return glob;
		});
}

/** GitHub gives `? + [ ] ! \` a meaning (optional, class, negation, escape) that matchesGlob does not model. */
function unsupportedGlobs(globs: string[]): string[] {
	return globs.filter((glob) => /[?+[\]!\\]/.test(glob));
}

/** GitHub filter semantics for the supported subset: `*` stays inside a path segment, `**` crosses `/`. */
function matchesGlob(glob: string, path: string): boolean {
	if (unsupportedGlobs([glob]).length > 0) throw new Error(`unsupported glob syntax: ${glob}`);
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
		else pattern += char.replace(/[.^${}()|]/g, "\\$&");
	}
	return new RegExp(`^${pattern}$`).test(path);
}

/** The workflow starts when at least one changed file matches at least one pattern (none changed: no run). */
function startsWorkflow(globs: string[], changedFiles: string[]): boolean {
	return changedFiles.some((file) => globs.some((glob) => matchesGlob(glob, file)));
}

const uncovered = (globs: string[], files: string[]): string[] =>
	files.filter((file) => !startsWorkflow(globs, [file]));

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

interface SourceFile {
	file: string;
	source: string;
}

const readAll = (files: string[]): SourceFile[] =>
	files.map((file) => ({ file, source: readFileSync(file, "utf8") }));

/** Project files in which a `../` could point at a resource outside ios/ (Xcode resolves them from there). */
function parentReferences(sources: SourceFile[]): string[] {
	return sources.filter(({ source }) => source.includes("../")).map(({ file }) => file);
}

/** Relative path strings that resolve outside `root` (an import, an `extends`, a config path). */
function escapingReferences(sources: SourceFile[], root: string): string[] {
	const reference = /["'`](\.{1,2}\/[^"'`\s]*)["'`]/g;
	return sources.flatMap(({ file, source }) =>
		[...source.matchAll(reference)]
			.map((match) => match[1] ?? "")
			.filter((spec) => {
				const target = relative(".", resolve(dirname(file), spec));
				return target !== root && !target.startsWith(`${root}/`);
			})
			.map((spec) => `${file}: ${spec}`),
	);
}

/** String literals naming a root entry the workflow does not watch, or a Markdown file (best effort). */
function readsOutside(sources: SourceFile[], outsideRoots: string[]): string[] {
	// One left-to-right pass: a comment is consumed only where it starts outside a string literal.
	const token = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1|\/\/.*$|\/\*[\s\S]*?\*\//gm;
	return sources.flatMap(({ file, source }) =>
		[...source.matchAll(token)]
			.flatMap((match) => (match[1] === undefined ? [] : [match[2] ?? ""]))
			.filter((text) => {
				// A relative module specifier names a file of the import graph, which is already compared.
				if (/^\.{1,2}\/.*\.[jt]s$/.test(text)) return false;
				const head = text.replace(/^(?:\.{1,2}\/)+/, "").split("/")[0] ?? "";
				return outsideRoots.includes(head) || /\.md$/.test(text);
			})
			.map((text) => `${file}: ${text}`),
	);
}

/** Top-level tracked entries in which no file starts the workflow (untracked local files do not count). */
function rootEntriesOutside(globs: string[]): string[] {
	const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 });
	const byRoot = new Map<string, string[]>();
	for (const file of tracked.split("\0").filter(Boolean)) {
		const root = file.split("/")[0] ?? file;
		byRoot.set(root, [...(byRoot.get(root) ?? []), file]);
	}
	return [...byRoot].filter(([, files]) => !startsWorkflow(globs, files)).map(([root]) => root);
}

// Read without being imported: data/ (every file; genre-identity, genre-registry, graph, genre-taxonomy), cache/
// (genre-taxonomy.ts cacheRootFor, whatever ODYSSEY_CACHE_DIR says), the root manifests (`npm ci`, tsx).
// .deployed-sha (src/server.ts /version) is gitignored: no PR can change it.
const iosInputs = [
	...filesUnder("ios"),
	...harnessImportGraph(HARNESS),
	...filesUnder("data"),
	...filesUnder("cache"),
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	IOS_WORKFLOW,
];
// mobile/biome.json is `"root": false`: it inherits from the root biome.json.
const mobileInputs = [...filesUnder("mobile"), "biome.json", MOBILE_WORKFLOW];

const paths = (list: string): string[] => list.trim().split(/\s+/);

const filters = [
	{
		name: "ios-ci",
		path: IOS_WORKFLOW,
		inputs: iosInputs,
		triggers: paths(`ios/x ios/scripts/check.sh src/server.ts src/mobile/router.ts data/genre-taxonomy.json
			cache/nodes/x.json package.json package-lock.json tsconfig.json ${HARNESS} ${IOS_WORKFLOW}`),
		ignored: paths(`vitest.config.ts test/foo.test.ts test/helpers/yield-event-loop.setup.ts
			.claude/agents/implementer.md docs/plans/track1-mobile.md README.md web/index.html .deployed-sha biome.json
			mobile/app/index.tsx mobile/package-lock.json .github/workflows/ci.yml ${MOBILE_WORKFLOW}`),
	},
	{
		name: "mobile-ci",
		path: MOBILE_WORKFLOW,
		inputs: mobileInputs,
		triggers: paths(
			`mobile/app/index.tsx mobile/package-lock.json mobile/.env.example biome.json ${MOBILE_WORKFLOW}`,
		),
		ignored: paths(`ios/x src/server.ts data/genre-taxonomy.json cache/nodes/x.json package.json
			vitest.config.ts test/foo.test.ts .claude/agents/implementer.md docs/plans/track1-mobile.md README.md
			.github/workflows/ci.yml ${IOS_WORKFLOW}`),
	},
] as const;

describe("path filter helpers (TRA-417)", () => {
	it("matches globs like GitHub does", () => {
		expect(matchesGlob("docs/**", "docs/plans/track1-mobile.md")).toBe(true);
		expect(matchesGlob("*.md", "README.md")).toBe(true);
		expect(matchesGlob("*.md", "ios/NOTES.md")).toBe(false);
		expect(matchesGlob("docs/**", "src/docs/x.ts")).toBe(false);
		expect(matchesGlob("data/*.json", "data/genre-taxonomy.json")).toBe(true);
		expect(matchesGlob("data/*.json", "data/sub/x.json")).toBe(false);
		expect(matchesGlob("tsconfig*.json", "tsconfig.json")).toBe(true);
		expect(matchesGlob("tsconfig*.json", "mobile/tsconfig.json")).toBe(false);
	});

	it("starts the workflow when at least one changed file matches, never when none does", () => {
		const globs = ["src/**"];
		expect(startsWorkflow(globs, ["docs/a.md", "src/server.ts"])).toBe(true);
		expect(startsWorkflow(globs, ["docs/a.md", ".claude/x", "vitest.config.ts"])).toBe(false);
		expect(startsWorkflow(globs, [])).toBe(false);
	});

	it("refuses the glob syntax GitHub reads differently from matchesGlob", () => {
		expect(unsupportedGlobs(["src/**", "data/*.json", ".github/workflows/ios-ci.yml"])).toEqual([]);
		for (const glob of ["src/a?.ts", "src/a+.ts", "src/[ab].ts", "src/a].ts", "!docs/**", "src/a\\*.ts"]) {
			expect(unsupportedGlobs([glob])).toEqual([glob]);
			expect(() => matchesGlob(glob, "src/ab.ts")).toThrow(/unsupported glob/);
		}
	});

	it("flags a ../ in a project file, an import leaving mobile/, and a read of an unwatched root", () => {
		expect(parentReferences([{ file: "ios/x.pbxproj", source: "path = ../docs/a.md;" }])).toEqual([
			"ios/x.pbxproj",
		]);
		const escaping = { file: "mobile/src/a.ts", source: 'import { x } from "../../src/schemas";' };
		expect(escapingReferences([escaping], "mobile")).toEqual(["mobile/src/a.ts: ../../src/schemas"]);
		const inside = { file: "mobile/src/a.ts", source: 'import { x } from "../config";' };
		expect(escapingReferences([inside], "mobile")).toEqual([]);
		const read = {
			file: "src/a.ts",
			source: 'g("src/**/*.ts"); join(here, "..", "docs", "a.txt"); // reads "web"\nread("NOTES.md");',
		};
		expect(readsOutside([read], ["docs", "web"])).toEqual(["src/a.ts: docs", "src/a.ts: NOTES.md"]);
	});
});

describe("ios-check inputs (TRA-417)", () => {
	it("reads the harness import graph from src/", () => {
		const graph = harnessImportGraph(HARNESS);
		expect(graph).toContain("src/server.ts");
		expect(graph).toContain("src/mobile/router.ts");
		expect(graph).toContain("src/schemas.ts");
		expect(graph).toContain(HARNESS);
	});

	it("leaves .deployed-sha out of paths: it is gitignored, so no PR changes it", () => {
		expect(readFileSync(".gitignore", "utf8").split("\n")).toContain(".deployed-sha");
	});

	it("has no ../ in the Xcode project files, so the project reads nothing outside ios/", () => {
		const projectFiles = filesUnder("ios").filter((f) =>
			/\.(pbxproj|xcconfig|xcscheme|xcworkspacedata|plist|entitlements)$/.test(f),
		);
		expect(projectFiles).toContain("ios/Track1.xcodeproj/project.pbxproj");
		expect(parentReferences(readAll(projectFiles))).toEqual([]);
	});

	it("names only covered repo paths after $repository_root in check.sh", () => {
		const script = readFileSync("ios/scripts/check.sh", "utf8");
		const reads = [...script.matchAll(/\$repository_root\/([\w./-]+)/g)].map((m) => m[1] ?? "");
		expect(reads).toContain("package-lock.json");
		const repoReads = reads.filter((path) => !path.startsWith("node_modules/"));
		const globs = pathsOf(onBlockOf(withoutComments(readFileSync(IOS_WORKFLOW, "utf8"))));
		expect(uncovered(globs, repoReads)).toEqual([]);
	});

	it("reads no unwatched root entry (docs, .claude, web, Markdown...) from the harness import graph", () => {
		const globs = pathsOf(onBlockOf(withoutComments(readFileSync(IOS_WORKFLOW, "utf8"))));
		const outside = rootEntriesOutside(globs);
		expect(outside).toContain("docs");
		expect(outside).toContain(".claude");
		expect(readsOutside(readAll(harnessImportGraph(HARNESS)), outside)).toEqual([]);
	});
});

describe("mobile-check inputs (TRA-417)", () => {
	it("imports nothing from outside mobile/", () => {
		const sources = filesUnder("mobile").filter(
			(f) => /\.(tsx?|[cm]?js|json)$/.test(f) && !f.endsWith("package-lock.json"),
		);
		expect(sources).toContain("mobile/tsconfig.json");
		expect(escapingReferences(readAll(sources), "mobile")).toEqual([]);
	});
});

describe.each(filters)("$name path filter (TRA-417)", ({ path, inputs, triggers, ignored }) => {
	const raw = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
	const onBlock = onBlockOf(withoutComments(raw));
	const globs = pathsOf(onBlock);

	it("lists inputs with `paths` under pull_request, not a deny-list", () => {
		expect(onBlock).not.toMatch(/^ {4}paths-ignore:/m);
		expect(onBlock).toMatch(/^ {4}types: \[opened, synchronize, reopened, ready_for_review\]\s*$/m);
	});

	it("uses only the glob syntax the tests model", () => {
		expect(unsupportedGlobs(globs)).toEqual([]);
	});

	it("covers every known input", () => {
		expect(inputs.length).toBeGreaterThan(10);
		expect(uncovered(globs, inputs)).toEqual([]);
	});

	it("needs every entry: removing any one leaves an input uncovered", () => {
		for (const glob of globs) {
			const without = globs.filter((other) => other !== glob);
			expect(uncovered(without, inputs), `removing ${glob}`).not.toEqual([]);
		}
	});

	it("starts on each trigger and on none of the ignored paths", () => {
		for (const file of triggers) expect(startsWorkflow(globs, [file]), file).toBe(true);
		for (const file of ignored) expect(startsWorkflow(globs, [file]), file).toBe(false);
	});

	it("documents the rule, its limit, its date and its symptom in a comment", () => {
		expect(raw).toContain("TRA-417");
		expect(raw).toContain("2026-10-12");
		expect(raw).toContain("#341");
		expect(raw).toContain("every input must be listed in `paths`");
		expect(raw).toContain("3,000 files");
		expect(raw).toContain("`*` stays inside a path segment");
	});
});

// TRA-425: the Swift package ios/Track1Core is an ios-check input (its `swift test` run is wired in by a
// separate ticket of TRA-422), so its manifest and sources must start the workflow. `ios/**` covers them today;
// this names them so that narrowing that glob cannot drop the package silently. The workflow is not changed here.
describe("ios-check Track1Core inputs (TRA-425)", () => {
	const core = ["ios/Track1Core/Package.swift", "ios/Track1Core/Sources/Track1Core/API/URLValidation.swift"];
	const iosGlobs = () => pathsOf(onBlockOf(withoutComments(readFileSync(IOS_WORKFLOW, "utf8"))));

	it("lists the package manifest and a package source file in the ios-ci paths", () => {
		for (const file of core) expect(existsSync(file), file).toBe(true);
		expect(uncovered(iosGlobs(), core)).toEqual([]);
		for (const file of core) expect(startsWorkflow(iosGlobs(), [file]), file).toBe(true);
	});

	it("reports the package as uncovered by a glob list that omits it", () => {
		const narrowed = [
			"ios/Track1/**",
			"ios/Track1Tests/**",
			"ios/Track1UITests/**",
			"ios/Track1.xcodeproj/**",
		];
		expect(uncovered(narrowed, core)).toEqual(core);
	});
});
