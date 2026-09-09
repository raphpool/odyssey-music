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
