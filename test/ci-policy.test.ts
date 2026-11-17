import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { calculatePrPolicy, readDiffFiles } from "../scripts/ci/pr-policy.js";

describe("calculatePrPolicy", () => {
	it("does not require a scope review at the exact written thresholds", () => {
		const policy = calculatePrPolicy(
			Array.from({ length: 20 }, (_, index) => ({
				path: `src/file-${index}.ts`,
				additions: index === 0 ? 981 : 1,
				deletions: 0,
				binary: false,
			})),
		);

		expect(policy.writtenLines).toBe(1000);
		expect(policy.writtenFiles).toBe(20);
		expect(policy.requiresScopeReview).toBe(false);
	});

	it("requires a scope review above either written threshold", () => {
		expect(
			calculatePrPolicy([{ path: "src/large.ts", additions: 1001, deletions: 0, binary: false }])
				.requiresScopeReview,
		).toBe(true);
		expect(
			calculatePrPolicy(
				Array.from({ length: 21 }, (_, index) => ({
					path: `src/file-${index}.ts`,
					additions: 1,
					deletions: 0,
					binary: false,
				})),
			).requiresScopeReview,
		).toBe(true);
	});

	it("counts additions and deletions for written files, including names with spaces", () => {
		const policy = calculatePrPolicy([
			{ path: "src/with spaces.ts", additions: 4, deletions: 3, binary: false },
			{ path: "test/scaffold.test.ts", additions: 5, deletions: 0, binary: false },
			{ path: "data/genre-catalog.json", additions: 2, deletions: 1, binary: false },
		]);

		expect(policy.writtenLines).toBe(15);
		expect(policy.writtenFiles).toBe(3);
		expect(policy.written.map((file) => file.path)).toEqual([
			"src/with spaces.ts",
			"test/scaffold.test.ts",
			"data/genre-catalog.json",
		]);
	});

	it("separates known generated files with their provenance", () => {
		const policy = calculatePrPolicy([
			{ path: "package-lock.json", additions: 2, deletions: 1, binary: false },
			{ path: "mobile/package-lock.json", additions: 4, deletions: 0, binary: false },
			{ path: "web/data.json", additions: 3, deletions: 2, binary: false },
			{ path: "data/genre-qid-map.json", additions: 1, deletions: 1, binary: false },
			{ path: "cache/nodes/a/artist.json", additions: 6, deletions: 0, binary: false },
			{ path: "test/__snapshots__/graph.snap", additions: 2, deletions: 0, binary: false },
		]);

		expect(policy.generatedLines).toBe(22);
		expect(policy.generatedFiles).toBe(6);
		expect(policy.generated).toEqual([
			{ path: "package-lock.json", provenance: "npm" },
			{ path: "mobile/package-lock.json", provenance: "npm" },
			{ path: "web/data.json", provenance: "scripts/build-graph-json.ts" },
			{ path: "data/genre-qid-map.json", provenance: "scripts/build-genre-qid-map.ts" },
			{ path: "cache/nodes/a/artist.json", provenance: "pipeline" },
			{ path: "test/__snapshots__/graph.snap", provenance: "test runner" },
		]);
	});

	it("classifies only Swift Package Manager resolution locks under ios as generated", () => {
		const policy = calculatePrPolicy([
			{
				path: "ios/Track1.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
				additions: 4,
				deletions: 1,
				binary: false,
			},
			{ path: "ios/Track1.xcodeproj/project.pbxproj", additions: 2, deletions: 1, binary: false },
			{ path: "ios/Track1/App/RootView.swift", additions: 1, deletions: 0, binary: false },
			{ path: "docs/Package.resolved", additions: 3, deletions: 0, binary: false },
		]);

		expect(policy.generated).toEqual([
			{
				path: "ios/Track1.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
				provenance: "Swift Package Manager",
			},
		]);
		expect(policy.written.map((file) => file.path)).toEqual([
			"ios/Track1.xcodeproj/project.pbxproj",
			"ios/Track1/App/RootView.swift",
			"docs/Package.resolved",
		]);
	});

	it("lists binary files separately without declaring them generated", () => {
		const policy = calculatePrPolicy([
			{ path: "assets/cover.png", additions: 0, deletions: 0, binary: true },
			{ path: "scripts/generated.ts", additions: 3, deletions: 1, binary: false },
		]);

		expect(policy.binaryFiles).toEqual([{ path: "assets/cover.png", provenance: "unknown" }]);
		expect(policy.written).toEqual([{ path: "scripts/generated.ts", provenance: "manual" }]);
	});

	it("reads binary files and names with spaces from a real Git diff", async () => {
		const repository = await mkdtemp(join(tmpdir(), "odyssey-ci-policy-"));
		try {
			execFileSync("git", ["init", "--initial-branch=main", repository]);
			execFileSync("git", ["config", "user.email", "ci-policy@example.test"], { cwd: repository });
			execFileSync("git", ["config", "user.name", "CI policy test"], { cwd: repository });
			await writeFile(join(repository, "tracked.txt"), "base\n");
			execFileSync("git", ["add", "."], { cwd: repository });
			execFileSync("git", ["commit", "-m", "base"], { cwd: repository });

			await writeFile(join(repository, "file with spaces.ts"), "written\n");
			await writeFile(join(repository, "cover.bin"), Buffer.from([0, 1, 2, 3]));
			await writeFile(join(repository, "large.ts"), "line\n".repeat(1001));
			execFileSync("git", ["add", "."], { cwd: repository });
			execFileSync("git", ["commit", "-m", "changed"], { cwd: repository });

			const diff = readDiffFiles("HEAD~1", "HEAD", repository);
			expect(diff).toEqual(
				expect.arrayContaining([
					{ path: "file with spaces.ts", additions: 1, deletions: 0, binary: false },
					{ path: "cover.bin", additions: 0, deletions: 0, binary: true },
				]),
			);
			expect(calculatePrPolicy(diff).requiresScopeReview).toBe(true);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	});
});

describe("CI policy integration", () => {
	it("keeps the required protections while making size a review signal", async () => {
		const workflow = await readFile(".github/workflows/ci.yml", "utf8");

		expect(workflow).toContain("types: [opened, synchronize, reopened, ready_for_review]");
		expect(workflow).toContain("github.event.pull_request.draft == false");
		expect(workflow).toContain("runs-on: ubuntu-latest");
		expect(workflow).toContain("permissions: { contents: read, pull-requests: write }");
		expect(workflow).toContain("npx --no-install tsx scripts/ci/pr-policy.ts");
		expect(workflow).toContain('--add-label "tier/3"');
		expect(workflow).toContain('--remove-label "tier/1"');
		expect(workflow).toContain('--remove-label "tier/2"');
		expect(workflow).toContain("npm run test -- --run");
		expect(workflow).not.toContain("--disable-auto");
		expect(workflow).not.toContain("gh pr merge");
	});

	it("requires PR evidence for scope, provenance, and final SHA review", async () => {
		const template = await readFile(".github/pull_request_template.md", "utf8");

		expect(template).toContain("## Périmètre");
		expect(template).toContain("## Décompte du diff");
		expect(template).toContain("Provenance");
		expect(template).toContain("Justification du réexamen de périmètre");
		expect(template).toContain("SHA final");
		expect(template).toContain("Aucune approbation humaine de merge n'est requise");
		expect(template).not.toContain("estimation");
	});
});

describe("web/data.json provenance", () => {
	const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" });

	it("is not tracked: it is generated by build:graph at deploy time (TRA-460)", () => {
		expect(git("ls-files", "web/data.json").trim()).toBe("");
	});

	it("is git-ignored so a local build:graph leaves the tree clean (TRA-460)", () => {
		// check-ignore exits 1 (execFileSync throws) when the path is not ignored.
		expect(() => git("check-ignore", "--quiet", "web/data.json")).not.toThrow();
	});

	it("is still classified as generated if it is ever committed by accident", () => {
		const policy = calculatePrPolicy([{ path: "web/data.json", additions: 1, deletions: 0, binary: false }]);
		expect(policy.generated).toEqual([{ path: "web/data.json", provenance: "scripts/build-graph-json.ts" }]);
	});
});
