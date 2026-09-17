import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/pipeline.js";
import type { NodePayload } from "../src/types.js";

const HAVE_KEYS =
	Boolean(process.env.ANTHROPIC_API_KEY) &&
	Boolean(process.env.TAVILY_API_KEY) &&
	Boolean(process.env.FIRECRAWL_API_KEY);

const deps = (): { tavilyApiKey: string; firecrawlApiKey: string } => ({
	tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
	firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? "",
});

describe.skipIf(!HAVE_KEYS)("pipeline (live network)", () => {
	it("materializes a track node from structured input", async () => {
		const r = await runPipeline({ type: "track", name: "Tendency", disambiguator: "Jan Jelinek" }, deps());
		assertNode(r.node, "track");
	}, 180_000);

	it("materializes an artist node from a structured input", async () => {
		const r = await runPipeline({ type: "artist", name: "Aphex Twin" }, deps());
		assertNode(r.node, "artist");
	}, 180_000);
});

function assertNode(node: NodePayload, expectedType: NodePayload["type"]): void {
	expect(node.type).toBe(expectedType);
	// 2026-09-16 (TRA-239): the 400-char / 3-edge floors this test used to assert came from
	// Gemini's `responseSchema` (minLength:350 on editorial_article, minItems on several edge
	// arrays) — constraints Claude's structured outputs don't support (see the "Anthropic
	// structured-output schema builders" comment in src/pipeline.ts). Only the post-call Zod
	// floor (src/schemas.ts: editorial_article.min(80), citations.min(1)) is still actually
	// guaranteed, so the assertions below are lowered to match reality instead of asserting a
	// guarantee this pipeline no longer makes.
	expect(node.editorial_article.length).toBeGreaterThanOrEqual(80);
	expect(node.citations.length).toBeGreaterThanOrEqual(1);
	const edgeCount = countEdges(node);
	expect(edgeCount).toBeGreaterThanOrEqual(1);
}

function countEdges(node: NodePayload): number {
	let n = 0;
	for (const [, v] of Object.entries(node)) {
		if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] && "slug" in v[0]) {
			n += v.length;
		} else if (v && typeof v === "object" && "slug" in v) {
			n += 1;
		}
	}
	return n;
}
