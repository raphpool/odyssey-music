import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExpoPushReceipts } from "../../src/mobile/push-receipts.js";
import { createPushScheduler } from "../../src/mobile/push-schedule.js";
import type { ExpoPushSender } from "../../src/mobile/push-sender.js";
import {
	createPushStore,
	type PushNotificationReservation,
	type PushStore,
} from "../../src/mobile/push-store.js";

const SECRET = "A".repeat(43);
const SUBSCRIPTION_ID = "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd";

function clock(initial: string) {
	let current = new Date(initial);
	return {
		now: () => new Date(current),
		set: (value: string) => {
			current = new Date(value);
		},
	};
}

async function stateDir(label: string) {
	return mkdtemp(join(tmpdir(), `track1-schedule-${label}-`));
}

async function subscriptionStore(label: string, time: ReturnType<typeof clock>, timezone = "Europe/Paris") {
	const store = await createPushStore({ stateDir: await stateDir(label), now: time.now });
	await store.create({
		subscriptionId: SUBSCRIPTION_ID,
		secret: SECRET,
		expoToken: "ExpoPushToken[scheduler-token]",
		platform: "ios",
		timezone,
	});
	return store;
}

function scheduler(
	store: PushStore,
	time: ReturnType<typeof clock>,
	sent: PushNotificationReservation[],
	options: { throwSend?: boolean; throwReceipts?: boolean } = {},
) {
	let identifier = 0;
	let receipts = 0;
	const sender: ExpoPushSender = {
		sendReserved: async (reservations) => {
			sent.push(...reservations);
			if (options.throwSend) throw new Error("Expo unavailable");
			return { accepted: 0, rejected: 0, unknown: 0 };
		},
	};
	const receiptClient: ExpoPushReceipts = {
		collectDueReceipts: async () => {
			receipts += 1;
			if (options.throwReceipts) throw new Error("receipt unavailable");
			return { ok: 0, error: 0, unknown: 0, skipped: false };
		},
	};
	return {
		receipts: () => receipts,
		scheduler: createPushScheduler({
			store,
			sender,
			receipts: receiptClient,
			now: time.now,
			uuid: () => `67fd896e-0b5f-466d-8b9b-${(++identifier).toString(16).padStart(12, "0")}`,
			timers: {
				setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
				clearInterval: () => undefined,
				yield: async () => undefined,
			},
		}),
	};
}

function withMutationAfterList(store: PushStore, mutate: () => Promise<void>): PushStore {
	return {
		...store,
		list: async () => {
			const snapshot = await store.list();
			await mutate();
			return snapshot;
		},
	};
}

describe("push scheduler", () => {
	it("uses the exact 09:00–10:00 local window through the Europe/Paris DST fallback", async () => {
		for (const [moment, expected] of [
			["2026-10-25T07:59:00.000Z", 0],
			["2026-10-25T08:00:00.000Z", 1],
			["2026-10-25T08:59:00.000Z", 1],
			["2026-10-25T09:00:00.000Z", 0],
		] as const) {
			const time = clock("2026-10-24T12:00:00.000Z");
			const store = await subscriptionStore(`dst-${moment}`, time);
			time.set(moment);
			const sent: PushNotificationReservation[] = [];
			const instance = scheduler(store, time, sent);
			await instance.scheduler.tick();
			expect(sent).toHaveLength(expected);
			expect(instance.receipts()).toBe(1);
		}
	});

	it("calculates local dates for each IANA timezone and never sends on activation day or after 10:00", async () => {
		const newYorkTime = clock("2026-09-27T12:00:00.000Z");
		const newYorkStore = await subscriptionStore("new-york", newYorkTime, "America/New_York");
		newYorkTime.set("2026-09-28T13:00:00.000Z");
		const newYorkSent: PushNotificationReservation[] = [];
		await scheduler(newYorkStore, newYorkTime, newYorkSent).scheduler.tick();
		expect(newYorkSent).toEqual([expect.objectContaining({ targetLocalDate: "2026-09-28" })]);

		const activationTime = clock("2026-09-28T07:00:00.000Z");
		const activationStore = await subscriptionStore("activation-day", activationTime);
		const activationSent: PushNotificationReservation[] = [];
		await scheduler(activationStore, activationTime, activationSent).scheduler.tick();
		expect(activationSent).toEqual([]);
		activationTime.set("2026-09-29T07:00:00.000Z");
		await scheduler(activationStore, activationTime, activationSent).scheduler.tick();
		expect(activationSent).toHaveLength(1);
		activationTime.set("2026-09-30T09:00:00.000Z");
		await scheduler(activationStore, activationTime, activationSent).scheduler.tick();
		expect(activationSent).toHaveLength(1);

		const disabledTime = clock("2026-09-27T12:00:00.000Z");
		const disabledStore = await subscriptionStore("disabled", disabledTime);
		await disabledStore.update({
			subscriptionId: SUBSCRIPTION_ID,
			secret: SECRET,
			expoToken: "ExpoPushToken[scheduler-token]",
			platform: "ios",
			timezone: "Europe/Paris",
			enabled: false,
		});
		disabledTime.set("2026-09-28T07:00:00.000Z");
		const disabledSent: PushNotificationReservation[] = [];
		await scheduler(disabledStore, disabledTime, disabledSent).scheduler.tick();
		expect(disabledSent).toEqual([]);
	});

	it("persists a reservation before sending and does not replay it after restart or a timezone change", async () => {
		const time = clock("2026-09-27T12:00:00.000Z");
		const dir = await stateDir("restart");
		const store = await createPushStore({ stateDir: dir, now: time.now });
		await store.create({
			subscriptionId: SUBSCRIPTION_ID,
			secret: SECRET,
			expoToken: "ExpoPushToken[scheduler-token]",
			platform: "ios",
			timezone: "Europe/Paris",
		});
		time.set("2026-09-28T07:00:00.000Z");
		const firstSent: PushNotificationReservation[] = [];
		await scheduler(store, time, firstSent, { throwSend: true }).scheduler.tick();
		expect(firstSent).toHaveLength(1);

		const restarted = await createPushStore({ stateDir: dir, now: time.now });
		await restarted.update({
			subscriptionId: SUBSCRIPTION_ID,
			secret: SECRET,
			expoToken: "ExpoPushToken[scheduler-token]",
			platform: "ios",
			timezone: "Europe/Berlin",
			enabled: true,
		});
		const replayed: PushNotificationReservation[] = [];
		await scheduler(restarted, time, replayed).scheduler.tick();
		expect(replayed).toEqual([]);
	});

	it("revalidates a stale snapshot atomically before sending after subscription mutations", async () => {
		const time = clock("2026-09-27T12:00:00.000Z");
		const timezoneStore = await subscriptionStore("stale-timezone", time);
		time.set("2026-09-28T07:00:00.000Z"); // 09:00 Paris, but 03:00 New York.
		const timezoneSent: PushNotificationReservation[] = [];
		const timezoneSnapshot = withMutationAfterList(timezoneStore, async () => {
			await timezoneStore.update({
				subscriptionId: SUBSCRIPTION_ID,
				secret: SECRET,
				expoToken: "ExpoPushToken[renewed-token]",
				platform: "ios",
				timezone: "America/New_York",
				enabled: true,
			});
		});
		await scheduler(timezoneSnapshot, time, timezoneSent).scheduler.tick();
		expect(timezoneSent).toEqual([]);
		expect(await timezoneStore.listDeliveries()).toEqual([]);

		const timeReactivated = clock("2026-09-27T12:00:00.000Z");
		const reactivatedStore = await subscriptionStore("stale-reactivated", timeReactivated);
		timeReactivated.set("2026-09-28T07:00:00.000Z");
		const reactivatedSent: PushNotificationReservation[] = [];
		const reactivatedSnapshot = withMutationAfterList(reactivatedStore, async () => {
			await reactivatedStore.update({
				subscriptionId: SUBSCRIPTION_ID,
				secret: SECRET,
				expoToken: "ExpoPushToken[scheduler-token]",
				platform: "ios",
				timezone: "Europe/Paris",
				enabled: false,
			});
			await reactivatedStore.update({
				subscriptionId: SUBSCRIPTION_ID,
				secret: SECRET,
				expoToken: "ExpoPushToken[scheduler-token]",
				platform: "ios",
				timezone: "Europe/Paris",
				enabled: true,
			});
		});
		await scheduler(reactivatedSnapshot, timeReactivated, reactivatedSent).scheduler.tick();
		expect(reactivatedSent).toEqual([]);
		expect(await reactivatedStore.listDeliveries()).toEqual([]);
	});

	it("isolates sender and receipt failures, prunes inactive subscriptions, and coalesces concurrent ticks", async () => {
		const time = clock("2026-06-01T12:00:00.000Z");
		const store = await subscriptionStore("isolated", time);
		time.set("2026-09-01T07:00:00.000Z");
		const sent: PushNotificationReservation[] = [];
		const instance = scheduler(store, time, sent, { throwSend: true, throwReceipts: true });
		await expect(instance.scheduler.tick()).resolves.toMatchObject({ skipped: false });
		expect(sent).toEqual([]);

		const activeTime = clock("2026-09-27T12:00:00.000Z");
		const activeStore = await subscriptionStore("overlap", activeTime);
		activeTime.set("2026-09-28T07:00:00.000Z");
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blockingSender: ExpoPushSender = {
			sendReserved: async () =>
				new Promise((resolve) => {
					markStarted?.();
					release = () => resolve({ accepted: 0, rejected: 0, unknown: 0 });
				}),
		};
		let cleared = false;
		const overlapping = createPushScheduler({
			store: activeStore,
			sender: blockingSender,
			receipts: { collectDueReceipts: async () => ({ ok: 0, error: 0, unknown: 0, skipped: false }) },
			now: activeTime.now,
			timers: {
				setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
				clearInterval: () => {
					cleared = true;
				},
				yield: async () => undefined,
			},
		});
		overlapping.start();
		await started;
		await expect(overlapping.tick()).resolves.toEqual({ reserved: 0, skipped: true });
		const stopped = overlapping.stop();
		expect(cleared).toBe(true);
		if (!release) throw new Error("sender did not start");
		release();
		await stopped;
	});

	it("stops after the current send batch instead of draining a large registry", async () => {
		const time = clock("2026-09-27T12:00:00.000Z");
		const store = await createPushStore({ stateDir: await stateDir("stop-after-batch"), now: time.now });
		for (let index = 0; index < 101; index += 1) {
			await store.create({
				subscriptionId: `67fd896e-0b5f-466d-8b9b-${index.toString(16).padStart(12, "0")}`,
				secret: SECRET,
				expoToken: `ExpoPushToken[scheduler-token-${index}]`,
				platform: "ios",
				timezone: "Europe/Paris",
			});
		}
		time.set("2026-09-28T07:00:00.000Z");
		let releaseFirstBatch: (() => void) | undefined;
		let signalFirstBatch: (() => void) | undefined;
		const firstBatchStarted = new Promise<void>((resolve) => {
			signalFirstBatch = resolve;
		});
		let sentBatches = 0;
		const instance = createPushScheduler({
			store,
			sender: {
				sendReserved: async () => {
					sentBatches += 1;
					if (sentBatches === 1) {
						signalFirstBatch?.();
						await new Promise<void>((resolve) => {
							releaseFirstBatch = resolve;
						});
					}
					return { accepted: 0, rejected: 0, unknown: 0 };
				},
			},
			receipts: { collectDueReceipts: async () => ({ ok: 0, error: 0, unknown: 0, skipped: false }) },
			now: time.now,
			timers: {
				setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
				clearInterval: () => undefined,
				yield: async () => undefined,
			},
		});
		instance.start();
		await firstBatchStarted;
		const stopped = instance.stop();
		if (!releaseFirstBatch) throw new Error("first batch did not start");
		releaseFirstBatch();
		await stopped;
		expect(sentBatches).toBe(1);
		await expect(instance.tick()).resolves.toEqual({ reserved: 0, skipped: true });
	});
});
