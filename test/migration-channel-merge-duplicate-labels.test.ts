import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-20-merge-duplicate-labels.js";
import {
	type ChannelFixture,
	type ChannelOutcome,
	createChannelWorkspace,
	manifestReader,
	node,
	type Obj,
	readServer,
	ref,
	removeTmpDirs,
	runChannel,
	writeGenreTaxonomy,
	writeNode,
} from "./helpers/migration-channel.js";

// TRA-600: the REAL label merge through the real deploy/sync-genre-cache.sh, in preview and with --apply, on a
// small fixture (the pattern of migration-channel-reverse-edges.test.ts; ssh, rsync and curl are local fakes).
// The merge is a deletion: what it proves is the CHANNEL contract. The loser is removed on the server, the nodes
// that exist only in prod are re-pointed, the redirect is shipped, and --apply is refused while the redirect is
// not committed in the repo.

afterAll(removeTmpDirs);

const WARP = ref("label:warp", "Warp");
const WARP_RECORDS = ref("label:warp-records", "Warp Records");

/** `committed`: whether the repo's data/slug-redirects.json already holds the redirect (the repo run landed). */
function makeFixture(committed: boolean): ChannelFixture {
	const fx = createChannelWorkspace("labels-channel-");
	const aphex = ref("artist:aphex-twin", "Aphex Twin");
	const boc = ref("artist:boards-of-canada", "Boards of Canada");

	// The repo AFTER the repo run: merged survivor, re-pointed edges, loser deleted.
	writeNode(fx.repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(
		fx.repoCacheDir,
		node("label:warp", "Warp", {
			founded: "1989",
			roster: [aphex, boc],
			notable_releases: [ref("project:syro", "Syro")],
		}),
	);
	writeNode(fx.repoCacheDir, node("artist:aphex-twin", "Aphex Twin", { labels: [WARP] }));
	writeNode(fx.repoCacheDir, node("artist:boards-of-canada", "Boards of Canada", { labels: [WARP] }));
	writeNode(fx.repoCacheDir, node("project:syro", "Syro", { label: WARP }));
	writeFileSync(join(fx.repoCacheDir, "pending-reverses.json"), "{}");
	writeGenreTaxonomy(fx.repoDataDir);
	const repoSlugRedirects = join(fx.repoDataDir, "slug-redirects.json");
	writeFileSync(
		repoSlugRedirects,
		JSON.stringify({ redirects: committed ? { "label:warp-records": "label:warp" } : {} }),
	);
	// The committed table is the repo's own here, not the server's copy.
	fx.env.REPO_SLUG_REDIRECTS_PATH = repoSlugRedirects;

	// The server BEFORE the merge: both labels, and nodes only prod has, pointing at the loser.
	const serverCache = join(fx.serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeNode(serverCache, node("label:warp", "Warp", { founded: "1989", roster: [aphex] }));
	writeNode(
		serverCache,
		node("label:warp-records", "Warp Records", {
			founded: "1989",
			location: "Sheffield",
			roster: [boc, ref("artist:prod-only", "Prod Only")],
		}),
	);
	writeNode(serverCache, node("artist:boards-of-canada", "Boards of Canada", { labels: [WARP_RECORDS] }));
	writeNode(serverCache, node("artist:prod-only", "Prod Only", { labels: [WARP_RECORDS] }));
	writeNode(serverCache, node("project:prod-only-ep", "Prod EP", { label: WARP_RECORDS }));
	writeFileSync(
		join(serverCache, "pending-reverses.json"),
		JSON.stringify({ "artist:unborn": [{ field: "labels", cardinality: "list", edge: WARP_RECORDS }] }),
	);
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);
const serverNode = (fx: ChannelFixture, type: string, body: string): Obj =>
	readServer(fx, "cache", "nodes", type, `${body}.json`);
const slugsOf = (list: unknown): string[] => (list as { slug: string }[]).map((e) => e.slug);

describe("migration channel: the label merge (TRA-600), redirect committed", () => {
	let fx: ChannelFixture;
	let preview: ChannelOutcome;
	let again: ChannelOutcome;
	let serverBeforeApply: boolean;
	let apply: ChannelOutcome;

	beforeAll(async () => {
		fx = makeFixture(true);
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		again = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		serverBeforeApply = existsSync(join(fx.serverRoot, "cache", "nodes", "label", "warp-records.json"));
		apply = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);
	}, 300_000);

	it("is accepted in preview, declares the deletion and the redirect, and touches nothing on the server", () => {
		expect(`${preview.stdout}\n${preview.stderr}`).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain("Preview only");
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			removed: ["nodes/label/warp-records.json"],
			renamed: {},
			redirects: { "label:warp-records": "label:warp" },
			errors: [],
		});
		expect(serverBeforeApply).toBe(true);
	});

	it("gives a byte-identical manifest on a second preview", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});

	it("with --apply deletes the loser on the server, re-points the nodes only prod has, and ships the redirect", () => {
		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "label", "warp-records.json"))).toBe(false);
		expect(serverNode(fx, "artist", "prod-only").labels).toEqual([WARP]);
		expect(serverNode(fx, "artist", "boards-of-canada").labels).toEqual([WARP]);
		expect(serverNode(fx, "project", "prod-only-ep").label).toEqual(WARP);
		// The union keeps every artist either cache gave the label: 26-from-the-loser is not lost.
		expect(slugsOf(serverNode(fx, "label", "warp").roster).sort()).toEqual([
			"artist:aphex-twin",
			"artist:boards-of-canada",
			"artist:prod-only",
		]);
		expect(readServer(fx, "cache", "pending-reverses.json")["artist:unborn"]).toEqual([
			{ field: "labels", cardinality: "list", edge: WARP },
		]);
		expect(readServer(fx, "data", "slug-redirects.json").redirects).toEqual({
			"label:warp-records": "label:warp",
		});
	});
});

describe("migration channel: the label merge (TRA-600), redirect not committed", () => {
	it("refuses --apply before any server write, and says which redirect is missing", async () => {
		const fx = makeFixture(false);
		const out = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);

		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain("label:warp-records -> label:warp");
		expect(out.stderr).toMatch(/refusing --apply until the redirects above are committed/);
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "label", "warp-records.json"))).toBe(true);
		expect(readServer(fx, "data", "slug-redirects.json").redirects).toEqual({});
	});
});
