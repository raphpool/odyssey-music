import type { PushReceiptOutcome, PushReceiptRequest, PushStore } from "./push-store.js";

const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;

interface FetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export interface ExpoPushReceiptsOptions {
	store: PushStore;
	fetch?: (input: string, init: RequestInit) => Promise<FetchResponse>;
	accessToken?: string;
}

export interface PushReceiptReport {
	ok: number;
	error: number;
	unknown: number;
	skipped: boolean;
}

export interface ExpoPushReceipts {
	collectDueReceipts(): Promise<PushReceiptReport>;
}

// A scheduler tick may overlap a slow provider response. Joining the in-flight work keeps
// a ticket from being queried concurrently and leaves its terminal state unambiguous.
export function createExpoPushReceipts(options: ExpoPushReceiptsOptions): ExpoPushReceipts {
	const fetcher = options.fetch ?? fetch;
	let inFlight: Promise<PushReceiptReport> | undefined;

	async function collect(): Promise<PushReceiptReport> {
		const report: PushReceiptReport = { ok: 0, error: 0, unknown: 0, skipped: false };
		while (true) {
			const requests = await options.store.listReceiptRequests(MAX_BATCH_SIZE);
			if (requests.length === 0) return report;
			const outcomes = await getBatch(fetcher, requests, options.accessToken);
			if (outcomes.length > 0) {
				await options.store.recordReceiptOutcomes(outcomes);
				for (const outcome of outcomes) report[outcome.status] += 1;
			}
			// A partial provider response is not a permission to spin on omitted tickets. Leave
			// them for the next scheduler tick (or their 24-hour terminal expiry).
			if (requests.length < MAX_BATCH_SIZE || outcomes.length !== requests.length) return report;
		}
	}

	return {
		collectDueReceipts() {
			if (inFlight) return inFlight.then((report) => ({ ...report, skipped: true }));
			inFlight = collect().finally(() => {
				inFlight = undefined;
			});
			return inFlight;
		},
	};
}

async function getBatch(
	fetcher: (input: string, init: RequestInit) => Promise<FetchResponse>,
	requests: PushReceiptRequest[],
	accessToken: string | undefined,
): Promise<PushReceiptOutcome[]> {
	try {
		const response = await fetcher(EXPO_RECEIPTS_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept-Encoding": "gzip, deflate",
				"User-Agent": "track1-push-receipts/1",
				...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
			},
			body: JSON.stringify({ ids: requests.map((request) => request.ticketId) }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return [];
		return parseReceiptResponse(await response.json(), requests);
	} catch {
		return [];
	}
}

function parseReceiptResponse(value: unknown, requests: PushReceiptRequest[]): PushReceiptOutcome[] {
	if (!isRecord(value) || !isRecord(value.data)) return [];
	const outcomes: PushReceiptOutcome[] = [];
	for (const request of requests) {
		const receipt = value.data[request.ticketId];
		if (receipt === undefined) continue;
		if (!isRecord(receipt) || (receipt.status !== "ok" && receipt.status !== "error")) return [];
		outcomes.push({
			ticketId: request.ticketId,
			status: receipt.status,
			...(receipt.status === "error" && hasDeviceNotRegistered(receipt) ? { deviceNotRegistered: true } : {}),
		});
	}
	return outcomes;
}

function hasDeviceNotRegistered(receipt: Record<string, unknown>): boolean {
	return isRecord(receipt.details) && receipt.details.error === "DeviceNotRegistered";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
