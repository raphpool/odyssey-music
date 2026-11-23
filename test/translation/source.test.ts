import { describe, expect, it } from "vitest";
import {
	currentTranslation,
	translationSourceHash,
	translationSourceOf,
} from "../../src/translation/source.js";
import type { NodePayload, NodeTranslation } from "../../src/types.js";
import { artistNode, edge, genreNode, labelNode, projectNode, trackNode } from "../images/helpers.js";

const radiohead = edge("artist", "radiohead", "Radiohead");
const kidA = edge("project", "kid-a", "Kid A", { artist: "Radiohead" });
const parlophone = edge("label", "parlophone", "Parlophone");
const artRock = edge("genre", "art-rock", "Art rock");

function idioteque(extra: Parameters<typeof trackNode>[2] = {}) {
	return trackNode("idioteque", "Idioteque", {
		editorial_teaser: "A frantic electronic track.",
		year: "2000",
		duration: "5:09",
		bpm: "136",
		cover_url: "https://coverartarchive.org/release/1/front",
		musical_key: "A minor",
		samples_notes: "Built on a Paul Lansky piece.",
		artists: [radiohead],
		project: kidA,
		label: parlophone,
		genres: [artRock],
		...extra,
	});
}

const hashOf = (node: NodePayload) => translationSourceHash(translationSourceOf(node));

function translationFor(node: NodePayload): NodeTranslation {
	return {
		teaser: "Un morceau électronique frénétique.",
		article: "Premier paragraphe.\n\nSecond paragraphe.",
		source_sha256: hashOf(node),
		model: "gemini-flash-lite",
		translated_at: "2026-11-02T10:00:00.000Z",
	};
}

describe("translationSourceOf", () => {
	it("returns the teaser, article and non-blank translatable facts of a track, with its proper nouns", () => {
		const track = idioteque({ vocals: "   " });
		const source = translationSourceOf(track);

		expect(source.type).toBe("track");
		expect(source.name).toBe("Idioteque");
		expect(source.teaser).toBe("A frantic electronic track.");
		expect(source.article).toBe(track.editorial_article);
		expect(source.facts).toEqual({
			musical_key: "A minor",
			samples_notes: "Built on a Paul Lansky piece.",
		});
		expect(source.properNouns).toEqual(["Idioteque", "Radiohead", "Kid A", "Parlophone"]);
	});

	it("lists the facts in declaration order, whatever the order of the node's keys", () => {
		const track = idioteque({ inspirations: "Early electronic music.", vocals: "Thom Yorke" });
		expect(Object.keys(translationSourceOf(track).facts)).toEqual([
			"musical_key",
			"vocals",
			"samples_notes",
			"inspirations",
		]);
	});

	it("reads the teaser and the facts of each node type", () => {
		const genre = genreNode("ambient-techno", "Ambient techno", {
			editorial_definition: "Techno slowed down.",
			era: "Early 1990s",
			origin: "United Kingdom",
		});
		const label = labelNode("warp", "Warp", {
			editorial_description: "A Sheffield label.",
			location: "Sheffield",
			active_years: "1989-present",
		});
		const artist = artistNode("radiohead", "Radiohead", {
			editorial_bio: "An English band.",
			origin: "Abingdon",
		});
		const project = projectNode("kid-a", "Kid A", {
			editorial_pitch: "An album without guitars.",
			vocals: "Thom Yorke",
			inspirations: "Warp Records",
		});

		const [g, l, a, p] = [genre, label, artist, project].map(translationSourceOf);
		expect([g?.teaser, l?.teaser, a?.teaser, p?.teaser]).toEqual([
			"Techno slowed down.",
			"A Sheffield label.",
			"An English band.",
			"An album without guitars.",
		]);
		expect(g?.facts).toEqual({ era: "Early 1990s", origin: "United Kingdom" });
		expect(l?.facts).toEqual({ location: "Sheffield", active_years: "1989-present" });
		expect(a?.facts).toEqual({ origin: "Abingdon" });
		expect(p?.facts).toEqual({ vocals: "Thom Yorke", inspirations: "Warp Records" });
	});

	it("takes proper nouns from the artist, label, project and track edges of every node type", () => {
		const xtal = edge("track", "xtal", "Xtal");
		expect(translationSourceOf(labelNode("warp", "Warp", { roster: [radiohead] })).properNouns).toEqual([
			"Warp",
			"Radiohead",
		]);
		expect(
			translationSourceOf(artistNode("aphex", "Aphex Twin", { discography: [kidA], labels: [parlophone] }))
				.properNouns,
		).toEqual(["Aphex Twin", "Parlophone", "Kid A"]);
		expect(
			translationSourceOf(projectNode("kid-a", "Kid A", { tracklist: [xtal], genres: [artRock] }))
				.properNouns,
		).toEqual(["Kid A", "Xtal"]);
	});

	it("leaves the name of a genre node and the genre edges out of the proper nouns", () => {
		const genre = genreNode("ambient-techno", "Ambient techno", {
			key_artists: [radiohead],
			related_genres: [artRock],
		});
		expect(translationSourceOf(genre).properNouns).toEqual(["Radiohead"]);
	});

	it("never puts year, duration, bpm, founded, founders, release_type or an image url in the facts", () => {
		const excluded = [
			"year",
			"duration",
			"bpm",
			"founded",
			"founders",
			"release_type",
			"cover_url",
			"photo_url",
		];
		const nodes: NodePayload[] = [
			genreNode("g", "Genre"),
			labelNode("l", "Label", { founded: "1989", founders: "Someone" }),
			artistNode("a", "Artist", { photo_url: "https://upload.wikimedia.org/p.jpg" }),
			projectNode("p", "Project", {
				year: "2000",
				release_type: "album",
				bpm: "90",
				cover_url: "https://x/c",
			}),
			idioteque(),
		];
		for (const node of nodes) {
			const keys = Object.keys(translationSourceOf(node).facts);
			for (const field of excluded) expect(keys, `${node.type}.${field}`).not.toContain(field);
		}
	});

	it("drops duplicated proper nouns and those shorter than 3 characters", () => {
		const track = trackNode("xy", "Xy", {
			artists: [radiohead, edge("artist", "radiohead-2", "Radiohead"), edge("artist", "dj", "DJ")],
			project: { ...kidA, name: "Radiohead" },
		});
		expect(translationSourceOf(track).properNouns).toEqual(["Radiohead"]);
	});
});

describe("translationSourceHash", () => {
	const track = idioteque();

	it("is 64 lowercase hexadecimal characters and deterministic", () => {
		expect(hashOf(track)).toMatch(/^[0-9a-f]{64}$/);
		expect(hashOf(idioteque())).toBe(hashOf(track));
	});

	it("is the sha256 of the documented JSON, in UTF-8", () => {
		// sha256 of '["é","b",[["origin","c"]]]', computed independently of the implementation (sha256sum).
		expect(translationSourceHash({ teaser: "é", article: "b", facts: { origin: "c" } })).toBe(
			"827a57d45b50a087c0a0d368c043859abeea7abb213455978659480df8af1eb4",
		);
	});

	it("changes when one character of the article, the teaser or a translatable fact changes", () => {
		const base = hashOf(track);
		expect(hashOf(idioteque({ editorial_article: `${track.editorial_article}.` }))).not.toBe(base);
		expect(hashOf(idioteque({ editorial_teaser: "A frantic electronic track!" }))).not.toBe(base);
		expect(hashOf(idioteque({ musical_key: "A major" }))).not.toBe(base);
		expect(hashOf(idioteque({ inspirations: "Warp" }))).not.toBe(base);
	});

	it("tells a fact moving from one field to another", () => {
		const a = translationSourceHash({ teaser: "t", article: "a", facts: { vocals: "x" } });
		const b = translationSourceHash({ teaser: "t", article: "a", facts: { musical_key: "x" } });
		expect(a).not.toBe(b);
	});

	it("does not change when an edge, image_url, materialized_at, l10n or a non-translatable field changes", () => {
		const base = hashOf(track);
		expect(hashOf(idioteque({ artists: [edge("artist", "other", "Someone Else")], genres: [] }))).toBe(base);
		expect(hashOf(idioteque({ image_url: "https://coverartarchive.org/other.jpg" }))).toBe(base);
		expect(hashOf(idioteque({ materialized_at: "2027-01-01T00:00:00.000Z" }))).toBe(base);
		expect(hashOf(idioteque({ l10n: { fr: translationFor(track) } }))).toBe(base);
		expect(hashOf(idioteque({ year: "2001", duration: "6:00", bpm: "99" }))).toBe(base);
	});
});

describe("currentTranslation", () => {
	it("returns the block when its source_sha256 equals the fingerprint of the node", () => {
		const translation = translationFor(idioteque());
		expect(currentTranslation(idioteque({ l10n: { fr: translation } }), "fr")).toBe(translation);
	});

	it("returns undefined when the node has no block", () => {
		expect(currentTranslation(idioteque(), "fr")).toBeUndefined();
		expect(currentTranslation(idioteque({ l10n: {} }), "fr")).toBeUndefined();
	});

	it("returns undefined once the English article changed", () => {
		const translation = translationFor(idioteque());
		const edited = idioteque({ editorial_article: "A rewritten article.", l10n: { fr: translation } });
		expect(currentTranslation(edited, "fr")).toBeUndefined();
	});

	it("stays current when only an edge changed", () => {
		const translation = translationFor(idioteque());
		const merged = idioteque({
			remixed_by: [edge("track", "remix", "Idioteque (remix)")],
			l10n: { fr: translation },
		});
		expect(currentTranslation(merged, "fr")).toBe(translation);
	});
});
