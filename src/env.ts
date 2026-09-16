export interface ApiEnv {
	ANTHROPIC_API_KEY: string;
	TAVILY_API_KEY: string;
	FIRECRAWL_API_KEY: string;
}

export function loadEnv(): ApiEnv {
	const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
	const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "";
	const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
	const missing: string[] = [];
	if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
	if (!TAVILY_API_KEY) missing.push("TAVILY_API_KEY");
	if (!FIRECRAWL_API_KEY) missing.push("FIRECRAWL_API_KEY");
	if (missing.length) {
		throw new Error(
			`Missing required env vars: ${missing.join(", ")}. ` +
				"Set them in the shell or a .env loaded by the caller.",
		);
	}
	return { ANTHROPIC_API_KEY, TAVILY_API_KEY, FIRECRAWL_API_KEY };
}
