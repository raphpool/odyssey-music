export type SegmentStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
	getAllKeys(): Promise<string[]>;
	multiRemove(keys: string[]): Promise<void>;
};

export type SegmentPersistor = {
	get<T>(key: string): Promise<T | undefined>;
	set<T>(key: string, state: T): Promise<void>;
};

export const SEGMENT_STORAGE_PREFIX = "track1.analytics-segment.v1.";

function unavailableStorage(): SegmentStorage {
	const unavailable = async (): Promise<never> => Promise.reject(new Error("Segment storage unavailable"));
	return {
		getItem: unavailable,
		setItem: unavailable,
		removeItem: unavailable,
		getAllKeys: unavailable,
		multiRemove: unavailable,
	};
}

export function segmentStorage(): SegmentStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as SegmentStorage;
	} catch {
		return unavailableStorage();
	}
}

export function segmentStorageKey(key: string): string {
	return `${SEGMENT_STORAGE_PREFIX}${key}`;
}

/**
 * Segment's Persistor API has no delete operation. This wrapper closes its read/write gate before
 * removal, so a late queue flush cannot recreate a key after consent is withdrawn.
 */
export class ConsentBoundPersistor implements SegmentPersistor {
	private enabled = true;
	private generation = 0;
	private readonly keys = new Set<string>();

	constructor(private readonly storage: SegmentStorage) {}

	block(): void {
		this.enabled = false;
		this.generation += 1;
	}

	async get<T>(key: string): Promise<T | undefined> {
		const storageKey = segmentStorageKey(key);
		this.keys.add(storageKey);
		if (!this.enabled) return undefined;
		const generation = this.generation;
		try {
			const raw = await this.storage.getItem(storageKey);
			if (!this.enabled || generation !== this.generation || raw === null) return undefined;
			return JSON.parse(raw) as T;
		} catch {
			return undefined;
		}
	}

	async set<T>(key: string, state: T): Promise<void> {
		const storageKey = segmentStorageKey(key);
		this.keys.add(storageKey);
		if (!this.enabled) return;
		const generation = this.generation;
		try {
			await this.storage.setItem(storageKey, JSON.stringify(state));
			if (!this.enabled || generation !== this.generation) await this.storage.removeItem(storageKey);
		} catch {
			// Analytics persistence must never make an opted-in app unusable.
		}
	}

	async purge(): Promise<boolean> {
		this.block();
		return purgeSegmentStorage(this.storage, this.keys);
	}
}

export async function purgeSegmentStorage(
	storage: SegmentStorage = segmentStorage(),
	knownKeys: ReadonlySet<string> = new Set(),
): Promise<boolean> {
	let discovered: string[];
	try {
		discovered = await storage.getAllKeys();
	} catch {
		return false;
	}
	const keys = new Set([...knownKeys, ...discovered].filter((key) => key.startsWith(SEGMENT_STORAGE_PREFIX)));
	try {
		if (keys.size > 0) await storage.multiRemove([...keys]);
		return true;
	} catch {
		const removed = await Promise.all(
			[...keys].map(async (key) => {
				try {
					await storage.removeItem(key);
					return true;
				} catch {
					return false;
				}
			}),
		);
		return removed.every(Boolean);
	}
}
