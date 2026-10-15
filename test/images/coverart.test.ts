import { describe, expect, it, vi } from "vitest";
import { coverArtUrl } from "../../src/images/coverart.js";
import { redirectResponse, routedFetch } from "./helpers.js";

const MBID = "5c3d7c9e-1111-4a6e-8a59-0c56f5cf1111";
const CANONICAL = `https://coverartarchive.org/release-group/${MBID}/front-500`;
const ARCHIVE_TARGET = "https://ia800000.us.archive.org/12/items/mbid-abc/mbid-abc-123-thumb500.jpg";

describe("coverArtUrl", () => {
	it("returns the canonical coverartarchive.org URL on a 307, never the archive.org target", async () => {
		const f = routedFetch([["coverartarchive.org", () => redirectResponse(ARCHIVE_TARGET)]]);
		await expect(coverArtUrl(MBID, f)).resolves.toBe(CANONICAL);
		expect(f.calls).toEqual([CANONICAL]);
	});

	it("does not follow the redirect and identifies itself with the MusicBrainz user agent", async () => {
		const f = vi.fn(async () => redirectResponse(ARCHIVE_TARGET));
		await coverArtUrl(MBID, f as unknown as typeof fetch);
		const init = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(init[1].redirect).toBe("manual");
		expect((init[1].headers as Record<string, string>)["User-Agent"]).toContain("odyssey-music");
	});

	it("accepts a plain 200 as well", async () => {
		const f = routedFetch([["coverartarchive.org", () => new Response("jpeg", { status: 200 })]]);
		await expect(coverArtUrl(MBID, f)).resolves.toBe(CANONICAL);
	});

	it("lowercases the MBID so the stored URL is canonical", async () => {
		const f = routedFetch([["coverartarchive.org", () => redirectResponse(ARCHIVE_TARGET)]]);
		await expect(coverArtUrl(MBID.toUpperCase(), f)).resolves.toBe(CANONICAL);
	});

	it("returns null on 404 (no front cover)", async () => {
		const f = routedFetch([["coverartarchive.org", () => new Response("", { status: 404 })]]);
		await expect(coverArtUrl(MBID, f)).resolves.toBeNull();
	});

	it("returns null on a server error", async () => {
		const f = routedFetch([["coverartarchive.org", () => new Response("", { status: 503 })]]);
		await expect(coverArtUrl(MBID, f)).resolves.toBeNull();
	});

	it("returns null when the redirect leaves the allowed image hosts", async () => {
		for (const target of [
			"https://evil.example/cover.jpg",
			"http://ia800000.us.archive.org/cover.jpg",
			"https://archive.org.evil.example/cover.jpg",
		]) {
			const f = routedFetch([["coverartarchive.org", () => redirectResponse(target)]]);
			await expect(coverArtUrl(MBID, f)).resolves.toBeNull();
		}
	});

	it("returns null on a redirect without a Location", async () => {
		const f = routedFetch([["coverartarchive.org", () => redirectResponse(null)]]);
		await expect(coverArtUrl(MBID, f)).resolves.toBeNull();
	});

	it("returns null when the request fails, without throwing", async () => {
		const f = vi.fn(async () => {
			throw new Error("network down");
		});
		await expect(coverArtUrl(MBID, f as unknown as typeof fetch)).resolves.toBeNull();
	});

	it("refuses an MBID that is not a UUID without making a request", async () => {
		const f = routedFetch([]);
		for (const bad of ["", "not-a-uuid", `${MBID}/../../x`, `${MBID}?x=1`]) {
			await expect(coverArtUrl(bad, f)).resolves.toBeNull();
		}
		expect(f.calls).toEqual([]);
	});
});
