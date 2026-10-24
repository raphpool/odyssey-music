import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry, loadRedirects } from "../src/genre-registry.js";
import { createLabelRegistry, type LabelIdentityGroup, loadLabelIdentities } from "../src/label-registry.js";
import type { PipelineDeps } from "../src/pipeline.js";
import type { ArtistNode, LabelNode, ProjectNode, Slug } from "../src/types.js";
import { artistDraftFixture, installPipelineMocks, projectDraftFixture } from "./helpers/pipeline-mocks.js";

// TRA-607, end to end: runPipeline with a real NodeCache, the committed redirect table and the committed
// identity table; only the four external boundaries are mocked (see test/pipeline-e2e.test.ts for why
// runPipeline is imported dynamically).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const TIMEOUT_MS = 5_000;
const WARP_MBID = "46f0f4cd-8aab-4b33-b698-f459faf64190";
const FOO_MBID = "11111111-2222-4333-8444-555555555555";
const OTHER_MBID = "99999999-2222-4333-8444-555555555555";
const AXIS_MBID = "0aa73845-13c6-49fc-935f-82b8db65cd8e";
// One of the seven "Axis Records" of MusicBrainz: the 1979 UK label renamed 4AD.
const FOREIGN_AXIS_MBID = "d6025dee-9ac4-4790-ac52-b83bb032b23e";
const RG_MBID = "bbbbbbbb-1111-4111-8111-000000000022";

let dir: string;
let cache: NodeCache;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "odyssey-pipeline-label-dedup-"));
	cache = new NodeCache(dir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

function labelNode(slug: Slug, name: string, mbid?: string): LabelNode {
	return {
		type: "label",
		slug,
		name,
		editorial_article: "A real long article about this label, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_description: "A short description.",
		citations: [{ url: "https://example.com/label" }],
		materialized_at: "2026-10-24T00:00:00.000Z",
		genres: [],
		roster: [],
		notable_releases: [],
		...(mbid ? { mbid } : {}),
	};
}

/** The registry the server builds, on the committed tables unless `identities` says otherwise. */
async function deps(identities?: readonly LabelIdentityGroup[]): Promise<PipelineDeps> {
	const redirects = await loadRedirects();
	const labels = createLabelRegistry({
		cache,
		redirects,
		identities: identities ?? (await loadLabelIdentities()),
	});
	const genreRegistry = createGenreRegistry({
		cache,
		resolver: await loadGenreResolver(),
		redirects,
		labels,
	});
	return { tavilyApiKey: "test", firecrawlApiKey: "test", genreRegistry };
}

describe("label duplicates at generation (TRA-607)", () => {
	it(
		'points an artist citing "Warp Records" at the surviving label:warp, and mints no label:warp-records',
		async () => {
			await cache.write(labelNode("label:warp", "Warp", WARP_MBID));
			installPipelineMocks({
				draft: artistDraftFixture({
					labels: [
						{ type: "label", name: "Warp Records" },
						{ type: "label", name: "Warp" },
						{ type: "label", name: "Rephlex Records" },
					],
				}),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, await deps());

			const labels = (result.node as ArtistNode).labels;
			// Warp Records and Warp are one edge; Rephlex Records is the loser of its own merge.
			expect(labels.map((l) => l.slug)).toEqual(["label:warp", "label:rephlex"]);
			expect(labels[0]?.name).toBe("Warp Records");
		},
		TIMEOUT_MS,
	);

	it(
		"gives an unproven homonym its own node",
		async () => {
			await cache.write(labelNode("label:stand-high", "Stand High"));
			installPipelineMocks({
				draft: artistDraftFixture({
					labels: [
						{ type: "label", name: "Stand High Records" },
						{ type: "label", name: "Dor et de Platine Records" },
					],
				}),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, await deps());

			expect((result.node as ArtistNode).labels.map((l) => l.slug)).toEqual([
				"label:stand-high-records",
				"label:dor-et-de-platine-records",
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"still follows a redirect when the identity table is absent, and merges no variant on a name",
		async () => {
			await cache.write(labelNode("label:stand-high", "Stand High"));
			installPipelineMocks({
				draft: artistDraftFixture({
					labels: [
						{ type: "label", name: "Warp Records" },
						{ type: "label", name: "Stand High Records" },
					],
				}),
			});
			const runPipeline = await loadRunPipeline();
			const absent = await loadLabelIdentities(join(dir, "missing.identities.json"));

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, await deps(absent));

			expect((result.node as ArtistNode).labels.map((l) => l.slug)).toEqual([
				"label:warp",
				"label:stand-high-records",
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"canonicalizes the label MusicBrainz gives a project when its mbid matches the cached label",
		async () => {
			vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
			await cache.write(labelNode("label:foo", "Foo", FOO_MBID));
			installPipelineMocks({ draft: projectDraftFixture("Fixture Album", "Fixture Artist") });
			const runPipeline = await loadRunPipeline();
			const m = await import("../src/musicbrainz.js");
			vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);

			const run = async (label: { name: string; mbid: string }) => {
				vi.mocked(m.fetchProjectMetaMb).mockImplementation(async () => ({
					tracks: [],
					label,
					artists: [],
					year: null,
					producers: [],
					personnel: [],
					primaryType: "Album",
				}));
				const result = await runPipeline(
					{ type: "project", name: "Fixture Album", artist: "Fixture Artist", mbid: RG_MBID },
					await deps(),
				);
				return (result.node as ProjectNode).label;
			};

			// Same mbid, name with a suffix: the cached label.
			expect(await run({ name: "Foo Records", mbid: FOO_MBID })).toMatchObject({
				slug: "label:foo",
				name: "Foo Records",
				mbid: FOO_MBID,
			});
			// Another mbid under the same normalized name: a homonym, its own slug.
			expect(await run({ name: "Foo Records", mbid: OTHER_MBID })).toMatchObject({
				slug: "label:foo-records",
				mbid: OTHER_MBID,
			});
		},
		TIMEOUT_MS,
	);

	// B1 of the deep review: the committed redirect label:axis-records -> label:axis was followed whatever the
	// mbid, so another "Axis Records" (MusicBrainz has seven) was filed under Jeff Mills's label on disk.
	it(
		"keeps a project released on another Axis Records out of label:axis, with the committed tables",
		async () => {
			vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
			await cache.write(labelNode("label:axis", "Axis", AXIS_MBID));
			installPipelineMocks({ draft: projectDraftFixture("Fixture Album", "Fixture Artist") });
			const runPipeline = await loadRunPipeline();
			const m = await import("../src/musicbrainz.js");
			vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);

			const run = async (label: { name: string; mbid: string }) => {
				vi.mocked(m.fetchProjectMetaMb).mockImplementation(async () => ({
					tracks: [],
					label,
					artists: [],
					year: null,
					producers: [],
					personnel: [],
					primaryType: "Album",
				}));
				const result = await runPipeline(
					{ type: "project", name: "Fixture Album", artist: "Fixture Artist", mbid: RG_MBID },
					await deps(),
				);
				await cache.write(result.node);
				return (result.node as ProjectNode).label;
			};
			const roster = async () => ((await cache.get("label:axis")) as LabelNode).notable_releases;

			expect(await run({ name: "Axis Records", mbid: FOREIGN_AXIS_MBID })).toMatchObject({
				slug: "label:axis-records",
				mbid: FOREIGN_AXIS_MBID,
			});
			expect(await roster()).toEqual([]);

			// Control: Axis's own mbid under the same name does reach the survivor.
			expect(await run({ name: "Axis Records", mbid: AXIS_MBID })).toMatchObject({ slug: "label:axis" });
			expect((await roster()).map((e) => e.slug)).toEqual([expect.stringContaining("fixture-album")]);
		},
		TIMEOUT_MS,
	);
});
