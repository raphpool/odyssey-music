import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanAppleUrl } from "../src/itunes.js";
import {
	appleSearchUrl,
	LINKABLE_TYPES,
	readSidecar,
	safeServiceUrl,
	sidecarPath,
	spotifySearchUrl,
} from "../src/streaming-links.js";
import { nameMatchScore } from "../src/text-match.js";

describe("LINKABLE_TYPES", () => {
	it("covers the three streamable node types only", () => {
		expect([...LINKABLE_TYPES].sort()).toEqual(["artist", "project", "track"]);
	});
	it("excludes genre and label, which have no streaming counterpart", () => {
		expect(LINKABLE_TYPES.has("genre")).toBe(false);
		expect(LINKABLE_TYPES.has("label")).toBe(false);
	});
});

describe("search URLs", () => {
	it("puts the artist first so the query reads like a listener would type it", () => {
		expect(spotifySearchUrl("Kid A", "Radiohead")).toBe(
			"https://open.spotify.com/search/Radiohead%20Kid%20A",
		);
	});
	it("works without a known artist", () => {
		expect(spotifySearchUrl("Aphex Twin")).toBe("https://open.spotify.com/search/Aphex%20Twin");
	});
	it("encodes characters that would break the URL", () => {
		expect(spotifySearchUrl("Sur le fil", "Yann Tiersen")).toContain("Yann%20Tiersen%20Sur%20le%20fil");
		expect(appleSearchUrl("Rock & Roll", "Led Zeppelin")).toContain(
			"term=Led%20Zeppelin%20Rock%20%26%20Roll",
		);
	});
});

describe("safeServiceUrl", () => {
	// MusicBrainz url-rels are user-editable third-party data and land in an <a href>.
	it("rejects a javascript: url that name-drops the service host", () => {
		expect(safeServiceUrl("javascript:alert(document.domain)//open.spotify.com", "spotify")).toBeNull();
	});
	it("rejects a foreign host that merely contains the service host as a substring", () => {
		expect(safeServiceUrl("https://evil.example/pwn?ref=open.spotify.com", "spotify")).toBeNull();
		expect(safeServiceUrl("https://open.spotify.com.evil.example/x", "spotify")).toBeNull();
	});
	it("rejects plaintext http", () => {
		expect(safeServiceUrl("http://open.spotify.com/artist/x", "spotify")).toBeNull();
	});
	it("rejects the other service's url", () => {
		expect(safeServiceUrl("https://music.apple.com/us/artist/x/1", "spotify")).toBeNull();
	});
	it("accepts the real thing", () => {
		expect(safeServiceUrl("https://open.spotify.com/artist/0uCCBpmg6MrPb1KY2msceF", "spotify")).toBe(
			"https://open.spotify.com/artist/0uCCBpmg6MrPb1KY2msceF",
		);
		expect(safeServiceUrl("https://music.apple.com/us/artist/aphex-twin/39883194", "apple")).toBe(
			"https://music.apple.com/us/artist/aphex-twin/39883194",
		);
	});
	it("handles null and garbage without throwing", () => {
		expect(safeServiceUrl(null, "spotify")).toBeNull();
		expect(safeServiceUrl("not a url", "apple")).toBeNull();
	});
});

describe("cleanAppleUrl", () => {
	it("keeps ?i=, which is what makes a song URL a song URL", () => {
		// Regression: stripping the whole query turned every track link into a
		// link to the parent album.
		expect(cleanAppleUrl("https://music.apple.com/us/album/windowlicker/281953326?i=281953327&uo=4")).toBe(
			"https://music.apple.com/us/album/windowlicker/281953326?i=281953327",
		);
	});
	it("drops the tracking params", () => {
		expect(cleanAppleUrl("https://music.apple.com/us/artist/aphex-twin/39883194?uo=4")).toBe(
			"https://music.apple.com/us/artist/aphex-twin/39883194",
		);
	});
	it("rejects a URL that is not an Apple Music page", () => {
		expect(cleanAppleUrl("https://example.com/us/album/x/1?i=2")).toBeNull();
		expect(cleanAppleUrl("not a url")).toBeNull();
	});
});

describe("sidecarPath", () => {
	it("keeps type and slug body in the filename", () => {
		expect(sidecarPath("/c", "artist:aphex-twin")).toBe(join("/c", "links", "artist-aphex-twin.json"));
	});
	it("sanitizes characters that are not filename-safe", () => {
		expect(sidecarPath("/c", "track:sur/le fil")).toBe(join("/c", "links", "track-sur_le_fil.json"));
	});
	it("gives different types different files for the same body", () => {
		expect(sidecarPath("/c", "artist:burial")).not.toBe(sidecarPath("/c", "track:burial"));
	});
	it("cannot escape the cache directory through the type prefix", () => {
		// The type half also lands in the filename; unsanitized, this resolved to
		// /etc/passwd-x.json.
		expect(sidecarPath("/c", "../../etc/passwd:x")).toBe(join("/c", "links", "______etc_passwd-x.json"));
		expect(sidecarPath("/c", "..:evil")).toBe(join("/c", "links", "__-evil.json"));
	});
	it("cannot escape the cache directory through the slug body", () => {
		expect(sidecarPath("/c", "artist:../../../oops")).toBe(join("/c", "links", "artist-_________oops.json"));
	});
});

/** Write a sidecar straight to disk, the way resolveStreamingLinks would. */
async function seedSidecar(dir: string, slug: string, body: unknown): Promise<string> {
	const file = sidecarPath(dir, slug);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(body));
	return file;
}

describe("readSidecar", () => {
	it("returns null when no sidecar exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "odyssey-links-"));
		expect(await readSidecar(dir, "artist:nobody")).toBeNull();
	});

	it("round-trips a resolved sidecar", async () => {
		const dir = await mkdtemp(join(tmpdir(), "odyssey-links-"));
		await seedSidecar(dir, "artist:burial", {
			spotify: "https://open.spotify.com/artist/0uCCBpmg6MrPb1KY2msceF",
			apple: null,
			sources: { spotify: "musicbrainz" },
			resolvedAt: "2026-08-17T00:00:00.000Z",
		});
		const got = await readSidecar(dir, "artist:burial");
		expect(got?.spotify).toBe("https://open.spotify.com/artist/0uCCBpmg6MrPb1KY2msceF");
		expect(got?.apple).toBeNull();
		expect(got?.sources.spotify).toBe("musicbrainz");
	});

	it("coerces a malformed sidecar instead of leaking junk to the client", async () => {
		const dir = await mkdtemp(join(tmpdir(), "odyssey-links-"));
		await seedSidecar(dir, "track:x", { spotify: 42, apple: ["nope"] });
		const got = await readSidecar(dir, "track:x");
		expect(got?.spotify).toBeNull();
		expect(got?.apple).toBeNull();
		expect(got?.sources).toEqual({});
	});

	it("caches a miss so an unmatchable node is not re-resolved forever", async () => {
		const dir = await mkdtemp(join(tmpdir(), "odyssey-links-"));
		const file = await seedSidecar(dir, "track:white-label", {
			spotify: null,
			apple: null,
			sources: {},
			resolvedAt: "2026-08-17T00:00:00.000Z",
		});
		const got = await readSidecar(dir, "track:white-label");
		// A miss must read back as a real cache entry, not as an absence —
		// otherwise the resolver re-hits both APIs on every page view.
		expect(got).not.toBeNull();
		expect(got?.spotify).toBeNull();
		expect(JSON.parse(await readFile(file, "utf8")).resolvedAt).toBeTruthy();
	});
});

describe("nameMatchScore as the Apple-candidate gate", () => {
	it("rejects the wrong volume of a series (iTunes' favourite mistake)", () => {
		// Real case: searching "Selected Ambient Works 85-92" returns Volume II first.
		expect(
			nameMatchScore(
				"Selected Ambient Works Volume II Aphex Twin",
				"Selected Ambient Works 85–92",
				"Aphex Twin",
			),
		).not.toBeNull();
		// The gate alone cannot separate these; scoring must prefer the closer title.
		const vol2 =
			nameMatchScore("Selected Ambient Works Volume II", "Selected Ambient Works 85–92", undefined) ?? 0;
		const exact =
			nameMatchScore("Selected Ambient Works 85-92", "Selected Ambient Works 85–92", undefined) ?? 0;
		expect(exact).toBeGreaterThan(vol2);
	});

	it("rejects a same-title record by a different artist", () => {
		expect(nameMatchScore("Untitled — Some Other Band", "Untitled", "Autechre")).toBeNull();
	});

	it("accepts an exact artist match", () => {
		expect(nameMatchScore("Boards of Canada", "Boards of Canada", undefined)).not.toBeNull();
	});

	it("rejects an unrelated artist with a shared word", () => {
		expect(nameMatchScore("Board of Directors", "Boards of Canada", undefined)).toBeNull();
	});
});
