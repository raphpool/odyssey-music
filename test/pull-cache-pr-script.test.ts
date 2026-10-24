import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { artist, removeTmpDirsAfterEach, tmp, writeNodes } from "./helpers/pull-cache.js";

// scripts/ci/pull-cache-pr.sh (TRA-493): commit, push, open a draft PR. A real git repository with a real
// bare "origin" on disk; `gh` is a fake that records its arguments, so no PR is ever really opened.

removeTmpDirsAfterEach();

const script = resolve("scripts/ci/pull-cache-pr.sh");
const DATE = "2026-10-24";
const BRANCH = `data/pull-cache-${DATE}`;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
	work: string;
	remote: string;
	out: string;
	summary: string;
	ghCalls: string[];
	ghBody: string | null;
}

/** A work tree on `main` holding artist:base, plus a bare remote it was cloned from. */
function repo(): { work: string; remote: string; root: string } {
	const root = tmp("pull-cache-pr-");
	const remote = join(root, "origin.git");
	const work = join(root, "work");
	git(root, "init", "-q", "--bare", "-b", "main", remote);
	git(root, "init", "-q", "-b", "main", work);
	writeNodes(join(work, "cache"), [artist("base")]);
	git(work, "add", "-A");
	git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
	git(work, "remote", "add", "origin", remote);
	git(work, "push", "-q", "origin", "main");
	return { work, remote, root };
}

interface Options {
	/** Slugs the pull "copied": written into cache/nodes and listed in new.txt. */
	added?: string[];
	listed?: string[];
	changed?: string[];
	ghExit?: number;
	ghMessage?: string;
	/** Reuse an existing repo (second run). */
	existing?: ReturnType<typeof repo>;
	mutate?: (work: string) => void;
}

function run(options: Options = {}): Run {
	const { work, remote, root } = options.existing ?? repo();
	const added = options.added ?? ["a-one", "a-two"];
	writeNodes(
		join(work, "cache"),
		added.map((b) => artist(b)),
	);
	options.mutate?.(work);
	const out = join(root, "out");
	mkdirSync(out, { recursive: true });
	const list = (slugs: string[]) => (slugs.length === 0 ? "" : `${slugs.join("\n")}\n`);
	writeFileSync(join(out, "new.txt"), list((options.listed ?? added).map((b) => `artist:${b}`)));
	writeFileSync(join(out, "changed.txt"), list(options.changed ?? []));

	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const calls = join(root, "gh-calls.log");
	const gh = join(bin, "gh");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "${root}/gh-body.md"; shift; done
echo ${JSON.stringify(options.ghMessage ?? "https://github.com/raphpool/odyssey-music/pull/999")}
exit ${options.ghExit ?? 0}
`,
	);
	chmodSync(gh, 0o755);
	const summary = join(root, "summary.md");
	const result = spawnSync("bash", [script], {
		cwd: work,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			PULL_OUT_DIR: out,
			PULL_DATE: DATE,
			PULL_PUSH_REMOTE: remote,
			GITHUB_STEP_SUMMARY: summary,
		},
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		work,
		remote,
		out,
		summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
		ghCalls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [],
		ghBody: existsSync(join(root, "gh-body.md")) ? readFileSync(join(root, "gh-body.md"), "utf8") : null,
	};
}

const remoteBranches = (remote: string) => git(remote, "branch", "--list").replace(/[* ]/g, "").split("\n");

describe("scripts/ci/pull-cache-pr.sh", () => {
	it("commits the added nodes on a data branch, pushes it and opens a DRAFT PR against main", () => {
		const r = run({ changed: ["artist:base"] });
		expect(r.status, r.stderr).toBe(0);
		expect(remoteBranches(r.remote)).toContain(BRANCH);
		expect(git(r.remote, "log", "-1", "--format=%s%n%b", BRANCH)).toBe(
			"data(cache): rapatrier 2 nœuds JIT de prod\nRefs TRA-493",
		);
		expect(git(r.remote, "diff", "--name-status", "main", BRANCH)).toBe(
			"A\tcache/nodes/artist/a-one.json\nA\tcache/nodes/artist/a-two.json",
		);
		expect(r.ghCalls).toHaveLength(1);
		expect(r.ghCalls[0]).toMatch(
			new RegExp(
				`^pr create --draft --base main --head ${BRANCH} --title data\\(cache\\): rapatrier 2 nœuds JIT de prod --body-file `,
			),
		);
		expect(r.summary).toContain("https://github.com/raphpool/odyssey-music/pull/999");
	});

	it("lists the new and the changed slugs in the PR body, which only references the ticket", () => {
		const r = run({ changed: ["artist:base"] });
		expect(r.ghBody).toContain("nœuds ajoutés : 2");
		expect(r.ghBody).toContain("nœuds divergents (même slug, contenu différent) : 1");
		expect(r.ghBody).toContain("- `artist:a-one`");
		expect(r.ghBody).toContain("- `artist:a-two`");
		expect(r.ghBody).toContain("## Divergences prod / dépôt (1)");
		expect(r.ghBody).toContain("- `artist:base`");
		expect(r.ghBody).toContain("Refs TRA-493");
		// "Fixes" would close the ticket when the data PR merges.
		expect(r.ghBody).not.toMatch(/Fixes/);
	});

	it("never marks the PR ready, enables auto-merge or force-pushes", () => {
		const r = run();
		expect(r.ghCalls.join("\n")).not.toMatch(/ready|merge|--auto/);
		expect(readFileSync(script, "utf8")).not.toMatch(/--force|push -f|gh pr (ready|merge)/);
	});

	it("does nothing when there is no new node: no branch, no commit, no gh call", () => {
		const { work, remote, root } = repo();
		const r = run({ existing: { work, remote, root }, added: [], listed: [], changed: ["artist:base"] });
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("No new node to import (1 changed)");
		expect(remoteBranches(remote)).toEqual(["main"]);
		expect(r.ghCalls).toEqual([]);
		expect(git(work, "branch", "--show-current")).toBe("main");
	});

	it("refuses to commit when a file already in the repo was modified", () => {
		const r = run({
			mutate: (work) =>
				writeNodes(join(work, "cache"), [artist("base", { origin: "overwritten from prod" })]),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("not exactly the 2 added node file(s)");
		expect(remoteBranches(r.remote)).toEqual(["main"]);
		expect(r.ghCalls).toEqual([]);
	});

	it("refuses to commit when the copied files are not the ones new.txt lists", () => {
		const r = run({ added: ["a-one", "a-two", "a-stray"], listed: ["a-one", "a-two"] });
		expect(r.status).toBe(1);
		expect(remoteBranches(r.remote)).toEqual(["main"]);
		expect(r.ghCalls).toEqual([]);
	});

	it("fails on the existing branch of an earlier run instead of rewriting it", () => {
		const first = run();
		expect(first.status, first.stderr).toBe(0);
		// A second run starts from a fresh checkout of main: same date, same branch name.
		const second = repo();
		const r = run({ existing: { ...second, remote: first.remote }, added: ["a-three"] });
		expect(r.status).not.toBe(0);
		expect(r.ghCalls).toEqual([]);
	});

	it("keeps the job green and prints the command when the repo forbids Actions-created PRs", () => {
		const r = run({
			ghExit: 1,
			ghMessage:
				"pull request create failed: GitHub Actions is not permitted to create or approve pull requests",
		});
		expect(r.status, r.stderr).toBe(0);
		expect(remoteBranches(r.remote)).toContain(BRANCH);
		expect(r.summary).toContain("Ouverture de PR refusée");
		expect(r.summary).toContain(`gh pr create --draft --base main --head ${BRANCH}`);
	});

	it("fails on any other gh error", () => {
		const r = run({ ghExit: 1, ghMessage: "HTTP 500" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("gh pr create failed");
		// No orphan branch: a retry the same day must not fail on the push.
		expect(remoteBranches(r.remote)).toEqual(["main"]);
	});
});
