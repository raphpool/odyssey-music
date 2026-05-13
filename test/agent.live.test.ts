import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent.js";
import type { NodePayload } from "../src/types.js";

const HAVE_KEYS =
	Boolean(process.env.GEMINI_API_KEY) &&
	Boolean(process.env.TAVILY_API_KEY) &&
	Boolean(process.env.FIRECRAWL_API_KEY);

const deps = (): { tavilyApiKey: string; firecrawlApiKey: string } => ({
	tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
	firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? "",
});

describe.skipIf(!HAVE_KEYS)("agent (live network)", () => {
	it("materializes a track node from free text", async () => {
		const r = await runAgent({ text: "jan jelinek tendency" }, deps());
		assertNode(r.node, "track");
	}, 180_000);

	it("materializes an artist node from a structured input", async () => {
		const r = await runAgent({ type: "artist", name: "Aphex Twin" }, deps());
		assertNode(r.node, "artist");
	}, 180_000);

	it("materializes a label node from a free-text query", async () => {
		const r = await runAgent({ text: "Warp Records label" }, deps());
		assertNode(r.node, "label");
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
