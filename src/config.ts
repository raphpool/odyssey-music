import { join } from "node:path";
import { readExpoAccessToken } from "./env.js";

export { readApnsPushConfiguration } from "./env.js";

function envString(name: string, fallback: string): string {
	const value = process.env[name];
	return value?.trim() ? value : fallback;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) throw new Error(`${name} must be an integer`);
	return value;
}

// Defined in flags.ts (no import-time effect, unlike this module) and re-exported so callers keep their import.
// It now governs every slug-identity change, not only scoped project/track slugs: see flags.ts.
export { scopedReleaseSlugsEnabled } from "./flags.js";

export const serverConfig = {
	port: envInt("PORT", 18791),
	cacheDir: envString("ODYSSEY_CACHE_DIR", join(process.cwd(), "cache")),
	mobileStateDir: envString("MOBILE_STATE_DIR", join(process.cwd(), "mobile-state")),
	expoAccessToken: readExpoAccessToken(),
	mobileApnsPushEnabled: process.env.MOBILE_APNS_PUSH_ENABLED === "true",
};

export const streamConfig = {
	cacheDir: envString("STREAM_CACHE_DIR", join(serverConfig.cacheDir, "..", "stream-cache")),
	maxCacheBytes: envInt("STREAM_CACHE_MAX_BYTES", 5 * 1024 * 1024 * 1024),
	ytdlpBridgeUrl: envString("YTDLP_BRIDGE_URL", "http://127.0.0.1:18889"),
};

export const musicBrainzConfig = {
	baseUrl: envString("MB_BASE_URL", "https://musicbrainz.org/ws/2"),
	// 2026-10-19 (TRA-626): the default used to carry a personal e-mail address, sent in a header on every
	// request. MusicBrainz only needs a way to reach the author: a contact URL does that, no personal data.
	userAgent: envString("MB_USER_AGENT", "odyssey-music/0.1 ( https://dropcliffs.com/labs/odyssey )"),
	fetchTimeoutMs: envInt("MB_FETCH_TIMEOUT_MS", 4000),
	cacheTtlMs: envInt("MB_CACHE_TTL_MS", 5 * 60 * 1000),
	cacheMaxEntries: envInt("MB_CACHE_MAX", 500),
	// 2026-10-14 (TRA-450): MusicBrainz allows 1 request/second per client. 0 disables spacing.
	minIntervalMs: envInt("MB_MIN_INTERVAL_MS", 1000),
};

// 2026-10-15 (TRA-468): ListenBrainz labs similar-artists, free and keyless. Its policy is 1 request/second
// and a descriptive User-Agent (the MusicBrainz one is reused). 0 disables spacing.
export const listenBrainzConfig = {
	baseUrl: "https://labs.api.listenbrainz.org",
	algorithm: envString(
		"LISTENBRAINZ_ALGORITHM",
		"session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30",
	),
	minIntervalMs: envInt("LISTENBRAINZ_MIN_INTERVAL_MS", 1000),
};

export const pipelineConfig = {
	geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
	defaultModel: envString("GEMINI_MODEL", "gemini-2.5-flash-lite"),
	temperature: Number.parseFloat(envString("GEMINI_TEMPERATURE", "0.95")),
	retryDelayMs: envInt("GEMINI_RETRY_DELAY_MS", 600),
	maxCorpusBytes: envInt("PIPELINE_MAX_CORPUS_BYTES", 80_000),
	perPageBudgetBytes: envInt("PIPELINE_PER_PAGE_BUDGET_BYTES", 60_000),
	searchResults: envInt("PIPELINE_SEARCH_RESULTS", 7),
	fetchTopKWithWiki: envInt("PIPELINE_FETCH_TOP_K_WITH_WIKI", 2),
	fetchTopKNoWiki: envInt("PIPELINE_FETCH_TOP_K_NO_WIKI", 3),
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
