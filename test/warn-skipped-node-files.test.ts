import { describe, expect, it, vi } from "vitest";
import { warnSkippedNodeFiles } from "../scripts/migrations/2026-09-04-merge-genre-duplicates.js";

// TRA-280: the single point of truth for the "skipping unreadable node file" stderr warning,
// previously duplicated (and already diverged) between this migration's own `runMigration` and
// the cache-union builder's `buildCacheUnion` -- see those files' own integration tests for proof
// that both real call sites route through this same function.
describe("warnSkippedNodeFiles", () => {
	it("writes the migration's own format (no source label) when `source` is omitted", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			warnSkippedNodeFiles([{ path: "/cache/nodes/genre/broken.json", error: "Unexpected token" }]);
			expect(stderrSpy).toHaveBeenCalledWith(
				"warning: skipping unreadable node file /cache/nodes/genre/broken.json: Unexpected token\n",
			);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("prefixes the source (repo/server) when given -- the cache-union caller's own, more informative format", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			warnSkippedNodeFiles([
				{ source: "server", path: "/cache/nodes/genre/broken.json", error: "Unexpected token" },
			]);
			expect(stderrSpy).toHaveBeenCalledWith(
				"warning: skipping unreadable server node file /cache/nodes/genre/broken.json: Unexpected token\n",
			);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("writes one line per entry, in order, and nothing for an empty list", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			warnSkippedNodeFiles([]);
			expect(stderrSpy).not.toHaveBeenCalled();

			warnSkippedNodeFiles([
				{ path: "/a.json", error: "e1" },
				{ source: "repo", path: "/b.json", error: "e2" },
			]);
			expect(stderrSpy.mock.calls.map(([chunk]) => String(chunk))).toEqual([
				"warning: skipping unreadable node file /a.json: e1\n",
				"warning: skipping unreadable repo node file /b.json: e2\n",
			]);
		} finally {
			stderrSpy.mockRestore();
		}
	});
});
