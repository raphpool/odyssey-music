export interface ApiEnv {
	GEMINI_API_KEY: string;
	TAVILY_API_KEY: string;
	FIRECRAWL_API_KEY: string;
}

export function loadEnv(): ApiEnv {
	const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
	const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "";
	const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
	const missing: string[] = [];
	if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
	if (!TAVILY_API_KEY) missing.push("TAVILY_API_KEY");
	if (!FIRECRAWL_API_KEY) missing.push("FIRECRAWL_API_KEY");
	if (missing.length) {
		throw new Error(
			`Missing required env vars: ${missing.join(", ")}. ` +
				"Set them in the shell or a .env loaded by the caller.",
		);
	}
	// pi-ai reads GEMINI_API_KEY from process.env itself, but we re-export for clarity.
	process.env.GEMINI_API_KEY = GEMINI_API_KEY;
	return { GEMINI_API_KEY, TAVILY_API_KEY, FIRECRAWL_API_KEY };
}
