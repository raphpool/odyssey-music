import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import type { ArtistNode } from "../src/types.js";
import { genreDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-28 review B2: `topUpDangling` (scripts/top-up-dangling.ts) selects a dangling target by
// its already-canonicalized slug but used to materialize it from its display name alone. `crawl`
// dynamically imports its module for the same reason test/pipeline-e2e.test.ts imports
// runPipeline dynamically: the module graph statically pulls in pipeline.js ->
// musicbrainz.js/tavily.js/local-fetcher.js/@anthropic-ai/sdk, which must stay mocked -- see that
// file's comment on import-order hazards with Biome's sorter.
async function loadTopUpDangling() {
	return (await import("../scripts/top-up-dangling.js")).topUpDangling;
}

const ENV: ApiEnv = { ANTHROPIC_API_KEY: "test", TAVILY_API_KEY: "test", FIRECRAWL_API_KEY: "test" };
const TIMEOUT_MS = 5_000;

/** Minimal valid ArtistNode referencing a dangling genre by an already-canonicalized edge:
 * slug "genre:electronic", display name "Electronic Music" -- the same slug/name split
 * GenreRegistry.canonicalizeNodeEdges produces for a name variant of an existing genre. */
function artistReferencingDanglingGenre(): ArtistNode {
	return {
		type: "artist",
		slug: "artist:fixture-artist",
		name: "Fixture Artist",
		editorial_bio: "A short bio.",
		editorial_article: "A real long article about this artist, well past the eighty character floor. ".repeat(
			2,
		),
		citations: [{ url: "https://example.com/fixture-artist" }],
		materialized_at: new Date().toISOString(),
		genres: [{ type: "genre", slug: "genre:electronic", name: "Electronic Music", qid: "Q9778" }],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
	};
}

describe("topUpDangling (TRA-28 review B2)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-topup-e2e-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it(
		"materializes a dangling reference under its own slug, and a second run finds nothing left dangling",
		async () => {
			const cache = new NodeCache(dir);
			// "genre:electronic" is dangling: referenced (by name "Electronic Music") but not
			// itself cached yet.
			await cache.write(artistReferencingDanglingGenre());

			// Empty out the fixture's own outbound edges: genreDraftFixture()'s defaults (parent
			// "Electronic", subgenres, related genres, key artists/labels, landmark tracks) would
			// otherwise leave a fresh crop of dangling targets behind and mask the "second run
			// selects nothing" assertion below with edges unrelated to this regression.
			installPipelineMocks({
				draft: genreDraftFixture({
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});
			const topUpDangling = await loadTopUpDangling();

			const first = await topUpDangling(dir, 10, 1, ENV);
			expect(first.targetsFound).toBe(1);
			expect(first.okCount).toBe(1);
			// Before the fix, materializing from t.name alone ("Electronic Music") minted
			// "genre:electronic-music" instead of the actually-dangling "genre:electronic",
			// which then never gets created no matter how many times top-up runs.
			expect(await cache.has("genre:electronic")).toBe(true);
			expect(await cache.has("genre:electronic-music")).toBe(false);

			const second = await topUpDangling(dir, 10, 1, ENV);
			expect(second.targetsFound).toBe(0);
		},
		TIMEOUT_MS,
	);
});
