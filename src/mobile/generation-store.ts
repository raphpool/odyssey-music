import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseSlug } from "../slug.js";
import { NODE_TYPES, type NodeType } from "../types.js";

const REGISTRY_FILE = "generation-store.v1.json";
const REGISTRY_VERSION = 1;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_GENERATIONS = 1000;
const MAX_IMMEDIATE_RESPONSES = 2048;
const CANONICAL_SLUG_BODY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const GENERATION_STATUSES = new Set<GenerationStatus>([
	"pending",
	"running",
	"succeeded",
	"failed",
	"interrupted",
]);
const TERMINAL_STATUSES = new Set<GenerationStatus>(["succeeded", "failed", "interrupted"]);
const TRANSITIONS: Readonly<Record<GenerationStatus, readonly GenerationStatus[]>> = {
	pending: ["running", "failed"],
	running: ["succeeded", "failed"],
	succeeded: [],
	failed: [],
	interrupted: [],
};

export type GenerationStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted";

export interface GenerationRequest {
	userId: string;
	idempotencyKey: string;
	request: unknown;
}

export interface StoredGeneration {
	id: string;
	userId: string;
	idempotencyKey: string;
	fingerprint: string;
	request: JsonValue;
	status: GenerationStatus;
	createdAt: string;
	updatedAt: string;
	terminalAt: string | null;
	/**
	 * Terminal public metadata is deliberately persisted with the job. A process
	 * restart must not lose the node selected by a completed paid generation, nor
	 * turn a known provider failure into an opaque internal error.
	 */
	outcome?: GenerationOutcome;
}

export interface GenerationOutcome {
	nodeId?: string;
	error?: { code: string; retryable: boolean };
}

/** A cache answer has no worker lifecycle, but its idempotency key remains durable for 24h. */
export interface StoredImmediateGeneration {
	userId: string;
	idempotencyKey: string;
	fingerprint: string;
	request: JsonValue;
	nodeId: string;
	createdAt: string;
	updatedAt: string;
	terminalAt: string;
}

export type CreateGenerationResult =
	| { kind: "created"; generation: StoredGeneration }
	| { kind: "existing"; generation: StoredGeneration };

export type GenerationIdempotencyLookup =
	| { kind: "none" }
	| { kind: "generation"; generation: StoredGeneration }
	| { kind: "immediate"; immediate: StoredImmediateGeneration };

export type RecordImmediateGenerationResult =
	| { kind: "created"; immediate: StoredImmediateGeneration }
	| { kind: "existing"; immediate: StoredImmediateGeneration }
	| { kind: "generation"; generation: StoredGeneration };

export interface GenerationStore {
	create(request: GenerationRequest): Promise<CreateGenerationResult>;
	get(id: string): Promise<StoredGeneration | null>;
	list(): Promise<StoredGeneration[]>;
	lookupIdempotency(input: GenerationRequest): Promise<GenerationIdempotencyLookup>;
	recordImmediate(input: GenerationRequest, nodeId: string): Promise<RecordImmediateGenerationResult>;
	transition(id: string, status: GenerationStatus, outcome?: GenerationOutcome): Promise<StoredGeneration>;
}

export interface GenerationStoreOptions {
	stateDir: string;
	now?: () => Date;
	newId?: () => string;
}

export class GenerationStoreError extends Error {
	constructor(
		readonly code:
			| "corrupt_registry"
			| "generation_not_found"
			| "idempotency_conflict"
			| "invalid_generation"
			| "invalid_transition"
			| "store_full"
			| "immediate_store_full"
			| "terminal_generation",
		message: string,
	) {
		super(message);
		this.name = "GenerationStoreError";
	}
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface Registry {
	version: 1;
	generations: StoredGeneration[];
	immediateResponses: StoredImmediateGeneration[];
}

export async function createGenerationStore(options: GenerationStoreOptions): Promise<GenerationStore> {
	const stateDir = options.stateDir;
	const now = options.now ?? (() => new Date());
	const newId = options.newId ?? randomUUID;
	const registryPath = join(stateDir, REGISTRY_FILE);
	let tail: Promise<void> = Promise.resolve();

	async function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = tail.then(operation, operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function withRegistry<T>(mutate: (registry: Registry) => T | Promise<T>): Promise<T> {
		return serialize(async () => {
			const registry = await readRegistry(registryPath);
			const before = JSON.stringify(registry);
			pruneExpiredTerminals(registry, now());
			const result = await mutate(registry);
			if (before !== JSON.stringify(registry)) await writeRegistry(stateDir, registryPath, registry);
			return result;
		});
	}

	await serialize(async () => {
		const registry = await readRegistry(registryPath);
		const before = JSON.stringify(registry);
		let recovered = false;
		for (const generation of registry.generations) {
			if (generation.status === "pending" || generation.status === "running") {
				const timestamp = now().toISOString();
				generation.status = "interrupted";
				generation.updatedAt = timestamp;
				generation.terminalAt = timestamp;
				recovered = true;
			}
		}
		pruneExpiredTerminals(registry, now());
		if (recovered || before !== JSON.stringify(registry))
			await writeRegistry(stateDir, registryPath, registry);
	});

	return {
		create: async (input) =>
			withRegistry((registry) => {
				const userId = validateToken(input.userId, "userId");
				const idempotencyKey = validateToken(input.idempotencyKey, "idempotencyKey");
				const request = normalizeJson(input.request);
				const fingerprint = fingerprintRequest(userId, request);
				const existing = lookupInRegistry(registry, userId, idempotencyKey, fingerprint);
				if (existing.kind === "generation") return { kind: "existing", generation: existing.generation };
				if (existing.kind === "immediate") throwIdempotencyConflict();
				if (
					registry.generations.filter((generation) => isTerminal(generation.status)).length >=
					MAX_TERMINAL_GENERATIONS
				) {
					throw new GenerationStoreError(
						"store_full",
						"generation store has reached its terminal record limit",
					);
				}
				const timestamp = now().toISOString();
				const generation: StoredGeneration = {
					id: newId(),
					userId,
					idempotencyKey,
					fingerprint,
					request,
					status: "pending",
					createdAt: timestamp,
					updatedAt: timestamp,
					terminalAt: null,
				};
				validateGeneration(generation);
				registry.generations.push(generation);
				return { kind: "created", generation: copyGeneration(generation) };
			}),
		get: async (id) =>
			withRegistry((registry) => {
				const generation = registry.generations.find((candidate) => candidate.id === id);
				return generation ? copyGeneration(generation) : null;
			}),
		list: async () => withRegistry((registry) => registry.generations.map(copyGeneration)),
		lookupIdempotency: async (input) =>
			withRegistry((registry) => {
				const userId = validateToken(input.userId, "userId");
				const idempotencyKey = validateToken(input.idempotencyKey, "idempotencyKey");
				const request = normalizeJson(input.request);
				return lookupInRegistry(registry, userId, idempotencyKey, fingerprintRequest(userId, request));
			}),
		recordImmediate: async (input, nodeId) =>
			withRegistry((registry) => {
				const userId = validateToken(input.userId, "userId");
				const idempotencyKey = validateToken(input.idempotencyKey, "idempotencyKey");
				const request = normalizeJson(input.request);
				const fingerprint = fingerprintRequest(userId, request);
				const existing = lookupInRegistry(registry, userId, idempotencyKey, fingerprint);
				if (existing.kind === "generation") return { kind: "generation", generation: existing.generation };
				if (existing.kind === "immediate") return { kind: "existing", immediate: existing.immediate };
				if (registry.immediateResponses.length >= MAX_IMMEDIATE_RESPONSES) {
					throw new GenerationStoreError(
						"immediate_store_full",
						"immediate generation response registry has reached its limit",
					);
				}
				const timestamp = now().toISOString();
				const immediate = validateImmediateGeneration({
					userId,
					idempotencyKey,
					fingerprint,
					request,
					nodeId,
					createdAt: timestamp,
					updatedAt: timestamp,
					terminalAt: timestamp,
				});
				registry.immediateResponses.push(immediate);
				return { kind: "created", immediate: copyImmediateGeneration(immediate) };
			}),
		transition: async (id, status, outcome) =>
			withRegistry((registry) => {
				const generation = registry.generations.find((candidate) => candidate.id === id);
				if (!generation) throw new GenerationStoreError("generation_not_found", "generation does not exist");
				if (isTerminal(generation.status)) {
					throw new GenerationStoreError("terminal_generation", "terminal generations are immutable");
				}
				if (!TRANSITIONS[generation.status].includes(status)) {
					throw new GenerationStoreError("invalid_transition", "generation status transition is not allowed");
				}
				let validatedOutcome: GenerationOutcome | undefined;
				if (outcome !== undefined) {
					if (!isTerminal(status)) {
						throw new GenerationStoreError(
							"invalid_generation",
							"generation outcome requires a terminal status",
						);
					}
					// Validate the durable result before changing the lifecycle state. A bad
					// provider result must not turn an active paid job into a terminal record.
					validatedOutcome = validateOutcome(outcome, generation.request, "invalid_generation");
				}
				generation.status = status;
				generation.updatedAt = now().toISOString();
				generation.terminalAt = isTerminal(status) ? generation.updatedAt : null;
				if (validatedOutcome !== undefined) generation.outcome = validatedOutcome;
				return copyGeneration(generation);
			}),
	};
}

async function readRegistry(path: string): Promise<Registry> {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) {
			throw new GenerationStoreError("corrupt_registry", "generation registry must not be a symbolic link");
		}
		const raw = await readFile(path, "utf8");
		return parseRegistry(raw);
	} catch (error) {
		if (isMissingFile(error)) return { version: REGISTRY_VERSION, generations: [], immediateResponses: [] };
		if (error instanceof GenerationStoreError) throw error;
		throw new GenerationStoreError("corrupt_registry", "generation registry cannot be read");
	}
}

async function writeRegistry(stateDir: string, path: string, registry: Registry): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let file: Awaited<ReturnType<typeof open>> | null = null;
	try {
		file = await open(temporaryPath, "wx", 0o600);
		await file.writeFile(`${JSON.stringify(registry)}\n`, "utf8");
		await file.sync();
		await file.close();
		file = null;
		await rename(temporaryPath, path);
	} finally {
		if (file) await file.close();
	}
}

function parseRegistry(raw: string): Registry {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new GenerationStoreError("corrupt_registry", "generation registry is not valid JSON");
	}
	if (!isRecord(value) || value.version !== REGISTRY_VERSION || !Array.isArray(value.generations)) {
		throw new GenerationStoreError("corrupt_registry", "generation registry has an unsupported shape");
	}
	if (value.immediateResponses !== undefined && !Array.isArray(value.immediateResponses)) {
		throw new GenerationStoreError(
			"corrupt_registry",
			"immediate response registry has an unsupported shape",
		);
	}
	const generations = value.generations.map((generation) => validateGeneration(generation));
	const immediateResponses = (value.immediateResponses ?? []).map((response) =>
		validateImmediateGeneration(response),
	);
	if (new Set(generations.map((generation) => generation.id)).size !== generations.length) {
		throw new GenerationStoreError("corrupt_registry", "generation registry has duplicate ids");
	}
	if (
		new Set(generations.map((generation) => JSON.stringify([generation.userId, generation.idempotencyKey])))
			.size !== generations.length
	) {
		throw new GenerationStoreError("corrupt_registry", "generation registry has duplicate idempotency keys");
	}
	const idempotencyPairs = [
		...generations.map((generation) => JSON.stringify([generation.userId, generation.idempotencyKey])),
		...immediateResponses.map((response) => JSON.stringify([response.userId, response.idempotencyKey])),
	];
	if (new Set(idempotencyPairs).size !== idempotencyPairs.length) {
		throw new GenerationStoreError("corrupt_registry", "generation registry has duplicate idempotency keys");
	}
	if (immediateResponses.length > MAX_IMMEDIATE_RESPONSES) {
		throw new GenerationStoreError("corrupt_registry", "immediate response registry exceeds its limit");
	}
	return { version: REGISTRY_VERSION, generations, immediateResponses };
}

function validateGeneration(value: unknown): StoredGeneration {
	if (!isRecord(value)) throw new GenerationStoreError("corrupt_registry", "generation entry is invalid");
	const status = value.status;
	if (!isGenerationStatus(status))
		throw new GenerationStoreError("corrupt_registry", "generation status is invalid");
	const generation: StoredGeneration = {
		id: validateToken(value.id, "id"),
		userId: validateToken(value.userId, "userId"),
		idempotencyKey: validateToken(value.idempotencyKey, "idempotencyKey"),
		fingerprint: validateFingerprint(value.fingerprint),
		request: normalizeJson(value.request),
		status,
		createdAt: validateTimestamp(value.createdAt, "createdAt"),
		updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
		terminalAt: value.terminalAt === null ? null : validateTimestamp(value.terminalAt, "terminalAt"),
	};
	if (value.outcome !== undefined) generation.outcome = validateOutcome(value.outcome, generation.request);
	if (isTerminal(status) !== (generation.terminalAt !== null)) {
		throw new GenerationStoreError("corrupt_registry", "generation terminal state is inconsistent");
	}
	if (generation.outcome !== undefined && !isTerminal(status)) {
		throw new GenerationStoreError("corrupt_registry", "generation outcome requires a terminal status");
	}
	if (generation.fingerprint !== fingerprintRequest(generation.userId, generation.request)) {
		throw new GenerationStoreError("corrupt_registry", "generation fingerprint does not match its request");
	}
	return generation;
}

type DurableValidationCode = "corrupt_registry" | "invalid_generation";

function validateOutcome(
	value: unknown,
	request: unknown,
	code: DurableValidationCode = "corrupt_registry",
): GenerationOutcome {
	if (!isRecord(value)) throw new GenerationStoreError(code, "generation outcome is invalid");
	const nodeId = value.nodeId;
	const error = value.error;
	if (error !== undefined) {
		if (
			!isRecord(error) ||
			typeof error.code !== "string" ||
			!error.code.trim() ||
			error.code.length > 128 ||
			typeof error.retryable !== "boolean"
		) {
			throw new GenerationStoreError(code, "generation outcome error is invalid");
		}
	}
	if ((nodeId === undefined) === (error === undefined)) {
		throw new GenerationStoreError(code, "generation outcome must contain exactly one result");
	}
	const out: GenerationOutcome = {};
	if (nodeId !== undefined) out.nodeId = validateDurableNodeId(nodeId, request, code, "generation outcome");
	if (
		error !== undefined &&
		isRecord(error) &&
		typeof error.code === "string" &&
		typeof error.retryable === "boolean"
	) {
		out.error = { code: error.code.trim(), retryable: error.retryable };
	}
	return out;
}

function validateImmediateGeneration(value: unknown): StoredImmediateGeneration {
	if (!isRecord(value)) throw new GenerationStoreError("corrupt_registry", "immediate response is invalid");
	const immediate: StoredImmediateGeneration = {
		userId: validateToken(value.userId, "userId"),
		idempotencyKey: validateToken(value.idempotencyKey, "idempotencyKey"),
		fingerprint: validateFingerprint(value.fingerprint),
		request: normalizeJson(value.request),
		nodeId: validateDurableNodeId(value.nodeId, value.request, "corrupt_registry", "immediate response"),
		createdAt: validateTimestamp(value.createdAt, "createdAt"),
		updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
		terminalAt: validateTimestamp(value.terminalAt, "terminalAt"),
	};
	if (immediate.fingerprint !== fingerprintRequest(immediate.userId, immediate.request)) {
		throw new GenerationStoreError(
			"corrupt_registry",
			"immediate response fingerprint does not match its request",
		);
	}
	return immediate;
}

function validateDurableNodeId(
	value: unknown,
	request: unknown,
	code: DurableValidationCode,
	field: string,
): string {
	if (typeof value !== "string" || value !== value.trim() || !value || value.length > 256) {
		throw new GenerationStoreError(code, `${field} node is invalid`);
	}
	const requestType = durableRequestType(request, code, field);
	try {
		const parsed = parseSlug(value);
		if (parsed.type !== requestType || !CANONICAL_SLUG_BODY.test(parsed.body)) {
			throw new GenerationStoreError(code, `${field} node does not match its request`);
		}
	} catch (error) {
		if (error instanceof GenerationStoreError) throw error;
		throw new GenerationStoreError(code, `${field} node is invalid`);
	}
	return value;
}

function durableRequestType(request: unknown, code: DurableValidationCode, field: string): NodeType {
	if (!isRecord(request) || !isNodeType(request.type)) {
		throw new GenerationStoreError(code, `${field} request type is invalid`);
	}
	return request.type;
}

function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

function lookupInRegistry(
	registry: Registry,
	userId: string,
	idempotencyKey: string,
	fingerprint: string,
): GenerationIdempotencyLookup {
	const generation = registry.generations.find(
		(candidate) => candidate.userId === userId && candidate.idempotencyKey === idempotencyKey,
	);
	if (generation) {
		if (generation.fingerprint !== fingerprint) throwIdempotencyConflict();
		return { kind: "generation", generation: copyGeneration(generation) };
	}
	const immediate = registry.immediateResponses.find(
		(candidate) => candidate.userId === userId && candidate.idempotencyKey === idempotencyKey,
	);
	if (immediate) {
		if (immediate.fingerprint !== fingerprint) throwIdempotencyConflict();
		return { kind: "immediate", immediate: copyImmediateGeneration(immediate) };
	}
	return { kind: "none" };
}

function throwIdempotencyConflict(): never {
	throw new GenerationStoreError(
		"idempotency_conflict",
		"idempotency key is already associated with a different request",
	);
}

function pruneExpiredTerminals(registry: Registry, current: Date): void {
	const cutoff = current.getTime() - TERMINAL_TTL_MS;
	registry.generations = registry.generations.filter((generation) => {
		if (!isTerminal(generation.status) || !generation.terminalAt) return true;
		return new Date(generation.terminalAt).getTime() > cutoff;
	});
	registry.immediateResponses = registry.immediateResponses.filter(
		(response) => new Date(response.terminalAt).getTime() > cutoff,
	);
}

function normalizeJson(value: unknown): JsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return value.trim();
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new GenerationStoreError("invalid_generation", "request contains a non-finite number");
		return value;
	}
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (!isRecord(value)) throw new GenerationStoreError("invalid_generation", "request must be JSON data");
	// A regular object treats `__proto__` as a prototype setter. This registry
	// fingerprints untrusted JSON, so use a dictionary with no prototype to retain
	// every JSON key and avoid collisions between distinct requests.
	const normalized: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
	for (const key of Object.keys(value).sort()) normalized[key] = normalizeJson(value[key]);
	return normalized;
}

function fingerprintRequest(userId: string, request: JsonValue): string {
	return `sha256:${createHash("sha256").update(JSON.stringify({ userId, request })).digest("hex")}`;
}

function validateToken(value: unknown, field: string): string {
	if (typeof value !== "string")
		throw new GenerationStoreError("corrupt_registry", `${field} must be a string`);
	const normalized = value.trim();
	if (!normalized || normalized.length > 256) {
		throw new GenerationStoreError("invalid_generation", `${field} must be between 1 and 256 characters`);
	}
	return normalized;
}

function validateFingerprint(value: unknown): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new GenerationStoreError("corrupt_registry", "generation fingerprint is invalid");
	}
	return value;
}

function validateTimestamp(value: unknown, field: string): string {
	if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
		throw new GenerationStoreError("corrupt_registry", `${field} is invalid`);
	}
	return value;
}

function isGenerationStatus(value: unknown): value is GenerationStatus {
	return typeof value === "string" && GENERATION_STATUSES.has(value as GenerationStatus);
}

function isTerminal(status: GenerationStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyGeneration(generation: StoredGeneration): StoredGeneration {
	return structuredClone(generation);
}

function copyImmediateGeneration(response: StoredImmediateGeneration): StoredImmediateGeneration {
	return structuredClone(response);
}
