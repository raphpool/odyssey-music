import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-24-merge-near-duplicate-releases.js";
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
	serverTree,
	writeGenreTaxonomy,
	writeNode,
} from "./helpers/migration-channel.js";

// TRA-633 PR 2: the REAL near-duplicate merge through the real deploy/sync-genre-cache.sh, on the state the prod
// run meets. The repository is AFTER its own run (the node of Harold Budd's album already moved to the survivor's
// slug, the redirect committed); the server is BEFORE (the old node, the old entries, nodes only prod has pointing
// at the old slug). The union holds both nodes. The proof: one node per album on the server, no losing entry,
// lists without duplicates; and without the committed redirect the channel stops instead of shipping the state.

afterAll(removeTmpDirs);

const LOSER = "project:avalon-sutra-as-long-as-i-can-hold-my-breath--harold-budd";
const LOSER_NAME = "Avalon Sutra / As Long As I Can Hold My Breath";
const SURVIVOR = "project:avalon-sutra--harold-budd";
const MBID = "c5fe0b85-fbc8-3dec-9ea0-3d3aa70ba8a3";
const SURVIVOR_ENTRY = {
	...ref(SURVIVOR, "Avalon Sutra"),
	artist: "Harold Budd",
	mbid: MBID,
	year: "2005",
	releaseType: "album",
};
const SURVIVOR_EDGE = { ...ref(SURVIVOR, "Avalon Sutra"), artist: "Harold Budd" };
const LOSER_EDGE = { ...ref(LOSER, LOSER_NAME), artist: "Harold Budd" };
const SAMADHI = ref("label:samadhisound", "Samadhisound");
const BUDD = ref("artist:harold-budd", "Harold Budd");

/** `committed`: whether the repo's data/slug-redirects.json already holds `loser -> survivor`. */
function makeFixture(committed: boolean): ChannelFixture {
	const fx = createChannelWorkspace("near-duplicates-channel-");

	// The repo AFTER the repo run.
	writeNode(fx.repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(
		fx.repoCacheDir,
		node("artist:harold-budd", "Harold Budd", {
			discography: [SURVIVOR_ENTRY],
			landmark_project: SURVIVOR_EDGE,
		}),
	);
	writeNode(
		fx.repoCacheDir,
		node(SURVIVOR, "Avalon Sutra", {
			label: SAMADHI,
			artists: [BUDD],
			tracklist: [ref("track:arabesque-3", "Arabesque 3")],
		}),
	);
	writeNode(
		fx.repoCacheDir,
		node("label:samadhisound", "Samadhisound", { notable_releases: [SURVIVOR_EDGE] }),
	);
	writeFileSync(join(fx.repoCacheDir, "pending-reverses.json"), "{}");
	writeGenreTaxonomy(fx.repoDataDir);
	const repoSlugRedirects = join(fx.repoDataDir, "slug-redirects.json");
	writeFileSync(repoSlugRedirects, JSON.stringify({ redirects: committed ? { [LOSER]: SURVIVOR } : {} }));
	fx.env.REPO_SLUG_REDIRECTS_PATH = repoSlugRedirects;

	// The server BEFORE: the old node and the old entries, and a label only prod has.
	const serverCache = join(fx.serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeNode(
		serverCache,
		node("artist:harold-budd", "Harold Budd", { discography: [LOSER_EDGE], landmark_project: LOSER_EDGE }),
	);
	writeNode(
		serverCache,
		node(LOSER, LOSER_NAME, {
			label: SAMADHI,
			artists: [BUDD],
			tracklist: [ref("track:arabesque-3", "Arabesque 3"), ref("track:faraon", "Faraon")],
		}),
	);
	writeNode(serverCache, node("label:samadhisound", "Samadhisound", { notable_releases: [LOSER_EDGE] }));
	writeNode(serverCache, node("label:prod-only", "Prod Only", { notable_releases: [LOSER_EDGE] }));
	writeFileSync(join(serverCache, "pending-reverses.json"), "{}");
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);
const serverNode = (fx: ChannelFixture, type: string, body: string): Obj =>
	readServer(fx, "cache", "nodes", type, `${body}.json`);
const slugsOf = (list: unknown): string[] => (list as { slug: string }[]).map((e) => e.slug);
const oldNodePath = (fx: ChannelFixture): string =>
	join(fx.serverRoot, "cache", "nodes", "project", `${LOSER.slice("project:".length)}.json`);

describe("migration channel: the near-duplicate merge (TRA-633), repo after / server before", () => {
	let fx: ChannelFixture;
	let preview: ChannelOutcome;
	let again: ChannelOutcome;
	let oldNodeBeforeApply: boolean;
	let apply: ChannelOutcome;

	beforeAll(async () => {
		fx = makeFixture(true);
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		again = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		oldNodeBeforeApply = existsSync(oldNodePath(fx));
		apply = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);
	}, 300_000);

	it("is accepted in preview: the old node is declared renamed, nothing is flagged for the album", () => {
		expect(`${preview.stdout}\n${preview.stderr}`).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		const manifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(manifest).toMatchObject({
			migration: MIGRATION_NAME,
			renamed: { [LOSER]: SURVIVOR },
			removed: [],
			// The redirect is committed already: it is not declared again.
			redirects: {},
			errors: [],
		});
		expect((manifest.merged as Obj[]).map((m) => m.loser)).toEqual([LOSER]);
		expect(oldNodeBeforeApply).toBe(true);
	});

	it("gives a byte-identical manifest on a second preview", () => {
		expect(manifestOf(preview)).not.toBe("");
		expect(manifestOf(again)).toBe(manifestOf(preview));
	});

	it("with --apply leaves one node for the album on the server, with the lists of both, and no losing entry", () => {
		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		expect(existsSync(oldNodePath(fx))).toBe(false);
		const survivor = serverNode(fx, "project", "avalon-sutra--harold-budd");
		expect(slugsOf(survivor.tracklist)).toEqual(["track:arabesque-3", "track:faraon"]);
		const artist = serverNode(fx, "artist", "harold-budd");
		expect(slugsOf(artist.discography)).toEqual([SURVIVOR]);
		expect(artist.discography).toEqual([SURVIVOR_ENTRY]);
		expect((artist.landmark_project as Obj).slug).toBe(SURVIVOR);
	});

	it("with --apply re-points the nodes only prod has, without doubling a list", () => {
		expect(slugsOf(serverNode(fx, "label", "prod-only").notable_releases)).toEqual([SURVIVOR]);
		expect(slugsOf(serverNode(fx, "label", "samadhisound").notable_releases)).toEqual([SURVIVOR]);
		expect(readServer(fx, "data", "slug-redirects.json").redirects).toEqual({ [LOSER]: SURVIVOR });
	});
});

describe("migration channel: the near-duplicate merge (TRA-633), redirect not committed", () => {
	it("stops the channel and writes nothing on the server when two nodes exist and nobody decided", async () => {
		const fx = makeFixture(false);
		const before = serverTree(fx);
		const out = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);

		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain("failed (exit 2) -- refusing");
		expect(`${out.stdout}\n${out.stderr}`).toContain("the redirect is not committed");
		expect(existsSync(oldNodePath(fx))).toBe(true);
		expect(serverTree(fx)).toEqual(before);
	}, 300_000);
});
