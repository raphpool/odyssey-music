import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-18-backfill-images.js";
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

// TRA-489 (a): the REAL image backfill through the real deploy/sync-genre-cache.sh, in preview, on a small
// fixture (the pattern of migration-channel-identity.test.ts: ssh and rsync are local fakes). The fixture holds
// no MBID and no artist name on a work, so the resolver makes no request at all: nothing leaves the machine and
// the run needs no fake server. What it proves is the CHANNEL contract: the name is accepted, the flags are
// the ones the migration parses, the manifest passes the channel's validation and is the same on every run.

const WIKIMEDIA_PHOTO = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg";

afterAll(removeTmpDirs);

function makeFixture(): ChannelFixture {
	const fx = createChannelWorkspace("images-channel-");
	writeNode(fx.repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(fx.repoCacheDir, node("artist:flash", "Flash", { photo_url: WIKIMEDIA_PHOTO }));
	writeNode(fx.repoCacheDir, node("project:bare", "Bare"));
	writeGenreTaxonomy(fx.repoDataDir);
	writeFileSync(join(fx.repoCacheDir, "pending-reverses.json"), "{}");

	const serverCache = join(fx.serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeFileSync(join(serverCache, "pending-reverses.json"), "{}");
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);

describe("migration channel: the image backfill (TRA-489)", () => {
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

	it("does not copy the artist's photo_url (no legacy fallback): every node of the union is in none", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			none: [
				{ slug: "artist:flash", reason: "no-mbid" },
				{ slug: "genre:only-repo", reason: "no-related-image" },
				{ slug: "genre:only-server", reason: "no-related-image" },
				{ slug: "project:bare", reason: "no-mbid" },
			],
			failed: [],
		});
		expect((manifest.coverage as Obj).artist).toEqual({ before: 0, after: 0, total: 1 });
		expect((manifest.bySource as Obj).legacy).toBe(0);
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
