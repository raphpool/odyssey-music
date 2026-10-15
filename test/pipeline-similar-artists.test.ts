import { describe, expect, it, vi } from "vitest";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import type { ArtistNode, EdgeRef } from "../src/types.js";
import { artistDraftFixture, DEFAULT_ARTIST_MBID, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-480: `similar_artists` is attached once, after the MusicBrainz enrichment, by the injected
// `similarArtists` dependency. ListenBrainz is never called here: the dependency is a double.
//
// Kept apart from test/pipeline-e2e.test.ts (other in-flight PRs append to it); same dynamic import, for
// the same reason (the pipeline-mocks vi.mock calls must register first).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;
const INPUT: PipelineInput = { type: "artist", name: "Fixture Artist" };
const CLIENT_MBID = "11111111-2222-4333-8444-555555555555";

function edge(name: string, extra: Partial<EdgeRef> = {}): EdgeRef {
	return {
		type: "artist",
		slug: `artist:${name.toLowerCase().replace(/\W+/g, "-")}` as EdgeRef["slug"],
		name,
		...extra,
	};
}

describe("similar_artists at materialization (TRA-480)", () => {
	it(
		"writes the edges the dependency returns, mbid kept on each, after the MusicBrainz enrichment",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const edges = [
				edge("Alpha", { mbid: "aaaaaaaa-0000-4000-8000-000000000001" }),
				edge("Beta", { mbid: "aaaaaaaa-0000-4000-8000-000000000002" }),
				edge("Gamma", { mbid: "aaaaaaaa-0000-4000-8000-000000000003" }),
			];
			const similarArtists = vi.fn(async (_artist: ArtistNode) => edges);

			const result = await runPipeline(INPUT, { ...DEPS, similarArtists });

			expect((result.node as ArtistNode).similar_artists).toEqual(edges);
			expect(similarArtists).toHaveBeenCalledTimes(1);
			// The server's own MusicBrainz resolution is what the lookup is keyed on.
			expect(similarArtists.mock.calls[0]?.[0]).toMatchObject({
				slug: "artist:fixture-artist",
				mbid: DEFAULT_ARTIST_MBID,
			});
		},
		TIMEOUT_MS,
	);

	it(
		"writes the node with similar_artists [] and logs when the dependency throws",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const lines: string[] = [];

			const result = await runPipeline(INPUT, {
				...DEPS,
				similarArtists: async () => {
					throw new Error("listenbrainz exploded");
				},
				logger: (line) => lines.push(line),
			});

			expect(result.slug).toBe("artist:fixture-artist");
			expect((result.node as ArtistNode).similar_artists).toEqual([]);
			expect(lines.some((l) => l.includes("similar artists skipped") && l.includes("exploded"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"defaults to [] when the deps carry no similarArtists",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, DEPS);

			expect((result.node as ArtistNode).similar_artists).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"drops an edge whose slug is not canonical, the artist itself and duplicates, and still writes the node",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const legacy = { type: "artist", slug: "artist:Legacy_Name", name: "Legacy Name" } as EdgeRef;
			const good = edge("Alpha");

			const result = await runPipeline(INPUT, {
				...DEPS,
				similarArtists: async () => [
					legacy,
					edge("Fixture Artist"),
					good,
					good,
					{ ...edge("Not An Artist"), type: "label" } as EdgeRef,
				],
			});

			expect((result.node as ArtistNode).similar_artists).toEqual([good]);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps at most 10 edges",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const many = Array.from({ length: 14 }, (_, i) => edge(`Similar ${String.fromCharCode(97 + i)}`));

			const result = await runPipeline(INPUT, { ...DEPS, similarArtists: async () => many });

			expect((result.node as ArtistNode).similar_artists).toEqual(many.slice(0, 10));
		},
		TIMEOUT_MS,
	);

	it(
		"does not hand a client's unconfirmed mbid to the dependency (graph fallback only)",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const m = await import("../src/musicbrainz.js");
			vi.mocked(m.fetchArtistEntityMb).mockImplementation(async () => null);
			const runPipeline = await loadRunPipeline();
			const similarArtists = vi.fn(async (_artist: ArtistNode) => [] as EdgeRef[]);

			await runPipeline({ ...INPUT, mbid: CLIENT_MBID, mbidIsClientHint: true }, { ...DEPS, similarArtists });

			expect(similarArtists).toHaveBeenCalledTimes(1);
			expect(similarArtists.mock.calls[0]?.[0].mbid).toBeUndefined();
		},
		TIMEOUT_MS,
	);

	it(
		"hands over the mbid of a trusted caller (not an HTTP client)",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const m = await import("../src/musicbrainz.js");
			vi.mocked(m.fetchArtistEntityMb).mockImplementation(async () => null);
			const runPipeline = await loadRunPipeline();
			const similarArtists = vi.fn(async (_artist: ArtistNode) => [] as EdgeRef[]);

			await runPipeline({ ...INPUT, mbid: CLIENT_MBID }, { ...DEPS, similarArtists });

			expect(similarArtists.mock.calls[0]?.[0].mbid).toBe(CLIENT_MBID);
		},
		TIMEOUT_MS,
	);

	it(
		"leaves other node types alone",
		async () => {
			const { genreDraftFixture } = await import("./helpers/pipeline-mocks.js");
			installPipelineMocks({ draft: genreDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const similarArtists = vi.fn(async () => [edge("Alpha")]);

			await runPipeline({ type: "genre", name: "Techno" }, { ...DEPS, similarArtists });

			expect(similarArtists).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);
});
