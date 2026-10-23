import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	KEPT_CLOSED,
	MIGRATION_NAME,
	POSES,
	parseCliArgs,
	RETRACTIONS,
	type RunOptions,
	runEdgeOverrides,
} from "../scripts/migrations/2026-10-23-discography-edge-overrides.js";
import { musicBrainzConfig } from "../src/config.js";
import { LIST_EDGES_BY_TYPE, type NodeType } from "../src/node-spec.js";
import { nodePayloadSchema } from "../src/schemas.js";
import { parseSlug } from "../src/slug.js";

// TRA-652 (+ the two retractions of TRA-654): a closed list of hand decisions about artist.discography edges.
// MusicBrainz is the external boundary: it is a fake `fetch` here, so nothing leaves the machine. The cache is a
// small fixture written to a temp dir; the last describe reads the REAL cache/ of the repo.

type Obj = Record<string, unknown>;

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TODAY = "2026-10-23";
const MBID = {
	"artist:harold-budd": "5c864a6f-146e-4225-986d-3295ce90f784",
	"artist:john-adams": "94f46f90-f220-458d-acd6-5f14c55ab9b2",
	"artist:quadrant": "7c1cc8a1-a237-40b6-ab4a-dca495a8f470",
	"artist:pierre-henry": "24e0aaa1-7961-4ab8-865e-e736226e41c9",
	"artist:hikaru-utada": "b539e453-c4fe-47e3-8a07-8517eac74429",
} as const;

const edge = (slug: string, name: string, extra: Obj = {}): Obj => ({
	slug,
	type: "project",
	name,
	...extra,
});

function artistNode(slug: string, name: string, discography: Obj[], mbid?: string): Obj {
	const type: NodeType = "artist";
	return {
		slug,
		name,
		type,
		editorial_article: "x".repeat(100),
		citations: [{ url: "https://example.com/a", title: "a" }],
		materialized_at: "2026-10-16T00:00:00.000Z",
		editorial_bio: "bio",
		...Object.fromEntries(LIST_EDGES_BY_TYPE[type].map((f) => [f, []])),
		...(mbid === undefined ? {} : { mbid }),
		discography,
	};
}

/** The fixture cache: the five artists of the lists and the two whose entry stays closed. */
function fixtureNodes(): Obj[] {
	const posed = (n: string, year: string, mbid: string): Obj =>
		edge(`project:${n}`, n, { mbid, year, releaseType: "album" });
	return [
		artistNode(
			"artist:harold-budd",
			"Harold Budd",
			[
				posed("perhaps", "2007", "aa0dcd1a-b38b-356c-b70e-b12e1d3f8206"),
				edge("project:the-serpent", "The Serpent (In Quicksilver)"),
				edge("project:avalon-sutra", "Avalon Sutra"),
			],
			MBID["artist:harold-budd"],
		),
		artistNode(
			"artist:john-adams",
			"John Adams",
			[
				posed("harmonielehre", "1985", "11111111-1111-4111-8111-111111111111"),
				edge("project:nixon-in-china", "Nixon in China"),
				edge("project:doctor-atomic", "Doctor Atomic"),
			],
			MBID["artist:john-adams"],
		),
		artistNode(
			"artist:quadrant",
			"Quadrant",
			[posed("rough-puff", "2024", "22222222-2222-4222-8222-222222222222"), edge("project:206", "206")],
			MBID["artist:quadrant"],
		),
		artistNode(
			"artist:pierre-henry",
			"Pierre Henry",
			[
				edge("project:variance-duo--pierre-henry", "Variance / Duo", {
					artist: "Pierre Henry",
					mbid: "b3189f1d-3d84-4966-acac-d1f4ac7b6e44",
					year: "2026",
					releaseType: "album",
				}),
				posed("psyche-rock", "1967", "33333333-3333-4333-8333-333333333333"),
				edge("project:ceremony", "Ceremony"),
			],
			MBID["artist:pierre-henry"],
		),
		artistNode(
			"artist:hikaru-utada",
			"Hikaru Utada",
			[
				edge("project:intentions--hikaru-utada", "Intentions", {
					artist: "Hikaru Utada",
					mbid: "8cad71b2-f26e-47bd-b74e-e54d023f353a",
					year: "2026",
					releaseType: "single",
				}),
				posed("bad-mode", "2022", "44444444-4444-4444-8444-444444444444"),
			],
			MBID["artist:hikaru-utada"],
		),
		artistNode("artist:fats-domino", "Fats Domino", [edge("project:his-greatest-hits", "His Greatest Hits")]),
		artistNode("artist:luigi-nono", "Luigi Nono", [edge("project:intolleranza-1960", "Intolleranza 1960")]),
	];
}

function writeCache(nodes: Obj[]): string {
	const root = mkdtempSync(join(tmpdir(), "edge-overrides-"));
	dirs.push(root);
	for (const n of nodes) {
		const { type, body } = parseSlug(String(n.slug));
		mkdirSync(join(root, "nodes", type), { recursive: true });
		writeFileSync(join(root, "nodes", type, `${body}.json`), `${JSON.stringify(n, null, 2)}\n`);
	}
	return root;
}

const read = (root: string, slug: string): Obj => {
	const { type, body } = parseSlug(slug);
	return JSON.parse(readFileSync(join(root, "nodes", type, `${body}.json`), "utf8")) as Obj;
};
const discographyOf = (root: string, slug: string): Obj[] => read(root, slug).discography as Obj[];
const edgeOf = (root: string, artist: string, slug: string): Obj | undefined =>
	discographyOf(root, artist).find((e) => e.slug === slug);

// What MusicBrainz says today (2026-10-23) about the seven release groups, as the lookups return them.
const credit = (id: string, name: string): Obj => ({ name, artist: { id, name } });
function answers(): Record<string, Obj> {
	const [serpent, nixon, quadrant206] = POSES;
	const [variance, intentions] = RETRACTIONS;
	return {
		[String(serpent?.mbid)]: {
			id: serpent?.mbid,
			title: "The Serpent (In Quicksilver)",
			"primary-type": "EP",
			"first-release-date": "1981",
			"artist-credit": [credit(MBID["artist:harold-budd"], "Harold Budd")],
		},
		[String(nixon?.mbid)]: {
			id: nixon?.mbid,
			title: "Nixon in China",
			"primary-type": "Album",
			"first-release-date": "1988",
			"artist-credit": [
				credit(MBID["artist:john-adams"], "John Adams"),
				credit("cbc3186a-0000-4000-8000-000000000000", "Alice Goodman"),
				credit("94320f83-0000-4000-8000-000000000000", "Edo de Waart"),
			],
		},
		[String(quadrant206?.mbid)]: {
			id: quadrant206?.mbid,
			title: "206",
			"primary-type": "Album",
			"first-release-date": "2015-10-16",
			"artist-credit": [
				credit(MBID["artist:quadrant"], "Quadrant"),
				credit("b516d1cc-0000-4000-8000-000000000000", "Kid Hops"),
				credit("9ab8c1be-0000-4000-8000-000000000000", "Iris"),
			],
		},
		[String(variance?.mbid)]: {
			id: variance?.mbid,
			title: "Variance / Duo",
			"first-release-date": "2026-11-20",
			releases: [{ id: "r1", status: "Official" }],
		},
		[String(intentions?.mbid)]: {
			id: intentions?.mbid,
			title: "Intentions",
			"first-release-date": "2026-03-01",
			releases: [{ id: "r2", title: "Intentions (60s edit)", status: "Promotion" }],
		},
	};
}

interface FakeMusicBrainz {
	fetchImpl: typeof fetch;
	urls: URL[];
	headers: Record<string, string>[];
	times: number[];
	maxInFlight: number;
}

/** A number as answer = that HTTP status. A missing mbid answers 404. */
function fakeMusicBrainz(table: Record<string, Obj | number> = answers()): FakeMusicBrainz {
	const fake: FakeMusicBrainz = {
		urls: [],
		headers: [],
		times: [],
		maxInFlight: 0,
		fetchImpl: async () => new Response(null, { status: 500 }),
	};
	let inFlight = 0;
	fake.fetchImpl = async (input, init) => {
		const url = new URL(String(input));
		fake.urls.push(url);
		fake.headers.push(init?.headers as Record<string, string>);
		fake.times.push(Date.now());
		inFlight++;
		fake.maxInFlight = Math.max(fake.maxInFlight, inFlight);
		await new Promise((done) => setTimeout(done, 5));
		inFlight--;
		const answer = table[url.pathname.split("/").pop() ?? ""];
		if (typeof answer === "number") return new Response("{}", { status: answer });
		if (answer === undefined) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(answer), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	return fake;
}

function run(root: string, fake: FakeMusicBrainz, extra: Partial<RunOptions> = {}) {
	return runEdgeOverrides({
		cacheDir: root,
		apply: true,
		manifestPath: join(root, "out", "manifest.json"),
		fetchImpl: fake.fetchImpl,
		today: TODAY,
		minIntervalMs: 0,
		...extra,
	});
}

const snapshot = (root: string): string[] =>
	fixtureNodes().map((n) =>
		readFileSync(join(root, "nodes", "artist", `${parseSlug(String(n.slug)).body}.json`), "utf8"),
	);

describe("poses (TRA-652)", () => {
	it.each(POSES.map((p) => [p.edge, p] as const))("%s gets its mbid, year and type", async (_slug, pose) => {
		const root = writeCache(fixtureNodes());
		const before = discographyOf(root, pose.artist);
		const result = await run(root, fakeMusicBrainz());
		expect(result.exitCode).toBe(0);
		const posed = edgeOf(root, pose.artist, pose.edge);
		expect(posed).toMatchObject({
			slug: pose.edge,
			type: "project",
			name: pose.title,
			mbid: pose.mbid,
			year: pose.year,
			releaseType: pose.releaseType,
		});
		// Everything else in the list is the same edges, in the same relative order.
		const others = (list: Obj[]) => list.filter((e) => e.slug !== pose.edge);
		expect(others(discographyOf(root, pose.artist))).toEqual(others(before));
		const manifestEntry = result.manifest.poses.find((p) => p.edge === pose.edge);
		expect(manifestEntry).toMatchObject({
			status: "posed",
			mbid: pose.mbid,
			filled: ["year", "releaseType"],
		});
	});

	it("has full, distinct, well-formed mbid, and none for the entries that stay closed", () => {
		const all = [...POSES, ...RETRACTIONS].map((o) => o.mbid);
		for (const mbid of all) expect(mbid).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
		expect(new Set(all).size).toBe(all.length);
		const closed = new Set(KEPT_CLOSED.map((k) => k.edge));
		for (const o of [...POSES, ...RETRACTIONS]) expect(closed.has(o.edge)).toBe(false);
	});

	it("moves a posed edge to its year when the list was in policy order, and nothing else", async () => {
		const root = writeCache(fixtureNodes());
		await run(root, fakeMusicBrainz());
		expect(discographyOf(root, "artist:harold-budd").map((e) => e.slug)).toEqual([
			"project:perhaps",
			"project:the-serpent",
			"project:avalon-sutra",
		]);
		// Newest year first: Nixon (1988) moves ahead of Harmonielehre (1985).
		expect(discographyOf(root, "artist:john-adams").map((e) => e.slug)).toEqual([
			"project:nixon-in-china",
			"project:harmonielehre",
			"project:doctor-atomic",
		]);
	});

	it("keeps every position of a list that was not in policy order", async () => {
		const nodes = fixtureNodes();
		const harold = nodes[0] as Obj;
		harold.discography = [
			edge("project:avalon-sutra", "Avalon Sutra"),
			edge("project:the-serpent", "The Serpent (In Quicksilver)"),
			edge("project:perhaps", "Perhaps", {
				year: "2007",
				releaseType: "album",
				mbid: "55555555-5555-4555-8555-555555555555",
			}),
		];
		const root = writeCache(nodes);
		await run(root, fakeMusicBrainz());
		expect(discographyOf(root, "artist:harold-budd").map((e) => e.slug)).toEqual([
			"project:avalon-sutra",
			"project:the-serpent",
			"project:perhaps",
		]);
	});

	it("completes only the year and type the edge lacked", async () => {
		const nodes = fixtureNodes();
		const quadrant = nodes[2] as Obj;
		(quadrant.discography as Obj[])[1] = edge("project:206", "206", { year: "2016", releaseType: "single" });
		const root = writeCache(nodes);
		const result = await run(root, fakeMusicBrainz());
		expect(edgeOf(root, "artist:quadrant", "project:206")).toMatchObject({
			mbid: "a465667c-f288-4f82-874e-0aef036c95f4",
			year: "2016",
			releaseType: "single",
		});
		expect(result.manifest.poses.find((p) => p.edge === "project:206")?.filled).toEqual([]);
	});

	it("refuses an edge that already holds another mbid and never overwrites it", async () => {
		const nodes = fixtureNodes();
		const other = "99999999-9999-4999-8999-999999999999";
		((nodes[1] as Obj).discography as Obj[])[1] = edge("project:nixon-in-china", "Nixon in China", {
			mbid: other,
		});
		const root = writeCache(nodes);
		const before = snapshot(root);
		const result = await run(root, fakeMusicBrainz());
		expect(result.exitCode).toBe(1);
		expect(result.manifest.poses.find((p) => p.edge === "project:nixon-in-china")).toMatchObject({
			status: "refused",
			refusal: "mbid-conflict",
			detail: other,
		});
		expect(snapshot(root)).toEqual(before);
	});

	it("refuses an edge whose name is not the pinned title", async () => {
		const nodes = fixtureNodes();
		((nodes[2] as Obj).discography as Obj[])[1] = edge("project:206", "Two Oh Six");
		const root = writeCache(nodes);
		const result = await run(root, fakeMusicBrainz());
		expect(result.manifest.poses.find((p) => p.edge === "project:206")).toMatchObject({
			refusal: "name-mismatch",
			detail: "Two Oh Six",
		});
		expect(result.exitCode).toBe(1);
	});

	it("refuses when the edge or the artist is not in the cache", async () => {
		const nodes = fixtureNodes().filter((n) => n.slug !== "artist:john-adams");
		((nodes[0] as Obj).discography as Obj[]).splice(1, 1);
		const root = writeCache(nodes);
		const result = await run(root, fakeMusicBrainz());
		expect(result.manifest.poses.map((p) => [p.edge, p.refusal])).toEqual([
			["project:the-serpent", "edge-missing"],
			["project:nixon-in-china", "artist-missing"],
			["project:206", undefined],
		]);
		expect(result.exitCode).toBe(1);
	});
});

describe("MusicBrainz verification of the poses", () => {
	const wrong: [string, (a: Record<string, Obj>) => void, string][] = [
		[
			"a title that is not the pinned one",
			(a) =>
				Object.assign(a["ab57421b-ec7b-3190-8c98-93e7cc01fe16"] ?? {}, {
					title: "Music From 'Nixon in China'",
				}),
			"title",
		],
		[
			"another release group id",
			(a) =>
				Object.assign(a["bbea6257-57de-4754-a9f0-658166ac02d8"] ?? {}, {
					id: "bbea6257-57de-4754-a9f0-000000000000",
				}),
			"id",
		],
		[
			"another primary type",
			(a) => Object.assign(a["bbea6257-57de-4754-a9f0-658166ac02d8"] ?? {}, { "primary-type": "Album" }),
			"primary-type",
		],
		[
			"another year",
			(a) =>
				Object.assign(a["a465667c-f288-4f82-874e-0aef036c95f4"] ?? {}, {
					"first-release-date": "2016-01-01",
				}),
			"year",
		],
		[
			"a first credit that is not the artist",
			(a) =>
				Object.assign(a["a465667c-f288-4f82-874e-0aef036c95f4"] ?? {}, {
					"artist-credit": [
						credit("b516d1cc-0000-4000-8000-000000000000", "Kid Hops"),
						credit(MBID["artist:quadrant"], "Quadrant"),
					],
				}),
			"first-credit",
		],
	];

	it.each(wrong)("refuses %s, and then writes nothing at all", async (_label, break_, detail) => {
		const table = answers();
		break_(table);
		const root = writeCache(fixtureNodes());
		const before = snapshot(root);
		const fake = fakeMusicBrainz(table);
		const result = await run(root, fake);
		expect(result.exitCode).toBe(1);
		expect(result.manifest.poses.filter((p) => p.status === "refused")).toEqual([
			expect.objectContaining({ refusal: "mismatch", detail }),
		]);
		// The other four items were fine: still, none is applied.
		expect(snapshot(root)).toEqual(before);
		expect(result.written).toBe(0);
	});

	it("refuses and writes nothing when MusicBrainz does not answer", async () => {
		const table: Record<string, Obj | number> = answers();
		table["bbea6257-57de-4754-a9f0-658166ac02d8"] = 503;
		const root = writeCache(fixtureNodes());
		const before = snapshot(root);
		const result = await run(root, fakeMusicBrainz(table));
		expect(result.exitCode).toBe(1);
		expect(result.manifest.poses[0]).toMatchObject({ status: "refused", refusal: "unavailable" });
		expect(snapshot(root)).toEqual(before);
	});

	it("asks again after a 503, waiting for the answer, and ends in the same state", async () => {
		const table = answers();
		const inner = fakeMusicBrainz(table);
		let throttled = 0;
		const fake: FakeMusicBrainz = {
			...inner,
			fetchImpl: async (input, init) => {
				if (throttled < 2) {
					throttled++;
					inner.urls.push(new URL(String(input)));
					return new Response("{}", { status: 503, headers: { "Retry-After": "0" } });
				}
				return inner.fetchImpl(input, init);
			},
		};
		const root = writeCache(fixtureNodes());
		const result = await run(root, fake);
		expect(result.exitCode).toBe(0);
		expect(result.requests).toBe(7);
		expect(edgeOf(root, "artist:quadrant", "project:206")).toHaveProperty("mbid");
	});

	it("gives up after three retries for the whole run, so it never asks ten times", async () => {
		const root = writeCache(fixtureNodes());
		const before = snapshot(root);
		const result = await run(
			root,
			fakeMusicBrainz(Object.fromEntries([...POSES, ...RETRACTIONS].map((o) => [o.mbid, 503]))),
		);
		expect(result.exitCode).toBe(1);
		expect(result.requests).toBeLessThan(10);
		expect(result.manifest.blocked).toBe(true);
		expect(snapshot(root)).toEqual(before);
	});

	it("flags a blocked run in the manifest, whatever the item that blocked it", async () => {
		const table = answers();
		Object.assign(table["a465667c-f288-4f82-874e-0aef036c95f4"] ?? {}, { title: "Two Oh Six" });
		const root = writeCache(fixtureNodes());
		const result = await run(root, fakeMusicBrainz(table));
		expect(result.manifest.blocked).toBe(true);
		expect(result.manifest.totals.posed).toBe(2);
		const clean = await run(writeCache(fixtureNodes()), fakeMusicBrainz());
		expect(clean.manifest.blocked).toBe(false);
	});

	it("treats a body that is not an object as no answer", async () => {
		const root = writeCache(fixtureNodes());
		const fake = fakeMusicBrainz();
		const result = await run(root, {
			...fake,
			fetchImpl: async () => new Response("[1, 2]", { status: 200 }),
		});
		expect(result.exitCode).toBe(1);
		expect(result.manifest.poses.map((p) => p.refusal)).toEqual([
			"unavailable",
			"unavailable",
			"unavailable",
		]);
	});
});

describe("retractions of the two entries added wrongly (TRA-654)", () => {
	it("removes Pierre Henry 'Variance / Duo' (a release announced for 2026-11-20) and traces it", async () => {
		const root = writeCache(fixtureNodes());
		const result = await run(root, fakeMusicBrainz());
		expect(edgeOf(root, "artist:pierre-henry", "project:variance-duo--pierre-henry")).toBeUndefined();
		expect(discographyOf(root, "artist:pierre-henry").map((e) => e.slug)).toEqual([
			"project:psyche-rock",
			"project:ceremony",
		]);
		expect(result.manifest.edgeRetractions[0]).toEqual({
			artist: "artist:pierre-henry",
			edge: "project:variance-duo--pierre-henry",
			mbid: "b3189f1d-3d84-4966-acac-d1f4ac7b6e44",
			reason: "future-release",
			status: "removed",
			musicBrainz: { firstReleaseDate: "2026-11-20", releaseStatuses: { Official: 1 } },
		});
	});

	it("removes Hikaru Utada 'Intentions' (its only release is a promo) and traces it", async () => {
		const root = writeCache(fixtureNodes());
		const result = await run(root, fakeMusicBrainz());
		expect(edgeOf(root, "artist:hikaru-utada", "project:intentions--hikaru-utada")).toBeUndefined();
		expect(discographyOf(root, "artist:hikaru-utada").map((e) => e.slug)).toEqual(["project:bad-mode"]);
		expect(result.manifest.edgeRetractions[1]).toMatchObject({
			status: "removed",
			reason: "promotion-only",
			musicBrainz: { releaseStatuses: { Promotion: 1 } },
		});
	});

	it("keeps the entry, and refuses the run, once the release date has passed", async () => {
		const root = writeCache(fixtureNodes());
		const before = snapshot(root);
		const result = await run(root, fakeMusicBrainz(), { today: "2026-11-20" });
		expect(result.manifest.edgeRetractions[0]).toMatchObject({ status: "refused", refusal: "reason-gone" });
		expect(result.exitCode).toBe(1);
		expect(snapshot(root)).toEqual(before);
	});

	it("keeps the entry once a release other than a promo exists", async () => {
		const table = answers();
		Object.assign(table["8cad71b2-f26e-47bd-b74e-e54d023f353a"] ?? {}, {
			releases: [
				{ id: "r2", status: "Promotion" },
				{ id: "r3", status: "Official" },
			],
		});
		const root = writeCache(fixtureNodes());
		const result = await run(root, fakeMusicBrainz(table));
		expect(result.manifest.edgeRetractions[1]).toMatchObject({ status: "refused", refusal: "reason-gone" });
		expect(edgeOf(root, "artist:hikaru-utada", "project:intentions--hikaru-utada")).toBeDefined();
	});

	it("does not take a release group without any release for a promo-only one", async () => {
		const table = answers();
		Object.assign(table["8cad71b2-f26e-47bd-b74e-e54d023f353a"] ?? {}, { releases: [] });
		const root = writeCache(fixtureNodes());
		const result = await run(root, fakeMusicBrainz(table));
		expect(result.manifest.edgeRetractions[1]).toMatchObject({ status: "refused", refusal: "reason-gone" });
	});

	it("does not take a partial date for a future one unless its earliest day is after today", async () => {
		const table = answers();
		Object.assign(table["b3189f1d-3d84-4966-acac-d1f4ac7b6e44"] ?? {}, { "first-release-date": "2026" });
		const root = writeCache(fixtureNodes());
		const result = await run(root, fakeMusicBrainz(table));
		expect(result.manifest.edgeRetractions[0]).toMatchObject({ status: "refused", refusal: "reason-gone" });
	});

	it("never removes an edge that holds another mbid than the one added by the backfill", async () => {
		const nodes = fixtureNodes();
		const henry = (nodes[3] as Obj).discography as Obj[];
		(henry[0] as Obj).mbid = "99999999-9999-4999-8999-999999999999";
		const root = writeCache(nodes);
		const result = await run(root, fakeMusicBrainz());
		expect(result.manifest.edgeRetractions[0]).toMatchObject({ refusal: "mbid-conflict" });
		expect(edgeOf(root, "artist:pierre-henry", "project:variance-duo--pierre-henry")).toBeDefined();
	});

	it("says so when the edge it would retract holds no mbid at all, and leaves it", async () => {
		const nodes = fixtureNodes();
		const utada = (nodes[4] as Obj).discography as Obj[];
		utada[0] = edge("project:intentions--hikaru-utada", "Intentions");
		const root = writeCache(nodes);
		const result = await run(root, fakeMusicBrainz());
		expect(result.manifest.edgeRetractions[1]).toMatchObject({ refusal: "mbid-conflict", detail: "(none)" });
		expect(edgeOf(root, "artist:hikaru-utada", "project:intentions--hikaru-utada")).toBeDefined();
	});

	it("reports a pending reverse that names a retracted slug, and leaves the file alone", async () => {
		const root = writeCache(fixtureNodes());
		const pending = `${JSON.stringify({ "artist:pierre-henry": [{ slug: "project:variance-duo--pierre-henry" }] })}\n`;
		writeFileSync(join(root, "pending-reverses.json"), pending);
		const result = await run(root, fakeMusicBrainz());
		expect(result.manifest.edgeRetractions[0]?.pendingReverse).toBe(true);
		expect(result.manifest.edgeRetractions[1]?.pendingReverse).toBeUndefined();
		expect(readFileSync(join(root, "pending-reverses.json"), "utf8")).toBe(pending);
	});

	it("takes an edge that is already gone for done: no request, no refusal (the union may lack it)", async () => {
		const nodes = fixtureNodes();
		((nodes[3] as Obj).discography as Obj[]).shift();
		((nodes[4] as Obj).discography as Obj[]).shift();
		const root = writeCache(nodes);
		const fake = fakeMusicBrainz();
		const result = await run(root, fake);
		expect(result.exitCode).toBe(0);
		expect(result.manifest.edgeRetractions.map((r) => r.status)).toEqual(["absent", "absent"]);
		expect(fake.urls.map((u) => u.pathname)).not.toContain(
			"/ws/2/release-group/b3189f1d-3d84-4966-acac-d1f4ac7b6e44",
		);
		expect(fake.urls).toHaveLength(3);
	});

	it("reports a project node it finds, and does not delete it", async () => {
		const root = writeCache([
			...fixtureNodes(),
			{ ...artistNode("project:variance-duo--pierre-henry", "Variance / Duo", []), type: "project" },
		]);
		const result = await run(root, fakeMusicBrainz());
		expect(result.manifest.edgeRetractions[0]?.projectNode).toBe(true);
		expect(result.manifest.edgeRetractions[1]?.projectNode).toBeUndefined();
		expect(statSync(join(root, "nodes", "project", "variance-duo--pierre-henry.json")).isFile()).toBe(true);
		expect(result.manifest.removed).toEqual([]);
	});
});

describe("entries kept closed, and nothing else changes", () => {
	it("leaves His Greatest Hits and Intolleranza 1960 without mbid, and never asks MusicBrainz about them", async () => {
		const root = writeCache(fixtureNodes());
		const fake = fakeMusicBrainz();
		const result = await run(root, fake);
		expect(edgeOf(root, "artist:fats-domino", "project:his-greatest-hits")).not.toHaveProperty("mbid");
		expect(edgeOf(root, "artist:luigi-nono", "project:intolleranza-1960")).not.toHaveProperty("mbid");
		expect(result.manifest.keptClosed).toEqual([
			{ artist: "artist:fats-domino", edge: "project:his-greatest-hits", mbid: null },
			{ artist: "artist:luigi-nono", edge: "project:intolleranza-1960", mbid: null },
		]);
		const asked = fake.urls.map((u) => u.pathname.split("/").pop());
		expect(asked.sort()).toEqual([...POSES, ...RETRACTIONS].map((o) => o.mbid).sort());
	});

	it("rewrites no node other than the four whose list changes, and no field other than `discography`", async () => {
		const root = writeCache(fixtureNodes());
		const before = snapshot(root);
		const result = await run(root, fakeMusicBrainz());
		const after = snapshot(root);
		const changed = fixtureNodes().flatMap((n, i) => (before[i] === after[i] ? [] : [String(n.slug)]));
		expect(changed).toEqual([
			"artist:harold-budd",
			"artist:john-adams",
			"artist:quadrant",
			"artist:pierre-henry",
			"artist:hikaru-utada",
		]);
		expect(result.written).toBe(5);
		for (const slug of changed) {
			const { discography: _d, ...rest } = read(root, slug);
			const { discography: _o, ...original } = fixtureNodes().find((n) => n.slug === slug) ?? {};
			expect(rest).toEqual(original);
		}
		// Written nodes still pass the schema untouched: nothing is stripped, nothing added.
		for (const slug of changed) expect(nodePayloadSchema.safeParse(read(root, slug)).success).toBe(true);
	});

	it("writes no node file in a dry run, and its manifest is the apply's, byte for byte", async () => {
		const root = writeCache(fixtureNodes());
		const before = snapshot(root);
		const dry = await run(root, fakeMusicBrainz(), { apply: false, manifestPath: join(root, "dry.json") });
		expect(snapshot(root)).toEqual(before);
		expect(dry.written).toBe(0);
		await run(root, fakeMusicBrainz(), { apply: true, manifestPath: join(root, "applied.json") });
		expect(readFileSync(join(root, "dry.json"), "utf8")).toBe(
			readFileSync(join(root, "applied.json"), "utf8"),
		);
	});

	it("is idempotent: a second apply asks nothing, writes nothing, and ends in the same state", async () => {
		const root = writeCache(fixtureNodes());
		await run(root, fakeMusicBrainz());
		const afterFirst = snapshot(root);
		const fake = fakeMusicBrainz();
		const again = await run(root, fake);
		expect(again.exitCode).toBe(0);
		expect(fake.urls).toHaveLength(0);
		expect(again.written).toBe(0);
		expect(snapshot(root)).toEqual(afterFirst);
		expect(again.manifest.totals).toEqual({ posed: 0, alreadyPosed: 3, removed: 0, absent: 2, refused: 0 });
	});
});

describe("MusicBrainz etiquette", () => {
	it("asks at most five times, one at a time, with the default User-Agent and no other header", async () => {
		const root = writeCache(fixtureNodes());
		const fake = fakeMusicBrainz();
		const result = await run(root, fake);
		expect(result.requests).toBe(5);
		expect(fake.urls).toHaveLength(5);
		expect(fake.maxInFlight).toBe(1);
		for (const headers of fake.headers) {
			expect(headers).toEqual({ "User-Agent": musicBrainzConfig.userAgent, Accept: "application/json" });
		}
		expect(musicBrainzConfig.userAgent).not.toMatch(/@/);
		for (const url of fake.urls) {
			expect(url.origin).toBe(new URL(musicBrainzConfig.baseUrl).origin);
			expect(dirnameOf(url.pathname)).toBe(`${new URL(musicBrainzConfig.baseUrl).pathname}/release-group`);
		}
	});

	it("leaves at least the configured interval between two requests", async () => {
		const root = writeCache(fixtureNodes());
		const fake = fakeMusicBrainz();
		await run(root, fake, { minIntervalMs: 60 });
		for (let i = 1; i < fake.times.length; i++) {
			expect((fake.times[i] ?? 0) - (fake.times[i - 1] ?? 0)).toBeGreaterThanOrEqual(55);
		}
	});
});

const dirnameOf = (p: string): string => p.slice(0, p.lastIndexOf("/"));

describe("migration channel (deploy/sync-genre-cache.sh)", () => {
	const channel = readFileSync(resolve("deploy/sync-genre-cache.sh"), "utf8");

	it("is a name the channel accepts, for a script that exists", () => {
		const pattern = /MIGRATION_NAME_PATTERN='([^']+)'/.exec(channel)?.[1];
		expect(pattern).toBeDefined();
		expect(MIGRATION_NAME).toMatch(new RegExp(pattern ?? "$^"));
		expect(statSync(resolve("scripts/migrations", `${MIGRATION_NAME}.ts`)).isFile()).toBe(true);
	});

	it("writes a manifest the channel's validator reads: its name, removed[], renamed{}, redirects{}", async () => {
		const root = writeCache(fixtureNodes());
		const result = await run(root, fakeMusicBrainz());
		const manifest = JSON.parse(readFileSync(join(root, "out", "manifest.json"), "utf8")) as Obj;
		expect(manifest.migration).toBe(MIGRATION_NAME);
		expect(manifest.removed).toEqual([]);
		expect(manifest.renamed).toEqual({});
		expect(manifest.redirects).toEqual({});
		expect(JSON.stringify(manifest)).toBe(JSON.stringify(result.manifest));
	});

	it("parses the flags the channel passes, and nothing else", () => {
		expect(parseCliArgs(["/union", "--apply", "--manifest", "/m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/union",
			apply: true,
			manifestPath: "/m.json",
			dataDir: "/d",
		});
		expect(parseCliArgs(["/union"])).toEqual({
			cacheDir: "/union",
			apply: false,
			manifestPath: DEFAULT_MANIFEST_PATH,
			dataDir: undefined,
		});
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["/union", "--resume"])).toBeNull();
		expect(parseCliArgs(["/union", "--apply", "--apply"])).toBeNull();
		expect(parseCliArgs(["/union", "--manifest"])).toBeNull();
	});
});
