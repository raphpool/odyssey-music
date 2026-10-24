import { describe, expect, it } from "vitest";
import { auditNodes, type RawNode } from "../scripts/audit-cache.js";

// TRA-557: the `duplicate-list-edges` metric, ceiling 0 once 2026-10-24-dedupe-list-edges has run.

function edge(slug: string, extra: RawNode = {}): RawNode {
	return { slug, type: slug.slice(0, slug.indexOf(":")), name: slug.slice(slug.indexOf(":") + 1), ...extra };
}

function node(slug: string, fields: RawNode = {}): RawNode {
	return { slug, type: slug.slice(0, slug.indexOf(":")), name: slug, ...fields };
}

function count(nodes: RawNode[]): number {
	const report = auditNodes(new Map(nodes.map((n) => [n.slug as string, n])));
	return report.metrics["duplicate-list-edges"] as number;
}

describe("duplicate-list-edges", () => {
	it("counts each entry that repeats the slug of an earlier entry of the same list", () => {
		const artist = node("artist:a", {
			discography: [
				edge("project:t--a", { mbid: "1" }),
				edge("project:u--a"),
				edge("project:t--a", { mbid: "2" }),
				edge("project:t--a", { mbid: "3" }),
			],
		});

		// Three entries of one slug: two extra.
		expect(count([artist])).toBe(2);
	});

	it("looks at every list field of every type, and names the case", () => {
		const project = node("project:p--a", {
			tracklist: [edge("track:t--a"), edge("track:t--a")],
			personnel: [edge("artist:v"), edge("artist:v")],
		});
		const report = auditNodes(new Map([[project.slug as string, project]]));

		expect(report.metrics["duplicate-list-edges"]).toBe(2);
		expect(report.cases["duplicate-list-edges"]).toEqual([
			"project:p--a tracklist track:t--a x2",
			"project:p--a personnel artist:v x2",
		]);
		expect(report.samples["duplicate-list-edges"]).toEqual(["project:p--a"]);
	});

	it("does not count the same slug in two different lists, nor a clean list", () => {
		const artist = node("artist:a", {
			discography: [edge("project:t--a"), edge("project:u--a")],
			notable_tracks: [edge("track:t--a")],
			labels: [edge("label:x")],
		});
		const label = node("label:y", { roster: [edge("artist:a")], genres: [edge("genre:g")] });

		expect(count([artist, label])).toBe(0);
	});
});
