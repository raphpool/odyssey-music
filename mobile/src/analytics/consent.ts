export const CONSENT_STORAGE_KEY = "track1.analytics-consent.v1";
const ANONYMOUS_ID_STORAGE_KEY = "track1.analytics-anonymous-id.v1";
const REVOCATION_STORAGE_KEY = "track1.analytics-revocation.v1";

export type ConsentStatus = "unknown" | "granted" | "denied";
export type Consent = { version: 1; status: ConsentStatus; decidedAt?: string };
export type KeyValueStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
};

function unavailableStorage(): KeyValueStorage {
	const unavailable = async (): Promise<never> => Promise.reject(new Error("analytics storage unavailable"));
	return { getItem: unavailable, setItem: unavailable, removeItem: unavailable };
}

function defaultStorage(): KeyValueStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as KeyValueStorage;
	} catch {
		// A missing native bridge must fail closed: the app stays usable but analytics never starts.
		return unavailableStorage();
	}
}

function parseConsent(raw: string | null): Consent {
	if (raw === null) return { version: 1, status: "unknown" };
	try {
		const value: unknown = JSON.parse(raw);
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const candidate = value as Record<string, unknown>;
			if (
				Object.hasOwn(candidate, "version") &&
				Object.hasOwn(candidate, "status") &&
				candidate.version === 1 &&
				(candidate.status === "unknown" || candidate.status === "granted" || candidate.status === "denied") &&
				(!Object.hasOwn(candidate, "decidedAt") || typeof candidate.decidedAt === "string")
			) {
				return typeof candidate.decidedAt === "string"
					? { version: 1, status: candidate.status, decidedAt: candidate.decidedAt }
					: { version: 1, status: candidate.status };
			}
		}
	} catch {
		// Malformed local data must fail closed.
	}
	return { version: 1, status: "unknown" };
}

export class ConsentStore {
	constructor(
		private readonly storage: KeyValueStorage = defaultStorage(),
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async read(): Promise<Consent> {
		try {
			if ((await this.storage.getItem(REVOCATION_STORAGE_KEY)) !== null)
				return { version: 1, status: "denied" };
			const raw = await this.storage.getItem(CONSENT_STORAGE_KEY);
			const consent = parseConsent(raw);
			// Re-write a grant: read-only storage after a withdrawal must not revive it.
			if (consent.status === "granted" && raw !== null) await this.storage.setItem(CONSENT_STORAGE_KEY, raw);
			return consent;
		} catch {
			return { version: 1, status: "unknown" };
		}
	}

	async grant(): Promise<Consent> {
		return this.write("granted");
	}

	async deny(): Promise<Consent> {
		return this.write("denied");
	}

	async anonymousId(): Promise<string | null> {
		return this.storage.getItem(ANONYMOUS_ID_STORAGE_KEY);
	}

	async saveAnonymousId(value: string): Promise<void> {
		await this.storage.setItem(ANONYMOUS_ID_STORAGE_KEY, value);
	}

	async clearAnonymousId(): Promise<void> {
		await this.storage.removeItem(ANONYMOUS_ID_STORAGE_KEY);
	}

	async beginRevocation(): Promise<boolean> {
		try {
			await this.storage.setItem(REVOCATION_STORAGE_KEY, "pending");
			return true;
		} catch {
			return false;
		}
	}

	async revocationPending(): Promise<boolean> {
		try {
			return (await this.storage.getItem(REVOCATION_STORAGE_KEY)) !== null;
		} catch {
			return true;
		}
	}

	async completeRevocation(): Promise<boolean> {
		try {
			await this.storage.removeItem(REVOCATION_STORAGE_KEY);
			return true;
		} catch {
			return false;
		}
	}

	private async write(status: Exclude<ConsentStatus, "unknown">): Promise<Consent> {
		const value: Consent = { version: 1, status, decidedAt: this.now() };
		await this.storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
		return value;
	}
}
