export interface ApiEnv {
	GEMINI_API_KEY: string;
	TAVILY_API_KEY: string;
	FIRECRAWL_API_KEY: string;
}

// Expo's server-side access token is intentionally kept out of ApiEnv: loadEnv is also
// used by command-line materialization, which must not require notification credentials.
export function readExpoAccessToken(): string | undefined {
	const value = process.env.EXPO_ACCESS_TOKEN;
	if (value === undefined || value === "") return undefined;
	if (value.trim() !== value || /[\r\n]/.test(value) || value.length > 1024) {
		throw new Error("EXPO_ACCESS_TOKEN must be a non-empty single-line server secret");
	}
	return value;
}

export interface ApnsPushConfiguration {
	keyId: string;
	teamId: string;
	privateKeyPath: string;
	topics: { preview: string; production: string };
}

// APNs credentials stay server-side. Returning undefined when the complete group is absent keeps
// the music API usable before native push is configured; a partial group is an operator error.
export function readApnsPushConfiguration(): ApnsPushConfiguration | undefined {
	const keyId = process.env.APNS_KEY_ID;
	const teamId = process.env.APNS_TEAM_ID;
	const privateKeyPath = process.env.APNS_PRIVATE_KEY_PATH;
	const preview = process.env.APNS_TOPIC_PREVIEW;
	const production = process.env.APNS_TOPIC_PRODUCTION;
	const values = [keyId, teamId, privateKeyPath, preview, production];
	if (values.every((value) => value === undefined || value === "")) return undefined;
	if (!keyId || !teamId || !privateKeyPath || !preview || !production) {
		throw new Error("APNs configuration requires key id, team id, private key path, and both topics");
	}
	if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId)) {
		throw new Error("APNs key id and team id must be ten uppercase alphanumeric characters");
	}
	if (!privateKeyPath.startsWith("/") || /[\r\n]/.test(privateKeyPath)) {
		throw new Error("APNS_PRIVATE_KEY_PATH must be an absolute single-line path");
	}
	if (preview !== "com.dropcliffs.track1.preview" || production !== "com.dropcliffs.track1") {
		throw new Error("APNs topics do not match the verified track1 bundle identifiers");
	}
	return {
		keyId,
		teamId,
		privateKeyPath,
		topics: { preview, production },
	};
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
