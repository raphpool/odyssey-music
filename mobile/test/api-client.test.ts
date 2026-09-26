import { createApiClient, type FetchLike } from "../src/api/client";
import { catalogFixture, generationFixture, imageFixture, linksFixture, nodeFixture } from "./fixtures/api";

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

	it("accepts the nullable teaser documented by the mobile catalog contract", async () => {
		const catalogWithNullTeaser = {
			...catalogFixture,
			nodes: [{ ...catalogFixture.nodes[0], teaser: null }],
		};
		await expect(clientWith([json(catalogWithNullTeaser)]).client.getCatalog()).resolves.toMatchObject({
			kind: "success",
			value: catalogWithNullTeaser,
		});
	});

	it("rejects a future taxonomy mode", async () => {
		const unsupportedTaxonomy = { ...catalogFixture, taxonomy: { mode: "v2", available: true } };
		await expect(clientWith([json(unsupportedTaxonomy)]).client.getCatalog()).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
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
			clientWith([new Response(null, { status: 304 })]).client.getCatalog(cached),
		).resolves.toEqual({ kind: "notModified", etag: "catalog-v1" });
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
			json(imageFixture),
			json(linksFixture),
			json({ q: "massive", hits: [], sources: { cache: 0, catalog: 0 } }),
		]);

		await expect(client.getNode("artist:massive-attack")).resolves.toMatchObject({
			kind: "success",
			value: nodeFixture,
		});
		await expect(client.getImage("artist:massive-attack")).resolves.toMatchObject({
			kind: "success",
			value: imageFixture,
		});
		await expect(client.getLinks("artist:massive-attack")).resolves.toMatchObject({
			kind: "success",
			value: linksFixture,
		});
		await expect(client.search({ q: "massive", type: "artist", limit: 3 })).resolves.toMatchObject({
			kind: "success",
		});
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			"https://api.example.test/mobile/v1/nodes/artist%3Amassive-attack",
			"https://api.example.test/mobile/v1/nodes/artist%3Amassive-attack/image",
			"https://api.example.test/mobile/v1/nodes/artist%3Amassive-attack/links",
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

	it("accepts canonical disambiguators and rejects unsafe provider payloads", async () => {
		const catalogWithDisambiguator = {
			...catalogFixture,
			nodes: [
				{
					...catalogFixture.nodes[0],
					identity: "artist:pole--stefan-betke",
				},
			],
		};
		const { client } = clientWith([
			json(catalogWithDisambiguator),
			json({ ...linksFixture, spotify: "https://evil.example/track" }),
			json({
				q: "massive",
				hits: [{ source: "cache", type: "artist", name: "Massive Attack" }],
				sources: {},
			}),
		]);
		await expect(client.getCatalog()).resolves.toMatchObject({ kind: "success" });
		await expect(client.getLinks("artist:massive-attack")).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
		});
		await expect(client.search({ q: "massive" })).resolves.toMatchObject({
			kind: "error",
			error: { kind: "invalid_response" },
		});
	});

	it("accepts the real node and search DTO shapes", async () => {
		const richNode = {
			...nodeFixture,
			node: {
				...nodeFixture.node,
				citations: [{ url: "https://example.com/source", title: "Source" }],
				edges: {
					projects: [
						{
							slug: "project:blue-lines",
							type: "project",
							name: "Blue Lines",
							year: "1991",
							releaseType: "album",
						},
					],
				},
				facts: { origin: "Bristol" },
			},
		};
		const realSearch = {
			q: "massive",
			hits: [
				{
					source: "catalog",
					type: "artist",
					name: "Massive Attack",
					mbid: "11111111-1111-4111-8111-111111111111",
					subtitle: "Bristol",
					extra: "trip-hop",
				},
			],
			sources: { cache: 0, catalog: 1 },
		};
		const { client } = clientWith([json(richNode), json(realSearch)]);
		await expect(client.getNode("artist:massive-attack")).resolves.toMatchObject({
			kind: "success",
			value: richNode,
		});
		await expect(client.search({ q: "massive" })).resolves.toMatchObject({
			kind: "success",
			value: realSearch,
		});
	});

	it("rejects malformed edges, facts, citations and search metadata", async () => {
		const mismatchedEdge = {
			...nodeFixture,
			node: {
				...nodeFixture.node,
				edges: { artists: { slug: "track:teardrop", type: "artist", name: "Massive Attack" } },
			},
		};
		const privateCitation = {
			...nodeFixture,
			node: { ...nodeFixture.node, citations: [{ url: "https://[::ffff:127.0.0.1]/internal" }] },
		};
		const structuredFact = {
			...nodeFixture,
			node: { ...nodeFixture.node, facts: { origin: { city: "Bristol" } } },
		};
		const badSearch = {
			q: "massive",
			hits: [
				{
					source: "cache",
					type: "artist",
					name: "Massive Attack",
					slug: "https://evil.example",
					extra: { raw: "not a string" },
				},
			],
			sources: { cache: 1 },
		};
		const { client } = clientWith([
			json(mismatchedEdge),
			json(privateCitation),
			json(structuredFact),
			json(badSearch),
		]);
		for (const read of [
			client.getNode("artist:massive-attack"),
			client.getNode("artist:massive-attack"),
			client.getNode("artist:massive-attack"),
			client.search({ q: "massive" }),
		]) {
			await expect(read).resolves.toMatchObject({ kind: "error", error: { kind: "invalid_response" } });
		}
	});

	it.each([
		"http://example.com/source",
		"https://localhost/source",
		"https://localhost./source",
		"https://127.0.0.1/source",
		"https://10.0.0.1/source",
		"https://[::1]/source",
		"https://[fc00::1]/source",
		"https://user@example.com/source",
		"https://example.com:8443/source",
	])("rejects unsafe citation URL %s", async (url) => {
		const response = {
			...nodeFixture,
			node: { ...nodeFixture.node, citations: [{ url }] },
		};
		await expect(clientWith([json(response)]).client.getNode("artist:massive-attack")).resolves.toMatchObject(
			{
				kind: "error",
				error: { kind: "invalid_response" },
			},
		);
	});

	it.each(["https://fcbayern.com/source", "https://[2606:4700:4700::1111]/source"])(
		"accepts a public citation URL %s",
		async (url) => {
			const response = {
				...nodeFixture,
				node: { ...nodeFixture.node, citations: [{ url }] },
			};
			await expect(
				clientWith([json(response)]).client.getNode("artist:massive-attack"),
			).resolves.toMatchObject({ kind: "success" });
		},
	);

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
			client.createGeneration({
				requestId: "11111111-1111-4111-8111-111111111111",
				type: "artist",
				name: "Massive Attack",
			}),
		).resolves.toMatchObject({ kind: "success", value: generationFixture });
		await expect(
			client.createGeneration({
				requestId: "22222222-2222-4222-8222-222222222222",
				type: "artist",
				name: "Massive Attack",
			}),
		).resolves.toMatchObject({
			kind: "error",
			error: { kind: "network_error" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({
				request_id: "11111111-1111-4111-8111-111111111111",
				type: "artist",
				name: "Massive Attack",
			}),
		});
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
			json({ error: { code: "quota", message: "provider secret", retryable: false } }, 429, {
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
				retryable: false,
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
