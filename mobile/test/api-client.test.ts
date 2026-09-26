import { createApiClient, type FetchLike } from "../src/api/client";
import { catalogFixture, generationFixture, nodeFixture } from "./fixtures/api";

const config = {
	appEnvironment: "development" as const,
	apiBaseUrl: "https://api.example.test/mobile/v1/",
};

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(body), headers === undefined ? { status } : { status, headers });
}

function clientWith(responses: Array<Response | Error>) {
	const fetchMock = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
	for (const response of responses) {
		fetchMock.mockImplementationOnce(async () => {
			if (response instanceof Error) throw response;
			return response;
		});
	}
	return { client: createApiClient({ config, fetch: fetchMock }), fetchMock };
}

describe("mobile API client", () => {
	it("validates the catalog and carries ETag metadata", async () => {
		const { client, fetchMock } = clientWith([json(catalogFixture, 200, { ETag: "catalog-v1" })]);

		await expect(client.getCatalog({ etag: "prior", hasCachedCopy: true })).resolves.toMatchObject({
			kind: "success",
			value: catalogFixture,
			etag: "catalog-v1",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.example.test/mobile/v1/catalog",
			expect.objectContaining({ headers: expect.objectContaining({ "If-None-Match": "prior" }) }),
		);
	});

	it("accepts a live catalog node whose optional teaser is null", async () => {
		const catalogWithNullTeaser = {
			...catalogFixture,
			nodes: [{ ...catalogFixture.nodes[0], teaser: null }],
		};
		await expect(clientWith([json(catalogWithNullTeaser)]).client.getCatalog()).resolves.toMatchObject({
			kind: "success",
			value: catalogWithNullTeaser,
		});
	});

	it("only accepts a 304 catalog when a local copy and ETag exist", async () => {
		const cached = { etag: "catalog-v1", hasCachedCopy: true };
		await expect(
			clientWith([new Response(null, { status: 304, headers: { ETag: "catalog-v1" } })]).client.getCatalog(
				cached,
			),
		).resolves.toEqual({
			kind: "notModified",
			etag: "catalog-v1",
		});
		await expect(
			clientWith([new Response(null, { status: 304 })]).client.getCatalog(),
		).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
		});
		const withoutCopy = clientWith([new Response(null, { status: 304, headers: { ETag: "catalog-v1" } })]);
		await expect(
			withoutCopy.client.getCatalog({ etag: "catalog-v1", hasCachedCopy: false }),
		).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
		});
		expect(withoutCopy.fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: {} });
	});

	it("validates every read method and encodes untrusted slugs inside the configured route", async () => {
		const { client, fetchMock } = clientWith([
			json(nodeFixture),
			json({ image: null }),
			json({ links: null }),
			json({ q: "massive", hits: [], sources: ["cache"] }),
		]);

		await expect(client.getNode("artist:massive-attack")).resolves.toMatchObject({
			kind: "success",
			value: nodeFixture,
		});
		await expect(client.getImage("artist:massive-attack")).resolves.toMatchObject({
			kind: "success",
			value: { image: null },
		});
		await expect(client.getLinks("artist:massive-attack")).resolves.toMatchObject({
			kind: "success",
			value: { links: null },
		});
		await expect(client.search({ q: "massive", type: "artist", limit: 3 })).resolves.toMatchObject({
			kind: "success",
		});
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			"https://api.example.test/mobile/v1/nodes/artist%3Amassive-attack",
			"https://api.example.test/mobile/v1/images/artist%3Amassive-attack",
			"https://api.example.test/mobile/v1/links/artist%3Amassive-attack",
			"https://api.example.test/mobile/v1/search?q=massive&type=artist&limit=3",
		]);
	});

	it("keeps a malicious slug confined to its route", async () => {
		const { client, fetchMock } = clientWith([json(nodeFixture)]);
		await client.getNode("artist:foo/../../https://evil.example");
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://api.example.test/mobile/v1/nodes/artist%3Afoo%2F..%2F..%2Fhttps%3A%2F%2Fevil.example",
		);
	});

	it("validates terminal generation invariants and never retries POST", async () => {
		const { client, fetchMock } = clientWith([
			json(generationFixture),
			json(generationFixture),
			new Error("offline"),
		]);
		await expect(client.getGeneration("request-1")).resolves.toMatchObject({
			kind: "success",
			value: generationFixture,
		});
		await expect(
			client.createGeneration({ idempotencyKey: "key-1", input: { name: "Massive Attack" } }),
		).resolves.toMatchObject({ kind: "success", value: generationFixture });
		await expect(
			client.createGeneration({ idempotencyKey: "key-2", input: { name: "Massive Attack" } }),
		).resolves.toMatchObject({
			kind: "error",
			error: { kind: "network_error" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
	});

	it("rejects unknown schemas, incoherent identities and incomplete terminal states", async () => {
		const unknownSchema = { ...catalogFixture, version: "v2" };
		const incoherentNode = { ...nodeFixture, node: { ...nodeFixture.node, type: "track" } };
		const incompleteTerminal = { ...generationFixture, status: "failed", node_id: undefined };
		const { client } = clientWith([json(unknownSchema), json(incoherentNode), json(incompleteTerminal)]);
		await expect(client.getCatalog()).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
		});
		await expect(client.getNode("artist:massive-attack")).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
		});
		await expect(client.getGeneration("request-1")).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
		});
	});

	it("distinguishes safe API, timeout and cancellation errors without exposing provider messages", async () => {
		const api = clientWith([
			json({ error: { code: "gone", message: "provider secret" } }, 404),
			json({ error: { code: "quota", message: "provider secret" } }, 429, {
				"Retry-After": "30",
			}),
		]);
		await expect(api.client.getNode("artist:missing")).resolves.toMatchObject({
			kind: "error",
			error: { kind: "api", status: 404, message: "The service cannot fulfil this request." },
		});
		await expect(api.client.search({ q: "test" })).resolves.toEqual({
			kind: "error",
			error: {
				kind: "api",
				status: 429,
				code: "quota",
				retryable: true,
				retryAfterSeconds: 30,
				message: "Try again later.",
			},
		});

		const controller = new AbortController();
		controller.abort();
		await expect(
			clientWith([]).client.search({ q: "test", signal: controller.signal }),
		).resolves.toMatchObject({
			kind: "error",
			error: { kind: "cancelled" },
		});

		jest.useFakeTimers();
		const timeoutFetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject({ name: "AbortError" }));
				}),
		);
		const timedOut = createApiClient({ config, fetch: timeoutFetch }).search({ q: "test" });
		jest.advanceTimersByTime(15_000);
		await expect(timedOut).resolves.toMatchObject({ kind: "error", error: { kind: "timeout" } });
		jest.useRealTimers();

		await expect(clientWith([new Response("{", { status: 200 })]).client.getCatalog()).resolves.toMatchObject(
			{
				kind: "error",
				error: { kind: "invalid_response" },
			},
		);
	});
});
