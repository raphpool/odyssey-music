#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");
const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

const result = spawnSync(tsxBin, [cliEntry, ...process.argv.slice(2)], {
	stdio: "inherit",
});
process.exit(result.status ?? 1);
