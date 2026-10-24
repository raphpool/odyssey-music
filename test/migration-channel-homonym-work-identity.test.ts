import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME } from "../scripts/migrations/2026-10-20-fix-homonym-work-identity.js";
import {
	type ChannelFixture,
	type ChannelOutcome,
	createChannelWorkspace,
	node,
	type Obj,
	ref,
	removeTmpDirs,
	runChannel as runChannelOnFixture,
	serverTree,
	writeGenreTaxonomy,
	writeNode,
} from "./helpers/migration-channel.js";

// TRA-610 (PR 3, the channel): the REAL homonym migration through the REAL deploy/sync-genre-cache.sh, on a
// small fixture, with a fake MusicBrainz on 127.0.0.1 (MB_BASE_URL: the external boundary is replaced, nothing
// else). What it proves is the contract between the preview and the apply of one job: the apply must rename,
// remove and redirect what the preview did, or the run is refused before it writes to the server.
//
// The migration asks MusicBrainz again in the apply (no --resume: its answers are not recorded, only its
// outcome), so a MusicBrainz that answers differently is the way to make the two runs diverge.

const OLD = "project:wish-you-were-here--american-hot-wax";
const NEW = "project:wish-you-were-here--pink-floyd";
const BARE = "project:wish-you-were-here";

const MB_HOT_WAX = "00000000-0000-4000-8000-0000000000a1";
const MB_FLOYD = "00000000-0000-4000-8000-0000000000a2";
const RG_HOT_WAX = "00000000-0000-4000-8000-0000000000b1";
const RG_FLOYD = "00000000-0000-4000-8000-0000000000b2";
const RG_TWIN_1 = "00000000-0000-4000-8000-0000000000b3";
const RG_TWIN_2 = "00000000-0000-4000-8000-0000000000b4";

// --- A fake MusicBrainz: the release-group search and the lookups behind it ---

/** `resolves`: one Pink Floyd album of that title. `ambiguous`: two with the same date, MB cannot tell. */
type MbMode = "resolves" | "ambiguous";

interface FakeRg {
	id: string;
	artistId: string;
	artist: string;
	date: string;
	type: string;
}

let mb: Server;
let mbBase = "";
let mbMode: MbMode = "resolves";

const rgs = (): FakeRg[] => {
	const hotWax: FakeRg = {
		id: RG_HOT_WAX,
		artistId: MB_HOT_WAX,
		artist: "American Hot Wax",
		date: "2001-05-01",
		type: "EP",
	};
	const floyd = (id: string): FakeRg => ({
		id,
		artistId: MB_FLOYD,
		artist: "Pink Floyd",
		date: "1975-09-12",
		type: "Album",
	});
	return mbMode === "resolves"
		? [hotWax, floyd(RG_FLOYD)]
		: [hotWax, floyd(RG_FLOYD), floyd(RG_TWIN_1), floyd(RG_TWIN_2)];
};

const creditOf = (rg: FakeRg) => [{ name: rg.artist, artist: { id: rg.artistId, name: rg.artist } }];

function mbResponse(url: URL): unknown {
	const [, , , kind, id] = url.pathname.split("/");
	if (kind === "release-group" && !id) {
		const artist = /AND artist:"(.*)"$/.exec(url.searchParams.get("query") ?? "")?.[1];
		const hits = rgs().filter(
			(rg) => artist === undefined || rg.artist.toLowerCase() === artist.toLowerCase(),
		);
		return {
			"release-groups": hits.map((rg) => ({
				id: rg.id,
				title: "Wish You Were Here",
				"artist-credit": creditOf(rg),
				"first-release-date": rg.date,
				"primary-type": rg.type,
			})),
		};
	}
	const rg = rgs().find((r) => r.id === id);
	if (!rg) return null;
	if (kind === "release-group") {
		return {
			"first-release-date": rg.date,
			"primary-type": rg.type,
			releases: [{ id: rg.id, date: rg.date }],
		};
	}
	// /release/<id>: the earliest release of the release group.
	return {
		date: rg.date,
		"label-info": [],
		"artist-credit": creditOf(rg),
		media: [{ tracks: [] }],
	};
}

beforeAll(async () => {
	mb = createServer((req, res) => {
		const body = mbResponse(new URL(req.url ?? "/", "http://127.0.0.1"));
		res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
		res.end(JSON.stringify(body ?? {}));
	});
	await new Promise<void>((done) => mb.listen(0, "127.0.0.1", done));
	mbBase = `http://127.0.0.1:${(mb.address() as AddressInfo).port}/ws/2`;
});

afterAll(async () => {
	await new Promise<void>((done) => mb.close(() => done()));
	removeTmpDirs();
});

// --- The fixture: Pink Floyd's album, in the cache as prod holds it, credited to American Hot Wax ---

interface Fixture extends ChannelFixture {
	replayDir: string;
}

function makeFixture(): Fixture {
	// The pairs the migration would write are committed already (the channel refuses an apply without them):
	// the table the channel hands to the migration is this one.
	const base = createChannelWorkspace("homonym-channel-", {
		serverSlugRedirects: { [OLD]: NEW, [BARE]: NEW },
	});
	const fx: Fixture = { ...base, replayDir: join(dirname(base.serverRoot), "replay") };
	const { repoCacheDir, serverRoot } = fx;

	writeNode(repoCacheDir, node("genre:only-repo", "only-repo"));
	writeNode(
		repoCacheDir,
		node(OLD, "Wish You Were Here", {
			mbid: RG_HOT_WAX,
			year: "2001",
			release_type: "ep",
			editorial_article: `Pink Floyd's ninth studio album, Wish You Were Here, was released in 1975. ${"x".repeat(100)}`,
			editorial_pitch: "Pink Floyd's 1975 concept album Wish You Were Here.",
			artists: [{ ...ref("artist:american-hot-wax", "American Hot Wax"), mbid: MB_HOT_WAX }],
		}),
	);
	writeNode(
		repoCacheDir,
		node("artist:american-hot-wax", "American Hot Wax", {
			mbid: MB_HOT_WAX,
			discography: [ref(OLD, "Wish You Were Here")],
		}),
	);
	// Pink Floyd lists the album (the evidence), as it would be if the work were theirs. No producer edge: with
	// the listing alone, an ambiguous MusicBrainz leaves the work as it is (`skipped`) instead of stripping it.
	writeNode(
		repoCacheDir,
		node("artist:pink-floyd", "Pink Floyd", {
			mbid: MB_FLOYD,
			editorial_article: `Pink Floyd were an English rock band. ${"x".repeat(100)}`,
			discography: [{ ...ref(OLD, "Wish You Were Here"), releaseType: "album", year: "1975" }],
		}),
	);
	writeGenreTaxonomy(fx.repoDataDir);
	writeFileSync(join(repoCacheDir, "pending-reverses.json"), "{}");

	const serverCache = join(serverRoot, "cache");
	writeNode(serverCache, node("genre:only-server", "only-server"));
	writeFileSync(join(serverCache, "pending-reverses.json"), "{}");
	return fx;
}

async function runChannel(
	fx: Fixture,
	args: string[],
	mode: MbMode,
	env: Record<string, string> = {},
): Promise<ChannelOutcome> {
	mbMode = mode;
	return runChannelOnFixture(fx, args, { MB_BASE_URL: mbBase, MIGRATION_REPLAY_DIR: fx.replayDir, ...env });
}

const migrationArgs = ["--migration", MIGRATION_NAME];
const serverNodeExists = (fx: Fixture, slug: string): boolean => {
	const i = slug.indexOf(":");
	return existsSync(join(fx.serverRoot, "cache", "nodes", slug.slice(0, i), `${slug.slice(i + 1)}.json`));
};
const recordedPath = (fx: Fixture): string => join(fx.replayDir, `${MIGRATION_NAME}.manifest.json`);

describe("migration channel: the homonym migration, preview then apply of one job (TRA-610)", () => {
	it("renames the album in the preview, and lets an apply that ends the same go through", async () => {
		const fx = makeFixture();
		const preview = await runChannel(fx, migrationArgs, "resolves");
		expect(preview.stderr).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain(`"${OLD}": "${NEW}"`);

		const apply = await runChannel(fx, ["--apply", ...migrationArgs], "resolves");

		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		expect(apply.stdout).toContain(`${MIGRATION_NAME}: same renamed, removed and redirects as the preview`);
		expect(serverNodeExists(fx, NEW)).toBe(true);
		expect(serverNodeExists(fx, OLD)).toBe(false);
	}, 240_000);

	it("refuses an apply whose MusicBrainz no longer settles the album: the preview's rename would be lost", async () => {
		const fx = makeFixture();
		const preview = await runChannel(fx, migrationArgs, "resolves");
		expect(preview.status).toBe(0);
		expect(preview.stdout).toContain(`"${OLD}": "${NEW}"`);
		const before = serverTree(fx);

		// MusicBrainz now answers "ambiguous": the work is `skipped`, nothing is renamed, and without the check
		// the apply would ship that. The bare slug is already redirected in the committed table: it would 404.
		const apply = await runChannel(fx, ["--apply", ...migrationArgs], "ambiguous");

		expect(apply.status).not.toBe(0);
		expect(apply.stderr).toContain(
			`migration ${MIGRATION_NAME} ended with other renamed, removed or redirects`,
		);
		expect(apply.stderr).toContain(`renamed ${OLD} -> ${NEW}: in the preview, not in the apply`);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
		expect(serverTree(fx)).toEqual(before);
	}, 240_000);

	it("refuses the other way round too: an apply that renames what the preview left alone", async () => {
		const fx = makeFixture();
		const preview = await runChannel(fx, migrationArgs, "ambiguous");
		expect(preview.status).toBe(0);
		expect(preview.stdout).not.toContain(`"${OLD}": "${NEW}"`);
		const before = serverTree(fx);

		const apply = await runChannel(fx, ["--apply", ...migrationArgs], "resolves");

		expect(apply.status).not.toBe(0);
		expect(apply.stderr).toContain(`renamed ${OLD} -> ${NEW}: in the apply, not in the preview`);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
		expect(serverTree(fx)).toEqual(before);
	}, 240_000);

	it("records the outcome of a first run and replays nothing: an apply with no preview in the job goes through", async () => {
		const fx = makeFixture();
		expect(existsSync(recordedPath(fx))).toBe(false);

		const apply = await runChannel(fx, ["--apply", ...migrationArgs], "resolves");

		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		expect(apply.stdout).not.toContain("same renamed, removed and redirects");
		// Allowed, but never silent.
		expect(apply.stderr).toContain(`WARNING: ${MIGRATION_NAME}: no preview recorded`);
		const recorded = JSON.parse(readFileSync(recordedPath(fx), "utf8")) as Obj;
		expect(recorded.renamed).toEqual({ [OLD]: NEW });
		// The migration has no --resume: the channel never passes one.
		expect(apply.npx.find((a) => a.some((x) => x.endsWith(`${MIGRATION_NAME}.ts`)))).not.toContain(
			"--resume",
		);
	}, 240_000);

	it("compares nothing without MIGRATION_REPLAY_DIR (a local run): the apply is not refused", async () => {
		const fx = makeFixture();
		await runChannel(fx, migrationArgs, "resolves", { MIGRATION_REPLAY_DIR: "" });
		const apply = await runChannel(fx, ["--apply", ...migrationArgs], "ambiguous", {
			MIGRATION_REPLAY_DIR: "",
		});
		expect(apply.stderr).not.toMatch(/ERROR/);
		expect(apply.status).toBe(0);
		expect(apply.stderr).toContain(`WARNING: ${MIGRATION_NAME}: MIGRATION_REPLAY_DIR is not set`);
		expect(existsSync(fx.replayDir)).toBe(false);
	}, 240_000);
});
