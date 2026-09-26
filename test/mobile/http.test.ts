import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMobileCatalog } from "../../src/mobile/catalog.js";
import { createMobileRouter } from "../../src/mobile/router.js";

const fixturePath = fileURLToPath(new URL("../fixtures/mobile-contracts.json", import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

async function loadGraph(): Promise<unknown> {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { graph: unknown };
	return fixture.graph;
}

async function startServer(getGraph: () => Promise<unknown>): Promise<number> {
	const catalog = createMobileCatalog({ getGraph });
	const mobileRouter = createMobileRouter({ catalog });
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const handled = await mobileRouter.handle({ req, res, url });
		if (!handled) res.end();
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
	return address.port;
}

async function get(port: number, path: string, headers: Record<string, string> = {}) {
	return new Promise<{
		status: number;
		headers: Record<string, string | string[] | undefined>;
		body: string;
	}>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("mobile HTTP catalog", () => {
	it("serves a cacheable mobile-only catalog and returns 304 for its ETag", async () => {
		const graph = await loadGraph();
		const port = await startServer(async () => graph);

		const first = await get(port, "/mobile/v1/catalog");
		const etag = first.headers.etag;
		const second = await get(port, "/mobile/v1/catalog", {
			"if-none-match": typeof etag === "string" ? etag : "",
		});

		expect(first.status).toBe(200);
		expect(first.headers["cache-control"]).toContain("max-age=60");
		expect(etag).toMatch(/^"sha256-[a-f0-9]{64}"$/);
		expect(first.body).not.toContain("This must never reach mobile");
		expect(second).toMatchObject({ status: 304, body: "" });
		expect(second.headers.etag).toBe(etag);
	});

	it("uses stable typed errors for invalid requests and unknown mobile routes", async () => {
		const graph = await loadGraph();
		const port = await startServer(async () => graph);

		const invalid = await get(port, "/mobile/v1/catalog?identities=article%3Aignored");
		const missing = await get(port, "/mobile/v1/daily-recommendation");

		expect(invalid).toMatchObject({
			status: 400,
			body: JSON.stringify({ error: { code: "invalid_request", message: "unsupported identity type" } }),
		});
		expect(missing).toMatchObject({
			status: 404,
			body: JSON.stringify({ error: { code: "not_found", message: "mobile resource not found" } }),
		});
	});

	it("does not leak internal failures from catalog construction", async () => {
		const port = await startServer(async () => {
			throw new Error("cache directory /secret is unavailable");
		});

		const response = await get(port, "/mobile/v1/catalog");

		expect(response).toMatchObject({
			status: 500,
			body: JSON.stringify({
				error: { code: "catalog_unavailable", message: "mobile catalog is temporarily unavailable" },
			}),
		});
	});

	it("rejects an oversized identities request without reading the catalog", async () => {
		let graphReads = 0;
		const port = await startServer(async () => {
			graphReads += 1;
			return loadGraph();
		});

		const response = await get(port, `/mobile/v1/catalog?identities=artist%3A${"a".repeat(8 * 1024)}`);

		expect(response).toMatchObject({
			status: 400,
			body: JSON.stringify({
				error: { code: "invalid_request", message: "identities accepts at most 8192 bytes" },
			}),
		});
		expect(graphReads).toBe(0);
	});
});
