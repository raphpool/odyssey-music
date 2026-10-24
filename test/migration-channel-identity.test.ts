import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ChannelFixture,
	type ChannelOutcome,
	createChannelWorkspace,
	node,
	type Obj,
	ref,
	removeTmpDirs,
	runChannel as runChannelOnFixture,
	writeGenreTaxonomy,
	writeNode,
} from "./helpers/migration-channel.js";

// TRA-568: the three REAL identity migrations (artists -> works -> scope) through the real
// deploy/sync-genre-cache.sh, in preview, on a small fixture. Offline: ssh and rsync are local fakes (as in
// genre-cache-sync.test.ts) and MusicBrainz is a fake HTTP server on 127.0.0.1, reached through the
// MB_BASE_URL the code under test already reads -- the external boundary is replaced, nothing else is.

const ARTIST_STEP = "2026-10-15-backfill-artist-identity";
const RELEASE_STEP = "2026-10-15-backfill-release-identity";
const SCOPE_STEP = "2026-10-16-scope-release-slugs";
const ALL_STEPS = [ARTIST_STEP, RELEASE_STEP, SCOPE_STEP];

const MBID_POLE = "45e00f0f-0000-4000-8000-000000000003";

const pendingEntry = (field: string, edge: Obj): Obj => ({ field, cardinality: "list", edge });

// --- A fake MusicBrainz (the artist search and the artist lookup are all these fixtures ask for) ---

let mb: Server;
let mbBase = "";
const mbKinds: string[] = [];

function mbResponse(url: URL): unknown {
	const artist = {
		id: MBID_POLE,
		name: "Pole",
		type: "Person",
		disambiguation: "German IDM/electronic producer/mastering Stefan Betke",
		area: { name: "Germany", type: "Country" },
		"begin-area": { name: "Düsseldorf", type: "City" },
	};
	const [, , , kind, id] = url.pathname.split("/");
	// The works are searched too (a work without mbid): MB answers "nothing like that".
	if (kind === "release-group" || kind === "recording") {
		return { count: 0, offset: 0, "release-groups": [], recordings: [] };
	}
	if (kind !== "artist") return null;
	if (id) return id === MBID_POLE ? { ...artist, relations: [] } : null;
	const phrase = /^(?:artist|alias):"(.*)"$/.exec(url.searchParams.get("query") ?? "")?.[1] ?? "";
	const isAlias = (url.searchParams.get("query") ?? "").startsWith("alias:");
	const hit = !isAlias && phrase.toLowerCase() === "pole";
	return { count: hit ? 1 : 0, offset: 0, artists: hit ? [{ ...artist, score: 100 }] : [] };
}

beforeAll(async () => {
	mb = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		mbKinds.push(url.pathname.split("/")[3] ?? "");
		const body = mbResponse(url);
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

// --- The fixture: a repo cache, and a server cache holding the prod-only artist ---

interface Fixture extends ChannelFixture {
	replayDir: string;
}

function makeFixture(): Fixture {
	const base = createChannelWorkspace("identity-channel-");
	const fx: Fixture = { ...base, replayDir: join(dirname(base.serverRoot), "replay") };
	const { repoCacheDir, serverRoot } = fx;

	// Repo: the stored-mbid Pole with a work credited to it, plus the genre the union's taxonomy guard wants.
	writeNode(repoCacheDir, {
		type: "genre",
		slug: "genre:only-repo",
		name: "only-repo",
		materialized_at: "2026-01-01T00:00:00.000Z",
	});
	writeNode(
		repoCacheDir,
		node("artist:pole--stefan-betke", "Pole", {
			mbid: MBID_POLE,
			disambiguator: "Stefan Betke",
			artist_kind: "person",
			discography: [ref("project:steel", "Steel")],
		}),
	);
	writeNode(
		repoCacheDir,
		node("project:steel", "Steel", { artists: [ref("artist:pole--stefan-betke", "Pole")] }),
	);
	writeGenreTaxonomy(fx.repoDataDir);
	// The same reverse edge recorded under both spellings of Pole (the key the scope merges), and an entry that
	// would put a credit on the work `project:steel` once the scope renames it.
	const discography = pendingEntry("discography", ref("project:steel", "Steel"));
	writeFileSync(
		join(repoCacheDir, "pending-reverses.json"),
		JSON.stringify({
			"artist:pole--stefan-betke": [discography],
			"project:steel": [pendingEntry("artists", ref("artist:a-homonym", "Pole"))],
		}),
	);

	// Server: Pole as prod knows it, no mbid -- the collision the artist manifest has to carry to the scope.
	const serverCache = join(serverRoot, "cache");
	writeNode(serverCache, {
		type: "genre",
		slug: "genre:only-server",
		name: "only-server",
		materialized_at: "2026-01-01T00:00:00.000Z",
	});
	writeNode(serverCache, node("artist:pole", "Pole", { origin: "Düsseldorf, Germany" }));
	writeFileSync(join(serverCache, "pending-reverses.json"), JSON.stringify({ "artist:pole": [discography] }));
	return fx;
}

interface Outcome extends ChannelOutcome {
	/** The kind (artist, release-group, ...) of every MusicBrainz request made during the run. */
	mbKinds: string[];
}

async function runChannel(fx: Fixture, args: string[], env: Record<string, string> = {}): Promise<Outcome> {
	const before = mbKinds.length;
	const out = await runChannelOnFixture(fx, args, {
		MB_BASE_URL: mbBase,
		MIGRATION_REPLAY_DIR: fx.replayDir,
		...env,
	});
	return { ...out, mbKinds: mbKinds.slice(before) };
}

const migrationArgs = (names: string[]): string[] => names.flatMap((n) => ["--migration", n]);
const callOf = (out: Outcome, step: string): string[] | undefined =>
	out.npx.find((argv) => argv.some((a) => a.endsWith(`${step}.ts`)));
/** The ODYSSEY_SCOPED_RELEASE_SLUGS a step ran under (the channel must set it itself), null when unset. */
const scopedFlagOf = (out: Outcome, step: string): string | null | undefined =>
	out.npxCalls.find((c) => c.argv.some((a) => a.endsWith(`${step}.ts`)))?.scoped;
const flagValue = (argv: string[] | undefined, flag: string): string | undefined =>
	argv?.[argv.indexOf(flag) + 1];

describe("migration channel: the three identity migrations (TRA-568)", () => {
	let fx: Fixture;
	let preview: Outcome;
	let apply: Outcome;

	beforeAll(async () => {
		fx = makeFixture();
		preview = await runChannel(fx, migrationArgs(ALL_STEPS));
		apply = await runChannel(fx, ["--apply", ...migrationArgs(ALL_STEPS)]);
	}, 240_000);

	it("passes the three migrations in preview: no refusal, every manifest validated", () => {
		expect(preview.stderr).not.toMatch(/ERROR/);
		expect(preview.status).toBe(0);
		for (const step of ALL_STEPS) {
			expect(preview.stdout).toContain(`==> Migration manifest: ${step}`);
			expect(preview.stdout).toContain(`"migration": "${step}"`);
		}
		expect(preview.stdout).toContain("Preview only");
	});

	it("hands --data-dir and a manifest path to each migration, the scoped-slug flag only to the process", () => {
		for (const step of ALL_STEPS) {
			const argv = callOf(preview, step);
			expect(argv, step).toBeDefined();
			expect(argv).toContain("--apply");
			expect(flagValue(argv, "--data-dir")).toMatch(/migration-data$/);
			expect(flagValue(argv, "--manifest")).toMatch(new RegExp(`${step}\\.manifest\\.json$`));
		}
		// The scope exits 2 without ODYSSEY_SCOPED_RELEASE_SLUGS, and the test's own env has none.
		expect(preview.stdout).toContain(`${SCOPE_STEP} (apply)`);
		expect(preview.stdout).not.toContain("is off");
		expect(process.env.ODYSSEY_SCOPED_RELEASE_SLUGS).toBeUndefined();
		// ...and the artist and work backfills get it too (TRA-599): the cache and the server are scoped and
		// transliterated, so a slug they mint from a name must have that spelling (no exception list).
		expect(scopedFlagOf(preview, SCOPE_STEP)).toBe("1");
		expect(scopedFlagOf(preview, ARTIST_STEP)).toBe("1");
		expect(scopedFlagOf(preview, RELEASE_STEP)).toBe("1");
	});

	it("calls the scope with the artist manifest written by this run's artist step", () => {
		const artistManifest = flagValue(callOf(preview, ARTIST_STEP), "--manifest");
		expect(artistManifest).toBeDefined();
		expect(flagValue(callOf(preview, SCOPE_STEP), "--artist-manifest")).toBe(artistManifest);
		expect(flagValue(callOf(preview, RELEASE_STEP), "--artist-manifest")).toBe(artistManifest);
		// The scope did see the collision (prod-only Pole, no mbid, vs the scoped slug) and merged it.
		expect(preview.stdout).toContain('"artist:pole--stefan-betke": "artist:pole"');
		expect(preview.stdout).toContain('"project:steel": "project:steel--pole"');
	});

	it("keeps the credit entry aimed at the renamed work in pending-reverses.json, merges the duplicate key", () => {
		expect(preview.stdout).toContain("pending-reverses.json before the migrations: 3 key(s), 3 entries");
		// artist:pole + artist:pole--stefan-betke carried the same edge: one entry, applied to the node and
		// dropped; the credit on the work stays pending, applied to nothing.
		expect(preview.stdout).toContain("pending-reverses.json after the migrations: 1 key(s), 1 entries");
		expect(preview.stdout).toContain(
			"1 pending reverse edge(s) not applied (direction not emitted by the runtime, TRA-563)",
		);
	});

	it("replays the preview's identities in the apply of the same job, without asking MusicBrainz", () => {
		expect(preview.mbKinds).toContain("artist");
		for (const step of [ARTIST_STEP, RELEASE_STEP]) {
			expect(apply.stdout).toContain(`Replaying the manifest recorded by the preview for ${step}`);
			expect(apply.stdout).toContain(`${step}: same identities as the preview`);
			expect(flagValue(callOf(apply, step), "--manifest")).toBeDefined();
			expect(callOf(apply, step)).toContain("--resume");
		}
		expect(callOf(apply, SCOPE_STEP)).not.toContain("--resume");
		// Nothing the preview resolved is asked again: no artist request. Only what stayed unresolved (the
		// work MB knows nothing about) is searched again, and ends the same, or the run is refused.
		expect(apply.mbKinds).not.toContain("artist");
		expect(apply.mbKinds.length).toBeLessThan(preview.mbKinds.length);
		// The apply stops later, at the guard that wants the scope's redirects committed first -- not on identities.
		expect(apply.stderr).not.toContain("other identities than the preview");
	});

	it("refuses an apply whose identities differ from the preview's, before any write", async () => {
		// The preview recorded Pole as unresolved; MusicBrainz now resolves it.
		const recorded = join(fx.replayDir, `${ARTIST_STEP}.manifest.json`);
		const manifest = JSON.parse(readFileSync(recorded, "utf8")) as {
			resolved: Record<string, unknown>;
			unresolved: unknown[];
		};
		delete manifest.resolved["artist:pole"];
		manifest.unresolved.push({ slug: "artist:pole", name: "Pole", candidates: 0 });
		writeFileSync(recorded, JSON.stringify(manifest));
		const out = await runChannel(fx, ["--apply", ...migrationArgs(ALL_STEPS)]);
		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain(
			`migration ${ARTIST_STEP} ended with other identities than the preview recorded`,
		);
		expect(callOf(out, RELEASE_STEP)).toBeUndefined();
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
	}, 120_000);
});

describe("migration channel: the scope needs the artist manifest of the same run (TRA-568)", () => {
	it.each([
		["the artist step is absent", [SCOPE_STEP]],
		["the artist step comes after the scope", [SCOPE_STEP, ARTIST_STEP]],
		["only the work step precedes it", [RELEASE_STEP, SCOPE_STEP]],
	])("refuses the scope when %s, before touching the server", async (_label, names) => {
		const fx = makeFixture();
		const out = await runChannel(fx, migrationArgs(names));
		expect(out.status).toBe(1);
		expect(out.stderr).toContain(`${SCOPE_STEP} needs the artist manifest of this run`);
		expect(out.npx).toEqual([]);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
	});
});

describe("migration channel: a replay dir left by another run is refused (TRA-568)", () => {
	it.each([
		["another revision or migration list", { context: "0000000 some-other-migration\n" }],
		["manifests without a context file", {}],
	])("refuses a replay dir with %s, before any write", async (_label, files) => {
		const fx = makeFixture();
		mkdirSync(fx.replayDir, { recursive: true });
		writeFileSync(join(fx.replayDir, `${ARTIST_STEP}.manifest.json`), "{}");
		for (const [name, body] of Object.entries(files)) writeFileSync(join(fx.replayDir, name), body);
		const out = await runChannel(fx, ["--apply", ...migrationArgs(ALL_STEPS)]);
		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain("was recorded by another run");
		expect(out.npx.filter((argv) => argv.some((a) => a.endsWith(`${ARTIST_STEP}.ts`)))).toEqual([]);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
	});
});

describe("migration channel: the identity exclusion list reaches the artist step (TRA-575)", () => {
	const exclusionsAt = (fx: Fixture, name: string, content: string): string => {
		const path = join(dirname(fx.callsLog), name);
		writeFileSync(path, content);
		return path;
	};

	it("hands the committed list to the artist step: it excludes the artist, with the reason", async () => {
		const fx = makeFixture();
		const list = exclusionsAt(
			fx,
			"exclusions.json",
			JSON.stringify({ artists: { "artist:pole--stefan-betke": "fixture reason for the channel" } }),
		);

		const out = await runChannel(fx, migrationArgs([ARTIST_STEP]), {
			REPO_IDENTITY_EXCLUSIONS_PATH: list,
		});

		expect(out.stderr).not.toMatch(/ERROR/);
		expect(out.status).toBe(0);
		// The step printed its manifest: it read the file from the --data-dir the channel built.
		expect(out.stdout).toContain('"status": "excluded"');
		expect(out.stdout).toContain("fixture reason for the channel");
		expect(out.stdout).toMatch(/"slug": "artist:pole--stefan-betke"/);
	}, 120_000);

	it("with the repo's own committed list the artist step is not refused (the file is in --data-dir)", async () => {
		const fx = makeFixture();
		const out = await runChannel(fx, migrationArgs([ARTIST_STEP]));
		expect(out.stderr).not.toMatch(/ERROR/);
		expect(out.status).toBe(0);
		expect(out.stdout).toContain('"excluded": []');
	}, 120_000);

	it("refuses an artist step when the list is missing from the repo, before touching the server", async () => {
		const fx = makeFixture();
		const out = await runChannel(fx, ["--apply", ...migrationArgs([ARTIST_STEP])], {
			REPO_IDENTITY_EXCLUSIONS_PATH: join(dirname(fx.callsLog), "absent.json"),
		});
		expect(out.status).toBe(1);
		expect(out.stderr).toContain("absent.json is missing");
		expect(out.stderr).toContain(
			`${ARTIST_STEP} refuses to run without the committed identity-exclusions list`,
		);
		expect(out.npx).toEqual([]);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
	}, 120_000);

	it("stops the run when the list is invalid: the artist step itself refuses", async () => {
		const fx = makeFixture();
		const out = await runChannel(fx, ["--apply", ...migrationArgs([ARTIST_STEP])], {
			REPO_IDENTITY_EXCLUSIONS_PATH: exclusionsAt(fx, "bad.json", JSON.stringify({ artists: { tyla: "x" } })),
		});
		expect(out.status).toBe(1);
		expect(out.stderr).toContain(`migration ${ARTIST_STEP} failed (exit 2)`);
		expect(existsSync(join(fx.serverRoot, "backups"))).toBe(false);
	}, 120_000);

	it("does not require the list for a run without the artist step", async () => {
		const fx = makeFixture();
		const missing = join(dirname(fx.callsLog), "absent.json");
		const other = await runChannel(fx, migrationArgs([RELEASE_STEP]), {
			REPO_IDENTITY_EXCLUSIONS_PATH: missing,
		});
		expect(other.stderr).not.toContain("identity-exclusions");
		expect(callOf(other, RELEASE_STEP)).toBeDefined();
		const plain = await runChannel(fx, [], { REPO_IDENTITY_EXCLUSIONS_PATH: missing });
		expect(plain.stderr).not.toContain("identity-exclusions");
	}, 120_000);
});
