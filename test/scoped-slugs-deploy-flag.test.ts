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

/** The systemd unit embedded in the script: the quoted heredoc `<<'UNIT'` ... `UNIT`. */
function embeddedUnit(): string {
	const start = deployScript.indexOf("<<'UNIT'\n");
	const end = deployScript.indexOf("\nUNIT\n", start);
	if (start === -1 || end === -1) throw new Error("systemd unit heredoc not found in deploy-server.sh");
	return deployScript.slice(start + "<<'UNIT'\n".length, end);
}

/** Value of the `Environment=FLAG=...` directives of the [Service] section, in file order. */
function unitFlagValues(): string[] {
	const unit = embeddedUnit();
	const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
	return [...service.matchAll(new RegExp(`^Environment=${FLAG}=(.*)$`, "gm"))].map((m) => m[1] ?? "");
}

const saved = process.env[FLAG];
afterEach(() => {
	if (saved === undefined) delete process.env[FLAG];
	else process.env[FLAG] = saved;
});

describe("deploy-server.sh: scoped release slugs flag (TRA-509)", () => {
	it("sets the flag exactly once in the [Service] section of the generated unit", () => {
		expect(unitFlagValues()).toHaveLength(1);
	});

	it("sets it to a value src/flags.ts reads as enabled", () => {
		const [value] = unitFlagValues();
		expect(value).toBeDefined();
		process.env[FLAG] = value;
		expect(scopedReleaseSlugsEnabled()).toBe(true);
	});

	it("rewrites the unit and restarts the service on every deploy, not under a condition", () => {
		const write = deployScript.search(/^cat > \/etc\/systemd\/system\/odyssey-server\.service <<'UNIT'$/m);
		const reload = deployScript.indexOf("systemctl daemon-reload");
		const restart = deployScript.indexOf("systemctl restart odyssey-server.service");
		// Column 0: a top-level statement of the remote script, so not nested in an if/for block.
		expect(write).toBeGreaterThan(-1);
		expect(reload).toBeGreaterThan(write);
		expect(restart).toBeGreaterThan(reload);
		const restartLineStart = deployScript.lastIndexOf("\n", restart) + 1;
		expect(deployScript.slice(restartLineStart, restart)).toBe("");
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
	});

	it("warns when the env file overrides the unit (the process has 0, the unit says 1)", () => {
		const r = runFlagReport({ pid: "4242", environ: `${FLAG}=0\0`, unit: UNIT_ON });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`${FLAG}=0 in the running service (unit: 1)`);
		expect(r.stderr).toContain("WARN");
		expect(r.stderr).toContain("overrides the unit");
	});

	it("does not warn on a deliberate rollback written in the unit (0 and 0)", () => {
		const r = runFlagReport({
			pid: "4242",
			environ: `${FLAG}=0\0`,
			unit: UNIT_ON.replace(`${FLAG}=1`, `${FLAG}=0`),
		});
		expect(r.stderr).toBe("");
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
