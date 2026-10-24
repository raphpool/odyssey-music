import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-24-backfill-guarded-reverse-edges.js";
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

// TRA-564: the REAL guarded reverse-edge backfill through the real deploy/sync-genre-cache.sh, in preview, on a
// small fixture (the pattern of migration-channel-reverse-edges.test.ts: ssh and rsync are local fakes, no
// network). What it proves is the CHANNEL contract: the name matches the channel's pattern, the script accepts the
// flags the channel passes, its manifest passes the channel's validation, and the manifest is the same on every run.

afterAll(removeTmpDirs);

function makeFixture(): ChannelFixture {
	const fx = createChannelWorkspace("guarded-reverse-edges-channel-");
	// 2-step garage names dubstep with the qid dubstep carries (proven), and house with another one (not).
	writeNode(
		fx.repoCacheDir,
		node("genre:2-step-garage", "2-step garage", {
			qid: "Q1165777",
			related_genres: [
				{ ...ref("genre:dubstep", "dubstep"), qid: "Q20474" },
				{ ...ref("genre:house", "house"), qid: "Q999" },
			],
		}),
	);
	writeNode(fx.repoCacheDir, node("genre:dubstep", "Dubstep", { qid: "Q20474" }));
	writeNode(fx.repoCacheDir, node("genre:house", "House", { qid: "Q10" }));
	writeGenreTaxonomy(fx.repoDataDir, false);
	// The server holds a genre the repo does not have, so the union is a real one.
	writeNode(join(fx.serverRoot, "cache"), node("genre:only-server", "only-server"));
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);

describe("migration channel: the guarded reverse-edge backfill (TRA-564)", () => {
	let preview: ChannelOutcome;
	let again: ChannelOutcome;

	beforeAll(async () => {
		const fx = makeFixture();
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		again = await runChannel(fx, ["--migration", MIGRATION_NAME]);
	}, 240_000);

	it("is accepted by the channel in preview: name, script, manifest contract", () => {
		expect(MIGRATION_NAME).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/);
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

	it("declares the channel's fields, the edge it added and the one it refused", () => {
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			blocked: false,
			removed: [],
			renamed: {},
			redirects: {},
			written: 1,
			added: { "genre.related_genres→genre.related_genres": 1 },
			doubtful: [
				{
					pair: "genre.related_genres→genre.related_genres",
					source: "genre:2-step-garage",
					target: "genre:house",
					reason: "qid-mismatch",
				},
			],
			conflicts: [],
			errors: [],
		});
	});

	it("gives a byte-identical manifest on a second run of the channel (nothing time-dependent in it)", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});
});
