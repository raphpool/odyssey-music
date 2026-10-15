import type { Schema } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { EDGE_TARGET_TYPES_BY_TYPE, NODE_TYPES } from "../src/node-spec.js";
import { type EdgeContext, makeNodeSchema, normalizeEdge } from "../src/pipeline.js";
import type { NodeType, Slug } from "../src/types.js";

// TRA-462: work references (project/track) carry their primary artist; normalizeEdge scopes the slug
// with it, drops a work nobody is credited for, and refuses links from a node to itself.

const ARTIST_CTX: EdgeContext = {
	sourceSlug: "artist:rohff" as Slug,
	sourceType: "artist",
	sourceName: "Rohff",
};
const PROJECT_CTX: EdgeContext = {
	sourceSlug: "project:signal--autechre" as Slug,
	sourceType: "project",
	sourceName: "Signal",
	sourceArtist: "Autechre",
};
const GENRE_CTX: EdgeContext = {
	sourceSlug: "genre:drum-and-bass" as Slug,
	sourceType: "genre",
	sourceName: "Drum and bass",
};

describe("normalizeEdge -- scoped work references (TRA-462)", () => {
	it("scopes a track emitted by an artist node with that artist's name", () => {
		const out = normalizeEdge({ type: "track", name: "Fitna" }, ["track"], {
			...ARTIST_CTX,
			sourceField: "notable_tracks",
		});
		expect(out).toEqual({ slug: "track:fitna--rohff", type: "track", name: "Fitna", artist: "Rohff" });
	});

	it("prefers the artist named on the reference over the source's", () => {
		const out = normalizeEdge({ type: "track", name: "Fitna", artist: "Akuma" }, ["track"], ARTIST_CTX);
		expect(out?.slug).toBe("track:fitna--akuma");
		expect(out?.artist).toBe("Akuma");
	});

	it("scopes a genre's landmark project by the artist on the reference", () => {
		const out = normalizeEdge(
			{ type: "project", name: "New Forms", artist: "Roni Size / Reprazent" },
			["project"],
			GENRE_CTX,
		);
		expect(out?.slug).toBe("project:new-forms--roni-size-reprazent");
		expect(out?.artist).toBe("Roni Size / Reprazent");
	});

	it("drops a work with no artist anywhere and reports it", () => {
		const onDrop = vi.fn();
		const out = normalizeEdge({ type: "project", name: "New Forms" }, ["project"], GENRE_CTX, onDrop);
		expect(out).toBeNull();
		expect(onDrop).toHaveBeenCalledWith("no artist", 'project "New Forms"');
	});

	it("treats a blank artist as missing", () => {
		expect(
			normalizeEdge({ type: "project", name: "New Forms", artist: "  " }, ["project"], GENRE_CTX),
		).toBeNull();
	});

	it("falls back to the source work's first artist (tracklist of a project)", () => {
		const out = normalizeEdge({ type: "track", name: "Gantz Graf" }, ["track"], {
			...PROJECT_CTX,
			sourceField: "tracklist",
		});
		expect(out?.slug).toBe("track:gantz-graf--autechre");
		expect(out?.artist).toBe("Autechre");
	});

	it("drops the edge, not the caller, when the artist name has no Latin letter or digit", () => {
		const onDrop = vi.fn();
		const out = normalizeEdge(
			{ type: "track", name: "Merry Christmas", artist: "坂本龍一" },
			["track"],
			GENRE_CTX,
			onDrop,
		);
		expect(out).toBeNull();
		expect(onDrop).toHaveBeenCalledWith("empty-artist", 'track "Merry Christmas" by "坂本龍一"');
	});

	it("drops a work whose title normalizes to nothing", () => {
		const out = normalizeEdge({ type: "track", name: "???", artist: "Rohff" }, ["track"], GENRE_CTX);
		expect(out).toBeNull();
	});

	it("keeps a valid mbid on a scoped reference", () => {
		const mbid = "11111111-2222-3333-4444-555555555555";
		const out = normalizeEdge({ type: "track", name: "Fitna", artist: "Rohff", mbid }, ["track"], ARTIST_CTX);
		expect(out?.mbid).toBe(mbid);
	});
});

describe("normalizeEdge -- inheriting the source's artist is whitelisted (TRA-462 review)", () => {
	const ROHFF_TRACK_CTX: EdgeContext = {
		sourceSlug: "track:fitna--rohff" as Slug,
		sourceType: "track",
		sourceName: "Fitna",
		sourceArtist: "Rohff",
	};
	const NEW_FORMS_CTX: EdgeContext = {
		sourceSlug: "project:new-forms--roni-size-reprazent" as Slug,
		sourceType: "project",
		sourceName: "New Forms",
		sourceArtist: "Roni Size / Reprazent",
	};

	it("drops a sample with no artist rather than crediting it to the sampling track's artist", () => {
		const onDrop = vi.fn();
		const ctx = { ...ROHFF_TRACK_CTX, sourceField: "samples" };
		expect(normalizeEdge({ type: "track", name: "Fitna" }, ["track"], ctx, onDrop)).toBeNull();
		expect(onDrop).toHaveBeenCalledWith("no artist", 'track "Fitna"');
		const kept = normalizeEdge({ type: "track", name: "Fitna", artist: "Akuma" }, ["track"], ctx);
		expect(kept?.slug).toBe("track:fitna--akuma");
	});

	it.each(["sampled_by", "remix_of", "remixed_by"])("does not inherit on track.%s", (field) => {
		const ctx = { ...ROHFF_TRACK_CTX, sourceField: field };
		expect(normalizeEdge({ type: "track", name: "Other" }, ["track"], ctx)).toBeNull();
	});

	it("does not inherit on related_projects, nor from a genre or label source", () => {
		const related = { ...NEW_FORMS_CTX, sourceField: "related_projects" };
		expect(normalizeEdge({ type: "project", name: "Other" }, ["project"], related)).toBeNull();
		for (const [sourceType, sourceField, type] of [
			["genre", "landmark_projects", "project"],
			["genre", "landmark_tracks", "track"],
			["label", "notable_releases", "project"],
		] as const) {
			const ctx: EdgeContext = {
				sourceSlug: `${sourceType}:x` as Slug,
				sourceType,
				sourceName: "X",
				sourceField,
			};
			expect(normalizeEdge({ type, name: "Other" }, [type], ctx), `${sourceType}.${sourceField}`).toBeNull();
		}
	});

	it("does not inherit when the field is unknown", () => {
		expect(normalizeEdge({ type: "track", name: "Fitna" }, ["track"], ARTIST_CTX)).toBeNull();
	});

	it("credits an artist's discography entry without artist to that artist", () => {
		const ctx = { ...ARTIST_CTX, sourceField: "discography" };
		const out = normalizeEdge({ type: "project", name: "Il Faut Du Temps" }, ["project"], ctx);
		expect(out?.slug).toBe("project:il-faut-du-temps--rohff");
		expect(out?.artist).toBe("Rohff");
	});

	it("credits a tracklist entry without artist to the project's first artist", () => {
		const ctx = { ...NEW_FORMS_CTX, sourceField: "tracklist" };
		const out = normalizeEdge({ type: "track", name: "Brown Paper Bag" }, ["track"], ctx);
		expect(out?.slug).toBe("track:brown-paper-bag--roni-size-reprazent");
		expect(out?.artist).toBe("Roni Size / Reprazent");
	});

	it("credits track.project to the track's first artist", () => {
		const ctx = { ...ROHFF_TRACK_CTX, sourceField: "project" };
		const out = normalizeEdge({ type: "project", name: "La Fierte" }, ["project"], ctx);
		expect(out?.slug).toBe("project:la-fierte--rohff");
	});
});

describe("normalizeEdge -- self references and other types (TRA-462)", () => {
	it("rejects an artist listing themselves", () => {
		const onDrop = vi.fn();
		const ctx: EdgeContext = {
			sourceSlug: "artist:cartola" as Slug,
			sourceType: "artist",
			sourceName: "Cartola",
		};
		expect(normalizeEdge({ type: "artist", name: "Cartola" }, ["artist"], ctx, onDrop)).toBeNull();
		expect(onDrop).toHaveBeenCalledWith("self reference", 'artist "Cartola"');
	});

	it("leaves non-work targets unscoped and unchanged", () => {
		const genre = normalizeEdge(
			{ type: "genre", name: "Drum and Bass", artist: "ignored" },
			["genre"],
			ARTIST_CTX,
		);
		expect(genre).toEqual({ slug: "genre:drum-and-bass", type: "genre", name: "Drum and Bass" });
		const label = normalizeEdge({ type: "label", name: "Moving Shadow" }, ["label"], ARTIST_CTX);
		expect(label).toEqual({ slug: "label:moving-shadow", type: "label", name: "Moving Shadow" });
	});

	it("rejects a target type the field does not allow", () => {
		expect(normalizeEdge({ type: "label", name: "Moving Shadow" }, ["genre"], ARTIST_CTX)).toBeNull();
	});

	it("rejects malformed input without throwing", () => {
		expect(normalizeEdge(null as never, ["genre"], ARTIST_CTX)).toBeNull();
		expect(normalizeEdge({ type: "genre" }, ["genre"], ARTIST_CTX)).toBeNull();
		expect(normalizeEdge({ type: "nope", name: "x" }, ["genre"], ARTIST_CTX)).toBeNull();
	});
});

describe("makeNodeSchema -- artist required on work references (TRA-462)", () => {
	const WORK_FIELDS = new Set([
		"discography",
		"notable_tracks",
		"landmark_projects",
		"landmark_tracks",
		"notable_releases",
		"tracklist",
		"related_projects",
		"project",
		"samples",
		"sampled_by",
		"remix_of",
		"remixed_by",
	]);

	function edgeSchemaOf(type: NodeType, field: string): Schema | undefined {
		const prop = makeNodeSchema(type).schema.properties?.[field];
		return prop?.items ?? prop;
	}

	it("requires artist, in output order, on every work field", () => {
		let seen = 0;
		for (const type of NODE_TYPES) {
			for (const field of WORK_FIELDS) {
				if (!(field in EDGE_TARGET_TYPES_BY_TYPE[type])) continue;
				const edge = edgeSchemaOf(type, field);
				expect(edge, `${type}.${field}`).toBeDefined();
				expect(edge?.required, `${type}.${field}`).toEqual(["type", "name", "artist"]);
				expect(edge?.propertyOrdering, `${type}.${field}`).toEqual(["type", "name", "artist"]);
				expect(edge?.properties?.artist?.minLength, `${type}.${field}`).toBe("1");
				seen++;
			}
		}
		expect(seen).toBe(WORK_FIELDS.size);
	});

	it("does not ask for artist on any other edge field", () => {
		for (const type of NODE_TYPES) {
			for (const field of Object.keys(EDGE_TARGET_TYPES_BY_TYPE[type])) {
				if (WORK_FIELDS.has(field)) continue;
				const edge = edgeSchemaOf(type, field);
				if (!edge) continue;
				expect(edge.required, `${type}.${field}`).toEqual(["type", "name"]);
				expect(edge.properties?.artist, `${type}.${field}`).toBeUndefined();
			}
		}
	});
});
