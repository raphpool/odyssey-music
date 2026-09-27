import type { NodeType, SearchResponse } from "../api/contracts";

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 120;
export const SEARCH_LIMIT = 25;

export const SEARCH_NODE_TYPES = [
	"artist",
	"project",
	"track",
	"genre",
	"label",
] as const satisfies readonly NodeType[];
export const SEARCH_FILTERS = ["all", ...SEARCH_NODE_TYPES] as const;

export type SearchFilter = (typeof SEARCH_FILTERS)[number];
export type SearchQueryState = "empty" | "too_short" | "too_long" | "admissible";

export type SearchResult = SearchResponse["hits"][number];

export function normalizeSearchQuery(value: string): string {
	return value.trim();
}

export function searchQueryState(query: string): SearchQueryState {
	if (query.length === 0) return "empty";
	if (query.length < SEARCH_MIN_QUERY_LENGTH) return "too_short";
	if (query.length > SEARCH_MAX_QUERY_LENGTH) return "too_long";
	return "admissible";
}

export function searchType(filter: SearchFilter): NodeType | undefined {
	return filter === "all" ? undefined : filter;
}

export function searchKey(query: string, filter: SearchFilter): string {
	return `${filter}\u0000${query}`;
}

export function resultAvailability(hit: SearchResult): "cached" | "missing" {
	return hit.source === "cache" ? "cached" : "missing";
}

export function resultKey(hit: SearchResult, index: number): string {
	return hit.slug ?? `${hit.source}-${hit.type}-${hit.mbid ?? hit.name}-${index}`;
}
