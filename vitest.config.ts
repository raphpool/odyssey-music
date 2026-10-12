import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 30_000,
		reporters: "default",
		// 2026-10-12 (TRA-377): avoids the false `Timeout calling "onTaskUpdate"` failure; see the file for why.
		setupFiles: ["test/helpers/yield-event-loop.setup.ts"],
	},
});
