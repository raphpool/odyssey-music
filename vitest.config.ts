import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 30_000,
		reporters: "default",
		// 2026-10-14 (TRA-450): mbFetch spaces real requests by 1 s (MusicBrainz policy). Tests stub
		// fetch, so the spacing only made suites that call MusicBrainz time out (e.g.
		// test/genre-seed-proposals.test.ts). test/musicbrainz.test.ts opts back in for its own cases.
		env: { MB_MIN_INTERVAL_MS: "0" },
		// 2026-10-12 (TRA-377): avoids the false `Timeout calling "onTaskUpdate"` failure; see the file for why.
		setupFiles: ["test/helpers/yield-event-loop.setup.ts"],
	},
});
