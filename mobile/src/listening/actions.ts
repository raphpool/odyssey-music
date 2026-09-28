import type { NodeType } from "../api/contracts";
import type { NodeNavigationContext } from "../navigation/context";

export type ListeningProvider = "spotify" | "apple_music";
export type ListeningLinkKind = "exact" | "search";
export type ListeningErrorCode = "unsafe_url" | "open_failed";

export type ListeningNode = {
	id: string;
	name: string;
	type: NodeType;
};

export type ListeningAnalytics = {
	trackEvent(name: unknown, properties: unknown, context: NodeNavigationContext): Promise<unknown>;
};

export type OpenExternalListeningOptions = {
	node: ListeningNode;
	provider: ListeningProvider;
	exactUrl?: string | null;
	navigationContext: NodeNavigationContext;
	openUrl(url: string): Promise<unknown>;
	analytics?: ListeningAnalytics;
};

export type ExternalListeningResult =
	| { kind: "opened"; provider: ListeningProvider; linkKind: ListeningLinkKind; url: string }
	| {
			kind: "failed";
			provider: ListeningProvider;
			linkKind: ListeningLinkKind;
			errorCode: ListeningErrorCode;
	  };

const providerHosts: Record<ListeningProvider, string> = {
	spotify: "open.spotify.com",
	apple_music: "music.apple.com",
};

export function providerLabel(provider: ListeningProvider): string {
	return provider === "spotify" ? "Spotify" : "Apple Music";
}

export function fallbackSearchUrl(provider: ListeningProvider, nodeName: string): string {
	const query = encodeURIComponent(nodeName.trim());
	return provider === "spotify"
		? `https://open.spotify.com/search/${query}`
		: `https://music.apple.com/search?term=${query}`;
}

export function isSafeListeningUrl(provider: ListeningProvider, value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname.toLowerCase().replace(/\.$/, "") === providerHosts[provider] &&
			url.username === "" &&
			url.password === "" &&
			url.port === ""
		);
	} catch {
		return false;
	}
}

export async function openExternalListening(
	options: OpenExternalListeningOptions,
): Promise<ExternalListeningResult> {
	const candidate = options.exactUrl;
	const linkKind: ListeningLinkKind = candidate === null || candidate === undefined ? "search" : "exact";
	const url =
		candidate === null || candidate === undefined
			? fallbackSearchUrl(options.provider, options.node.name)
			: candidate;
	if (!isSafeListeningUrl(options.provider, url)) {
		const result: ExternalListeningResult = {
			kind: "failed",
			provider: options.provider,
			linkKind,
			errorCode: "unsafe_url",
		};
		await trackOutcome(options, result);
		return result;
	}
	try {
		await options.openUrl(url);
		const result: ExternalListeningResult = { kind: "opened", provider: options.provider, linkKind, url };
		await trackOutcome(options, result);
		return result;
	} catch {
		const result: ExternalListeningResult = {
			kind: "failed",
			provider: options.provider,
			linkKind,
			errorCode: "open_failed",
		};
		await trackOutcome(options, result);
		return result;
	}
}

async function trackOutcome(
	options: OpenExternalListeningOptions,
	result: ExternalListeningResult,
): Promise<void> {
	if (options.analytics === undefined) return;
	const properties = {
		node_id: options.node.id,
		node_type: options.node.type,
		provider: options.provider,
		link_kind: result.linkKind,
		...(result.kind === "failed" ? { error_code: result.errorCode } : {}),
	};
	try {
		await options.analytics.trackEvent(
			result.kind === "opened" ? "external_listening_opened" : "external_listening_failed",
			properties,
			options.navigationContext,
		);
	} catch {
		// An optional measurement transport must not turn a successfully opened service into a UI error.
	}
}
