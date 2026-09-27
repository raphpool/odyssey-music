import type { NodeType } from "../api/contracts";

export const GENERATION_STORAGE_KEY = "track1.generations.v1";
export const GENERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const GENERATION_MAX_RECORDS = 1000;

export type GenerationInput = {
	type: NodeType;
	name: string;
	slug?: string;
	mbid?: string;
	qid?: string;
	disambiguator?: string;
};

export type GenerationStatus =
	| "submitting"
	| "queued"
	| "running"
	| "confirming"
	| "busy"
	| "unknown"
	| "succeeded"
	| "failed"
	| "interrupted"
	| "expired";

export type GenerationEventFlags = {
	requested: boolean;
	completed: boolean;
	failed: boolean;
};

export type GenerationRecord = {
	request_id: string;
	input: GenerationInput;
	created_at: string;
	status: GenerationStatus;
	event_flags: GenerationEventFlags;
	node_id?: string;
	error_code?: string;
	retry_after_seconds?: number;
};

export type GenerationStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
};

export type GenerationStore = {
	list(): Promise<GenerationRecord[]>;
	get(requestId: string): Promise<GenerationRecord | undefined>;
	findActive(input: GenerationInput): Promise<GenerationRecord | undefined>;
	reserve(record: GenerationRecord): Promise<{ acquired: boolean; record: GenerationRecord }>;
	upsert(record: GenerationRecord): Promise<void>;
	remove(requestId: string): Promise<void>;
};

export class GenerationStoreCapacityError extends Error {
	readonly kind = "capacity" as const;

	constructor() {
		super("Generation storage is full of active requests.");
		this.name = "GenerationStoreCapacityError";
	}
}

const nodeTypes = new Set<NodeType>(["artist", "project", "track", "genre", "label"]);
const identityPattern =
	/^(artist|project|track|genre|label):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mbidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qidPattern = /^Q[1-9]\d*$/;

const terminalStatuses = new Set<GenerationStatus>(["succeeded", "failed", "interrupted", "expired"]);
const navigationInputs = new Map<string, GenerationInput>();
const mutationQueues = new Map<string, Promise<void>>();

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && nodeTypes.has(value as NodeType);
}

function optionalString(
	candidate: Record<string, unknown>,
	key: string,
	maximum = Number.MAX_SAFE_INTEGER,
): string | null | undefined {
	const value = candidate[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

export function normalizeGenerationInput(value: unknown): GenerationInput | undefined {
	const candidate = record(value);
	if (candidate === undefined || typeof candidate.type !== "string" || typeof candidate.name !== "string")
		return undefined;
	const type = candidate.type.trim();
	const name = candidate.name.trim();
	if (!isNodeType(type) || name.length === 0 || name.length > 200) return undefined;

	const input: GenerationInput = { type, name };
	const slug = optionalString(candidate, "slug", 200);
	if (slug === null) return undefined;
	if (slug !== undefined) {
		if (!identityPattern.test(slug) || !slug.startsWith(`${type}:`)) return undefined;
		input.slug = slug;
	}
	const mbid = optionalString(candidate, "mbid", 36);
	if (mbid === null) return undefined;
	if (mbid !== undefined) {
		if (!mbidPattern.test(mbid)) return undefined;
		input.mbid = mbid;
	}
	const qid = optionalString(candidate, "qid", 32);
	if (qid === null) return undefined;
	if (qid !== undefined) {
		if (!qidPattern.test(qid)) return undefined;
		input.qid = qid;
	}
	const disambiguator = optionalString(candidate, "disambiguator", 200);
	if (disambiguator === null) return undefined;
	if (disambiguator !== undefined) input.disambiguator = disambiguator;
	return input;
}

export function generationIdentity(input: GenerationInput): string {
	if (input.slug !== undefined) return input.slug;
	return [input.type, input.name, input.mbid ?? "", input.qid ?? "", input.disambiguator ?? ""].join(
		"\u0000",
	);
}

export function rememberGenerationInput(input: GenerationInput): void {
	if (input.slug !== undefined) navigationInputs.set(input.slug, input);
}

export function generationInputForSlug(slug: string): GenerationInput | undefined {
	return navigationInputs.get(slug);
}

export function isGenerationTerminal(status: GenerationStatus): boolean {
	return terminalStatuses.has(status);
}

function normalizeEventFlags(value: unknown): GenerationEventFlags | undefined {
	const candidate = record(value);
	if (candidate === undefined) return undefined;
	const requested = candidate.requested;
	const completed = candidate.completed;
	const failed = candidate.failed;
	if (typeof requested !== "boolean" || typeof completed !== "boolean" || typeof failed !== "boolean")
		return undefined;
	return { requested, completed, failed };
}

function normalizeRecord(value: unknown): GenerationRecord | undefined {
	const candidate = record(value);
	if (candidate === undefined) return undefined;
	const requestId = candidate.request_id;
	const createdAt = candidate.created_at;
	const status = candidate.status;
	if (
		typeof requestId !== "string" ||
		!uuidPattern.test(requestId) ||
		typeof createdAt !== "string" ||
		Number.isNaN(Date.parse(createdAt)) ||
		typeof status !== "string" ||
		!new Set<GenerationStatus>([
			"submitting",
			"queued",
			"running",
			"confirming",
			"busy",
			"unknown",
			"succeeded",
			"failed",
			"interrupted",
			"expired",
		]).has(status as GenerationStatus)
	)
		return undefined;
	const input = normalizeGenerationInput(candidate.input);
	const eventFlags = normalizeEventFlags(candidate.event_flags);
	if (input === undefined || eventFlags === undefined) return undefined;
	const normalized: GenerationRecord = {
		request_id: requestId,
		input,
		created_at: createdAt,
		status: status as GenerationStatus,
		event_flags: eventFlags,
	};
	const nodeId = optionalString(candidate, "node_id");
	if (nodeId === null) return undefined;
	if (nodeId !== undefined) {
		if (!identityPattern.test(nodeId)) return undefined;
		normalized.node_id = nodeId;
	}
	const errorCode = optionalString(candidate, "error_code");
	if (errorCode === null) return undefined;
	if (errorCode !== undefined) normalized.error_code = errorCode;
	const retryAfter = candidate.retry_after_seconds;
	if (retryAfter !== undefined) {
		if (typeof retryAfter !== "number" || !Number.isInteger(retryAfter) || retryAfter < 0) return undefined;
		normalized.retry_after_seconds = retryAfter;
	}
	return normalized;
}

function generationStorage(): GenerationStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as GenerationStorage;
	} catch {
		const unavailable = async (): Promise<never> => {
			throw new Error("Generation storage unavailable");
		};
		return { getItem: unavailable, setItem: unavailable, removeItem: unavailable };
	}
}

function prune(records: GenerationRecord[], now: number): GenerationRecord[] {
	const retained = records.filter((item) => {
		if (!isGenerationTerminal(item.status)) return true;
		const age = now - Date.parse(item.created_at);
		return age <= GENERATION_RETENTION_MS;
	});
	if (retained.length <= GENERATION_MAX_RECORDS) return retained;

	const removable = retained
		.filter((item) => isGenerationTerminal(item.status))
		.sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
	const removeCount = retained.length - GENERATION_MAX_RECORDS;
	const removed = new Set(removable.slice(0, removeCount).map((item) => item.request_id));
	return retained.filter((item) => !removed.has(item.request_id));
}

export function createGenerationStore(
	storage: GenerationStorage = generationStorage(),
	now: () => number = () => Date.now(),
): GenerationStore {
	const read = async (): Promise<GenerationRecord[]> => {
		const raw = await storage.getItem(GENERATION_STORAGE_KEY);
		if (raw === null) return [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = [];
		}
		const entries: unknown[] = Array.isArray(parsed) ? parsed : [];
		const records = entries
			.map(normalizeRecord)
			.filter((item): item is GenerationRecord => item !== undefined);
		const cleaned = prune(records, now());
		if (cleaned.length !== records.length)
			await storage.setItem(GENERATION_STORAGE_KEY, JSON.stringify(cleaned));
		return cleaned;
	};

	const write = async (records: GenerationRecord[]): Promise<void> => {
		const cleaned = prune(records, now());
		await storage.setItem(GENERATION_STORAGE_KEY, JSON.stringify(cleaned));
	};

	const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = mutationQueues.get(GENERATION_STORAGE_KEY) ?? Promise.resolve();
		const current = previous.then(operation, operation);
		const settled = current.then(
			() => undefined,
			() => undefined,
		);
		mutationQueues.set(GENERATION_STORAGE_KEY, settled);
		return current.finally(() => {
			if (mutationQueues.get(GENERATION_STORAGE_KEY) === settled)
				mutationQueues.delete(GENERATION_STORAGE_KEY);
		});
	};

	return {
		list: () => serializeMutation(read),
		get: (requestId) =>
			serializeMutation(async () => (await read()).find((item) => item.request_id === requestId)),
		findActive: (input) =>
			serializeMutation(async () =>
				(await read()).find(
					(item) =>
						!isGenerationTerminal(item.status) &&
						generationIdentity(item.input) === generationIdentity(input),
				),
			),
		reserve: (next) =>
			serializeMutation(async () => {
				const records = await read();
				const sameRequestIndex = records.findIndex((item) => item.request_id === next.request_id);
				if (sameRequestIndex !== -1) {
					const existing = records[sameRequestIndex];
					if (existing === undefined) throw new Error("Generation reservation disappeared.");
					if (existing.status === "submitting" && next.status === "submitting")
						return { acquired: false, record: existing };
					records[sameRequestIndex] = next;
					await write(records);
					return { acquired: true, record: next };
				}
				const active = records.find(
					(item) =>
						!isGenerationTerminal(item.status) &&
						generationIdentity(item.input) === generationIdentity(next.input),
				);
				if (active !== undefined) return { acquired: false, record: active };
				if (
					records.length >= GENERATION_MAX_RECORDS &&
					records.every((item) => !isGenerationTerminal(item.status))
				)
					throw new GenerationStoreCapacityError();
				records.push(next);
				await write(records);
				return { acquired: true, record: next };
			}),
		upsert: (next) =>
			serializeMutation(async () => {
				const records = await read();
				const index = records.findIndex((item) => item.request_id === next.request_id);
				if (
					index === -1 &&
					records.length >= GENERATION_MAX_RECORDS &&
					records.every((item) => !isGenerationTerminal(item.status))
				)
					throw new GenerationStoreCapacityError();
				if (index === -1) records.push(next);
				else records[index] = next;
				await write(records);
			}),
		remove: (requestId) =>
			serializeMutation(async () => {
				const records = await read();
				const remaining = records.filter((item) => item.request_id !== requestId);
				if (remaining.length !== records.length) await write(remaining);
			}),
	};
}
