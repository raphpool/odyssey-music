import { randomUUID } from "node:crypto";
import type { ExpoPushReceipts } from "./push-receipts.js";
import type { ExpoPushSender } from "./push-sender.js";
import type { PushNotificationReservation, PushStore, PushSubscription } from "./push-store.js";

const TICK_MS = 60_000;
const MAX_BATCH_SIZE = 100;
const INACTIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface PushSchedulerTimers {
	setInterval(handler: () => void, milliseconds: number): ReturnType<typeof setInterval>;
	clearInterval(timer: ReturnType<typeof setInterval>): void;
	yield(): Promise<void>;
}

export interface PushSchedulerOptions {
	store: PushStore;
	sender: ExpoPushSender;
	receipts: ExpoPushReceipts;
	now?: () => Date;
	uuid?: () => string;
	timers?: PushSchedulerTimers;
	onError?: (event: "send" | "receipts" | "scheduler", error: unknown) => void;
}

export interface PushScheduleReport {
	reserved: number;
	skipped: boolean;
}

export interface PushScheduler {
	start(): void;
	stop(): Promise<void>;
	tick(): Promise<PushScheduleReport>;
}

// The scheduler is deliberately process-local. Reservations are durable before every send, so a
// restart can lose a tick but cannot make the same local date eligible twice.
export function createPushScheduler(options: PushSchedulerOptions): PushScheduler {
	const now = options.now ?? (() => new Date());
	const uuid = options.uuid ?? randomUUID;
	const timers = options.timers ?? defaultTimers;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight: Promise<PushScheduleReport> | undefined;

	async function execute(): Promise<PushScheduleReport> {
		try {
			const current = now();
			await options.store.pruneInactive();
			const subscriptions = await options.store.list();
			let reserved = 0;
			for (const batch of batches(
				subscriptions.filter((subscription) => isEligible(subscription, current)),
				MAX_BATCH_SIZE,
			)) {
				const reservations: PushNotificationReservation[] = [];
				for (const subscription of batch) {
					try {
						const targetLocalDate = localDate(current, subscription.timezone);
						const reservation = await options.store.reserveNotification(
							{
								subscriptionId: subscription.subscriptionId,
								notificationId: uuid(),
								targetLocalDate,
								reservedAt: current.toISOString(),
							},
							{ requireScheduledEligibility: true },
						);
						reservations.push(reservation);
						reserved += 1;
					} catch (error) {
						// A concurrent lifecycle mutation or a full registry only affects this phone.
						options.onError?.("scheduler", error);
					}
				}
				if (reservations.length > 0) {
					try {
						await options.sender.sendReserved(reservations);
					} catch (error) {
						options.onError?.("send", error);
					}
				}
				await timers.yield();
			}
			try {
				await options.receipts.collectDueReceipts();
			} catch (error) {
				options.onError?.("receipts", error);
			}
			return { reserved, skipped: false };
		} catch (error) {
			options.onError?.("scheduler", error);
			return { reserved: 0, skipped: false };
		}
	}

	function tick(): Promise<PushScheduleReport> {
		if (inFlight) return Promise.resolve({ reserved: 0, skipped: true });
		inFlight = execute().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	}

	return {
		start() {
			if (timer) return;
			timer = timers.setInterval(() => {
				void tick();
			}, TICK_MS);
			void tick();
		},
		async stop() {
			if (timer) {
				timers.clearInterval(timer);
				timer = undefined;
			}
			await inFlight;
		},
		tick,
	};
}

function isEligible(subscription: PushSubscription, current: Date): boolean {
	if (!subscription.enabled) return false;
	if (current.getTime() - new Date(subscription.lastSeenAt).getTime() >= INACTIVE_TTL_MS) return false;
	const date = localDate(current, subscription.timezone);
	if (date <= subscription.activatedLocalDate || hasReservedDate(subscription, date)) return false;
	const hour = localHour(current, subscription.timezone);
	return hour >= 9 && hour < 10;
}

function hasReservedDate(subscription: PushSubscription, targetLocalDate: string): boolean {
	return (
		subscription.lastReservedLocalDate === targetLocalDate ||
		subscription.reservedLocalDates?.includes(targetLocalDate) === true
	);
}

function localDate(date: Date, timezone: string): string {
	const values = localParts(date, timezone);
	const year = values.get("year");
	const month = values.get("month");
	const day = values.get("day");
	if (!year || !month || !day) throw new Error("Intl did not provide a local date");
	return `${year}-${month}-${day}`;
}

function localHour(date: Date, timezone: string): number {
	const hour = localParts(date, timezone).get("hour");
	if (!hour || !/^\d{2}$/.test(hour)) throw new Error("Intl did not provide a local hour");
	return Number.parseInt(hour, 10);
}

function localParts(date: Date, timezone: string): Map<string, string> {
	return new Map(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(date)
			.map((part) => [part.type, part.value]),
	);
}

function batches<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

const defaultTimers: PushSchedulerTimers = {
	setInterval,
	clearInterval,
	yield: () => new Promise((resolve) => setImmediate(resolve)),
};
