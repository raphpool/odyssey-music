import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const setupFile = "test/helpers/yield-event-loop.setup.ts";

// TRA-377: the false `Timeout calling "onTaskUpdate"` failure is only avoided while this setup file
// runs in every worker. Reproduced on 2026-10-12 with six chained `spawnSync("sleep", ["11"])` tests
// (66 s, error without the hook, none with it); that probe takes too long for the suite, so this
// guards the wiring instead of the timing.
describe("vitest config: event-loop yield between tests (TRA-377)", () => {
	it("registers the setup file that yields to the event loop after each test", () => {
		const config = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
		expect(config).toContain(`setupFiles: ["${setupFile}"]`);
	});

	it("ships that setup file with an afterEach hook that waits for a macrotask", () => {
		const path = resolve(root, setupFile);
		expect(existsSync(path)).toBe(true);
		const source = readFileSync(path, "utf8");
		expect(source).toMatch(/afterEach\(/);
		expect(source).toMatch(/realSetImmediate\(resolve\)/);
	});
});
