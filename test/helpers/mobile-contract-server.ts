import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, Server, type ServerResponse } from "node:http";
import { NodeCache } from "../../src/cache.js";
import type { ArtistNode, GenreNode } from "../../src/types.js";

const PARENT_POLL_MILLISECONDS = 500;
const readyFile = argument("--ready-file");
exitWithParent();
const nativeFetch = globalThis.fetch;
let providerFetchAttempts = 0;
let catalogRequests = 0;
let notModifiedCatalogRequests = 0;
let nodeRequests = 0;
let generationPosts = 0;
const observedRequests: string[] = [];

globalThis.fetch = async (input, init) => {
	const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
	if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
		providerFetchAttempts += 1;
		throw new Error(`The contract harness blocked an unexpected provider request to ${url.hostname}.`);
	}
	return nativeFetch(input, init);
};

const cacheDir = requiredEnvironment("ODYSSEY_CACHE_DIR");
const stateDir = requiredEnvironment("MOBILE_STATE_DIR");
// 2026-10-15 (TRA-530): the port of the owned server used to be probed here (bind 127.0.0.1:0, close, pass the
// number as PORT). src/server.ts then listens on every interface, and on macOS a bind on 127.0.0.1:N succeeds
// while another process holds *:N, so the probe could hand out a port that the real listen found taken
// (`EADDRINUSE :::56773`) when the three runners of the Mac ran this harness at the same time. The owned
// server now binds port 0 on loopback and the real port is read back once it listens.
process.env.PORT = "0";
const upstreamListening = captureUpstreamServer();
const cache = new NodeCache(cacheDir);
await cache.write(artistNode());
await cache.write(genreNode());
await mkdir(stateDir, { recursive: true });
await writeFile(`${stateDir}/generation-store.v1.json`, "{corrupt");

await import("../../src/server.js");
const upstreamPort = await upstreamListening();
await waitForHealth(upstreamPort);

const proxy = createServer((clientRequest, clientResponse) => {
	observedRequests.push(`${clientRequest.method ?? "UNKNOWN"} ${clientRequest.url ?? ""}`);
	if (clientRequest.url === "/__track1_contract_report") {
		return respond(clientResponse, 200, report());
	}
	if (clientRequest.url === "/__track1_contract_reset" && clientRequest.method === "POST") {
		resetCounters();
		return respond(clientResponse, 204);
	}
	if (clientRequest.url?.startsWith("/mobile/v1/catalog")) catalogRequests += 1;
	if (clientRequest.url?.startsWith("/mobile/v1/nodes/")) nodeRequests += 1;
	if (
		clientRequest.method === "POST" &&
		(clientRequest.url === "/mobile/v1/generations" ||
			clientRequest.url?.startsWith("/mobile/v1/generations?"))
	)
		generationPosts += 1;
	proxyRequest(clientRequest, clientResponse);
});
await listen(proxy);
const address = proxy.address();
if (address === null || typeof address === "string")
	throw new Error("The contract proxy did not bind a TCP port.");
const baseURL = `http://127.0.0.1:${address.port}/mobile/v1/`;
// Renamed into place so that a reader never sees a half-written URL.
await writeFile(`${readyFile}.partial`, `${baseURL}\n`, { encoding: "utf8", mode: 0o600 });
await rename(`${readyFile}.partial`, readyFile);

function proxyRequest(clientRequest: IncomingMessage, clientResponse: ServerResponse): void {
	const upstreamRequest = request(
		{
			host: "127.0.0.1",
			port: upstreamPort,
			method: clientRequest.method,
			path: clientRequest.url,
			headers: clientRequest.headers,
		},
		(upstreamResponse) => {
			if (clientRequest.url?.startsWith("/mobile/v1/catalog") && upstreamResponse.statusCode === 304) {
				notModifiedCatalogRequests += 1;
			}
			clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
			upstreamResponse.pipe(clientResponse);
		},
	);
	upstreamRequest.on("error", (error: Error) => respond(clientResponse, 502, { error: error.message }));
	clientRequest.pipe(upstreamRequest);
}

function report() {
	return {
		providerFetchAttempts,
		catalogRequests,
		notModifiedCatalogRequests,
		nodeRequests,
		generationPosts,
		observedRequests,
	};
}

function resetCounters(): void {
	providerFetchAttempts = 0;
	catalogRequests = 0;
	notModifiedCatalogRequests = 0;
	nodeRequests = 0;
	generationPosts = 0;
	observedRequests.length = 0;
}

function artistNode(): ArtistNode {
	return {
		slug: "artist:fixture-artist",
		type: "artist",
		name: "Fixture Artist",
		editorial_article: "A fixture artist article long enough to satisfy the cache schema. ".repeat(2),
		editorial_bio: "A fixture artist bio.",
		citations: [{ url: "https://example.com/fixture-artist" }],
		materialized_at: "2026-09-27T00:00:00.000Z",
		photo_url: "https://images.example.com/fixture-artist.jpg",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
	};
}

function genreNode(): GenreNode {
	return {
		slug: "genre:ambient",
		type: "genre",
		name: "Ambient",
		editorial_article: "A fixture ambient article long enough to satisfy the cache schema. ".repeat(2),
		editorial_definition: "A fixture genre definition.",
		citations: [{ url: "https://example.com/ambient" }],
		materialized_at: "2026-09-27T00:00:00.000Z",
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
	};
}

async function waitForHealth(port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			if ((await localRequest(port, "/health")).status === 200) return;
		} catch {
			// The owned server has not bound its port yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("The contract server did not become healthy within five seconds.");
}

function localRequest(port: number, path: string): Promise<{ status: number }> {
	return new Promise((resolve, reject) => {
		const healthRequest = request({ host: "127.0.0.1", port, path }, (response) => {
			response.resume();
			response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
		});
		healthRequest.once("error", reject);
		healthRequest.end();
	});
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
}

// Makes the next `listen` of an http server (the one of src/server.ts, started by the import below) bind a
// system-chosen port on loopback only, whatever it asked for. Returns a function that resolves with the real port.
function captureUpstreamServer(): () => Promise<number> {
	const originalListen = Server.prototype.listen;
	let captured: Server | undefined;
	Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
		Server.prototype.listen = originalListen;
		// PORT=0 was set above, so the only call shape accepted is listen(0, callback?): anything else (a host,
		// an options object) would be silently dropped by the rewrite below.
		if (args[0] !== 0 || (args.length > 1 && typeof args[1] !== "function"))
			throw new Error("src/server.ts listens with arguments the contract harness does not expect.");
		captured = this;
		const callback = args.find((argument) => typeof argument === "function");
		const bindArguments = callback === undefined ? [0, "127.0.0.1"] : [0, "127.0.0.1", callback];
		return (originalListen as (...listenArguments: unknown[]) => Server).apply(this, bindArguments);
	} as typeof Server.prototype.listen;
	return () =>
		new Promise((resolve, reject) => {
			const server = captured;
			if (server === undefined) return reject(new Error("src/server.ts did not start an http server."));
			const publish = () => {
				const address = server.address();
				if (address === null || typeof address === "string")
					return reject(new Error("The owned server did not bind a TCP port."));
				resolve(address.port);
			};
			if (server.listening) return publish();
			server.once("listening", publish);
			server.once("error", reject);
		});
}

// 2026-10-15 (TRA-530): a job cancelled with SIGKILL never runs the trap of check.sh, so harnesses outlived their
// job for up to two days (parent 1), holding two ports and some memory each. The harness polls its parent and
// leaves when it changes: the kernel reparents an orphan to pid 1, and `process.ppid` reads the live value.
function exitWithParent(): void {
	const parent = process.ppid;
	if (parent <= 1) return;
	setInterval(() => {
		if (process.ppid === parent) return;
		console.error(`The parent process ${parent} is gone; the contract harness exits.`);
		process.exit(0);
	}, PARENT_POLL_MILLISECONDS).unref();
}

function respond(response: ServerResponse, status: number, body?: unknown): void {
	response.statusCode = status;
	if (body !== undefined) {
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify(body));
		return;
	}
	response.end();
}

function argument(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index < 0 ? undefined : process.argv[index + 1];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
