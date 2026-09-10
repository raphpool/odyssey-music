import { describe, expect, it, vi } from "vitest";
import { enrichFromMusicBrainz, normalizeEdge } from "../src/pipeline.js";

// TRA-18: mock only the external MB boundary; genre-identity.ts is ours, so it runs for real
// against the committed catalog — "techno" resolves there, "not-a-real-genre-xyz" doesn't.
vi.mock("../src/musicbrainz.js", () => ({
	findArtistMbidByName: vi.fn(async () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
	fetchArtistDiscographyMb: vi.fn(async () => []),
	fetchEntityGenresMb: vi.fn(async () => [{ name: "techno" }, { name: "not-a-real-genre-xyz" }]),
}));

describe("normalizeEdge — qid propagation (TRA-17)", () => {
	it("keeps a valid qid", () => {
		const out = normalizeEdge({ type: "genre", name: "Techno", qid: "Q170611" });
		expect(out).not.toBeNull();
		expect(out?.qid).toBe("Q170611");
	});

	it("discards a malformed qid without dropping the edge", () => {
		const out = normalizeEdge({ type: "genre", name: "Techno", qid: "170611" });
		expect(out).not.toBeNull();
		expect(out?.name).toBe("Techno");
		expect(out?.qid).toBeUndefined();
	});
});

describe("enrichFromMusicBrainz — MB genre producers stamp qid (TRA-18)", () => {
	it("stamps qid on a resolvable genre, omits it on an unresolvable one, keeps both edges", async () => {
		const node: Record<string, unknown> = {};
		await enrichFromMusicBrainz(node, { type: "artist", name: "Test Artist" }, () => undefined);
		const genres = node.genres as Array<{ name: string; slug: string; qid?: string }>;
		expect(genres).toHaveLength(2);
		expect(genres[0]?.qid).toBe("Q170611");
		expect(genres[0]?.name).toBe("Techno");
		expect(genres[1]?.qid).toBeUndefined();
		expect(genres[1]?.name).toBeTruthy();
		expect(genres[1]?.slug).toBeTruthy();
	});
});

describe("enrichFromMusicBrainz — genre node qid + parent_genres backfill from catalog (TRA-18)", () => {
	it("stamps the node's own qid even when parent_genres is already non-empty", async () => {
		const node: Record<string, unknown> = {
			slug: "genre:acid-techno",
			parent_genres: [{ type: "genre", name: "Placeholder", slug: "genre:placeholder" }],
		};
		await enrichFromMusicBrainz(node, { type: "genre", name: "Acid Techno" }, () => undefined);
		expect(node.qid).toBe("Q341395");
		// Backfill only fires when parent_genres is empty; the array is left untouched.
		expect(node.parent_genres).toEqual([{ type: "genre", name: "Placeholder", slug: "genre:placeholder" }]);
	});

	it("backfills parent_genres from the catalog, each parent edge carrying its own qid", async () => {
		const node: Record<string, unknown> = { slug: "genre:acid-techno", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Acid Techno" }, () => undefined);
		expect(node.qid).toBe("Q341395");
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		expect(bySlug.get("genre:acid")?.qid).toBe("Q106528337");
		expect(bySlug.get("genre:techno")?.qid).toBe("Q170611");
	});
});

describe("enrichFromMusicBrainz — genre node stamped via the resolver, not a slug-exact lookup (TRA-26)", () => {
	it("resolves genre:electronic via the resolver's 'music' suffix heuristic (catalog only has electronic-music)", async () => {
		const node: Record<string, unknown> = { slug: "genre:electronic", name: "Electronic" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Electronic" }, () => undefined);
		expect(node.qid).toBe("Q9778");
		// The catalog's "electronic-music" entry has no parents, so the backfill guard never
		// fires; parent_genres is simply left as-is (contains all zero of the entry's parents).
		expect(node.parent_genres).toBeUndefined();
	});

	it("resolves a node whose slug already matches the catalog slug, same as before the resolver (genre:techno)", async () => {
		const node: Record<string, unknown> = { slug: "genre:techno", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Techno" }, () => undefined);
		expect(node.qid).toBe("Q170611");
	});

	it("leaves an unresolvable genre name without qid or parent_genres (architecture decision 5)", async () => {
		const node: Record<string, unknown> = { slug: "genre:braindance", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Braindance" }, () => undefined);
		expect(node.qid).toBeUndefined();
		expect(node.parent_genres).toEqual([]);
	});

	it("resolves genre:idm via the hand-curated alias table", async () => {
		const node: Record<string, unknown> = { slug: "genre:idm", name: "IDM" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "IDM" }, () => undefined);
		expect(node.qid).toBe("Q660984");
	});

	it("resolves on the node's own materialized name (obj.name), not the original input.name", async () => {
		// canonicalizeDraft runs before enrichFromMusicBrainz and can let the LLM draft's name
		// override the requested one, so by the time we get here obj.name (not input.name) is
		// the node's real, persisted name. input.name is deliberately unresolvable here to prove
		// obj.name — not the request — drives resolution.
		const node: Record<string, unknown> = { slug: "genre:idm", name: "IDM" };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Braindance" }, () => undefined);
		expect(node.qid).toBe("Q660984");
	});
});

describe("enrichFromMusicBrainz — parent_genres backfill expands the 'rb' token, scoped fix (TRA-34)", () => {
	it("derives a 'contemporary-rb' parent as 'Contemporary R&B' / genre:contemporary-r-and-b, not the mangled 'Contemporary Rb' / genre:contemporary-rb", async () => {
		// "alternative-rb" is a real catalog entry whose only parent is "contemporary-rb".
		const node: Record<string, unknown> = { slug: "genre:alternative-rb", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Alternative R&B" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		expect(bySlug.has("genre:contemporary-rb")).toBe(false);
		const parent = bySlug.get("genre:contemporary-r-and-b");
		expect(parent?.name).toBe("Contemporary R&B");
		expect(parent?.qid).toBe("Q850412");
	});

	it("derives an 'early-rb' parent as 'Early R&B' / genre:early-r-and-b", async () => {
		// "bluebeat"'s catalog parents include "early-rb".
		const node: Record<string, unknown> = { slug: "genre:bluebeat", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Bluebeat" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:early-r-and-b");
		expect(parent?.name).toBe("Early R&B");
		expect(parent?.qid).toBe("Q114907417");
	});

	it("derives a 'french-contemporary-rb' parent as 'French Contemporary R&B' / genre:french-contemporary-r-and-b", async () => {
		// "rainb"'s catalog parents include "french-contemporary-rb".
		const node: Record<string, unknown> = { slug: "genre:rainb", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Rai'n'B" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:french-contemporary-r-and-b");
		expect(parent?.name).toBe("French Contemporary R&B");
		expect(parent?.qid).toBe("Q113509746");
	});

	it("leaves a 'hip-hop' parent unchanged ('Hip Hop' / genre:hip-hop) — the fix is scoped to the 'rb' token only", async () => {
		// "abstract-hip-hop"'s only catalog parent is "hip-hop". Its catalog name ("hip-hop")
		// has an internal hyphen the slug-based derivation still discards deliberately: the
		// name-based approach that would have preserved it was reverted (see the comment on the
		// backfill in src/pipeline.ts) because it moved 143 unrelated slugs.
		const node: Record<string, unknown> = { slug: "genre:abstract-hip-hop", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Abstract Hip-Hop" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:hip-hop");
		expect(parent?.name).toBe("Hip Hop");
		expect(parent?.qid).toBe("Q11401");
	});

	it("leaves a non-R&B parent ('electronic-music') unchanged", async () => {
		// "acid"'s only catalog parent is "electronic-music"; neither its slug nor its catalog
		// name contain an "rb" token, so the fix must not move this.
		const node: Record<string, unknown> = { slug: "genre:acid", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Acid" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		const parent = bySlug.get("genre:electronic-music");
		expect(parent?.name).toBe("Electronic Music");
		expect(parent?.qid).toBe("Q9778");
	});

	it("leaves a 'bass-music-edm' parent unchanged — no collision with the distinct 'bass-music' entry", async () => {
		// "bass-house"'s catalog parents include "bass-music-edm", a genuinely distinct genre
		// (Q114880130) from "bass-music" (Q96740854). The reverted name-based approach folded
		// both onto genre:bass-music because makeSlug strips the "(EDM)" parenthetical; the
		// slug-based derivation (unaffected by the "rb" token fix) keeps them apart.
		const node: Record<string, unknown> = { slug: "genre:bass-house", parent_genres: [] };
		await enrichFromMusicBrainz(node, { type: "genre", name: "Bass House" }, () => undefined);
		const parents = node.parent_genres as Array<{ name: string; slug: string; qid?: string }>;
		const bySlug = new Map(parents.map((p) => [p.slug, p]));
		expect(bySlug.has("genre:bass-music")).toBe(false);
		const parent = bySlug.get("genre:bass-music-edm");
		expect(parent?.name).toBe("Bass Music Edm");
		expect(parent?.qid).toBe("Q114880130");
	});
});
