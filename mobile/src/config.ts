export type AppEnvironment = "development" | "preview" | "production";

export type PublicConfig = {
	appEnvironment: AppEnvironment;
	apiBaseUrl: string;
	segmentWriteKey?: string;
	easProjectId?: string;
};

export type ConfigError = {
	code: "MISSING_VALUE" | "INVALID_APP_ENV" | "INVALID_API_BASE_URL";
	field: "EXPO_PUBLIC_APP_ENV" | "EXPO_PUBLIC_API_BASE_URL";
	message: string;
};

export type PublicConfigResult = { ok: true; value: PublicConfig } | { ok: false; error: ConfigError };

export type PublicEnvironment = {
	EXPO_PUBLIC_APP_ENV?: string;
	EXPO_PUBLIC_API_BASE_URL?: string;
	EXPO_PUBLIC_SEGMENT_WRITE_KEY?: string;
	EXPO_PUBLIC_EAS_PROJECT_ID?: string;
};

const appEnvironment = process.env.EXPO_PUBLIC_APP_ENV;
const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
const segmentWriteKey = process.env.EXPO_PUBLIC_SEGMENT_WRITE_KEY;
const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;

const runtimeEnvironment: PublicEnvironment = {
	EXPO_PUBLIC_APP_ENV: appEnvironment,
	EXPO_PUBLIC_API_BASE_URL: apiBaseUrl,
	EXPO_PUBLIC_SEGMENT_WRITE_KEY: segmentWriteKey,
	EXPO_PUBLIC_EAS_PROJECT_ID: easProjectId,
};

function error(code: ConfigError["code"], field: ConfigError["field"], message: string): PublicConfigResult {
	return { ok: false, error: { code, field, message } };
}

function normalizeOptionalValue(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized === "" ? undefined : normalized;
}

function normalizeApiBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		const normalizedPathname = url.pathname.replace(/\/+$/, "");
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			!normalizedPathname.endsWith("/mobile/v1")
		) {
			return undefined;
		}

		url.pathname = `${normalizedPathname}/`;
		return url.toString();
	} catch {
		return undefined;
	}
}

export function readPublicConfig(environment: PublicEnvironment = runtimeEnvironment): PublicConfigResult {
	const environmentValue = normalizeOptionalValue(environment.EXPO_PUBLIC_APP_ENV);
	if (environmentValue === undefined) {
		return error("MISSING_VALUE", "EXPO_PUBLIC_APP_ENV", "EXPO_PUBLIC_APP_ENV is required.");
	}

	if (
		environmentValue !== "development" &&
		environmentValue !== "preview" &&
		environmentValue !== "production"
	) {
		return error("INVALID_APP_ENV", "EXPO_PUBLIC_APP_ENV", "EXPO_PUBLIC_APP_ENV must be a supported value.");
	}

	const apiBaseUrlValue = normalizeOptionalValue(environment.EXPO_PUBLIC_API_BASE_URL);
	if (apiBaseUrlValue === undefined) {
		return error("MISSING_VALUE", "EXPO_PUBLIC_API_BASE_URL", "EXPO_PUBLIC_API_BASE_URL is required.");
	}

	const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrlValue);
	if (normalizedApiBaseUrl === undefined) {
		return error(
			"INVALID_API_BASE_URL",
			"EXPO_PUBLIC_API_BASE_URL",
			"EXPO_PUBLIC_API_BASE_URL must be a safe HTTPS mobile API URL.",
		);
	}

	const segmentWriteKeyValue = normalizeOptionalValue(environment.EXPO_PUBLIC_SEGMENT_WRITE_KEY);
	const easProjectIdValue = normalizeOptionalValue(environment.EXPO_PUBLIC_EAS_PROJECT_ID);

	return {
		ok: true,
		value: {
			appEnvironment: environmentValue,
			apiBaseUrl: normalizedApiBaseUrl,
			...(segmentWriteKeyValue === undefined ? {} : { segmentWriteKey: segmentWriteKeyValue }),
			...(easProjectIdValue === undefined ? {} : { easProjectId: easProjectIdValue }),
		},
	};
}
