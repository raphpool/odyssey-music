export const MOBILE_API_PREFIX = "/mobile/v1";
export const MOBILE_NODE_TYPES = ["artist", "project", "track", "genre", "label"] as const;
export const MOBILE_CATALOG_MAX_IDENTITIES = 20;
export const MOBILE_CATALOG_MAX_IDENTITIES_BYTES = 8 * 1024;

export type MobileNodeType = (typeof MOBILE_NODE_TYPES)[number];

export interface MobileCatalogNode {
	identity: string;
	type: MobileNodeType;
	name: string;
	teaser: string | null;
}

export interface MobileCatalogEdge {
	source: string;
	target: string;
	type: string;
}

export interface MobileCatalogResponse {
	version: "v1";
	revision: string;
	taxonomy: {
		mode: "degraded";
		available: boolean;
	};
	nodes: MobileCatalogNode[];
	edges: MobileCatalogEdge[];
}

export type MobileApiErrorCode =
	| "catalog_unavailable"
	| "invalid_request"
	| "method_not_allowed"
	| "not_found";

export interface MobileApiError {
	error: {
		code: MobileApiErrorCode;
		message: string;
	};
}

export function isMobileNodeType(value: string): value is MobileNodeType {
	return (MOBILE_NODE_TYPES as readonly string[]).includes(value);
}
