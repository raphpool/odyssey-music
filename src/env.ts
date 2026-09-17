export interface ApiEnv {
	GEMINI_API_KEY: string;
	TAVILY_API_KEY: string;
	FIRECRAWL_API_KEY: string;
}

export interface LoadEnvOptions {
	// 2026-09-17 (TRA-242): which web-search backend the caller intends to use. Defaults to
	// "tavily", which keeps the strict pre-existing contract (TAVILY_API_KEY always required) —
	// every caller that omits this option (server, materialize-service, scripts) is unaffected.
	// Only "firecrawl" relaxes the TAVILY_API_KEY requirement.
	searchProvider?: "tavily" | "firecrawl";
}

export function loadEnv(opts: LoadEnvOptions = {}): ApiEnv {
	const searchProvider = opts.searchProvider ?? "tavily";
	const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
	const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "";
	const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
	const missing: string[] = [];
	if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
	if (!TAVILY_API_KEY && searchProvider === "tavily") missing.push("TAVILY_API_KEY");
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
