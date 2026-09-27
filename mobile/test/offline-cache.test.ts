import type { Catalog, NodeResponse } from "../src/api/contracts";
import { CATALOG_MAX_AGE_MS, type CacheStorage, CatalogCache } from "../src/cache/catalog";
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
