import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scopedReleaseSlugsEnabled } from "../src/flags.js";

// TRA-509: production gets ODYSSEY_SCOPED_RELEASE_SLUGS=1 from the systemd unit that
// deploy/deploy-server.sh regenerates on every deploy. /etc/odyssey-music.env is bootstrapped once
// (deploy/bootstrap-env.sh) and never rewritten by a deploy, so a value that lived only there would
// never reach the service. The script itself talks to a real droplet over ssh and is never run here:
// like test/sync-genre-cache-workflow.test.ts, this file asserts on its text.

const REPO_ROOT = join(__dirname, "..");
const deployScript = readFileSync(join(REPO_ROOT, "deploy/deploy-server.sh"), "utf8");
const bootstrapScript = readFileSync(join(REPO_ROOT, "deploy/bootstrap-env.sh"), "utf8");

const FLAG = "ODYSSEY_SCOPED_RELEASE_SLUGS";

/** The remote script: the quoted heredoc `<<'REMOTE'` ... `REMOTE` run over ssh. */
function remoteScript(script: string): string {
	const start = script.indexOf("<<'REMOTE'\n");
	const end = script.indexOf("\nREMOTE\n", start);
	if (start === -1 || end === -1) throw new Error("REMOTE heredoc not found in deploy-server.sh");
	return script.slice(start + "<<'REMOTE'\n".length, end);
}

/** The systemd unit embedded in the remote script: the quoted heredoc `<<'UNIT'` ... `UNIT`. */
function embeddedUnit(script: string): string {
	const remote = remoteScript(script);
	const start = remote.indexOf("<<'UNIT'\n");
	const end = remote.indexOf("\nUNIT\n", start);
	if (start === -1 || end === -1) throw new Error("systemd unit heredoc not found in deploy-server.sh");
	return remote.slice(start + "<<'UNIT'\n".length, end);
}

/** Value of the `Environment=FLAG=...` directives of the [Service] section, in file order. */
function unitFlagValues(script: string): string[] {
	const unit = embeddedUnit(script);
	const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
	return [...service.matchAll(new RegExp(`^Environment=${FLAG}=(.*)$`, "gm"))].map((m) => m[1] ?? "");
}

/** Shell blocks (`if`/`for`/`while`/`case`) still open at `index`, judged on column-0 keywords. */
function openBlocksBefore(text: string, index: number): number {
	let depth = 0;
	for (const line of text.slice(0, index).split("\n")) {
		if (/^(if|for|while|until|case)\b/.test(line)) depth++;
		if (/^(fi|done|esac)\b/.test(line)) depth--;
	}
	return depth;
}

const saved = process.env[FLAG];
afterEach(() => {
	if (saved === undefined) delete process.env[FLAG];
	else process.env[FLAG] = saved;
});

// Both variants are built from the CURRENT script, whatever its value (1 as shipped by TRA-509, 0 once
// the rollback commit is merged): deploy.yml runs `npm run test` BEFORE `Deploy server`, so a test that
// required the current script to hold a given value would stop the rollback (or the re-enable) at the
// test step and never reach the server. The checks below run on a copy forced to 1 and on a copy
// forced to 0; the value actually committed is documented in the PR and the plan, not asserted here.
const FLAG_LINE = new RegExp(`^Environment=${FLAG}=[01]$`, "m");
const FLAG_LINE_GLOBAL = new RegExp(FLAG_LINE.source, "gm");
const withFlag = (value: "0" | "1") => deployScript.replace(FLAG_LINE, `Environment=${FLAG}=${value}`);
const flagOnScript = withFlag("1");
const flagOffScript = withFlag("0");

describe("deploy-server.sh: scoped release slugs flag (TRA-509)", () => {
	it("the current script has exactly one flag line set to 0 or 1, and each variant carries its value", () => {
		expect(deployScript.match(FLAG_LINE_GLOBAL)).toHaveLength(1);
		expect(flagOnScript).toContain(`\nEnvironment=${FLAG}=1\n`);
		expect(flagOnScript).not.toContain(`Environment=${FLAG}=0`);
		expect(flagOffScript).toContain(`\nEnvironment=${FLAG}=0\n`);
		expect(flagOffScript).not.toContain(`Environment=${FLAG}=1`);
	});

	describe.each([
		["flag forced to 1", flagOnScript],
		["flag forced to 0 (rollback)", flagOffScript],
	])("%s", (_label, script) => {
		it("sets the flag exactly once in the [Service] section of the generated unit, to 0 or 1", () => {
			const values = unitFlagValues(script);
			expect(values).toHaveLength(1);
			expect(["0", "1"]).toContain(values[0]);
		});

		it("sets it to a value src/flags.ts reads consistently", () => {
			const [value] = unitFlagValues(script);
			process.env[FLAG] = value;
			expect(scopedReleaseSlugsEnabled()).toBe(value === "1");
		});

		it("rewrites the unit, reloads systemd and restarts the service on every deploy, in REMOTE, unconditionally", () => {
			const remote = remoteScript(script);
			const write = remote.search(/^cat > \/etc\/systemd\/system\/odyssey-server\.service <<'UNIT'$/m);
			const reload = remote.search(/^systemctl daemon-reload$/m);
			const restart = remote.search(/^systemctl restart odyssey-server\.service$/m);
			expect(write).toBeGreaterThan(-1);
			expect(reload).toBeGreaterThan(write);
			expect(restart).toBeGreaterThan(reload);
			// Column-0 statements of the remote script, with no if/for/while/case open around them.
			for (const index of [write, reload, restart]) expect(openBlocksBefore(remote, index)).toBe(0);
			// And all of it runs remotely: none of the three is outside the REMOTE heredoc.
			const outside = script.replace(remote, "");
			expect(outside).not.toContain("systemctl daemon-reload");
			expect(outside).not.toContain("systemctl restart odyssey-server.service");
		});
	});

	it("never writes /etc/odyssey-music.env: the flag lives in the unit, not in the env file", () => {
		// The premise of the mechanism. If a deploy ever rewrote the env file, this guard (and the
		// choice of the unit) would have to be revisited. Any write form counts: redirect, tee, sed -i,
		// cp, mv, install. Comments and `>&2` (stderr) are not writes.
		const writes = deployScript
			.split("\n")
			.filter((line) => !/^\s*#/.test(line) && line.includes("/etc/odyssey-music.env"))
			.filter((line) => /(>(?!&)|\btee\b|\bsed\b.*\s-i|\bcp\b|\bmv\b|\binstall\b)/.test(line));
		expect(writes).toEqual([]);
		expect(bootstrapScript).not.toContain(FLAG);
	});
});

/** The report block that follows the restart, run for real against stubbed systemctl and /proc. */
function flagReportBlock(): string {
	const start = deployScript.indexOf("# >>> TRA-509 flag report");
	const end = deployScript.indexOf("# <<< TRA-509 flag report");
	if (start === -1 || end === -1) throw new Error("flag report block not found in deploy-server.sh");
	return deployScript.slice(start, end);
}

function runFlagReport(opts: { pid: string; environ?: string; unit: string }) {
	const dir = mkdtempSync(join(tmpdir(), "flag-report-"));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho ${opts.pid}\n`);
		chmodSync(join(bin, "systemctl"), 0o755);
		const procRoot = join(dir, "proc");
		if (opts.environ !== undefined) {
			mkdirSync(join(procRoot, opts.pid), { recursive: true });
			writeFileSync(join(procRoot, opts.pid, "environ"), opts.environ);
		}
		const unitFile = join(dir, "odyssey-server.service");
		writeFileSync(unitFile, opts.unit);
		const result = spawnSync("bash", ["-euo", "pipefail", "-c", flagReportBlock()], {
			encoding: "utf8",
			env: { PATH: `${bin}:${process.env.PATH ?? ""}`, PROC_ROOT: procRoot, UNIT_FILE: unitFile },
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const UNIT_ON = `[Service]\nEnvironment=${FLAG}=1\n[Install]\n`;

describe("deploy-server.sh: report of the flag the running service received (TRA-509)", () => {
	it("prints the value and stays quiet when the process has what the unit declares", () => {
		const r = runFlagReport({ pid: "4242", environ: `PORT=18792\0${FLAG}=1\0HOME=/root\0`, unit: UNIT_ON });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`${FLAG}=1 in the running service (unit: 1)`);
		expect(r.stderr).toBe("");
		expect(r.stdout).not.toContain("::warning");
	});

	it("warns when the env file overrides the unit (the process has 0, the unit says 1)", () => {
		const r = runFlagReport({ pid: "4242", environ: `${FLAG}=0\0`, unit: UNIT_ON });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`${FLAG}=0 in the running service (unit: 1)`);
		expect(r.stderr).toContain("WARN");
		expect(r.stderr).toContain("overrides the unit");
		// GitHub annotation, on stdout (the stream ssh relays into the job log).
		expect(r.stdout).toMatch(/^::warning title=ODYSSEY_SCOPED_RELEASE_SLUGS mismatch::/m);
	});

	it("does not warn on a deliberate rollback written in the unit (0 and 0)", () => {
		const r = runFlagReport({
			pid: "4242",
			environ: `${FLAG}=0\0`,
			unit: UNIT_ON.replace(`${FLAG}=1`, `${FLAG}=0`),
		});
		expect(r.stderr).toBe("");
		expect(r.stdout).not.toContain("::warning");
	});

	it("says <unset> when the process has no such variable", () => {
		const r = runFlagReport({ pid: "4242", environ: "PORT=18792\0", unit: UNIT_ON });
		expect(r.stdout).toContain(`${FLAG}=<unset> in the running service`);
		expect(r.stderr).toContain("WARN");
	});

	it("says <unreadable>, not <unset>, when the service has no main process (MainPID=0)", () => {
		const r = runFlagReport({ pid: "0", unit: UNIT_ON });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`${FLAG}=<unreadable> in the running service`);
		expect(r.stderr).toContain("service is not up");
	});
});

describe("rollback by flag value (TRA-509)", () => {
	it.each([["0"], [""], ["false"]])("a unit value of %j turns the behaviour off", (value) => {
		process.env[FLAG] = value;
		expect(scopedReleaseSlugsEnabled()).toBe(false);
	});

	it("is off when the variable is absent (the default of dev and CI)", () => {
		delete process.env[FLAG];
		expect(scopedReleaseSlugsEnabled()).toBe(false);
	});
});
