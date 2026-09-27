import Constants from "expo-constants";
import { type PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
import "react-native-get-random-values";

import { AnalyticsClient, type AnalyticsPayload, type AnalyticsTransport, type TrackResult } from "./client";
import { type EventContext, type AnalyticsSource } from "./contracts";
import { ConsentStore, type Consent, type ConsentStatus } from "./consent";
import { ConsentBoundPersistor, type SegmentPersistor, type SegmentStorage, purgeSegmentStorage, segmentStorage } from "./storage";

type ProviderValue = {
	ready: boolean;
	consent: Consent;
	configured: boolean;
	transportReady?: boolean;
	purgeIncomplete: boolean;
	grant(): Promise<void>;
	deny(): Promise<void>;
	trackEvent(name: unknown, properties: unknown, context: EventContext): Promise<TrackResult>;
};
const AnalyticsContext = createContext<ProviderValue>({
	ready: true,
	consent: { version: 1, status: "unknown" },
	configured: false,
	purgeIncomplete: false,
	grant: async () => undefined,
	deny: async () => undefined,
	trackEvent: async () => ({ kind: "disabled" }),
});

type SegmentEvent = {
	properties?: Record<string, unknown>;
	messageId?: string;
	anonymousId?: string;
	timestamp?: string;
	context?: Record<string, unknown>;
};
type SegmentEventPlugin = { type: "before"; track(event: SegmentEvent): SegmentEvent };
type SegmentRuntime = {
	track(name: string, properties: Record<string, string | number>, enrich: (event: SegmentEvent) => SegmentEvent): Promise<void>;
	enabled: { set(value: boolean): Promise<void> };
	running: { set(value: boolean): Promise<void> };
	isReady: { value: boolean; onChange(callback: (value: boolean) => void): () => void };
	add(input: { plugin: SegmentEventPlugin }): void;
	clear(): void;
	reset(resetAnonymousId: boolean): Promise<void>;
	cleanup(): void;
};
type SegmentPackage = {
	createClient(config: { writeKey: string; trackAppLifecycleEvents: false; trackDeepLinks: false; collectDeviceId: false; debug: false; storePersistor: SegmentPersistor }): SegmentRuntime;
	EventPlugin: new () => SegmentEventPlugin;
	PluginType: { before: "before" };
};

function messageIdPlugin(segmentPackage: SegmentPackage): SegmentEventPlugin {
	const EventPlugin = segmentPackage.EventPlugin;
	class StableMessageIdPlugin extends EventPlugin {
		type = segmentPackage.PluginType.before;
		track(event: SegmentEvent): SegmentEvent {
			const eventId = event.properties?.event_id;
			return typeof eventId === "string" ? { ...event, messageId: eventId } : event;
		}
	}
	return new StableMessageIdPlugin();
}

export function createSegmentTransport(
	writeKey: string,
	packageOverride?: SegmentPackage,
	storageOverride?: SegmentStorage,
): AnalyticsTransport {
	// Segment is loaded only after consent, keeping its native bridge and network client out of denied sessions.
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
			if (!segment.isReady.value) return false;
			await segment.track(payload.name, payload.properties, (event) => ({
				...event,
				messageId: payload.properties.event_id,
				anonymousId: payload.properties.anonymousId,
				timestamp: payload.properties.occurred_at,
				context: { ...event.context, track1: payload.context },
			}));
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
		reset: async () => segment.reset(false),
		destroy: () => segment.cleanup(),
		onReady: (callback) => {
			if (segment.isReady.value) callback();
			return segment.isReady.onChange((ready) => {
				if (ready) callback();
			});
		},
	};
}

function platform(): "ios" | "android" {
	return Platform.OS === "android" ? "android" : "ios";
}

function randomUuid(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function AnalyticsProvider({
	children,
	environment,
	writeKey,
}: PropsWithChildren<{ environment: "development" | "preview" | "production"; writeKey?: string }>) {
	const controller = useMemo(
		() =>
			new AnalyticsClient({
				consent: new ConsentStore(),
				createTransport: () => (writeKey === undefined ? undefined : createSegmentTransport(writeKey)),
				purgeStorage: () => purgeSegmentStorage(),
				createId: randomUuid,
				environment,
				platform: platform(),
				appVersion: Constants.expoConfig?.version ?? "unknown",
				buildNumber:
					Constants.expoConfig?.ios?.buildNumber ??
					Constants.expoConfig?.android?.versionCode?.toString() ??
					"unknown",
			}),
		[environment, writeKey],
	);
	const [consent, setConsent] = useState<Consent>({ version: 1, status: "unknown" });
	const [ready, setReady] = useState(false);
	const [transportReady, setTransportReady] = useState(false);

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
		const subscription = AppState.addEventListener("change", (next) => {
			if (next === "active" || next === "background" || next === "inactive") void controller.onAppState(next);
		});
		return () => {
			mounted = false;
			subscription.remove();
			void controller.dispose();
		};
	}, [controller]);

	useEffect(() => {
		setTransportReady(false);
		return controller.subscribeTransportReady(() => setTransportReady(true));
	}, [controller]);

	const value = useMemo<ProviderValue>(
		() => ({
			ready,
			consent,
			configured: controller.configured,
			transportReady,
			purgeIncomplete: controller.purgeIncomplete,
			grant: async () => {
				const next = await controller.grant();
				void controller.recordAppOpened("app");
				setConsent(next);
			},
			deny: async () => {
				setTransportReady(false);
				setConsent(await controller.revoke());
			},
			trackEvent: (name, properties, context) => controller.trackEvent(name, properties, context),
		}),
		[consent, controller, ready, transportReady],
	);
	return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalytics(): ProviderValue {
	return useContext(AnalyticsContext);
}

export function analyticsStatusLabel(status: ConsentStatus): string {
	return status === "granted" ? "Activée" : status === "denied" ? "Refusée" : "À choisir";
}

export type { AnalyticsSource };
