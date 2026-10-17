import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../../src/cache.js";
import type { GenreRedirects } from "../../src/genre-registry.js";
import { reciprocates, reciprocity } from "../../src/images/reciprocity.js";
import type { Slug } from "../../src/types.js";
import { artistNode, edge, genreNode, labelNode, projectNode, trackNode } from "./helpers.js";

// TRA-597: a genre also accepts a work carrying its direct parent or a direct subgenre. One level, from
// the genre node's own parent_genres / subgenres edges. Label and artist stay strict (TRA-591).

let dir: string;
let cache: NodeCache;
const none: GenreRedirects = new Map();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-reciprocity-"));
	cache = new NodeCache(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const workTagged = (...genres: string[]) =>
	projectNode("album", "Album", { genres: genres.map((g) => edge("genre", g, g)) });

// jungle <- drum-and-bass <- (parent of D&B) breakbeat ; jungle -> ragga-jungle ; jungle ~ related: reggae.
const jungle = genreNode("jungle", "Jungle", {
	parent_genres: [edge("genre", "drum-and-bass", "Drum and bass")],
	subgenres: [edge("genre", "ragga-jungle", "Ragga jungle")],
	related_genres: [edge("genre", "reggae", "Reggae")],
});

describe("genre subject (TRA-597)", () => {
	it("accepts a work carrying the genre itself (unchanged)", async () => {
		expect(await reciprocates(jungle, workTagged("jungle"), cache, none)).toBe(true);
	});

	it("accepts a work carrying the direct parent: jungle with a drum-and-bass album", async () => {
		expect(await reciprocates(jungle, workTagged("drum-and-bass"), cache, none)).toBe(true);
	});

	it("accepts a work carrying a direct subgenre", async () => {
		expect(await reciprocates(jungle, workTagged("ragga-jungle"), cache, none)).toBe(true);
	});

	it("refuses a work carrying only a related genre", async () => {
		expect(await reciprocates(jungle, workTagged("reggae"), cache, none)).toBe(false);
	});

	it("refuses a grandparent and a grandchild: one level only, even when the parent is cached", async () => {
		await cache.write(
			genreNode("drum-and-bass", "Drum and bass", {
				parent_genres: [edge("genre", "breakbeat", "Breakbeat")],
			}),
		);
		await cache.write(
			genreNode("ragga-jungle", "Ragga jungle", { subgenres: [edge("genre", "dub-jungle", "Dub jungle")] }),
		);
		expect(await reciprocates(jungle, workTagged("breakbeat"), cache, none)).toBe(false);
		expect(await reciprocates(jungle, workTagged("dub-jungle"), cache, none)).toBe(false);
	});

	it("refuses an unrelated genre and a work with no genre", async () => {
		expect(await reciprocates(jungle, workTagged("house"), cache, none)).toBe(false);
		expect(await reciprocates(jungle, workTagged(), cache, none)).toBe(false);
	});

	it("does not accept a sibling that merely shares the parent", async () => {
		// The relation is read from the subject only: a work tagged with another child of the parent is a sibling.
		expect(await reciprocates(jungle, workTagged("darkstep"), cache, none)).toBe(false);
	});

	it("applies the redirect table to the work's genre and to the parent / subgenre edges", async () => {
		const redirects: GenreRedirects = new Map<Slug, Slug>([
			["genre:dnb" as Slug, "genre:drum-and-bass" as Slug],
			["genre:ragga" as Slug, "genre:ragga-jungle" as Slug],
		]);
		expect(await reciprocates(jungle, workTagged("dnb"), cache, redirects)).toBe(true);
		const viaOldEdge = genreNode("jungle", "Jungle", { parent_genres: [edge("genre", "dnb", "DnB")] });
		expect(await reciprocates(viaOldEdge, workTagged("drum-and-bass"), cache, redirects)).toBe(true);
		const viaOldSub = genreNode("jungle", "Jungle", { subgenres: [edge("genre", "ragga", "Ragga")] });
		expect(await reciprocates(viaOldSub, workTagged("ragga-jungle"), cache, redirects)).toBe(true);
	});

	it("accepts a track as well as a project", async () => {
		const track = trackNode("t", "T", { genres: [edge("genre", "drum-and-bass", "Drum and bass")] });
		expect(await reciprocates(jungle, track, cache, none)).toBe(true);
	});
});

describe("reciprocity kind (TRA-597)", () => {
	it("tells the genre itself (exact) from a direct parent or subgenre (neighbour)", async () => {
		expect(await reciprocity(jungle, workTagged("jungle"), cache, none)).toBe("exact");
		expect(await reciprocity(jungle, workTagged("drum-and-bass"), cache, none)).toBe("neighbour");
		expect(await reciprocity(jungle, workTagged("ragga-jungle"), cache, none)).toBe("neighbour");
		expect(await reciprocity(jungle, workTagged("reggae"), cache, none)).toBeNull();
	});

	it("is exact as soon as the work also carries the genre itself, whatever the tag order", async () => {
		expect(await reciprocity(jungle, workTagged("drum-and-bass", "jungle"), cache, none)).toBe("exact");
	});

	it("is always exact for a label or an artist that matches", async () => {
		const label = labelNode("mille-plateaux", "Mille Plateaux");
		const work = projectNode("w", "W", { label: edge("label", "mille-plateaux", "Mille Plateaux") });
		expect(await reciprocity(label, work, cache, none)).toBe("exact");
	});
});

describe("label and artist stay strict (TRA-591 non-regression)", () => {
	it("a genre-neighbour does not open anything for a label: Mille Plateaux / Electric Ladyland", async () => {
		const mp = labelNode("mille-plateaux", "Mille Plateaux");
		const ladyland = projectNode("electric-ladyland", "Electric Ladyland", {
			label: edge("label", "reprise-records", "Reprise Records"),
			artists: [edge("artist", "the-jimi-hendrix-experience", "The Jimi Hendrix Experience")],
		});
		expect(await reciprocates(mp, ladyland, cache, none)).toBe(false);
		expect(
			await reciprocates(
				mp,
				{ ...ladyland, label: edge("label", "mille-plateaux", "Mille Plateaux") },
				cache,
				none,
			),
		).toBe(true);
	});

	it("an artist matches on credit only, whatever genres the work carries", async () => {
		const member = artistNode("member", "Member");
		const album = projectNode("band-album", "Band Album", {
			artists: [edge("artist", "the-band", "The Band")],
			genres: [edge("genre", "jungle", "Jungle")],
		});
		expect(await reciprocates(member, album, cache, none)).toBe(false);
		expect(
			await reciprocates(member, { ...album, artists: [edge("artist", "member", "Member")] }, cache, none),
		).toBe(true);
	});
});
