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
