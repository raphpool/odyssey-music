import {
	isGenreId,
	isUuid,
	PROFILE_VERSION,
	type Profile,
	type ProfileDraft,
	parseProfile,
	parseProfileDraft,
	randomUuid,
	selectionIsComplete,
} from "./model";

export const PROFILE_STORAGE_KEY = "track1.profile.v1";
export const PROFILE_DRAFT_STORAGE_KEY = "track1.profile-draft.v1";
export const PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY = "track1.profile-onboarding-completion.v1";
export const PROFILE_ONBOARDING_STARTED_STORAGE_KEY = "track1.profile-onboarding-started.v1";
export const PROFILE_ONBOARDING_PURGE_STORAGE_KEY = "track1.profile-onboarding-purge.v1";
const RECOMMENDATION_STORAGE_PREFIX = "track1.recommendation.";

export type ProfileStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
	getAllKeys(): Promise<string[]>;
};

export type ProfileRead =
	| { kind: "missing" }
	| { kind: "profile"; profile: Profile }
	| { kind: "corrupt" }
	| { kind: "unavailable" };
export type ProfileWrite =
	| { kind: "saved"; profile: Profile }
	| { kind: "unavailable" }
	| { kind: "invalid" };
export type ProfileClear = { kind: "cleared" } | { kind: "unavailable" };
export type OnboardingCompletion = {
	version: typeof PROFILE_VERSION;
	flow_id: string;
	event_id: string;
	genres_count: number;
	occurred_at: string;
};
export type OnboardingStarted = {
	version: typeof PROFILE_VERSION;
	flow_id: string;
	event_id: string;
	occurred_at: string;
};

function unavailableStorage(): ProfileStorage {
	const unavailable = async (): Promise<never> => Promise.reject(new Error("profile storage unavailable"));
	return { getItem: unavailable, setItem: unavailable, removeItem: unavailable, getAllKeys: unavailable };
}

function defaultStorage(): ProfileStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as ProfileStorage;
	} catch {
		return unavailableStorage();
	}
}

function parse(raw: string): unknown | undefined {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function isOccurredAt(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function parseCompletion(value: unknown): OnboardingCompletion | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== PROFILE_VERSION ||
		!isUuid(candidate.flow_id) ||
		!isUuid(candidate.event_id) ||
		!isOccurredAt(candidate.occurred_at) ||
		typeof candidate.genres_count !== "number" ||
		!Number.isSafeInteger(candidate.genres_count) ||
		candidate.genres_count < 0
	)
		return undefined;
	return {
		version: PROFILE_VERSION,
		flow_id: candidate.flow_id as string,
		event_id: candidate.event_id as string,
		genres_count: candidate.genres_count as number,
		occurred_at: candidate.occurred_at as string,
	};
}

function parseStarted(value: unknown): OnboardingStarted | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== PROFILE_VERSION ||
		!isUuid(candidate.flow_id) ||
		!isUuid(candidate.event_id) ||
		!isOccurredAt(candidate.occurred_at)
	)
		return undefined;
	return {
		version: PROFILE_VERSION,
		flow_id: candidate.flow_id as string,
		event_id: candidate.event_id as string,
		occurred_at: candidate.occurred_at as string,
	};
}

export class ProfileStore {
	private static completionTransitions: Promise<void> = Promise.resolve();
	private static readonly onboardingOutboxListeners = new Set<() => void>();
	private static outboxPurgeUncertain = false;

	static subscribeOnboardingOutbox(listener: () => void): () => void {
		ProfileStore.onboardingOutboxListeners.add(listener);
		return () => ProfileStore.onboardingOutboxListeners.delete(listener);
	}
	constructor(
		private readonly storage: ProfileStorage = defaultStorage(),
		private readonly createId: () => string = randomUuid,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async read(): Promise<ProfileRead> {
		try {
			const raw = await this.storage.getItem(PROFILE_STORAGE_KEY);
			if (raw === null) return { kind: "missing" };
			const profile = parseProfile(parse(raw));
			return profile === undefined ? { kind: "corrupt" } : { kind: "profile", profile };
		} catch {
			return { kind: "unavailable" };
		}
	}

	async readDraft(): Promise<ProfileDraft | undefined> {
		try {
			const raw = await this.storage.getItem(PROFILE_DRAFT_STORAGE_KEY);
			return raw === null ? undefined : parseProfileDraft(parse(raw));
		} catch {
			return undefined;
		}
	}

	async beginDraft(genreIds: readonly string[] = []): Promise<ProfileDraft | undefined> {
		const existing = await this.readDraft();
		if (existing !== undefined) return existing;
		const flowId = this.createId();
		if (!isUuid(flowId)) return undefined;
		const draft: ProfileDraft = {
			version: PROFILE_VERSION,
			flow_id: flowId,
			genre_ids: [...new Set(genreIds)],
			started_recorded: false,
		};
		try {
			await this.storage.setItem(PROFILE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
			return draft;
		} catch {
			return undefined;
		}
	}

	async saveDraft(draft: ProfileDraft): Promise<boolean> {
		if (parseProfileDraft(draft) === undefined) return false;
		try {
			await this.storage.setItem(PROFILE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
			return true;
		} catch {
			return false;
		}
	}

	async prepareOnboardingStarted(flowId: string): Promise<OnboardingStarted | undefined> {
		if (!isUuid(flowId)) return undefined;
		try {
			return await this.serializeCompletion(async () => {
				if (await this.onboardingOutboxPurgePending()) return undefined;
				const existing = await this.readOnboardingStarted();
				const event =
					existing !== undefined && existing.flow_id === flowId
						? existing
						: {
								version: PROFILE_VERSION,
								flow_id: flowId,
								event_id: this.createId(),
								occurred_at: this.now(),
							};
				if (!isUuid(event.event_id) || !isOccurredAt(event.occurred_at)) return undefined;
				await this.storage.setItem(PROFILE_ONBOARDING_STARTED_STORAGE_KEY, JSON.stringify(event));
				ProfileStore.notifyOnboardingOutbox();
				return event;
			});
		} catch {
			return undefined;
		}
	}

	async commit(input: {
		genreIds: readonly string[];
		availableGenreIds: readonly string[];
		flowId: string;
		trackOnboardingCompletion?: boolean;
	}): Promise<ProfileWrite> {
		if (!isUuid(input.flowId) || !selectionIsComplete(input.genreIds, input.availableGenreIds))
			return { kind: "invalid" };
		const genreIds = [...new Set(input.genreIds)].sort((left, right) => left.localeCompare(right));
		if (genreIds.length !== input.genreIds.length || genreIds.some((genreId) => !isGenreId(genreId)))
			return { kind: "invalid" };
		const current = await this.read();
		if (current.kind === "corrupt" || current.kind === "unavailable") return { kind: "unavailable" };
		const localId = current.kind === "profile" ? current.profile.local_id : this.createId();
		if (!isUuid(localId)) return { kind: "unavailable" };
		const unchanged =
			current.kind === "profile" &&
			current.profile.genre_ids.length === genreIds.length &&
			current.profile.genre_ids.every((genreId) => genreIds.includes(genreId));
		const profile: Profile = {
			version: PROFILE_VERSION,
			local_id: localId,
			genre_ids: genreIds,
			revision:
				current.kind === "profile"
					? unchanged
						? current.profile.revision
						: current.profile.revision + 1
					: 1,
			onboarding_completed: true,
			flow_id: input.flowId,
		};
		try {
			if (input.trackOnboardingCompletion === true)
				await this.serializeCompletion(async () => {
					if (await this.onboardingOutboxPurgePending()) throw new Error("onboarding outbox purge pending");
					const completion = await this.readOnboardingCompletion();
					const pending =
						completion !== undefined && completion.flow_id === input.flowId
							? { ...completion, genres_count: genreIds.length, occurred_at: this.now() }
							: {
									version: PROFILE_VERSION,
									flow_id: input.flowId,
									event_id: this.createId(),
									genres_count: genreIds.length,
									occurred_at: this.now(),
								};
					if (!isUuid(pending.event_id)) throw new Error("invalid completion event id");
					await this.storage.setItem(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY, JSON.stringify(pending));
					ProfileStore.notifyOnboardingOutbox();
				});
			await this.storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
			await this.storage.removeItem(PROFILE_DRAFT_STORAGE_KEY);
			return { kind: "saved", profile };
		} catch {
			return { kind: "unavailable" };
		}
	}

	async readOnboardingCompletion(): Promise<OnboardingCompletion | undefined> {
		try {
			const raw = await this.storage.getItem(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY);
			return raw === null ? undefined : parseCompletion(parse(raw));
		} catch {
			return undefined;
		}
	}

	async readOnboardingStarted(): Promise<OnboardingStarted | undefined> {
		try {
			const raw = await this.storage.getItem(PROFILE_ONBOARDING_STARTED_STORAGE_KEY);
			return raw === null ? undefined : parseStarted(parse(raw));
		} catch {
			return undefined;
		}
	}

	async acknowledgeOnboardingStarted(eventId: string): Promise<boolean> {
		if (!isUuid(eventId)) return false;
		try {
			return await this.serializeCompletion(async () => {
				const pending = await this.readOnboardingStarted();
				if (pending === undefined || pending.event_id !== eventId) return false;
				const draft = await this.readDraft();
				if (draft !== undefined && draft.flow_id === pending.flow_id)
					await this.storage.setItem(
						PROFILE_DRAFT_STORAGE_KEY,
						JSON.stringify({ ...draft, started_recorded: true }),
					);
				await this.storage.removeItem(PROFILE_ONBOARDING_STARTED_STORAGE_KEY);
				return true;
			});
		} catch {
			return false;
		}
	}

	async discardOnboardingStarted(eventId: string): Promise<boolean> {
		if (!isUuid(eventId)) return false;
		try {
			return await this.serializeCompletion(async () => {
				const pending = await this.readOnboardingStarted();
				if (pending === undefined || pending.event_id !== eventId) return false;
				await this.storage.removeItem(PROFILE_ONBOARDING_STARTED_STORAGE_KEY);
				return true;
			});
		} catch {
			return false;
		}
	}

	async discardOnboardingOutboxes(): Promise<boolean> {
		ProfileStore.outboxPurgeUncertain = true;
		try {
			return await this.serializeCompletion(async () => {
				await this.storage.setItem(PROFILE_ONBOARDING_PURGE_STORAGE_KEY, "pending");
				await Promise.all([
					this.storage.removeItem(PROFILE_ONBOARDING_STARTED_STORAGE_KEY),
					this.storage.removeItem(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY),
				]);
				await this.storage.removeItem(PROFILE_ONBOARDING_PURGE_STORAGE_KEY);
				ProfileStore.outboxPurgeUncertain = false;
				return true;
			});
		} catch {
			return false;
		}
	}

	async onboardingOutboxPurgePending(): Promise<boolean> {
		if (ProfileStore.outboxPurgeUncertain) return true;
		try {
			return (await this.storage.getItem(PROFILE_ONBOARDING_PURGE_STORAGE_KEY)) !== null;
		} catch {
			return true;
		}
	}

	async acknowledgeOnboardingCompletion(eventId: string): Promise<boolean> {
		if (!isUuid(eventId)) return false;
		try {
			return await this.serializeCompletion(async () => {
				const pending = await this.readOnboardingCompletion();
				if (pending === undefined || pending.event_id !== eventId) return false;
				await this.storage.removeItem(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY);
				return true;
			});
		} catch {
			return false;
		}
	}

	async clear(): Promise<ProfileClear> {
		try {
			const recommendationKeys = (await this.storage.getAllKeys()).filter((key) =>
				key.startsWith(RECOMMENDATION_STORAGE_PREFIX),
			);
			await Promise.all([
				this.storage.removeItem(PROFILE_STORAGE_KEY),
				this.storage.removeItem(PROFILE_DRAFT_STORAGE_KEY),
				this.storage.removeItem(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY),
				this.storage.removeItem(PROFILE_ONBOARDING_STARTED_STORAGE_KEY),
				...recommendationKeys.map((key) => this.storage.removeItem(key)),
			]);
			return { kind: "cleared" };
		} catch {
			return { kind: "unavailable" };
		}
	}

	private async serializeCompletion<T>(operation: () => Promise<T>): Promise<T> {
		const next = ProfileStore.completionTransitions.then(operation, operation);
		ProfileStore.completionTransitions = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private static notifyOnboardingOutbox(): void {
		for (const listener of ProfileStore.onboardingOutboxListeners) listener();
	}
}
