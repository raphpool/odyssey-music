import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	artist,
	removeTmpDirsAfterEach,
	thresholdsOf,
	tmp,
	writeJson,
	writeNodes,
} from "./helpers/pull-cache.js";

// deploy/pull-cache.sh (TRA-493). Real ssh is never reached: a fake `ssh` that fails loudly and records
// itself sits first on PATH, and a fake `rsync` records its arguments, then runs the REAL rsync with the
// "host:" prefix of the source cut off, so the directory `SERVER_CACHE_REMOTE` points at stands in for
// the server. The validator and its audit are the real ones (tsx), only the ceilings are the fixture's.

removeTmpDirsAfterEach();

const script = resolve("deploy/pull-cache.sh");
const realRsync = execFileSync("bash", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();

const REPO_NODES = [artist("pull-fixture-repo-one"), artist("pull-fixture-repo-two")];
const SERVER_ONLY = [artist("pull-fixture-new-one"), artist("pull-fixture-new-two")];

function writeFakeBin(dir: string, name: string, body: string): void {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(path, 0o755);
}

interface Setup {
	/** Nodes the server holds, by slug; the repo holds REPO_NODES. */
	server?: Parameters<typeof writeNodes>[1];
	serverRaw?: Record<string, string>;
	/** Ceilings are measured on these nodes (default: the repo's, plus SERVER_ONLY). */
	ceilingsOn?: Parameters<typeof thresholdsOf>[0];
	args?: string[];
	rsyncExit?: number;
	extraServer?: (serverCache: string) => void;
}

function run(setup: Setup = {}) {
	const root = tmp("pull-cache-script-");
	const bin = join(root, "bin");
	const serverCache = join(root, "server-cache");
	const repoCache = join(root, "repo-cache");
	const calls = join(root, "calls.log");
	mkdirSync(bin);
	mkdirSync(join(serverCache, "nodes"), { recursive: true });
	writeNodes(repoCache, REPO_NODES);
	writeNodes(serverCache, setup.server ?? [...REPO_NODES, ...SERVER_ONLY], setup.serverRaw);
	setup.extraServer?.(serverCache);
	writeFakeBin(bin, "ssh", `echo "ssh $*" >> "${calls}"; exit 99`);
	writeFakeBin(
		bin,
		"rsync",
		`echo "rsync $*" >> "${calls}"
if [ "${setup.rsyncExit ?? 0}" != 0 ]; then exit ${setup.rsyncExit ?? 0}; fi
args=("$@"); n=\${#args[@]}
args[$((n-2))]="\${args[$((n-2))]#*:}"
exec "${realRsync}" "\${args[@]}"`,
	);
	const out = join(root, "out");
	const thresholds = writeJson(
		join(root, "thresholds.json"),
		thresholdsOf(setup.ceilingsOn ?? [...REPO_NODES, ...SERVER_ONLY]),
	);
	const result = spawnSync("bash", [script, ...(setup.args ?? [])], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			SERVER_CACHE_REMOTE: serverCache,
			REPO_CACHE_DIR: repoCache,
			PULL_OUT_DIR: out,
			PULL_THRESHOLDS_PATH: thresholds,
		},
	});
	const log = existsSync(calls) ? readFileSync(calls, "utf8") : "";
	const files = (cache: string, slug: string) => {
		const path = join(cache, "nodes", "artist", `${slug.slice("artist:".length)}.json`);
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	};
	return { ...result, log, out, repoCache, serverCache, files };
}

describe("deploy/pull-cache.sh: preview (no --apply)", () => {
	it("prints the classification and the validation result, and copies nothing", () => {
		const r = run();
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("new 2, changed 0, same 2");
		expect(r.stdout).toContain("validation: OK");
		expect(r.stdout).toContain("Preview only (no --apply): 2 node(s) would be copied");
		expect(r.files(r.repoCache, "artist:pull-fixture-new-one")).toBeNull();
		expect(readFileSync(join(r.out, "new.txt"), "utf8")).toBe(
			"artist:pull-fixture-new-one\nartist:pull-fixture-new-two\n",
		);
	});
});

describe("deploy/pull-cache.sh: --apply", () => {
	it("copies the validated new nodes byte for byte and leaves every repo node alone", () => {
		const r = run({ args: ["--apply"] });
		expect(r.status, r.stderr).toBe(0);
		for (const node of SERVER_ONLY) {
			expect(r.files(r.repoCache, node.slug as string)).toBe(r.files(r.serverCache, node.slug as string));
			expect(r.files(r.repoCache, node.slug as string)).not.toBeNull();
		}
		for (const node of REPO_NODES) {
			expect(r.files(r.repoCache, node.slug as string)).toBe(`${JSON.stringify(node, null, 2)}\n`);
		}
		expect(r.stdout).toContain("Copied 2 node(s)");
	});

	it("never copies a changed node: the repo wins, the divergence is only listed", () => {
		const diverged = artist("pull-fixture-repo-two", { origin: "Somewhere else" });
		const r = run({
			args: ["--apply"],
			server: [...REPO_NODES.slice(0, 1), diverged, ...SERVER_ONLY],
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("new 2, changed 1, same 1");
		expect(r.stdout).toContain("artist:pull-fixture-repo-two");
		expect(r.files(r.repoCache, "artist:pull-fixture-repo-two")).toBe(
			`${JSON.stringify(REPO_NODES[1], null, 2)}\n`,
		);
		expect(readFileSync(join(r.out, "changed.txt"), "utf8")).toBe("artist:pull-fixture-repo-two\n");
	});

	it("copies nothing at all when one new node is invalid, and names it", () => {
		const broken = artist("pull-fixture-broken", { editorial_article: "short" });
		const r = run({ args: ["--apply"], server: [...REPO_NODES, ...SERVER_ONLY, broken] });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("artist:pull-fixture-broken: fails the node schema");
		expect(r.stderr).toContain("nothing was copied");
		expect(r.files(r.repoCache, "artist:pull-fixture-new-one")).toBeNull();
		expect(r.files(r.repoCache, "artist:pull-fixture-broken")).toBeNull();
	});

	it("copies nothing when a new node would push an audit metric over its ceiling", () => {
		const r = run({ args: ["--apply"], ceilingsOn: REPO_NODES });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/audit: .* > /);
		expect(r.files(r.repoCache, "artist:pull-fixture-new-one")).toBeNull();
	});
});

describe("deploy/pull-cache.sh: read-only on the server", () => {
	it("runs one rsync from the server to a local scratch dir, and never ssh", () => {
		const r = run({ args: ["--apply"] });
		// A local rsync re-executes itself through PATH as `rsync --server`: that echo is not a second pull.
		const rsyncs = r.log.split("\n").filter((l) => l.startsWith("rsync ") && !l.includes("--server"));
		expect(rsyncs).toHaveLength(1);
		expect(r.log).not.toMatch(/^ssh /m);
		const words = (rsyncs[0] as string).split(" ");
		const [source, dest] = words.slice(-2) as [string, string];
		expect(source).toBe(`root@46.101.167.241:${r.serverCache}/nodes/`);
		expect(dest).not.toContain(":");
		expect(dest).not.toContain(r.repoCache);
		expect(words).not.toContain("--delete");
		expect(words).toContain("--no-links");
		expect(words.join(" ")).not.toMatch(/--remove-source-files|--delete/);
	});

	it("leaves the server tree untouched", () => {
		const r = run({ args: ["--apply"] });
		for (const node of [...REPO_NODES, ...SERVER_ONLY]) {
			expect(r.files(r.serverCache, node.slug as string)).toBe(`${JSON.stringify(node, null, 2)}\n`);
		}
	});

	it("does not follow a symlink planted on the server", () => {
		const r = run({
			args: ["--apply"],
			extraServer: (server) => symlinkSync("/etc/hostname", join(server, "nodes", "artist", "evil.json")),
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.files(r.repoCache, "artist:evil")).toBeNull();
		expect(r.stdout).toContain("new 2, changed 0, same 2");
	});

	it("stops with rsync's status and copies nothing when the pull fails", () => {
		const r = run({ args: ["--apply"], rsyncExit: 23 });
		expect(r.status).toBe(23);
		expect(r.files(r.repoCache, "artist:pull-fixture-new-one")).toBeNull();
	});

	it("takes no argument but --apply", () => {
		const r = run({ args: ["--delete"] });
		expect(r.status).toBe(2);
		expect(r.log).toBe("");
	});
});
