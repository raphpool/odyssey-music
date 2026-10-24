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
	VARIOUS_ARTISTS_MBID,
} from "../src/discography-policy.js";
import { makeScopedSlug } from "../src/slug.js";
import type { EdgeRef, Slug } from "../src/types.js";

const ARTIST_MBID = "11111111-1111-4111-8111-111111111111";

const policy: DiscographyPolicy = {
	artistMbid: ARTIST_MBID,
	artistName: "Daft Punk",
	cap: DEFAULT_DISCOGRAPHY_CAP,
	currentYear: 2026,
	currentDate: "2026-10-24",
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
		projectIndex: { byMbid: new Map(), mbidBySlug: new Map(), resolveSlug: (slug) => slug },
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

	it("ignores the Live / Compilation homonyms of an entry that states its releaseType and poses the studio album", () => {
		const album = release("Blue Train", { firstReleaseDate: "1958-01-01" });
		const live = release("Blue Train", { firstReleaseDate: "2004-01-01", secondaryTypes: ["Live"] });
		const existing = [entry("Blue Train", { releaseType: "album" })];

		// Same rule as for an entry without type (TRA-628): the Live album is not the entry's work.
		const result = merge({ existing, allCredited: [album, live] });

		expect(result.ambiguous).toEqual([]);
		expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
	});

	it("keeps two studio albums of the same title ambiguous for an entry that states 'album'", () => {
		const first = release("Blue Train", { firstReleaseDate: "1958-01-01" });
		const second = release("Blue Train", { firstReleaseDate: "1959-01-01" });
		const live = release("Blue Train", { firstReleaseDate: "2004-01-01", secondaryTypes: ["Live"] });
		const existing = [entry("Blue Train", { releaseType: "album" })];

		const result = merge({ existing, allCredited: [first, second, live] });

		expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "multiple" }]);
		expect(result.posed).toEqual([]);
	});

	describe.each([
		["exact title", "Hurt", "Hurt"],
		["looser key", "Hurt (2002)", "Hurt"],
	])(
		"an entry that states its type never takes a Live / Compilation release group (%s)",
		(_label, entryName, rgTitle) => {
			it("typed 'ep' next to the album and a Compilation EP: no pose", () => {
				const existingEntry = entry(entryName, { releaseType: "ep" });
				const album = release(rgTitle, { primaryType: "Album", firstReleaseDate: "2002-11-05" });
				const compilationEp = release(rgTitle, {
					primaryType: "EP",
					secondaryTypes: ["Compilation"],
					firstReleaseDate: "2002-12-01",
				});

				const result = merge({ existing: [existingEntry], allCredited: [album, compilationEp] });

				expect(result.posed).toEqual([]);
				expect(result.edges.some((e) => e.mbid === compilationEp.mbid)).toBe(false);
			});

			it("typed 'album' next to a single and a Compilation album: no pose", () => {
				const existingEntry = entry(entryName, { releaseType: "album" });
				const single = release(rgTitle, { primaryType: "Single", firstReleaseDate: "2002-11-05" });
				const compilationAlbum = release(rgTitle, {
					primaryType: "Album",
					secondaryTypes: ["Compilation"],
					firstReleaseDate: "2002-12-01",
				});

				const result = merge({ existing: [existingEntry], allCredited: [single, compilationAlbum] });

				expect(result.posed).toEqual([]);
				expect(result.edges.some((e) => e.mbid === compilationAlbum.mbid)).toBe(false);
			});

			it("typed 'album' next to the studio album and a Compilation album: the studio album", () => {
				const existingEntry = entry(entryName, { releaseType: "album" });
				const album = release(rgTitle, { primaryType: "Album", firstReleaseDate: "2002-11-05" });
				const compilationAlbum = release(rgTitle, {
					primaryType: "Album",
					secondaryTypes: ["Compilation"],
					firstReleaseDate: "2002-12-01",
				});

				const result = merge({ existing: [existingEntry], allCredited: [album, compilationAlbum] });

				expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
			});
		},
	);

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
		// With a year: an entry without one is held back from an unvoted release group by TRA-647.
		const existing = [entry("The Lost Lennon Tapes, Vol. 1", { year: "1988" })];

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
				mbidBySlug: new Map(),
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
				mbidBySlug: new Map(),
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
				mbidBySlug: new Map(),
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
		expect(reconciliationKey("(EP) (1979)")).toBe("ep");
		expect(reconciliationKey("EP (1979)")).toBe("ep");
		expect(reconciliationKey("(1979) (EP)")).toBe("1979");
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

	describe.each([
		["the exact twin listed first", false],
		["the suffixed entry listed first", true],
	])("one mbid on one entry only, %s", (_label, suffixedFirst) => {
		it("gives the mbid to the entry with the exact title, nothing to its suffixed twin, adds nothing", () => {
			const exact = entry("Xpander", {}, "Sasha");
			const suffixed = entry("Xpander EP", {}, "Sasha");
			const group = release("Xpander", { primaryType: "EP" });

			const result = merge({
				existing: suffixedFirst ? [suffixed, exact] : [exact, suffixed],
				candidates: [group],
				allCredited: [group],
				policy: { ...policy, artistName: "Sasha" },
			});

			expect(result.posed.map((p) => [p.slug, p.mbid])).toEqual([[exact.slug, group.mbid]]);
			expect(result.edges.filter((e) => e.mbid === group.mbid).map((e) => e.slug)).toEqual([exact.slug]);
			expect(result.edges.find((e) => e.slug === suffixed.slug)?.mbid).toBeUndefined();
			expect(result.ambiguous).toEqual([]);
			expect(result.added).toEqual([]);
		});
	});

	it("does not pose the EP on a legacy entry when its twin already holds the album, and adds the EP on its own", () => {
		const legacy = entry("Ladies' Night (1979)", {}, "Kool and the Gang");
		const album = release("Ladies' Night", { firstReleaseDate: "1979-05-01" });
		const ep = release("Ladies' Night EP", { primaryType: "EP", firstReleaseDate: "1979-06-01" });
		const twin = entry("Ladies' Night", { mbid: album.mbid, year: "1979" }, "Kool and the Gang");

		const result = merge({
			existing: [twin, legacy],
			candidates: [album, ep],
			allCredited: [album, ep],
			policy: kool,
		});

		// The album is the entry's work, and the twin holds it: the entry stays as it is. The EP is a release
		// group of its own, never the entry's mbid.
		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([]);
		expect(result.edges.find((e) => e.slug === legacy.slug)?.mbid).toBeUndefined();
		expect(result.edges.find((e) => e.slug === legacy.slug)?.releaseType).toBeUndefined();
		expect(result.added.map((a) => a.mbid)).toEqual([ep.mbid]);
	});

	it("leaves a legacy entry untouched when the only release group under its key is held by its twin", () => {
		const legacy = entry("Ladies' Night (1979)", {}, "Kool and the Gang");
		const album = release("Ladies' Night", { firstReleaseDate: "1979-05-01" });
		const twin = entry("Ladies' Night", { mbid: album.mbid }, "Kool and the Gang");

		const result = merge({
			existing: [legacy, twin],
			candidates: [album],
			allCredited: [album],
			policy: kool,
		});

		expect(result.changed).toBe(false);
		expect(result.ambiguous).toEqual([]);
	});

	describe.each([
		["'Foo EP' first", false],
		["'Foo (1979)' first", true],
	])("two suffixed entries claiming the same release group, %s", (_label, reversed) => {
		it("poses neither and reports both, whatever their order", () => {
			const withEp = entry("Foo EP");
			const withYear = entry("Foo (1979)");
			const group = release("Foo", { primaryType: "EP", firstReleaseDate: "1979-01-01" });

			const result = merge({
				existing: reversed ? [withYear, withEp] : [withEp, withYear],
				candidates: [group],
				allCredited: [group],
			});

			expect(result.posed).toEqual([]);
			expect(result.edges.filter((e) => e.mbid !== undefined)).toEqual([]);
			expect(result.ambiguous.map((a) => [a.slug, a.reason]).sort()).toEqual(
				[
					[withEp.slug, "multiple"],
					[withYear.slug, "multiple"],
				].sort(),
			);
			expect(result.added).toEqual([]);
		});
	});

	it("gives the same result whatever the order of the existing entries", () => {
		const exact = entry("Xpander", {}, "Sasha");
		const suffixed = entry("Xpander EP", {}, "Sasha");
		const plain = entry("Ladies' Night (1979)", {}, "Sasha");
		const withEp = entry("Foo EP", {}, "Sasha");
		const withYear = entry("Foo (1979)", {}, "Sasha");
		const settled = entry("Discovery", { mbid: mbidOf(900) }, "Sasha");
		const xpander = release("Xpander", { primaryType: "EP" });
		const night = release("Ladies' Night", { firstReleaseDate: "1979-05-01" });
		const foo = release("Foo", { primaryType: "EP", firstReleaseDate: "1979-01-01" });
		const extra = release("Brand New", { firstReleaseDate: "2020-01-01" });
		const all = [xpander, night, foo, extra];
		const entries = [exact, suffixed, plain, withEp, withYear, settled];

		const summarize = (existing: EdgeRef[]) => {
			const result = merge({
				existing,
				candidates: all,
				allCredited: all,
				policy: { ...policy, artistName: "Sasha" },
			});
			return JSON.stringify({
				edges: result.edges
					.map((e) => [e.slug, e.mbid ?? null, e.year ?? null, e.releaseType ?? null])
					.sort(),
				posed: result.posed.map((p) => [p.slug, p.mbid, [...p.filled].sort()]).sort(),
				ambiguous: result.ambiguous.map((a) => [a.slug, a.reason]).sort(),
				added: result.added.map((a) => [a.slug, a.mbid, a.nearDuplicateOf ?? null]).sort(),
				capReached: result.capReached,
			});
		};

		const permutations = (items: EdgeRef[]): EdgeRef[][] =>
			items.length <= 1
				? [items]
				: items.flatMap((item, i) =>
						permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
					);

		const reference = summarize(entries);
		// Sanity: the case is a real mix of poses, ambiguities and an addition, not an empty comparison.
		expect(JSON.parse(reference).posed.length).toBeGreaterThan(0);
		expect(JSON.parse(reference).ambiguous.length).toBeGreaterThan(0);
		expect(JSON.parse(reference).added.length).toBeGreaterThan(0);
		for (const order of permutations(entries)) {
			expect(summarize(order)).toBe(reference);
		}
	});

	it("keeps the year guard when the title states its year before an EP suffix", () => {
		const existingEntry = entry("Greatest Hits (1992) EP");
		const group = release("Greatest Hits", { primaryType: "EP", firstReleaseDate: "2005-06-01" });

		const result = merge({ existing: [existingEntry], candidates: [group], allCredited: [group] });

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([{ slug: existingEntry.slug, reason: "year-mismatch" }]);
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

		const result = merge({
			existing: [existingEntry],
			candidates: [coupling, subtitle],
			allCredited: [coupling, subtitle],
			policy: { ...policy, artistName: "Kode9" },
		});

		// Neither title is the entry's up to a year or EP suffix: both are added and flagged.
		expect(result.posed).toEqual([]);
		expect(result.added.map((a) => [a.title, a.nearDuplicateOf])).toEqual(
			expect.arrayContaining([
				["Sine of the Dub / Stalker", existingEntry.slug],
				["Sine of the Dub (Remastered Dub Plates)", existingEntry.slug],
			]),
		);
		expect(result.added).toHaveLength(2);
	});

	describe("on release groups as MusicBrainz returns them (read 2026-10-19)", () => {
		// Trimmed copies of what `fetchArtistDiscographyMb` returned for these artists: the homonymous singles,
		// the Live / Compilation albums and the multi-artist singles are there, which the dry-run manifest does not show.
		const koolCredit = [{ mbid: ARTIST_MBID, name: "Kool & the Gang" }];
		const real = (
			title: string,
			mbid: string,
			firstReleaseDate: string,
			primaryType: string,
			secondaryTypes: string[] = [],
			ratingVotes = 0,
			artistCredits = koolCredit,
		): ReleaseGroupCandidate => ({
			mbid,
			title,
			firstReleaseDate,
			primaryType,
			secondaryTypes,
			artistCredits,
			ratingVotes,
		});
		const ladiesNight = [
			real("Ladies\u2019 Night", "5d3fb998-0857-37d5-b211-e95e646c38d5", "1979-09-06", "Album", [], 2),
			real("Ladies Night", "2138a736-ba8c-40ea-8221-f669b03dfe32", "1979", "Single", [], 1),
			real("Ladies Night", "68cabb06-70bb-476c-8811-6056239e8bea", "2003-12-15", "Single", [], 0, [
				...koolCredit,
				{ mbid: "00000000-0000-4000-8000-0000000000a1", name: "Atomic Kitten" },
			]),
			real("Ladies Night", "3a26f2f5-973e-4106-8202-ffc1ff8ea3e4", "2004-04-20", "Single", [], 0, [
				...koolCredit,
				{ mbid: "00000000-0000-4000-8000-0000000000a2", name: "Sean Paul" },
			]),
			real("Ladies Night", "36fee049-018d-4413-b929-937567c14e7e", "2004", "Album", ["Compilation"]),
			real("Ladies\u2019 Night", "c76be46d-f15b-4fad-82dd-3e06dc49854e", "", "Album", ["Compilation"]),
		];
		const koolRg = [
			real("Kool and the Gang", "0931b359-fc39-33b2-b52e-a9aaf103e33a", "1969", "Album", [], 1),
			real(
				"Kool & the Gang",
				"97f8d5f3-324b-40a7-8e9d-d38482f7cef7",
				"2007",
				"Album",
				["Compilation", "Live"],
				1,
			),
			real("Kool & The Gang", "f01659dd-dda1-4918-a2b5-e9d95feffabf", "1995", "Album", [
				"Compilation",
				"Live",
			]),
			real("Kool & the Gang", "9df5ffc6-0141-4579-8b23-7cc124cb79cf", "1997-03-04", "Album", ["Compilation"]),
			real("Kool & The Gang", "b37ea5a1-eee0-469e-9e9d-dc79abae21db", "2001", "Album", ["Compilation"]),
			real("Kool and the Gang", "967c2912-e19e-40d4-9b98-82ab9ddc20af", "2012", "Album", ["Compilation"]),
		];
		const emergency = [
			real("Emergency", "1e650dc3-191b-3816-a8ce-ef62a401a096", "1984-11-15", "Album", [], 2),
			real("Emergency", "5c447f52-6c2d-4c13-818d-3e8220c3bd22", "1984", "Single", [], 1),
		];
		const mitisCredit = [{ mbid: ARTIST_MBID, name: "MitiS" }];
		const foundations = [
			real("Foundations", "194a366b-28a8-4ce3-ad9b-987132d001f7", "2016-03-18", "EP", [], 0, mitisCredit),
			real("Foundations", "91b28708-6c03-4254-bf73-7b01253bfff2", "2016-02-24", "Single", [], 0, [
				...mitisCredit,
				{ mbid: "00000000-0000-4000-8000-0000000000a3", name: "Adara" },
			]),
		];
		const dyingForIt = [
			real("Dying for It", "8c6cecaa-4b0f-3ca8-8bb0-f360fc9a2800", "1988", "EP", [], 0, [
				{ mbid: ARTIST_MBID, name: "The Vaselines" },
			]),
			real("Dying for It", "2ca8749a-0b15-3775-984f-3fe4b9e78d8d", "1988", "Single", [], 0, [
				{ mbid: ARTIST_MBID, name: "The Vaselines" },
			]),
		];

		it("poses 'Ladies' Night (1979)' on the 1979 album, not left ambiguous by its homonymous singles and compilations", () => {
			const existingEntry = entry("Ladies' Night (1979)", {}, "Kool and the Gang");

			const result = merge({
				existing: [existingEntry],
				// What the pipeline would offer for addition: the album, its same-titled single dropped by slug.
				candidates: selectReleases(ladiesNight, kool).kept,
				allCredited: ladiesNight,
				policy: kool,
			});

			expect(result.posed).toEqual([
				{
					slug: existingEntry.slug,
					mbid: "5d3fb998-0857-37d5-b211-e95e646c38d5",
					filled: ["year", "releaseType"],
				},
			]);
			expect(result.ambiguous).toEqual([]);
			expect(result.added).toEqual([]);
		});

		it("poses 'Kool and the Gang (1969)' on the 1969 album among five compilations", () => {
			const existingEntry = entry("Kool and the Gang (1969)", {}, "Kool and the Gang");

			const result = merge({ existing: [existingEntry], allCredited: koolRg, policy: kool });

			expect(result.posed.map((p) => p.mbid)).toEqual(["0931b359-fc39-33b2-b52e-a9aaf103e33a"]);
			expect(result.ambiguous).toEqual([]);
		});

		it("poses 'Emergency (1984)' on the album, not its single", () => {
			const existingEntry = entry("Emergency (1984)", {}, "Kool and the Gang");

			const result = merge({ existing: [existingEntry], allCredited: emergency, policy: kool });

			expect(result.posed.map((p) => p.mbid)).toEqual(["1e650dc3-191b-3816-a8ce-ef62a401a096"]);
			expect(result.ambiguous).toEqual([]);
		});

		it("poses 'Foundations EP' on the EP, not the single of the same title", () => {
			const existingEntry = entry("Foundations EP", {}, "MitiS");

			const result = merge({
				existing: [existingEntry],
				allCredited: foundations,
				policy: { ...policy, artistName: "MitiS" },
			});

			expect(result.posed.map((p) => p.mbid)).toEqual(["194a366b-28a8-4ce3-ad9b-987132d001f7"]);
			expect(result.ambiguous).toEqual([]);
		});

		it("poses 'Dying for It EP' on the EP, not the single of the same title", () => {
			const existingEntry = entry("Dying for It EP", {}, "The Vaselines");

			const result = merge({
				existing: [existingEntry],
				allCredited: dyingForIt,
				policy: { ...policy, artistName: "The Vaselines" },
			});

			expect(result.posed.map((p) => p.mbid)).toEqual(["8c6cecaa-4b0f-3ca8-8bb0-f360fc9a2800"]);
			expect(result.ambiguous).toEqual([]);
		});
	});

	it("never gives the album 'Foo' to an entry that was written 'Foo - EP': the entry is left alone, the album is its own release group", () => {
		const existingEntry = entry("Foo - EP");
		const album = release("Foo", { primaryType: "Album" });

		const result = merge({ existing: [existingEntry], candidates: [album], allCredited: [album] });

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([]);
		expect(result.edges.find((e) => e.slug === existingEntry.slug)?.mbid).toBeUndefined();
		expect(result.added.map((a) => [a.mbid, a.releaseType])).toEqual([[album.mbid, "album"]]);
	});

	it("does not pose the Compilation EP 'Hurt' on 'Hurt EP' when the group also has the album", () => {
		const existingEntry = entry("Hurt EP", {}, "Johnny Cash");
		const album = release("Hurt", { primaryType: "Album", firstReleaseDate: "2002-11-05" });
		const compilationEp = release("Hurt", {
			primaryType: "EP",
			secondaryTypes: ["Compilation"],
			firstReleaseDate: "2003-01-01",
		});

		const result = merge({
			existing: [existingEntry],
			candidates: [album],
			allCredited: [album, compilationEp],
			policy: { ...policy, artistName: "Johnny Cash" },
		});

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([]);
		expect(result.edges.some((e) => e.mbid === compilationEp.mbid)).toBe(false);
		expect(result.edges.find((e) => e.slug === existingEntry.slug)?.mbid).toBeUndefined();
		expect(result.added.map((a) => a.mbid)).toEqual([album.mbid]);
	});

	it("leaves 'Hurt EP' alone when the EP of that title is only a Live one", () => {
		const existingEntry = entry("Hurt EP");
		const liveEp = release("Hurt", { primaryType: "EP", secondaryTypes: ["Live"] });

		const result = merge({ existing: [existingEntry], allCredited: [liveEp] });

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([]);
		expect(result.changed).toBe(false);
	});

	it("poses the admitted EP on 'Foo EP' when the group also has an album and a Compilation EP", () => {
		const existingEntry = entry("Foo EP");
		const album = release("Foo", { primaryType: "Album", firstReleaseDate: "2010-01-01" });
		const ep = release("Foo", { primaryType: "EP", firstReleaseDate: "2010-01-01" });
		const compilationEp = release("Foo", { primaryType: "EP", secondaryTypes: ["Compilation"] });

		const result = merge({
			existing: [existingEntry],
			candidates: [album, ep],
			allCredited: [album, ep, compilationEp],
		});

		expect(result.posed.map((p) => p.mbid)).toEqual([ep.mbid]);
	});

	it("reports 'Foo EP' as multiple when two admitted EPs share the title", () => {
		const existingEntry = entry("Foo EP");
		const first = release("Foo", { primaryType: "EP", firstReleaseDate: "2010-01-01" });
		const second = release("Foo", { primaryType: "EP", firstReleaseDate: "2011-01-01" });

		const result = merge({
			existing: [existingEntry],
			candidates: [first, second],
			allCredited: [first, second],
		});

		expect(result.posed).toEqual([]);
		expect(result.ambiguous).toEqual([{ slug: existingEntry.slug, reason: "multiple" }]);
		expect(result.added).toEqual([]);
	});

	it("leaves 'Foo EP' as it is when the only admitted EP of that title is held by its twin", () => {
		const existingEntry = entry("Foo EP");
		const ep = release("Foo", { primaryType: "EP" });
		const twin = entry("Foo", { mbid: ep.mbid, releaseType: "ep" });

		const result = merge({ existing: [existingEntry, twin], candidates: [ep], allCredited: [ep] });

		expect(result.changed).toBe(false);
		expect(result.ambiguous).toEqual([]);
	});

	it("gives an untyped 'Foo EP' the EP 'Foo' and not the album of the same title", () => {
		const existingEntry = entry("Foo EP");
		const album = release("Foo", { primaryType: "Album", firstReleaseDate: "2010-01-01" });
		const ep = release("Foo", { primaryType: "EP", firstReleaseDate: "2010-01-01" });

		const result = merge({ existing: [existingEntry], candidates: [album, ep], allCredited: [album, ep] });

		expect(result.posed.map((p) => p.mbid)).toEqual([ep.mbid]);
		expect(result.edges.find((e) => e.slug === existingEntry.slug)).toMatchObject({
			mbid: ep.mbid,
			releaseType: "ep",
		});
	});
});

// TRA-647 (review of the cache PR #562, 2026-10-20): 5 reference entries were posed with the identity of another
// release group. An entry with neither releaseType nor year gave its mbid to the lone same-title release group,
// and a minor release (a promo single, a 2013 orchestral recording, a 2019 single with a guest) carries the exact
// title while the real album has a longer one ("Joe's Garage Act I").
describe("mergeDiscography — cautious pose without a year (TRA-647)", () => {
	const zappa: DiscographyPolicy = { ...policy, artistName: "Frank Zappa" };
	const zappaEntry = (name: string, extra: Partial<EdgeRef> = {}): EdgeRef =>
		entry(name, extra, "Frank Zappa");

	// Voted studio albums: what makes an artist "rated" (MIN_VOTED_FOR_UNRATED_CUT = 10).
	const votedAlbums = (count: number): ReleaseGroupCandidate[] =>
		Array.from({ length: count }, (_, i) =>
			release(`Studio Album ${i}`, { firstReleaseDate: `${1966 + i}-01-01`, ratingVotes: 20 + i }),
		);

	// The same albums as entries that already hold their mbid, so that what is added is only what the case adds.
	const settledEntries = (albums: ReleaseGroupCandidate[], artist: string): EdgeRef[] =>
		albums.map((a) =>
			entry(a.title, { mbid: a.mbid, year: a.firstReleaseDate.slice(0, 4), releaseType: "album" }, artist),
		);

	// What the migration does: `candidates` is selectReleases' kept list, `allCredited` is every release group.
	function mergeFor(
		artistPolicy: DiscographyPolicy,
		existing: EdgeRef[],
		allCredited: ReleaseGroupCandidate[],
		extra: Partial<MergeInput> = {},
	): ReturnType<typeof mergeDiscography> {
		const { kept } = selectReleases(allCredited, artistPolicy);
		return merge({ existing, candidates: kept, allCredited, policy: artistPolicy, ...extra });
	}

	describe("an artist with 10 voted release groups or more", () => {
		it.each([
			["Joe's Garage", "Frank Zappa", { primaryType: "Single", firstReleaseDate: "1979-09-07" }],
			["Trans-Europe Express", "Kraftwerk", { primaryType: "Single", firstReleaseDate: "1999-01-01" }],
			[
				"Merry Christmas, Mr. Lawrence",
				"Ryuichi Sakamoto",
				{ primaryType: "Single", firstReleaseDate: "2019-11-22" },
			],
		] satisfies [string, string, Partial<ReleaseGroupCandidate>][])(
			"does not pose the unvoted %s, reports it unrated-pose and adds nothing",
			(title, artist, fixture) => {
				const artistPolicy = { ...policy, artistName: artist };
				const minor = release(title, { ratingVotes: 0, ...fixture });
				const voted = votedAlbums(10);
				const held = entry(title, {}, artist);
				const existing = [...settledEntries(voted, artist), held];

				const result = mergeFor(artistPolicy, existing, [...voted, minor]);

				expect(result.posed).toEqual([]);
				expect(result.added).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: held.slug, reason: "unrated-pose" }]);
				expect(result.changed).toBe(false);
				expect(result.edges).toBe(existing);
			},
		);

		it("still poses a voted album: 'Imagine' (17 votes) next to its unvoted single", () => {
			const album = release("Imagine", { firstReleaseDate: "1971-09-09", ratingVotes: 17 });
			const single = release("Imagine", { primaryType: "Single", firstReleaseDate: "1971-10-11" });
			const existing = [entry("Imagine", {}, "John Lennon")];

			const result = mergeFor({ ...policy, artistName: "John Lennon" }, existing, [
				...votedAlbums(10),
				album,
				single,
			]);

			expect(result.ambiguous).toEqual([]);
			expect(result.posed).toEqual([
				{ slug: existing[0]?.slug, mbid: album.mbid, filled: ["year", "releaseType"] },
			]);
		});

		it("holds the entry when the album it would take is the unvoted one, whatever its voted single says", () => {
			const album = release("Joe's Garage", { firstReleaseDate: "1979-09-07", ratingVotes: 0 });
			const single = release("Joe's Garage", {
				primaryType: "Single",
				firstReleaseDate: "1979-09-07",
				ratingVotes: 4,
			});
			const existing = [zappaEntry("Joe's Garage")];

			const result = mergeFor(zappa, existing, [...votedAlbums(10), album, single]);

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "unrated-pose" }]);
		});

		it("spares a release of last year or this year, which has had no time to be voted", () => {
			// Singles: since TRA-649 an unvoted plain album is posed whatever its age.
			const lastYear = release("Fresh", { primaryType: "Single", firstReleaseDate: "2025-03-01" });
			const twoYearsAgo = release("Stale", { primaryType: "Single", firstReleaseDate: "2024-12-31" });
			const undated = release("Timeless", { primaryType: "Single", firstReleaseDate: "" });
			const existing = [zappaEntry("Fresh"), zappaEntry("Stale"), zappaEntry("Timeless")];

			const result = mergeFor(zappa, existing, [...votedAlbums(10), lastYear, twoYearsAgo, undated]);

			expect(result.posed.map((p) => p.mbid)).toEqual([lastYear.mbid]);
			expect(result.ambiguous.map((a) => [a.slug, a.reason]).sort()).toEqual(
				[
					[existing[1]?.slug, "unrated-pose"],
					[existing[2]?.slug, "unrated-pose"],
				].sort(),
			);
		});

		it("holds the looser pass too: an untyped 'Xpander EP' does not take an unvoted EP", () => {
			const ep = release("Xpander", { primaryType: "EP", firstReleaseDate: "1996-01-01" });
			const voted = votedAlbums(10);
			const held = zappaEntry("Xpander EP");

			const result = mergeFor(zappa, [...settledEntries(voted, "Frank Zappa"), held], [...voted, ep]);

			expect(result.posed).toEqual([]);
			expect(result.added).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: held.slug, reason: "unrated-pose" }]);
		});

		it("keeps the usual guards for an entry that states a year, a type, or a year in its title", () => {
			const single = release("Joe's Garage", { primaryType: "Single", firstReleaseDate: "1979-09-07" });
			const night = release("Ladies' Night", { firstReleaseDate: "1979-05-01" });
			const base = votedAlbums(10);

			const withYear = mergeFor(zappa, [zappaEntry("Joe's Garage", { year: "1979" })], [...base, single]);
			expect(withYear.posed.map((p) => p.mbid)).toEqual([single.mbid]);

			const withType = mergeFor(
				zappa,
				[zappaEntry("Joe's Garage", { releaseType: "single" })],
				[...base, single],
			);
			expect(withType.posed.map((p) => p.mbid)).toEqual([single.mbid]);

			const withTitleYear = mergeFor(zappa, [zappaEntry("Ladies' Night (1979)")], [...base, night]);
			expect(withTitleYear.posed.map((p) => p.mbid)).toEqual([night.mbid]);
		});
	});

	describe("an artist with fewer than 10 voted release groups", () => {
		it("poses 'Memories of the Future' for Kode9, who has none voted, as before", () => {
			const memories = release("Memories of the Future", { firstReleaseDate: "2006-05-08" });
			const others = Array.from({ length: 23 }, (_, i) =>
				release(`Kode9 Record ${i}`, { primaryType: "EP" }),
			);
			const existing = [entry("Memories of the Future", {}, "Kode9")];

			const result = mergeFor({ ...policy, artistName: "Kode9" }, existing, [memories, ...others]);

			expect(result.ambiguous).toEqual([]);
			expect(result.posed.map((p) => p.mbid)).toEqual([memories.mbid]);
		});

		it("counts the threshold exactly: 9 voted poses, 10 voted holds", () => {
			const single = release("Joe's Garage", { primaryType: "Single", firstReleaseDate: "1979-09-07" });
			const existing = [zappaEntry("Joe's Garage")];

			const nine = mergeFor(zappa, existing, [...votedAlbums(9), single]);
			expect(nine.posed.map((p) => p.mbid)).toEqual([single.mbid]);

			const ten = mergeFor(zappa, existing, [...votedAlbums(10), single]);
			expect(ten.posed).toEqual([]);
		});
	});

	// Measured 2026-10-20 on Duke Ellington (2 voted release groups of 82, so the rated-artist rule stays out): the
	// 2013 "Black, Brown, and Beige" is credited to him first but to more than two artists, and the pose took it.
	// A release group the artist does not head is somebody else's work: its mbid is never the entry's identity.
	describe("a release group the credit rule of classifyRelease rejects", () => {
		const ellington: DiscographyPolicy = { ...policy, artistName: "Duke Ellington" };
		const BUFFALO = { mbid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Buffalo Philharmonic Orchestra" };
		const ELLINGTON = { mbid: ARTIST_MBID, name: "Duke Ellington" };
		const third = (n: number) => ({ mbid: mbidOf(900 + n), name: `Guest ${n}` });
		const bbb = entry("Black, Brown and Beige", {}, "Duke Ellington");

		it.each([
			["the artist is not the first credit", [BUFFALO, ELLINGTON]],
			["the release has more than two credits", [ELLINGTON, third(1), third(2)]],
			[
				"the release is credited to Various Artists",
				[ELLINGTON, { mbid: VARIOUS_ARTISTS_MBID, name: "Various Artists" }],
			],
		])("is not posed, nor added, and is reported `credit`, when %s", (_label, artistCredits) => {
			const found = release("Black, Brown and Beige", { firstReleaseDate: "2013-02-26", artistCredits });
			const { kept } = selectReleases([found], ellington);

			const result = merge({ existing: [bbb], candidates: kept, allCredited: [found], policy: ellington });

			expect(result.posed).toEqual([]);
			expect(result.added).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: bbb.slug, reason: "credit" }]);
			expect(result.changed).toBe(false);
		});

		it("is not added either when a caller hands it over as a candidate", () => {
			const found = release("Black, Brown and Beige", { artistCredits: [BUFFALO, ELLINGTON] });
			const result = merge({ existing: [bbb], candidates: [found], allCredited: [found], policy: ellington });
			expect(result.posed).toEqual([]);
			expect(result.added).toEqual([]);
		});

		it("is not posed on the looser pass either", () => {
			const found = release("Xpander", {
				primaryType: "EP",
				artistCredits: [BUFFALO, ELLINGTON],
			});
			const xpander = entry("Xpander EP", {}, "Duke Ellington");
			const result = merge({ existing: [xpander], allCredited: [found] });
			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: xpander.slug, reason: "credit" }]);
		});

		it("is not posed on an entry that states a year or a type: the credit guard is for every entry", () => {
			const found = release("Black, Brown and Beige", {
				firstReleaseDate: "2013-02-26",
				artistCredits: [ELLINGTON, third(1), third(2)],
			});
			for (const extra of [{ year: "2013" }, { releaseType: "album" as const }]) {
				const stated = entry("Black, Brown and Beige", extra, "Duke Ellington");
				const result = merge({ existing: [stated], allCredited: [found], policy: ellington });
				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: stated.slug, reason: "credit" }]);
			}
		});

		// The credit is checked on the release group the decision picks, not before it: filtering first would turn
		// "two recordings" (multiple) into a confident pose on the other one.
		it("keeps two recordings of one title ambiguous when only one of them fails the credit rule", () => {
			const own = release("Black, Brown and Beige", { firstReleaseDate: "1958-01-01" });
			const other = release("Black, Brown and Beige", {
				firstReleaseDate: "2013-02-26",
				artistCredits: [ELLINGTON, third(1), third(2)],
			});
			for (const allCredited of [
				[own, other],
				[other, own],
			]) {
				const result = merge({ existing: [bbb], allCredited, policy: ellington });
				expect(result.posed).toEqual([]);
				expect(result.added).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: bbb.slug, reason: "multiple" }]);
			}
		});

		it("does not fall back on the single when the album of the title fails the credit rule (TRA-560)", () => {
			const album = release("Black, Brown and Beige", {
				firstReleaseDate: "1958-01-01",
				artistCredits: [ELLINGTON, third(1), third(2)],
			});
			const single = release("Black, Brown and Beige", {
				primaryType: "Single",
				firstReleaseDate: "1958-01-01",
			});
			for (const allCredited of [
				[album, single],
				[single, album],
			]) {
				const result = merge({ existing: [bbb], allCredited, policy: ellington });
				expect(result.posed).toEqual([]);
				expect(result.added).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: bbb.slug, reason: "credit" }]);
			}
		});

		it("poses the artist's own release group when the other one of the title is a single it heads", () => {
			const album = release("Black, Brown and Beige", { firstReleaseDate: "1958-01-01" });
			const single = release("Black, Brown and Beige", {
				primaryType: "Single",
				firstReleaseDate: "1958-01-01",
			});
			const result = merge({ existing: [bbb], allCredited: [single, album], policy: ellington });
			expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
		});

		it("still poses an album credited to the artist and one guest, the artist first (Kode9 & The Spaceape)", () => {
			const album = release("Memories of the Future", {
				firstReleaseDate: "2006-05-08",
				artistCredits: [
					{ mbid: ARTIST_MBID, name: "Kode9" },
					{ mbid: mbidOf(950), name: "The Spaceape" },
				],
			});
			const result = merge({
				existing: [entry("Memories of the Future", {}, "Kode9")],
				allCredited: [album],
				policy: { ...policy, artistName: "Kode9" },
			});
			expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
		});

		it("keeps posing a Live release group of the artist: only the credit filters more", () => {
			const live = release("Live at the BBC", { secondaryTypes: ["Live"] });
			const result = merge({ existing: [entry("Live at the BBC")], allCredited: [live] });
			expect(result.posed.map((p) => p.mbid)).toEqual([live.mbid]);
		});
	});

	describe("a project node that already holds an mbid", () => {
		const sakamoto: DiscographyPolicy = { ...policy, artistName: "Ryuichi Sakamoto" };
		const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const vrioon = entry("Vrioon", {}, "Ryuichi Sakamoto");
		const nodeIndex = (
			mbid: string | undefined,
			resolveSlug = (slug: Slug): Slug => slug,
		): MergeInput["projectIndex"] => ({
			byMbid: new Map(),
			mbidBySlug: mbid === undefined ? new Map() : new Map([[resolveSlug(vrioon.slug), mbid]]),
			resolveSlug,
		});

		it("does not pose another mbid on the entry, reports node-conflict and adds nothing", () => {
			const remaster = release("Vrioon", { firstReleaseDate: "2022-04-08" });

			const result = mergeFor(sakamoto, [vrioon], [remaster], { projectIndex: nodeIndex(M1) });

			expect(result.posed).toEqual([]);
			expect(result.added).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: vrioon.slug, reason: "node-conflict" }]);
			expect(result.changed).toBe(false);
		});

		it("poses the node's mbid when it is the candidate, and completes year and releaseType", () => {
			const original = release("Vrioon", { mbid: M1, firstReleaseDate: "2002-01-01" });

			const result = mergeFor(sakamoto, [vrioon], [original], { projectIndex: nodeIndex(M1) });

			expect(result.ambiguous).toEqual([]);
			expect(result.posed).toEqual([{ slug: vrioon.slug, mbid: M1, filled: ["year", "releaseType"] }]);
		});

		it("poses the node's mbid among several candidates, which would otherwise be ambiguous", () => {
			const original = release("Vrioon", { mbid: M1, firstReleaseDate: "2002-01-01" });
			const remaster = release("Vrioon", { firstReleaseDate: "2022-04-08" });

			const withoutNode = mergeFor(sakamoto, [vrioon], [remaster, original]);
			expect(withoutNode.ambiguous).toEqual([{ slug: vrioon.slug, reason: "multiple" }]);

			for (const allCredited of [
				[original, remaster],
				[remaster, original],
			]) {
				const result = mergeFor(sakamoto, [vrioon], allCredited, { projectIndex: nodeIndex(M1) });
				expect(result.posed.map((p) => p.mbid)).toEqual([M1]);
				expect(result.ambiguous).toEqual([]);
			}
		});

		it("compares mbids whatever their case", () => {
			const original = release("Vrioon", { mbid: M1, firstReleaseDate: "2002-01-01" });
			const result = mergeFor(sakamoto, [vrioon], [original], { projectIndex: nodeIndex(M1.toUpperCase()) });
			expect(result.posed.map((p) => p.mbid)).toEqual([M1]);
		});

		it("poses the node's mbid even when it is unvoted and the artist is rated: the node is the identity", () => {
			const original = release("Vrioon", { mbid: M1, firstReleaseDate: "2002-01-01" });
			const result = mergeFor(sakamoto, [vrioon], [...votedAlbums(10), original], {
				projectIndex: nodeIndex(M1),
			});
			expect(result.posed.map((p) => p.mbid)).toEqual([M1]);
		});

		it("reads the node under the slug the redirects lead to", () => {
			const remaster = release("Vrioon", { firstReleaseDate: "2022-04-08" });
			const moved = "project:vrioon-2002--ryuichi-sakamoto" as Slug;
			const resolveSlug = (slug: Slug): Slug => (slug === vrioon.slug ? moved : slug);

			const result = mergeFor(sakamoto, [vrioon], [remaster], { projectIndex: nodeIndex(M1, resolveSlug) });

			expect(result.ambiguous).toEqual([{ slug: vrioon.slug, reason: "node-conflict" }]);
		});

		it("holds the looser pass too: an untyped 'Vrioon EP' does not take another EP", () => {
			const ep = release("Vrioon", { primaryType: "EP", firstReleaseDate: "2022-04-08" });
			const epEntry = entry("Vrioon EP", {}, "Ryuichi Sakamoto");
			const projectIndex: MergeInput["projectIndex"] = {
				byMbid: new Map(),
				mbidBySlug: new Map([[epEntry.slug, M1]]),
				resolveSlug: (slug) => slug,
			};

			const result = mergeFor(sakamoto, [epEntry], [ep], { projectIndex });

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: epEntry.slug, reason: "node-conflict" }]);
		});

		it("applies to an entry that states a type but no year: the same guard, at no cost", () => {
			const remaster = release("Vrioon", { firstReleaseDate: "2022-04-08" });
			const original = release("Vrioon", { mbid: M1, firstReleaseDate: "2002-01-01" });
			const typed = entry("Vrioon", { releaseType: "album" }, "Ryuichi Sakamoto");

			const conflict = mergeFor(sakamoto, [typed], [remaster], { projectIndex: nodeIndex(M1) });
			expect(conflict.posed).toEqual([]);
			expect(conflict.added).toEqual([]);
			expect(conflict.ambiguous).toEqual([{ slug: typed.slug, reason: "node-conflict" }]);

			const match = mergeFor(sakamoto, [typed], [original], { projectIndex: nodeIndex(M1) });
			expect(match.posed.map((p) => p.mbid)).toEqual([M1]);
		});

		it("keeps the type guard on the node's own mbid: an album entry never takes a single", () => {
			const single = release("Vrioon", { mbid: M1, primaryType: "Single", firstReleaseDate: "2002-01-01" });
			const typed = entry("Vrioon", { releaseType: "album" }, "Ryuichi Sakamoto");

			const result = mergeFor(sakamoto, [typed], [single], { projectIndex: nodeIndex(M1) });

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: typed.slug, reason: "type" }]);
		});

		it("never poses the node's mbid from a release group the artist does not head", () => {
			const collaboration = release("Vrioon", {
				mbid: M1,
				firstReleaseDate: "2002-01-01",
				artistCredits: [
					{ mbid: ARTIST_MBID, name: "Ryuichi Sakamoto" },
					{ mbid: mbidOf(951), name: "Guest 1" },
					{ mbid: mbidOf(952), name: "Guest 2" },
				],
			});

			const result = mergeFor(sakamoto, [vrioon], [collaboration], { projectIndex: nodeIndex(M1) });

			expect(result.posed).toEqual([]);
			expect(result.ambiguous).toEqual([{ slug: vrioon.slug, reason: "credit" }]);
		});

		it("does not apply to a node without mbid, nor to an entry that states a year", () => {
			const remaster = release("Vrioon", { firstReleaseDate: "2022-04-08" });

			const noNode = mergeFor(sakamoto, [vrioon], [remaster], { projectIndex: nodeIndex(undefined) });
			expect(noNode.posed.map((p) => p.mbid)).toEqual([remaster.mbid]);

			const dated = entry("Vrioon", { year: "2022" }, "Ryuichi Sakamoto");
			const withYear = mergeFor(sakamoto, [dated], [remaster], { projectIndex: nodeIndex(M1) });
			expect(withYear.posed.map((p) => p.mbid)).toEqual([remaster.mbid]);

			const datedAndTyped = entry("Vrioon", { year: "2022", releaseType: "album" }, "Ryuichi Sakamoto");
			const both = mergeFor(sakamoto, [datedAndTyped], [remaster], { projectIndex: nodeIndex(M1) });
			expect(both.posed.map((p) => p.mbid)).toEqual([remaster.mbid]);
		});
	});

	it("gives the same result whatever the order of the existing entries", () => {
		const held = zappaEntry("Joe's Garage");
		const heldEp = zappaEntry("Xpander EP");
		const conflict = zappaEntry("Vrioon");
		const matching = zappaEntry("Overnite Sensation");
		const imagine = zappaEntry("Imagine");
		const recent = zappaEntry("Fresh");
		const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const garage = release("Joe's Garage", { primaryType: "Single", firstReleaseDate: "1979-09-07" });
		const xpander = release("Xpander", { primaryType: "EP", firstReleaseDate: "1996-01-01" });
		const vrioon = release("Vrioon", { mbid: M2, firstReleaseDate: "2022-04-08" });
		const overnite = release("Overnite Sensation", { mbid: M1, firstReleaseDate: "1973-09-07" });
		const imagineAlbum = release("Imagine", { firstReleaseDate: "1971-09-09", ratingVotes: 17 });
		const fresh = release("Fresh", { firstReleaseDate: "2025-03-01" });
		const allCredited = [...votedAlbums(10), garage, xpander, vrioon, overnite, imagineAlbum, fresh];
		const projectIndex: MergeInput["projectIndex"] = {
			byMbid: new Map(),
			mbidBySlug: new Map([
				[conflict.slug, M1],
				[matching.slug, M1],
			]),
			resolveSlug: (slug) => slug,
		};
		const entries = [held, heldEp, conflict, matching, imagine, recent];

		const summarize = (existing: EdgeRef[]) => {
			const result = mergeFor(zappa, existing, allCredited, { projectIndex });
			return JSON.stringify({
				edges: result.edges
					.map((e) => [e.slug, e.mbid ?? null, e.year ?? null, e.releaseType ?? null])
					.sort(),
				posed: result.posed.map((p) => [p.slug, p.mbid, [...p.filled].sort()]).sort(),
				ambiguous: result.ambiguous.map((a) => [a.slug, a.reason]).sort(),
				added: result.added.map((a) => [a.slug, a.mbid, a.nearDuplicateOf ?? null]).sort(),
			});
		};
		const permutations = (items: EdgeRef[]): EdgeRef[][] =>
			items.length <= 1
				? [items]
				: items.flatMap((item, i) =>
						permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
					);

		const reference = JSON.parse(summarize(entries));
		// Sanity: a real mix of poses and of both holds, not an empty comparison.
		expect(reference.posed.map((p: string[]) => p[0]).sort()).toEqual(
			[imagine.slug, matching.slug, recent.slug].sort(),
		);
		expect(reference.ambiguous.map((a: string[]) => a[1]).sort()).toEqual([
			"node-conflict",
			"unrated-pose",
			"unrated-pose",
		]);
		for (const order of permutations(entries)) {
			expect(JSON.parse(summarize(order))).toEqual(reference);
		}
	});

	// TRA-649 (2026-10-20): replayed on MusicBrainz, 20 of the 33 entries v5 held back were the right release group.
	// Real answers are in test/discography-policy-v6.test.ts; these cases pin the two rules on their edges.
	describe("what v6 poses that v5 held (TRA-649)", () => {
		const unvoted = (title: string, overrides: Partial<ReleaseGroupCandidate> = {}): ReleaseGroupCandidate =>
			release(title, { firstReleaseDate: "2010-11-22", ratingVotes: 0, ...overrides });
		const guest = (n: number) => ({ mbid: mbidOf(960 + n), name: `Guest ${n}` });
		const HEAD = { mbid: ARTIST_MBID, name: "Frank Zappa" };

		describe("an unvoted release group, an artist with 10 voted release groups", () => {
			it("poses a plain album, which v5 held (an unvoted 'Lunatic' next to the voted albums)", () => {
				const album = unvoted("Lunatic");
				const existing = [zappaEntry("Lunatic")];

				const result = mergeFor(zappa, existing, [...votedAlbums(10), album]);

				expect(result.ambiguous).toEqual([]);
				expect(result.posed).toEqual([
					{ slug: existing[0]?.slug, mbid: album.mbid, filled: ["year", "releaseType"] },
				]);
			});

			it("poses an album with a Live or Soundtrack secondary type: 'The London Chuck Berry Sessions'", () => {
				for (const secondaryTypes of [["Live"], ["Soundtrack"], ["Live", "Soundtrack"]]) {
					const album = unvoted("Sessions", { secondaryTypes });
					const result = mergeFor(zappa, [zappaEntry("Sessions")], [...votedAlbums(10), album]);
					expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
				}
			});

			it.each([
				["a Compilation", { secondaryTypes: ["Compilation"] }, "Free Jazz"],
				["a Demo", { secondaryTypes: ["Demo"] }, "Free Jazz"],
				["a Remix", { secondaryTypes: ["Remix"] }, "Free Jazz"],
				["a single", { primaryType: "Single" }, "Free Jazz"],
				["an EP", { primaryType: "EP" }, "Free Jazz"],
				["an album titled like a best-of", {}, "His Greatest Hits"],
				["an album titled like a remix album", {}, "The Remix Album"],
			] satisfies [string, Partial<ReleaseGroupCandidate>, string][])(
				"holds %s, `unrated-pose`",
				(_label, overrides, title) => {
					const found = unvoted(title, overrides);
					const existing = [zappaEntry(title)];

					const result = mergeFor(zappa, existing, [...votedAlbums(10), found]);

					expect(result.posed).toEqual([]);
					expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "unrated-pose" }]);
				},
			);

			it("holds an unvoted album when the votes are on a longer title of the artist: 'Joe's Garage: Act I'", () => {
				const exact = unvoted("Joe's Garage", { firstReleaseDate: "1987-06-01" });
				const act = unvoted("Joe's Garage: Act I", { firstReleaseDate: "1979-09-17", ratingVotes: 6 });
				const existing = [zappaEntry("Joe's Garage")];

				const result = mergeFor(zappa, existing, [...votedAlbums(10), exact, act]);

				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "unrated-pose" }]);
			});

			it("does not read the artist's name as a longer title: 'Frank' against the voted 'Frank Zappa Is on Top'", () => {
				const album = unvoted("Frank");
				const onTop = unvoted("Frank Zappa Is on Top", { ratingVotes: 3 });
				const result = mergeFor(zappa, [zappaEntry("Frank")], [...votedAlbums(10), album, onTop]);
				expect(result.posed.map((p) => p.mbid)).toEqual([album.mbid]);
			});

			it("holds an unvoted album when another release group of the title has a vote", () => {
				const album = unvoted("Joe's Garage", { firstReleaseDate: "1979-09-07" });
				const single = unvoted("Joe's Garage", {
					primaryType: "Single",
					firstReleaseDate: "1979-09-07",
					ratingVotes: 4,
				});
				const existing = [zappaEntry("Joe's Garage")];

				const result = mergeFor(zappa, existing, [...votedAlbums(10), album, single]);

				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "unrated-pose" }]);
			});

			it("does not pose an album that fails the credit rule, voted or not (the plain album is no credit pass)", () => {
				const notFirst = unvoted("Lunatic", { artistCredits: [guest(1), HEAD] });
				const result = mergeFor(zappa, [zappaEntry("Lunatic")], [...votedAlbums(10), notFirst]);
				expect(result.posed).toEqual([]);
				expect(result.ambiguous.map((a) => a.reason)).toEqual(["credit"]);
			});
		});

		describe("a release group the artist heads with more than two credits", () => {
			const credits = [HEAD, guest(1), guest(2)];
			const existing = [zappaEntry("Dil Padosi Hai")];

			it("is posed when it has a vote, one is enough", () => {
				const found = release("Dil Padosi Hai", { artistCredits: credits, ratingVotes: 1 });
				const result = mergeFor(zappa, existing, [found]);
				expect(result.ambiguous).toEqual([]);
				expect(result.posed.map((p) => p.mbid)).toEqual([found.mbid]);
			});

			it("is held without a vote, the entry stating nothing: `credit`", () => {
				const found = release("Dil Padosi Hai", { artistCredits: credits });
				const result = mergeFor(zappa, existing, [found]);
				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "credit" }]);
			});

			it("is posed when the entry states the very year and type of the release group", () => {
				const found = release("Annihilation", {
					primaryType: "Single",
					firstReleaseDate: "2025-10-31",
					artistCredits: credits,
				});
				const stated = zappaEntry("Annihilation", { year: "2025", releaseType: "single" });
				const result = mergeFor(zappa, [stated], [found]);
				expect(result.ambiguous).toEqual([]);
				expect(result.posed.map((p) => p.mbid)).toEqual([found.mbid]);
			});

			it.each([
				["a year alone", { year: "2025" }],
				["a type alone", { releaseType: "single" as const }],
				[
					"another year (within the drift decidePose allows)",
					{ year: "2024", releaseType: "single" as const },
				],
			])("is held when the entry states %s", (_label, extra) => {
				const found = release("Annihilation", {
					primaryType: "Single",
					firstReleaseDate: "2025-10-31",
					artistCredits: credits,
				});
				const stated = zappaEntry("Annihilation", extra);
				const result = mergeFor(zappa, [stated], [found]);
				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: stated.slug, reason: "credit" }]);
			});

			it("is never posed when the artist does not head it, whatever the votes and the entry say", () => {
				const found = release("Dil Padosi Hai", {
					primaryType: "Single",
					firstReleaseDate: "2025-10-31",
					artistCredits: [guest(1), HEAD, guest(2)],
					ratingVotes: 9,
				});
				const stated = zappaEntry("Dil Padosi Hai", { year: "2025", releaseType: "single" });
				const result = mergeFor(zappa, [stated], [found]);
				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: stated.slug, reason: "credit" }]);
			});

			it("is never posed when Various Artists is one of the credits, even voted", () => {
				const found = release("Dil Padosi Hai", {
					artistCredits: [HEAD, { mbid: VARIOUS_ARTISTS_MBID, name: "Various Artists" }],
					ratingVotes: 9,
				});
				const result = mergeFor(zappa, existing, [found]);
				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "credit" }]);
			});

			// TRA-653. MusicBrainz separates the composer from the performers of a classical recording with ";"
			// ("Duke Ellington; Buffalo Philharmonic, JoAnn Falletta"): a third party's recording of the artist's work,
			// whatever its votes. The legitimate three-credit releases (Lennon, Getz, Asha Bhosle, Elstak) have none.
			describe("whose credits separate a composer from the performers with ';' (TRA-653)", () => {
				const classical = [{ ...HEAD, joinphrase: "; " }, { ...guest(1), joinphrase: ", " }, guest(2)];

				it.each([
					["a vote", { ratingVotes: 1 }],
					["many votes", { ratingVotes: 40 }],
					["no vote", {}],
				])("is held with %s", (_label, extra) => {
					const found = release("Dil Padosi Hai", { artistCredits: classical, ...extra });
					const result = mergeFor(zappa, existing, [found]);
					expect(result.posed).toEqual([]);
					expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "credit" }]);
				});

				it("is held even when the entry states the very year and type of the release group", () => {
					const found = release("Annihilation", {
						primaryType: "Single",
						firstReleaseDate: "2025-10-31",
						artistCredits: classical,
					});
					const stated = zappaEntry("Annihilation", { year: "2025", releaseType: "single" });
					const result = mergeFor(zappa, [stated], [found]);
					expect(result.posed).toEqual([]);
					expect(result.ambiguous).toEqual([{ slug: stated.slug, reason: "credit" }]);
				});

				it("is found whichever credit carries the ';'", () => {
					const found = release("Dil Padosi Hai", {
						artistCredits: [{ ...HEAD, joinphrase: ", " }, { ...guest(1), joinphrase: "; " }, guest(2)],
						ratingVotes: 1,
					});
					const result = mergeFor(zappa, existing, [found]);
					expect(result.posed).toEqual([]);
					expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "credit" }]);
				});

				it("ignores a ';' after the last credit: it separates nothing", () => {
					const found = release("Dil Padosi Hai", {
						artistCredits: [
							{ ...HEAD, joinphrase: ", " },
							{ ...guest(1), joinphrase: " & " },
							{ ...guest(2), joinphrase: ";" },
						],
						ratingVotes: 1,
					});
					const result = mergeFor(zappa, existing, [found]);
					expect(result.ambiguous).toEqual([]);
					expect(result.posed.map((p) => p.mbid)).toEqual([found.mbid]);
				});

				it("does not hold a voted release group whose joinphrases are the usual ones", () => {
					const found = release("Dil Padosi Hai", {
						artistCredits: [{ ...HEAD, joinphrase: ", " }, { ...guest(1), joinphrase: " & " }, guest(2)],
						ratingVotes: 1,
					});
					const result = mergeFor(zappa, existing, [found]);
					expect(result.ambiguous).toEqual([]);
					expect(result.posed.map((p) => p.mbid)).toEqual([found.mbid]);
				});

				// v7 left it posed (TRA-653); the review of that PR found the same recording, credited with two names,
				// passing the credit rule, and TRA-654 closes it for the selection and the pose alike.
				it("holds a release group of two credits as well: 'Composer; Orchestra' (TRA-654)", () => {
					const found = release("Dil Padosi Hai", {
						artistCredits: [{ ...HEAD, joinphrase: "; " }, guest(1)],
						ratingVotes: 4,
					});
					const result = mergeFor(zappa, existing, [found]);
					expect(result.posed).toEqual([]);
					expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "credit" }]);
				});
			});

			it("is held with four credits or more, even voted: only one credit past the rule is let through", () => {
				const found = release("Dil Padosi Hai", { artistCredits: [...credits, guest(3)], ratingVotes: 9 });
				const result = mergeFor(zappa, existing, [found]);
				expect(result.posed).toEqual([]);
				expect(result.ambiguous).toEqual([{ slug: existing[0]?.slug, reason: "credit" }]);
			});

			it("does not change what is added: a voted release group with three credits is still not a candidate", () => {
				const found = release("Dil Padosi Hai", { artistCredits: credits, ratingVotes: 9 });
				const { kept } = selectReleases([found], zappa);
				expect(kept).toEqual([]);
			});
		});
	});
});
