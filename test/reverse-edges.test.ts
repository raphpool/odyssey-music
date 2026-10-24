import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import { EDGE_FIELDS_BY_TYPE, REVERSE_EDGE_PAIRS } from "../src/node-spec.js";
import {
	isEmittedPendingReverse,
	isEmittedReversePair,
	reverseFor,
	reversePairKey,
	SAFE_BACKFILL_PAIRS,
} from "../src/reverse-edges.js";
import type { EdgeRef, NodeType, TrackNode } from "../src/types.js";

// TRA-563: the runtime emits the same cross-type directions as the backfill migration (TRA-486).

function targetOf(sourceType: NodeType, field: string): NodeType {
	const spec = (EDGE_FIELDS_BY_TYPE[sourceType] as Record<string, { targets: readonly NodeType[] }>)[field];
	const target = spec?.targets[0];
	if (!target) throw new Error(`no target for ${sourceType}.${field}`);
	return target;
}

describe("reverse edge emission", () => {
	it("lists exactly the four safe directions, each backed by a REVERSE_EDGE_PAIRS entry", () => {
		const keys = REVERSE_EDGE_PAIRS.map((p) =>
			reversePairKey(p.sourceType, p.sourceField, targetOf(p.sourceType, p.sourceField), p.reverse.field),
		);
		expect([...SAFE_BACKFILL_PAIRS].sort()).toEqual([
			"artist.labels→label.roster",
			"project.artists→artist.discography",
			"project.label→label.notable_releases",
			"track.artists→artist.notable_tracks",
		]);
		for (const key of SAFE_BACKFILL_PAIRS) expect(keys).toContain(key);
	});

	it("emits the safe directions, the same-kind list pairs and no other pair", () => {
		for (const pair of REVERSE_EDGE_PAIRS) {
			const target = targetOf(pair.sourceType, pair.sourceField);
			const key = reversePairKey(pair.sourceType, pair.sourceField, target, pair.reverse.field);
			const emitted = reverseFor(pair.sourceType, pair.sourceField) !== null;
			// A singular reverse is never emitted, whatever the types (TRA-569).
			const expected =
				pair.reverse.cardinality === "list" && (target === pair.sourceType || SAFE_BACKFILL_PAIRS.has(key));
			expect(emitted, key).toBe(expected);
			// The audit caps exactly what is emitted (TRA-567): against the rule above and the emission table.
			expect(isEmittedReversePair(pair.sourceType, pair.sourceField, pair.reverse.field), key).toBe(expected);
			expect(isEmittedReversePair(pair.sourceType, pair.sourceField, pair.reverse.field), key).toBe(
				reverseFor(pair.sourceType, pair.sourceField)?.field === pair.reverse.field,
			);
		}
	});

	it("judges a pending entry by its source type, the target type and the field", () => {
		const entry = (field: string, type: string) => ({ field, edge: { type } });
		expect(isEmittedPendingReverse("artist", entry("discography", "project"))).toBe(true);
		expect(isEmittedPendingReverse("artist", entry("notable_tracks", "track"))).toBe(true);
		expect(isEmittedPendingReverse("label", entry("notable_releases", "project"))).toBe(true);
		expect(isEmittedPendingReverse("label", entry("roster", "artist"))).toBe(true);
		expect(isEmittedPendingReverse("artist", entry("members", "artist"))).toBe(true);
		expect(isEmittedPendingReverse("project", entry("artists", "artist"))).toBe(false);
		expect(isEmittedPendingReverse("track", entry("artists", "artist"))).toBe(false);
		expect(isEmittedPendingReverse("project", entry("genres", "genre"))).toBe(false);
		expect(isEmittedPendingReverse("artist", entry("labels", "label"))).toBe(false);
		expect(isEmittedPendingReverse("project", entry("label", "label"))).toBe(false);
		expect(isEmittedPendingReverse("track", entry("project", "project"))).toBe(false);
		expect(isEmittedPendingReverse("project", entry("artists", "unknown"))).toBe(false);
	});
});

// TRA-569 (2026-10-23): `track.remixed_by -> remix_of` set a SINGULAR parent on a work from the list of another
// node. Writing track:song with `remixed_by: [track:intro]` made track:intro a remix of track:song, the same
// class of false credit as TRA-563. Only `remix_of -> remixed_by` (a list entry on the original) is derived.
describe("remix edges (TRA-569)", () => {
	it("emits remix_of -> remixed_by and nothing for remixed_by", () => {
		expect(reverseFor("track", "remix_of")).toEqual({ field: "remixed_by", cardinality: "list" });
		expect(reverseFor("track", "remixed_by")).toBeNull();
	});

	it("never derives a singular field from the list of another node", () => {
		for (const pair of REVERSE_EDGE_PAIRS) {
			if (pair.reverse.cardinality !== "single") continue;
			expect(
				reverseFor(pair.sourceType, pair.sourceField),
				`${pair.sourceType}.${pair.sourceField}`,
			).toBeNull();
		}
	});

	it("ignores a pending remix_of entry and keeps a pending remixed_by one", () => {
		const entry = (field: string) => ({ field, edge: { type: "track" } });
		expect(isEmittedPendingReverse("track", entry("remix_of"))).toBe(false);
		expect(isEmittedPendingReverse("track", entry("remixed_by"))).toBe(true);
	});

	describe("NodeCache.write", () => {
		let dir: string;
		let cache: NodeCache;
		beforeEach(async () => {
			dir = await mkdtemp(join(tmpdir(), "odyssey-remix-"));
			cache = new NodeCache(dir);
		});
		afterEach(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		const ref = (slug: string, name: string): EdgeRef => ({
			type: "track",
			slug: slug as EdgeRef["slug"],
			name,
		});
		const track = (slug: string, name: string, overrides: Partial<TrackNode> = {}): TrackNode => ({
			type: "track",
			slug: slug as TrackNode["slug"],
			name,
			editorial_teaser: `Fixture teaser for ${name}.`,
			editorial_article: `A real long article about ${name}. `.repeat(8),
			citations: [{ url: `https://example.com/${slug.slice("track:".length)}` }],
			materialized_at: new Date().toISOString(),
			artists: [],
			genres: [],
			producers: [],
			personnel: [],
			samples: [],
			sampled_by: [],
			remixed_by: [],
			...overrides,
		});
		const song = ref("track:song", "Song");
		const intro = ref("track:intro", "Intro");

		it("does not set remix_of on a cached target listed in remixed_by", async () => {
			await cache.write(track("track:intro", "Intro"));
			await cache.write(track("track:song", "Song", { remixed_by: [intro] }));

			const target = (await cache.get("track:intro")) as TrackNode;
			expect(target.remix_of).toBeUndefined();
		});

		it("does not queue anything for an absent target, so a later write of it stays clean", async () => {
			// The credit to an absent artist is a safe direction: it proves the pending file is written at all.
			const eno = { type: "artist", slug: "artist:eno", name: "Eno" } as EdgeRef;
			await cache.write(track("track:song", "Song", { artists: [eno], remixed_by: [intro] }));
			const raw = await readFile(join(dir, "pending-reverses.json"), "utf8");
			const pending = JSON.parse(raw) as Record<string, unknown[]>;
			expect(pending["artist:eno"]).toHaveLength(1);
			expect(pending["track:intro"]).toBeUndefined();

			await cache.write(track("track:intro", "Intro"));
			expect(((await cache.get("track:intro")) as TrackNode).remix_of).toBeUndefined();
		});

		it("still adds the remix to remixed_by of the original", async () => {
			await cache.write(track("track:song", "Song"));
			await cache.write(track("track:intro", "Intro", { remix_of: song }));

			const original = (await cache.get("track:song")) as TrackNode;
			expect(original.remixed_by.map((e) => e.slug)).toEqual(["track:intro"]);
		});

		it("does not apply a remix_of entry pending from before the fix", async () => {
			await writeFile(
				join(dir, "pending-reverses.json"),
				JSON.stringify({ "track:intro": [{ field: "remix_of", cardinality: "single", edge: song }] }),
			);
			const legacy = new NodeCache(dir);
			await legacy.write(track("track:intro", "Intro"));

			expect(((await legacy.get("track:intro")) as TrackNode).remix_of).toBeUndefined();
		});
	});
});
