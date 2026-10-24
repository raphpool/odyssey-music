import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineDeps } from "../src/pipeline.js";
import { installPipelineMocks, trackDraftFixture } from "./helpers/pipeline-mocks.js";

// Review of PR #643 (TRA-551): the artist's own recording printed under another name ("Roni Size Presents",
// credited by Roni Size's own MBID) and a band recording of the same title. TRA-552 made this "ambiguous" when the
// artist's MBID is passed; resolveWork knows it but does not pass it on the second search.
const RONI = "eeeeeeee-6431-4643-8643-000000000001";
const BAND = "eeeeeeee-6431-4643-8643-000000000002";
const PRESENTS = "eeeeeeee-6431-4643-8643-0000000000a1";
const BAND_WORK = "eeeeeeee-6431-4643-8643-0000000000a2";

function credit(id: string, name: string) {
	return [{ name, artist: { id, name } }];
}

describe("band credit at JIT: the artist's own work printed under another name (TRA-551, review #643)", () => {
	beforeEach(() => installPipelineMocks({ draft: trackDraftFixture("R643 Title", "Roni Size") }));

	it("does not give the artist's track the band's recording when the artist's own one exists", async () => {
		const actual = await vi.importActual<typeof import("../src/musicbrainz.js")>("../src/musicbrainz.js");
		const m = await import("../src/musicbrainz.js");
		vi.mocked(m.resolveRecordingDetailed).mockImplementation(actual.resolveRecordingDetailed);
		vi.mocked(m.fetchArtistProfileMb).mockImplementation(actual.fetchArtistProfileMb);
		vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
		vi.mocked(m.fetchTrackMetaMb).mockImplementation(async () => ({
			project: null,
			label: null,
			artists: [],
			year: null,
			duration: null,
			producers: [],
			personnel: [],
		}));
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				urls.push(input.pathname);
				const body = input.pathname.endsWith("/recording")
					? {
							count: 2,
							recordings: [
								{ id: PRESENTS, title: "R643 Title", "artist-credit": credit(RONI, "Roni Size Presents") },
								{
									id: BAND_WORK,
									title: "R643 Title",
									"artist-credit": credit(BAND, "Roni Size / Reprazent"),
								},
							],
						}
					: {
							id: RONI,
							name: "Roni Size",
							type: "Person",
							relations: [
								{
									type: "member of band",
									direction: "forward",
									artist: { id: BAND, name: "Roni Size / Reprazent" },
								},
							],
						};
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const runPipeline = (await import("../src/pipeline.js")).runPipeline;
		const deps: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
		const result = await runPipeline(
			{ type: "track", name: "R643 Title", artist: "Roni Size", artistMbid: RONI },
			deps,
		);
		expect((result.node as { mbid?: string }).mbid).not.toBe(BAND_WORK);
	});
});
