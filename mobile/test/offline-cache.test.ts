import type { Catalog, NodeResponse } from "../src/api/contracts";
import {
	CATALOG_MAX_AGE_MS,
	type CacheStorage,
	CatalogCache,
	searchCachedCatalog,
} from "../src/cache/catalog";
import { NODE_MAX_AGE_MS, NodeCache } from "../src/cache/nodes";

function storage(initial?: string): CacheStorage & { value: string | null } {
	let value = initial ?? null;
	return {
		get value() {
			return value;
		},
		getItem: jest.fn(async () => value),
		setItem: jest.fn(async (_key: string, next: string) => {
			value = next;
		}),
		removeItem: jest.fn(async () => {
			value = null;
		}),
	};
}

const catalog = {
	version: "v1",
	revision: `sha256:${"a".repeat(64)}`,
	taxonomy: { mode: "degraded", available: true },
	nodes: [{ identity: "artist:sample", type: "artist", name: "Sample", teaser: null }],
	edges: [],
} satisfies Catalog;

function node(id: string, redirectedFrom?: string): NodeResponse {
	return {
		node: {
			id,
			type: "artist",
			name: id,
			teaser: null,
			article: "Article",
			citations: [],
			edges: {},
			facts: {},
			materialized_at: "2026-09-27T00:00:00.000Z",
		},
		source: "cache",
		...(redirectedFrom === undefined ? {} : { redirected_from: redirectedFrom }),
	};
}

describe("offline caches", () => {
	it("uses the catalog for exactly six hours, revalidates with its ETag, and keeps stale data on failure", async () => {
		let now = 0;
		const cache = new CatalogCache(storage(), () => now);
		const getCatalog = jest
			.fn()
			.mockResolvedValueOnce({ kind: "success", value: catalog, etag: "first" })
			.mockResolvedValueOnce({ kind: "notModified", etag: "second" })
			.mockResolvedValueOnce({ kind: "error", error: { kind: "network_error", message: "offline" } });

		expect((await cache.load({ getCatalog } as never)).stale).toBe(false);
		now = CATALOG_MAX_AGE_MS - 1;
		expect((await cache.load({ getCatalog } as never)).value).toEqual(catalog);
		expect(getCatalog).toHaveBeenCalledTimes(1);
		now = CATALOG_MAX_AGE_MS;
		expect((await cache.load({ getCatalog } as never)).stale).toBe(false);
		expect(getCatalog).toHaveBeenLastCalledWith({ etag: "first", hasCachedCopy: true });
		now += CATALOG_MAX_AGE_MS;
		const stale = await cache.load({ getCatalog } as never);
		expect(stale.value).toEqual(catalog);
		expect(stale.stale).toBe(true);
	});

	it("keeps aliases unique, protects the daily fiche during LRU eviction, and recovers from corrupt storage", async () => {
		let now = 0;
		const persisted = storage("not json");
		const cache = new NodeCache(persisted, () => now);
		expect(await cache.read("artist:any")).toBeUndefined();

		await cache.protect(["artist:canonical"]);
		await cache.write(node("artist:canonical", "artist:old"));
		expect((await cache.read("artist:old"))?.node.id).toBe("artist:canonical");
		await cache.write(node("artist:canonical", "artist:older"));
		expect(await cache.count()).toBe(1);
		for (let index = 0; index < 50; index += 1) {
			now += 1;
			await cache.write(node(`artist:node-${index}`));
		}
		expect(await cache.count()).toBe(50);
		expect((await cache.read("artist:canonical"))?.node.id).toBe("artist:canonical");
		expect(await cache.read("artist:node-0")).toBeUndefined();
		expect(NODE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
	});

	it("uses a fiche for exactly 24 hours then serves its stale version when revalidation fails", async () => {
		let now = 0;
		const cache = new NodeCache(storage(), () => now);
		const getNode = jest
			.fn()
			.mockResolvedValueOnce({ kind: "success", value: node("artist:sample") })
			.mockResolvedValueOnce({ kind: "error", error: { kind: "network_error", message: "offline" } });
		await cache.load({ getNode } as never, "artist:sample");
		now = NODE_MAX_AGE_MS - 1;
		expect((await cache.load({ getNode } as never, "artist:sample")).stale).toBe(false);
		expect(getNode).toHaveBeenCalledTimes(1);
		now = NODE_MAX_AGE_MS;
		const stale = await cache.load({ getNode } as never, "artist:sample");
		expect(stale).toMatchObject({ kind: "success", stale: true, value: node("artist:sample") });
	});

	it("keeps a stale fiche visible during a retryable API outage", async () => {
		let now = 0;
		const cache = new NodeCache(storage(), () => now);
		const getNode = jest
			.fn()
			.mockResolvedValueOnce({ kind: "success", value: node("artist:sample") })
			.mockResolvedValueOnce({
				kind: "error",
				error: { kind: "api", status: 503, code: "unavailable", retryable: true, message: "retry" },
			});
		await cache.load({ getNode } as never, "artist:sample");
		now = NODE_MAX_AGE_MS;
		await expect(cache.load({ getNode } as never, "artist:sample")).resolves.toMatchObject({
			kind: "success",
			stale: true,
		});
	});

	it("removes a stale fiche when its canonical API response is 404", async () => {
		let now = 0;
		const cache = new NodeCache(storage(), () => now);
		const getNode = jest
			.fn()
			.mockResolvedValueOnce({ kind: "success", value: node("artist:removed") })
			.mockResolvedValueOnce({
				kind: "error",
				error: { kind: "api", status: 404, code: "not_found", retryable: false, message: "missing" },
			});
		await cache.load({ getNode } as never, "artist:removed");
		now = NODE_MAX_AGE_MS;
		await expect(cache.load({ getNode } as never, "artist:removed")).resolves.toMatchObject({
			kind: "error",
			error: { status: 404 },
		});
		expect(await cache.read("artist:removed")).toBeUndefined();
	});

	it("serializes catalog revalidations so a late 304 cannot overwrite a newer catalog", async () => {
		let now = 0;
		const cache = new CatalogCache(storage(), () => now);
		await cache.load({
			getCatalog: jest.fn(async () => ({ kind: "success" as const, value: catalog, etag: "v1" })),
		} as never);
		now = CATALOG_MAX_AGE_MS;
		let resolveFirst: ((result: { kind: "notModified"; etag: string }) => void) | undefined;
		const firstResponse = new Promise<{ kind: "notModified"; etag: string }>((resolve) => {
			resolveFirst = resolve;
		});
		const freshCatalog = { ...catalog, revision: `sha256:${"b".repeat(64)}` } satisfies Catalog;
		const getCatalog = jest
			.fn()
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce({ kind: "success", value: freshCatalog, etag: "v2" });
		const first = cache.load({ getCatalog } as never, { forceRevalidate: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = cache.load({ getCatalog } as never, { forceRevalidate: true });
		expect(getCatalog).toHaveBeenCalledTimes(1);
		if (resolveFirst === undefined) throw new Error("the first revalidation did not start");
		resolveFirst({ kind: "notModified", etag: "v1" });
		await Promise.all([first, second]);
		expect((await cache.cached())?.revision).toBe(freshCatalog.revision);
	});

	it("limits cached catalogue search results to the remote search page size", () => {
		const manyNodes = Array.from({ length: 26 }, (_, index) => ({
			identity: `artist:sample-${index}`,
			type: "artist" as const,
			name: `Sample ${index}`,
			teaser: null,
		}));
		const results = searchCachedCatalog({ ...catalog, nodes: manyNodes }, "sample");
		expect(results).toHaveLength(25);
	});

	it("searches cached names and teasers without accent sensitivity", () => {
		const searchable = {
			...catalog,
			nodes: [
				{ identity: "artist:bjork", type: "artist" as const, name: "Björk", teaser: "Chanteuse islandaise" },
			],
		};
		expect(searchCachedCatalog(searchable, "bjork")).toHaveLength(1);
		expect(searchCachedCatalog(searchable, "islandaise")).toHaveLength(1);
	});

	it("replaces a former canonical fiche with its redirected identity", async () => {
		const cache = new NodeCache(storage());
		await cache.write(node("artist:old"));
		await cache.write(node("artist:new", "artist:old"));
		expect(await cache.count()).toBe(1);
		expect((await cache.read("artist:old"))?.node.id).toBe("artist:new");
	});

	it("serializes concurrent daily protection and fiche writes so neither update is lost", async () => {
		let now = 0;
		const sharedStorage = storage();
		const first = new NodeCache(sharedStorage, () => now);
		const second = new NodeCache(sharedStorage, () => now);
		await first.write(node("artist:daily"));
		for (let index = 0; index < 49; index += 1) {
			now += 1;
			await first.write(node(`artist:existing-${index}`));
		}
		await Promise.all([first.protect(["artist:daily"]), second.write(node("artist:new"))]);
		expect((await first.read("artist:daily"))?.node.id).toBe("artist:daily");
		expect((await second.read("artist:new"))?.node.id).toBe("artist:new");
		expect(await first.count()).toBe(50);
	});
});
