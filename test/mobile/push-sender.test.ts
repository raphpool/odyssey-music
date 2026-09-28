import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExpoPushSender } from "../../src/mobile/push-sender.js";
import { createPushStore, type PushNotificationReservation } from "../../src/mobile/push-store.js";

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

function subscription(index = 0) {
	const final = index.toString(16).padStart(12, "0");
	return {
		subscriptionId: index === 0 ? SUBSCRIPTION_ID : `f9cdb447-c46d-4a97-b4bc-${final}`,
		secret: SECRET,
		expoToken: `ExpoPushToken[token-${index}]`,
		platform: "ios",
		timezone: "Europe/Paris",
	};
}

function reservation(index = 0): PushNotificationReservation {
	const final = (index + 1).toString(16).padStart(12, "0");
	return {
		subscriptionId: subscription(index).subscriptionId,
		notificationId: index === 0 ? NOTIFICATION_ID : `67fd896e-0b5f-466d-8b9b-${final}`,
		targetLocalDate: "2026-09-28",
		reservedAt: "2026-09-27T08:00:00.000Z",
	};
}

async function stateDir(label: string) {
	return mkdtemp(join(tmpdir(), `track1-${label}-`));
}

describe("Expo push sender", () => {
	it("sends only durable reservations with the fixed Expo payload and persists acceptance", async () => {
		const dir = await stateDir("push-send");
		const time = clock();
		const store = await createPushStore({ stateDir: dir, now: time.now });
		await store.create(subscription());
		await store.reserveNotification(reservation());
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const sender = createExpoPushSender({
			store,
			accessToken: "server-only-token",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return { ok: true, status: 200, json: async () => ({ data: [{ status: "ok", id: TICKET_ID }] }) };
			},
		});

		await expect(sender.sendReserved([reservation()])).resolves.toEqual({
			accepted: 1,
			rejected: 0,
			unknown: 0,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://exp.host/--/api/v2/push/send",
			init: {
				method: "POST",
				headers: expect.objectContaining({ Authorization: "Bearer server-only-token" }),
				body: JSON.stringify([
					{
						to: "ExpoPushToken[token-0]",
						title: "track1 — Ta découverte du jour",
						body: "Une découverte musicale t'attend. Ouvre track1 pour la découvrir.",
						sound: "default",
						channelId: "daily",
						data: {
							kind: "daily",
							notification_id: NOTIFICATION_ID,
							target_local_date: "2026-09-28",
							url: "track1://today",
						},
					},
				]),
			},
		});
		const restarted = await createPushStore({ stateDir: dir, now: time.now });
		expect(await restarted.listDeliveries()).toEqual([
			expect.objectContaining({ status: "accepted", ticketId: TICKET_ID }),
		]);
	});

	it("splits 101 reservations into bounded sequential batches and leaves an empty batch untouched", async () => {
		const time = clock();
		const store = await createPushStore({ stateDir: await stateDir("push-batches"), now: time.now });
		const reservations = Array.from({ length: 101 }, (_, index) => reservation(index));
		for (let index = 0; index < reservations.length; index += 1) {
			const currentReservation = reservations[index];
			if (!currentReservation) throw new Error("test setup has no reservation");
			await store.create(subscription(index));
			await store.reserveNotification(currentReservation);
		}
		const sizes: number[] = [];
		const sender = createExpoPushSender({
			store,
			fetch: async (_url, init) => {
				const payload = JSON.parse(String(init.body)) as Array<unknown>;
				sizes.push(payload.length);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						data: payload.map((_, index) => ({
							status: "ok",
							id: `a30fe0ec-3c27-4a5e-a9ca-${(index + sizes.length * 100).toString(16).padStart(12, "0")}`,
						})),
					}),
				};
			},
		});

		await expect(sender.sendReserved([])).resolves.toEqual({ accepted: 0, rejected: 0, unknown: 0 });
		await expect(sender.sendReserved(reservations)).resolves.toMatchObject({ accepted: 101 });
		expect(sizes).toEqual([100, 1]);
	});

	it("does not repeat an ambiguous, timed-out, throttled, 5xx, malformed or partial provider attempt after restart", async () => {
		for (const response of [
			"network",
			"timeout",
			"throttled",
			"server_error",
			"malformed",
			"partial",
		] as const) {
			const time = clock();
			const dir = await stateDir(`push-${response}`);
			const store = await createPushStore({ stateDir: dir, now: time.now });
			await store.create(subscription());
			await store.reserveNotification(reservation());
			let calls = 0;
			const sender = createExpoPushSender({
				store,
				fetch: async () => {
					calls += 1;
					if (response === "network") throw new Error("socket closed after request");
					if (response === "timeout") throw new DOMException("request timed out", "TimeoutError");
					if (response === "malformed") return { ok: true, status: 200, json: async () => ({}) };
					if (response === "partial") return { ok: true, status: 200, json: async () => ({ data: [] }) };
					if (response === "server_error") return { ok: false, status: 503, json: async () => ({}) };
					return { ok: false, status: 429, json: async () => ({}) };
				},
			});
			await expect(sender.sendReserved([reservation()])).resolves.toMatchObject({ unknown: 1 });
			const restarted = await createPushStore({ stateDir: dir, now: time.now });
			await expect(
				createExpoPushSender({
					store: restarted,
					fetch: async () => {
						calls += 1;
						return { ok: true, status: 200, json: async () => ({ data: [{ status: "ok", id: TICKET_ID }] }) };
					},
				}).sendReserved([reservation()]),
			).rejects.toMatchObject({ code: "invalid_delivery" });
			expect(calls).toBe(1);
			expect(await restarted.listDeliveries()).toEqual([expect.objectContaining({ status: "unknown" })]);
		}
	});

	it("reserves one notification atomically per subscription and local date, including after restart", async () => {
		const dir = await stateDir("push-unique-date");
		const time = clock();
		const store = await createPushStore({ stateDir: dir, now: time.now });
		await store.create(subscription());
		const conflicting = { ...reservation(), notificationId: "dea9228b-4c8f-4f50-bf0d-46a12de262a3" };
		const results = await Promise.allSettled([
			store.reserveNotification(reservation()),
			store.reserveNotification(conflicting),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		time.advance(24 * 60 * 60 * 1000 + 1);
		expect(await store.listDeliveries()).toEqual([]);
		const restarted = await createPushStore({ stateDir: dir, now: time.now });
		await expect(
			restarted.reserveNotification({
				...reservation(),
				notificationId: "a30fe0ec-3c27-4a5e-a9ca-f1b0d9d63d20",
			}),
		).rejects.toMatchObject({
			code: "invalid_delivery",
		});
		await restarted.update({ ...subscription(), timezone: "America/New_York", enabled: true });
		await expect(
			restarted.reserveNotification({
				...conflicting,
				notificationId: "b30fe0ec-3c27-4a5e-a9ca-f1b0d9d63d20",
				targetLocalDate: "2026-09-29",
			}),
		).resolves.toMatchObject({ status: "reserved" });
	});

	it("handles DeviceNotRegistered on the send ticket without disabling a renewed token", async () => {
		for (const renewToken of [false, true]) {
			const time = clock();
			const store = await createPushStore({
				stateDir: await stateDir(`push-ticket-device-${renewToken}`),
				now: time.now,
			});
			await store.create(subscription());
			await store.reserveNotification(reservation());
			const sender = createExpoPushSender({
				store,
				fetch: async () => {
					if (renewToken) {
						await store.update({
							...subscription(),
							expoToken: "ExpoPushToken[renewed-token]",
							enabled: true,
						});
					}
					return {
						ok: true,
						status: 200,
						json: async () => ({
							data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
						}),
					};
				},
			});
			await expect(sender.sendReserved([reservation()])).resolves.toMatchObject({ rejected: 1 });
			expect(await store.list()).toEqual([expect.objectContaining({ enabled: renewToken })]);
		}
	});

	it("rejects duplicate receipt tickets globally and fails closed when persisted tickets collide", async () => {
		const dir = await stateDir("push-duplicate-ticket");
		const time = clock();
		const store = await createPushStore({ stateDir: dir, now: time.now });
		await store.create(subscription());
		await store.create(subscription(1));
		await store.reserveNotification(reservation());
		await store.reserveNotification(reservation(1));
		const sender = createExpoPushSender({
			store,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => ({ data: [{ status: "ok", id: TICKET_ID }] }),
			}),
		});
		await sender.sendReserved([reservation()]);
		await expect(sender.sendReserved([reservation(1)])).rejects.toMatchObject({ code: "invalid_delivery" });
		expect(await store.listDeliveries()).toEqual([
			expect.objectContaining({ notificationId: NOTIFICATION_ID, status: "accepted", ticketId: TICKET_ID }),
			expect.objectContaining({ notificationId: reservation(1).notificationId, status: "sending" }),
		]);

		const registryPath = join(dir, "push-subscriptions.json");
		const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
			deliveries: Array<Record<string, unknown>>;
		};
		const second = persisted.deliveries[1];
		if (!second) throw new Error("test setup has no second delivery");
		second.status = "receipt_ok";
		second.ticket_id = TICKET_ID;
		second.accepted_at = "2026-09-27T08:00:00.000Z";
		second.finalized_at = "2026-09-27T08:01:00.000Z";
		await writeFile(registryPath, JSON.stringify(persisted));
		await expect(createPushStore({ stateDir: dir, now: time.now })).rejects.toMatchObject({
			code: "corrupt_registry",
		});
	});
});
