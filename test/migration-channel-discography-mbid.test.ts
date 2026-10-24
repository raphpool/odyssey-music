import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-21-backfill-discography-mbid.js";
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

// TRA-619: the REAL discography backfill (TRA-618) through the real deploy/sync-genre-cache.sh, in preview and
// with --apply, on a small fixture (the pattern of migration-channel-merge-duplicate-labels.test.ts: ssh, rsync
// and curl are local fakes). MusicBrainz is a local HTTP server reached through MB_BASE_URL, so nothing leaves
// the machine. What it proves is the CHANNEL contract for a migration that only completes `discography` lists:
// the flags the script parses, the manifest shape, no deletion, pending-reverses.json untouched, the union
// check, the refusal of a run whose MusicBrainz does not answer.

const servers: Server[] = [];
afterAll(async () => {
	removeTmpDirs();
	await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

const FLASH_MBID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const PROD_MBID = "f1c6f5a0-7a3e-4d3c-9b6e-2c1d8e4a5b77";
// Accented on purpose (TRA-632): the slug of the appended work holds a letter only the scoped form transliterates
// (o-slash, ae), so a flag left off would mint `etoile-s-ndag-ther--flash` and no node would answer to it.
const SECOND_WIND_TITLE = "\u00c9toile S\u00f8ndag \u00c6ther";
const SECOND_WIND_SLUG = "project:etoile-sondag-aether--flash";
const RG = {
	firstLight: "11111111-1111-4111-8111-111111111111",
	secondWind: "22222222-2222-4222-8222-222222222222",
	nightShift: "33333333-3333-4333-8333-333333333333",
	dayside: "44444444-4444-4444-8444-444444444444",
};
// Voted and old: the policy's unrated cut depends on the current year, this fixture must not.
const releaseGroup = (id: string, title: string, type: string, date: string, who: [string, string]): Obj => ({
	id,
	title,
	"primary-type": type,
	"secondary-types": [],
	"first-release-date": date,
	rating: { "votes-count": 4 },
	"artist-credit": [{ name: who[1], artist: { id: who[0], name: who[1] } }],
});
const MB_ANSWERS: Record<string, Obj[]> = {
	[FLASH_MBID]: [
		releaseGroup(RG.firstLight, "First Light", "Album", "1999-05-01", [FLASH_MBID, "Flash"]),
		releaseGroup(RG.secondWind, SECOND_WIND_TITLE, "Album", "2003-03-03", [FLASH_MBID, "Flash"]),
	],
	[PROD_MBID]: [
		releaseGroup(RG.nightShift, "Night Shift", "Album", "2001-01-01", [PROD_MBID, "Prod Only"]),
		releaseGroup(RG.dayside, "Dayside", "EP", "2005-05-05", [PROD_MBID, "Prod Only"]),
	],
};

/** A MusicBrainz browse endpoint; `down` answers 400 (not retried by the client, so the artist is `unavailable`). */
async function startMusicBrainz(
	down: boolean,
): Promise<{ baseUrl: string; asked: string[]; refused: string[] }> {
	const asked: string[] = [];
	const refused: string[] = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const artist = url.searchParams.get("artist") ?? "";
		if (down || url.pathname !== "/ws/2/release-group" || !(artist in MB_ANSWERS)) {
			refused.push(`${url.pathname}?artist=${artist}`);
			res.writeHead(400).end("{}");
			return;
		}
		asked.push(artist);
		const type = (url.searchParams.get("type") ?? "").toLowerCase();
		const groups = (MB_ANSWERS[artist] ?? []).filter((g) => String(g["primary-type"]).toLowerCase() === type);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ "release-group-count": groups.length, "release-groups": groups }));
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ws/2`, asked, refused };
}

const PENDING_REPO = {
	"artist:unborn-repo": [{ field: "labels", cardinality: "list", edge: ref("label:warp", "Warp") }],
};
const PENDING_PROD = {
	"artist:unborn-prod": [{ field: "labels", cardinality: "list", edge: ref("label:warp", "Warp") }],
};

interface Fixture extends ChannelFixture {
	mb: { baseUrl: string; asked: string[]; refused: string[] };
}

async function makeFixture(mbDown = false): Promise<Fixture> {
	const base = createChannelWorkspace("discography-channel-");
	const fx: Fixture = { ...base, mb: await startMusicBrainz(mbDown) };
	// The channel asks the fake MusicBrainz, and reads the repo's own tables.
	fx.env.MB_BASE_URL = fx.mb.baseUrl;
	fx.env.REPO_SLUG_REDIRECTS_PATH = join(fx.repoDataDir, "slug-redirects.json");
	fx.env.REPO_REDIRECTS_PATH = join(fx.repoDataDir, "genre-redirects.json");
	fx.env.REPO_IDENTITY_EXCLUSIONS_PATH = join(fx.repoDataDir, "identity-exclusions.json");

	// The repo: one artist with an mbid whose list has an entry WITHOUT mbid, and one artist without mbid.
	writeNode(fx.repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(
		fx.repoCacheDir,
		node("artist:flash", "Flash", {
			mbid: FLASH_MBID,
			discography: [ref("project:first-light", "First Light")],
		}),
	);
	writeNode(fx.repoCacheDir, node("artist:solo", "Solo"));
	writeFileSync(join(fx.repoCacheDir, "pending-reverses.json"), JSON.stringify(PENDING_REPO));
	writeGenreTaxonomy(fx.repoDataDir);
	writeFileSync(fx.env.REPO_SLUG_REDIRECTS_PATH, JSON.stringify({ redirects: {} }));
	// The union's own genre merges mint redirects the committed table must already hold: take the repo's.
	copyFileSync(resolve("data/genre-redirects.json"), fx.env.REPO_REDIRECTS_PATH);
	writeFileSync(fx.env.REPO_IDENTITY_EXCLUSIONS_PATH, JSON.stringify({ artists: {} }));

	// The server: a snapshot with an artist only prod has, mbid included.
	const serverCache = join(fx.serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeNode(
		serverCache,
		node("artist:prod-only", "Prod Only", {
			mbid: PROD_MBID,
			discography: [ref("project:night-shift", "Night Shift")],
		}),
	);
	writeFileSync(join(serverCache, "pending-reverses.json"), JSON.stringify(PENDING_PROD));
	return fx;
}

const manifestOf = manifestReader(MIGRATION_NAME);
const serverArtist = (fx: Fixture, body: string): Obj =>
	readServer(fx, "cache", "nodes", "artist", `${body}.json`);
const mbidsOf = (list: unknown): (string | undefined)[] => (list as { mbid?: string }[]).map((e) => e.mbid);

describe("migration channel: the discography backfill (TRA-619)", () => {
	let fx: Fixture;
	let serverBefore: Record<string, string>;
	let preview: ChannelOutcome;
	let serverAfterPreview: Record<string, string>;
	let backupsAfterPreview: boolean;
	let apply: ChannelOutcome;

	beforeAll(async () => {
		fx = await makeFixture();
		serverBefore = serverTree(fx);
		preview = await runChannel(fx, ["--migration", MIGRATION_NAME]);
		serverAfterPreview = serverTree(fx);
		backupsAfterPreview = existsSync(join(fx.serverRoot, "backups"));
		apply = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);
	}, 300_000);

	it("preview: exits 0, the manifest passes the channel's shape check, no rsync goes to the server", () => {
		expect(`${preview.stdout}\n${preview.stderr}`).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain("Preview only");
		expect(manifestOf(preview)).not.toBe("");
		const previewManifest = JSON.parse(manifestOf(preview)) as Obj;
		expect(previewManifest).toMatchObject({ migration: MIGRATION_NAME, removed: [] });
		// toMatchObject({}) would accept any object: these are compared whole.
		expect(previewManifest.renamed).toEqual({});
		expect(previewManifest.redirects).toEqual({});
		// An rsync reads the server (source) but never writes it: no destination, the last argument, is remote.
		expect(preview.rsyncs.length).toBeGreaterThan(0);
		for (const args of preview.rsyncs) expect(args.at(-1)).not.toMatch(/^test@fake-server:/);
		expect(serverAfterPreview).toEqual(serverBefore);
		expect(backupsAfterPreview).toBe(false);
	});

	it("hands --apply, --manifest and --data-dir to the script, with no --resume and the channel's slug flag", () => {
		const call = preview.npxCalls.find((c) => c.argv.some((x) => x.endsWith(`${MIGRATION_NAME}.ts`)));
		expect(call).toBeDefined();
		const argv = call?.argv ?? [];
		expect(argv).toContain("--apply");
		expect(argv).not.toContain("--resume");
		expect(argv[argv.indexOf("--manifest") + 1]).toMatch(new RegExp(`${MIGRATION_NAME}\\.manifest\\.json$`));
		expect(argv[argv.indexOf("--data-dir") + 1]).toMatch(/migration-data$/);
		// The channel runs every migration with the flag on (TRA-599); the migration still pins it itself.
		expect(call?.scoped).toBe("1");
		// Both mbids reached MusicBrainz, the union's one (prod-only) included; the artist without mbid did not.
		expect([...new Set(fx.mb.asked)].sort()).toEqual([FLASH_MBID, PROD_MBID].sort());
		// Nothing else was asked: not for the artist without mbid, not for anything but release groups.
		expect(fx.mb.refused).toEqual([]);
	});

	it("--apply ships the repo artist and the prod-only artist with completed discographies, deleting nothing", () => {
		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		const applyManifest = JSON.parse(manifestOf(apply)) as Obj;
		expect(applyManifest.removed).toEqual([]);
		expect(applyManifest.renamed).toEqual({});
		expect(applyManifest.redirects).toEqual({});
		expect(apply.stdout).not.toContain("Removing");
		for (const [artist, mbids] of [
			["flash", [RG.firstLight, RG.secondWind]],
			["prod-only", [RG.nightShift, RG.dayside]],
		] as const) {
			// The entry that had no mbid has it now, and the work MusicBrainz knows and the list lacked is appended.
			expect(mbidsOf(serverArtist(fx, artist).discography).sort()).toEqual([...mbids].sort());
		}
		// The entry that existed keeps its slug and name; the appended one is a well-formed project ref.
		const flash = serverArtist(fx, "flash").discography as Obj[];
		expect(flash.find((e) => e.mbid === RG.firstLight)).toMatchObject({
			slug: "project:first-light",
			name: "First Light",
		});
		// ...with the scoped, transliterated slug (title--artist) the cache and the server use.
		expect(flash.find((e) => e.mbid === RG.secondWind)).toMatchObject({
			slug: SECOND_WIND_SLUG,
			type: "project",
			name: SECOND_WIND_TITLE,
		});
		// A discography backfill writes no work and no inverse edge: cache/nodes/project/ does not exist.
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "project"))).toBe(false);
		// Every file the server had is still there: the transfer only adds and overwrites.
		for (const path of Object.keys(serverBefore)) expect(existsSync(join(fx.serverRoot, path))).toBe(true);
		// The repo artist travelled with the union; the one without an mbid was not touched.
		expect(existsSync(join(fx.serverRoot, "cache", "nodes", "artist", "solo.json"))).toBe(true);
		expect(serverArtist(fx, "solo")).toEqual(node("artist:solo", "Solo"));
	});

	it("ships pending-reverses.json identical to the union's input (the repo's and the server's files)", () => {
		expect(readServer(fx, "cache", "pending-reverses.json")).toEqual({ ...PENDING_REPO, ...PENDING_PROD });
		expect(apply.stdout).toMatch(/before the migrations: 2 key\(s\), 2 entries/);
		expect(apply.stdout).toMatch(/after the migrations: 2 key\(s\), 2 entries/);
	});

	it("passes the migrated union through validate-migrated-union.ts, which accepts it", () => {
		const check = apply.npxCalls.find(
			(c) => c.argv.some((x) => x.endsWith("validate-migrated-union.ts")) && c.argv.includes("check"),
		);
		expect(check).toBeDefined();
		expect(apply.stdout + apply.stderr).not.toContain("the migrated union is invalid");
		expect(apply.stdout).toContain("Sync complete");
	});
});

describe("migration channel: the discography backfill (TRA-619), MusicBrainz not answering", () => {
	it("refuses the run before any server write: every artist asked about is unavailable, the script exits 1", async () => {
		const fx = await makeFixture(true);
		const before = serverTree(fx);
		const out = await runChannel(fx, ["--apply", "--migration", MIGRATION_NAME]);

		expect(out.status).not.toBe(0);
		expect(out.stderr).toMatch(new RegExp(`migration ${MIGRATION_NAME} failed \\(exit 1\\) -- refusing`));
		// It is MusicBrainz's silence that refused it: both artists were asked about and answered nothing.
		expect(out.stdout).toContain("2 of 2 artist(s) unavailable on MusicBrainz");
		expect(fx.mb.refused.length).toBeGreaterThan(0);
		expect(serverTree(fx)).toEqual(before);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
		expect(existsSync(join(fx.serverRoot, ".service-active"))).toBe(true);
	});
});
