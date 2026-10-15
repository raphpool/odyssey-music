import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors.js";
import { createMobileGenerationService } from "../../src/mobile/generation-service.js";
import { createGenerationStore } from "../../src/mobile/generation-store.js";
import { createMobileRouter } from "../../src/mobile/router.js";
import { MaterializeCacheMissError } from "../../src/services/materialize-service.js";

const REQUEST_A = "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd";
const REQUEST_B = "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce";
const REQUEST_C = "a0d4a2ca-87dc-4ee0-9d22-573d8aa5da51";

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function storeDir(name: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `track1-generation-${name}-`));
}

function input(requestId = REQUEST_A) {
	return { requestId, type: "artist", name: "Fixture Artist" };
}

function registryFingerprint(request: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify({ userId: "public", request }))
		.digest("hex")}`;
}

async function eventually<T>(read: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const value = await read();
		if (valid(value)) return value;
		await new Promise((done) => setTimeout(done, 5));
	}
	throw new Error("generation did not settle");
}

describe("mobile generations", () => {
	it("persists before a flat 202 response, shares case-normalized identity work and survives a restart", async () => {
		const dir = await storeDir("lifecycle");
		const finish = deferred<{ node: { slug: string } }>();
		let paidCalls = 0;
		const materialize = {
			handleMaterialize: async (_request: unknown, options: { cacheOnly?: true }) => {
				if (options.cacheOnly) throw new MaterializeCacheMissError();
				paidCalls += 1;
				return finish.promise;
			},
		};
		const service = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: dir }),
			materialize,
		});
		const first = await service.submit({ ...input(), name: "Aphex Twin" });
		const second = await service.submit({
			...input(REQUEST_B),
			name: "Áphex   Twin",
			disambiguator: "()",
		});
		expect(first).toMatchObject({ request_id: REQUEST_A, status: "queued" });
		expect(second).toMatchObject({ request_id: REQUEST_B, status: "queued" });
		await eventually(
			() => service.get(REQUEST_A),
			(job) => job.status === "running",
		);
		expect(paidCalls).toBe(1);

		finish.resolve({ node: { slug: "artist:aphex-twin" } });
		const completed = await eventually(
			() => service.get(REQUEST_A),
			(job) => job.status === "succeeded",
		);
		expect(completed).toMatchObject({ node_id: "artist:aphex-twin" });
		expect(
			await eventually(
				() => service.get(REQUEST_B),
				(job) => job.status === "succeeded",
			),
		).toMatchObject({
			node_id: "artist:aphex-twin",
		});
		const restarted = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: dir }),
			materialize,
		});
		expect(await restarted.get(REQUEST_A)).toMatchObject({
			status: "succeeded",
			node_id: "artist:aphex-twin",
		});
	});

	it("maps provider failures, interruption and saturation without a replay", async () => {
		const dir = await storeDir("failures");
		const stuck = deferred<{ node: { slug: string } }>();
		let calls = 0;
		const materialize = {
			handleMaterialize: async (_request: unknown, options: { cacheOnly?: true }) => {
				if (options.cacheOnly) throw new MaterializeCacheMissError();
				calls += 1;
				if (calls === 1) throw Object.assign(new Error("quota"), { code: "RESOURCE_EXHAUSTED" });
				return stuck.promise;
			},
		};
		const service = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: dir }),
			materialize,
		});
		await service.submit(input());
		await expect(
			eventually(
				() => service.get(REQUEST_A),
				(job) => job.status === "failed",
			),
		).resolves.toMatchObject({ error: { code: "provider_quota_exhausted", retryable: false } });

		const restartedStore = await createGenerationStore({ stateDir: dir });
		const interrupted = await restartedStore.create({
			userId: "public",
			idempotencyKey: REQUEST_B,
			request: input(REQUEST_B),
		});
		await restartedStore.transition(interrupted.generation.id, "running");
		const restarted = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: dir }),
			materialize,
		});
		expect(await restarted.get(REQUEST_B)).toMatchObject({
			status: "interrupted",
			error: { code: "interrupted", retryable: false },
		});
		expect(calls).toBe(1);

		const capacityService = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: await storeDir("capacity") }),
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					return stuck.promise;
				},
			},
		});
		for (let index = 0; index < 12; index += 1) {
			await capacityService.submit(input(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
		}
		await expect(capacityService.submit(input("00000000-0000-4000-8000-999999999999"))).rejects.toMatchObject(
			{ code: "busy" },
		);
	});

	it("preflights cache identity before admission and latches an unavailable store without provider work", async () => {
		const dir = await storeDir("preflight");
		const store = await createGenerationStore({ stateDir: dir });
		const calls: Array<{ cacheOnly?: true; maxProviderAttempts?: 1 }> = [];
		const existing = createMobileGenerationService({
			store,
			materialize: {
				handleMaterialize: async (_request, options) => {
					calls.push(options);
					if (options.cacheOnly) return { node: { slug: "artist:fixture-artist" } };
					throw new Error("model must not run for cached node");
				},
			},
		});
		expect(await existing.submit(input())).toMatchObject({
			status: "succeeded",
			node_id: "artist:fixture-artist",
		});
		expect(calls).toEqual([{ reuseExisting: true, cacheOnly: true }]);

		const rejectedStore = await createGenerationStore({ stateDir: await storeDir("contradiction") });
		const rejected = createMobileGenerationService({
			store: rejectedStore,
			materialize: {
				handleMaterialize: async () => {
					throw new BadRequestError("contradictory identity");
				},
			},
		});
		await expect(rejected.submit(input())).rejects.toMatchObject({ code: "invalid_request" });
		expect(await rejectedStore.list()).toEqual([]);

		let providerCalls = 0;
		const unavailable = createMobileGenerationService({
			store: {
				create: async () => {
					throw new Error("disk failure");
				},
				get: async () => null,
				list: async () => {
					throw new Error("disk failure");
				},
				lookupIdempotency: async () => {
					throw new Error("disk failure");
				},
				recordImmediate: async () => {
					throw new Error("disk failure");
				},
				transition: async () => {
					throw new Error("disk failure");
				},
			},
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					providerCalls += 1;
					return { node: { slug: "artist:fixture-artist" } };
				},
			},
		});
		await expect(unavailable.submit(input())).rejects.toMatchObject({ code: "provider_unavailable" });
		expect(providerCalls).toBe(0);
	});

	it("durably records cache idempotence without consuming job capacity", async () => {
		const dir = await storeDir("cache-idempotence");
		const store = await createGenerationStore({ stateDir: dir });
		const service = createMobileGenerationService({
			store,
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (!options.cacheOnly) throw new Error("cache hit must not start a worker");
					return { node: { slug: "artist:fixture-artist" } };
				},
			},
		});
		const first = await service.submit(input(REQUEST_A));
		expect(await service.submit(input(REQUEST_A))).toEqual(first);
		const restarted = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: dir }),
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (!options.cacheOnly) throw new Error("cache hit must not start a worker");
					return { node: { slug: "artist:fixture-artist" } };
				},
			},
		});
		for (let index = 0; index < 1_000; index += 1) {
			const cached = await restarted.submit(input(`cache-${index}`));
			expect(cached).toMatchObject({ status: "succeeded", node_id: "artist:fixture-artist" });
		}
		expect(await restarted.submit(input(REQUEST_A))).toEqual(first);
		await expect(
			restarted.submit({ ...input(REQUEST_A), name: "A different cached artist" }),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		expect(await store.list()).toEqual([]);
	});

	it("maps a full immediate registry and a durable write failure without remapping their public errors", async () => {
		const dir = await storeDir("immediate-cap");
		const store = await createGenerationStore({ stateDir: dir });
		const timestamp = new Date().toISOString();
		const immediateResponses = Array.from({ length: 2_048 }, (_, index) => {
			const request = { name: "Cached", requestId: `cached-${index}`, type: "artist" };
			return {
				userId: "public",
				idempotencyKey: request.requestId,
				fingerprint: registryFingerprint(request),
				request,
				nodeId: "artist:cached",
				createdAt: timestamp,
				updatedAt: timestamp,
				terminalAt: timestamp,
			};
		});
		await writeFile(
			join(dir, "generation-store.v1.json"),
			JSON.stringify({ version: 1, generations: [], immediateResponses }),
		);
		const full = createMobileGenerationService({
			store,
			materialize: { handleMaterialize: async () => ({ node: { slug: "artist:cached" } }) },
		});
		await expect(full.submit(input())).rejects.toMatchObject({ code: "busy", status: 429 });
		const router = createMobileRouter({
			catalog: {
				getCatalog: async () => ({
					version: "v1" as const,
					revision: `sha256:${"0".repeat(64)}`,
					taxonomy: { mode: "degraded" as const, available: true },
					nodes: [],
					edges: [],
				}),
			},
			generation: full,
		});
		const httpServer = createServer(async (req, res) => {
			const handled = await router.handle({ req, res, url: new URL(req.url ?? "/", "http://localhost") });
			if (!handled) res.end();
		});
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("test server unavailable");
		try {
			const response = await http(address.port, "POST", "/mobile/v1/generations", {
				request_id: REQUEST_A,
				type: "artist",
				name: "Fixture Artist",
			});
			expect(response).toMatchObject({
				status: 429,
				retryAfter: "30",
				body: { error: { code: "busy" } },
			});
		} finally {
			await new Promise<void>((resolve, reject) =>
				httpServer.close((error) => (error ? reject(error) : resolve())),
			);
		}

		const unavailable = createMobileGenerationService({
			store: {
				create: async () => {
					throw new Error("unused");
				},
				get: async () => null,
				list: async () => [],
				lookupIdempotency: async () => ({ kind: "none" as const }),
				recordImmediate: async () => {
					throw new Error("durable write failed");
				},
				transition: async () => {
					throw new Error("unused");
				},
			},
			materialize: { handleMaterialize: async () => ({ node: { slug: "artist:cached" } }) },
		});
		await expect(unavailable.submit(input())).rejects.toMatchObject({
			code: "provider_unavailable",
			status: 503,
		});
	});

	it("latches after a terminal store write failure without an unhandled rejection or another admission", async () => {
		const persisted = await createGenerationStore({ stateDir: await storeDir("terminal-write-failure") });
		const store = {
			...persisted,
			transition: async (...args: Parameters<typeof persisted.transition>) => {
				if (args[1] === "succeeded") throw new Error("disk write failed");
				return persisted.transition(...args);
			},
		};
		let providerCalls = 0;
		const service = createMobileGenerationService({
			store,
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					providerCalls += 1;
					return { node: { slug: "artist:fixture-artist" } };
				},
			},
		});
		const unhandled: unknown[] = [];
		const observeUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", observeUnhandled);
		try {
			await service.submit(input());
			await eventually(
				async () => providerCalls,
				(calls) => calls === 1,
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			await expect(service.submit(input(REQUEST_B))).rejects.toMatchObject({ code: "provider_unavailable" });
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", observeUnhandled);
		}
	});

	it("observes concurrent worker and follower registry failures before they can become unhandled", async () => {
		const persisted = await createGenerationStore({ stateDir: await storeDir("pump-list-failure") });
		let listCalls = 0;
		const store = {
			...persisted,
			list: async () => {
				listCalls += 1;
				if (listCalls === 1) return persisted.list();
				throw new Error("registry read failed");
			},
		};
		let providerCalls = 0;
		const service = createMobileGenerationService({
			store,
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					providerCalls += 1;
					return { node: { slug: "artist:fixture-artist" } };
				},
			},
		});
		const unhandled: unknown[] = [];
		const observeUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", observeUnhandled);
		try {
			await service.submit(input());
			await new Promise((resolve) => setTimeout(resolve, 15));
			await expect(service.get(REQUEST_A)).rejects.toMatchObject({ code: "provider_unavailable" });
			expect(providerCalls).toBe(0);
			expect(listCalls).toBeGreaterThanOrEqual(3);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", observeUnhandled);
		}
	});

	it("treats the terminal cap as retryable admission and admits again after TTL pruning", async () => {
		const dir = await storeDir("terminal-cap");
		let current = new Date("2026-09-26T12:00:00.000Z");
		const store = await createGenerationStore({ stateDir: dir, now: () => new Date(current) });
		// GenerationStore fingerprints normalized JSON keys alphabetically.
		const terminalRequest = { name: "Completed", requestId: "terminal", type: "artist" };
		const timestamp = current.toISOString();
		await writeFile(
			join(dir, "generation-store.v1.json"),
			JSON.stringify({
				version: 1,
				generations: Array.from({ length: 1_000 }, (_, index) => ({
					id: `terminal-${index}`,
					userId: "public",
					idempotencyKey: `terminal-key-${index}`,
					fingerprint: registryFingerprint(terminalRequest),
					request: terminalRequest,
					status: "succeeded",
					createdAt: timestamp,
					updatedAt: timestamp,
					terminalAt: timestamp,
				})),
			}),
		);
		const service = createMobileGenerationService({
			store,
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					return { node: { slug: "artist:fixture-artist" } };
				},
			},
		});
		await expect(service.submit(input())).rejects.toMatchObject({ code: "busy" });
		current = new Date(current.getTime() + 24 * 60 * 60 * 1_000 + 1);
		await expect(service.submit(input(REQUEST_B))).resolves.toMatchObject({ status: "queued" });
	});

	it("serves strict HTTP validation, 202 Location and 410 expiration", async () => {
		const service = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: await storeDir("http") }),
			materialize: {
				handleMaterialize: async (requestBody, options) => {
					if (options.cacheOnly && requestBody.name === "Cached Artist") {
						return { node: { slug: "artist:cached-artist" } };
					}
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					return deferred<{ node: { slug: string } }>().promise;
				},
			},
		});
		const router = createMobileRouter({
			catalog: {
				getCatalog: async () => ({
					version: "v1" as const,
					revision: `sha256:${"0".repeat(64)}`,
					taxonomy: { mode: "degraded" as const, available: true },
					nodes: [],
					edges: [],
				}),
			},
			generation: service,
		});
		const server = createServer(async (req, res) => {
			const handled = await router.handle({ req, res, url: new URL(req.url ?? "/", "http://localhost") });
			if (!handled) res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server unavailable");
		try {
			const created = await http(address.port, "POST", "/mobile/v1/generations", {
				request_id: REQUEST_A,
				type: "artist",
				name: "Fixture Artist",
			});
			expect(created).toMatchObject({ status: 202, location: `/mobile/v1/generations/${REQUEST_A}` });
			expect(created.body).toMatchObject({ request_id: REQUEST_A, status: "queued" });
			const hostile = await http(address.port, "POST", "/mobile/v1/generations", {
				request_id: REQUEST_B,
				type: "artist",
				name: "Fixture Artist",
				fresh: true,
			});
			expect(hostile.body).toMatchObject({ error: { code: "invalid_request" } });
			const freshQuery = await http(address.port, "POST", "/mobile/v1/generations?fresh=1", {
				request_id: REQUEST_B,
				type: "artist",
				name: "Fixture Artist",
			});
			expect(freshQuery.body).toMatchObject({ error: { code: "invalid_request" } });
			const cached = await http(address.port, "POST", "/mobile/v1/generations", {
				request_id: REQUEST_B,
				type: "artist",
				name: "Cached Artist",
			});
			expect(cached).toMatchObject({
				status: 200,
				location: undefined,
				body: { request_id: REQUEST_B, status: "succeeded", node_id: "artist:cached-artist" },
			});
			expect(cached.body).not.toHaveProperty("immediate");
			const expired = await http(address.port, "GET", `/mobile/v1/generations/${REQUEST_C}`);
			expect(expired.body).toMatchObject({ error: { code: "job_expired" } });
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	// TRA-477: a work clicked from an artist page carries that artist and the edge it came from; they
	// reach /materialize untouched, in the preflight and in the queued run alike.
	it("forwards the artist context and source edge to materialization and validates them", async () => {
		const seen: Array<{ cacheOnly: boolean; request: Record<string, unknown> }> = [];
		const service = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: await storeDir("artist-context") }),
			materialize: {
				handleMaterialize: async (requestBody, options) => {
					seen.push({ cacheOnly: options.cacheOnly === true, request: { ...requestBody } });
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					return { node: { slug: "track:fitna--rohff" } };
				},
			},
		});
		const router = createMobileRouter({
			catalog: {
				getCatalog: async () => ({
					version: "v1" as const,
					revision: `sha256:${"0".repeat(64)}`,
					taxonomy: { mode: "degraded" as const, available: true },
					nodes: [],
					edges: [],
				}),
			},
			generation: service,
		});
		const server = createServer(async (req, res) => {
			const handled = await router.handle({ req, res, url: new URL(req.url ?? "/", "http://localhost") });
			if (!handled) res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server unavailable");
		const body = {
			request_id: REQUEST_A,
			type: "track",
			name: "Fitna",
			artist: "Rohff",
			slug: "track:fitna--rohff",
			source: { slug: "artist:rohff", field: "notable_tracks" },
		};
		try {
			const created = await http(address.port, "POST", "/mobile/v1/generations", body);
			expect(created.status).toBe(202);
			await eventually(
				async () => seen.length,
				(count) => count >= 2,
			);
			const expected = {
				type: "track",
				name: "Fitna",
				artist: "Rohff",
				slug: "track:fitna--rohff",
				source: { slug: "artist:rohff", field: "notable_tracks" },
			};
			expect(seen.map((call) => call.cacheOnly)).toEqual([true, false]);
			for (const call of seen) expect(call.request).toMatchObject(expected);

			// The same request id with another artist is a different request, not a replay.
			const conflicting = await http(address.port, "POST", "/mobile/v1/generations", {
				...body,
				artist: "Akuma",
			});
			expect(conflicting.body).toMatchObject({ error: { code: "idempotency_conflict" } });

			const invalid: Array<[string, Record<string, unknown>]> = [
				["a non-string artist", { artist: 7 }],
				["an empty artist", { artist: "   " }],
				["a source that is not an object", { source: "artist:rohff" }],
				["a source with an extra key", { source: { slug: "artist:rohff", field: "notable_tracks", x: 1 } }],
				[
					"a source slug that is not canonical",
					{ source: { slug: 'artist:x" onmouseover="y', field: "notable_tracks" } },
				],
				["a source field that is not an edge name", { source: { slug: "artist:rohff", field: "../x" } }],
			];
			for (const [label, patch] of invalid) {
				const response = await http(address.port, "POST", "/mobile/v1/generations", {
					...body,
					request_id: REQUEST_B,
					...patch,
				});
				expect(response.body, label).toMatchObject({ error: { code: "invalid_request" } });
			}
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("does not share one paid run between works of the same title by different artists", async () => {
		const finish = deferred<{ node: { slug: string } }>();
		let paidCalls = 0;
		const service = createMobileGenerationService({
			store: await createGenerationStore({ stateDir: await storeDir("artist-identity") }),
			materialize: {
				handleMaterialize: async (_request, options) => {
					if (options.cacheOnly) throw new MaterializeCacheMissError();
					paidCalls += 1;
					return finish.promise;
				},
			},
		});
		await service.submit({ requestId: REQUEST_A, type: "track", name: "Fitna", artist: "Rohff" });
		await service.submit({ requestId: REQUEST_B, type: "track", name: "Fitna", artist: "Akuma" });
		await eventually(
			async () => paidCalls,
			(count) => count === 2,
		);
		finish.resolve({ node: { slug: "track:fitna--rohff" } });
	});

	it("keeps mobile reads bootable while generation initialization is unavailable", async () => {
		const router = createMobileRouter({
			catalog: {
				getCatalog: async () => ({
					version: "v1" as const,
					revision: `sha256:${"0".repeat(64)}`,
					taxonomy: { mode: "degraded" as const, available: true },
					nodes: [],
					edges: [],
				}),
			},
		});
		const server = createServer(async (req, res) => {
			const handled = await router.handle({ req, res, url: new URL(req.url ?? "/", "http://localhost") });
			if (!handled) res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server unavailable");
		try {
			const generation = await http(address.port, "POST", "/mobile/v1/generations", {
				request_id: REQUEST_A,
				type: "artist",
				name: "Fixture Artist",
			});
			expect(generation).toMatchObject({ status: 503, body: { error: { code: "provider_unavailable" } } });
			const catalog = await http(address.port, "GET", "/mobile/v1/catalog");
			expect(catalog).toMatchObject({ status: 200, body: { version: "v1" } });
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});

async function http(
	port: number,
	method: string,
	path: string,
	body?: unknown,
): Promise<{
	status: number;
	location: string | undefined;
	retryAfter: string | undefined;
	body: unknown;
}> {
	const serialized = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				headers: serialized ? { "Content-Type": "application/json" } : {},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						location: typeof res.headers.location === "string" ? res.headers.location : undefined,
						retryAfter:
							typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : undefined,
						body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
					}),
				);
			},
		);
		req.on("error", reject);
		if (serialized) req.write(serialized);
		req.end();
	});
}
