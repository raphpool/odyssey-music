import { describe, expect, it, vi } from "vitest";
import { lookupVerifiedAlbumArt } from "../src/itunes.js";
import { jsonResponse, routedFetch } from "./images/helpers.js";

const art = (id: string): string =>
	`https://is1-ssl.mzstatic.com/image/thumb/Music/${id}/source/100x100bb.jpg`;
const art600 = (id: string): string =>
	`https://is1-ssl.mzstatic.com/image/thumb/Music/${id}/source/600x600bb.jpg`;

function itunes(results: unknown[]) {
	return routedFetch([
		["itunes.apple.com/search", () => jsonResponse({ resultCount: results.length, results })],
	]);
}

describe("lookupVerifiedAlbumArt", () => {
	it("asks for 5 results, as albums", async () => {
		const f = itunes([]);
		await lookupVerifiedAlbumArt("The Message", "Grandmaster Flash", f);
		const url = new URL(f.calls[0] ?? "");
		expect(url.searchParams.get("limit")).toBe("5");
		expect(url.searchParams.get("entity")).toBe("album");
		expect(url.searchParams.get("term")).toBe("The Message Grandmaster Flash");
	});

	it("does not give the first result to a different artist (the Earth, Wind & Fire compilation)", async () => {
		const f = itunes([
			{ collectionName: "The Message", artistName: "Earth, Wind & Fire", artworkUrl100: art("ewf") },
			{ collectionName: "The Message (Deluxe)", artistName: "Nas", artworkUrl100: art("nas") },
		]);
		await expect(lookupVerifiedAlbumArt("The Message", "Grandmaster Flash", f)).resolves.toBeNull();
	});

	it("does not give the first result to a different title", async () => {
		const f = itunes([
			{ collectionName: "Totally Other Record", artistName: "Grandmaster Flash", artworkUrl100: art("x") },
		]);
		await expect(lookupVerifiedAlbumArt("The Message", "Grandmaster Flash", f)).resolves.toBeNull();
	});

	it("skips wrong results and takes the verified one, at 600x600", async () => {
		const f = itunes([
			{ collectionName: "The Message", artistName: "Earth, Wind & Fire", artworkUrl100: art("wrong") },
			{
				collectionName: "The Message",
				artistName: "Grandmaster Flash & The Furious Five",
				artworkUrl100: art("right"),
			},
		]);
		await expect(lookupVerifiedAlbumArt("The Message", "Grandmaster Flash", f)).resolves.toBe(
			art600("right"),
		);
	});

	it("prefers the better-scoring verified result", async () => {
		const f = itunes([
			{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: art("a") },
			{ collectionName: "New Forms", artistName: "Roni Size Reprazent", artworkUrl100: art("b") },
		]);
		await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size Reprazent", f)).resolves.toBe(art600("b"));
	});

	// TRA-589: the Clicks & Cuts backfill row resolved to the cover of a different release.
	it("does not retain a longer title that only adds a volume number (Clicks & Cuts -> Clicks & Cuts 3)", async () => {
		const f = itunes([
			{ collectionName: "Clicks & Cuts 3", artistName: "Mille Plateaux", artworkUrl100: art("cc3") },
		]);
		await expect(lookupVerifiedAlbumArt("Clicks & Cuts", "Mille Plateaux", f)).resolves.toBeNull();
	});

	it.each(["Album 2", "Album Vol. 2", "Album (Vol. 2)", "Album II", "Album Part 2", "Album Live"])(
		"does not retain %s for Album (numbers and unknown suffixes are other releases)",
		async (other) => {
			const f = itunes([{ collectionName: other, artistName: "Some Artist", artworkUrl100: art("o") }]);
			await expect(lookupVerifiedAlbumArt("Album", "Some Artist", f)).resolves.toBeNull();
		},
	);

	it("does not retain a shorter title either (Clicks & Cuts 3 asked, Clicks & Cuts returned)", async () => {
		const f = itunes([
			{ collectionName: "Clicks & Cuts", artistName: "Mille Plateaux", artworkUrl100: art("cc1") },
		]);
		await expect(lookupVerifiedAlbumArt("Clicks & Cuts 3", "Mille Plateaux", f)).resolves.toBeNull();
	});

	it("still retains an exact title, across case, accents, punctuation and & / and", async () => {
		const exact = itunes([
			{ collectionName: "Clicks & Cuts", artistName: "Mille Plateaux", artworkUrl100: art("cc1") },
		]);
		await expect(lookupVerifiedAlbumArt("Clicks & Cuts", "Mille Plateaux", exact)).resolves.toBe(
			art600("cc1"),
		);
		const folded = itunes([
			{ collectionName: "CLICKS AND CUTS", artistName: "Mille Plateaux", artworkUrl100: art("cc1") },
		]);
		await expect(lookupVerifiedAlbumArt("Clicks & Cuts", "Mille Plateaux", folded)).resolves.toBe(
			art600("cc1"),
		);
		const accents = itunes([
			{ collectionName: "Dé\u0301jà Vu", artistName: "Some Artist", artworkUrl100: art("dv") },
		]);
		await expect(lookupVerifiedAlbumArt("Déjà Vu", "Some Artist", accents)).resolves.toBe(art600("dv"));
	});

	// Documented rule: trailing edition suffixes from a whitelist are ignored, nothing else is.
	it.each([
		"Album (Deluxe Edition)",
		"Album [Deluxe Edition]",
		"Album - Remastered",
		"Album (Expanded Edition)",
		"Album (Deluxe) [Remastered]",
	])("retains %s for Album (known edition suffix)", async (edition) => {
		const f = itunes([{ collectionName: edition, artistName: "Some Artist", artworkUrl100: art("e") }]);
		await expect(lookupVerifiedAlbumArt("Album", "Some Artist", f)).resolves.toBe(art600("e"));
	});

	it("retains the plain album when the asked title carries the edition suffix", async () => {
		const f = itunes([{ collectionName: "Album", artistName: "Some Artist", artworkUrl100: art("e") }]);
		await expect(lookupVerifiedAlbumArt("Album (Deluxe Edition)", "Some Artist", f)).resolves.toBe(
			art600("e"),
		);
	});

	it("never treats a numbered edition as an edition suffix (year remaster, anniversary)", async () => {
		const f = itunes([
			{ collectionName: "Album (2009 Remaster)", artistName: "Some Artist", artworkUrl100: art("a") },
			{
				collectionName: "Album (20th Anniversary Edition)",
				artistName: "Some Artist",
				artworkUrl100: art("b"),
			},
		]);
		await expect(lookupVerifiedAlbumArt("Album", "Some Artist", f)).resolves.toBeNull();
	});

	it.each([
		"Various Artists",
		"Various",
		"various artist",
		"VA",
		"V.A.",
		"V/A",
		"Various Artists & Roni Size",
	])("never retains a result credited to %s", async (credit) => {
		const f = itunes([{ collectionName: "New Forms", artistName: credit, artworkUrl100: art("va") }]);
		await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size", f)).resolves.toBeNull();
	});

	it("skips the Various Artists result and takes the real artist's", async () => {
		const f = itunes([
			{ collectionName: "New Forms", artistName: "Various Artists", artworkUrl100: art("va") },
			{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: art("ok") },
		]);
		await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size", f)).resolves.toBe(art600("ok"));
	});

	it("does not even ask when the requested artist is Various Artists", async () => {
		const f = itunes([
			{ collectionName: "New Forms", artistName: "Various Artists", artworkUrl100: art("va") },
		]);
		for (const asked of ["Various Artists", "Various", "VA", "V.A."]) {
			await expect(lookupVerifiedAlbumArt("New Forms", asked, f)).resolves.toBeNull();
		}
		expect(f.calls).toEqual([]);
	});

	it("refuses an artwork URL off *.mzstatic.com", async () => {
		const f = itunes([
			{
				collectionName: "New Forms",
				artistName: "Roni Size",
				artworkUrl100: "https://evil.example/Music/x/100x100bb.jpg",
			},
			{
				collectionName: "New Forms",
				artistName: "Roni Size",
				artworkUrl100: "https://mzstatic.com/Music/x/100x100bb.jpg",
			},
			{
				collectionName: "New Forms",
				artistName: "Roni Size",
				artworkUrl100: "http://is1-ssl.mzstatic.com/Music/x/100x100bb.jpg",
			},
		]);
		await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size", f)).resolves.toBeNull();
	});

	it("returns null when the artwork is not a 100x100bb thumbnail we can upscale", async () => {
		const f = itunes([
			{
				collectionName: "New Forms",
				artistName: "Roni Size",
				artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/source/cover.jpg",
			},
		]);
		await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size", f)).resolves.toBeNull();
	});

	it("survives malformed results and malformed responses", async () => {
		const mixed = itunes([
			null,
			"text",
			{ collectionName: 12, artistName: "Roni Size", artworkUrl100: art("n") },
			{ collectionName: "New Forms", artistName: "Roni Size" },
			{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: art("ok") },
		]);
		await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size", mixed)).resolves.toBe(art600("ok"));
		for (const body of [{}, { results: "nope" }, [], "html", null]) {
			const f = routedFetch([["itunes.apple.com", () => jsonResponse(body)]]);
			await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size", f)).resolves.toBeNull();
		}
	});

	it("returns null on HTTP errors and network failures", async () => {
		const down = routedFetch([["itunes.apple.com", () => new Response("", { status: 500 })]]);
		await expect(lookupVerifiedAlbumArt("New Forms", "Roni Size", down)).resolves.toBeNull();
		const boom = vi.fn(async () => {
			throw new Error("offline");
		});
		await expect(
			lookupVerifiedAlbumArt("New Forms", "Roni Size", boom as unknown as typeof fetch),
		).resolves.toBeNull();
	});

	it("cannot verify without an artist or a title, so it does not even ask", async () => {
		const f = itunes([{ collectionName: "New Forms", artistName: "Roni Size", artworkUrl100: art("a") }]);
		await expect(lookupVerifiedAlbumArt("New Forms", "  ", f)).resolves.toBeNull();
		await expect(lookupVerifiedAlbumArt("", "Roni Size", f)).resolves.toBeNull();
		expect(f.calls).toEqual([]);
	});
});
