import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	creditConfirmsHint,
	findCollisions,
	mergeArtists,
	observingMbOutage,
	parseCliArgs,
	type ReleaseManifest,
	runBackfill,
	yearsAgree,
} from "../scripts/migrations/2026-10-15-backfill-release-identity.js";
import { resolveRecording, resolveReleaseGroup } from "../src/musicbrainz.js";
import { nodePayloadSchema } from "../src/schemas.js";

// The two resolvers stay real (they run against the fake below); they are spied on only so tests can
// count the searches the migration makes. mbFetch memoizes by URL for the whole file, so counting
// fetch calls would hide a repeated search.
vi.mock("../src/musicbrainz.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/musicbrainz.js")>();
	return {
		...actual,
		resolveReleaseGroup: vi.fn(actual.resolveReleaseGroup),
		resolveRecording: vi.fn(actual.resolveRecording),
	};
});

/** How many works the migration searched on MusicBrainz. */
const searchCalls = () =>
	vi.mocked(resolveReleaseGroup).mock.calls.length + vi.mocked(resolveRecording).mock.calls.length;

// --- A fake MusicBrainz, behind fetch (the external boundary) ---
// mbFetch memoizes by URL for the whole file: every test uses titles and MBIDs of its own.

let nextId = 0;
/** A fresh, valid MBID. */
const mbid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

interface FakeCredit {
	id: string;
	name: string;
	/** What the credit says when it differs from the canonical name. */
	creditedAs?: string;
}

interface FakeWork {
	kind: "release-group" | "recording";
	id: string;
	title: string;
	credit: FakeCredit[];
	date?: string;
	primaryType?: string;
	label?: { id: string; name: string };
	/** Release groups: the tracklist of their earliest release. */
	tracks?: { id: string; title: string }[];
	/** Recordings: the release group they first appeared on. */
	project?: { id: string; title: string };
}

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

const refused = () =>
	({ ok: false, status: 400, headers: new Headers(), json: async () => ({}) }) as Response;

interface Stub {
	urls: URL[];
	/** Search queries only. */
	searches: () => string[];
}

/**
 * Answers MB's release-group / recording search (by title only: like MB, it returns look-alikes the
 * migration must sift), and the lookups behind fetchProjectMetaMb / fetchTrackMetaMb. `fail` makes
 * the matching requests fail without a usable answer. `filterByArtist` makes the `artist:` clause
 * work as MB's does: it only matches the credited names, never an artist's other-script name.
 */
function stubMb(
	works: FakeWork[],
	options: { fail?: (url: URL) => boolean; filterByArtist?: boolean } = {},
): Stub {
	const urls: URL[] = [];
	const creditOf = (w: FakeWork) =>
		w.credit.map((c) => ({ name: c.creditedAs ?? c.name, artist: { id: c.id, name: c.name } }));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			urls.push(input);
			if (options.fail?.(input)) return refused();
			const [, , , kind, id] = input.pathname.split("/");
			if (!id && (kind === "release-group" || kind === "recording")) {
				const [, phrase = "", artist] =
					/^\w+:"(.*?)"(?: AND artist:"(.*)")?$/.exec(input.searchParams.get("query") ?? "") ?? [];
				const credited = (w: FakeWork) =>
					artist === undefined ||
					!options.filterByArtist ||
					w.credit.some((c) => (c.creditedAs ?? c.name).toLowerCase().includes(artist.toLowerCase()));
				const hits = works
					.filter(
						(w) => w.kind === kind && w.title.toLowerCase().includes(phrase.toLowerCase()) && credited(w),
					)
					.map((w) => ({
						id: w.id,
						title: w.title,
						"artist-credit": creditOf(w),
						...(w.date ? { "first-release-date": w.date } : {}),
						...(w.primaryType ? { "primary-type": w.primaryType } : {}),
					}));
				return jsonResponse(kind === "recording" ? { recordings: hits } : { "release-groups": hits });
			}
			const work = works.find((w) => w.id === id);
			if (!work) return refused();
			if (kind === "release-group") {
				return jsonResponse({
					"first-release-date": work.date,
					"primary-type": work.primaryType,
					releases: [{ id: work.id, date: work.date }],
				});
			}
			if (kind === "recording") {
				return jsonResponse({
					"artist-credit": creditOf(work),
					releases: work.project
						? [
								{
									id: work.id,
									date: work.date,
									"release-group": { ...work.project, "primary-type": "Album" },
								},
							]
						: [],
				});
			}
			// /release/<id>: the earliest release of a release group, or of a recording's release group.
			return jsonResponse({
				date: work.date,
				"label-info": work.label ? [{ label: work.label }] : [],
				"artist-credit": creditOf(work),
				media: [
					{ tracks: (work.tracks ?? []).map((t) => ({ id: t.id, recording: { id: t.id, title: t.title } })) },
				],
			});
		}),
	);
	return {
		urls,
		searches: () =>
			urls
				.filter((u) => /\/(release-group|recording)$/.test(u.pathname))
				.map((u) => u.searchParams.get("query") ?? ""),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// --- Cache fixtures ---

const article = "A real long article about the test node. ".repeat(4);

function artistNode(slug: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "artist",
		slug,
		name: slug.replace(/^artist:/, ""),
		editorial_bio: "A test artist bio.",
		editorial_article: article,
		citations: [{ url: "https://example.com/artist", title: "Artist" }],
		materialized_at: "2026-10-01T00:00:00.000Z",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...overrides,
	};
}

function projectNode(slug: string, name: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "project",
		slug,
		name,
		editorial_pitch: "A pitch.",
		editorial_article: article,
		citations: [{ url: "https://example.com/project", title: "Project" }],
		materialized_at: "2026-05-13T13:51:00.910Z",
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		related_projects: [],
		...overrides,
	};
}

function trackNode(slug: string, name: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "track",
		slug,
		name,
		editorial_teaser: "A teaser.",
		editorial_article: article,
		citations: [{ url: "https://example.com/track", title: "Track" }],
		materialized_at: "2026-05-14T09:33:56.770Z",
		artists: [],
		genres: [],
		producers: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
		...overrides,
	};
}

const edge = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
	slug,
	type: slug.slice(0, slug.indexOf(":")),
	name,
	...extra,
});

let root: string;
let manifestPath: string;

beforeEach(async () => {
	vi.mocked(resolveReleaseGroup).mockClear();
	vi.mocked(resolveRecording).mockClear();
	root = await mkdtemp(join(tmpdir(), "release-identity-"));
	manifestPath = join(root, "out", "release-identity.json");
	await mkdir(join(root, "cache", "nodes"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const cacheDir = () => join(root, "cache");
const nodePath = (slug: string) => {
	const i = slug.indexOf(":");
	return join(cacheDir(), "nodes", slug.slice(0, i), `${slug.slice(i + 1)}.json`);
};

async function seed(...nodes: { slug: string; [key: string]: unknown }[]): Promise<void> {
	for (const node of nodes) {
		await mkdir(join(nodePath(node.slug), ".."), { recursive: true });
		await writeFile(nodePath(node.slug), `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
}

async function readNode(slug: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(nodePath(slug), "utf8")) as Record<string, unknown>;
}

async function readManifestFile(): Promise<ReleaseManifest> {
	return JSON.parse(await readFile(manifestPath, "utf8")) as ReleaseManifest;
}

/** Keys whose value differs between two versions of a node. */
function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
		.sort();
}

const run = (options: Partial<Parameters<typeof runBackfill>[0]> = {}) =>
	runBackfill({ cacheDir: cacheDir(), apply: false, manifestPath, ...options });

// --- The four fixtures of the ticket, and the original-script credit ---

describe("project:new-forms", () => {
	const rg = mbid();
	const reprazent = mbid();
	const talkin = mbid();
	const works: FakeWork[] = [
		{
			kind: "release-group",
			id: mbid(),
			title: "New Forms²",
			credit: [{ id: mbid(), name: "Roni Size & Reprazent" }],
			date: "2000",
			primaryType: "Album",
		},
		{
			kind: "release-group",
			id: mbid(),
			title: "New Forms",
			credit: [{ id: mbid(), name: "Somebody Else" }],
			date: "2011",
			primaryType: "Album",
		},
		{
			kind: "release-group",
			id: rg,
			title: "New Forms",
			credit: [{ id: reprazent, name: "Roni Size / Reprazent" }],
			date: "1997-06-23",
			primaryType: "Album",
			label: { id: talkin, name: "Talkin' Loud" },
			tracks: [
				{ id: mbid(), title: "Brown Paper Bag" },
				{ id: mbid(), title: "Heroes" },
				{ id: mbid(), title: "Heroes" },
			],
		},
	];

	async function seedNewForms() {
		await seed(
			artistNode("artist:roni-size", {
				name: "Roni Size",
				discography: [edge("project:new-forms", "New Forms")],
			}),
			projectNode("project:new-forms", "New Forms"),
		);
	}

	it("takes its hint from the one artist pointing at it, and writes credit, tracklist, label, year", async () => {
		const mb = stubMb(works);
		await seedNewForms();
		const before = await readNode("project:new-forms");

		const result = await run({ apply: true });

		expect(result.exitCode).toBe(0);
		expect(mb.searches()).toEqual(['releasegroup:"New Forms" AND artist:"Roni Size"']);
		const after = await readNode("project:new-forms");
		expect(after).toMatchObject({
			mbid: rg,
			year: "1997",
			release_type: "album",
			artists: [
				{
					slug: "artist:roni-size-reprazent",
					type: "artist",
					name: "Roni Size / Reprazent",
					mbid: reprazent,
				},
			],
			label: { slug: "label:talkin-loud", type: "label", name: "Talkin' Loud", mbid: talkin },
		});
		const tracklist = after.tracklist as Record<string, unknown>[];
		expect(tracklist.map((t) => t.slug)).toEqual([
			"track:brown-paper-bag--roni-size-reprazent",
			"track:heroes--roni-size-reprazent",
		]);
		expect(tracklist[0]).toMatchObject({
			type: "track",
			name: "Brown Paper Bag",
			artist: "Roni Size / Reprazent",
		});
		// Nothing else moved: the editorial text, citations and slug are the original's.
		// `personnel` is the schema's own empty default, which the node lacked.
		expect(changedKeys(before, after)).toEqual([
			"artists",
			"label",
			"mbid",
			"personnel",
			"release_type",
			"tracklist",
			"year",
		]);
		expect(nodePayloadSchema.safeParse(after).success).toBe(true);
		expect(result.manifest.resolved["project:new-forms"]).toMatchObject({
			mbid: rg,
			hint: "Roni Size",
			credit: [{ mbid: reprazent, name: "Roni Size / Reprazent" }],
		});
	});

	it("reads the artist's identity from the artist manifest when the cache has none yet", async () => {
		stubMb(works);
		await seedNewForms();
		await seed(artistNode("artist:roni-size-reprazent", { name: "Roni Size & Reprazent" }));
		await mkdir(join(root, "out"), { recursive: true });
		const artistManifestPath = join(root, "out", "artist-identity.json");
		await writeFile(
			artistManifestPath,
			JSON.stringify({ resolved: { "artist:roni-size-reprazent": { mbid: reprazent } }, unresolved: [] }),
		);

		await run({ apply: true, artistManifestPath });

		// The credit lands on the cache's own artist, whose name is the cache's.
		expect((await readNode("project:new-forms")).artists).toEqual([
			{ slug: "artist:roni-size-reprazent", type: "artist", name: "Roni Size & Reprazent", mbid: reprazent },
		]);
	});
});

describe("labels", () => {
	it("never makes a label of MusicBrainz's '[no label]' placeholder, and says so", async () => {
		const rg = mbid();
		stubMb([
			{
				kind: "release-group",
				id: rg,
				title: "Unsigned",
				credit: [{ id: mbid(), name: "Free Agent" }],
				date: "2004",
				primaryType: "Single",
				label: { id: mbid(), name: "[no label]" },
			},
		]);
		await seed(
			projectNode("project:unsigned", "Unsigned", { artists: [edge("artist:free-agent", "Free Agent")] }),
		);

		const result = await run({ apply: true });

		const after = await readNode("project:unsigned");
		expect(after.mbid).toBe(rg);
		expect(after.label).toBeUndefined();
		expect(result.manifest.resolved["project:unsigned"]?.notes).toEqual([
			"label: [no label] is a MusicBrainz placeholder",
		]);
	});

	it("reuses the cache label that carries the MBID, with its own slug and name", async () => {
		const label = mbid();
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Signed",
				credit: [{ id: mbid(), name: "Free Agent" }],
				label: { id: label, name: "Big Records Ltd" },
			},
		]);
		await seed(
			projectNode("project:signed", "Signed", { artists: [edge("artist:free-agent", "Free Agent")] }),
			{ type: "label", slug: "label:big-records", name: "Big Records", mbid: label },
		);

		await run({ apply: true });

		expect((await readNode("project:signed")).label).toEqual({
			slug: "label:big-records",
			type: "label",
			name: "Big Records",
			mbid: label,
		});
	});
});

describe("track:fitna", () => {
	const akuma = mbid();
	const axmo = mbid();
	const rec = mbid();
	const works: FakeWork[] = [
		{
			kind: "recording",
			id: mbid(),
			title: "Fitna (Live)",
			credit: [{ id: akuma, name: "Akuma" }],
			date: "2024",
		},
		{
			kind: "recording",
			id: rec,
			title: "Fitna",
			credit: [
				{ id: akuma, name: "Akuma" },
				{ id: axmo, name: "AXMO" },
			],
			date: "2023-03-17",
			project: { id: mbid(), title: "Fitna" },
			label: { id: mbid(), name: "Sample Records" },
		},
	];

	it("keeps both credits, adds their MBIDs and the label, leaves the project edge alone", async () => {
		const mb = stubMb(works);
		await seed(
			trackNode("track:fitna", "Fitna", {
				year: "2023",
				artists: [edge("artist:akuma", "Akuma"), edge("artist:axmo", "AXMO")],
				project: edge("project:fitna", "Fitna"),
			}),
		);
		const before = await readNode("track:fitna");

		const result = await run({ apply: true });

		expect(result.exitCode).toBe(0);
		expect(mb.searches()).toEqual(['recording:"Fitna" AND artist:"Akuma"']);
		const after = await readNode("track:fitna");
		expect(after.mbid).toBe(rec);
		expect(after.artists).toEqual([
			edge("artist:akuma", "Akuma", { mbid: akuma }),
			edge("artist:axmo", "AXMO", { mbid: axmo }),
		]);
		expect(after.project).toEqual(before.project);
		expect(after.label).toMatchObject({ slug: "label:sample-records", name: "Sample Records" });
		expect(changedKeys(before, after)).toEqual(["artists", "label", "mbid", "personnel"]);
	});

	it("does not ask for the second lookup when the node needs nothing from it", async () => {
		const mb = stubMb(works);
		await seed(
			trackNode("track:fitna", "Fitna", {
				artists: [edge("artist:akuma", "Akuma"), edge("artist:axmo", "AXMO")],
				project: edge("project:fitna", "Fitna"),
				label: edge("label:own-label", "Own Label"),
			}),
		);

		await run({ apply: true });

		expect(mb.urls.filter((u) => u.pathname.includes(`/recording/`))).toEqual([]);
		expect((await readNode("track:fitna")).label).toEqual(edge("label:own-label", "Own Label"));
	});
});

describe("track:together", () => {
	const oak = mbid();
	const rec = mbid();
	const works: FakeWork[] = [
		{
			kind: "recording",
			id: rec,
			title: "Together",
			credit: [{ id: oak, name: "The Oak Ridge Boys" }],
			date: "1981",
		},
	];
	const pointed = () => [
		artistNode("artist:mitis", { name: "MitiS", notable_tracks: [edge("track:together", "Together")] }),
		artistNode("artist:dj-premier", {
			name: "DJ Premier",
			notable_tracks: [edge("track:together", "Together")],
		}),
	];

	it("looks up under the existing credit, which prevails over the artists pointing at it", async () => {
		const mb = stubMb(works);
		await seed(
			...pointed(),
			trackNode("track:together", "Together", {
				artists: [edge("artist:the-oak-ridge-boys", "The Oak Ridge Boys")],
			}),
		);

		const result = await run({ apply: true });

		expect(mb.searches()).toEqual(['recording:"Together" AND artist:"The Oak Ridge Boys"']);
		expect(result.manifest.resolved["track:together"]).toMatchObject({
			mbid: rec,
			hint: "The Oak Ridge Boys",
		});
		expect((await readNode("track:together")).artists).toEqual([
			edge("artist:the-oak-ridge-boys", "The Oak Ridge Boys", { mbid: oak }),
		]);
	});

	it("is ambiguous, node intact and MusicBrainz not asked, with no credit and two artists pointing", async () => {
		const mb = stubMb(works);
		await seed(...pointed(), trackNode("track:together", "Together"));
		const before = await readFile(nodePath("track:together"), "utf8");

		const result = await run({ apply: true });

		expect(result.manifest.ambiguous).toEqual([
			{
				slug: "track:together",
				candidates: ["artist:dj-premier", "artist:mitis"],
				reason: "several-artists-point-here",
			},
		]);
		expect(result.manifest.resolved["track:together"]).toBeUndefined();
		expect(mb.urls).toEqual([]);
		expect(await readFile(nodePath("track:together"), "utf8")).toBe(before);
		expect(result.exitCode).toBe(0);
	});

	it("takes the parent project's first credit as a pointing artist for a track", async () => {
		const mb = stubMb([{ ...(works[0] as FakeWork), title: "Together Forever" }]);
		await seed(
			projectNode("project:on-tour", "On Tour", {
				mbid: mbid(),
				artists: [edge("artist:the-oak-ridge-boys", "The Oak Ridge Boys")],
				tracklist: [edge("track:together-forever", "Together Forever")],
			}),
			trackNode("track:together-forever", "Together Forever"),
		);

		await run({ apply: true });

		expect(mb.searches()).toEqual(['recording:"Together Forever" AND artist:"The Oak Ridge Boys"']);
	});
});

describe("works MusicBrainz cannot single out", () => {
	it("leaves a work without an exact-title match unresolved and its file intact", async () => {
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Nowhere Near",
				credit: [{ id: mbid(), name: "Some Band" }],
			},
			{
				kind: "release-group",
				id: mbid(),
				title: "Nowhere Near Enough",
				credit: [{ id: mbid(), name: "Some Band" }],
			},
		]);
		await seed(
			projectNode("project:nowhere", "Nowhere", { artists: [edge("artist:some-band", "Some Band")] }),
		);
		const before = await readFile(nodePath("project:nowhere"), "utf8");

		const result = await run({ apply: true });

		expect(result.manifest.unresolved).toEqual([
			{ slug: "project:nowhere", name: "Nowhere", hint: "Some Band", reason: "no-match" },
		]);
		expect(result.written).toEqual([]);
		expect(await readFile(nodePath("project:nowhere"), "utf8")).toBe(before);
		expect(result.exitCode).toBe(0);
	});

	it("tells a remix from the original by its full title (Booty La La)", async () => {
		const original = mbid();
		const bugz = mbid();
		stubMb([
			{
				kind: "recording",
				id: mbid(),
				title: "Booty La La (Loefah remix)",
				credit: [{ id: bugz, name: "Bugz in the Attic" }],
			},
			{
				kind: "recording",
				id: original,
				title: "Booty La La",
				credit: [{ id: bugz, name: "Bugz in the Attic" }],
			},
		]);
		await seed(
			trackNode("track:booty-la-la", "Booty La La", {
				artists: [edge("artist:bugz-in-the-attic", "Bugz in the Attic")],
			}),
		);

		await run({ apply: true });

		expect((await readNode("track:booty-la-la")).mbid).toBe(original);
	});

	it("refuses a sole exact-title candidate credited to another artist", async () => {
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Mirage",
				credit: [{ id: mbid(), name: "Stranger Danger" }],
			},
		]);
		await seed(
			projectNode("project:mirage", "Mirage", { artists: [edge("artist:someone-real", "Someone Real")] }),
		);

		const result = await run({ apply: true });

		expect(result.manifest.unresolved).toEqual([
			{ slug: "project:mirage", name: "Mirage", hint: "Someone Real", reason: "credit-mismatch" },
		]);
		expect((await readNode("project:mirage")).mbid).toBeUndefined();
	});

	it("refuses a work whose stated year contradicts MusicBrainz's first release (a stray discography entry)", async () => {
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Fading Light",
				credit: [{ id: mbid(), name: "Pole" }],
				date: "2020-11-06",
				primaryType: "Album",
			},
		]);
		await seed(
			artistNode("artist:pole", {
				name: "Pole",
				discography: [edge("project:fading-light", "Fading Light")],
			}),
			projectNode("project:fading-light", "Fading Light", { year: "2012" }),
		);
		const before = await readFile(nodePath("project:fading-light"), "utf8");

		const result = await run({ apply: true });

		expect(result.manifest.unresolved).toEqual([
			{ slug: "project:fading-light", name: "Fading Light", hint: "Pole", reason: "year-mismatch" },
		]);
		expect(await readFile(nodePath("project:fading-light"), "utf8")).toBe(before);
	});

	it("does not search a title for a work nobody credits or points to", async () => {
		const mb = stubMb([]);
		await seed(projectNode("project:orphan-title", "Orphan Title"));

		const result = await run({ apply: true });

		expect(result.manifest.unresolved).toEqual([
			{ slug: "project:orphan-title", name: "Orphan Title", hint: "", reason: "no-hint" },
		]);
		expect(mb.urls).toEqual([]);
	});
});

describe("credit mapped onto the cache's artists", () => {
	const sakamoto = mbid();
	const work = (title: string): FakeWork => ({
		kind: "release-group",
		id: mbid(),
		title,
		credit: [{ id: sakamoto, name: "坂本龍一" }],
		date: "1983",
		primaryType: "Album",
	});

	it("writes the Latin cache artist's own edge for a credit in the original script", async () => {
		const mb = stubMb([work("Merry Christmas Mr. Lawrence")], { filterByArtist: true });
		await seed(
			artistNode("artist:ryuichi-sakamoto", {
				name: "Ryuichi Sakamoto",
				mbid: sakamoto,
				discography: [edge("project:merry-christmas-mr-lawrence", "Merry Christmas Mr. Lawrence")],
			}),
			projectNode("project:merry-christmas-mr-lawrence", "Merry Christmas Mr. Lawrence"),
		);

		const result = await run({ apply: true });

		expect(result.exitCode).toBe(0);
		// MB's artist field does not see 坂本龍一 under "Ryuichi Sakamoto": the title alone is searched next.
		expect(mb.searches()).toEqual([
			'releasegroup:"Merry Christmas Mr. Lawrence" AND artist:"Ryuichi Sakamoto"',
			'releasegroup:"Merry Christmas Mr. Lawrence"',
		]);
		expect((await readNode("project:merry-christmas-mr-lawrence")).artists).toEqual([
			{ slug: "artist:ryuichi-sakamoto", type: "artist", name: "Ryuichi Sakamoto", mbid: sakamoto },
		]);
	});

	it("leaves a work unresolved when the original-script credit matches no cache artist", async () => {
		const mb = stubMb([work("Thousand Knives")], { filterByArtist: true });
		await seed(
			artistNode("artist:some-other-sakamoto", {
				name: "Some Other Sakamoto",
				discography: [edge("project:thousand-knives", "Thousand Knives")],
			}),
			projectNode("project:thousand-knives", "Thousand Knives"),
		);

		const result = await run({ apply: true });

		// Neither the name nor an MBID ties the credit to the artist it was looked up under, and without
		// that artist's MBID the title is not searched alone.
		expect(mb.searches()).toHaveLength(1);
		expect(result.manifest.unresolved.map((u) => u.reason)).toEqual(["no-match"]);
		expect((await readNode("project:thousand-knives")).mbid).toBeUndefined();
	});

	it("accepts a title-alone match only when its credit carries the MBID of the artist looked up", async () => {
		const known = mbid();
		stubMb(
			[
				{
					kind: "release-group",
					id: mbid(),
					title: "Quiet Room",
					credit: [{ id: mbid(), name: "坂本龍一" }],
				},
			],
			{
				filterByArtist: true,
			},
		);
		await seed(
			artistNode("artist:ryuichi-sakamoto", {
				name: "Ryuichi Sakamoto",
				mbid: known,
				discography: [edge("project:quiet-room", "Quiet Room")],
			}),
			projectNode("project:quiet-room", "Quiet Room"),
		);

		const result = await run({ apply: true });

		// The only "Quiet Room" is credited to another 坂本龍一 entry: same script, not the same artist.
		expect(result.manifest.unresolved.map((u) => u.reason)).toEqual(["credit-mismatch"]);
		expect((await readNode("project:quiet-room")).mbid).toBeUndefined();
	});

	it("does not choose between two cache artists carrying the credit's MBID", async () => {
		const duo = mbid();
		stubMb([
			{ kind: "release-group", id: mbid(), title: "Twin Peaks", credit: [{ id: duo, name: "The Duo" }] },
		]);
		await seed(
			artistNode("artist:the-duo", { mbid: duo, discography: [edge("project:twin-peaks", "Twin Peaks")] }),
			artistNode("artist:duo", { mbid: duo }),
			projectNode("project:twin-peaks", "Twin Peaks"),
		);

		const result = await run({ apply: true });

		expect(result.manifest.ambiguous).toEqual([
			{
				slug: "project:twin-peaks",
				candidates: ["artist:duo", "artist:the-duo"],
				reason: "several-artist-nodes-share-the-credit-mbid",
			},
		]);
		expect((await readNode("project:twin-peaks")).mbid).toBeUndefined();
	});

	it("refuses a derived artist slug already held by an artist with another MBID", async () => {
		stubMb([
			{
				kind: "release-group",
				id: mbid(),
				title: "Hollow",
				credit: [
					{ id: mbid(), name: "Hollow Band" },
					{ id: mbid(), name: "Earth" },
				],
			},
		]);
		await seed(
			artistNode("artist:hollow-band", {
				name: "Hollow Band",
				discography: [edge("project:hollow", "Hollow")],
			}),
			artistNode("artist:earth", { name: "Earth", mbid: mbid() }),
			projectNode("project:hollow", "Hollow"),
		);

		const result = await run({ apply: true });

		expect(result.manifest.unresolved.map((u) => u.reason)).toEqual(["unmappable-credit"]);
		expect((await readNode("project:hollow")).artists).toEqual([]);
	});
});

// --- Safety of the run ---

describe("runBackfill", () => {
	const rg = mbid();
	const reprazent = mbid();
	const fixture = (title: string): FakeWork => ({
		kind: "release-group",
		id: rg,
		title,
		credit: [{ id: reprazent, name: "Idem Band" }],
		date: "2001",
		primaryType: "EP",
		label: { id: mbid(), name: "Idem Records" },
		tracks: [{ id: mbid(), title: "Idem Song" }],
	});
	const seedIdem = () =>
		seed(projectNode("project:idem-ep", "Idem EP", { artists: [edge("artist:idem-band", "Idem Band")] }));

	it("dry-run writes the manifest and no node; --apply twice writes once, and the manifest keeps the entry", async () => {
		stubMb([fixture("Idem EP")]);
		await seedIdem();
		const before = await readFile(nodePath("project:idem-ep"), "utf8");

		const dry = await run();
		expect(dry.written).toEqual([]);
		expect(await readFile(nodePath("project:idem-ep"), "utf8")).toBe(before);
		expect((await readManifestFile()).resolved["project:idem-ep"]?.mbid).toBe(rg);

		const first = await run({ apply: true });
		expect(first.written).toEqual([nodePath("project:idem-ep")]);
		const afterFirst = await readFile(nodePath("project:idem-ep"), "utf8");
		const mtime = (await stat(nodePath("project:idem-ep"))).mtimeMs;

		const second = await run({ apply: true });
		expect(second.written).toEqual([]);
		expect(await readFile(nodePath("project:idem-ep"), "utf8")).toBe(afterFirst);
		expect((await stat(nodePath("project:idem-ep"))).mtimeMs).toBe(mtime);
		// 1.12 reads the credit from the manifest: a second run, which has nothing left to do, must not erase it.
		expect((await readManifestFile()).resolved["project:idem-ep"]?.credit).toEqual([
			{ mbid: reprazent, name: "Idem Band" },
		]);
		expect(nodePayloadSchema.safeParse(await readNode("project:idem-ep")).success).toBe(true);
	});

	it("--resume reuses the manifest: a dry-run followed by --apply --resume searches nothing", async () => {
		stubMb([fixture("Resume EP")]);
		await seed(
			projectNode("project:resume-ep", "Resume EP", { artists: [edge("artist:idem-band", "Idem Band")] }),
		);

		await run();
		expect(searchCalls()).toBe(1);
		const applied = await run({ apply: true, resume: true });

		expect(searchCalls()).toBe(1);
		expect(applied.written).toEqual([nodePath("project:resume-ep")]);
		expect((await readNode("project:resume-ep")).mbid).toBe(rg);
	});

	it("--resume retries unresolved works, and refuses to run over a manifest it cannot read", async () => {
		stubMb([]);
		await seed(
			projectNode("project:nothing-known", "Nothing Known", {
				artists: [edge("artist:idem-band", "Idem Band")],
			}),
		);

		await run();
		await run({ resume: true });
		expect(searchCalls()).toBe(2);

		await writeFile(manifestPath, "not json");
		await expect(run({ resume: true })).rejects.toThrow();
		await expect(run()).resolves.toMatchObject({ exitCode: 0 });
	});

	it("reports a failed search as a failure (exit 1), not as an unknown work, and --resume completes it", async () => {
		let down = true;
		const works = [fixture("Flaky EP")];
		stubMb(works, { fail: () => down });
		await seed(
			projectNode("project:flaky-ep", "Flaky EP", { artists: [edge("artist:idem-band", "Idem Band")] }),
		);
		const before = await readFile(nodePath("project:flaky-ep"), "utf8");

		const result = await run({ apply: true });

		expect(result.failed).toEqual([{ slug: "project:flaky-ep", reason: "MusicBrainz search unavailable" }]);
		expect(result.manifest.unresolved).toEqual([]);
		expect(result.exitCode).toBe(1);
		expect(await readFile(nodePath("project:flaky-ep"), "utf8")).toBe(before);

		down = false;
		const retried = await run({ apply: true, resume: true });
		expect(retried.exitCode).toBe(0);
		expect((await readNode("project:flaky-ep")).mbid).toBe(rg);
	});

	it("writes nothing for a work whose tracklist lookup fails: no mbid without its tracklist", async () => {
		stubMb([{ ...fixture("Half EP"), id: mbid() }], { fail: (u) => u.pathname.includes("/release/") });
		await seed(
			projectNode("project:half-ep", "Half EP", { artists: [edge("artist:idem-band", "Idem Band")] }),
		);
		const before = await readFile(nodePath("project:half-ep"), "utf8");

		const result = await run({ apply: true });

		expect(result.failed.map((f) => f.slug)).toEqual(["project:half-ep"]);
		expect(result.exitCode).toBe(1);
		expect(await readFile(nodePath("project:half-ep"), "utf8")).toBe(before);
		// The identity found is not lost: --resume only repeats the failed lookup.
		expect((await readManifestFile()).resolved["project:half-ep"]?.mbid).toMatch(/^0{8}-/);
	});

	it("refuses to write a node the schema would alter beyond empty defaults", async () => {
		stubMb([fixture("Odd EP")]);
		await seed(
			projectNode("project:odd-ep", "Odd EP", {
				artists: [edge("artist:idem-band", "Idem Band")],
				field_nobody_declared: "kept by hand",
			}),
		);
		const before = await readFile(nodePath("project:odd-ep"), "utf8");

		const result = await run({ apply: true });

		expect(result.failed).toEqual([
			{ slug: "project:odd-ep", reason: "refusing to write: validation would alter fields the node carries" },
		]);
		expect(await readFile(nodePath("project:odd-ep"), "utf8")).toBe(before);
	});

	it("skips works that already carry an mbid and ignores the other node types", async () => {
		const mb = stubMb([]);
		await seed(
			projectNode("project:done", "Done", { mbid: mbid(), artists: [edge("artist:idem-band", "Idem Band")] }),
			artistNode("artist:idem-band", { name: "Idem Band" }),
		);

		const result = await run({ apply: true });

		expect(mb.urls).toEqual([]);
		expect(result.written).toEqual([]);
	});

	it("--limit caps the works searched, and --resume carries on with the next ones", async () => {
		stubMb([fixture("Cap One"), { ...fixture("Cap Two"), id: mbid() }]);
		await seed(
			projectNode("project:cap-one", "Cap One", { artists: [edge("artist:idem-band", "Idem Band")] }),
			projectNode("project:cap-two", "Cap Two", { artists: [edge("artist:idem-band", "Idem Band")] }),
		);

		const first = await run({ limit: 1 });
		expect(Object.keys(first.manifest.resolved)).toEqual(["project:cap-one"]);
		expect(searchCalls()).toBe(1);

		const second = await run({ resume: true });
		expect(Object.keys(second.manifest.resolved)).toEqual(["project:cap-one", "project:cap-two"]);
		expect(searchCalls()).toBe(2);
	});

	it("flags two works resolved on one MusicBrainz id as a collision, without choosing", async () => {
		stubMb([fixture("Same Thing"), fixture("Same Thing (Deluxe Edition)")]);
		await seed(
			projectNode("project:same-thing", "Same Thing", { artists: [edge("artist:idem-band", "Idem Band")] }),
			projectNode("project:same-thing-deluxe", "Same Thing (Deluxe Edition)", {
				artists: [edge("artist:idem-band", "Idem Band")],
			}),
		);

		const result = await run();

		expect(result.manifest.collisions).toEqual([
			{ mbid: rg, slugs: ["project:same-thing", "project:same-thing-deluxe"] },
		]);
	});

	it("prints the request budget before the first request", async () => {
		stubMb([]);
		await seed(projectNode("project:budget", "Budget", { artists: [edge("artist:idem-band", "Idem Band")] }));
		const lines: string[] = [];

		await run({ log: (l) => lines.push(l) });

		expect(lines.join("\n")).toMatch(/1 works without mbid, 0 reused from the manifest, 1 to search/);
	});
});

// --- Pure helpers ---

describe("creditConfirmsHint", () => {
	const credit = [{ mbid: "00000000-0000-4000-8000-0000000000aa", name: "Roni Size / Reprazent" }];

	it("accepts a credit that names the hint in whole words, or carries the hint's MBID", () => {
		expect(creditConfirmsHint(credit, { name: "Roni Size" })).toBe(true);
		expect(creditConfirmsHint(credit, { name: "坂本龍一", mbid: credit[0]?.mbid as string })).toBe(true);
	});

	it("refuses another artist, a partial word, and a hint with no Latin letter and no MBID", () => {
		expect(creditConfirmsHint(credit, { name: "Ron" })).toBe(false);
		expect(creditConfirmsHint(credit, { name: "Krust" })).toBe(false);
		expect(creditConfirmsHint(credit, { name: "坂本龍一" })).toBe(false);
		expect(creditConfirmsHint([], { name: "Roni Size" })).toBe(false);
	});

	it("refuses a homonym: same name as an artist whose MBID is known, under another MBID", () => {
		const earth = [{ mbid: "00000000-0000-4000-8000-0000000000bb", name: "Earth" }];
		const other = "00000000-0000-4000-8000-0000000000cc";
		expect(creditConfirmsHint(earth, { name: "Earth", mbid: other })).toBe(false);
		expect(creditConfirmsHint(earth, { name: "Earth" })).toBe(true);
		// A band that merely contains the artist's name is another entity, not a homonym.
		expect(creditConfirmsHint(credit, { name: "Roni Size", mbid: other })).toBe(true);
	});
});

describe("yearsAgree", () => {
	it("tolerates a year of difference, and a node with no usable year", () => {
		expect(yearsAgree("1997", "1997")).toBe(true);
		expect(yearsAgree("1998", "1997")).toBe(true);
		expect(yearsAgree("2012", "2020")).toBe(false);
		expect(yearsAgree(undefined, "2020")).toBe(true);
		expect(yearsAgree("circa 1990", "2020")).toBe(true);
		expect(yearsAgree("2012", null)).toBe(true);
	});
});

describe("mergeArtists", () => {
	const ctx = { artists: new Map() } as unknown as Parameters<typeof mergeArtists>[2];

	it("replaces an empty credit, stamps matching edges, and appends artists not yet credited", () => {
		const a = { slug: "artist:a", type: "artist", name: "A", mbid: mbid() };
		const b = { slug: "artist:b", type: "artist", name: "B", mbid: mbid() };
		expect(mergeArtists([], [a, b], ctx)).toEqual([a, b]);
		expect(mergeArtists([{ slug: "artist:a", type: "artist", name: "A" }], [a, b], ctx)).toEqual([a, b]);
		// An existing edge with another MBID is not the credited artist, whatever its name: it is neither
		// stamped nor duplicated under the same slug.
		const homonym = { slug: "artist:a", type: "artist", name: "A", mbid: mbid() };
		expect(mergeArtists([homonym], [a], ctx)).toEqual([homonym]);
		expect(mergeArtists([homonym], [b], ctx)).toEqual([homonym, b]);
	});
});

describe("findCollisions", () => {
	it("lists only MBIDs shared by two slugs or more, counting works already written", () => {
		const entry = (m: string) => ({
			mbid: m,
			credit: [],
			title: "",
			hint: "",
			year: null,
			release_type: null,
		});
		expect(
			findCollisions({ "track:b": entry("m1"), "track:c": entry("m2") }, new Map([["track:a", "m1"]])),
		).toEqual([{ mbid: "m1", slugs: ["track:a", "track:b"] }]);
	});
});

describe("observingMbOutage", () => {
	it("restores fetch, and calls a request retried to success an answer", async () => {
		const original = vi.fn(async () => jsonResponse({}));
		vi.stubGlobal("fetch", original);
		const url = new URL("https://musicbrainz.example/ws/2/x");
		const seen: boolean[] = [];

		const answered = await observingMbOutage(async () => {
			seen.push((await fetch(url)).ok);
			return 1;
		});
		const attempts = [refused(), jsonResponse({})];
		original.mockImplementation(async () => attempts.shift() as Response);
		const retried = await observingMbOutage(async () => {
			await fetch(url);
			await fetch(url);
			return 2;
		});
		const refusedOnce = await observingMbOutage(async () => {
			original.mockImplementation(async () => refused());
			await fetch(url);
			return 3;
		});

		expect([answered.unavailable, retried.unavailable, refusedOnce.unavailable]).toEqual([
			false,
			false,
			true,
		]);
		expect(globalThis.fetch).toBe(original);
	});
});

describe("parseCliArgs", () => {
	it("defaults to a dry-run writing out/release-identity.json, reading out/artist-identity.json if present", () => {
		expect(parseCliArgs(["cache"])).toEqual({
			cacheDir: "cache",
			apply: false,
			resume: false,
			manifestPath: "out/release-identity.json",
			artistManifestPath: "out/artist-identity.json",
			artistManifestRequired: false,
		});
	});

	it("reads every flag, and requires an artist manifest that was named", () => {
		expect(
			parseCliArgs([
				"cache",
				"--apply",
				"--resume",
				"--limit",
				"10",
				"--manifest",
				"m.json",
				"--artist-manifest",
				"a.json",
			]),
		).toEqual({
			cacheDir: "cache",
			apply: true,
			resume: true,
			limit: 10,
			manifestPath: "m.json",
			artistManifestPath: "a.json",
			artistManifestRequired: true,
		});
	});

	it("refuses anything ambiguous", () => {
		for (const argv of [
			[],
			["--apply"],
			["cache", "--limit", "0"],
			["cache", "--limit"],
			["cache", "--manifest", "--apply"],
			["cache", "--apply", "--apply"],
			["cache", "stray"],
			["cache", "--artist-manifest", "a", "--artist-manifest", "b"],
		]) {
			expect(parseCliArgs(argv)).toBeNull();
		}
	});
});
