import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface TavilyResult {
	title: string;
	url: string;
	content: string;
	score?: number;
}

export async function tavilySearch(
	apiKey: string,
	query: string,
	opts: { max_results?: number; search_depth?: "basic" | "advanced" } = {},
	signal?: AbortSignal,
): Promise<TavilyResult[]> {
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			api_key: apiKey,
			query,
			max_results: opts.max_results ?? 5,
			search_depth: opts.search_depth ?? "basic",
			include_answer: false,
		}),
	};
	if (signal) init.signal = signal;
	const res = await fetch("https://api.tavily.com/search", init);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 500)}`);
	}
	const data = (await res.json()) as { results?: TavilyResult[] };
	return data.results ?? [];
}

export function makeTavilyTool(apiKey: string): AgentTool {
	return {
		name: "web_search",
		label: "Web search (Tavily)",
		description:
			"Search the open web for a query. Returns up to N results with title, url, " +
			"and a short snippet. Use this to find authoritative sources (Discogs, RYM, label sites, " +
			"Wikipedia, music press) about an entity before scraping.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 10, description: "Max results (1-10), default 5" }),
			),
		}),
		executionMode: "parallel",
		execute: async (_id, params, signal) => {
			const args = params as { query: string; max_results?: number };
			const opts: { max_results?: number; search_depth?: "basic" | "advanced" } = {
				search_depth: "basic",
			};
			if (args.max_results !== undefined) opts.max_results = args.max_results;
			const results = await tavilySearch(apiKey, args.query, opts, signal);
			const trimmed = results.map((r) => ({
				title: r.title,
				url: r.url,
				snippet: r.content.slice(0, 400),
			}));
			return {
				content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }],
				details: { count: trimmed.length },
			};
		},
	};
}
