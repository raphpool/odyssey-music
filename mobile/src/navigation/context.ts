import type { AnalyticsSource } from "../analytics/contracts";
import { isUuid } from "../analytics/contracts";

const navigationSources = new Set<AnalyticsSource>([
	"app",
	"onboarding",
	"settings",
	"home",
	"search",
	"relation",
	"notification",
	"deeplink",
]);

export type NodeNavigationContext = {
	source: AnalyticsSource;
	recommendation_id?: string;
	notification_id?: string;
};

export type NodeNavigationParams = {
	slug: string;
	source: AnalyticsSource;
	recommendation_id?: string;
	notification_id?: string;
};

function firstString(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) return value[0];
	return undefined;
}

function publicIdentifier(value: unknown): string | undefined {
	const candidate = firstString(value);
	return candidate !== undefined && isUuid(candidate) ? candidate : undefined;
}

export function readNodeNavigationContext(params: Readonly<Record<string, unknown>>): NodeNavigationContext {
	const sourceValue = firstString(params.source);
	const source =
		sourceValue !== undefined && navigationSources.has(sourceValue as AnalyticsSource)
			? (sourceValue as AnalyticsSource)
			: "deeplink";
	// Deep-link attribution is copied into analytics, so accept only opaque public ids, never arbitrary text.
	const recommendationId = publicIdentifier(params.recommendation_id);
	const notificationId = publicIdentifier(params.notification_id);

	return {
		source,
		...(recommendationId === undefined ? {} : { recommendation_id: recommendationId }),
		...(notificationId === undefined ? {} : { notification_id: notificationId }),
	};
}

export function nodeNavigationParams(slug: string, context: NodeNavigationContext): NodeNavigationParams {
	return {
		slug,
		source: context.source,
		...(context.recommendation_id === undefined ? {} : { recommendation_id: context.recommendation_id }),
		...(context.notification_id === undefined ? {} : { notification_id: context.notification_id }),
	};
}
