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
