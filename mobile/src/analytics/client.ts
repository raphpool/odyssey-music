import type { Consent, ConsentStore } from "./consent";
import {
	type AnalyticsSource,
	type EventContext,
	type EventName,
	type EventProperties,
	isUuidV4,
	validateEvent,
} from "./contracts";

export type AnalyticsPayload = {
	name: EventName;
	properties: EventProperties & {
		event_id: string;
		schema_version: 1;
		platform: "ios" | "android";
		app_version: string;
		build_number: string;
		environment: "development" | "preview" | "production";
		source: AnalyticsSource;
		occurred_at: string;
		anonymousId: string;
	};
	context: EventContext;
};
export type AnalyticsTransport = {
	track(payload: AnalyticsPayload): Promise<boolean>;
	disable(): Promise<void>;
	purge(): Promise<boolean>;
	reset(): Promise<void>;
	destroy(): void;
	onReady?(callback: () => void): () => void;
};
export type TrackResult = { kind: "accepted" } | { kind: "disabled" } | { kind: "invalid" };
export type ClientOptions = {
	consent: ConsentStore;
	createTransport(): AnalyticsTransport | undefined;
	purgeStorage?(): Promise<boolean>;
	createId(): string;
	environment: "development" | "preview" | "production";
	platform: "ios" | "android";
	appVersion: string;
	buildNumber: string;
	now?: () => string;
};

type DetachedRuntime = { previous: AnalyticsTransport | undefined; disabled: Promise<boolean> };

export class AnalyticsClient {
	private consentState: Consent = { version: 1, status: "unknown" };
	private transport: AnalyticsTransport | undefined;
	private epoch = 0;
	private opened = false;
	private opening: Promise<TrackResult> | undefined;
	private appState: "active" | "background" | "inactive" = "active";
	private _anonymousId: string | undefined;
	private _purgeIncomplete = false;
	private intent = 0;
	private revocationSequence = 0;
	private readonly acceptedRevocations = new Set<number>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private readyUnsubscribe: (() => void) | undefined;
	private transitions: Promise<void> = Promise.resolve();
	private readonly now: () => string;

	constructor(private readonly options: ClientOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
	}

	get consent(): Consent {
		return this.consentState;
	}

	get anonymousId(): string | undefined {
		return this._anonymousId;
	}

	get configured(): boolean {
		return this.transport !== undefined;
	}

	get purgeIncomplete(): boolean {
		return this._purgeIncomplete;
	}

	async initialize(): Promise<Consent> {
		if (this.disposed) return this.consentState;
		const intent = ++this.intent;
		const epoch = this.epoch;
		return this.serialize(async () => {
			if (!this.current(intent, epoch)) return this.consentState;
			const loaded = await this.options.consent.read();
			const pending = await this.options.consent.revocationPending();
			if (!this.current(intent, epoch)) return this.consentState;
			this.consentState = loaded;
			this._purgeIncomplete = pending;
			if (loaded.status !== "granted" || pending) return this.consentState;
			const activated = await this.activate(intent, epoch);
			if (!this.current(intent, epoch)) return this.consentState;
			if (!activated) await this.rollbackGrant();
			return this.consentState;
		});
	}

	async grant(): Promise<Consent> {
		if (this.disposed) return this.consentState;
		const intent = ++this.intent;
		const epoch = this.epoch;
		return this.serialize(async () => {
			if (!this.current(intent, epoch) || this._purgeIncomplete) return this.consentState;
			try {
				this.consentState = await this.options.consent.grant();
			} catch {
				return this.consentState;
			}
			if (!this.current(intent, epoch) || this._purgeIncomplete) return this.consentState;
			const activated = await this.activate(intent, epoch);
			if (!this.current(intent, epoch)) return this.consentState;
			if (!activated) await this.rollbackGrant();
			return this.consentState;
		});
	}

	async revoke(): Promise<Consent> {
		if (this.disposed) return this.consentState;
		const admission = ++this.revocationSequence;
		this.acceptedRevocations.add(admission);
		this.intent += 1;
		this._purgeIncomplete = true;
		this.consentState = { version: 1, status: "denied" };
		const detached = this.detachRuntime();
		return this.serialize(async () => {
			// Disposal rejects only future calls. A withdrawal admitted while active must finish its
			// durable cleanup before dispose's later serialized resource cleanup can run.
			if (!this.acceptedRevocations.delete(admission)) return this.consentState;
			return this.withdraw(detached);
		});
	}

	async dispose(): Promise<void> {
		if (this.disposePromise !== undefined) return this.disposePromise;
		this.disposed = true;
		this.intent += 1;
		const detached = this.detachRuntime();
		this.disposePromise = this.serialize(async () => {
			await detached.disabled;
			try {
				detached.previous?.destroy();
			} catch {
				// A replacement controller is already detached, so cleanup cannot re-enable it.
			}
		});
		return this.disposePromise;
	}

	async recordAppOpened(source: AnalyticsSource = "app"): Promise<TrackResult> {
		if (this.disposed) return { kind: "disabled" };
		if (this.opening !== undefined) return this.opening;
		if (this.opened) return { kind: "disabled" };
		const epoch = this.epoch;
		this.opened = true;
		const opening = this.trackEvent("app_opened", {}, { source })
			.then((result) => {
				if (result.kind !== "accepted" && epoch === this.epoch) this.opened = false;
				return result;
			})
			.finally(() => {
				if (this.opening === opening) this.opening = undefined;
			});
		this.opening = opening;
		return opening;
	}

	async onAppState(next: "active" | "background" | "inactive"): Promise<TrackResult | undefined> {
		if (this.disposed) return undefined;
		const previous = this.appState;
		this.appState = next;
		return next === "active" && previous === "background"
			? this.trackEvent("app_opened", {}, { source: "app" })
			: undefined;
	}

	async trackEvent(name: unknown, properties: unknown, context: unknown): Promise<TrackResult> {
		if (this.disposed) return { kind: "disabled" };
		const validated = validateEvent(name, properties, context);
		if (!validated.ok) return { kind: "invalid" };
		const transport = this.transport;
		const anonymousId = this._anonymousId;
		const epoch = this.epoch;
		if (
			this.disposed ||
			this.consentState.status !== "granted" ||
			transport === undefined ||
			anonymousId === undefined
		)
			return { kind: "disabled" };
		const eventId = validated.context.event_id ?? this.options.createId();
		const payload: AnalyticsPayload = {
			name: validated.name,
			properties: {
				...validated.properties,
				...(validated.context.recommendation_id === undefined ||
				validated.properties.recommendation_id !== undefined
					? {}
					: { recommendation_id: validated.context.recommendation_id }),
				...(validated.context.notification_id === undefined ||
				validated.properties.notification_id !== undefined
					? {}
					: { notification_id: validated.context.notification_id }),
				event_id: eventId,
				schema_version: 1,
				platform: this.options.platform,
				app_version: this.options.appVersion,
				build_number: this.options.buildNumber,
				environment: this.options.environment,
				source: validated.context.source,
				occurred_at: this.now(),
				anonymousId,
			},
			context:
				validated.context.event_id === undefined
					? { ...validated.context, event_id: eventId }
					: validated.context,
		};
		if (!(await safely(() => transport.track(payload)))) return { kind: "disabled" };
		return this.epoch === epoch && this.transport === transport ? { kind: "accepted" } : { kind: "disabled" };
	}

	private current(intent: number, epoch: number): boolean {
		return !this.disposed && this.intent === intent && this.epoch === epoch;
	}

	private async activate(expectedIntent: number, expectedEpoch: number): Promise<boolean> {
		if (
			!this.current(expectedIntent, expectedEpoch) ||
			this.consentState.status !== "granted" ||
			this.transport !== undefined ||
			this._purgeIncomplete
		)
			return false;
		let existing: string | null;
		try {
			existing = await this.options.consent.anonymousId();
		} catch {
			return false;
		}
		if (!this.current(expectedIntent, expectedEpoch)) return false;
		let anonymousId = existing;
		if (anonymousId === null || !isUuidV4(anonymousId)) {
			try {
				anonymousId = this.options.createId();
				if (!isUuidV4(anonymousId)) return false;
				await this.options.consent.saveAnonymousId(anonymousId);
			} catch {
				return false;
			}
		}
		if (!this.current(expectedIntent, expectedEpoch) || anonymousId === null) return false;
		let next: AnalyticsTransport | undefined;
		try {
			next = this.options.createTransport();
			if (next === undefined) return false;
			this.transport = next;
			this._anonymousId = anonymousId;
			this.readyUnsubscribe = next.onReady?.(() => void this.recordAppOpened("app"));
			return true;
		} catch {
			if (next !== undefined) {
				await safely(async () => {
					await next?.disable();
					return true;
				});
				try {
					next.destroy();
				} catch {
					// The rollback below still removes durable data and denies consent.
				}
			}
			this.clearTransport();
			return false;
		}
	}

	private async rollbackGrant(): Promise<void> {
		this._purgeIncomplete = true;
		this.consentState = { version: 1, status: "denied" };
		await this.withdraw(this.detachRuntime());
	}

	private detachRuntime(): DetachedRuntime {
		this.epoch += 1;
		const previous = this.transport;
		this.clearTransport();
		this._anonymousId = undefined;
		this.opened = false;
		this.opening = undefined;
		return {
			previous,
			disabled:
				previous === undefined
					? Promise.resolve(true)
					: safely(async () => {
							await previous.disable();
							return true;
						}),
		};
	}

	private clearTransport(): void {
		try {
			this.readyUnsubscribe?.();
		} catch {
			// The stale callback still checks epoch/disposed before recording anything.
		}
		this.readyUnsubscribe = undefined;
		this.transport = undefined;
	}

	private async withdraw(detached: DetachedRuntime): Promise<Consent> {
		const tombstone = await this.options.consent.beginRevocation();
		let denied: Consent = { version: 1, status: "denied" };
		const denialSaved = await safely(async () => {
			denied = await this.options.consent.deny();
			return true;
		});
		const disabled = await detached.disabled;
		const transportPurged =
			detached.previous === undefined
				? true
				: await safely(() => detached.previous?.purge() ?? Promise.resolve(false));
		const durablePurged =
			this.options.purgeStorage === undefined
				? detached.previous !== undefined && transportPurged
				: await safely(() => this.options.purgeStorage?.() ?? Promise.resolve(false));
		const identityCleared = await safely(async () => {
			await this.options.consent.clearAnonymousId();
			return true;
		});
		const reset =
			detached.previous === undefined
				? true
				: await safely(async () => {
						await detached.previous?.reset();
						return true;
					});
		try {
			detached.previous?.destroy();
		} catch {
			// The transport is detached and cannot be reached by future tracking calls.
		}
		const complete =
			tombstone && denialSaved && disabled && transportPurged && durablePurged && identityCleared && reset;
		this._purgeIncomplete = !complete;
		if (complete) this._purgeIncomplete = !(await this.options.consent.completeRevocation());
		this.consentState = { ...denied, status: "denied" };
		return this.consentState;
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.transitions.then(operation, operation);
		this.transitions = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

async function safely(operation: () => Promise<boolean>): Promise<boolean> {
	try {
		return await operation();
	} catch {
		return false;
	}
}
