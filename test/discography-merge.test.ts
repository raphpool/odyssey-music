import { describe, expect, it } from "vitest";
import {
	DEFAULT_DISCOGRAPHY_CAP,
	type DiscographyPolicy,
	type MergeInput,
	mergeDiscography,
	type ReleaseGroupCandidate,
	reconciliationKey,
	selectReleases,
	toDiscographyEdge,
} from "../src/discography-policy.js";
import { makeScopedSlug } from "../src/slug.js";
import type { EdgeRef, Slug } from "../src/types.js";

const ARTIST_MBID = "11111111-1111-4111-8111-111111111111";

const policy: DiscographyPolicy = {
	artistMbid: ARTIST_MBID,
	artistName: "Daft Punk",
	cap: DEFAULT_DISCOGRAPHY_CAP,
	currentYear: 2026,
};

let counter = 0;
function mbidOf(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function release(title: string, overrides: Partial<ReleaseGroupCandidate> = {}): ReleaseGroupCandidate {
	counter += 1;
	return {
		mbid: mbidOf(counter),
		title,
		firstReleaseDate: "2001-03-12",
		primaryType: "Album",
		secondaryTypes: [],
		artistCredits: [{ mbid: ARTIST_MBID, name: "Daft Punk" }],
		ratingVotes: 0,
		...overrides,
	};
}

function slugFor(title: string, artist = "Daft Punk"): Slug {
	const slug = makeScopedSlug("project", title, artist);
	if (!slug.ok) throw new Error(`no slug for ${title}`);
	return slug.slug;
}

function entry(name: string, extra: Partial<EdgeRef> = {}, artist = "Daft Punk"): EdgeRef {
	return { slug: slugFor(name, artist), type: "project", name, artist, ...extra };
}

function merge(overrides: Partial<MergeInput> = {}): ReturnType<typeof mergeDiscography> {
	return mergeDiscography({
		existing: [],
		candidates: [],
		allCredited: [],
		policy,
		projectIndex: { byMbid: new Map(), resolveSlug: (slug) => slug },
		...overrides,
	});
}

describe("mergeDiscography — pose", () => {
	it("poses the mbid on a unique title, including a release group only present in allCredited", () => {
		const plain = release("Discovery");
		const live = release("Live at the BBC", { secondaryTypes: ["Live"] });
		const existing = [entry("Discovery"), entry("Live at the BBC")];

		const result = merge({ existing, allCredited: [plain, live] });

		expect(result.changed).toBe(true);
		expect(result.edges.map((e) => [e.name, e.mbid])).toEqual(
			expect.arrayContaining([
				["Discovery", plain.mbid],
				["Live at the BBC", live.mbid],
			]),
		);
		expect(result.posed.map((p) => p.mbid).sort()).toEqual([plain.mbid, live.mbid].sort());
		expect(result.added).toEqual([]);
	});

	it("matches titles through normalizeTitleBody (edition noise, case)", () => {
		const album = release("Kid A");
		const result = merge({ existing: [entry("kid a (Deluxe Edition)")], allCredited: [album] });
		expect(result.posed).toHaveLength(1);
		expect(result.posed[0]?.mbid).toBe(album.mbid);
	});

	it("Giant Steps: poses the album, not the single, on an entry without releaseType and completes it", () => {
		const album = release("Giant Steps", { primaryType: "Album", firstReleaseDate: "1960-01-01" });
		const single = release("Giant Steps", { primaryType: "Single", firstReleaseDate: "1959-01-01" });
		const ep = release("Giant Steps", { primaryType: "EP", firstReleaseDate: "1959-06-01" });
		const existing = [entry("Giant Steps", { year: "1960" })];

		for (const allCredited of [
			[album, single],
			[single, album],
			[single, ep, album],
		]) {
			const result = merge({ existing, allCredited });
			expect(result.ambiguous).toEqual([]);
			expect(result.posed).toEqual([{ slug: existing[0]?.slug, mbid: album.mbid, filled: ["releaseType"] }]);
			expect(result.edges[0]).toMatchObject({ mbid: album.mbid, releaseType: "album", year: "1960" });
		}
	});

	it("Help!: poses the Album + Soundtrack over its EP, an exact-title pose stays open to every type", () => {
		const album = release("Help!", { primaryType: "Album", secondaryTypes: ["Soundtrack"] });
		const ep = release("Help!", { primaryType: "EP" });
		const live = release("Live at the BBC", { secondaryTypes: ["Live", "Soundtrack"] });
		const existing = [entry("Help!"), entry("Live at the BBC")];

		const result = merge({ existing, allCredited: [ep, album, live] });

		expect(result.ambiguous).toEqual([]);
		expect(result.edges.find((e) => e.name === "Help!")).toMatchObject({
			mbid: album.mbid,
			releaseType: "album",
		});
		expect(result.edges.find((e) => e.name === "Live at the BBC")?.mbid).toBe(live.mbid);
	});

	it("keeps an Album and a Single sharing a title ambiguous/type when the album is not the only one", () => {
		const albumA = release("Imagine", { primaryType: "Album", firstReleaseDate: "1971-01-01" });
		const albumB = release("Imagine", { primaryType: "Album", firstReleaseDate: "1972-01-01" });
		const single = release("Imagine", { primaryType: "Single", firstReleaseDate: "1971-01-01" });
		const existing = [entry("Imagine")];

		const result = merge({ existing, allCredited: [albumA, albumB, single] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "type" }]);
		expect(result.posed).toEqual([]);
		expect(result.changed).toBe(false);
		expect(result.edges).toBe(existing);
	});

	it("does not pose a lone Live or Compilation album against a single of the same title", () => {
		const single = release("Hurt", { primaryType: "Single" });
		const existing = [entry("Hurt")];
		for (const secondary of ["Live", "Compilation"]) {
			const album = release("Hurt", { primaryType: "Album", secondaryTypes: [secondary] });
			const result = merge({ existing, allCredited: [album, single] });
			expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "type" }]);
			expect(result.posed).toEqual([]);
		}
	});

	// TRA-628, measured 2026-10-19 on MusicBrainz: the Live / Compilation albums of the same title are not
	// competitors, so the studio album is posed.
	it.each([
		{
			title: "Blue Train",
			groups: [
				{ primaryType: "Album", firstReleaseDate: "1958-01-01", ratingVotes: 8 },
				{ primaryType: "Album", firstReleaseDate: "2004-01-01", secondaryTypes: ["Compilation", "Live"] },
				{ primaryType: "Single", firstReleaseDate: "1957-01-01" },
			],
		},
		{
			title: "My Favorite Things",
			groups: [
				{ primaryType: "Album", firstReleaseDate: "1961-01-01", ratingVotes: 5 },
				{ primaryType: "Album", firstReleaseDate: "2002-01-01", secondaryTypes: ["Compilation", "Live"] },
				{ primaryType: "Album", firstReleaseDate: "2011-01-01", secondaryTypes: ["Compilation", "Live"] },
				{ primaryType: "Album", firstReleaseDate: "2016-01-01", secondaryTypes: ["Compilation", "Live"] },
				{ primaryType: "Single", firstReleaseDate: "1961-01-01" },
			],
		},
		{
			title: "Imagine",
			groups: [
				{ primaryType: "Album", firstReleaseDate: "1971-01-01", ratingVotes: 17 },
				{ primaryType: "Album", firstReleaseDate: "1993-01-01", secondaryTypes: ["Live"] },
				{ primaryType: "Single", firstReleaseDate: "1971-01-01" },
				{ primaryType: "EP", firstReleaseDate: "2021-01-01", secondaryTypes: ["Compilation"] },
			],
		},
	])(
		"$title: poses the studio album despite Live / Compilation albums of the same title",
		({ title, groups }) => {
			const credited = groups.map((g) => release(title, g));
			const [studio] = credited;
			const existing = [entry(title)];

			const result = merge({ existing, allCredited: credited });

			expect(result.ambiguous).toEqual([]);
			expect(result.posed).toEqual([
				{ slug: existing[0]?.slug, mbid: studio?.mbid, filled: ["year", "releaseType"] },
			]);
			expect(result.edges[0]).toMatchObject({ mbid: studio?.mbid, releaseType: "album" });
		},
	);

	it("keeps two studio albums of one title ambiguous even with a Live album and a single around", () => {
		const albumA = release("Imagine", { firstReleaseDate: "1971-01-01" });
		const albumB = release("Imagine", { firstReleaseDate: "1972-01-01" });
		const live = release("Imagine", { firstReleaseDate: "1993-01-01", secondaryTypes: ["Live"] });
		const single = release("Imagine", { primaryType: "Single", firstReleaseDate: "1971-01-01" });
		const existing = [entry("Imagine")];

		const result = merge({ existing, allCredited: [albumA, live, albumB, single] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "type" }]);
		expect(result.posed).toEqual([]);
	});

	it("counts a Soundtrack or Mixtape/Street album as a competitor, but not a Soundtrack + Live one", () => {
		const plain = release("Help!", { firstReleaseDate: "1965-01-01" });
		const soundtrack = release("Help!", { firstReleaseDate: "1965-08-06", secondaryTypes: ["Soundtrack"] });
		const soundtrackLive = release("Help!", {
			firstReleaseDate: "1990-01-01",
			secondaryTypes: ["Soundtrack", "Live"],
		});
		const single = release("Help!", { primaryType: "Single", firstReleaseDate: "1965-01-01" });
		const existing = [entry("Help!")];

		const two = merge({ existing, allCredited: [plain, soundtrack, single] });
		expect(two.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "type" }]);
		expect(two.posed).toEqual([]);

		const one = merge({ existing, allCredited: [soundtrack, soundtrackLive, single] });
		expect(one.ambiguous).toEqual([]);
		expect(one.posed.map((p) => p.mbid)).toEqual([soundtrack.mbid]);
	});

	it("leaves an entry that states its releaseType unchanged by the Live / Compilation homonyms", () => {
		const album = release("Blue Train", { firstReleaseDate: "1958-01-01" });
		const live = release("Blue Train", { firstReleaseDate: "2004-01-01", secondaryTypes: ["Live"] });
		const existing = [entry("Blue Train", { releaseType: "album" })];

		// Two albums share the title and the entry states "album": still not guessed.
		const result = merge({ existing, allCredited: [album, live] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "multiple" }]);
		expect(result.posed).toEqual([]);
	});

	it("keeps two albums of the same title ambiguous/multiple", () => {
		const albumA = release("Mind Games", { primaryType: "Album" });
		const albumB = release("Mind Games", { primaryType: "Album" });
		const existing = [entry("Mind Games")];

		const result = merge({ existing, allCredited: [albumA, albumB] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "multiple" }]);
		expect(result.posed).toEqual([]);
	});

	it("does not guess the album when another primary type shares the title", () => {
		const album = release("Blue Train", { primaryType: "Album" });
		const other = release("Blue Train", { primaryType: "Broadcast" });
		const existing = [entry("Blue Train")];

		const result = merge({ existing, allCredited: [album, other] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "type" }]);
		expect(result.posed).toEqual([]);
	});

	it("keeps the type guard when the entry states a releaseType: a single entry never takes the album", () => {
		const album = release("Imagine", { primaryType: "Album" });
		const single = release("Imagine", { primaryType: "Single" });
		const existing = [entry("Imagine", { releaseType: "single" })];

		const result = merge({ existing, allCredited: [album, single] });

		expect(result.edges[0]?.mbid).toBe(single.mbid);
		expect(result.ambiguous).toEqual([]);
		// Album-only match for an entry that says "single": still refused.
		const refused = merge({ existing, allCredited: [album] });
		expect(refused.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "type" }]);
		expect(refused.posed).toEqual([]);
	});

	it("poses the Album mbid when the entry says releaseType album", () => {
		const album = release("Imagine", { primaryType: "Album" });
		const single = release("Imagine", { primaryType: "Single" });

		const result = merge({
			existing: [entry("Imagine", { releaseType: "album" })],
			allCredited: [single, album],
		});

		expect(result.edges[0]?.mbid).toBe(album.mbid);
		expect(result.ambiguous).toEqual([]);
	});

	it("refuses a single candidate whose primary type differs from the entry's releaseType", () => {
		const single = release("X", { primaryType: "Single" });
		const existing = [entry("X", { releaseType: "album" })];

		const result = merge({ existing, allCredited: [single] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "type" }]);
		expect(result.posed).toEqual([]);
		expect(result.changed).toBe(false);
		expect(result.edges).toBe(existing);
	});

	it("poses a single candidate on an entry without releaseType and completes the releaseType", () => {
		const single = release("X", { primaryType: "Single" });

		const result = merge({ existing: [entry("X")], allCredited: [single] });

		expect(result.ambiguous).toEqual([]);
		expect(result.posed[0]?.filled).toContain("releaseType");
		expect(result.edges[0]).toMatchObject({ mbid: single.mbid, releaseType: "single" });
	});

	it("still poses an mbid from an unvoted release group that the unrated cut keeps out of the candidates (TRA-628)", () => {
		const rated = Array.from({ length: 12 }, (_, i) =>
			release(`Voted ${i}`, { firstReleaseDate: `${1970 + i}-01-01`, ratingVotes: 10 }),
		);
		const tapes = release("The Lost Lennon Tapes, Vol. 1", { firstReleaseDate: "1988-01-01" });
		const existing = [entry("The Lost Lennon Tapes, Vol. 1")];

		const { kept, excluded } = selectReleases([...rated, tapes], policy);
		expect(excluded.map((e) => e.reason)).toEqual(["unrated"]);

		const result = merge({ existing, candidates: kept, allCredited: [...rated, tapes] });

		expect(result.posed.map((p) => p.mbid)).toEqual([tapes.mbid]);
		expect(result.added.map((a) => a.mbid)).not.toContain(tapes.mbid);
	});

	it("reports several candidates of the same type as ambiguous/multiple", () => {
		const first = release("Homework", { firstReleaseDate: "1997-01-20" });
		const second = release("Homework", { firstReleaseDate: "1997-03-17" });
		const existing = [entry("Homework")];

		const result = merge({ existing, allCredited: [first, second] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "multiple" }]);
		expect(result.edges).toBe(existing);
	});

	it("reports ambiguous/multiple when the releaseType filter leaves nothing", () => {
		const album = release("Imagine", { primaryType: "Album" });
		const single = release("Imagine", { primaryType: "Single" });
		const existing = [entry("Imagine", { releaseType: "ep" })];

		const result = merge({ existing, allCredited: [album, single] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "multiple" }]);
	});

	it("refuses a year more than one year away, and accepts one year away", () => {
		const candidate = release("Imagine", { firstReleaseDate: "1975-06-01" });

		const far = merge({ existing: [entry("Imagine", { year: "1968" })], allCredited: [candidate] });
		expect(far.ambiguous).toEqual([{ slug: slugFor("Imagine"), reason: "year-mismatch" }]);
		expect(far.posed).toEqual([]);
		expect(far.changed).toBe(false);

		const near = merge({ existing: [entry("Imagine", { year: "1976" })], allCredited: [candidate] });
		expect(near.ambiguous).toEqual([]);
		expect(near.edges[0]?.mbid).toBe(candidate.mbid);
	});

	it("fills year and releaseType only when absent, and lists them in filled", () => {
		const candidate = release("Discovery", { firstReleaseDate: "2001-03-12", primaryType: "Album" });

		const bare = merge({ existing: [entry("Discovery")], allCredited: [candidate] });
		expect(bare.posed[0]?.filled).toEqual(["year", "releaseType"]);
		expect(bare.edges[0]).toMatchObject({ year: "2001", releaseType: "album", mbid: candidate.mbid });

		const complete = merge({
			existing: [entry("Discovery", { year: "2002", releaseType: "album" })],
			allCredited: [candidate],
		});
		expect(complete.posed[0]?.filled).toEqual([]);
		expect(complete.edges[0]).toMatchObject({ year: "2002", releaseType: "album", mbid: candidate.mbid });
	});

	it("never changes name, slug or artist of a posed entry, and does not mutate the input", () => {
		const candidate = release("Discovery");
		const original = entry("DISCOVERY (Deluxe Edition)");
		const snapshot = structuredClone(original);
		const existing = Object.freeze([Object.freeze(original)]);

		const result = merge({ existing, allCredited: [candidate] });

		expect(original).toEqual(snapshot);
		expect(result.edges[0]).toMatchObject({
			name: snapshot.name,
			slug: snapshot.slug,
			artist: snapshot.artist,
		});
		expect(result.edges[0]).not.toBe(original);
	});

	it("leaves entries that already carry an mbid alone", () => {
		const candidate = release("Discovery");
		const existing = [entry("Discovery", { mbid: "99999999-9999-4999-8999-999999999999" })];
		const result = merge({ existing, allCredited: [candidate] });
		expect(result.changed).toBe(false);
		expect(result.edges).toBe(existing);
	});

	it("poses every duplicate of the same title and removes none", () => {
		const candidate = release("Birth of the Cool", { firstReleaseDate: "1957-02-01" });
		const first = entry("Birth of the Cool", { year: "1957" });
		const second = { ...entry("Birth of the Cool"), slug: "project:birth-of-the-cool--daft-punk-2" as Slug };

		const result = merge({ existing: [first, second], allCredited: [candidate] });

		expect(result.edges).toHaveLength(2);
		expect(result.edges.map((e) => e.mbid)).toEqual([candidate.mbid, candidate.mbid]);
		expect(result.posed).toHaveLength(2);
	});

	it("does not match an empty normalized title against anything", () => {
		const candidate = release("日本語");
		const existing: EdgeRef[] = [
			{ slug: "project:nihongo--daft-punk" as Slug, type: "project", name: "日本語", artist: "Daft Punk" },
		];
		const result = merge({ existing, allCredited: [candidate] });
		expect(result.changed).toBe(false);
		expect(result.edges).toBe(existing);
	});
});

describe("mergeDiscography — additions", () => {
	it("attaches an addition to the project node found by mbid", () => {
		const discovery = release("Discovery");
		const existingSlug = "project:discovery--daft-punk-fr" as Slug;

		const result = merge({
			candidates: [discovery],
			projectIndex: {
				byMbid: new Map([[discovery.mbid, existingSlug]]),
				resolveSlug: () => "project:wrong" as Slug,
			},
		});

		expect(result.added).toEqual([
			{ slug: existingSlug, mbid: discovery.mbid, title: "Discovery", year: "2001", releaseType: "album" },
		]);
		expect(result.edges).toEqual([
			{ ...toDiscographyEdge(discovery, policy), slug: existingSlug } as EdgeRef,
		]);
	});

	it("falls back to resolveSlug, then to the scoped slug", () => {
		const homework = release("Homework", { firstReleaseDate: "1997-01-20" });
		const redirected = merge({
			candidates: [homework],
			projectIndex: {
				byMbid: new Map(),
				resolveSlug: (slug) =>
					slug === slugFor("Homework") ? ("project:homework--daft-punk-v2" as Slug) : slug,
			},
		});
		expect(redirected.added[0]?.slug).toBe("project:homework--daft-punk-v2");

		const scoped = merge({ candidates: [homework] });
		expect(scoped.added[0]?.slug).toBe(slugFor("Homework"));
	});

	it("adds an edge with exactly the shape of toDiscographyEdge", () => {
		const candidate = release("Alive 2007", { firstReleaseDate: "2007-11-19", primaryType: "Album" });
		const result = merge({ candidates: [candidate] });
		expect(result.edges).toEqual([toDiscographyEdge(candidate, policy)]);
		expect(result.edges[0]?.artist).toBe("Daft Punk");
	});

	it("ignores a candidate for which no scoped slug can be built", () => {
		const unusable = release("日本語");
		const result = merge({ candidates: [unusable] });
		expect(result.added).toEqual([]);
		expect(result.changed).toBe(false);
	});

	it("does not add a candidate whose mbid or normalized title is already in the list", () => {
		const known = release("Discovery");
		const sameTitle = release("Homework");
		const existing = [
			entry("Discovery", { mbid: known.mbid }),
			entry("Homework", { mbid: "99999999-9999-4999-8999-999999999999" }),
		];
		const result = merge({ existing, candidates: [known, sameTitle] });
		expect(result.added).toEqual([]);
		expect(result.edges).toBe(existing);
	});

	it("does not add a candidate whose mbid was just posed on an entry", () => {
		const album = release("Discovery");
		const result = merge({ existing: [entry("Discovery")], candidates: [album], allCredited: [album] });
		expect(result.added).toEqual([]);
		expect(result.edges).toHaveLength(1);
	});

	it("never produces two entries with the same slug for an album and a single of the same title", () => {
		const album = release("Black Sun", { primaryType: "Album", firstReleaseDate: "2011-01-01" });
		const single = release("Black Sun", { primaryType: "Single", firstReleaseDate: "2010-01-01" });

		const result = merge({ candidates: [album, single] });

		expect(result.added).toHaveLength(1);
		expect(result.added[0]?.mbid).toBe(album.mbid);
		expect(new Set(result.edges.map((e) => e.slug)).size).toBe(result.edges.length);
	});

	it("produces one entry when two candidates resolve to the same project node", () => {
		const first = release("Discovery");
		const second = release("Discovery (Japan)", { firstReleaseDate: "2001-04-01" });
		const shared = "project:discovery--daft-punk-fr" as Slug;
		const result = merge({
			candidates: [first, second],
			projectIndex: {
				byMbid: new Map([
					[first.mbid, shared],
					[second.mbid, shared],
				]),
				resolveSlug: (slug) => slug,
			},
		});
		expect(result.added.map((a) => a.mbid)).toEqual([first.mbid]);
	});

	it("adds nothing to a list already at the cap and flags capReached", () => {
		const existing = Array.from({ length: 40 }, (_, i) => entry(`Existing ${i}`, { mbid: mbidOf(1000 + i) }));
		const result = merge({ existing, candidates: [release("Brand New")] });
		expect(result.added).toEqual([]);
		expect(result.capReached).toBe(true);
		expect(result.changed).toBe(false);
		expect(result.edges).toBe(existing);
	});

	it("fills a list of 38 up to the cap with 5 candidates, in candidate order", () => {
		const existing = Array.from({ length: 38 }, (_, i) => entry(`Existing ${i}`, { mbid: mbidOf(1000 + i) }));
		const candidates = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((t) => release(t));

		const result = merge({ existing, candidates });

		expect(result.added.map((a) => a.title)).toEqual(["Alpha", "Bravo"]);
		expect(result.edges).toHaveLength(40);
		expect(result.capReached).toBe(true);
	});

	it("spends the last slots on albums before singles, whatever order the candidates come in", () => {
		const existing = Array.from({ length: 38 }, (_, i) => entry(`Existing ${i}`, { mbid: mbidOf(1000 + i) }));
		const newestFirst = [
			release("Single A", { primaryType: "Single", firstReleaseDate: "2020-01-01" }),
			release("Single B", { primaryType: "Single", firstReleaseDate: "2019-01-01" }),
			release("Old Album", { primaryType: "Album", firstReleaseDate: "2005-01-01" }),
			release("Old Album 2", { primaryType: "Album", firstReleaseDate: "2003-01-01" }),
		];

		const result = merge({ existing, candidates: newestFirst });

		// Same votes: the older album takes the first free place.
		expect(result.added.map((a) => a.title)).toEqual(["Old Album 2", "Old Album"]);
		expect(result.capReached).toBe(true);
	});

	it("spends the last slots on a voted single before an unvoted album (TRA-625)", () => {
		const existing = Array.from({ length: 38 }, (_, i) => entry(`Existing ${i}`, { mbid: mbidOf(1000 + i) }));
		const candidates = [
			release("Bootleg", { firstReleaseDate: "1990-01-01" }),
			release("Archive", { firstReleaseDate: "1991-01-01" }),
			release("Hey Jude", { primaryType: "Single", firstReleaseDate: "1968-08-26", ratingVotes: 30 }),
			release("Paperback Writer", { primaryType: "Single", firstReleaseDate: "1966-06-10", ratingVotes: 12 }),
		];

		const result = merge({ existing, candidates });

		expect(result.added.map((a) => a.title)).toEqual(["Hey Jude", "Paperback Writer"]);
		expect(result.capReached).toBe(true);
	});

	it("gives the last slots to the most voted albums, not to the newest ones (TRA-625)", () => {
		const existing = Array.from({ length: 38 }, (_, i) => entry(`Existing ${i}`, { mbid: mbidOf(1000 + i) }));
		// `kept` arrives newest first: the two bootlegs would fill the places in that order.
		const candidates = [
			release("Bootleg 2023", { firstReleaseDate: "2023-01-01" }),
			release("Bootleg 2015", { firstReleaseDate: "2015-01-01" }),
			release("Abbey Road", { firstReleaseDate: "1969-09-26", ratingVotes: 71 }),
			release("Let It Be", { firstReleaseDate: "1970-05-08", ratingVotes: 43 }),
		];

		const result = merge({ existing, candidates });

		expect(result.added.map((a) => a.title)).toEqual(["Abbey Road", "Let It Be"]);
		expect(result.capReached).toBe(true);
	});

	it("does not count the same release group twice when its mbid differs only by case", () => {
		const lower = release("Discovery");
		const upper = { ...lower, mbid: lower.mbid.toUpperCase() };
		const result = merge({ existing: [entry("Discovery")], allCredited: [lower, upper] });
		expect(result.ambiguous).toEqual([]);
		expect(result.posed).toHaveLength(1);
	});

	it("does not flag capReached when every candidate fits", () => {
		const result = merge({ candidates: [release("Alpha"), release("Bravo")] });
		expect(result.added).toHaveLength(2);
		expect(result.capReached).toBe(false);
	});

	it("does not flag capReached for candidates that were skipped for another reason", () => {
		const existing = Array.from({ length: 40 }, (_, i) => entry(`Existing ${i}`, { mbid: mbidOf(1000 + i) }));
		const result = merge({ existing, candidates: [release("Existing 3")] });
		expect(result.capReached).toBe(false);
	});
});

describe("mergeDiscography — near duplicates", () => {
	const kode9 = { ...policy, artistName: "Kode9" };

	it("adds 'Sine of the Dub / Stalker' next to an unmatched 'Sine of the Dub' and flags it", () => {
		const existingEntry = entry("Sine of the Dub", {}, "Kode9");
		const candidate = release("Sine of the Dub / Stalker", {
			primaryType: "Single",
			firstReleaseDate: "2010-05-03",
		});

		const result = merge({ existing: [existingEntry], candidates: [candidate], policy: kode9 });

		expect(existingEntry.slug).toBe("project:sine-of-the-dub--kode9");
		expect(result.added).toHaveLength(1);
		expect(result.added[0]).toMatchObject({
			mbid: candidate.mbid,
			title: "Sine of the Dub / Stalker",
			nearDuplicateOf: "project:sine-of-the-dub--kode9",
		});
		expect(result.edges).toHaveLength(2);
	});

	it("flags the reverse case: the existing title extends the candidate's", () => {
		const existingEntry = entry("Sine of the Dub / Stalker", {}, "Kode9");
		const candidate = release("Sine of the Dub", { primaryType: "Single" });
		const result = merge({ existing: [existingEntry], candidates: [candidate], policy: kode9 });
		// Same normalized prefix: added anyway, flagged against the existing entry.
		expect(result.added[0]?.nearDuplicateOf).toBe(existingEntry.slug);
	});

	it("does not flag against an entry that already has an mbid, nor on a partial word", () => {
		const withMbid = entry("Sine of the Dub", { mbid: "99999999-9999-4999-8999-999999999999" }, "Kode9");
		const partialWord = entry("Sin", {}, "Kode9");
		const candidate = release("Sines of Time", { primaryType: "Single" });
		const stalker = release("Sine of the Dub / Stalker", { primaryType: "Single" });

		const result = merge({
			existing: [withMbid, partialWord],
			candidates: [candidate, stalker],
			policy: kode9,
		});

		const byTitle = new Map(result.added.map((a) => [a.title, a]));
		expect(byTitle.get("Sines of Time")?.nearDuplicateOf).toBeUndefined();
		expect(byTitle.get("Sine of the Dub / Stalker")?.nearDuplicateOf).toBeUndefined();
	});
});

describe("mergeDiscography — result shape", () => {
	it("returns the very same list when there is nothing to pose or add", () => {
		const existing = [entry("Discovery", { mbid: mbidOf(5) }), entry("Homework")];
		const result = merge({ existing, candidates: [], allCredited: [] });
		expect(result.changed).toBe(false);
		expect(result.edges).toBe(existing);
		expect(result.posed).toEqual([]);
		expect(result.added).toEqual([]);
		expect(result.ambiguous).toEqual([]);
		expect(result.capReached).toBe(false);
	});

	it("sorts newest year first with undated entries last", () => {
		const existing = [entry("Undated"), entry("Old", { year: "1997" })];
		const recent = release("Recent", { firstReleaseDate: "2013-05-17" });
		const middle = release("Middle", { firstReleaseDate: "2005-01-01" });
		const posedOne = release("Undated2", { firstReleaseDate: "" });

		const result = merge({
			existing: [...existing, entry("Undated2")],
			candidates: [middle, recent],
			allCredited: [posedOne],
		});

		expect(result.edges.map((e) => e.name)).toEqual(["Recent", "Middle", "Old", "Undated", "Undated2"]);
	});
});

describe("reconciliationKey (TRA-629)", () => {
	it("drops a trailing year in parentheses or brackets, 1900 to 2099 only", () => {
		expect(reconciliationKey("Ladies' Night (1979)")).toBe(reconciliationKey("Ladies' Night"));
		expect(reconciliationKey("Ladies' Night [1979]")).toBe(reconciliationKey("Ladies' Night"));
		expect(reconciliationKey("Foo (2099)")).toBe("foo");
		expect(reconciliationKey("Foo (1899)")).not.toBe("foo");
		expect(reconciliationKey("Foo (2100)")).not.toBe("foo");
		expect(reconciliationKey("Foo (1979) Live")).not.toBe("foo");
		expect(reconciliationKey("Foo (1979]")).not.toBe("foo");
		expect(reconciliationKey("Foo [EP)")).not.toBe("foo");
	});

	it("drops a trailing EP in each written form", () => {
		for (const title of ["Xpander EP", "Xpander (EP)", "Xpander [EP]", "Xpander - EP", "Xpander \u2013 EP"]) {
			expect(reconciliationKey(title)).toBe("xpander");
		}
	});

	it("chains the two, in either order", () => {
		expect(reconciliationKey("Xpander EP (1996)")).toBe("xpander");
		expect(reconciliationKey("Xpander (1996) EP")).toBe("xpander");
	});

	it("does not truncate a bare year, nor a word that merely ends or starts with EP", () => {
		expect(reconciliationKey("1979")).toBe("1979");
		expect(reconciliationKey("(1979)")).toBe("1979");
		expect(reconciliationKey("EPic")).toBe("epic");
		expect(reconciliationKey("Deep")).toBe("deep");
		expect(reconciliationKey("Sleep")).toBe("sleep");
		expect(reconciliationKey("EP")).toBe("ep");
		expect(reconciliationKey("Foo-EP")).toBe("foo-ep");
	});
});

describe("mergeDiscography — suffix reconciliation (TRA-629)", () => {
	const kool = { ...policy, artistName: "Kool and the Gang" };

	it("poses the mbid on 'Ladies' Night (1979)' and adds nothing, name and slug untouched", () => {
		const existingEntry = entry("Ladies' Night (1979)", {}, "Kool and the Gang");
		const group = release("Ladies' Night", { firstReleaseDate: "1979-05-01" });

		const result = merge({
			existing: [existingEntry],
			candidates: [group],
			allCredited: [group],
			policy: kool,
		});

		expect(result.added).toEqual([]);
		expect(result.posed).toEqual([
			{ slug: existingEntry.slug, mbid: group.mbid, filled: ["year", "releaseType"] },
		]);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]).toMatchObject({
			name: "Ladies' Night (1979)",
			slug: existingEntry.slug,
			mbid: group.mbid,
		});
	});

	it("poses 'Xpander EP' on the EP 'Xpander'", () => {
		const existingEntry = entry("Xpander EP", {}, "Sasha");
		const group = release("Xpander", { primaryType: "EP", firstReleaseDate: "1996-01-01" });

		const result = merge({
			existing: [existingEntry],
			candidates: [group],
			allCredited: [group],
			policy: { ...policy, artistName: "Sasha" },
		});

		expect(result.added).toEqual([]);
		expect(result.posed.map((p) => p.mbid)).toEqual([group.mbid]);
		expect(result.edges[0]).toMatchObject({ name: "Xpander EP", slug: existingEntry.slug });
	});

	it("poses 'Kool and the Gang (1969)' on the self-titled album", () => {
		const existingEntry = entry("Kool and the Gang (1969)", {}, "Kool and the Gang");
		const group = release("Kool & the Gang", { firstReleaseDate: "1969-01-01" });

		const result = merge({
			existing: [existingEntry],
			candidates: [group],
			allCredited: [group],
			policy: kool,
		});

		expect(result.added).toEqual([]);
		expect(result.posed.map((p) => p.mbid)).toEqual([group.mbid]);
	});

	it("reconciles from the other side too: the release group carries the suffix", () => {
		const existingEntry = entry("Shivers", {}, "Armin van Buuren");
		const group = release("Shivers (2014)", { firstReleaseDate: "2014-03-01" });

		const result = merge({ existing: [existingEntry], candidates: [group], allCredited: [group] });

		expect(result.added).toEqual([]);
		expect(result.posed.map((p) => p.mbid)).toEqual([group.mbid]);
	});

	it("keeps the usual guards: a year more than one apart is ambiguous, not posed", () => {
		const existingEntry = entry("Ladies' Night (1979)", { year: "1979" }, "Kool and the Gang");
		const group = release("Ladies' Night", { firstReleaseDate: "2005-01-01" });

		const result = merge({
			existing: [existingEntry],
			candidates: [group],
			allCredited: [group],
			policy: kool,
		});

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([{ slug: existingEntry.slug, reason: "year-mismatch" }]);
		expect(result.added).toEqual([]);
	});

	it("keeps the type guard: an entry typed album does not take the EP", () => {
		const existingEntry = entry("Xpander EP", { releaseType: "album" }, "Sasha");
		const group = release("Xpander", { primaryType: "EP" });

		const result = merge({ existing: [existingEntry], candidates: [group], allCredited: [group] });

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([{ slug: existingEntry.slug, reason: "type" }]);
		expect(result.added).toEqual([]);
	});

	it("flags 'multiple' and adds neither candidate when the key finds two release groups", () => {
		const existingEntry = entry("Imagine (2005)");
		const first = release("Imagine");
		const second = release("Imagine [2010]");

		const result = merge({
			existing: [existingEntry],
			candidates: [first, second],
			allCredited: [first, second],
		});

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([{ slug: existingEntry.slug, reason: "multiple" }]);
		expect(result.added).toEqual([]);
		expect(result.changed).toBe(false);
	});

	it("still poses on the exact title first: a key twin does not make it ambiguous", () => {
		const existingEntry = entry("Mirage");
		const album = release("Mirage");
		const ep = release("Mirage EP", { primaryType: "EP" });

		const result = merge({ existing: [existingEntry], candidates: [album, ep], allCredited: [album, ep] });

		expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
		// "Mirage EP" is a different release group from the posed "Mirage": it is still added.
		expect(result.added.map((a) => a.title)).toEqual(["Mirage EP"]);
	});

	it("uses the year written in the title as the entry's year when it has no year field", () => {
		const existingEntry = entry("Greatest Hits (1992)");
		const group = release("Greatest Hits", { firstReleaseDate: "2005-06-01" });

		const result = merge({ existing: [existingEntry], candidates: [group], allCredited: [group] });

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([{ slug: existingEntry.slug, reason: "year-mismatch" }]);
		expect(result.added).toEqual([]);
	});

	it("never poses an mbid an entry already holds: a twin added by an earlier run keeps the legacy apart", () => {
		const legacy = entry("Ladies' Night (1979)", {}, "Kool and the Gang");
		const group = release("Ladies' Night", { firstReleaseDate: "1979-05-01" });
		const twin = entry("Ladies' Night", { mbid: group.mbid, year: "1979" }, "Kool and the Gang");

		const result = merge({
			existing: [legacy, twin],
			candidates: [group],
			allCredited: [group],
			policy: kool,
		});

		expect(result.posed).toEqual([]);
		expect(result.added).toEqual([]);
		expect(result.edges.filter((e) => e.mbid === group.mbid)).toHaveLength(1);
	});

	it("poses one mbid on one entry only when two entries share a key", () => {
		const exact = entry("Xpander", {}, "Sasha");
		const suffixed = entry("Xpander EP", {}, "Sasha");
		const group = release("Xpander", { primaryType: "EP" });

		const result = merge({
			existing: [exact, suffixed],
			candidates: [group],
			allCredited: [group],
			policy: { ...policy, artistName: "Sasha" },
		});

		expect(result.posed.map((p) => p.slug)).toEqual([exact.slug]);
		expect(result.edges.filter((e) => e.mbid === group.mbid)).toHaveLength(1);
		expect(result.added).toEqual([]);
	});

	it("does not tie 'Deep' to 'De', nor '1979' to a release group named otherwise", () => {
		const deep = entry("Deep");
		const year = entry("1979");
		const de = release("De");
		const other = release("1979 (Live)", { secondaryTypes: ["Live"] });

		const result = merge({ existing: [deep, year], candidates: [], allCredited: [de, other] });

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([]);
	});

	it("keeps counting the other near duplicates, subtitles and couplings", () => {
		const existingEntry = entry("Sine of the Dub", {}, "Kode9");
		const coupling = release("Sine of the Dub / Stalker", { primaryType: "Single" });
		const subtitle = release("Sine of the Dub (Remastered Dub Plates)", { primaryType: "Single" });
		const sameWork = release("Sine of the Dub (2010)", { primaryType: "Single" });

		const result = merge({
			existing: [existingEntry],
			candidates: [coupling, subtitle, sameWork],
			policy: { ...policy, artistName: "Kode9" },
		});

		// The two titles that only extend the entry's are still added and flagged; the one that is the entry
		// plus a year is the entry itself, not a candidate for addition.
		expect(result.added.map((a) => [a.title, a.nearDuplicateOf])).toEqual(
			expect.arrayContaining([
				["Sine of the Dub / Stalker", existingEntry.slug],
				["Sine of the Dub (Remastered Dub Plates)", existingEntry.slug],
			]),
		);
		expect(result.added.map((a) => a.title)).not.toContain("Sine of the Dub (2010)");
	});
});
