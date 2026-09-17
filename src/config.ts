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
	anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
	defaultModel: envString("ANTHROPIC_MODEL", "claude-haiku-4-5"),
	temperature: Number.parseFloat(envString("ANTHROPIC_TEMPERATURE", "0.95")),
	// 2026-09-16 (TRA-239): the model's max output tokens for one node-draft call. Node JSON
	// payloads (editorial prose + edge arrays) run well under this; kept generous rather than
	// tight so a large discography/tracklist can't trip `stop_reason: "max_tokens"`.
	maxOutputTokens: envInt("ANTHROPIC_MAX_OUTPUT_TOKENS", 8192),
	maxCorpusBytes: envInt("PIPELINE_MAX_CORPUS_BYTES", 80_000),
	perPageBudgetBytes: envInt("PIPELINE_PER_PAGE_BUDGET_BYTES", 60_000),
	searchResults: envInt("PIPELINE_SEARCH_RESULTS", 7),
	fetchTopKWithWiki: envInt("PIPELINE_FETCH_TOP_K_WITH_WIKI", 1),
	fetchTopKNoWiki: envInt("PIPELINE_FETCH_TOP_K_NO_WIKI", 3),
	nodeTtlMs: envInt("ODYSSEY_NODE_TTL_MS", 12 * 3600 * 1000),
};

export const pricingConfig = {
	// Claude Haiku 4.5 (TRA-239): $1 / 1M input tokens, $5 / 1M output tokens.
	claudeHaikuInputUsdPerMillion: Number.parseFloat(envString("CLAUDE_HAIKU_INPUT_USD_PER_MILLION", "1.00")),
	claudeHaikuOutputUsdPerMillion: Number.parseFloat(envString("CLAUDE_HAIKU_OUTPUT_USD_PER_MILLION", "5.00")),
};

export const cliConfig = {
	webhookAllowlist: envString("ODYSSEY_WEBHOOK_ALLOW", "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean),
};
