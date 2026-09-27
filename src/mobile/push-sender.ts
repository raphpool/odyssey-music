import type {
	PushNotificationReservation,
	PushNotificationToSend,
	PushSendOutcome,
	PushStore,
} from "./push-store.js";

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const DAILY_TITLE = "track1 — Ta découverte du jour";
const DAILY_BODY = "Une découverte musicale t'attend. Ouvre track1 pour la découvrir.";

interface FetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export interface ExpoPushSenderOptions {
	store: PushStore;
	fetch?: (input: string, init: RequestInit) => Promise<FetchResponse>;
	accessToken?: string;
}

export interface PushSendReport {
	accepted: number;
	rejected: number;
	unknown: number;
}

export interface ExpoPushSender {
	sendReserved(reservations: PushNotificationReservation[]): Promise<PushSendReport>;
}

// Sending is serialized because Expo accepts batches independently: concurrent callers must
// never turn one durable reservation into two provider requests.
export function createExpoPushSender(options: ExpoPushSenderOptions): ExpoPushSender {
	const fetcher = options.fetch ?? fetch;
	let tail: Promise<void> = Promise.resolve();

	async function sendReserved(reservations: PushNotificationReservation[]): Promise<PushSendReport> {
		const report: PushSendReport = { accepted: 0, rejected: 0, unknown: 0 };
		for (const batch of batches(reservations, MAX_BATCH_SIZE)) {
			const toSend = await options.store.claimReservedNotifications(batch);
			if (toSend.length === 0) continue;
			const outcomes = await sendBatch(fetcher, toSend, options.accessToken);
			await options.store.recordSendOutcomes(outcomes);
			for (const outcome of outcomes) report[outcome.status] += 1;
		}
		return report;
	}

	return {
		sendReserved(reservations) {
			const result = tail.then(
				() => sendReserved(reservations),
				() => sendReserved(reservations),
			);
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	};
}

async function sendBatch(
	fetcher: (input: string, init: RequestInit) => Promise<FetchResponse>,
	deliveries: PushNotificationToSend[],
	accessToken: string | undefined,
): Promise<PushSendOutcome[]> {
	const unknown = () =>
		deliveries.map((delivery) => ({ notificationId: delivery.notificationId, status: "unknown" as const }));
	try {
		const response = await fetcher(EXPO_SEND_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept-Encoding": "gzip, deflate",
				"User-Agent": "track1-push-sender/1",
				...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
			},
			body: JSON.stringify(deliveries.map(toExpoMessage)),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return unknown();
		return parseSendResponse(await response.json(), deliveries) ?? unknown();
	} catch {
		return unknown();
	}
}

function toExpoMessage(delivery: PushNotificationToSend) {
	return {
		to: delivery.expoToken,
		title: DAILY_TITLE,
		body: DAILY_BODY,
		sound: "default",
		channelId: "daily",
		data: {
			kind: "daily",
			notification_id: delivery.notificationId,
			target_local_date: delivery.targetLocalDate,
			url: "track1://today",
		},
	};
}

function parseSendResponse(value: unknown, deliveries: PushNotificationToSend[]): PushSendOutcome[] | null {
	if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== deliveries.length) return null;
	const outcomes: PushSendOutcome[] = [];
	for (let index = 0; index < deliveries.length; index += 1) {
		const delivery = deliveries[index];
		const result = value.data[index];
		if (!delivery || !isRecord(result) || (result.status !== "ok" && result.status !== "error")) return null;
		if (result.status === "ok") {
			if (typeof result.id !== "string" || !isUuid(result.id)) return null;
			outcomes.push({
				notificationId: delivery.notificationId,
				status: "accepted",
				ticketId: result.id.toLowerCase(),
			});
		} else {
			outcomes.push({
				notificationId: delivery.notificationId,
				status: "rejected",
				...(hasDeviceNotRegistered(result) ? { deviceNotRegistered: true } : {}),
			});
		}
	}
	return outcomes;
}

function batches<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDeviceNotRegistered(result: Record<string, unknown>): boolean {
	return isRecord(result.details) && result.details.error === "DeviceNotRegistered";
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
