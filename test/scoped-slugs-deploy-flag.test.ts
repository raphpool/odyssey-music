import { readFileSync } from "node:fs";
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

	it("explains why the flag is not in the env file: a deploy never writes it", () => {
		// The premise of the mechanism. If a deploy ever rewrote the env file, this guard (and the
		// choice of the unit) would have to be revisited.
		expect(deployScript).not.toMatch(/>\s*\/etc\/odyssey-music\.env/);
		expect(bootstrapScript).not.toContain(FLAG);
	});

	it("reports the value the running service received", () => {
		expect(deployScript).toMatch(/\/proc\/\$SERVICE_PID\/environ/);
		expect(deployScript).toMatch(/in the running service/);
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
