import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMobileCatalog } from "../../src/mobile/catalog.js";
import { createMobilePushRoutes } from "../../src/mobile/push-routes.js";
import { createApnsPushStore, createPushStore } from "../../src/mobile/push-store.js";
import { createMobileRouter } from "../../src/mobile/router.js";

const SECRET = "A".repeat(43);
const subscriptionId = "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd";
const servers: ReturnType<typeof createServer>[] = [];
const runtimeServers: Array<{ process: ChildProcess; directory: string }> = [];

async function startServer(available = true, maxSubscriptions?: number) {
	const stateDir = await mkdtemp(join(tmpdir(), "track1-push-route-"));
	const store = available
		? await createPushStore({
				stateDir,
				...(maxSubscriptions === undefined ? {} : { maxSubscriptions }),
			})
		: undefined;
	const apnsStore = available ? await createApnsPushStore({ stateDir }) : undefined;
	const router = createMobileRouter({
		catalog: createMobileCatalog({ getGraph: async () => ({ nodes: [], edges: [] }) }),
		push: createMobilePushRoutes({ ...(store ? { store } : {}), ...(apnsStore ? { apnsStore } : {}) }),
	});
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (!(await router.handle({ req, res, url }))) res.end();
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
	return address.port;
}

afterEach(async () => {
	await Promise.all(runtimeServers.splice(0).map(stopRuntimeServer));
	await Promise.all(
		servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

async function startRuntimeServer(): Promise<{ port: number; stateDir: string }> {
	const directory = await mkdtemp(join(tmpdir(), "track1-apns-runtime-"));
	const stateDir = join(directory, "state");
	const port = await reservePort();
	const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
		cwd: process.cwd(),
		detached: true,
		stdio: "pipe",
		env: {
			...process.env,
			PORT: String(port),
			ODYSSEY_CACHE_DIR: join(directory, "cache"),
			MOBILE_STATE_DIR: stateDir,
			GEMINI_API_KEY: "test-gemini-key",
			TAVILY_API_KEY: "test-tavily-key",
			FIRECRAWL_API_KEY: "test-firecrawl-key",
			MB_BASE_URL: "http://127.0.0.1:1",
			MOBILE_PUSH_ENABLED: "false",
		},
	});
	runtimeServers.push({ process: child, directory });
	await waitForRuntimeServer(child, port);
	return { port, stateDir };
}

async function reservePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function waitForRuntimeServer(child: ChildProcess, port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (child.exitCode !== null) throw new Error("runtime server exited before becoming ready");
		if (await isRuntimeServerReady(port)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("runtime server did not become ready");
}

async function isRuntimeServerReady(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET" }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode === 200));
		});
		req.on("error", () => resolve(false));
		req.end();
	});
}

async function stopRuntimeServer({
	process: child,
	directory,
}: {
	process: ChildProcess;
	directory: string;
}): Promise<void> {
	if (child.exitCode === null && child.pid) {
		process.kill(-child.pid, "SIGTERM");
		await Promise.race([once(child, "exit"), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
		if (child.exitCode === null) {
			process.kill(-child.pid, "SIGKILL");
			await once(child, "exit");
		}
	}
	await rm(directory, { recursive: true, force: true });
}

async function call(
	port: number,
	method: "POST" | "PUT" | "DELETE",
	path: string,
	body?: unknown,
	secret?: string,
) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const encoded = body === undefined ? "" : JSON.stringify(body);
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(encoded),
					...(secret ? { Authorization: `Bearer ${secret}` } : {}),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
				);
			},
		);
		req.on("error", reject);
		req.end(encoded);
	});
}

const payload = {
	subscription_id: subscriptionId,
	expo_token: "ExpoPushToken[abcDEF_123-xyz]",
	platform: "ios",
	timezone: "Europe/Paris",
};

describe("mobile push subscription routes", () => {
	it("wires APNs subscriptions through the real server entry point", async () => {
		const { port, stateDir } = await startRuntimeServer();
		const apnsPayload = {
			subscription_id: subscriptionId,
			device_token: "A1B2",
			app_variant: "preview",
			apns_environment: "sandbox",
			timezone: "Europe/Paris",
		};
		const created = await call(port, "POST", "/mobile/v1/push/apns/subscriptions", apnsPayload, SECRET);
		const retried = await call(port, "POST", "/mobile/v1/push/apns/subscriptions", apnsPayload, SECRET);

		expect(created.status).toBe(201);
		expect(retried).toEqual({ status: 200, body: created.body });
		expect(await readFile(join(stateDir, "push-apns-subscriptions.json"), "utf8")).toContain(
			'"device_token":"a1b2"',
		);
	});

	it("registers APNs subscriptions separately with strict contracts and protected lifecycle operations", async () => {
		const port = await startServer();
		const apnsPayload = {
			subscription_id: subscriptionId,
			device_token: "A1B2",
			app_variant: "preview",
			apns_environment: "sandbox",
			timezone: "Europe/Paris",
		};
		const created = await call(port, "POST", "/mobile/v1/push/apns/subscriptions", apnsPayload, SECRET);
		const retried = await call(port, "POST", "/mobile/v1/push/apns/subscriptions", apnsPayload, SECRET);
		const invalid = await call(
			port,
			"POST",
			"/mobile/v1/push/apns/subscriptions",
			{ ...apnsPayload, app_variant: "production", apns_environment: "sandbox" },
			SECRET,
		);
		const unknown = await call(
			port,
			"POST",
			"/mobile/v1/push/apns/subscriptions",
			{ ...apnsPayload, unexpected: true },
			SECRET,
		);
		const invalidToken = await call(
			port,
			"POST",
			"/mobile/v1/push/apns/subscriptions",
			{ ...apnsPayload, device_token: "abc" },
			SECRET,
		);
		const invalidTimezone = await call(
			port,
			"POST",
			"/mobile/v1/push/apns/subscriptions",
			{ ...apnsPayload, timezone: "not/a-timezone" },
			SECRET,
		);
		const invalidPut = await call(
			port,
			"PUT",
			`/mobile/v1/push/apns/subscriptions/${subscriptionId}`,
			{ ...apnsPayload, subscription_id: undefined, enabled: false },
			"invalid",
		);
		const invalidDelete = await call(
			port,
			"DELETE",
			`/mobile/v1/push/apns/subscriptions/${subscriptionId}`,
			undefined,
			"invalid",
		);
		const missingDelete = await call(port, "DELETE", `/mobile/v1/push/apns/subscriptions/${subscriptionId}`);
		const updated = await call(
			port,
			"PUT",
			`/mobile/v1/push/apns/subscriptions/${subscriptionId}`,
			{ ...apnsPayload, subscription_id: undefined, enabled: false },
			SECRET,
		);
		const removed = await call(
			port,
			"DELETE",
			`/mobile/v1/push/apns/subscriptions/${subscriptionId}`,
			undefined,
			SECRET,
		);
		const missing = await call(
			port,
			"DELETE",
			"/mobile/v1/push/apns/subscriptions/67fd896e-0b5f-466d-8b9b-93c8df9cc8ce",
		);

		expect(created).toMatchObject({ status: 201 });
		expect(retried).toEqual({ status: 200, body: created.body });
		expect(created.body).not.toContain(SECRET);
		expect(created.body).not.toContain(apnsPayload.device_token);
		expect(invalid.status).toBe(400);
		expect(unknown.status).toBe(400);
		expect(invalidToken.status).toBe(400);
		expect(invalidTimezone.status).toBe(400);
		expect(invalidPut.status).toBe(401);
		expect(invalidDelete.status).toBe(401);
		expect(missingDelete.status).toBe(401);
		expect(updated.status).toBe(200);
		expect(removed).toEqual({ status: 204, body: "" });
		expect(missing).toEqual({ status: 204, body: "" });
	});

	it("creates, retries, updates and deletes without returning bearer data", async () => {
		const port = await startServer();
		const created = await call(port, "POST", "/mobile/v1/push/subscriptions", payload, SECRET);
		const retried = await call(port, "POST", "/mobile/v1/push/subscriptions", payload, SECRET);
		const updated = await call(
			port,
			"PUT",
			`/mobile/v1/push/subscriptions/${subscriptionId}`,
			{ ...payload, subscription_id: undefined, enabled: false },
			SECRET,
		);
		const removed = await call(
			port,
			"DELETE",
			`/mobile/v1/push/subscriptions/${subscriptionId}`,
			undefined,
			SECRET,
		);
		const removedAgain = await call(
			port,
			"DELETE",
			`/mobile/v1/push/subscriptions/${subscriptionId}`,
			undefined,
			SECRET,
		);

		expect(created).toMatchObject({ status: 201 });
		expect(retried).toMatchObject({ status: 200, body: created.body });
		expect(created.body).not.toContain(SECRET);
		expect(created.body).not.toContain(payload.expo_token);
		expect(updated).toMatchObject({ status: 200 });
		expect(removed).toEqual({ status: 204, body: "" });
		expect(removedAgain).toEqual({ status: 204, body: "" });
	});

	it("rejects malformed, oversized and unauthorized writes with stable public errors", async () => {
		const port = await startServer();
		const missingSecret = await call(port, "POST", "/mobile/v1/push/subscriptions", payload);
		const malformed = await call(
			port,
			"POST",
			"/mobile/v1/push/subscriptions",
			{ ...payload, unexpected: true },
			SECRET,
		);
		const invalidToken = await call(
			port,
			"POST",
			"/mobile/v1/push/subscriptions",
			{ ...payload, expo_token: "https://example.test" },
			SECRET,
		);
		const invalidTimezone = await call(
			port,
			"POST",
			"/mobile/v1/push/subscriptions",
			{ ...payload, timezone: "not/a-timezone" },
			SECRET,
		);
		const created = await call(port, "POST", "/mobile/v1/push/subscriptions", payload, SECRET);
		const wrongSecret = await call(
			port,
			"PUT",
			`/mobile/v1/push/subscriptions/${subscriptionId}`,
			{ ...payload, subscription_id: undefined, enabled: true },
			"B".repeat(43),
		);
		const missing = await call(
			port,
			"PUT",
			"/mobile/v1/push/subscriptions/67fd896e-0b5f-466d-8b9b-93c8df9cc8ce",
			{ ...payload, subscription_id: undefined, enabled: true },
			SECRET,
		);
		const tooLarge = await call(
			port,
			"POST",
			"/mobile/v1/push/subscriptions",
			{ ...payload, padding: "x".repeat(8192) },
			SECRET,
		);

		expect(missingSecret).toMatchObject({
			status: 401,
			body: JSON.stringify({ error: { code: "unauthorized", message: "authorization is required" } }),
		});
		expect(malformed).toMatchObject({
			status: 400,
			body: JSON.stringify({
				error: { code: "invalid_request", message: "invalid push subscription request" },
			}),
		});
		expect(invalidToken.status).toBe(400);
		expect(invalidTimezone.status).toBe(400);
		expect(created.status).toBe(201);
		expect(wrongSecret).toMatchObject({
			status: 401,
			body: JSON.stringify({ error: { code: "unauthorized", message: "authorization is required" } }),
		});
		expect(missing.status).toBe(404);
		expect(tooLarge.status).toBe(400);
	});

	it("keeps the mobile router available while the push registry is unavailable", async () => {
		const port = await startServer(false);
		const response = await call(port, "POST", "/mobile/v1/push/subscriptions", payload, SECRET);

		expect(response).toEqual({
			status: 503,
			body: JSON.stringify({
				error: { code: "push_unavailable", message: "push subscriptions are temporarily unavailable" },
			}),
		});
	});

	it("returns a typed unavailable response when the subscription admission cap is reached", async () => {
		const port = await startServer(true, 1);
		await expect(call(port, "POST", "/mobile/v1/push/subscriptions", payload, SECRET)).resolves.toMatchObject(
			{
				status: 201,
			},
		);
		const saturated = await call(
			port,
			"POST",
			"/mobile/v1/push/subscriptions",
			{ ...payload, subscription_id: "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce" },
			SECRET,
		);

		expect(saturated).toEqual({
			status: 503,
			body: JSON.stringify({
				error: { code: "push_unavailable", message: "push subscriptions are temporarily unavailable" },
			}),
		});
	});
});
