import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExpoPushReceipts } from "../../src/mobile/push-receipts.js";
import { createExpoPushSender } from "../../src/mobile/push-sender.js";
import { createPushStore } from "../../src/mobile/push-store.js";

const SECRET = "A".repeat(43);
const SUBSCRIPTION_ID = "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd";
const NOTIFICATION_ID = "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce";
const TICKET_ID = "a30fe0ec-3c27-4a5e-a9ca-f1b0d9d63d20";

function clock() {
	let current = new Date("2026-09-27T08:00:00.000Z");
	return {
		now: () => new Date(current),
		advance: (milliseconds: number) => {
			current = new Date(current.getTime() + milliseconds);
		},
	};
}

async function readyStore(label: string, token = "ExpoPushToken[first-token]") {
	const time = clock();
	const store = await createPushStore({
		stateDir: await mkdtemp(join(tmpdir(), `track1-${label}-`)),
		now: time.now,
	});
	await store.create({
		subscriptionId: SUBSCRIPTION_ID,
		secret: SECRET,
		expoToken: token,
		platform: "ios",
		timezone: "Europe/Paris",
	});
	const reservation = {
		subscriptionId: SUBSCRIPTION_ID,
		notificationId: NOTIFICATION_ID,
		targetLocalDate: "2026-09-28",
		reservedAt: "2026-09-27T08:00:00.000Z",
	};
	await store.reserveNotification(reservation);
	await createExpoPushSender({
		store,
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [{ status: "ok", id: TICKET_ID }] }),
		}),
	}).sendReserved([reservation]);
	return { store, time };
}

describe("Expo push receipts", () => {
	it("waits 15 minutes, records receipt acceptance and uses only the fixed receipt endpoint", async () => {
		const { store, time } = await readyStore("receipts-ok");
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const receipts = createExpoPushReceipts({
			store,
			accessToken: "server-only-token",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return { ok: true, status: 200, json: async () => ({ data: { [TICKET_ID]: { status: "ok" } } }) };
			},
		});
		await expect(receipts.collectDueReceipts()).resolves.toMatchObject({ ok: 0 });
		expect(calls).toHaveLength(0);
		time.advance(15 * 60 * 1000);
		await expect(receipts.collectDueReceipts()).resolves.toMatchObject({ ok: 1 });
		expect(calls).toEqual([
			expect.objectContaining({
				url: "https://exp.host/--/api/v2/push/getReceipts",
				init: expect.objectContaining({
					body: JSON.stringify({ ids: [TICKET_ID] }),
					headers: expect.objectContaining({ Authorization: "Bearer server-only-token" }),
				}),
			}),
		]);
		expect(await store.listDeliveries()).toEqual([expect.objectContaining({ status: "receipt_ok" })]);
	});

	it("disables DeviceNotRegistered only when the delivery token has not been renewed", async () => {
		for (const renewToken of [false, true]) {
			const { store, time } = await readyStore(`receipt-device-${renewToken}`);
			if (renewToken) {
				await store.update({
					subscriptionId: SUBSCRIPTION_ID,
					secret: SECRET,
					expoToken: "ExpoPushToken[renewed-token]",
					platform: "ios",
					timezone: "Europe/Paris",
					enabled: true,
				});
			}
			time.advance(15 * 60 * 1000);
			await createExpoPushReceipts({
				store,
				fetch: async () => ({
					ok: true,
					status: 200,
					json: async () => ({
						data: { [TICKET_ID]: { status: "error", details: { error: "DeviceNotRegistered" } } },
					}),
				}),
			}).collectDueReceipts();
			expect(await store.list()).toEqual([expect.objectContaining({ enabled: renewToken })]);
		}
	});

	it("keeps absent receipts pending until 24 hours, then records receipt_unknown", async () => {
		const { store, time } = await readyStore("receipt-expiry");
		time.advance(15 * 60 * 1000);
		await createExpoPushReceipts({
			store,
			fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }),
		}).collectDueReceipts();
		expect(await store.listDeliveries()).toEqual([expect.objectContaining({ status: "accepted" })]);
		time.advance(23 * 60 * 60 * 1000 + 45 * 60 * 1000);
		await expect(store.listReceiptRequests(100)).resolves.toEqual([]);
		expect(await store.listDeliveries()).toEqual([expect.objectContaining({ status: "receipt_unknown" })]);
	});

	it("joins overlapping receipt ticks and leaves malformed provider data pending", async () => {
		const { store, time } = await readyStore("receipt-overlap");
		time.advance(15 * 60 * 1000);
		let calls = 0;
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const receipts = createExpoPushReceipts({
			store,
			fetch: async () => {
				calls += 1;
				markStarted?.();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { ok: true, status: 200, json: async () => ({ invalid: true }) };
			},
		});
		const first = receipts.collectDueReceipts();
		const second = receipts.collectDueReceipts();
		await started;
		expect(calls).toBe(1);
		if (!release) throw new Error("receipt request did not start");
		release();
		await expect(first).resolves.toMatchObject({ skipped: false });
		await expect(second).resolves.toMatchObject({ skipped: true });
		expect(await store.listDeliveries()).toEqual([expect.objectContaining({ status: "accepted" })]);
	});

	it("stops after one receipt batch when the scheduler is shutting down", async () => {
		const time = clock();
		const store = await createPushStore({
			stateDir: await mkdtemp(join(tmpdir(), "track1-receipt-shutdown-")),
			now: time.now,
		});
		const reservations = Array.from({ length: 101 }, (_, index) => ({
			subscriptionId: `f9cdb447-c46d-4a97-b4bc-${index.toString(16).padStart(12, "0")}`,
			notificationId: `67fd896e-0b5f-466d-8b9b-${(index + 1).toString(16).padStart(12, "0")}`,
			targetLocalDate: "2026-09-28",
			reservedAt: "2026-09-27T08:00:00.000Z",
		}));
		for (const [index, reservation] of reservations.entries()) {
			await store.create({
				subscriptionId: reservation.subscriptionId,
				secret: SECRET,
				expoToken: `ExpoPushToken[receipt-shutdown-${index}]`,
				platform: "ios",
				timezone: "Europe/Paris",
			});
			await store.reserveNotification(reservation);
		}
		let sentBatches = 0;
		await createExpoPushSender({
			store,
			fetch: async (_url, init) => {
				sentBatches += 1;
				const payload = JSON.parse(String(init.body)) as unknown[];
				return {
					ok: true,
					status: 200,
					json: async () => ({
						data: payload.map((_, index) => ({
							status: "ok",
							id: `a30fe0ec-3c27-4a5e-a9ca-${(sentBatches * 100 + index).toString(16).padStart(12, "0")}`,
						})),
					}),
				};
			},
		}).sendReserved(reservations);
		time.advance(15 * 60 * 1000);
		let receiptBatches = 0;
		const report = await createExpoPushReceipts({
			store,
			fetch: async (_url, init) => {
				receiptBatches += 1;
				const payload = JSON.parse(String(init.body)) as { ids: string[] };
				return {
					ok: true,
					status: 200,
					json: async () => ({ data: Object.fromEntries(payload.ids.map((id) => [id, { status: "ok" }])) }),
				};
			},
		}).collectDueReceipts({ shouldStop: () => receiptBatches > 0 });
		expect(report).toMatchObject({ ok: 100, skipped: false });
		expect(receiptBatches).toBe(1);
		expect(await store.listDeliveries()).toEqual([
			...Array.from({ length: 100 }, () => expect.objectContaining({ status: "receipt_ok" })),
			expect.objectContaining({ status: "accepted" }),
		]);
	});

	it("expires delivery records from their reservation time and frees bounded capacity on the next instant", async () => {
		const time = clock();
		const store = await createPushStore({
			stateDir: await mkdtemp(join(tmpdir(), "track1-receipt-retention-")),
			now: time.now,
			maxDeliveries: 1,
		});
		await store.create({
			subscriptionId: SUBSCRIPTION_ID,
			secret: SECRET,
			expoToken: "ExpoPushToken[retention-token]",
			platform: "ios",
			timezone: "Europe/Paris",
		});
		await store.reserveNotification({
			subscriptionId: SUBSCRIPTION_ID,
			notificationId: NOTIFICATION_ID,
			targetLocalDate: "2026-09-28",
			reservedAt: "2026-09-27T08:00:00.000Z",
		});
		time.advance(24 * 60 * 60 * 1000);
		expect(await store.listDeliveries()).toEqual([expect.objectContaining({ status: "unknown" })]);
		time.advance(1);
		await expect(
			store.reserveNotification({
				subscriptionId: SUBSCRIPTION_ID,
				notificationId: "dea9228b-4c8f-4f50-bf0d-46a12de262a3",
				targetLocalDate: "2026-09-29",
				reservedAt: "2026-09-28T08:00:00.001Z",
			}),
		).resolves.toMatchObject({ status: "reserved" });
		expect(await store.listDeliveries()).toHaveLength(1);
	});
});
