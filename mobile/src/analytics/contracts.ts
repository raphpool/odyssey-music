export const EVENT_NAMES = [
	"app_opened",
	"onboarding_started",
	"onboarding_completed",
	"preferences_updated",
	"daily_recommendation_viewed",
	"daily_recommendation_opened",
	"notification_permission_result",
	"notification_opened",
	"node_viewed",
	"relation_opened",
	"search_submitted",
	"search_result_opened",
	"generation_requested",
	"generation_completed",
	"generation_failed",
	"external_listening_opened",
	"external_listening_failed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];
export type AnalyticsSource =
	| "app"
	| "onboarding"
	| "settings"
	| "home"
	| "search"
	| "relation"
	| "notification"
	| "deeplink";
export type EventContext = {
	source: AnalyticsSource;
	event_id?: string;
	recommendation_id?: string;
	notification_id?: string;
};
export type EventProperties = Record<string, string | number>;
export type ValidationResult =
	| { ok: true; name: EventName; properties: EventProperties; context: EventContext }
	| { ok: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const nodeTypes = new Set(["artist", "project", "track", "genre", "label"]);
const sources = new Set<AnalyticsSource>([
	"app",
	"onboarding",
	"settings",
	"home",
	"search",
	"relation",
	"notification",
	"deeplink",
]);

type Field = (value: unknown) => boolean;
type Rule = { required: Record<string, Field>; optional?: Record<string, Field> };
const string: Field = (value) => typeof value === "string" && value.length > 0;
const uuid: Field = (value) => typeof value === "string" && UUID.test(value);
const date: Field = (value) => typeof value === "string" && DATE.test(value);
const integer: Field = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const oneOf =
	(...values: string[]): Field =>
	(value) =>
		typeof value === "string" && values.includes(value);
const nodeType = oneOf(...nodeTypes);
const attribution = { recommendation_id: string, notification_id: string };
const node = { node_id: string, node_type: nodeType };
const recommendation = { recommendation_id: string, local_date: date, ...node };
const listening = { ...node, provider: oneOf("spotify", "apple_music"), link_kind: oneOf("exact", "search") };

const rules: Record<EventName, Rule> = {
	app_opened: { required: {} },
	onboarding_started: { required: { flow_id: uuid } },
	onboarding_completed: { required: { flow_id: uuid, genres_count: integer } },
	preferences_updated: { required: { genres_count: integer, action: oneOf("updated", "cleared") } },
	daily_recommendation_viewed: { required: recommendation },
	daily_recommendation_opened: { required: recommendation },
	notification_permission_result: { required: { status: oneOf("granted", "denied", "undetermined") } },
	notification_opened: { required: { notification_id: string, target_local_date: date } },
	node_viewed: { required: node, optional: attribution },
	relation_opened: {
		required: { from_node_id: string, ...node, relation_kind: string },
		optional: attribution,
	},
	search_submitted: { required: { filter: oneOf("all", ...nodeTypes) } },
	search_result_opened: {
		required: { node_type: nodeType, availability: oneOf("cached", "missing"), results_count: integer },
		optional: { node_id: string },
	},
	generation_requested: { required: { request_id: uuid, node_type: nodeType } },
	generation_completed: { required: { request_id: uuid, ...node } },
	generation_failed: {
		required: {
			request_id: uuid,
			node_type: nodeType,
			error_code: oneOf("failed", "interrupted", "expired"),
		},
	},
	external_listening_opened: { required: listening, optional: attribution },
	external_listening_failed: {
		required: { ...listening, error_code: oneOf("unsafe_url", "open_failed") },
		optional: attribution,
	},
};
const attributionEvents = new Set<EventName>([
	"node_viewed",
	"relation_opened",
	"external_listening_opened",
	"external_listening_failed",
]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function validProperties(value: unknown, rule: Rule): value is EventProperties {
	const properties = record(value);
	if (properties === undefined) return false;
	const allowed = { ...rule.required, ...rule.optional };
	if (Object.keys(properties).some((key) => !Object.hasOwn(allowed, key))) return false;
	return (
		Object.entries(rule.required).every(
			([key, check]) => Object.hasOwn(properties, key) && check(properties[key]),
		) &&
		Object.entries(rule.optional ?? {}).every(
			([key, check]) =>
				properties[key] === undefined || (Object.hasOwn(properties, key) && check(properties[key])),
		)
	);
}

function validContext(value: unknown, name: EventName, properties: EventProperties): value is EventContext {
	const context = record(value);
	if (
		context === undefined ||
		Object.keys(context).some(
			(key) => !["source", "event_id", "recommendation_id", "notification_id"].includes(key),
		)
	)
		return false;
	const hasAttribution =
		(Object.hasOwn(context, "recommendation_id") && context.recommendation_id !== undefined) ||
		(Object.hasOwn(context, "notification_id") && context.notification_id !== undefined);
	const sameOrAbsent = (key: "recommendation_id" | "notification_id") =>
		context[key] === undefined || properties[key] === undefined || context[key] === properties[key];
	return (
		(!hasAttribution || attributionEvents.has(name)) &&
		Object.hasOwn(context, "source") &&
		sources.has(context.source as AnalyticsSource) &&
		(context.event_id === undefined || (Object.hasOwn(context, "event_id") && uuid(context.event_id))) &&
		(context.recommendation_id === undefined ||
			(Object.hasOwn(context, "recommendation_id") && string(context.recommendation_id))) &&
		(context.notification_id === undefined ||
			(Object.hasOwn(context, "notification_id") && string(context.notification_id))) &&
		sameOrAbsent("recommendation_id") &&
		sameOrAbsent("notification_id")
	);
}

export function validateEvent(name: unknown, properties: unknown, context: unknown): ValidationResult {
	if (!EVENT_NAMES.includes(name as EventName)) return { ok: false };
	const rule = rules[name as EventName];
	if (!validProperties(properties, rule) || !validContext(context, name as EventName, properties))
		return { ok: false };
	return { ok: true, name: name as EventName, properties, context };
}

export function isUuid(value: string): boolean {
	return UUID.test(value);
}

export function isUuidV4(value: string): boolean {
	return UUID_V4.test(value);
}
