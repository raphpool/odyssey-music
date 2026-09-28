import type { ApiClient } from "../api/client";
import { type Catalog, catalogSchema, type NodeType } from "../api/contracts";
import type { ClientError } from "../api/errors";

export const CATALOG_STORAGE_KEY = "track1.offline.catalog.v1";
export const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CATALOG_VERSION = 1 as const;

let catalogStorageMutation = Promise.resolve();
let catalogStorageGeneration = 0;
let catalogClearTransitions = 0;

export type CacheStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
};

type StoredCatalog = {
	version: typeof CATALOG_VERSION;
	catalog: Catalog;
	checkedAt: number;
	etag?: string;
};

export type CachedCatalogResult = {
	value?: Catalog;
	stale: boolean;
	error?: ClientError;
};

function mutateCatalogStorage<T>(operation: () => Promise<T>): Promise<T> {
	const result = catalogStorageMutation.then(operation, operation);
	catalogStorageMutation = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function catalogStorageGenerationForOperation(): number | undefined {
	return catalogClearTransitions === 0 ? catalogStorageGeneration : undefined;
}

export function beginCatalogStorageClear(): () => void {
	catalogStorageGeneration += 1;
	catalogClearTransitions += 1;
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		catalogClearTransitions -= 1;
	};
}

export async function clearCatalogStorage(storage: CacheStorage): Promise<void> {
	const endClear = beginCatalogStorageClear();
	try {
		await mutateCatalogStorage(() => storage.removeItem(CATALOG_STORAGE_KEY));
	} finally {
		endClear();
	}
}

function defaultStorage(): CacheStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as CacheStorage;
	} catch {
		const unavailable = async (): Promise<never> => Promise.reject(new Error("offline cache unavailable"));
		return { getItem: unavailable, setItem: unavailable, removeItem: unavailable };
	}
}

function isStoredCatalog(value: unknown): value is StoredCatalog {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === CATALOG_VERSION &&
		typeof candidate.checkedAt === "number" &&
		Number.isFinite(candidate.checkedAt) &&
		(candidate.etag === undefined || typeof candidate.etag === "string") &&
		catalogSchema.safeParse(candidate.catalog).success
	);
}

function parse(raw: string): StoredCatalog | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		return isStoredCatalog(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function searchCachedCatalog(
	catalog: Catalog,
	query: string,
	type?: NodeType,
	cachedIds = new Set<string>(),
) {
	const normalized = query.trim().toLocaleLowerCase();
	return catalog.nodes
		.filter(
			(node) =>
				(type === undefined || node.type === type) && node.name.toLocaleLowerCase().includes(normalized),
		)
		.map((node) => ({
			source: cachedIds.has(node.identity) ? ("cache" as const) : ("catalog" as const),
			type: node.type,
			name: node.name,
			slug: node.identity,
		}));
}

export class CatalogCache {
	constructor(
		private readonly storage: CacheStorage = defaultStorage(),
		private readonly now: () => number = Date.now,
	) {}

	async read(): Promise<StoredCatalog | undefined> {
		try {
			const raw = await this.storage.getItem(CATALOG_STORAGE_KEY);
			return raw === null ? undefined : parse(raw);
		} catch {
			return undefined;
		}
	}

	async cached(): Promise<Catalog | undefined> {
		return (await this.read())?.catalog;
	}

	async load(
		apiClient: Pick<ApiClient, "getCatalog">,
		options: { forceRevalidate?: boolean } = {},
	): Promise<CachedCatalogResult> {
		const generation = catalogStorageGenerationForOperation();
		const stored = await this.read();
		const current = this.now();
		if (stored !== undefined && current - stored.checkedAt < CATALOG_MAX_AGE_MS && !options.forceRevalidate)
			return { value: stored.catalog, stale: false };

		const result = await apiClient.getCatalog(
			stored?.etag === undefined ? undefined : { etag: stored.etag, hasCachedCopy: true },
		);
		if (result.kind === "success") {
			const next: StoredCatalog = {
				version: CATALOG_VERSION,
				catalog: result.value,
				checkedAt: current,
				...(result.etag === undefined ? {} : { etag: result.etag }),
			};
			await this.save(next, generation);
			return { value: result.value, stale: false };
		}
		if (result.kind === "notModified" && stored !== undefined) {
			const next: StoredCatalog = { ...stored, checkedAt: current, etag: result.etag };
			await this.save(next, generation);
			return { value: stored.catalog, stale: false };
		}
		if (result.kind !== "error") return { stale: false };
		return stored === undefined
			? { stale: false, error: result.error }
			: { value: stored.catalog, stale: true, error: result.error };
	}

	private async save(value: StoredCatalog, generation: number | undefined): Promise<void> {
		await mutateCatalogStorage(async () => {
			if (generation === undefined || generation !== catalogStorageGeneration) return;
			try {
				await this.storage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(value));
			} catch {
				// A storage failure must not hide a response which is already safe to render.
			}
		});
	}
}
