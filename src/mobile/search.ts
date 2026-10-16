import type { CacheIndex } from "../cache-index.js";
import type { CatalogIndex, CatalogResult } from "../musicbrainz.js";
import { createSearchService, type SearchHit, type SearchResult } from "../services/search-service.js";
import { isMobileNodeType, type MobileNodeType } from "./contracts.js";

const DEFAULT_LIMIT = 8;

export interface MobileSearchRequest {
	q: string;
	type: string | null;
	limit: number;
}

export interface MobileSearch {
	search(request: MobileSearchRequest): Promise<SearchResult>;
	invalidateIndex(): void;
}

export interface MobileSearchDependencies {
	buildIndex(): Promise<CacheIndex>;
	invalidateCacheIndex?(): void;
	catalogIndex: CatalogIndex;
}

export class MobileSearchInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MobileSearchInputError";
	}
}

export class MobileSearchProviderUnavailableError extends Error {
	constructor() {
		super("mobile search provider is temporarily unavailable");
		this.name = "MobileSearchProviderUnavailableError";
	}
}

export function parseMobileSearchRequest(params: URLSearchParams): MobileSearchRequest {
	for (const key of params.keys()) {
		if (key !== "q" && key !== "type" && key !== "limit") {
			throw new MobileSearchInputError("unsupported search query parameter");
		}
	}
	for (const key of ["q", "type", "limit"]) {
		if (params.getAll(key).length > 1)
			throw new MobileSearchInputError(`search parameter ${key} must be unique`);
	}
	const limitRaw = params.get("limit");
	if (limitRaw !== null && !/^\d+$/.test(limitRaw)) {
		throw new MobileSearchInputError("limit must be an integer from 1 to 25");
	}
	return {
		q: params.get("q") ?? "",
		type: params.get("type"),
		limit: limitRaw === null ? DEFAULT_LIMIT : Number.parseInt(limitRaw, 10),
	};
}

export function createMobileSearch(dependencies: MobileSearchDependencies): MobileSearch {
	// No local memo (TRA-548, 2026-10-15): the caller's buildIndex is the shared holder's get() (server.ts),
	// which already shares one build, drops it on invalidate() and never caches a failed build. A second
	// memo here served the pre-write index until restart and froze a rejected build forever.
	const getCacheIndex = (): Promise<CacheIndex> => dependencies.buildIndex();
	const catalogIndex: CatalogIndex = {
		async search(query, limit) {
			return callCatalog(() => dependencies.catalogIndex.search(query, limit));
		},
		async searchByType(type, query, limit) {
			return callCatalog(() => dependencies.catalogIndex.searchByType(type, query, limit));
		},
		close() {},
	};
	const searchService = createSearchService({ getCacheIndex, catalogIndex });

	return {
		async search(request: MobileSearchRequest): Promise<SearchResult> {
			const q = request.q.trim();
			if (q.length < 2 || q.length > 120) {
				throw new MobileSearchInputError("q must contain 2 to 120 characters");
			}
			if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 25) {
				throw new MobileSearchInputError("limit must be an integer from 1 to 25");
			}
			const type = parseType(request.type);
			return deduplicate(await searchService(q, type, request.limit));
		},
		invalidateIndex(): void {
			dependencies.invalidateCacheIndex?.();
		},
	};
}

function parseType(value: string | null): MobileNodeType | null {
	if (value === null) return null;
	if (!isMobileNodeType(value)) throw new MobileSearchInputError("unsupported search type");
	return value;
}

async function callCatalog(action: () => Promise<CatalogResult[]>): Promise<CatalogResult[]> {
	try {
		return await action();
	} catch {
		throw new MobileSearchProviderUnavailableError();
	}
}

function deduplicate(result: SearchResult): SearchResult {
	const mbids = new Set<string>();
	const hits: SearchHit[] = [];
	for (const hit of result.hits) {
		if (hit.source === "cache" && !hit.slug) continue;
		if (hit.mbid) {
			const mbidKey = hit.mbid.toLowerCase();
			if (mbids.has(mbidKey)) continue;
			mbids.add(mbidKey);
		}
		hits.push(hit);
	}
	return {
		q: result.q,
		hits,
		sources: {
			cache: hits.filter((hit) => hit.source === "cache").length,
			catalog: hits.filter((hit) => hit.source === "catalog").length,
		},
	};
}
