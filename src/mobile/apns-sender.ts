import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ClientHttp2Session, type ClientHttp2Stream, connect, constants } from "node:http2";
import type { ApnsNotificationReservation, ApnsPushStore } from "./push-store.js";

const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const DAILY_TITLE = "track1 — Ta découverte du jour";
const DAILY_BODY = "Une découverte musicale t'attend. Ouvre track1 pour la découvrir.";

export interface ApnsTopics {
	preview: string;
	production: string;
}

export interface ApnsRequest {
	host: string;
	path: string;
	headers: Record<string, string>;
	body: string;
}

export interface ApnsResponse {
	status: number;
	reason?: string;
}

export interface ApnsTransport {
	send(request: ApnsRequest): Promise<ApnsResponse>;
	close?(): Promise<void> | void;
}

export type ApnsSessionFactory = (authority: string) => ClientHttp2Session;

export interface ApnsPushSenderOptions {
	store: ApnsPushStore;
	keyId: string;
	teamId: string;
	privateKeyPath: string;
	topics: ApnsTopics;
	now?: () => Date;
	transport?: ApnsTransport;
	sessionFactory?: ApnsSessionFactory;
	requestTimeoutMs?: number;
}

export interface ApnsPushSendReport {
	accepted: number;
	disabled: number;
	unknown: number;
}

export interface ApnsPushSender {
	sendReserved(reservations: ApnsNotificationReservation[]): Promise<ApnsPushSendReport>;
	close?(): Promise<void>;
}

// A reservation is written before this sender runs. Network failures deliberately remain unknown:
// retrying could create a second application-level delivery after APNs accepted the first request.
export function createApnsPushSender(options: ApnsPushSenderOptions): ApnsPushSender {
	const now = options.now ?? (() => new Date());
	const key = loadPrivateKey(options.privateKeyPath);
	const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
		throw new Error("APNs request timeout must be between 1 and 60000 milliseconds");
	}
	const transport = options.transport ?? createHttp2Transport(options.sessionFactory, requestTimeoutMs);
	let cachedJwt: { value: string; createdAt: number } | undefined;
	let tail: Promise<void> = Promise.resolve();

	function jwt(current: Date): string {
		if (cachedJwt && current.getTime() - cachedJwt.createdAt < JWT_TTL_MS) return cachedJwt.value;
		const header = base64url(JSON.stringify({ alg: "ES256", kid: options.keyId }));
		const claims = base64url(
			JSON.stringify({ iss: options.teamId, iat: Math.floor(current.getTime() / 1000) }),
		);
		const unsigned = `${header}.${claims}`;
		const signer = createSign("SHA256");
		signer.update(unsigned);
		signer.end();
		const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });
		const value = `${unsigned}.${signature.toString("base64url")}`;
		cachedJwt = { value, createdAt: current.getTime() };
		return value;
	}

	async function sendReserved(reservations: ApnsNotificationReservation[]): Promise<ApnsPushSendReport> {
		const report: ApnsPushSendReport = { accepted: 0, disabled: 0, unknown: 0 };
		for (const reservation of reservations) {
			const current = now();
			let response: ApnsResponse;
			try {
				response = await transport.send(toRequest(reservation, jwt(current), options.topics, current));
			} catch {
				report.unknown += 1;
				continue;
			}
			if (response.status >= 200 && response.status < 300) {
				report.accepted += 1;
				continue;
			}
			if (isInvalidTokenResponse(response)) {
				await options.store.disableReservedToken(reservation);
				report.disabled += 1;
			} else {
				report.unknown += 1;
			}
		}
		return report;
	}

	return {
		sendReserved(reservations) {
			const result = tail.then(
				() => sendReserved(reservations),
				() => sendReserved(reservations),
			);
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		async close() {
			await tail;
			await transport.close?.();
		},
	};
}

function loadPrivateKey(path: string): KeyObject {
	try {
		return createPrivateKey(readFileSync(path));
	} catch {
		throw new Error("APNS_PRIVATE_KEY_PATH could not be read as a private key");
	}
}

function toRequest(
	reservation: ApnsNotificationReservation,
	authorization: string,
	topics: ApnsTopics,
	current: Date,
): ApnsRequest {
	const host =
		reservation.apnsEnvironment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
	const topic = topics[reservation.appVariant];
	return {
		host,
		path: `/3/device/${reservation.deviceToken}`,
		headers: {
			authorization: `bearer ${authorization}`,
			"apns-topic": topic,
			"apns-push-type": "alert",
			"apns-priority": "10",
			"apns-expiration": String(Math.floor((current.getTime() + 10 * 60 * 60 * 1000) / 1000)),
			"apns-collapse-id": collapseId(reservation),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			aps: { alert: { title: DAILY_TITLE, body: DAILY_BODY }, sound: "default" },
			kind: "daily",
			notification_id: reservation.notificationId,
			target_local_date: reservation.targetLocalDate,
			url: "track1://today",
		}),
	};
}

function collapseId(reservation: ApnsNotificationReservation): string {
	return createHash("sha256")
		.update(reservation.subscriptionId)
		.update("\0")
		.update(reservation.targetLocalDate)
		.digest("base64url")
		.slice(0, 32);
}

function base64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function isInvalidTokenResponse(response: ApnsResponse): boolean {
	return response.status === 410 || (response.status === 400 && response.reason === "BadDeviceToken");
}

function createHttp2Transport(
	sessionFactory: ApnsSessionFactory = connect,
	requestTimeoutMs: number,
): ApnsTransport {
	const sessions = new Map<string, ClientHttp2Session>();

	function sessionFor(host: string): ClientHttp2Session {
		const existing = sessions.get(host);
		if (existing && !existing.closed && !existing.destroyed) return existing;
		const session = sessionFactory(`https://${host}`);
		sessions.set(host, session);
		const forget = () => {
			if (sessions.get(host) === session) sessions.delete(host);
		};
		session.once("close", forget);
		session.once("error", forget);
		return session;
	}

	return {
		send(request) {
			return sendHttp2Request(sessionFor(request.host), request, requestTimeoutMs);
		},
		async close() {
			await Promise.all(
				[...sessions.values()].map(async (session) => {
					if (session.closed || session.destroyed) return;
					await new Promise<void>((resolve) => {
						session.once("close", resolve);
						session.close();
					});
				}),
			);
			sessions.clear();
		},
	};
}

async function sendHttp2Request(
	session: ClientHttp2Session,
	request: ApnsRequest,
	requestTimeoutMs: number,
): Promise<ApnsResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let status: number | undefined;
		let body = "";
		let stream: ClientHttp2Stream | undefined;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			session.off("error", onSessionError);
			callback();
		};
		const timeout = setTimeout(() => {
			// Cancel only this stream. Keeping the session alive lets unrelated healthy streams finish,
			// while close() cannot be held forever by a peer that never sends END_STREAM.
			finish(() => reject(new Error("APNs request timed out")));
			stream?.close(constants.NGHTTP2_CANCEL);
		}, requestTimeoutMs);
		const onSessionError = (error: Error) => finish(() => reject(error));
		session.once("error", onSessionError);
		const requestStream = session.request({ ":method": "POST", ":path": request.path, ...request.headers });
		stream = requestStream;
		requestStream.setEncoding("utf8");
		requestStream.once("response", (headers) => {
			const value = headers[":status"];
			if (typeof value === "number") status = value;
		});
		requestStream.on("data", (chunk: string) => {
			if (body.length < 4096) body += chunk;
		});
		requestStream.once("error", (error) => finish(() => reject(error)));
		requestStream.once("end", () => {
			finish(() => {
				if (status === undefined) {
					reject(new Error("APNs response had no status"));
					return;
				}
				resolve({ status, ...readReason(body) });
			});
		});
		requestStream.end(request.body);
	});
}

function readReason(body: string): Pick<ApnsResponse, "reason"> {
	try {
		const value: unknown = JSON.parse(body);
		if (
			typeof value === "object" &&
			value !== null &&
			"reason" in value &&
			typeof value.reason === "string"
		) {
			return { reason: value.reason };
		}
	} catch {
		// APNs error bodies are optional; an unknown body must not alter delivery handling.
	}
	return {};
}
