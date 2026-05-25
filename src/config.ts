import { join } from "node:path";

function envString(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.trim() ? value : fallback;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) throw new Error(`${name} must be an integer`);
	return value;
}

export const serverConfig = {
	port: envInt("PORT", 18791),
	cacheDir: envString("ODYSSEY_CACHE_DIR", join(process.cwd(), "cache")),
};

export const streamConfig = {
	cacheDir: envString("STREAM_CACHE_DIR", join(serverConfig.cacheDir, "..", "stream-cache")),
	maxCacheBytes: envInt("STREAM_CACHE_MAX_BYTES", 5 * 1024 * 1024 * 1024),
	ytdlpBridgeUrl: envString("YTDLP_BRIDGE_URL", "http://127.0.0.1:18889"),
};

export const musicBrainzConfig = {
	baseUrl: envString("MB_BASE_URL", "https://musicbrainz.org/ws/2"),
	userAgent: envString(
		"MB_USER_AGENT",
		"odyssey-music/0.1 (hfontanier@gmail.com; https://dropcliffs.com/labs/odyssey)",
	),
	fetchTimeoutMs: envInt("MB_FETCH_TIMEOUT_MS", 4000),
	cacheTtlMs: envInt("MB_CACHE_TTL_MS", 5 * 60 * 1000),
	cacheMaxEntries: envInt("MB_CACHE_MAX", 500),
};

export const pipelineConfig = {
	geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
	defaultModel: envString("GEMINI_MODEL", "gemini-2.5-flash-lite"),
	temperature: Number.parseFloat(envString("GEMINI_TEMPERATURE", "0.95")),
	retryDelayMs: envInt("GEMINI_RETRY_DELAY_MS", 600),
	maxCorpusBytes: envInt("PIPELINE_MAX_CORPUS_BYTES", 80_000),
	perPageBudgetBytes: envInt("PIPELINE_PER_PAGE_BUDGET_BYTES", 60_000),
	searchResults: envInt("PIPELINE_SEARCH_RESULTS", 7),
	fetchTopKWithWiki: envInt("PIPELINE_FETCH_TOP_K_WITH_WIKI", 1),
	fetchTopKNoWiki: envInt("PIPELINE_FETCH_TOP_K_NO_WIKI", 3),
	nodeTtlMs: envInt("ODYSSEY_NODE_TTL_MS", 12 * 3600 * 1000),
};

export const pricingConfig = {
	geminiFlashLiteInputUsdPerMillion: Number.parseFloat(
		envString("GEMINI_FLASH_LITE_INPUT_USD_PER_MILLION", "0.075"),
	),
	geminiFlashLiteOutputUsdPerMillion: Number.parseFloat(
		envString("GEMINI_FLASH_LITE_OUTPUT_USD_PER_MILLION", "0.30"),
	),
};

export const cliConfig = {
	webhookAllowlist: envString("ODYSSEY_WEBHOOK_ALLOW", "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean),
};
