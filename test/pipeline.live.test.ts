import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/pipeline.js";
import type { NodePayload } from "../src/types.js";

const HAVE_KEYS =
	Boolean(process.env.GEMINI_API_KEY) &&
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
	expect(node.editorial_article.length).toBeGreaterThanOrEqual(400);
	expect(node.citations.length).toBeGreaterThanOrEqual(1);
	const edgeCount = countEdges(node);
	expect(edgeCount).toBeGreaterThanOrEqual(3);
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
