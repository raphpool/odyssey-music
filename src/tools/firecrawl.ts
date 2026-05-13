import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface FirecrawlScrapeResult {
	markdown: string;
	url: string;
	title?: string;
}

export async function firecrawlScrape(
	apiKey: string,
	url: string,
	signal?: AbortSignal,
): Promise<FirecrawlScrapeResult> {
	const init: RequestInit = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
	};
	if (signal) init.signal = signal;
	const res = await fetch("https://api.firecrawl.dev/v1/scrape", init);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Firecrawl HTTP ${res.status}: ${text.slice(0, 500)}`);
	}
	const data = (await res.json()) as {
		success?: boolean;
		data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } };
		error?: string;
	};
	if (data.success === false) {
		throw new Error(`Firecrawl failure: ${data.error ?? "unknown"}`);
	}
	const md = data.data?.markdown ?? "";
	const result: FirecrawlScrapeResult = {
		markdown: md,
		url: data.data?.metadata?.sourceURL ?? url,
	};
	const title = data.data?.metadata?.title;
	if (title !== undefined) result.title = title;
	return result;
}

const MAX_MARKDOWN_RETURN = 12_000;

export function makeFirecrawlTool(apiKey: string): AgentTool {
	return {
		name: "fetch_page",
		label: "Fetch page (Firecrawl)",
		description:
			"Fetch a URL and return its main content as markdown. Use this AFTER web_search to read " +
			"a specific authoritative page (Discogs, Wikipedia, label site, RYM, etc.) for ground truth " +
			"about an entity. Returns at most ~12000 chars of markdown.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL to fetch", format: "uri" }),
		}),
		executionMode: "parallel",
		execute: async (_id, params, signal) => {
			const args = params as { url: string };
			const scraped = await firecrawlScrape(apiKey, args.url, signal);
			const text =
				scraped.markdown.length > MAX_MARKDOWN_RETURN
					? `${scraped.markdown.slice(0, MAX_MARKDOWN_RETURN)}\n\n[truncated]`
					: scraped.markdown;
			return {
				content: [
					{
						type: "text",
						text: `# ${scraped.title ?? "(no title)"}\nURL: ${scraped.url}\n\n${text}`,
					},
				],
				details: { url: scraped.url, length: scraped.markdown.length },
			};
		},
	};
}
