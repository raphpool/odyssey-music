import type { Catalog, NodeType } from "../api/contracts";
import { isUuid, type Profile, randomUuid } from "../profile/model";
import { rankAffinity } from "./affinity";

export const RECOMMENDATION_STORAGE_KEY = "track1.recommendation.v1";
const RECOMMENDATION_VERSION = 1 as const;
const HISTORY_LIMIT = 40;

export type RecommendationStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
};

export type DailyRecommendation = {
	recommendation_id: string;
	local_date: string;
	profile_revision: number;
	node_id: string;
	node_type: Extract<NodeType, "artist" | "project" | "track">;
	name: string;
	teaser: string | null;
	reasons: string[];
	view_event_id: string;
	view_recorded: boolean;
};

type StoredRecommendations = { version: typeof RECOMMENDATION_VERSION; history: DailyRecommendation[] };
export type DailyResult =
	| { kind: "recommendation"; recommendation: DailyRecommendation }
	| { kind: "missing_profile" }
	| { kind: "empty_catalog" }
	| { kind: "unavailable" };

function isDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isRecommendation(value: unknown): value is DailyRecommendation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		isUuid(candidate.recommendation_id) &&
		isDate(candidate.local_date) &&
		typeof candidate.profile_revision === "number" &&
		Number.isSafeInteger(candidate.profile_revision) &&
		candidate.profile_revision > 0 &&
		typeof candidate.node_id === "string" &&
		(candidate.node_type === "artist" ||
			candidate.node_type === "project" ||
			candidate.node_type === "track") &&
		typeof candidate.name === "string" &&
		(candidate.teaser === null || typeof candidate.teaser === "string") &&
		Array.isArray(candidate.reasons) &&
		candidate.reasons.every((reason) => typeof reason === "string") &&
		isUuid(candidate.view_event_id) &&
		typeof candidate.view_recorded === "boolean"
	);
}

function parse(raw: string): StoredRecommendations | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const candidate = value as Record<string, unknown>;
		if (candidate.version !== RECOMMENDATION_VERSION || !Array.isArray(candidate.history)) return undefined;
		if (!candidate.history.every(isRecommendation) || candidate.history.length > HISTORY_LIMIT)
			return undefined;
		return { version: RECOMMENDATION_VERSION, history: candidate.history };
	} catch {
		return undefined;
	}
}

function defaultStorage(): RecommendationStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as RecommendationStorage;
	} catch {
		const unavailable = async (): Promise<never> =>
			Promise.reject(new Error("recommendation storage unavailable"));
		return { getItem: unavailable, setItem: unavailable, removeItem: unavailable };
	}
}

/** FNV-1a 32 over UTF-8 keeps a local pick stable across JavaScript runtimes. */
export function fnv1a32(value: string): number {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export class DailyRecommendationStore {
	constructor(
		private readonly storage: RecommendationStorage = defaultStorage(),
		private readonly createId: () => string = randomUuid,
	) {}

	async read(): Promise<StoredRecommendations | undefined> {
		try {
			const raw = await this.storage.getItem(RECOMMENDATION_STORAGE_KEY);
			return raw === null ? { version: RECOMMENDATION_VERSION, history: [] } : parse(raw);
		} catch {
			return undefined;
		}
	}

	async save(history: DailyRecommendation[]): Promise<boolean> {
		try {
			await this.storage.setItem(
				RECOMMENDATION_STORAGE_KEY,
				JSON.stringify({ version: RECOMMENDATION_VERSION, history: history.slice(-HISTORY_LIMIT) }),
			);
			return true;
		} catch {
			return false;
		}
	}

	async markViewed(recommendationId: string): Promise<boolean> {
		const current = await this.read();
		if (current === undefined) return false;
		const history = current.history.map((recommendation) =>
			recommendation.recommendation_id === recommendationId
				? { ...recommendation, view_recorded: true }
				: recommendation,
		);
		return this.save(history);
	}

	newId(): string | undefined {
		const id = this.createId();
		return isUuid(id) ? id : undefined;
	}
}

export async function recommendDaily(input: {
	store: DailyRecommendationStore;
	profile?: Profile | undefined;
	catalog?: Catalog | undefined;
	localDate: string;
}): Promise<DailyResult> {
	if (input.profile === undefined) return { kind: "missing_profile" };
	if (input.catalog === undefined || !isDate(input.localDate)) return { kind: "empty_catalog" };
	const state = await input.store.read();
	if (state === undefined) return { kind: "unavailable" };
	const existing = state.history.find((item) => item.local_date === input.localDate);
	if (existing !== undefined && existing.profile_revision === input.profile.revision)
		return { kind: "recommendation", recommendation: existing };

	const candidates = rankAffinity(input.catalog, input.profile.genre_ids);
	if (candidates.length === 0) return { kind: "empty_catalog" };
	const historyWithoutCurrentDate = state.history.filter((item) => item.local_date !== input.localDate);
	const seen = new Set(historyWithoutCurrentDate.map((item) => item.node_id));
	const unseen = candidates.filter((candidate) => !seen.has(candidate.node.identity));
	// The hash indexes the eligible group itself: filtering after modulo would skew a partially seen cycle.
	const eligible = unseen.length === 0 ? candidates : unseen;
	const picked = eligible[fnv1a32(`${input.profile.local_id}:${input.localDate}`) % eligible.length];
	if (picked === undefined) return { kind: "empty_catalog" };
	const recommendationId = input.store.newId();
	const viewEventId = input.store.newId();
	if (recommendationId === undefined || viewEventId === undefined) return { kind: "unavailable" };
	const recommendation: DailyRecommendation = {
		recommendation_id: recommendationId,
		local_date: input.localDate,
		profile_revision: input.profile.revision,
		node_id: picked.node.identity,
		node_type: picked.node.type,
		name: picked.node.name,
		teaser: picked.node.teaser,
		reasons: picked.reasons,
		view_event_id: viewEventId,
		view_recorded: false,
	};
	return (await input.store.save([...historyWithoutCurrentDate, recommendation]))
		? { kind: "recommendation", recommendation }
		: { kind: "unavailable" };
}
