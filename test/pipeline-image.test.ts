import { describe, expect, it, vi } from "vitest";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import type { ProjectNode } from "../src/types.js";
import { installPipelineMocks, projectDraftFixture } from "./helpers/pipeline-mocks.js";

// TRA-479: the image is picked once, at materialization, from the node as MusicBrainz enriched it.
// The resolver is our own dependency, injected here: no provider is ever called.
//
// Kept apart from test/pipeline-e2e.test.ts (shared with the in-flight TRA-538 work); the same
// dynamic import applies, for the same reason (the pipeline-mocks vi.mock calls must register first).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;
const RG_MBID = "bbbbbbbb-1111-4111-8111-000000000022";
const CAA_URL = `https://coverartarchive.org/release-group/${RG_MBID}/front-500`;
const INPUT: PipelineInput = { type: "project", name: "New Forms", artist: "Roni Size" };

/** MusicBrainz resolves the release group "New Forms" to RG_MBID, credited to Roni Size. */
async function resolvedProject() {
	installPipelineMocks({ draft: projectDraftFixture("New Forms", "Roni Size") });
	const m = await import("../src/musicbrainz.js");
	vi.mocked(m.resolveReleaseGroup).mockImplementation(async () => ({
		mbid: RG_MBID,
		title: "New Forms",
		credit: [{ mbid: "2eeba1d4-0000-4000-8000-000000000001", name: "Roni Size" }],
		primaryType: null,
		firstReleaseDate: null,
		releaseGroupMbid: null,
	}));
	vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
	vi.mocked(m.fetchProjectMetaMb).mockImplementation(async () => ({
		tracks: [],
		label: null,
		artists: [],
		year: null,
		producers: [],
		personnel: [],
		primaryType: "Album",
	}));
}

describe("image at materialization (TRA-479)", () => {
	it(
		"sets image_url and image_source from the resolver, which sees the MBID MusicBrainz settled on",
		async () => {
			await resolvedProject();
			const resolveImage = vi.fn(async () => ({ url: CAA_URL, source: "caa" as const }));
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, { ...DEPS, resolveImage });

			const project = result.node as ProjectNode;
			expect(project.image_url).toBe(CAA_URL);
			expect(project.image_source).toBe("caa");
			expect(resolveImage).toHaveBeenCalledTimes(1);
			expect(resolveImage.mock.calls[0]).toEqual([
				expect.objectContaining({ type: "project", mbid: RG_MBID }),
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"writes the node without an image when the resolver finds none",
		async () => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, {
				...DEPS,
				resolveImage: async () => null,
				logger: (line) => lines.push(line),
			});

			const project = result.node as ProjectNode;
			expect(project.image_url).toBeUndefined();
			expect(project.image_source).toBeUndefined();
			expect(lines.some((l) => l.includes("no image resolved"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"writes the node without an image, and logs, when the resolver throws",
		async () => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, {
				...DEPS,
				resolveImage: async () => {
					throw new Error("coverartarchive.org is down");
				},
				logger: (line) => lines.push(line),
			});

			expect((result.node as ProjectNode).image_url).toBeUndefined();
			expect(result.node.name).toBe("New Forms");
			expect(lines.some((l) => l.includes("image resolution skipped") && l.includes("is down"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"never writes a URL the allow-list refuses, and does not fail the node over it",
		async () => {
			for (const url of [
				"https://evil.example.com/cover.jpg",
				`https://coverartarchive.org:8443/release-group/${RG_MBID}/front-500`,
				`http://coverartarchive.org/release-group/${RG_MBID}/front-500`,
				"javascript:alert(1)",
			]) {
				await resolvedProject();
				const lines: string[] = [];
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(INPUT, {
					...DEPS,
					resolveImage: async () => ({ url, source: "caa" as const }),
					logger: (line) => lines.push(line),
				});

				expect((result.node as ProjectNode).image_url, url).toBeUndefined();
				expect(
					lines.some((l) => l.includes("image refused")),
					url,
				).toBe(true);
			}
		},
		TIMEOUT_MS,
	);

	it(
		"changes nothing when the deps carry no resolveImage",
		async () => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, { ...DEPS, logger: (line) => lines.push(line) });

			expect((result.node as ProjectNode).image_url).toBeUndefined();
			expect(lines.some((l) => l.includes("image"))).toBe(false);
		},
		TIMEOUT_MS,
	);
});

// TRA-538 x TRA-479: a work's mbid is the server's, never the client's alone. The real resolver runs
// here, on a stubbed `fetch` (no provider is reached), to prove the CAA cover of an unconfirmed client
// mbid is never asked for, let alone written.
describe("image of a work asked with a client mbid (TRA-479, TRA-538)", () => {
	const CLIENT_MBID = "cccccccc-1111-4111-8111-000000000033";

	/** A `fetch` where Cover Art Archive has a cover for every release group and nothing else answers. */
	function stubbedFetch() {
		const asked: string[] = [];
		const impl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			asked.push(url);
			if (url.startsWith("https://coverartarchive.org/release-group/")) {
				return new Response(null, {
					status: 307,
					headers: { location: "https://archive.org/download/mbid-cover/front.jpg" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		return { asked, fetch: impl as unknown as typeof fetch };
	}

	async function resolverOn(fetchImpl: typeof fetch) {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { NodeCache } = await import("../src/cache.js");
		const { resolveImage } = await import("../src/images/resolve-image.js");
		const cache = new NodeCache(await mkdtemp(join(tmpdir(), "odyssey-pipeline-image-")));
		return (node: Parameters<typeof resolveImage>[0]) => resolveImage(node, { cache, fetch: fetchImpl });
	}

	const CLIENT_INPUT: PipelineInput = {
		type: "project",
		name: "New Forms",
		artist: "Roni Size",
		mbid: CLIENT_MBID,
		mbidIsClientHint: true,
	};

	it(
		"does not ask for, nor write, the cover of a client mbid the server's resolution did not confirm",
		async () => {
			await resolvedProject(); // MusicBrainz resolves "New Forms" to RG_MBID, not CLIENT_MBID
			const stub = stubbedFetch();
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(CLIENT_INPUT, { ...DEPS, resolveImage: await resolverOn(stub.fetch) });

			const project = result.node as ProjectNode;
			expect(project.mbid).toBeUndefined();
			expect(project.image_url).toBeUndefined();
			expect(stub.asked.some((u) => u.includes(CLIENT_MBID))).toBe(false);
			expect(stub.asked.some((u) => u.includes("coverartarchive.org"))).toBe(false);
		},
		TIMEOUT_MS,
	);

	it(
		"takes the cover of the client mbid once the server's resolution lands on it",
		async () => {
			await resolvedProject();
			const stub = stubbedFetch();
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(
				{ ...CLIENT_INPUT, mbid: RG_MBID },
				{ ...DEPS, resolveImage: await resolverOn(stub.fetch) },
			);

			const project = result.node as ProjectNode;
			expect(project.mbid).toBe(RG_MBID);
			expect(project.image_url).toBe(CAA_URL);
			expect(project.image_source).toBe("caa");
		},
		TIMEOUT_MS,
	);
});

describe("refresh keeps the existing image (TRA-549)", () => {
	const OLD_URL = "https://coverartarchive.org/release-group/aaaaaaaa-1111-4111-8111-000000000011/front-500";
	const EXISTING = { url: OLD_URL, source: "caa" as const };
	const SLUG = "project:new-forms";
	const REFRESH: PipelineInput = { ...INPUT, slug: SLUG, existingImage: EXISTING };

	async function refresh(resolveImage: PipelineDeps["resolveImage"], lines: string[] = []) {
		await resolvedProject();
		const runPipeline = await loadRunPipeline();
		const deps: PipelineDeps = { ...DEPS, logger: (line) => lines.push(line) };
		if (resolveImage) deps.resolveImage = resolveImage;
		return (await runPipeline(REFRESH, deps)).node as ProjectNode;
	}

	it(
		"keeps the image when the resolver finds nothing",
		async () => {
			const lines: string[] = [];
			const node = await refresh(async () => null, lines);
			expect(node.image_url).toBe(OLD_URL);
			expect(node.image_source).toBe("caa");
			expect(lines.some((l) => l.includes("existing image kept"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps the image when the resolver throws",
		async () => {
			const node = await refresh(async () => {
				throw new Error("coverartarchive.org is down");
			});
			expect(node.image_url).toBe(OLD_URL);
			expect(node.image_source).toBe("caa");
		},
		TIMEOUT_MS,
	);

	it(
		"keeps the image when the resolver proposes a host the allow-list refuses",
		async () => {
			const node = await refresh(async () => ({ url: "https://evil.example.com/c.jpg", source: "caa" }));
			expect(node.image_url).toBe(OLD_URL);
			expect(node.image_source).toBe("caa");
		},
		TIMEOUT_MS,
	);

	it(
		"keeps the image when no resolver is wired at all",
		async () => {
			const node = await refresh(undefined);
			expect(node.image_url).toBe(OLD_URL);
			expect(node.image_source).toBe("caa");
		},
		TIMEOUT_MS,
	);

	it(
		"replaces the image, and its source, when the resolver finds a new valid one",
		async () => {
			const node = await refresh(async () => ({ url: CAA_URL, source: "itunes-verified" as const }));
			expect(node.image_url).toBe(CAA_URL);
			expect(node.image_source).toBe("itunes-verified");
		},
		TIMEOUT_MS,
	);

	it(
		"does not keep an existing image whose host is no longer allowed",
		async () => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();
			const result = await runPipeline(
				{
					...INPUT,
					slug: SLUG,
					existingImage: { url: "https://evil.example.com/old.jpg", source: "legacy" },
				},
				{ ...DEPS, resolveImage: async () => null, logger: (line) => lines.push(line) },
			);
			const node = result.node as ProjectNode;
			expect(node.image_url).toBeUndefined();
			expect(node.image_source).toBeUndefined();
			expect(lines.some((l) => l.includes("existing image dropped"))).toBe(true);
		},
		TIMEOUT_MS,
	);
	it(
		"does not carry an image onto a node when no slug was pinned for the refresh",
		async () => {
			await resolvedProject();
			const runPipeline = await loadRunPipeline();
			const result = await runPipeline(
				{ ...INPUT, existingImage: EXISTING },
				{ ...DEPS, resolveImage: async () => null },
			);
			expect((result.node as ProjectNode).image_url).toBeUndefined();
		},
		TIMEOUT_MS,
	);
});
