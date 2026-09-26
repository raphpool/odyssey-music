import type { Consent, ConsentStore } from "./consent";
import {
	type AnalyticsSource,
	type EventContext,
	type EventName,
	type EventProperties,
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
type ClientOptions = {
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

export class AnalyticsClient {
	private consentState: Consent = { version: 1, status: "unknown" };
	private transport: AnalyticsTransport | undefined;
	private epoch = 0;
	private opened = false;
	private appState: "active" | "background" | "inactive" = "active";
	private _anonymousId: string | undefined;
	private retiredTransport: AnalyticsTransport | undefined;
	private _purgeIncomplete = false;
	private intent = 0;
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
		this.consentState = await this.options.consent.read();
		this._purgeIncomplete = await this.options.consent.revocationPending();
		if (this.consentState.status === "granted" && !this._purgeIncomplete) await this.activate();
		return this.consentState;
	}
	async grant(): Promise<Consent> {
		const intent = ++this.intent;
		const epoch = this.epoch;
		return this.serialize(async () => {
			// Re-check inside the serialized transition: revoke() can set its tombstone after a
			// tap has queued grant(), and no transport may be recreated until that purge succeeds.
			if (this._purgeIncomplete || intent !== this.intent || epoch !== this.epoch) return this.consentState;
			let granted: Consent;
			try {
				granted = await this.options.consent.grant();
			} catch {
				return this.consentState;
			}
			if (this._purgeIncomplete || intent !== this.intent || epoch !== this.epoch) return this.consentState;
			this.consentState = granted;
			await this.activate(epoch, intent);
			return this.consentState;
		});
	}
	async revoke(): Promise<Consent> {
		const intent = ++this.intent;
		this.epoch += 1;
		const initial = this.transport ?? this.retiredTransport;
		this.transport = undefined;
		this._anonymousId = undefined;
		this.opened = false;
		// Invoke disable before any awaited storage operation so a concurrent flush cannot start.
		const disabled = initial?.disable();
		return this.serialize(async () => {
			await disabled;
			const previous = initial;
			const revocationMarked = await this.options.consent.beginRevocation();
			this._purgeIncomplete = !revocationMarked;
			let durableStoragePurged = previous !== undefined;
			if (previous === undefined) {
				// A first refusal can find a queue written by an interrupted process without a live transport.
				// Clear that namespace directly rather than recreating Segment, which would create an id and network activity.
				try {
					durableStoragePurged = (await this.options.purgeStorage?.()) === true;
				} catch {
					durableStoragePurged = false;
				}
				if (!durableStoragePurged) this._purgeIncomplete = true;
			}
			let denied: Consent = { version: 1, status: "denied" };
			try {
				denied = await this.options.consent.deny();
			} catch {
				// A local write failure cannot restore consent in memory after withdrawal.
				this._purgeIncomplete = true;
			}
			let identityCleared = true;
			try {
				await this.options.consent.clearAnonymousId();
			} catch {
				identityCleared = false;
				this._purgeIncomplete = true;
			}
			if (previous !== undefined) {
				const purged = await previous.purge();
				if (purged && identityCleared && revocationMarked && !this._purgeIncomplete) {
					await previous.reset();
					previous.destroy();
					const revocationCompleted = await this.options.consent.completeRevocation();
					if (revocationCompleted) {
						this.retiredTransport = undefined;
						this._purgeIncomplete = false;
					} else {
						this.retiredTransport = previous;
						this._purgeIncomplete = true;
					}
				} else {
					this.retiredTransport = previous;
					this._purgeIncomplete = true;
				}
			}
			if (
				previous === undefined &&
				durableStoragePurged &&
				identityCleared &&
				revocationMarked &&
				!this._purgeIncomplete
			) {
				this._purgeIncomplete = !(await this.options.consent.completeRevocation());
			}
			// A newer grant can win only after revocation is complete. If purge failed, keep the
			// in-memory state denied so queued grant() observes the tombstone rather than reviving it.
			if (intent === this.intent || this._purgeIncomplete) this.consentState = denied;
			return this.consentState;
		});
	}
	async recordAppOpened(source: AnalyticsSource = "app"): Promise<TrackResult> {
		if (this.opened) return { kind: "disabled" };
		const result = await this.trackEvent("app_opened", {}, { source });
		if (result.kind === "accepted") this.opened = true;
		return result;
	}
	async onAppState(next: "active" | "background" | "inactive"): Promise<TrackResult | undefined> {
		const previous = this.appState;
		this.appState = next;
		return next === "active" && previous === "background"
			? this.trackEvent("app_opened", {}, { source: "app" })
			: undefined;
	}
	async trackEvent(name: unknown, properties: unknown, context: unknown): Promise<TrackResult> {
		const validated = validateEvent(name, properties, context);
		if (!validated.ok) return { kind: "invalid" };
		const transport = this.transport;
		const anonymousId = this._anonymousId;
		const epoch = this.epoch;
		if (this.consentState.status !== "granted" || transport === undefined || anonymousId === undefined)
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
		try {
			const accepted = await transport.track(payload);
			if (!accepted) return { kind: "disabled" };
		} catch {
			return this.epoch === epoch ? { kind: "disabled" } : { kind: "disabled" };
		}
		return this.epoch === epoch && this.transport === transport ? { kind: "accepted" } : { kind: "disabled" };
	}
	private async activate(expectedEpoch = this.epoch, expectedIntent = this.intent): Promise<void> {
		if (this.consentState.status !== "granted" || this.transport !== undefined) return;
		const existing = await this.options.consent.anonymousId();
		if (
			this._purgeIncomplete ||
			expectedEpoch !== this.epoch ||
			expectedIntent !== this.intent ||
			this.consentState.status !== "granted"
		)
			return;
		this._anonymousId = existing ?? this.options.createId();
		if (existing === null) await this.options.consent.saveAnonymousId(this._anonymousId);
		if (this._purgeIncomplete || expectedEpoch !== this.epoch || expectedIntent !== this.intent) return;
		this.transport = this.options.createTransport();
		this.transport?.onReady?.(() => {
			void this.recordAppOpened("app");
		});
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
