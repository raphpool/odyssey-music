import "react-native-get-random-values";

import type { AnalyticsSource, EventContext } from "../analytics/contracts";
import type { ApiClient } from "../api/client";
import type { Generation } from "../api/contracts";
import type { ApiClientError, ClientError } from "../api/errors";
import {
	createGenerationStore,
	type GenerationInput,
	type GenerationRecord,
	type GenerationStatus,
	type GenerationStore,
	generationIdentity,
	isGenerationTerminal,
	normalizeGenerationInput,
} from "./store";

export type GenerationApi = {
	createGeneration: ApiClient["createGeneration"];
	getGeneration: ApiClient["getGeneration"];
	getNode?: ApiClient["getNode"];
	getCatalog?: ApiClient["getCatalog"];
};

export type GenerationTrackEvent = (
	name: unknown,
	properties: unknown,
	context: EventContext,
) => Promise<{ kind: "accepted" | "disabled" | "invalid" }>;

export type GenerationPhase = "idle" | "checking" | "submitting" | GenerationStatus | "storage_error";

export type GenerationViewState = {
	phase: GenerationPhase;
	requestId?: string;
	input?: GenerationInput;
	nodeId?: string;
	errorCode?: string;
	retryAfterSeconds?: number;
	message?: string;
};

export type GenerationRequestOptions = {
	apiClient: GenerationApi;
	store?: GenerationStore;
	now?: () => string;
	createRequestId?: () => string;
	trackEvent?: GenerationTrackEvent;
	source?: AnalyticsSource;
	pollIntervalMs?: number;
};

export type GenerationStateListener = (state: GenerationViewState) => void;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createRequestId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isApiError(error: ClientError): error is ApiClientError {
	return error.kind === "api";
}

function isNotFound(error: ClientError): boolean {
	return error.kind === "api" && error.status === 404;
}

function isGone(error: ClientError): boolean {
	return error.kind === "api" && error.status === 410;
}

function isQuota(error: ClientError): error is ApiClientError {
	return isApiError(error) && (error.status === 429 || error.code.toLowerCase().includes("quota"));
}

function publicMessage(phase: GenerationPhase, errorCode?: string): string | undefined {
	const code = errorCode?.toLowerCase();
	if (phase === "busy") {
		if (code?.includes("quota"))
			return "La création est momentanément indisponible. Vous pouvez consulter les fiches existantes.";
		return "Trop de demandes sont en cours. Réessayez dans quelques secondes.";
	}
	if (phase === "confirming" || phase === "unknown")
		return "Statut à confirmer : votre demande n’a pas été déclarée comme échouée.";
	if (phase === "expired") return "Cette demande a expiré. Vous pouvez lancer une nouvelle action.";
	if (phase === "interrupted") return "La création a été interrompue. Vous pouvez réessayer explicitement.";
	if (phase === "failed") return "La fiche n’a pas pu être créée. Vous pouvez réessayer explicitement.";
	return undefined;
}

function controlledFailureCode(
	status: "failed" | "interrupted",
	errorCode?: string,
): "failed" | "interrupted" | "expired" {
	if (errorCode?.toLowerCase().includes("expired")) return "expired";
	return status;
}

function analyticsEventId(
	requestId: string,
	name: "generation_requested" | "generation_completed" | "generation_failed",
): string {
	const suffix = requestId.slice(-2);
	const salt = name === "generation_requested" ? 1 : name === "generation_completed" ? 2 : 3;
	const derived = (Number.parseInt(suffix, 16) ^ salt).toString(16).padStart(2, "0");
	return `${requestId.slice(0, -2)}${derived}`;
}

function canPollStatus(status: GenerationStatus): boolean {
	return status === "submitting" || status === "queued" || status === "running" || status === "confirming";
}

function stateFromRecord(record: GenerationRecord): GenerationViewState {
	const phase = record.status;
	const message = publicMessage(phase, record.error_code);
	return {
		phase,
		requestId: record.request_id,
		input: record.input,
		...(record.node_id === undefined ? {} : { nodeId: record.node_id }),
		...(record.error_code === undefined ? {} : { errorCode: record.error_code }),
		...(record.retry_after_seconds === undefined ? {} : { retryAfterSeconds: record.retry_after_seconds }),
		...(message === undefined ? {} : { message }),
	};
}

function makeRecord(input: GenerationInput, requestId: string, now: string): GenerationRecord {
	return {
		request_id: requestId,
		input,
		created_at: now,
		// This durable pre-acknowledgement state survives a crash after the POST reached the server.
		status: "submitting",
		event_flags: { requested: false, completed: false, failed: false },
	};
}

function retryRecord(
	record: GenerationRecord,
	createRequestId: () => string,
	now: () => string,
): GenerationRecord {
	const { node_id: _nodeId, error_code: _errorCode, retry_after_seconds: _retryAfter, ...base } = record;
	if (record.status === "unknown" || record.status === "busy" || record.status === "confirming")
		return { ...base, status: "submitting" };
	return makeRecord(record.input, createRequestId(), now());
}

export class GenerationRequestController {
	private readonly apiClient: GenerationApi;
	private readonly store: GenerationStore;
	private readonly now: () => string;
	private readonly createRequestId: () => string;
	private readonly trackEvent: GenerationTrackEvent | undefined;
	private readonly source: AnalyticsSource;
	private readonly pollIntervalMs: number;
	private readonly listeners = new Set<GenerationStateListener>();
	private records: GenerationRecord[] = [];
	private state: GenerationViewState = { phase: "idle" };
	private activeRecord: GenerationRecord | undefined;
	private hydrated = false;
	private hydrating: Promise<void> | undefined;
	private foreground = true;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private pollController: AbortController | undefined;
	private postController: AbortController | undefined;
	private readonly starts = new Map<string, Promise<GenerationViewState>>();
	private retrying: Promise<GenerationViewState> | undefined;
	private readonly analyticsResumes = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(options: GenerationRequestOptions) {
		this.apiClient = options.apiClient;
		this.store = options.store ?? createGenerationStore();
		this.now = options.now ?? (() => new Date().toISOString());
		this.createRequestId = options.createRequestId ?? createRequestId;
		this.trackEvent = options.trackEvent;
		this.source = options.source ?? "deeplink";
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	getState(): GenerationViewState {
		return this.state;
	}

	subscribe(listener: GenerationStateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async hydrate(input?: GenerationInput): Promise<void> {
		if (this.disposed) return;
		if (this.hydrated) {
			if (input !== undefined) this.selectRecord(input);
			return;
		}
		if (this.hydrating !== undefined) return this.hydrating;
		this.hydrating = this.store
			.list()
			.then((records) => {
				if (this.disposed) return;
				this.records = records;
				this.hydrated = true;
				if (input !== undefined) this.selectRecord(input);
			})
			.catch(() => {
				this.setState({ phase: "storage_error", message: "Impossible d’enregistrer la demande. Réessayez." });
			})
			.finally(() => {
				this.hydrating = undefined;
			});
		return this.hydrating;
	}

	setForeground(value: boolean): void {
		this.foreground = value;
		if (!value) {
			if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
			this.pollController?.abort();
			this.pollController = undefined;
			return;
		}
		if (
			this.activeRecord !== undefined &&
			canPollStatus(this.activeRecord.status) &&
			this.postController === undefined &&
			!this.analyticsResumes.has(this.activeRecord.request_id)
		)
			void this.pollActive();
	}

	async start(input: GenerationInput): Promise<GenerationViewState> {
		const normalized = normalizeGenerationInput(input);
		if (normalized === undefined) {
			this.setState({ phase: "storage_error", message: "Cette fiche ne peut pas être créée." });
			return this.state;
		}
		const identity = generationIdentity(normalized);
		const pending = this.starts.get(identity);
		if (pending !== undefined) return pending;
		const operation = this.startInternal(normalized);
		this.starts.set(identity, operation);
		try {
			return await operation;
		} finally {
			if (this.starts.get(identity) === operation) this.starts.delete(identity);
		}
	}

	private async startInternal(normalized: GenerationInput): Promise<GenerationViewState> {
		await this.hydrate(normalized);
		if (this.disposed) return this.state;

		const existing = this.findRecord(normalized);
		if (existing !== undefined && !isGenerationTerminal(existing.status)) {
			this.activeRecord = existing;
			this.setState(stateFromRecord(existing));
			if (this.foreground && canPollStatus(existing.status) && this.postController === undefined)
				void this.pollActive();
			return this.state;
		}

		const checked = await this.checkExistingNode(normalized);
		if (checked === "exists" || checked === "unavailable" || checked === "cancelled") return this.state;

		const record =
			existing === undefined
				? makeRecord(normalized, this.createRequestId(), this.now())
				: retryRecord(existing, this.createRequestId, this.now);
		const reservation = await this.reserve(record);
		if (reservation === undefined) return this.state;
		this.activeRecord = reservation.record;
		this.setState(stateFromRecord(reservation.record));
		if (!reservation.acquired) {
			if (this.foreground && canPollStatus(reservation.record.status)) void this.pollActive();
			return this.state;
		}
		return this.submit(reservation.record);
	}

	async retry(): Promise<GenerationViewState> {
		if (this.retrying !== undefined) return this.retrying;
		const operation = this.retryInternal();
		this.retrying = operation;
		try {
			return await operation;
		} finally {
			if (this.retrying === operation) this.retrying = undefined;
		}
	}

	private async retryInternal(): Promise<GenerationViewState> {
		if (this.disposed) return this.state;
		await this.hydrate();
		const record =
			this.activeRecord ??
			(this.state.requestId === undefined ? undefined : this.findById(this.state.requestId));
		if (record === undefined)
			return this.state.input === undefined ? this.state : this.start(this.state.input);
		if (this.postController !== undefined) return this.state;
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
		const polling = this.pollController;
		polling?.abort();
		if (this.pollController === polling) this.pollController = undefined;
		const checked = await this.checkExistingNode(record.input);
		if (checked === "exists" || checked === "unavailable" || checked === "cancelled") return this.state;
		const next = retryRecord(record, this.createRequestId, this.now);
		const reservation = await this.reserve(next);
		if (reservation === undefined) return this.state;
		this.activeRecord = reservation.record;
		this.setState(stateFromRecord(reservation.record));
		if (!reservation.acquired) {
			if (this.foreground && canPollStatus(reservation.record.status)) void this.pollActive();
			return this.state;
		}
		return this.submit(reservation.record);
	}

	dispose(): void {
		this.disposed = true;
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollController?.abort();
		this.postController?.abort();
		this.pollTimer = undefined;
		this.pollController = undefined;
		this.postController = undefined;
		this.listeners.clear();
	}

	private setState(next: GenerationViewState): void {
		if (this.disposed) return;
		this.state = next;
		for (const listener of this.listeners) listener(next);
	}

	private selectRecord(input: GenerationInput): void {
		const matching = this.findRecord(input);
		if (matching === undefined) return;
		this.activeRecord = isGenerationTerminal(matching.status) ? undefined : matching;
		this.setState(stateFromRecord(matching));
		const analyticsResume = this.resumeAnalytics(matching);
		void analyticsResume.finally(() => {
			if (
				this.foreground &&
				this.activeRecord?.request_id === matching.request_id &&
				canPollStatus(this.activeRecord.status) &&
				this.postController === undefined
			)
				void this.pollActive();
		});
	}

	private findRecord(input: GenerationInput): GenerationRecord | undefined {
		return this.records
			.filter((item) => generationIdentity(item.input) === generationIdentity(input))
			.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
	}

	private findById(requestId: string): GenerationRecord | undefined {
		return this.records.find((item) => item.request_id === requestId);
	}

	private async persist(record: GenerationRecord): Promise<boolean> {
		try {
			await this.store.upsert(record);
			const index = this.records.findIndex((item) => item.request_id === record.request_id);
			if (index === -1) this.records.push(record);
			else this.records[index] = record;
			return true;
		} catch {
			this.setState({ phase: "storage_error", message: "Impossible d’enregistrer la demande. Réessayez." });
			return false;
		}
	}

	private async reserve(
		record: GenerationRecord,
	): Promise<{ acquired: boolean; record: GenerationRecord } | undefined> {
		try {
			const reservation = await this.store.reserve(record);
			const index = this.records.findIndex((item) => item.request_id === reservation.record.request_id);
			if (index === -1) this.records.push(reservation.record);
			else this.records[index] = reservation.record;
			return reservation;
		} catch {
			this.setState({ phase: "storage_error", message: "Impossible d’enregistrer la demande. Réessayez." });
			return undefined;
		}
	}

	private async remove(requestId: string): Promise<void> {
		try {
			await this.store.remove(requestId);
			this.records = this.records.filter((item) => item.request_id !== requestId);
		} catch {
			// Keeping a terminal record is safe: its durable flags prevent duplicate analytics after restart.
		}
	}

	private async emit(
		name: "generation_requested" | "generation_completed" | "generation_failed",
		properties: Record<string, string>,
		requestId: string,
	): Promise<boolean> {
		// No tracker means the event happened without consent and must never be caught up later.
		if (this.trackEvent === undefined) return true;
		try {
			const result = await this.trackEvent(name, properties, {
				source: this.source,
				event_id: analyticsEventId(requestId, name),
			});
			return result.kind === "accepted";
		} catch {
			// Analytics transport failures must not turn a public generation into an error.
			return false;
		}
	}

	private async markRequested(record: GenerationRecord): Promise<GenerationRecord | undefined> {
		if (record.event_flags.requested) return record;
		const accepted = await this.emit(
			"generation_requested",
			{
				request_id: record.request_id,
				node_type: record.input.type,
			},
			record.request_id,
		);
		if (!accepted) return record;
		const next: GenerationRecord = {
			...record,
			event_flags: { ...record.event_flags, requested: true },
		};
		if (!(await this.persist(next))) return undefined;
		return next;
	}

	private async markCompleted(record: GenerationRecord): Promise<GenerationRecord | undefined> {
		if (record.event_flags.completed) return record;
		const accepted = await this.emit(
			"generation_completed",
			{
				request_id: record.request_id,
				node_id: record.node_id ?? "",
				node_type: record.input.type,
			},
			record.request_id,
		);
		if (!accepted) return record;
		const next: GenerationRecord = {
			...record,
			event_flags: { ...record.event_flags, completed: true },
		};
		return (await this.persist(next)) ? next : undefined;
	}

	private async markFailed(
		record: GenerationRecord,
		eventCode: "failed" | "interrupted" | "expired",
	): Promise<GenerationRecord | undefined> {
		if (record.event_flags.failed) return record;
		const accepted = await this.emit(
			"generation_failed",
			{
				request_id: record.request_id,
				node_type: record.input.type,
				error_code: eventCode,
			},
			record.request_id,
		);
		if (!accepted) return record;
		const next: GenerationRecord = {
			...record,
			event_flags: { ...record.event_flags, failed: true },
		};
		return (await this.persist(next)) ? next : undefined;
	}

	private resumeAnalytics(record: GenerationRecord): Promise<void> {
		const key = record.request_id;
		const existing = this.analyticsResumes.get(key);
		if (existing !== undefined) return existing;
		const operation = (async () => {
			let current = this.findById(record.request_id) ?? record;
			const requested = await this.markRequested(current);
			if (requested === undefined || this.disposed) return;
			current = requested;
			if (current.status === "succeeded" && current.node_id !== undefined) {
				const completed = await this.markCompleted(current);
				if (completed?.event_flags.requested && completed.event_flags.completed)
					await this.remove(completed.request_id);
				return;
			}
			if (current.status === "failed" || current.status === "interrupted" || current.status === "expired") {
				await this.markFailed(
					current,
					controlledFailureCode(current.status === "expired" ? "failed" : current.status, current.error_code),
				);
			}
			const latest = this.findById(key);
			if (latest !== undefined && this.activeRecord?.request_id === key) this.activeRecord = latest;
		})();
		this.analyticsResumes.set(key, operation);
		void operation.finally(() => {
			if (this.analyticsResumes.get(key) === operation) this.analyticsResumes.delete(key);
		});
		return operation;
	}

	private async submit(record: GenerationRecord): Promise<GenerationViewState> {
		if (this.postController !== undefined) return this.state;
		const requested = await this.markRequested(record);
		if (requested === undefined) return this.state;
		this.activeRecord = requested;
		this.setState({ phase: "submitting", requestId: requested.request_id, input: requested.input });
		const controller = new AbortController();
		this.postController = controller;
		try {
			const result = await this.apiClient.createGeneration({
				requestId: requested.request_id,
				type: requested.input.type,
				name: requested.input.name,
				...(requested.input.slug === undefined ? {} : { slug: requested.input.slug }),
				...(requested.input.mbid === undefined ? {} : { mbid: requested.input.mbid }),
				...(requested.input.qid === undefined ? {} : { qid: requested.input.qid }),
				...(requested.input.disambiguator === undefined
					? {}
					: { disambiguator: requested.input.disambiguator }),
				signal: controller.signal,
			});
			if (this.disposed) return this.state;
			if (result.kind === "success") return this.acceptGeneration(result.value, requested);
			return this.handlePostError(result.error, requested);
		} finally {
			if (this.postController === controller) {
				this.postController = undefined;
				this.schedulePoll();
			}
		}
	}

	private async checkExistingNode(
		input: GenerationInput,
	): Promise<"missing" | "exists" | "unavailable" | "cancelled"> {
		if (input.slug === undefined || this.apiClient.getNode === undefined) return "missing";
		this.setState({ phase: "checking", input });
		const controller = new AbortController();
		const result = await this.apiClient.getNode(input.slug, controller.signal);
		if (this.disposed || (result.kind === "error" && result.error.kind === "cancelled")) return "cancelled";
		if (result.kind === "success") {
			this.setState({ phase: "succeeded", input, nodeId: result.value.node.id });
			return "exists";
		}
		if (isNotFound(result.error)) return "missing";
		this.setState({ phase: "confirming", input, message: "Impossible de vérifier la fiche pour le moment." });
		return "unavailable";
	}

	private async handlePostError(error: ClientError, record: GenerationRecord): Promise<GenerationViewState> {
		if (error.kind === "cancelled" && this.disposed) return this.state;
		if (isQuota(error)) {
			const next: GenerationRecord = {
				...record,
				status: "busy",
				...(error.retryAfterSeconds === undefined ? {} : { retry_after_seconds: error.retryAfterSeconds }),
				error_code: error.code,
			};
			await this.persist(next);
			this.activeRecord = next;
			this.setState(stateFromRecord(next));
			return this.state;
		}
		if (isGone(error)) return this.acceptFailure(record, "expired", "expired");

		const confirming: GenerationRecord = { ...record, status: "confirming" };
		if (!(await this.persist(confirming))) return this.state;
		this.activeRecord = confirming;
		this.setState(stateFromRecord(confirming));
		return this.confirmAfterPostUncertainty(confirming);
	}

	private async confirmAfterPostUncertainty(record: GenerationRecord): Promise<GenerationViewState> {
		if (!this.foreground) {
			// Generation status reads are foreground-only; resume will poll the persisted request.
			return this.state;
		}
		const controller = new AbortController();
		this.pollController = controller;
		try {
			const result = await this.apiClient.getGeneration(record.request_id, controller.signal);
			if (this.disposed) return this.state;
			if (result.kind === "success") return this.acceptGeneration(result.value, record);
			if (isGone(result.error) || isNotFound(result.error)) {
				const unknown: GenerationRecord = { ...record, status: "unknown", error_code: "unknown" };
				await this.persist(unknown);
				this.activeRecord = unknown;
				this.setState(stateFromRecord(unknown));
				return this.state;
			}
			const error = result.error;
			if (error.kind === "api" && (error.status === 429 || error.code.toLowerCase().includes("quota"))) {
				const busy: GenerationRecord = {
					...record,
					status: "busy",
					error_code: error.code,
					...(error.retryAfterSeconds === undefined ? {} : { retry_after_seconds: error.retryAfterSeconds }),
				};
				await this.persist(busy);
				this.activeRecord = busy;
				this.setState(stateFromRecord(busy));
				return this.state;
			}
			this.setState({
				...stateFromRecord(record),
				message: "Statut à confirmer : vérifiez à nouveau plus tard.",
			});
			return this.state;
		} finally {
			if (this.pollController === controller) this.pollController = undefined;
		}
	}

	private async acceptGeneration(
		generation: Generation,
		record: GenerationRecord,
	): Promise<GenerationViewState> {
		if (generation.status === "succeeded") {
			if (generation.node_id === undefined) return this.acceptFailure(record, "failed", "failed");
			let succeeded: GenerationRecord = {
				...record,
				status: "succeeded",
				node_id: generation.node_id,
			};
			if (!(await this.persist(succeeded))) return this.state;
			const completed = await this.markCompleted(succeeded);
			if (completed === undefined) return this.state;
			succeeded = completed;
			if (succeeded.event_flags.requested && succeeded.event_flags.completed)
				await this.remove(record.request_id);
			this.activeRecord = undefined;
			this.setState({
				phase: "succeeded",
				requestId: record.request_id,
				input: record.input,
				nodeId: generation.node_id,
			});
			void this.apiClient.getCatalog?.().catch(() => {
				// A catalog refresh is opportunistic; the canonical node is opened immediately.
			});
			return this.state;
		}
		if (generation.status === "queued" || generation.status === "running") {
			const next: GenerationRecord = {
				...record,
				status: generation.status,
			};
			if (!(await this.persist(next))) return this.state;
			this.activeRecord = next;
			this.setState(stateFromRecord(next));
			this.schedulePoll();
			return this.state;
		}
		return this.acceptFailure(record, generation.status, generation.error?.code);
	}

	private async acceptFailure(
		record: GenerationRecord,
		status: "failed" | "interrupted" | "expired",
		errorCode?: string,
	): Promise<GenerationViewState> {
		let next: GenerationRecord = {
			...record,
			status,
			...(errorCode === undefined ? {} : { error_code: errorCode }),
		};
		const eventCode = controlledFailureCode(status === "expired" ? "failed" : status, errorCode);
		if (!(await this.persist(next))) return this.state;
		const failed = await this.markFailed(next, eventCode);
		if (failed === undefined) return this.state;
		next = failed;
		this.activeRecord = undefined;
		this.setState(stateFromRecord(next));
		return this.state;
	}

	private schedulePoll(delay = this.pollIntervalMs): void {
		if (
			!this.foreground ||
			this.disposed ||
			this.postController !== undefined ||
			this.activeRecord === undefined ||
			this.analyticsResumes.has(this.activeRecord.request_id) ||
			!canPollStatus(this.activeRecord.status)
		)
			return;
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			void this.pollActive();
		}, delay);
	}

	private async pollActive(): Promise<void> {
		if (
			!this.foreground ||
			this.disposed ||
			this.postController !== undefined ||
			this.activeRecord === undefined ||
			this.analyticsResumes.has(this.activeRecord.request_id) ||
			!canPollStatus(this.activeRecord.status)
		)
			return;
		if (this.pollController !== undefined) return;
		const record = this.findById(this.activeRecord.request_id) ?? this.activeRecord;
		this.activeRecord = record;
		const controller = new AbortController();
		this.pollController = controller;
		try {
			const result = await this.apiClient.getGeneration(record.request_id, controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			if (result.kind === "success") {
				await this.acceptGeneration(result.value, record);
				return;
			}
			if (
				isGone(result.error) &&
				(record.status === "submitting" || record.status === "confirming" || record.status === "unknown")
			) {
				const unknown: GenerationRecord = { ...record, status: "unknown", error_code: "unknown" };
				if (!(await this.persist(unknown))) return;
				this.activeRecord = unknown;
				this.setState(stateFromRecord(unknown));
				return;
			}
			if (isGone(result.error)) {
				await this.acceptFailure(record, "expired", "expired");
				return;
			}
			const error = result.error;
			if (error.kind === "api" && (error.status === 429 || error.code.toLowerCase().includes("quota"))) {
				const busy: GenerationRecord = {
					...record,
					status: "busy",
					error_code: error.code,
					...(error.retryAfterSeconds === undefined ? {} : { retry_after_seconds: error.retryAfterSeconds }),
				};
				await this.persist(busy);
				this.activeRecord = busy;
				this.setState(stateFromRecord(busy));
				return;
			}
			// A network failure is not a generation failure; keep the same request and try the GET later.
			this.setState(stateFromRecord(record));
		} finally {
			if (this.pollController === controller) this.pollController = undefined;
		}
		this.schedulePoll();
	}
}

export function createGenerationController(options: GenerationRequestOptions): GenerationRequestController {
	return new GenerationRequestController(options);
}

export { uuidPattern };
