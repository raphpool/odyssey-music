import type { Schema } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDGE_TARGET_TYPES_BY_TYPE, NODE_TYPES } from "../src/node-spec.js";
import { type EdgeContext, enforceArtistChoices, makeNodeSchema, normalizeEdge } from "../src/pipeline.js";
import type { NodeType, Slug } from "../src/types.js";

// TRA-462: work references (project/track) carry their primary artist; normalizeEdge scopes the slug
// with it, drops a work nobody is credited for, and refuses links from a node to itself.
// All of that sits behind ODYSSEY_SCOPED_RELEASE_SLUGS (TRA-509 flips it): the suite runs with the flag on,
// and the last describe proves that off, the output is what main emits.

beforeEach(() => {
	vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

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
		"landmark_project",
		"reference_track",
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

describe("makeNodeSchema -- artist picks (TRA-470)", () => {
	const { schema } = makeNodeSchema("artist");

	it("declares landmark_project and reference_track as optional single references with artist required", () => {
		for (const [field, type, list] of [
			["landmark_project", "project", "discography"],
			["reference_track", "track", "notable_tracks"],
		] as const) {
			const prop = schema.properties?.[field];
			expect(prop?.type, field).toBe("OBJECT");
			expect(prop?.properties?.type?.enum, field).toEqual([type]);
			expect(prop?.required, field).toEqual(["type", "name", "artist"]);
			expect(prop?.description, field).toContain(`repeat one entry of ${list} exactly`);
			expect(schema.required ?? [], field).not.toContain(field);
		}
	});
});

describe("enforceArtistChoices -- membership and fallback (TRA-470)", () => {
	const album = (name: string) => ({ slug: `project:${name}--a`, type: "project", name, artist: "A" });
	const track = (name: string) => ({ slug: `track:${name}--a`, type: "track", name, artist: "A" });
	const node = (extra: Record<string, unknown>): Record<string, unknown> => ({
		slug: "artist:a",
		discography: [album("one"), album("two")],
		notable_tracks: [track("x"), track("y")],
		...extra,
	});

	it("keeps a pick that is a list member, wherever it sits", () => {
		const n = node({ landmark_project: album("two"), reference_track: track("y") });
		const lines: string[] = [];
		enforceArtistChoices(n, (l) => lines.push(l));
		expect(n.landmark_project).toEqual(album("two"));
		expect(n.reference_track).toEqual(track("y"));
		expect(lines).toEqual([]);
	});

	it("compares by slug, not by name or object identity, and keeps the list's own entry", () => {
		const n = node({ landmark_project: { slug: "project:two--a", type: "project", name: "Two (remaster)" } });
		enforceArtistChoices(n);
		expect(n.landmark_project).toEqual(album("two"));
	});

	it("replaces an off-list pick with the first entry and logs it", () => {
		const n = node({ landmark_project: album("ghost"), reference_track: track("ghost") });
		const lines: string[] = [];
		enforceArtistChoices(n, (l) => lines.push(l));
		expect(n.landmark_project).toEqual(album("one"));
		expect(n.reference_track).toEqual(track("x"));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("landmark_project not in discography");
		expect(lines[1]).toContain("reference_track not in notable_tracks");
	});

	it("does not take a bare slug for the scoped entry of the same title", () => {
		const n = node({ landmark_project: { slug: "project:two", type: "project", name: "two" } });
		enforceArtistChoices(n);
		expect(n.landmark_project).toEqual(album("one"));
	});

	it("fills a missing pick and survives an unreadable one", () => {
		const n = node({ landmark_project: "two", reference_track: undefined });
		enforceArtistChoices(n);
		expect(n.landmark_project).toEqual(album("one"));
		expect(n.reference_track).toEqual(track("x"));
	});

	it("removes the pick when its list is empty or missing", () => {
		const n = node({
			discography: [],
			notable_tracks: undefined,
			landmark_project: album("one"),
			reference_track: track("x"),
		});
		const lines: string[] = [];
		enforceArtistChoices(n, (l) => lines.push(l));
		expect("landmark_project" in n).toBe(false);
		expect("reference_track" in n).toBe(false);
		expect(lines).toHaveLength(2);
	});

	it("leaves a node without picks and without lists untouched", () => {
		const n: Record<string, unknown> = { slug: "artist:a" };
		enforceArtistChoices(n);
		expect(n).toEqual({ slug: "artist:a" });
	});

	it("is idempotent", () => {
		const n = node({ landmark_project: album("ghost") });
		enforceArtistChoices(n);
		const once = structuredClone(n);
		const lines: string[] = [];
		enforceArtistChoices(n, (l) => lines.push(l));
		expect(n).toEqual(once);
		expect(lines).toEqual([]);
	});
});

// TRA-674: a field TRA-605 emptied on purpose (data/cleared-landmarks.json) is a missing pick, which the
// function above fills with list[0], the most recent entry: the bad choice would come back on the next
// regeneration of the card. Real artists of the list, no mock.
describe("enforceArtistChoices -- cleared pairs stay empty (TRA-674)", () => {
	const proj = (body: string, name: string) => ({ slug: `project:${body}`, type: "project", name });
	const trk = (body: string, name: string) => ({ slug: `track:${body}`, type: "track", name });
	const headhunterz = (extra: Record<string, unknown>): Record<string, unknown> => ({
		slug: "artist:headhunterz",
		discography: [proj("live-forever", "Live Forever"), proj("the-source-of-energy", "The Source of Energy")],
		notable_tracks: [trk("t1", "T1")],
		...extra,
	});

	it("does not fill a cleared field with the most recent entry", () => {
		const n = headhunterz({});
		const lines: string[] = [];
		enforceArtistChoices(n, (l) => lines.push(l));
		expect("landmark_project" in n).toBe(false);
		expect(lines.some((l) => l.includes("landmark_project"))).toBe(false);
	});

	it("does not replace an off-list pick of a cleared field by the first entry", () => {
		const n = headhunterz({ landmark_project: proj("ghost", "Ghost") });
		enforceArtistChoices(n);
		expect("landmark_project" in n).toBe(false);
	});

	it("drops the rejected pick when a regeneration proposes it again", () => {
		const n = headhunterz({ landmark_project: proj("live-forever", "Live Forever") });
		const lines: string[] = [];
		enforceArtistChoices(n, (l) => lines.push(l));
		expect("landmark_project" in n).toBe(false);
		expect(lines.filter((l) => l.includes("landmark_project"))).toEqual([
			expect.stringContaining("cleared on purpose"),
		]);
	});

	it("recognises the rejected pick under its scoped slug (ODYSSEY_SCOPED_RELEASE_SLUGS)", () => {
		const scoped = proj("live-forever--headhunterz", "Live Forever");
		const n = headhunterz({
			discography: [scoped, proj("the-source-of-energy", "x")],
			landmark_project: scoped,
		});
		enforceArtistChoices(n);
		expect("landmark_project" in n).toBe(false);
	});

	it("keeps any other member of the list: a regeneration may choose again", () => {
		const n = headhunterz({ landmark_project: proj("the-source-of-energy", "The Source of Energy") });
		enforceArtistChoices(n);
		expect(n.landmark_project).toEqual(proj("the-source-of-energy", "The Source of Energy"));
	});

	it("only withholds the pair that is cleared: the other field and other artists are filled", () => {
		const n = headhunterz({});
		enforceArtistChoices(n);
		expect(n.reference_track).toEqual(trk("t1", "T1"));
		const other = { slug: "artist:roni", discography: [proj("a1", "a1")] } as Record<string, unknown>;
		enforceArtistChoices(other);
		expect(other.landmark_project).toEqual(proj("a1", "a1"));
	});
});

describe("normalizeEdge -- flag off emits what main emits (TRA-509)", () => {
	beforeEach(() => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
	});

	it("keeps the bare slug for a work, stamping artist when known", () => {
		const track = normalizeEdge({ type: "track", name: "Fitna" }, ["track"], {
			...ARTIST_CTX,
			sourceField: "notable_tracks",
		});
		expect(track).toEqual({ slug: "track:fitna", type: "track", name: "Fitna", artist: "Rohff" });
		const project = normalizeEdge(
			{ type: "project", name: "New Forms", artist: "Roni Size / Reprazent" },
			["project"],
			GENRE_CTX,
		);
		expect(project?.slug).toBe("project:new-forms");
	});

	it("does not drop a work for a missing or non-Latin artist", () => {
		const onDrop = vi.fn();
		expect(normalizeEdge({ type: "project", name: "New Forms" }, ["project"], GENRE_CTX, onDrop)?.slug).toBe(
			"project:new-forms",
		);
		expect(
			normalizeEdge(
				{ type: "track", name: "Merry Christmas", artist: "坂本龍一" },
				["track"],
				GENRE_CTX,
				onDrop,
			)?.slug,
		).toBe("track:merry-christmas");
		expect(onDrop).not.toHaveBeenCalled();
	});

	it("still rejects a self link and a target type the field does not allow", () => {
		const onDrop = vi.fn();
		const cartola: EdgeContext = {
			sourceSlug: "artist:cartola" as Slug,
			sourceType: "artist",
			sourceName: "Cartola",
		};
		expect(normalizeEdge({ type: "artist", name: "Cartola" }, ["artist"], cartola, onDrop)).toBeNull();
		expect(onDrop).toHaveBeenCalledWith("self reference", 'artist "Cartola"');
		expect(normalizeEdge({ type: "label", name: "Moving Shadow" }, ["genre"], ARTIST_CTX, onDrop)).toBeNull();
		expect(onDrop).toHaveBeenCalledWith("type not allowed here", 'label "Moving Shadow"');
	});

	it("defaults to off when the variable is unset", () => {
		vi.unstubAllEnvs();
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "");
		expect(
			normalizeEdge({ type: "track", name: "Fitna", artist: "Rohff" }, ["track"], ARTIST_CTX)?.slug,
		).toBe("track:fitna");
	});
});
