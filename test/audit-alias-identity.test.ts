import { describe, expect, it } from "vitest";
import {
	type AuditReport,
	auditNodes,
	compareWithThresholds,
	type RawNode,
	thresholdsFromReport,
} from "../scripts/audit-cache.js";

// TRA-562: `alias-to-uncorroborated-identity`. An alias between two artists that carry DIFFERENT MusicBrainz
// ids is normal (MusicBrainz models a pseudonym as its own artist, "is person"), so the difference alone is not
// the signal: 17 of the 19 such pairs of the cache of 2026-10-24 were right. What the two wrong ones lacked is
// any other tie in the cache: a homonym shares no genre, label, release or neighbour with the artist whose
// nickname it happens to bear.

const METRIC = "alias-to-uncorroborated-identity";

function edge(slug: string, name?: string): RawNode {
	const type = slug.slice(0, slug.indexOf(":"));
	return { slug, type, name: name ?? slug.slice(slug.indexOf(":") + 1) };
}

function artist(slug: string, fields: RawNode = {}): RawNode {
	return {
		slug,
		type: "artist",
		name: slug.slice(slug.indexOf(":") + 1),
		citations: [{ url: "https://a.example" }, { url: "https://b.example" }],
		image_url: "https://img.example/x.jpg",
		...fields,
	};
}

function toMap(...nodes: RawNode[]): Map<string, RawNode> {
	return new Map(nodes.map((n) => [n.slug as string, n]));
}

function measured(report: AuditReport): number {
	const value = report.metrics[METRIC];
	if (typeof value !== "number") throw new Error(`${METRIC} is not a scalar metric`);
	return value;
}

const MILLS = "470a4ced-1323-4c91-8fd5-0bb3fb4c932a";
const WIZARD = "3193bfb8-d19f-415d-8791-d00ea71a311c";

describe("alias-to-uncorroborated-identity", () => {
	it("counts the Jeff Mills / The Wizard homonym, listed on both sides, once (acceptance case)", () => {
		const report = auditNodes(
			toMap(
				artist("artist:jeff-mills", {
					mbid: MILLS,
					genres: [edge("genre:techno")],
					aliases: [edge("artist:the-wizard", "The Wizard")],
				}),
				artist("artist:the-wizard", {
					mbid: WIZARD,
					genres: [edge("genre:garage-rock")],
					aliases: [edge("artist:jeff-mills", "Jeff Mills")],
				}),
			),
		);
		expect(measured(report)).toBe(1);
		expect(report.samples[METRIC]).toEqual(["artist:jeff-mills"]);
		expect(report.cases[METRIC]).toEqual(["artist:jeff-mills <-> artist:the-wizard"]);
	});

	it("counts a one-sided alias too, and names the case in slug order whichever side lists it", () => {
		const report = auditNodes(
			toMap(
				artist("artist:b", { mbid: WIZARD }),
				artist("artist:a", { mbid: MILLS, aliases: [edge("artist:b")] }),
			),
		);
		expect(measured(report)).toBe(1);
		expect(report.cases[METRIC]).toEqual(["artist:a <-> artist:b"]);
	});

	it("does not count a pseudonym that shares a genre with its artist", () => {
		const report = auditNodes(
			toMap(
				artist("artist:jeff-mills", {
					mbid: MILLS,
					genres: [edge("genre:techno"), edge("genre:minimal")],
					aliases: [edge("artist:millsart")],
				}),
				artist("artist:millsart", {
					mbid: "1e7a51db-e1a9-4a01-a879-957572988253",
					genres: [edge("genre:techno")],
					aliases: [edge("artist:jeff-mills")],
				}),
			),
		);
		expect(measured(report)).toBe(0);
	});

	it.each([
		["a label", "labels", edge("label:axis")],
		["a release", "discography", edge("project:waveform-transmissions-vol-1")],
		["a similar artist", "similar_artists", edge("artist:robert-hood")],
		["a landmark project", "landmark_project", edge("project:the-bells")],
	])("does not count a pair that shares %s", (_label, field, shared) => {
		const one = field === "landmark_project" ? shared : [shared];
		const report = auditNodes(
			toMap(
				artist("artist:a", { mbid: MILLS, [field]: one, aliases: [edge("artist:b")] }),
				artist("artist:b", { mbid: WIZARD, [field]: one }),
			),
		);
		expect(measured(report)).toBe(0);
	});

	it.each(["members", "collaborators"])(
		"does not count a pair where one side lists the other in %s",
		(field) => {
			const report = auditNodes(
				toMap(
					artist("artist:a", { mbid: MILLS, aliases: [edge("artist:b")] }),
					artist("artist:b", { mbid: WIZARD, [field]: [edge("artist:a")] }),
				),
			);
			expect(measured(report)).toBe(0);
		},
	);

	it("ignores a pair where either side has no mbid: nothing to compare", () => {
		const report = auditNodes(
			toMap(
				artist("artist:a", { mbid: MILLS, aliases: [edge("artist:b"), edge("artist:c")] }),
				artist("artist:b"),
				artist("artist:c", { mbid: "  " }),
			),
		);
		expect(measured(report)).toBe(0);
	});

	it("ignores two nodes with the same mbid (a duplicate, not a homonym) and an alias to a missing node", () => {
		const report = auditNodes(
			toMap(
				artist("artist:a", { mbid: MILLS, aliases: [edge("artist:b"), edge("artist:ghost")] }),
				artist("artist:b", { mbid: MILLS }),
			),
		);
		expect(measured(report)).toBe(0);
	});

	it("is 0 on an empty cache and on artists without aliases", () => {
		expect(measured(auditNodes(new Map()))).toBe(0);
		expect(measured(auditNodes(toMap(artist("artist:a", { mbid: MILLS }))))).toBe(0);
	});

	it("is a ratcheted metric: a missing ceiling or a rise above it is a violation", () => {
		const report = auditNodes(
			toMap(
				artist("artist:a", { mbid: MILLS, aliases: [edge("artist:b")] }),
				artist("artist:b", { mbid: WIZARD }),
			),
		);
		const ceilings = thresholdsFromReport(report);
		expect(ceilings[METRIC]).toBe(1);
		expect(compareWithThresholds(report, ceilings)).toEqual([]);
		expect(compareWithThresholds(report, { ...ceilings, [METRIC]: 0 })).toEqual([
			{ metric: METRIC, measured: 1, threshold: 0 },
		]);
		const { [METRIC]: _dropped, ...without } = ceilings;
		expect(compareWithThresholds(report, without)).toEqual([
			{ metric: METRIC, measured: 1, threshold: null },
		]);
	});
});
