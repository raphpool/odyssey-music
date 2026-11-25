import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import { nodePayloadSchema } from "../src/schemas.js";
import type { GenerateJson } from "../src/translation/translate-node.js";
import type { NodePayload, NodeTranslation, ProjectNode } from "../src/types.js";
import { installPipelineMocks, projectDraftFixture } from "./helpers/pipeline-mocks.js";

// TRA-809: the translation is attached once, after enrichment, by an injected dependency. The Gemini provider
// is the external boundary and is replaced; the pipeline, the node schema and the translator are the real ones.
const generateJson = vi.hoisted(() => ({ impl: undefined as GenerateJson | undefined }));
vi.mock("../src/translation/gemini-generate.js", () => ({
	createGeminiGenerateJson: (): GenerateJson => (request) => {
		if (!generateJson.impl) throw new Error("unexpected provider call");
		return generateJson.impl(request);
	},
}));

async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;
const RG_MBID = "bbbbbbbb-1111-4111-8111-000000000022";
const INPUT: PipelineInput = { type: "project", name: "New Forms", artist: "Roni Size" };

const VALID_BLOCK: NodeTranslation = {
	teaser: "Un album fondateur de la jungle.",
	article:
		"Un long article en français, rédigé pour dépasser largement le seuil des quatre-vingts caractères.",
	source_sha256: "a".repeat(64),
	model: "test-model",
	translated_at: "2026-11-24T10:00:00.000Z",
};

async function resolvedProject(draftExtra: Record<string, unknown> = {}) {
	installPipelineMocks({ draft: { ...projectDraftFixture("New Forms", "Roni Size"), ...draftExtra } });
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

afterEach(() => {
	vi.useRealTimers();
	generateJson.impl = undefined;
});

describe("translation at materialization (TRA-809)", () => {
	it(
		"renders a node without any l10n key when no translate is injected",
		async () => {
			await resolvedProject();
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, DEPS);

			expect("l10n" in result.node).toBe(false);
		},
		TIMEOUT_MS,
	);

	it(
		"attaches a valid block as l10n.fr, and translate sees the node as MusicBrainz enriched it",
		async () => {
			await resolvedProject();
			const translate = vi.fn(async (_node: NodePayload) => VALID_BLOCK);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, { ...DEPS, translate });

			expect(result.node.l10n).toEqual({ fr: VALID_BLOCK });
			expect(nodePayloadSchema.safeParse(result.node).success).toBe(true);
			expect(translate).toHaveBeenCalledTimes(1);
			const seen = translate.mock.calls[0]?.[0];
			expect(seen).toMatchObject({ type: "project", mbid: RG_MBID });
			// Same edges as the rendered node: nothing is added after the translation reads it.
			const { l10n: _l10n, ...rendered } = result.node as ProjectNode;
			expect(rendered.artists.length).toBeGreaterThan(0);
			expect(seen).toMatchObject({ artists: rendered.artists });
		},
		TIMEOUT_MS,
	);

	it.each([
		["returns null", async () => null],
		[
			"throws",
			async () => {
				throw new Error("provider down");
			},
		],
		[
			"returns a block that fails the schema (article of 10 characters)",
			async () => ({ ...VALID_BLOCK, article: "trop court" }),
		],
	])(
		"renders the node without l10n, and does not fail, when translate %s",
		async (_label, impl) => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, {
				...DEPS,
				translate: impl as NonNullable<PipelineDeps["translate"]>,
				logger: (line) => lines.push(line),
			});

			expect(result.node.slug).toBeTruthy();
			expect("l10n" in result.node).toBe(false);
			expect(lines.some((line) => line.includes("translation"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"never keeps an l10n the drafting model invented",
		async () => {
			await resolvedProject({ l10n: { fr: VALID_BLOCK } });
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, DEPS);

			expect("l10n" in result.node).toBe(false);
		},
		TIMEOUT_MS,
	);

	it(
		"gives up on translate after stepTimeoutMs and renders the node without l10n",
		async () => {
			await resolvedProject();
			// Imported here, not at the top: config.ts reads GEMINI_API_KEY at import, after the mocks stub it.
			const { stepTimeoutMs } = (await import("../src/config.js")).translationConfig;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let calls = 0;
			// The step's timer is armed before translate is called: advancing the fake clock here is the deadline.
			const translate = vi.fn(() => {
				calls++;
				vi.advanceTimersByTime(stepTimeoutMs);
				return new Promise<NodeTranslation | null>(() => {});
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, { ...DEPS, translate });

			expect(calls).toBe(1);
			expect("l10n" in result.node).toBe(false);
		},
		TIMEOUT_MS,
	);
});

describe("makePipelineTranslator (TRA-809)", () => {
	const GENRE = {
		type: "genre",
		slug: "genre:jungle",
		name: "Jungle",
		editorial_article: "A real long article about this genre, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_definition: "A short definition.",
	} as unknown as NodePayload;

	it.each([
		[
			"invalid_output",
			async () => ({ ok: true as const, text: "not json", inputTokens: 1, outputTokens: 1 }),
		],
		["quota_exhausted", async () => ({ ok: false as const, reason: "quota_exhausted" as const })],
	])("returns null and logs the reason, never the text, for %s", async (reason, impl) => {
		generateJson.impl = impl;
		const lines: string[] = [];
		const { makePipelineTranslator } = await import("../src/translation/pipeline-translator.js");
		const translate = makePipelineTranslator({ apiKey: "k", logger: (line) => lines.push(line) });

		expect(await translate(GENRE)).toBeNull();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`reason=${reason}`);
		expect(lines[0]).not.toContain("not json");
		expect(lines[0]).toMatch(/tokens=\d+\/\d+ cost=\$/);
	});
});
