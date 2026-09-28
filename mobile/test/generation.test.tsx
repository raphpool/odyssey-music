import { fireEvent, render, waitFor } from "@testing-library/react-native";

import { useAnalytics } from "../src/analytics/provider";
import type { SearchResponse } from "../src/api/contracts";
import { SearchResults } from "../src/components/SearchResults";
import {
	createGenerationController,
	type GenerationApi,
	type GenerationTrackEvent,
} from "../src/generation/request";
import { GenerationStatus } from "../src/generation/status";
import {
	clearGenerationStorage,
	createGenerationStore,
	GENERATION_MAX_RECORDS,
	GENERATION_STORAGE_KEY,
	type GenerationInput,
	type GenerationRecord,
	type GenerationStorage,
	normalizeGenerationInput,
} from "../src/generation/store";

jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

const mockedUseAnalytics = jest.mocked(useAnalytics);

const input: GenerationInput = {
	type: "artist",
	name: "Massive Attack",
	mbid: "11111111-1111-4111-8111-111111111111",
};

function generation(
	status: "queued" | "running" | "succeeded" | "failed" | "interrupted",
	requestId: string,
) {
	return {
		request_id: requestId,
		status,
		created_at: "2026-09-27T00:00:00.000Z",
		updated_at: "2026-09-27T00:01:00.000Z",
		...(status === "succeeded"
			? { node_id: "artist:massive-attack" }
			: status === "failed" || status === "interrupted"
				? { error: { code: status, message: "public", retryable: false } }
				: {}),
	};
}

function memoryStorage(initial?: string): GenerationStorage & { value: string | null } {
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

function clientWith(overrides: Partial<GenerationApi> = {}): GenerationApi {
	const defaultCreate = jest.fn(async ({ requestId }: Parameters<GenerationApi["createGeneration"]>[0]) => ({
		kind: "success" as const,
		value: generation("queued", requestId),
	})) as jest.MockedFunction<GenerationApi["createGeneration"]>;
	const defaultGet = jest.fn(async (requestId: string) => ({
		kind: "success" as const,
		value: generation("queued", requestId),
	})) as jest.MockedFunction<GenerationApi["getGeneration"]>;
	return {
		createGeneration: defaultCreate,
		getGeneration: defaultGet,
		...overrides,
	};
}

function analytics(
	status: "granted" | "denied" = "granted",
	trackEvent = jest.fn(async () => ({ kind: "accepted" as const })),
) {
	return {
		ready: true,
		consent: { version: 1 as const, status },
		configured: status === "granted",
		purgeIncomplete: false,
		grant: async () => undefined,
		deny: async () => undefined,
		trackEvent,
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("generation persistence and controller", () => {
	afterEach(() => {
		jest.useRealTimers();
		jest.clearAllMocks();
	});

	it("persists the allowlisted input before POST and never stores raw result fields", async () => {
		const storage = memoryStorage();
		const store = createGenerationStore(storage);
		const createGeneration = jest.fn(
			async ({ requestId }: Parameters<GenerationApi["createGeneration"]>[0]) => ({
				kind: "success" as const,
				value: generation("queued", requestId),
			}),
		) as jest.MockedFunction<GenerationApi["createGeneration"]>;
		const controller = createGenerationController({ apiClient: clientWith({ createGeneration }), store });

		await controller.start(input);

		expect(createGeneration).toHaveBeenCalledTimes(1);
		const persisted = JSON.parse(storage.value ?? "null") as GenerationRecord[];
		expect(persisted[0]).toMatchObject({
			input: { type: "artist", name: "Massive Attack", mbid: input.mbid },
			status: "queued",
			event_flags: { requested: true, completed: false, failed: false },
		});
		expect(JSON.stringify(persisted)).not.toContain("raw");
		controller.dispose();
	});

	it("coalesces two explicit gestures onto one request id and one paid POST", async () => {
		let resolvePost:
			| ((
					value: ReturnType<typeof generation> extends infer Value
						? { kind: "success"; value: Value }
						: never,
			  ) => void)
			| undefined;
		const post = new Promise<{ kind: "success"; value: ReturnType<typeof generation> }>((resolve) => {
			resolvePost = resolve;
		});
		const createGeneration = jest.fn<
			ReturnType<GenerationApi["createGeneration"]>,
			Parameters<GenerationApi["createGeneration"]>
		>(() => post as ReturnType<GenerationApi["createGeneration"]>);
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration }),
			store: createGenerationStore(memoryStorage()),
		});

		const first = controller.start(input);
		const second = controller.start(input);
		await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1));
		const firstCall = createGeneration.mock.calls[0];
		if (firstCall === undefined) throw new Error("POST was not started");
		const requestId = firstCall[0].requestId;
		if (requestId === undefined || resolvePost === undefined) throw new Error("POST was not started");
		resolvePost({ kind: "success", value: generation("queued", requestId) });
		await Promise.all([first, second]);
		expect(controller.getState()).toMatchObject({ phase: "queued", requestId });
		controller.dispose();
	});

	it("atomically reserves one active request across two independent controllers", async () => {
		const storage = memoryStorage();
		const createGeneration = jest.fn(async ({ requestId }) => ({
			kind: "success" as const,
			value: generation("queued", requestId),
		}));
		const first = createGenerationController({
			apiClient: clientWith({ createGeneration }),
			store: createGenerationStore(storage),
			createRequestId: () => "11111111-1111-4111-8111-111111111111",
		});
		const second = createGenerationController({
			apiClient: clientWith({ createGeneration }),
			store: createGenerationStore(storage),
			createRequestId: () => "22222222-2222-4222-8222-222222222222",
		});
		await Promise.all([first.hydrate(input), second.hydrate(input)]);

		await Promise.all([first.start(input), second.start(input)]);

		expect(createGeneration).toHaveBeenCalledTimes(1);
		const records = JSON.parse(storage.value ?? "null") as GenerationRecord[];
		expect(records).toHaveLength(1);
		expect(records[0]?.request_id).toBe("11111111-1111-4111-8111-111111111111");
		first.dispose();
		second.dispose();
	});

	it("keeps a lost POST ambiguous, confirms with GET, and retries the same id only explicitly", async () => {
		const createGeneration = jest
			.fn()
			.mockResolvedValueOnce({ kind: "error", error: { kind: "timeout", message: "timeout" } })
			.mockResolvedValueOnce({
				kind: "success",
				value: generation("queued", "11111111-1111-4111-8111-111111111111"),
			});
		const getGeneration = jest.fn(async () => ({
			kind: "error" as const,
			error: { kind: "api" as const, status: 410, code: "expired", retryable: false, message: "safe" },
		}));
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getGeneration }),
			store: createGenerationStore(memoryStorage()),
		});

		await controller.start(input);
		expect(controller.getState()).toMatchObject({ phase: "unknown" });
		expect(createGeneration).toHaveBeenCalledTimes(1);
		expect(getGeneration).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal));

		await controller.retry();
		expect(createGeneration).toHaveBeenCalledTimes(2);
		expect(createGeneration.mock.calls[0]?.[0].requestId).toBe(createGeneration.mock.calls[1]?.[0].requestId);
		controller.dispose();
	});

	it("keeps the same id when the app restarts after sending a POST without receiving its acknowledgement", async () => {
		const requestId = "11111111-1111-4111-8111-111111111111";
		const persisted: GenerationRecord = {
			request_id: requestId,
			input,
			created_at: "2026-09-27T00:00:00.000Z",
			status: "submitting",
			event_flags: { requested: true, completed: false, failed: false },
		};
		const storage = memoryStorage(JSON.stringify([persisted]));
		const getGeneration = jest.fn(async () => ({
			kind: "error" as const,
			error: { kind: "api" as const, status: 410, code: "job_expired", retryable: false, message: "safe" },
		}));
		const createGeneration = jest.fn(async ({ requestId: retriedId }) => ({
			kind: "success" as const,
			value: generation("queued", retriedId),
		}));
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getGeneration }),
			store: createGenerationStore(storage),
		});

		await controller.hydrate(input);
		await waitFor(() => expect(controller.getState()).toMatchObject({ phase: "unknown", requestId }));
		expect(createGeneration).not.toHaveBeenCalled();

		await controller.retry();
		expect(createGeneration).toHaveBeenCalledWith(expect.objectContaining({ requestId }));
		controller.dispose();
	});

	it("does not poll while the paid POST is still in flight after a background round-trip", async () => {
		let resolvePost: ((value: { kind: "success"; value: ReturnType<typeof generation> }) => void) | undefined;
		const post = new Promise<{ kind: "success"; value: ReturnType<typeof generation> }>((resolve) => {
			resolvePost = resolve;
		});
		const createGeneration = jest.fn<
			ReturnType<GenerationApi["createGeneration"]>,
			Parameters<GenerationApi["createGeneration"]>
		>(() => post as ReturnType<GenerationApi["createGeneration"]>);
		const getGeneration = jest.fn();
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getGeneration }),
			store: createGenerationStore(memoryStorage()),
			createRequestId: () => "11111111-1111-4111-8111-111111111111",
		});

		const started = controller.start(input);
		await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1));
		controller.setForeground(false);
		controller.setForeground(true);
		await flushPromises();
		expect(getGeneration).not.toHaveBeenCalled();

		if (resolvePost === undefined) throw new Error("POST was not started");
		resolvePost({
			kind: "success",
			value: generation("queued", "11111111-1111-4111-8111-111111111111"),
		});
		await started;
		expect(controller.getState()).toMatchObject({ phase: "queued" });
		controller.dispose();
	});

	it("allocates a new request id after an observed terminal failure", async () => {
		const requestIds: string[] = [];
		const createGeneration = jest.fn<
			ReturnType<GenerationApi["createGeneration"]>,
			Parameters<GenerationApi["createGeneration"]>
		>(async ({ requestId }) => {
			requestIds.push(requestId);
			return {
				kind: "success",
				value: generation(requestIds.length === 1 ? "failed" : "queued", requestId),
			};
		});
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration }),
			store: createGenerationStore(memoryStorage()),
		});

		await controller.start(input);
		expect(controller.getState()).toMatchObject({ phase: "failed" });
		await controller.retry();
		expect(requestIds).toHaveLength(2);
		expect(requestIds[0]).not.toBe(requestIds[1]);
		controller.dispose();
	});

	it("coalesces simultaneous retry callbacks into one new paid POST", async () => {
		let retryRequestId: string | undefined;
		let resolveRetry:
			| ((value: { kind: "success"; value: ReturnType<typeof generation> }) => void)
			| undefined;
		const retryResponse = new Promise<{ kind: "success"; value: ReturnType<typeof generation> }>(
			(resolve) => {
				resolveRetry = resolve;
			},
		);
		let calls = 0;
		const createGeneration = jest.fn<
			ReturnType<GenerationApi["createGeneration"]>,
			Parameters<GenerationApi["createGeneration"]>
		>(({ requestId }) => {
			calls += 1;
			if (calls === 1) return Promise.resolve({ kind: "success", value: generation("failed", requestId) });
			retryRequestId = requestId;
			return retryResponse;
		});
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration }),
			store: createGenerationStore(memoryStorage()),
		});

		await controller.start(input);
		const firstRetry = controller.retry();
		const secondRetry = controller.retry();
		await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(2));
		if (resolveRetry === undefined || retryRequestId === undefined)
			throw new Error("Retry POST was not started");
		resolveRetry({ kind: "success", value: generation("queued", retryRequestId) });
		await Promise.all([firstRetry, secondRetry]);

		expect(createGeneration).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	it("polls only in the foreground and emits terminal analytics once without the name", async () => {
		jest.useFakeTimers();
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		const getGeneration = jest
			.fn()
			.mockResolvedValueOnce({
				kind: "success",
				value: generation("running", "11111111-1111-4111-8111-111111111111"),
			})
			.mockResolvedValueOnce({
				kind: "success",
				value: generation("succeeded", "11111111-1111-4111-8111-111111111111"),
			});
		const controller = createGenerationController({
			apiClient: clientWith({ getGeneration }),
			store: createGenerationStore(memoryStorage()),
			trackEvent,
			createRequestId: () => "11111111-1111-4111-8111-111111111111",
		});

		await controller.start(input);
		controller.setForeground(false);
		jest.advanceTimersByTime(2_000);
		await flushPromises();
		expect(getGeneration).not.toHaveBeenCalled();

		controller.setForeground(true);
		await waitFor(() => expect(getGeneration).toHaveBeenCalledTimes(1));
		jest.advanceTimersByTime(2_000);
		await waitFor(() =>
			expect(controller.getState()).toMatchObject({ phase: "succeeded", nodeId: "artist:massive-attack" }),
		);
		expect(getGeneration).toHaveBeenCalledTimes(2);
		expect(trackEvent).toHaveBeenCalledWith(
			"generation_requested",
			{ request_id: "11111111-1111-4111-8111-111111111111", node_type: "artist" },
			expect.anything(),
		);
		expect(trackEvent).toHaveBeenCalledWith(
			"generation_completed",
			{
				request_id: "11111111-1111-4111-8111-111111111111",
				node_id: "artist:massive-attack",
				node_type: "artist",
			},
			expect.anything(),
		);
		expect(JSON.stringify(trackEvent.mock.calls)).not.toContain("Massive Attack");
		controller.dispose();
	});

	it("keeps a busy/quota response actionable without turning it into a paid automatic retry", async () => {
		const createGeneration = jest.fn(async () => ({
			kind: "error" as const,
			error: {
				kind: "api" as const,
				status: 429,
				code: "quota_exhausted",
				retryable: false,
				message: "safe",
				retryAfterSeconds: 30,
			},
		}));
		const getGeneration = jest.fn();
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getGeneration }),
			store: createGenerationStore(memoryStorage()),
		});

		await controller.start(input);
		expect(controller.getState()).toMatchObject({
			phase: "busy",
			retryAfterSeconds: 30,
			errorCode: "quota_exhausted",
		});
		expect(getGeneration).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("retries node preflight when its transient failure happened before a request id existed", async () => {
		const identifiedInput: GenerationInput = {
			...input,
			slug: "artist:massive-attack",
		};
		const getNode = jest
			.fn()
			.mockResolvedValueOnce({ kind: "error", error: { kind: "network_error", message: "offline" } })
			.mockResolvedValueOnce({
				kind: "error",
				error: { kind: "api", status: 404, code: "not_found", retryable: false, message: "safe" },
			});
		const createGeneration = jest.fn(async ({ requestId }) => ({
			kind: "success" as const,
			value: generation("queued", requestId),
		}));
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getNode }),
			store: createGenerationStore(memoryStorage()),
		});

		await controller.start(identifiedInput);
		expect(controller.getState()).toMatchObject({ phase: "confirming", input: identifiedInput });
		expect(createGeneration).not.toHaveBeenCalled();

		await controller.retry();
		expect(getNode).toHaveBeenCalledTimes(2);
		expect(createGeneration).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toMatchObject({ phase: "queued" });
		controller.dispose();
	});

	it("defers uncertain POST confirmation until the app is foregrounded", async () => {
		const getGeneration = jest.fn(async () => ({
			kind: "success" as const,
			value: generation("queued", "11111111-1111-4111-8111-111111111111"),
		}));
		const createGeneration = jest.fn(async () => ({
			kind: "error" as const,
			error: { kind: "timeout" as const, message: "timeout" },
		}));
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getGeneration }),
			store: createGenerationStore(memoryStorage()),
			createRequestId: () => "11111111-1111-4111-8111-111111111111",
		});

		controller.setForeground(false);
		await controller.start(input);
		expect(controller.getState()).toMatchObject({ phase: "confirming" });
		expect(getGeneration).not.toHaveBeenCalled();

		controller.setForeground(true);
		await waitFor(() => expect(getGeneration).toHaveBeenCalledTimes(1));
		controller.dispose();
	});

	it("aborts an in-flight status GET before an explicit retry can POST", async () => {
		const requestId = "11111111-1111-4111-8111-111111111111";
		const persisted: GenerationRecord = {
			request_id: requestId,
			input,
			created_at: "2026-09-27T00:00:00.000Z",
			status: "confirming",
			event_flags: { requested: true, completed: false, failed: false },
		};
		let resolveGet: ((value: { kind: "success"; value: ReturnType<typeof generation> }) => void) | undefined;
		const pendingGet = new Promise<{ kind: "success"; value: ReturnType<typeof generation> }>((resolve) => {
			resolveGet = resolve;
		});
		const getGeneration = jest.fn(() => pendingGet);
		const createGeneration = jest.fn(async ({ requestId: retriedId }) => ({
			kind: "success" as const,
			value: generation("queued", retriedId),
		}));
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getGeneration }),
			store: createGenerationStore(memoryStorage(JSON.stringify([persisted]))),
		});

		await controller.hydrate(input);
		await waitFor(() => expect(getGeneration).toHaveBeenCalledTimes(1));
		await controller.retry();
		expect(createGeneration).toHaveBeenCalledTimes(1);
		if (resolveGet === undefined) throw new Error("Status GET was not started");
		resolveGet({ kind: "success", value: generation("failed", requestId) });
		await flushPromises();

		expect(controller.getState()).toMatchObject({ phase: "queued", requestId });
		controller.dispose();
	});

	it("retries consented analytics after a transient transport failure with stable event ids", async () => {
		const storage = memoryStorage();
		const store = createGenerationStore(storage);
		const firstTrack = jest.fn<ReturnType<GenerationTrackEvent>, Parameters<GenerationTrackEvent>>(
			async () => ({ kind: "disabled" as const }),
		);
		const createGeneration = jest.fn(async ({ requestId }) => ({
			kind: "success" as const,
			value: generation("failed", requestId),
		}));
		const first = createGenerationController({
			apiClient: clientWith({ createGeneration }),
			store,
			trackEvent: firstTrack,
			createRequestId: () => "11111111-1111-4111-8111-111111111111",
		});

		await first.start(input);
		await expect(store.get("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
			event_flags: { requested: false, completed: false, failed: false },
		});
		first.dispose();

		const resumedTrack = jest.fn<ReturnType<GenerationTrackEvent>, Parameters<GenerationTrackEvent>>(
			async () => ({ kind: "accepted" as const }),
		);
		const resumed = createGenerationController({
			apiClient: clientWith(),
			store,
			trackEvent: resumedTrack,
		});
		await resumed.hydrate(input);
		await waitFor(() => expect(resumedTrack).toHaveBeenCalledTimes(2));
		await waitFor(async () =>
			expect(await store.get("11111111-1111-4111-8111-111111111111")).toMatchObject({
				event_flags: { requested: true, completed: false, failed: true },
			}),
		);
		const originalIds = firstTrack.mock.calls.map((call) => call[2].event_id);
		const resumedIds = resumedTrack.mock.calls.map((call) => call[2].event_id);
		expect(resumedIds).toEqual(originalIds);
		resumed.dispose();
	});

	it("finishes analytics recovery before polling can persist a terminal status", async () => {
		const requestId = "11111111-1111-4111-8111-111111111111";
		const persisted: GenerationRecord = {
			request_id: requestId,
			input,
			created_at: "2026-09-27T00:00:00.000Z",
			status: "queued",
			event_flags: { requested: false, completed: false, failed: false },
		};
		const storage = memoryStorage(JSON.stringify([persisted]));
		let acceptRequested: (() => void) | undefined;
		const requestedResult = new Promise<{ kind: "accepted" }>((resolve) => {
			acceptRequested = () => resolve({ kind: "accepted" });
		});
		const trackEvent = jest.fn<ReturnType<GenerationTrackEvent>, Parameters<GenerationTrackEvent>>((name) =>
			name === "generation_requested" ? requestedResult : Promise.resolve({ kind: "accepted" }),
		);
		const getGeneration = jest.fn(async () => ({
			kind: "success" as const,
			value: generation("succeeded", requestId),
		}));
		const controller = createGenerationController({
			apiClient: clientWith({ getGeneration }),
			store: createGenerationStore(storage),
			trackEvent,
		});

		await controller.hydrate(input);
		await flushPromises();
		expect(getGeneration).not.toHaveBeenCalled();
		if (acceptRequested === undefined) throw new Error("Requested analytics was not started");
		acceptRequested();

		await waitFor(() => expect(getGeneration).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(controller.getState()).toMatchObject({ phase: "succeeded" }));
		await expect(createGenerationStore(storage).get(requestId)).resolves.toBeUndefined();
		controller.dispose();
	});

	it("publishes canonical success without waiting for the opportunistic catalog refresh", async () => {
		let resolveCatalog:
			| ((value: Awaited<ReturnType<NonNullable<GenerationApi["getCatalog"]>>>) => void)
			| undefined;
		const catalog = new Promise<Awaited<ReturnType<NonNullable<GenerationApi["getCatalog"]>>>>((resolve) => {
			resolveCatalog = resolve;
		});
		const getCatalog = jest.fn(() => catalog);
		const createGeneration = jest.fn(async ({ requestId }) => ({
			kind: "success" as const,
			value: generation("succeeded", requestId),
		}));
		const controller = createGenerationController({
			apiClient: clientWith({ createGeneration, getCatalog }),
			store: createGenerationStore(memoryStorage()),
		});

		await controller.start(input);

		expect(controller.getState()).toMatchObject({
			phase: "succeeded",
			nodeId: "artist:massive-attack",
		});
		expect(getCatalog).toHaveBeenCalledTimes(1);
		resolveCatalog?.({ kind: "error", error: { kind: "network_error", message: "offline" } });
		controller.dispose();
	});

	it("prunes terminal records after one day without evicting active requests", async () => {
		const old = "2026-09-25T00:00:00.000Z";
		const active: GenerationRecord = {
			request_id: "11111111-1111-4111-8111-111111111111",
			input,
			created_at: old,
			status: "running",
			event_flags: { requested: true, completed: false, failed: false },
		};
		const finished: GenerationRecord = {
			...active,
			request_id: "22222222-2222-4222-8222-222222222222",
			status: "failed",
			event_flags: { requested: true, completed: false, failed: true },
		};
		const storage = memoryStorage(JSON.stringify([active, finished]));
		const store = createGenerationStore(storage, () => Date.parse("2026-09-27T00:00:00.000Z"));

		await expect(store.list()).resolves.toEqual([active]);
		expect(storage.getItem).toHaveBeenCalledWith(GENERATION_STORAGE_KEY);
	});

	it("refuses a new record when the 1000-record bound is entirely active", async () => {
		const records: GenerationRecord[] = Array.from({ length: GENERATION_MAX_RECORDS }, (_, index) => ({
			request_id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
			input: { type: "artist", name: `Artist ${index}` },
			created_at: "2026-09-27T00:00:00.000Z",
			status: "running",
			event_flags: { requested: true, completed: false, failed: false },
		}));
		const storage = memoryStorage(JSON.stringify(records));
		const store = createGenerationStore(storage);

		await expect(
			store.upsert({
				request_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				input,
				created_at: "2026-09-27T00:00:00.000Z",
				status: "queued",
				event_flags: { requested: false, completed: false, failed: false },
			}),
		).rejects.toMatchObject({ kind: "capacity" });
		expect(JSON.parse(storage.value ?? "null")).toHaveLength(GENERATION_MAX_RECORDS);
	});

	it("serializes mutations from independent stores so concurrent requests are both durable", async () => {
		const storage = memoryStorage();
		const firstStore = createGenerationStore(storage);
		const secondStore = createGenerationStore(storage);
		const first: GenerationRecord = {
			request_id: "11111111-1111-4111-8111-111111111111",
			input,
			created_at: "2026-09-27T00:00:00.000Z",
			status: "submitting",
			event_flags: { requested: false, completed: false, failed: false },
		};
		const second: GenerationRecord = {
			...first,
			request_id: "22222222-2222-4222-8222-222222222222",
			input: { type: "label", name: "Warp" },
		};

		await Promise.all([firstStore.upsert(first), secondStore.upsert(second)]);

		await expect(firstStore.list()).resolves.toEqual(expect.arrayContaining([first, second]));
		expect(JSON.parse(storage.value ?? "null")).toHaveLength(2);
	});

	it("does not recreate cleared storage when an in-flight generation completes", async () => {
		const pending: GenerationRecord = {
			request_id: "11111111-1111-4111-8111-111111111111",
			input,
			created_at: "2026-09-27T00:00:00.000Z",
			status: "running",
			event_flags: { requested: true, completed: false, failed: false },
		};
		const storage = memoryStorage(JSON.stringify([pending]));
		const controllerStore = createGenerationStore(storage);

		await clearGenerationStorage(storage);
		await controllerStore.upsert({ ...pending, status: "succeeded" });

		expect(storage.value).toBeNull();
		await expect(controllerStore.get(pending.request_id)).resolves.toBeUndefined();
	});

	it("does not reserve a request when its node check began before storage was cleared", async () => {
		const identifiedInput: GenerationInput = { ...input, slug: "artist:massive-attack" };
		type NodeResult = Awaited<ReturnType<NonNullable<GenerationApi["getNode"]>>>;
		let resolveCheck: (result: NodeResult) => void = () => undefined;
		const getNode = jest.fn(
			() =>
				new Promise<NodeResult>((resolve) => {
					resolveCheck = resolve;
				}),
		);
		const storage = memoryStorage();
		const controller = createGenerationController({
			apiClient: clientWith({ getNode }),
			store: createGenerationStore(storage),
			createRequestId: () => "11111111-1111-4111-8111-111111111111",
		});

		const started = controller.start(identifiedInput);
		await waitFor(() => expect(getNode).toHaveBeenCalledTimes(1));
		await clearGenerationStorage(storage);
		resolveCheck({
			kind: "error",
			error: { kind: "api", status: 404, code: "not_found", retryable: false, message: "safe" },
		});
		await started;

		expect(storage.value).toBeNull();
	});

	it("rejects identities that the generation API contract cannot accept", () => {
		expect(normalizeGenerationInput({ type: "artist", name: "a".repeat(201) })).toBeUndefined();
		expect(
			normalizeGenerationInput({ type: "artist", name: "Massive Attack", slug: "label:massive-attack" }),
		).toBeUndefined();
		expect(normalizeGenerationInput({ type: "artist", name: "Massive Attack", qid: "Q123" })).toEqual({
			type: "artist",
			name: "Massive Attack",
			qid: "Q123",
		});
		expect(
			normalizeGenerationInput({ type: "genre", name: "Trip-hop", disambiguator: "a".repeat(201) }),
		).toBeUndefined();
		expect(normalizeGenerationInput({ type: " genre ", name: " Trip-hop ", qid: "Q123" })).toEqual({
			type: "genre",
			name: "Trip-hop",
			qid: "Q123",
		});
	});
});

describe("GenerationStatus", () => {
	beforeEach(() => {
		mockedUseAnalytics.mockReturnValue(analytics());
	});

	it("offers an explicit action and opens the canonical node after success", async () => {
		const openNode = jest.fn();
		const store = createGenerationStore(memoryStorage());
		const apiClient = clientWith({
			createGeneration: jest.fn(async ({ requestId }) => ({
				kind: "success" as const,
				value: generation("succeeded", requestId),
			})),
		});
		const screen = render(
			<GenerationStatus
				apiClient={apiClient}
				input={input}
				source="search"
				store={store}
				onOpenNode={openNode}
			/>,
		);

		fireEvent.press(screen.getByLabelText("Créer cette fiche"));
		await waitFor(() => expect(openNode).toHaveBeenCalledWith("artist:massive-attack"));
		expect(screen.getByText("Fiche créée. Ouverture de la fiche canonique…")).toBeTruthy();
		screen.unmount();
	});

	it("does not call analytics when consent is denied", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		mockedUseAnalytics.mockReturnValue(analytics("denied", trackEvent));
		const apiClient = clientWith({
			createGeneration: jest.fn(async ({ requestId }) => ({
				kind: "success" as const,
				value: generation("succeeded", requestId),
			})),
		});
		const screen = render(
			<GenerationStatus
				apiClient={apiClient}
				input={input}
				source="relation"
				store={createGenerationStore(memoryStorage())}
			/>,
		);
		fireEvent.press(screen.getByLabelText("Créer cette fiche"));
		await waitFor(() =>
			expect(screen.getByText("Fiche créée. Ouverture de la fiche canonique…")).toBeTruthy(),
		);
		expect(trackEvent).not.toHaveBeenCalled();
		screen.unmount();
	});

	it("keeps the controller usable when a parent recreates an equivalent input object", async () => {
		const createGeneration = jest.fn(async ({ requestId }) => ({
			kind: "success" as const,
			value: generation("queued", requestId),
		}));
		const apiClient = clientWith({ createGeneration });
		const store = createGenerationStore(memoryStorage());
		const screen = render(
			<GenerationStatus apiClient={apiClient} input={{ ...input }} source="search" store={store} />,
		);
		screen.rerender(
			<GenerationStatus apiClient={apiClient} input={{ ...input }} source="search" store={store} />,
		);

		fireEvent.press(screen.getByLabelText("Créer cette fiche"));
		await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1));
		screen.unmount();
	});

	it("resets the visible state when the component is reused for a different identity", async () => {
		const createGeneration = jest
			.fn()
			.mockImplementationOnce(async ({ requestId }) => ({
				kind: "success" as const,
				value: generation("failed", requestId),
			}))
			.mockImplementationOnce(async ({ requestId }) => ({
				kind: "success" as const,
				value: generation("queued", requestId),
			}));
		const apiClient = clientWith({ createGeneration });
		const store = createGenerationStore(memoryStorage());
		const screen = render(
			<GenerationStatus apiClient={apiClient} input={input} source="search" store={store} />,
		);
		fireEvent.press(screen.getByLabelText("Créer cette fiche"));
		await waitFor(() => expect(screen.getByLabelText("Réessayer la création")).toBeTruthy());

		const secondInput: GenerationInput = {
			...input,
			mbid: "22222222-2222-4222-8222-222222222222",
		};
		screen.rerender(
			<GenerationStatus apiClient={apiClient} input={secondInput} source="search" store={store} />,
		);
		await waitFor(() => expect(screen.getByLabelText("Créer cette fiche")).toBeTruthy());
		fireEvent.press(screen.getByLabelText("Créer cette fiche"));
		await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(2));
		screen.unmount();
	});
});

describe("search generation action", () => {
	beforeEach(() => {
		mockedUseAnalytics.mockReturnValue(analytics());
	});

	it("keeps the generation button outside the result press target", async () => {
		const onOpenMissing = jest.fn();
		const createGeneration = jest.fn(
			async ({ requestId }: Parameters<GenerationApi["createGeneration"]>[0]) => ({
				kind: "success" as const,
				value: generation("queued", requestId),
			}),
		) as jest.MockedFunction<GenerationApi["createGeneration"]>;
		const response: SearchResponse = {
			q: "massive",
			hits: [{ source: "catalog", type: "artist", name: "Massive Attack" }],
			sources: { cache: 0, catalog: 1 },
		};
		const screen = render(
			<SearchResults
				generationApiClient={clientWith({ createGeneration })}
				generationStore={createGenerationStore(memoryStorage())}
				onOpenCached={jest.fn()}
				onOpenMissing={onOpenMissing}
				onRetry={jest.fn()}
				queryState="admissible"
				response={response}
				status="success"
			/>,
		);

		fireEvent.press(screen.getByLabelText("Créer cette fiche"));
		await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1));
		expect(onOpenMissing).not.toHaveBeenCalled();
		screen.unmount();
	});
});
