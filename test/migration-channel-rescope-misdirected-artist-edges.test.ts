import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-18-rescope-misdirected-artist-edges.js";
import {
	type ChannelFixture,
	type ChannelOutcome,
	createChannelWorkspace,
	manifestReader,
	node,
	type Obj,
	removeTmpDirs,
	runChannel,
	writeGenreTaxonomy,
	writeNode,
} from "./helpers/migration-channel.js";

// TRA-602: the REAL rescope of misdirected artist edges through the real deploy/sync-genre-cache.sh, in preview, on
// a small fixture (the pattern of migration-channel-landmark-highlights.test.ts: ssh and rsync are local fakes).
// The script is offline, so nothing leaves the machine. What it proves is the CHANNEL contract: the name is
// accepted, the flags are the ones the script parses, the redirect table is read from --data-dir (the channel's
// scratch copy of the server's table), the manifest passes the channel's validation and is the same on every run.

afterAll(removeTmpDirs);

function makeFixture(): ChannelFixture {
	const fx = createChannelWorkspace("rescope-channel-", {
		serverSlugRedirects: { "project:zz-fixture-ii": "project:zz-fixture-ii--boyz-ii-men" },
	});
	writeNode(fx.repoCacheDir, node("genre:only-repo", "only-repo"));
	// Moderat lists the bare `project:zz-fixture-ii`; the fixture's redirect table sends it to Boyz II Men's album.
	// That key exists ONLY in the fixture's table (the repo's own data/ has no such key), which is what proves
	// that the table is read from --data-dir.
	// Flash lists a bare slug that is not a redirect key: it stays.
	writeNode(
		fx.repoCacheDir,
		node("artist:moderat", "Moderat", {
			discography: [{ slug: "project:zz-fixture-ii", type: "project", name: "II", year: "2009" }],
		}),
	);
	writeNode(
		fx.repoCacheDir,
		node("artist:flash", "Flash", {
			discography: [{ slug: "project:plain", type: "project", name: "Plain" }],
		}),
	);
	writeNode(
		fx.repoCacheDir,
		node("project:zz-fixture-ii--boyz-ii-men", "II", {
			artists: [{ slug: "artist:boyz-ii-men", type: "artist", name: "Boyz II Men" }],
		}),
	);
	writeGenreTaxonomy(fx.repoDataDir);
	writeFileSync(join(fx.repoCacheDir, "pending-reverses.json"), "{}");

	const serverCache = join(fx.serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeFileSync(join(serverCache, "pending-reverses.json"), "{}");
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);

describe("migration channel: the rescope of misdirected artist edges (TRA-602)", () => {
	let fx: ChannelFixture;
	let preview: ChannelOutcome;
	let again: ChannelOutcome;

	beforeAll(async () => {
		fx = makeFixture();
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		again = await runChannel(fx, ["--migration", MIGRATION_NAME]);
	}, 240_000);

	it("is accepted by the channel in preview: name, script, manifest contract", () => {
		expect(`${preview.stdout}\n${preview.stderr}`).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain(`==> Migration manifest: ${MIGRATION_NAME}`);
		expect(preview.stdout).toContain("Preview only");
	});

	it("hands --apply, --manifest and --data-dir to the script, which accepts them", () => {
		const argv = preview.npx.find((a) => a.some((x) => x.endsWith(`${MIGRATION_NAME}.ts`)));
		expect(argv).toBeDefined();
		expect(argv).toContain("--apply");
		expect(argv?.[argv.indexOf("--manifest") + 1]).toMatch(
			new RegExp(`${MIGRATION_NAME}\\.manifest\\.json$`),
		);
		expect(argv?.[argv.indexOf("--data-dir") + 1]).toMatch(/migration-data$/);
	});

	it("rewrites Moderat's II to its own scoped work, reading the table from --data-dir, and declares nothing deleted", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			rewritten: [
				{
					artist: "artist:moderat",
					field: "discography",
					from: "project:zz-fixture-ii",
					to: "project:ii--moderat",
					reason: "cached-not-credited",
				},
			],
			skippedAliasOrMember: [],
			unjudged: [],
			collisions: [],
			failed: [],
		});
	});

	it("proves that --data-dir is what is read: the repo's own table does not hold the fixture's key", () => {
		// A script that ignored --data-dir would fall back on data/slug-redirects.json of the repo, find no
		// redirect for this key and rewrite nothing: the test above would fail.
		expect(readFileSync(resolve("data/slug-redirects.json"), "utf8")).not.toContain("zz-fixture-ii");
		expect(readFileSync(resolve("data/genre-redirects.json"), "utf8")).not.toContain("zz-fixture-ii");
		expect((JSON.parse(manifestOf(preview)) as { rewritten: unknown[] }).rewritten).toHaveLength(1);
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
