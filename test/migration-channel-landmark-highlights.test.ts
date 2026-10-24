import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-19-backfill-landmark-highlights.js";
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

// TRA-491: the REAL landmark-highlights backfill through the real deploy/sync-genre-cache.sh, in preview, on a
// small fixture (the pattern of migration-channel-images.test.ts: ssh and rsync are local fakes). The script is
// offline, so nothing leaves the machine. What it proves is the CHANNEL contract: the name is accepted, the
// flags are the ones the script parses, the manifest passes the channel's validation, picks the credited album
// and is the same on every run.

afterAll(removeTmpDirs);

function makeFixture(): ChannelFixture {
	const fx = createChannelWorkspace("landmark-channel-");
	writeNode(fx.repoCacheDir, node("genre:only-repo", "only-repo"));
	// "Bare" credits Flash; "Foreign" is in Flash's discography too but credits somebody else.
	const bare = { slug: "project:bare", type: "project", name: "Bare" };
	const foreign = { slug: "project:foreign", type: "project", name: "Foreign" };
	writeNode(fx.repoCacheDir, node("artist:flash", "Flash", { discography: [foreign, bare] }));
	writeNode(
		fx.repoCacheDir,
		node("project:bare", "Bare", { artists: [{ slug: "artist:flash", type: "artist", name: "Flash" }] }),
	);
	writeNode(
		fx.repoCacheDir,
		node("project:foreign", "Foreign", {
			artists: [{ slug: "artist:other", type: "artist", name: "Other" }],
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

describe("migration channel: the landmark highlights backfill (TRA-491)", () => {
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

	it("picks the album that credits the artist, excludes the foreign one, and declares nothing deleted", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			written: { landmark_project: 1, reference_track: 0 },
			byReason: { landmark_project: { genreLandmark: 0, imaged: 0, cached: 1, first: 0 } },
			skipped: { landmark_project: [], reference_track: ["artist:flash"] },
			excluded: [
				{
					artist: "artist:flash",
					field: "landmark_project",
					target: "project:foreign",
					reason: "not-credited",
				},
			],
			picks: [{ artist: "artist:flash", field: "landmark_project", target: "project:bare" }],
			failed: [],
		});
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
