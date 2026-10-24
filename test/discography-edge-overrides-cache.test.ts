import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	KEPT_CLOSED,
	POSES,
	RETRACTIONS,
} from "../scripts/migrations/2026-10-23-discography-edge-overrides.js";
import { parseSlug } from "../src/slug.js";

type Obj = Record<string, unknown>;

// The criteria of TRA-652 on the repo's own cache/ (written by this migration's apply, never by hand).
describe("the repo cache/", () => {
	const repoEdge = (artist: string, slug: string): Obj | undefined => {
		const { body } = parseSlug(artist);
		const node = JSON.parse(readFileSync(resolve("cache/nodes/artist", `${body}.json`), "utf8")) as Obj;
		return (node.discography as Obj[]).find((e) => e.slug === slug);
	};

	it.each(POSES.map((p) => [p.edge, p] as const))("%s carries its pinned mbid", (_slug, pose) => {
		expect(repoEdge(pose.artist, pose.edge)).toMatchObject({
			mbid: pose.mbid,
			year: pose.year,
			releaseType: pose.releaseType,
		});
	});

	it.each(KEPT_CLOSED.map((k) => [k.edge, k] as const))("%s stays without mbid", (_slug, kept) => {
		const found = repoEdge(kept.artist, kept.edge);
		expect(found).toBeDefined();
		expect(found).not.toHaveProperty("mbid");
	});

	it.each(RETRACTIONS.map((r) => [r.edge, r] as const))(
		"%s is no longer in the discography",
		(_slug, retraction) => {
			expect(repoEdge(retraction.artist, retraction.edge)).toBeUndefined();
		},
	);
});
