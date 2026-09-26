import Constants from "expo-constants";
import { type PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
import "react-native-get-random-values";

import { AnalyticsClient, type AnalyticsPayload, type AnalyticsTransport, type TrackResult } from "./client";
import { type AnalyticsSource, type EventContext } from "./contracts";
import { ConsentStore, type Consent, type ConsentStatus } from "./consent";

type ProviderValue = { ready: boolean; consent: Consent; configured: boolean; purgeIncomplete: boolean; grant(): Promise<void>; deny(): Promise<void>; trackEvent(name: unknown, properties: unknown, context: EventContext): Promise<TrackResult> };
const AnalyticsContext = createContext<ProviderValue>({ ready: true, consent: { version: 1, status: "unknown" }, configured: false, purgeIncomplete: false, grant: async () => undefined, deny: async () => undefined, trackEvent: async () => ({ kind: "disabled" }) });

type SegmentRuntime = {
	track(name: string, properties: Record<string, string | number>, enrich: (event: { messageId?: string; anonymousId?: string; timestamp?: string; context?: Record<string, unknown> }) => { messageId?: string; anonymousId?: string; timestamp?: string; context?: Record<string, unknown> }): Promise<void>;
	enabled: { set(value: boolean): Promise<void> };
	running: { set(value: boolean): Promise<void> };
	isReady: { value: boolean; onChange(callback: (value: boolean) => void): () => void };
	add(input: { plugin: SegmentEventPlugin }): void;
	clear(): void;
	reset(resetAnonymousId: boolean): Promise<void>;
	cleanup(): void;
};

type SegmentTrackEvent = {
	properties?: Record<string, unknown>;
	messageId?: string;
	anonymousId?: string;
	timestamp?: string;
	context?: Record<string, unknown>;
};
type SegmentEventPlugin = { type: "before"; track(event: SegmentTrackEvent): SegmentTrackEvent };
type SegmentPackage = {
	createClient(config: Record<string, unknown>): SegmentRuntime;
	EventPlugin: new () => SegmentEventPlugin;
	PluginType: { before: "before" };
};
type SegmentStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
	getAllKeys(): Promise<string[]>;
	multiRemove(keys: string[]): Promise<void>;
};
type SegmentPersistor = {
	get<T>(key: string): Promise<T | undefined>;
	set<T>(key: string, state: T): Promise<void>;
};

function unavailableSegmentStorage(): SegmentStorage {
	const unavailable = async (): Promise<never> => Promise.reject(new Error("Segment storage unavailable"));
	return {
		getItem: unavailable,
		setItem: unavailable,
		removeItem: unavailable,
		getAllKeys: unavailable,
		multiRemove: unavailable,
	};
}

function segmentStorage(): SegmentStorage {
	try {
		return require("@react-native-async-storage/async-storage").default as SegmentStorage;
	} catch {
		return unavailableSegmentStorage();
	}
}

/**
 * Segment's Persistor API intentionally exposes only get/set. Keeping this wrapper lets withdrawal
 * synchronously close that gate, then remove every SDK key even when a flush was already queued.
 */
export class ConsentBoundPersistor implements SegmentPersistor {
	private enabled = true;
	private generation = 0;
	private readonly keys = new Set<string>();
	constructor(private readonly storage: SegmentStorage) {}
	block(): void {
		this.enabled = false;
		this.generation += 1;
	}
	async get<T>(key: string): Promise<T | undefined> {
		const storageKey = segmentStorageKey(key);
		this.keys.add(storageKey);
		if (!this.enabled) return undefined;
		const generation = this.generation;
		try {
			const raw = await this.storage.getItem(storageKey);
			if (!this.enabled || generation !== this.generation || raw === null) return undefined;
			return JSON.parse(raw) as T;
		} catch {
			return undefined;
		}
	}
	async set<T>(key: string, state: T): Promise<void> {
		const storageKey = segmentStorageKey(key);
		this.keys.add(storageKey);
		if (!this.enabled) return;
		const generation = this.generation;
		try {
			await this.storage.setItem(storageKey, JSON.stringify(state));
			if (!this.enabled || generation !== this.generation) await this.storage.removeItem(storageKey);
		} catch {
			// Analytics persistence must never make an opted-in app unusable.
		}
	}
	async purge(): Promise<boolean> {
		this.block();
		return purgeSegmentStorage(this.storage, this.keys);
	}
}

// Segment only sees namespaced keys through this persistor. It makes withdrawal recovery exact
// even after a build loses its public write key, and never risks deleting another SDK's settings.
const SEGMENT_STORAGE_PREFIX = "track1.analytics-segment.v1.";

function segmentStorageKey(key: string): string {
	return `${SEGMENT_STORAGE_PREFIX}${key}`;
}

export async function purgeSegmentStorage(
	storage: SegmentStorage = segmentStorage(),
	knownKeys: ReadonlySet<string> = new Set(),
): Promise<boolean> {
	let discovered: string[];
	try {
		discovered = await storage.getAllKeys();
	} catch {
		return false;
	}
	const keys = new Set([
		...knownKeys,
		...discovered.filter((key) => key.startsWith(SEGMENT_STORAGE_PREFIX)),
	]);
	try {
		if (keys.size > 0) await storage.multiRemove([...keys]);
		return true;
	} catch {
		const results = await Promise.all(
			[...keys].map(async (key) => {
				try {
					await storage.removeItem(key);
					return true;
				} catch {
					return false;
				}
			}),
		);
		return results.every(Boolean);
	}
}

function messageIdPlugin(segmentPackage: SegmentPackage): SegmentEventPlugin {
	const EventPlugin = segmentPackage.EventPlugin;
	const PluginType = segmentPackage.PluginType;
	class StableMessageIdPlugin extends EventPlugin {
		type = PluginType.before;
		track(event: SegmentTrackEvent): SegmentTrackEvent {
			const eventId = event.properties?.event_id;
			return typeof eventId === "string" ? { ...event, messageId: eventId } : event;
		}
	}
	return new StableMessageIdPlugin();
}

export function createSegmentTransport(writeKey: string, packageOverride?: SegmentPackage, storageOverride?: SegmentStorage): AnalyticsTransport {
	// Segment is loaded only after consent. It keeps the module (and its native bridge) absent from
	// unknown/denied sessions, and lets Jest exercise the product without a native Segment binary.
	const segmentPackage = packageOverride ?? (require("@segment/analytics-react-native") as SegmentPackage);
	const persistor = new ConsentBoundPersistor(storageOverride ?? segmentStorage());
	const segment = segmentPackage.createClient({
		writeKey,
		trackAppLifecycleEvents: false,
		trackDeepLinks: false,
		collectDeviceId: false,
		debug: false,
		storePersistor: persistor,
	});
	segment.add({ plugin: messageIdPlugin(segmentPackage) });
	return {
		track: async (payload: AnalyticsPayload) => {
			// Do not let the SDK persist its pre-timeline event: its enrichment callback is not serializable.
			if (!segment.isReady.value) return false;
			await segment.track(payload.name, payload.properties, (event) => ({ ...event, messageId: payload.properties.event_id, anonymousId: payload.properties.anonymousId, timestamp: payload.properties.occurred_at, context: { ...event.context, track1: payload.context } }));
			return true;
		},
		disable: async () => {
			persistor.block();
			await segment.enabled.set(false);
			await segment.running.set(false);
		},
		purge: async () => {
			segment.clear();
			return persistor.purge();
		},
		reset: async () => { await segment.reset(false); },
		destroy: () => segment.cleanup(),
		onReady: (callback) => segment.isReady.onChange((ready) => {
			if (ready) callback();
		}),
	};
}

function platform(): "ios" | "android" { return Platform.OS === "android" ? "android" : "ios"; }
function randomUuid(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function AnalyticsProvider({ children, environment, writeKey }: PropsWithChildren<{ environment: "development" | "preview" | "production"; writeKey?: string }>) {
	const controller = useMemo(() => new AnalyticsClient({
		consent: new ConsentStore(),
		createTransport: () => writeKey === undefined ? undefined : createSegmentTransport(writeKey),
		purgeStorage: () => purgeSegmentStorage(),
		createId: randomUuid, environment, platform: platform(), appVersion: Constants.expoConfig?.version ?? "unknown",
		buildNumber: Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode?.toString() ?? "unknown",
	}), [environment, writeKey]);
	const [consent, setConsent] = useState<Consent>({ version: 1, status: "unknown" });
	const [ready, setReady] = useState(false);
	useEffect(() => {
		let mounted = true;
		void controller
			.initialize()
			.then((next) => {
				void controller.recordAppOpened("app");
				if (mounted) setConsent(next);
			})
			.finally(() => {
				if (mounted) setReady(true);
			});
		const subscription = AppState.addEventListener("change", (next) => { if (next === "active" || next === "background" || next === "inactive") void controller.onAppState(next); });
		return () => { mounted = false; subscription.remove(); };
	}, [controller]);
	const value = useMemo<ProviderValue>(() => ({
		ready, consent, configured: controller.configured, purgeIncomplete: controller.purgeIncomplete,
		grant: async () => {
			const next = await controller.grant();
			void controller.recordAppOpened("app");
			setConsent(next);
		},
		deny: async () => { const next = await controller.revoke(); setConsent(next); },
		trackEvent: (name, properties, context) => controller.trackEvent(name, properties, context),
	}), [consent, controller, ready]);
	return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalytics(): ProviderValue {
	return useContext(AnalyticsContext);
}

export const analyticsStatusLabel = (status: ConsentStatus): string => status === "granted" ? "Activée" : status === "denied" ? "Refusée" : "À choisir";
