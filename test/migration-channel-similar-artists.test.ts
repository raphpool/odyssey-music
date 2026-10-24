import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-19-backfill-similar-artists.js";
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

// TRA-490: the REAL similar_artists backfill through the real deploy/sync-genre-cache.sh, in preview, on a small
// fixture (the pattern of migration-channel-images.test.ts: ssh and rsync are local fakes). No artist of the
// fixture has an MBID, so the resolver goes straight to the graph and makes no request at all: nothing leaves
// the machine (ListenBrainz included) and the run needs no fake server. What it proves is the CHANNEL contract: the name is accepted, the flags are
// the ones the migration parses, the manifest passes the channel's validation and is the same on every run.

afterAll(removeTmpDirs);

function makeFixture(): ChannelFixture {
	const fx = createChannelWorkspace("similar-channel-");
	writeNode(fx.repoCacheDir, node("genre:only-repo", "only-repo"));
	const shared = [{ slug: "artist:loner", type: "artist", name: "Loner" }];
	writeNode(fx.repoCacheDir, node("artist:flash", "Flash", { collaborators: shared }));
	writeNode(fx.repoCacheDir, node("artist:spark", "Spark", { collaborators: shared }));
	writeNode(fx.repoCacheDir, node("artist:loner", "Loner"));
	writeNode(fx.repoCacheDir, node("artist:nobody", "Nobody"));
	writeNode(fx.repoCacheDir, node("project:bare", "Bare"));
	writeGenreTaxonomy(fx.repoDataDir);
	writeFileSync(join(fx.repoCacheDir, "pending-reverses.json"), "{}");

	const serverCache = join(fx.serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeFileSync(join(serverCache, "pending-reverses.json"), "{}");
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);

describe("migration channel: the similar_artists backfill (TRA-490)", () => {
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

	it("hands the channel's manifest contract and the distribution: graph and none, no error", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toEqual({
			migration: MIGRATION_NAME,
			removed: [],
			renamed: {},
			redirects: {},
			counts: { listenbrainz: 0, graph: 3, none: 1, kept: 0, errors: 0 },
			fallbacks: { "no-mbid": 4, "lb-unavailable": 0, "lb-rejected": 0, "lb-no-usable-edge": 0 },
			unsafeCandidates: 0,
			ambiguousSlugs: [],
			edgeDigests: {
				"artist:flash": expect.stringMatching(/^[0-9a-f]{16}$/),
				"artist:loner": expect.stringMatching(/^[0-9a-f]{16}$/),
				"artist:spark": expect.stringMatching(/^[0-9a-f]{16}$/),
			},
			listenbrainz: [],
			graph: [
				{ slug: "artist:flash", reason: "no-mbid" },
				{ slug: "artist:loner", reason: "no-mbid" },
				{ slug: "artist:spark", reason: "no-mbid" },
			],
			none: [{ slug: "artist:nobody", reason: "no-mbid" }],
			kept: [],
			errors: [],
		});
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
