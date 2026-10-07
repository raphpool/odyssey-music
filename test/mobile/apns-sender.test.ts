import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { connect, constants, createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ApnsRequest, type ApnsTransport, createApnsPushSender } from "../../src/mobile/apns-sender.js";
import { createApnsPushStore } from "../../src/mobile/push-store.js";

const SECRET = "A".repeat(43);
const SUBSCRIPTION_ID = "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd";

function clock(initial: string) {
	let current = new Date(initial);
	return {
		now: () => new Date(current),
		set(value: string) {
			current = new Date(value);
		},
	};
}

async function setup(label: string) {
	const directory = await mkdtemp(join(tmpdir(), `track1-apns-${label}-`));
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const keyPath = join(directory, "AuthKey_TEST.p8");
	await writeFile(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
	const time = clock("2026-09-27T12:00:00.000Z");
	const store = await createApnsPushStore({ stateDir: directory, now: time.now });
	await store.create({
		subscriptionId: SUBSCRIPTION_ID,
		secret: SECRET,
		deviceToken: "A1B2",
		appVariant: "preview",
		apnsEnvironment: "sandbox",
		timezone: "Europe/Paris",
	});
	time.set("2026-09-28T07:00:00.000Z");
	const reservation = await store.reserveNotification({
		subscriptionId: SUBSCRIPTION_ID,
		notificationId: "67fd896e-0b5f-466d-8b9b-000000000001",
		targetLocalDate: "2026-09-28",
		reservedAt: time.now().toISOString(),
	});
	return { directory, keyPath, pair, reservation, store, time };
}

function sender(
	keyPath: string,
	store: Awaited<ReturnType<typeof createApnsPushStore>>,
	now: () => Date,
	transport: ApnsTransport,
) {
	return createApnsPushSender({
		store,
		keyId: "ABC123DEFG",
		teamId: "DEF123GHIJ",
		privateKeyPath: keyPath,
		topics: { preview: "com.dropcliffs.track1.preview", production: "com.dropcliffs.track1" },
		now,
		transport,
	});
}

function decodeJwt(value: string) {
	const [, token] = value.split(" ");
	if (!token) throw new Error("missing bearer token");
	const [header, claims, signature] = token.split(".");
	if (!header || !claims || !signature) throw new Error("invalid JWT");
	return {
		token,
		header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
		claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")),
		signature: Buffer.from(signature, "base64url"),
		unsigned: `${header}.${claims}`,
	};
}

describe("APNs sender", () => {
	it("signs a real ES256 JWT and sends the Apple host, headers, and daily payload", async () => {
		const fixture = await setup("request");
		const requests: ApnsRequest[] = [];
		const transport: ApnsTransport = {
			send: async (request) => {
				requests.push(request);
				return { status: 200 };
			},
		};
		const client = sender(fixture.keyPath, fixture.store, fixture.time.now, transport);
		await expect(client.sendReserved([fixture.reservation])).resolves.toEqual({
			accepted: 1,
			disabled: 0,
			unknown: 0,
		});
		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (!request) throw new Error("APNs request was not captured");
		expect(request).toMatchObject({
			host: "api.sandbox.push.apple.com",
			path: "/3/device/a1b2",
			headers: expect.objectContaining({
				"apns-topic": "com.dropcliffs.track1.preview",
				"apns-push-type": "alert",
				"apns-priority": "10",
			}),
		});
		expect(request.headers["apns-expiration"]).toBe("1790614800");
		expect(request.headers["apns-collapse-id"]).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(request.headers["apns-collapse-id"]).not.toContain(SUBSCRIPTION_ID);
		expect(JSON.parse(request.body)).toEqual({
			aps: {
				alert: {
					title: "track1 — Ta découverte du jour",
					body: "Une découverte musicale t'attend. Ouvre track1 pour la découvrir.",
				},
				sound: "default",
			},
			kind: "daily",
			notification_id: fixture.reservation.notificationId,
			target_local_date: "2026-09-28",
			url: "track1://today",
		});
		const token = decodeJwt(request.headers.authorization ?? "");
		expect(token.header).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
		expect(token.claims).toEqual({ iss: "DEF123GHIJ", iat: 1790578800 });
		expect(
			verify(
				"SHA256",
				Buffer.from(token.unsigned),
				{ key: fixture.pair.publicKey, dsaEncoding: "ieee-p1363" },
				token.signature,
			),
		).toBe(true);
	});

	it("uses the production host and topic for a production enrollment", async () => {
		const fixture = await setup("production");
		const requests: ApnsRequest[] = [];
		const productionReservation = {
			...fixture.reservation,
			appVariant: "production" as const,
			apnsEnvironment: "production" as const,
		};
		await sender(fixture.keyPath, fixture.store, fixture.time.now, {
			send: async (request) => {
				requests.push(request);
				return { status: 200 };
			},
		}).sendReserved([productionReservation]);
		expect(requests).toEqual([
			expect.objectContaining({
				host: "api.push.apple.com",
				headers: expect.objectContaining({ "apns-topic": "com.dropcliffs.track1" }),
			}),
		]);
	});

	it("reuses a JWT for less than fifty minutes and rotates it afterwards", async () => {
		const fixture = await setup("jwt-cache");
		const authorizations: string[] = [];
		const client = sender(fixture.keyPath, fixture.store, fixture.time.now, {
			send: async (request) => {
				authorizations.push(request.headers.authorization ?? "");
				return { status: 200 };
			},
		});
		await client.sendReserved([fixture.reservation]);
		fixture.time.set("2026-09-28T07:49:00.000Z");
		await client.sendReserved([fixture.reservation]);
		fixture.time.set("2026-09-28T07:51:00.000Z");
		await client.sendReserved([fixture.reservation]);
		expect(authorizations[0]).toBe(authorizations[1]);
		expect(authorizations[2]).not.toBe(authorizations[0]);
	});

	it("reuses one HTTP/2 session per Apple host and closes it after the sender drains", async () => {
		const fixture = await setup("http2-session");
		const server = createServer();
		let connections = 0;
		let requests = 0;
		server.on("session", () => {
			connections += 1;
		});
		server.on("stream", (stream) => {
			requests += 1;
			stream.respond({ ":status": 200 });
			stream.end();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("HTTP/2 test server has no address");
		const port = (address as AddressInfo).port;
		const client = createApnsPushSender({
			store: fixture.store,
			keyId: "ABC123DEFG",
			teamId: "DEF123GHIJ",
			privateKeyPath: fixture.keyPath,
			topics: { preview: "com.dropcliffs.track1.preview", production: "com.dropcliffs.track1" },
			now: fixture.time.now,
			sessionFactory: () => connect(`http://127.0.0.1:${port}`),
		});
		await client.sendReserved([fixture.reservation]);
		await client.sendReserved([fixture.reservation]);
		expect({ connections, requests }).toEqual({ connections: 1, requests: 2 });
		await client.close?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("cancels a timed-out HTTP/2 stream so sender shutdown can complete without a resend", async () => {
		const fixture = await setup("http2-timeout");
		const server = createServer();
		let requests = 0;
		let resolveStreamClose: ((rstCode: number) => void) | undefined;
		const streamClosed = new Promise<number>((resolve) => {
			resolveStreamClose = resolve;
		});
		server.on("stream", (stream) => {
			requests += 1;
			// Deliberately never reply: this reproduces a peer that keeps END_STREAM open.
			stream.once("close", () => resolveStreamClose?.(stream.rstCode));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("HTTP/2 test server has no address");
		const port = (address as AddressInfo).port;
		const client = createApnsPushSender({
			store: fixture.store,
			keyId: "ABC123DEFG",
			teamId: "DEF123GHIJ",
			privateKeyPath: fixture.keyPath,
			topics: { preview: "com.dropcliffs.track1.preview", production: "com.dropcliffs.track1" },
			now: fixture.time.now,
			requestTimeoutMs: 20,
			sessionFactory: () => connect(`http://127.0.0.1:${port}`),
		});
		await expect(client.sendReserved([fixture.reservation])).resolves.toEqual({
			accepted: 0,
			disabled: 0,
			unknown: 1,
		});
		expect(await streamClosed).toBe(constants.NGHTTP2_CANCEL);
		await client.close?.();
		expect(requests).toBe(1);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("only disables the token snapshot that Apple rejected", async () => {
		const renewed = await setup("renewed");
		await renewed.store.update({
			subscriptionId: SUBSCRIPTION_ID,
			secret: SECRET,
			deviceToken: "C3D4",
			appVariant: "preview",
			apnsEnvironment: "sandbox",
			timezone: "Europe/Paris",
			enabled: true,
		});
		const rejected: ApnsTransport = { send: async () => ({ status: 410, reason: "Unregistered" }) };
		await sender(renewed.keyPath, renewed.store, renewed.time.now, rejected).sendReserved([
			renewed.reservation,
		]);
		expect(await renewed.store.list()).toEqual([
			expect.objectContaining({ enabled: true, deviceToken: "c3d4" }),
		]);

		const current = await setup("current");
		await sender(current.keyPath, current.store, current.time.now, rejected).sendReserved([
			current.reservation,
		]);
		expect(await current.store.list()).toEqual([expect.objectContaining({ enabled: false })]);
	});

	it("retains subscriptions after an operational provider error", async () => {
		const fixture = await setup("failure");
		let attempts = 0;
		await sender(fixture.keyPath, fixture.store, fixture.time.now, {
			send: async () => {
				attempts += 1;
				throw new Error("connection reset");
			},
		}).sendReserved([fixture.reservation]);
		expect(attempts).toBe(1);
		expect(await fixture.store.list()).toEqual([expect.objectContaining({ enabled: true })]);
	});
});
