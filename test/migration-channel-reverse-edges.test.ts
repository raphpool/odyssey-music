import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-17-backfill-reverse-edges.js";
import {
	type ChannelFixture,
	type ChannelOutcome,
	createChannelWorkspace,
	manifestReader,
	node,
	type Obj,
	ref,
	removeTmpDirs,
	runChannel,
	writeGenreTaxonomy,
	writeNode,
} from "./helpers/migration-channel.js";

// TRA-488: the REAL reverse-edge backfill through the real deploy/sync-genre-cache.sh, in preview, on a small
// fixture (the pattern of migration-channel-images.test.ts: ssh and rsync are local fakes, no network at all).
// What it proves is the CHANNEL contract: the script accepts the flags the channel passes (--data-dir used to
// make it exit 2), its manifest passes the channel's validation, the pending-reverses.json it rewrites passes
// the union check without a duplicate, and the manifest is the same on every run.

afterAll(removeTmpDirs);

// Held by the repo AND by the server: the union must keep one copy, and the migration must not queue it again.
const PENDING_HYPERDUB = {
	"label:hyperdub": [
		{ field: "roster", cardinality: "list", edge: { slug: "artist:burial", type: "artist", name: "Burial" } },
	],
};

function makeFixture(): ChannelFixture {
	const fx = createChannelWorkspace("reverse-edges-channel-");

	// Aphex Twin names a cached label (its roster gains him) and an uncached one (a pending entry).
	writeNode(
		fx.repoCacheDir,
		node("artist:aphex-twin", "Aphex Twin", {
			labels: [ref("label:ninja-tune", "Ninja Tune"), ref("label:warp", "Warp")],
		}),
	);
	writeNode(fx.repoCacheDir, node("label:ninja-tune", "Ninja Tune"));
	// Burial names an uncached label that the repo's and the server's pending files both already queue.
	writeNode(
		fx.repoCacheDir,
		node("artist:burial", "Burial", { labels: [ref("label:hyperdub", "Hyperdub")] }),
	);
	// A project credits a cached artist (his discography gains it) and an uncached one (a pending entry).
	writeNode(
		fx.repoCacheDir,
		node("project:syro", "Syro", {
			artists: [ref("artist:aphex-twin", "Aphex Twin"), ref("artist:gone", "Gone")],
		}),
	);
	writeGenreTaxonomy(fx.repoDataDir, false);
	writeFileSync(join(fx.repoCacheDir, "pending-reverses.json"), JSON.stringify(PENDING_HYPERDUB));

	const serverCache = join(fx.serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeFileSync(join(serverCache, "pending-reverses.json"), JSON.stringify(PENDING_HYPERDUB));
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);

describe("migration channel: the reverse-edge backfill (TRA-488)", () => {
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

	it("declares the channel's fields and the reverse edges added on the union", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			blocked: false,
			removed: [],
			renamed: {},
			redirects: {},
			written: 2,
			added: {
				"artist.labels→label.roster": 1,
				"project.artists→artist.discography": 1,
			},
			pendingAdded: 2,
			unchanged: 1,
			conflicts: [],
			errors: [],
		});
	});

	it("counts the pending entries coherently: the shared one is not duplicated, the new ones are added", () => {
		// The repo and the server both hold label:hyperdub: the union has 1 key / 1 entry. The migration leaves
		// it (unchanged) and queues label:warp and artist:gone.
		expect(preview.stdout).toContain("pending-reverses.json before the migrations: 1 key(s), 1 entries");
		expect(preview.stdout).toContain("pending-reverses.json after the migrations: 3 key(s), 3 entries");
		// A rise is expected for this migration: the channel only warns about it (stderr), the run is not refused.
		expect(preview.status).toBe(0);
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
