import type { ApiClient } from "../api/client";
import { type NodeResponse, nodeResponseSchema } from "../api/contracts";
import type { ClientResult } from "../api/errors";
import type { CacheStorage } from "./catalog";

export const NODE_STORAGE_KEY = "track1.offline.nodes.v1";
export const NODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const NODE_CACHE_LIMIT = 50;
const NODE_VERSION = 1 as const;

type StoredNode = { response: NodeResponse; touchedAt: number; checkedAt: number };
type StoredNodes = {
	version: typeof NODE_VERSION;
	nodes: Record<string, StoredNode>;
	aliases: Record<string, string>;
	protected: string[];
};

export type CachedNodeResult = ClientResult<NodeResponse> & { stale?: boolean };

// Today and fiche screens own separate cache instances but share AsyncStorage.
// Serializing read-modify-write operations prevents one screen from dropping the other's update.
let storageMutation = Promise.resolve();
const pendingProtections = new Set<string>();

function mutateStorage<T>(operation: () => Promise<T>): Promise<T> {
	const result = storageMutation.then(operation, operation);
	storageMutation = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function defaultStorage(): CacheStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as CacheStorage;
	} catch {
		const unavailable = async (): Promise<never> => Promise.reject(new Error("offline cache unavailable"));
		return { getItem: unavailable, setItem: unavailable, removeItem: unavailable };
	}
}

function empty(): StoredNodes {
	return { version: NODE_VERSION, nodes: {}, aliases: {}, protected: [] };
}

function isStoredNodes(value: unknown): value is StoredNodes {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== NODE_VERSION || candidate.nodes === null || typeof candidate.nodes !== "object")
		return false;
	if (
		candidate.aliases === null ||
		typeof candidate.aliases !== "object" ||
		!Array.isArray(candidate.protected)
	)
		return false;
	return (
		Object.values(candidate.nodes as Record<string, unknown>).every((entry) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
			const node = entry as Record<string, unknown>;
			return (
				typeof node.touchedAt === "number" &&
				typeof node.checkedAt === "number" &&
				Number.isFinite(node.touchedAt) &&
				Number.isFinite(node.checkedAt) &&
				nodeResponseSchema.safeParse(node.response).success
			);
		}) &&
		Object.entries(candidate.aliases as Record<string, unknown>).every(
			([alias, canonical]) => typeof canonical === "string" && alias.length > 0,
		) &&
		candidate.protected.every((id) => typeof id === "string")
	);
}

function parse(raw: string): StoredNodes | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		return isStoredNodes(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function canServeStale(error: ClientResult<NodeResponse>): boolean {
	return error.kind === "error" && (error.error.kind === "network_error" || error.error.kind === "timeout");
}

export class NodeCache {
	constructor(
		private readonly storage: CacheStorage = defaultStorage(),
		private readonly now: () => number = Date.now,
	) {}

	async read(slug: string): Promise<NodeResponse | undefined> {
		return mutateStorage(async () => {
			const stored = await this.readStore();
			const canonical = stored.aliases[slug] ?? slug;
			const entry = stored.nodes[canonical];
			if (entry === undefined) return undefined;
			entry.touchedAt = this.now();
			await this.save(stored);
			return entry.response;
		});
	}

	async load(
		apiClient: Pick<ApiClient, "getNode">,
		slug: string,
		signal?: AbortSignal,
	): Promise<CachedNodeResult> {
		const stored = await this.readStore();
		const canonical = stored.aliases[slug] ?? slug;
		const cached = stored.nodes[canonical];
		if (cached !== undefined && this.now() - cached.checkedAt < NODE_MAX_AGE_MS) {
			await this.touch(slug);
			return { kind: "success", value: cached.response, stale: false };
		}
		const result = await apiClient.getNode(slug, signal);
		if (result.kind === "success") {
			await this.write(result.value);
			return result;
		}
		if (cached !== undefined && canServeStale(result)) {
			await this.touch(slug);
			return { kind: "success", value: cached.response, stale: true };
		}
		if (
			cached !== undefined &&
			result.kind === "error" &&
			result.error.kind === "api" &&
			result.error.status === 404
		)
			await this.remove(slug);
		return result;
	}

	async write(response: NodeResponse): Promise<void> {
		await mutateStorage(async () => {
			const stored = await this.readStore();
			const canonical = response.node.id;
			const at = this.now();
			stored.nodes[canonical] = { response, touchedAt: at, checkedAt: at };
			if (response.redirected_from !== undefined) stored.aliases[response.redirected_from] = canonical;
			stored.aliases[canonical] = canonical;
			this.evict(stored);
			await this.save(stored);
		});
	}

	async protect(ids: string[]): Promise<void> {
		for (const id of ids) pendingProtections.add(id);
		try {
			await mutateStorage(async () => {
				const stored = await this.readStore();
				// Today can select a fiche before it has been opened and cached for the first time.
				stored.protected = [...new Set(ids)];
				this.evict(stored);
				await this.save(stored);
			});
		} finally {
			for (const id of ids) pendingProtections.delete(id);
		}
	}

	async count(): Promise<number> {
		return Object.keys((await this.readStore()).nodes).length;
	}

	async identities(): Promise<string[]> {
		return Object.keys((await this.readStore()).nodes);
	}

	private async touch(slug: string): Promise<void> {
		await mutateStorage(async () => {
			const stored = await this.readStore();
			const canonical = stored.aliases[slug] ?? slug;
			const entry = stored.nodes[canonical];
			if (entry === undefined) return;
			entry.touchedAt = this.now();
			await this.save(stored);
		});
	}

	private async remove(slug: string): Promise<void> {
		await mutateStorage(async () => {
			const stored = await this.readStore();
			const canonical = stored.aliases[slug] ?? slug;
			if (stored.nodes[canonical] === undefined) return;
			delete stored.nodes[canonical];
			for (const [alias, identity] of Object.entries(stored.aliases)) {
				if (identity === canonical) delete stored.aliases[alias];
			}
			await this.save(stored);
		});
	}

	private evict(stored: StoredNodes): void {
		const protectedIds = new Set([...stored.protected, ...pendingProtections]);
		while (Object.keys(stored.nodes).length > NODE_CACHE_LIMIT) {
			const victim = Object.entries(stored.nodes)
				.filter(([id]) => !protectedIds.has(id))
				.sort(([, left], [, right]) => left.touchedAt - right.touchedAt)[0]?.[0];
			if (victim === undefined) return;
			delete stored.nodes[victim];
			for (const [alias, canonical] of Object.entries(stored.aliases)) {
				if (canonical === victim) delete stored.aliases[alias];
			}
		}
	}

	private async readStore(): Promise<StoredNodes> {
		try {
			const raw = await this.storage.getItem(NODE_STORAGE_KEY);
			return raw === null ? empty() : (parse(raw) ?? empty());
		} catch {
			return empty();
		}
	}

	private async save(value: StoredNodes): Promise<void> {
		try {
			await this.storage.setItem(NODE_STORAGE_KEY, JSON.stringify(value));
		} catch {
			// Cache persistence is best effort; callers retain their in-memory response.
		}
	}
}
