import { describe, expect, it } from "vitest";
import { EDGE_FIELDS_BY_TYPE, REVERSE_EDGE_PAIRS } from "../src/node-spec.js";
import {
	isEmittedPendingReverse,
	reverseFor,
	reversePairKey,
	SAFE_BACKFILL_PAIRS,
} from "../src/reverse-edges.js";
import type { NodeType } from "../src/types.js";

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

	it("emits the safe directions and no other cross-type pair", () => {
		for (const pair of REVERSE_EDGE_PAIRS) {
			const target = targetOf(pair.sourceType, pair.sourceField);
			const key = reversePairKey(pair.sourceType, pair.sourceField, target, pair.reverse.field);
			const emitted = reverseFor(pair.sourceType, pair.sourceField) !== null;
			expect(emitted, key).toBe(target === pair.sourceType || SAFE_BACKFILL_PAIRS.has(key));
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
