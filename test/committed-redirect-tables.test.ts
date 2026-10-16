import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGenreRedirects, parseSlugRedirects } from "../src/genre-registry.js";

// The committed tables are shipped to the server as they are (deploy-server.sh, sync-genre-cache.sh) and
// every read path loads them through these parsers, which throw on a chain or a malformed entry. Tests
// elsewhere use fixtures on purpose (TRA-559), so nothing loaded the real files before a merge.
// 2026-10-16 (TRA-484, review of the PR committing the prod-only redirects): a table that is not
// flattened would break every redirect read in prod; this guard fails the PR instead.
describe("committed redirect tables", () => {
	it("data/slug-redirects.json parses and is flattened", () => {
		const raw: unknown = JSON.parse(readFileSync("data/slug-redirects.json", "utf8"));
		expect(() => parseSlugRedirects(raw)).not.toThrow();
	});

	it("data/genre-redirects.json parses and is flattened", () => {
		const raw: unknown = JSON.parse(readFileSync("data/genre-redirects.json", "utf8"));
		expect(() => parseGenreRedirects(raw)).not.toThrow();
	});
});
