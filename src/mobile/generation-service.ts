import { BadRequestError } from "../errors.js";
import { MaterializeCacheMissError } from "../services/materialize-service.js";
import { normalizeSlugBody } from "../slug.js";
import {
	classifyGenerationFailure,
	MobileGenerationError,
	type MobileGenerationErrorCode,
} from "./generation-errors.js";
import type {
	CreateGenerationResult,
	GenerationOutcome,
	GenerationStore,
	GenerationStoreError,
	StoredGeneration,
	StoredImmediateGeneration,
} from "./generation-store.js";

const MAX_RUNNING = 2;
const MAX_WAITING = 10;
const PUBLIC_USER = "public";

export interface MobileGenerationInput {
	requestId: string;
	type: string;
	name: string;
	slug?: string;
	// TRA-477: primary artist of the clicked project/track, and the edge the click came from. Both are
	// forwarded to /materialize as sent (already shape-checked by generation-routes).
	artist?: string;
	source?: { slug: string; field: string };
	mbid?: string;
	qid?: string;
	disambiguator?: string;
}

interface MaterializedNode {
	slug: string;
}

export interface MobileGenerationService {
	submit(input: MobileGenerationInput): Promise<MobileGenerationSnapshot>;
	get(id: string): Promise<MobileGenerationSnapshot>;
}

export interface MobileGenerationSnapshot {
	request_id: string;
	status: "queued" | "running" | "succeeded" | "failed" | "interrupted";
	created_at: string;
	updated_at: string;
	node_id?: string;
	error?: { code: MobileGenerationErrorCode; message: string; retryable: boolean };
	/** Internal routing marker. It is stripped before an immediate HTTP response. */
	immediate?: true;
}

export interface MobileGenerationDependencies {
	store: GenerationStore;
	materialize: {
		handleMaterialize(
			request: Omit<MobileGenerationInput, "requestId">,
			options: { reuseExisting: true; cacheOnly?: true; maxProviderAttempts?: 1 },
		): Promise<{ node: MaterializedNode }>;
	};
	invalidateSearch?(): void;
	invalidateCatalog?(): void;
}

interface WorkResult {
	node?: { slug: string };
	error?: MobileGenerationError;
}

export function createMobileGenerationService(
	dependencies: MobileGenerationDependencies,
): MobileGenerationService {
	let admission = Promise.resolve();
	let running = 0;
	let unavailable = false;
	const queue: MobileGenerationInput[] = [];
	const works = new Map<string, Promise<WorkResult>>();

	function latchUnavailable(): void {
		unavailable = true;
		queue.splice(0, queue.length);
	}

	async function readGenerations(): Promise<StoredGeneration[]> {
		try {
			return await dependencies.store.list();
		} catch {
			latchUnavailable();
			throw new MobileGenerationError("provider_unavailable", true);
		}
	}

	async function lookupIdempotency(input: MobileGenerationInput) {
		try {
			return await dependencies.store.lookupIdempotency({
				userId: PUBLIC_USER,
				idempotencyKey: input.requestId,
				request: input,
			});
		} catch (error) {
			if (hasGenerationStoreCode(error, "idempotency_conflict")) {
				throw new MobileGenerationError("idempotency_conflict", false);
			}
			latchUnavailable();
			throw new MobileGenerationError("provider_unavailable", true);
		}
	}

	async function recordImmediate(input: MobileGenerationInput, nodeId: string) {
		try {
			return await dependencies.store.recordImmediate(
				{ userId: PUBLIC_USER, idempotencyKey: input.requestId, request: input },
				nodeId,
			);
		} catch (error) {
			if (hasGenerationStoreCode(error, "idempotency_conflict")) {
				throw new MobileGenerationError("idempotency_conflict", false);
			}
			if (hasGenerationStoreCode(error, "immediate_store_full")) {
				throw new MobileGenerationError("busy", true);
			}
			latchUnavailable();
			throw new MobileGenerationError("provider_unavailable", true);
		}
	}

	async function transition(
		id: string,
		status: "running" | "succeeded" | "failed",
		outcome?: GenerationOutcome,
	) {
		try {
			return await dependencies.store.transition(id, status, outcome);
		} catch {
			latchUnavailable();
			throw new MobileGenerationError("provider_unavailable", true);
		}
	}

	async function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = admission.then(operation, operation);
		admission = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function identity(input: MobileGenerationInput): string {
		const disambiguator = normalizeSlugBody(input.disambiguator ?? "");
		return JSON.stringify({
			type: input.type,
			// makeSlug uses this same normalization. Queueing by display spelling made
			// case-only requests pay for two identical artist nodes (TRA-295 review).
			name: normalizeSlugBody(input.name),
			slug: input.slug ?? null,
			// TRA-477: the artist scopes a work and the source edge is repointed per request, so
			// neither may be shared with a request that differs on them.
			artist: normalizeSlugBody(input.artist ?? "") || null,
			source: input.source ? `${input.source.slug}#${input.source.field}` : null,
			mbid: input.mbid?.toLowerCase() ?? null,
			qid: input.qid ?? null,
			// makeSlug omits an empty normalized suffix, so represent it exactly like
			// an absent disambiguator in the paid-work identity (TRA-295 review).
			disambiguator: disambiguator || null,
		});
	}

	function snapshot(generation: StoredGeneration): MobileGenerationSnapshot {
		const out: MobileGenerationSnapshot = {
			request_id: generation.idempotencyKey,
			status: generation.status === "pending" ? "queued" : generation.status,
			created_at: generation.createdAt,
			updated_at: generation.updatedAt,
		};
		if (generation.outcome?.nodeId) out.node_id = generation.outcome.nodeId;
		if (generation.outcome?.error) {
			const error = publicError(generation.outcome.error.code, generation.outcome.error.retryable);
			out.error = {
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			};
		} else if (generation.status === "interrupted") {
			const error = new MobileGenerationError("interrupted", false);
			out.error = { code: error.code, message: error.message, retryable: error.retryable };
		}
		return out;
	}

	function cachedSnapshot(response: StoredImmediateGeneration): MobileGenerationSnapshot {
		return {
			request_id: response.idempotencyKey,
			status: "succeeded",
			created_at: response.createdAt,
			updated_at: response.updatedAt,
			node_id: response.nodeId,
			immediate: true,
		};
	}

	function publicError(code: string, retryable: boolean): MobileGenerationError {
		if (code === "provider_quota_exhausted") {
			return new MobileGenerationError("provider_quota_exhausted", false);
		}
		if (code === "provider_unavailable") {
			return new MobileGenerationError("provider_unavailable", retryable);
		}
		if (code === "interrupted") return new MobileGenerationError("interrupted", false);
		return new MobileGenerationError("internal_error", false);
	}

	async function settle(id: string, work: Promise<WorkResult>): Promise<void> {
		let result = await work;
		if (!result.error && !result.node?.slug) {
			result = { error: new MobileGenerationError("internal_error", false) };
		}
		const outcome: GenerationOutcome = result.error
			? { error: { code: result.error.code, retryable: result.error.retryable } }
			: { nodeId: result.node?.slug ?? "" };
		await transition(id, result.error ? "failed" : "succeeded", outcome);
		if (!result.error) {
			dependencies.invalidateSearch?.();
			dependencies.invalidateCatalog?.();
		}
	}

	function pump(): void {
		let index = 0;
		while (index < queue.length) {
			const input = queue[index];
			if (!input) return;
			const key = identity(input);
			let work = works.get(key);
			const startsWork = work === undefined;
			if (!work && running >= MAX_RUNNING) {
				index += 1;
				continue;
			}
			queue.splice(index, 1);
			if (!work) {
				running += 1;
				const rawWork = (async () => {
					const generation = (await readGenerations()).find(
						(candidate) => candidate.userId === PUBLIC_USER && candidate.idempotencyKey === input.requestId,
					);
					if (!generation) return { error: new MobileGenerationError("internal_error", false) };
					await transition(generation.id, "running");
					try {
						const response = await dependencies.materialize.handleMaterialize(toMaterializeRequest(input), {
							reuseExisting: true,
							maxProviderAttempts: 1,
						});
						return { node: { slug: response.node.slug } };
					} catch (error) {
						return { error: classifyGenerationFailure(error) };
					}
				})();
				// Observe a raw worker rejection synchronously at construction time. Both the
				// worker and its follower read the registry, and a disk failure can reject either
				// promise before a later scheduler turn gets a chance to attach a handler.
				work = rawWork.then(
					(result) => result,
					() => {
						latchUnavailable();
						return { error: new MobileGenerationError("provider_unavailable", true) };
					},
				);
				works.set(key, work);
			}
			const settleRequest = async () => {
				try {
					const generation = (await readGenerations()).find(
						(candidate) => candidate.userId === PUBLIC_USER && candidate.idempotencyKey === input.requestId,
					);
					if (!generation) return;
					// The leading request persists its running state before materialization.
					// Followers share that work but still expose their own running lifecycle.
					if (!startsWork && generation.status === "pending") {
						await transition(generation.id, "running");
					}
					await settle(generation.id, work);
				} catch {
					latchUnavailable();
					// The durable store is the authority. A failed transition must not expose internals.
				}
			};
			const completion = settleRequest();
			if (startsWork) {
				// Do not free capacity when the paid call returns. The store's terminal transition is
				// part of the work: if it fails, latch before a later queued request can start.
				void completion
					.then(() => {
						running -= 1;
						queueMicrotask(() => works.delete(key));
						if (!unavailable) pump();
					})
					.catch(() => latchUnavailable());
			}
		}
	}

	return {
		async submit(input) {
			return serialize(async () => {
				if (unavailable) throw new MobileGenerationError("provider_unavailable", true);
				const existing = await lookupIdempotency(input);
				if (existing.kind === "generation") return snapshot(existing.generation);
				if (existing.kind === "immediate") return cachedSnapshot(existing.immediate);
				try {
					const cached = await dependencies.materialize.handleMaterialize(toMaterializeRequest(input), {
						reuseExisting: true,
						cacheOnly: true,
					});
					// A known node is an answer, not a generation. Record only its durable
					// idempotency result: it never occupies a worker or job-capacity slot.
					const immediate = await recordImmediate(input, cached.node.slug);
					if (immediate.kind === "generation") return snapshot(immediate.generation);
					return cachedSnapshot(immediate.immediate);
				} catch (error) {
					if (error instanceof MobileGenerationError) {
						throw error;
					}
					if (error instanceof MaterializeCacheMissError) {
						// A cache miss is the only preflight result that may enter the queue.
					} else if (error instanceof BadRequestError) {
						throw new MobileGenerationError("invalid_request", false);
					} else {
						throw new MobileGenerationError("internal_error", false);
					}
				}
				const generations = await readGenerations();
				const previous = generations.find(
					(generation) => generation.userId === PUBLIC_USER && generation.idempotencyKey === input.requestId,
				);
				if (!previous) {
					const active = generations.filter(
						(generation) => generation.status === "pending" || generation.status === "running",
					).length;
					if (active >= MAX_RUNNING + MAX_WAITING) throw new MobileGenerationError("busy", true);
				}
				let created: CreateGenerationResult;
				try {
					created = await dependencies.store.create({
						userId: PUBLIC_USER,
						idempotencyKey: input.requestId,
						request: input,
					});
				} catch (error) {
					if (hasGenerationStoreCode(error, "idempotency_conflict")) {
						throw new MobileGenerationError("idempotency_conflict", false);
					}
					if (hasGenerationStoreCode(error, "store_full")) {
						// The terminal cap is an admission result, not a damaged registry. Its normal
						// TTL pruning can make a later request admissible in this same process.
						throw new MobileGenerationError("busy", true);
					}
					latchUnavailable();
					throw new MobileGenerationError("provider_unavailable", true);
				}
				if (created.kind === "created") {
					queue.push(input);
					queueMicrotask(pump);
				}
				return snapshot(created.generation);
			});
		},
		async get(requestId) {
			if (unavailable) throw new MobileGenerationError("provider_unavailable", true);
			const generation = (await readGenerations()).find(
				(candidate) => candidate.userId === PUBLIC_USER && candidate.idempotencyKey === requestId,
			);
			if (!generation) throw new MobileGenerationError("job_expired", false);
			return snapshot(generation);
		},
	};
}

function toMaterializeRequest(input: MobileGenerationInput): Omit<MobileGenerationInput, "requestId"> {
	const { requestId: _, ...request } = input;
	return request;
}

function hasGenerationStoreCode(error: unknown, code: GenerationStoreError["code"]): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
