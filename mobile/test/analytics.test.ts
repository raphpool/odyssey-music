import { act, render, waitFor } from "@testing-library/react-native";
import { createElement, useEffect } from "react";
import { View } from "react-native";

import {
	AnalyticsClient,
	type AnalyticsPayload,
	type AnalyticsTransport,
	type ClientOptions,
} from "../src/analytics/client";
import { ConsentStore, type KeyValueStorage } from "../src/analytics/consent";
import { EVENT_NAMES, type EventName, validateEvent } from "../src/analytics/contracts";
import { AnalyticsProvider, createSegmentTransport, useAnalytics } from "../src/analytics/provider";
import { ConsentBoundPersistor, purgeSegmentStorage, type SegmentStorage } from "../src/analytics/storage";

function memoryStorage(
	values = new Map<string, string>(),
): KeyValueStorage & { values: Map<string, string> } {
	return {
		values,
		getItem: async (key) => values.get(key) ?? null,
		setItem: async (key, value) => void values.set(key, value),
		removeItem: async (key) => void values.delete(key),
	};
}

function durableStorage(
	values = new Map<string, string>(),
	failing = false,
): SegmentStorage & { values: Map<string, string> } {
	return {
		values,
		getItem: async (key) => values.get(key) ?? null,
		setItem: async (key, value) => void values.set(key, value),
		removeItem: async (key) => {
			if (failing) throw new Error("unavailable");
			values.delete(key);
		},
		getAllKeys: async () => [...values.keys()],
		multiRemove: async (keys) => {
			if (failing) throw new Error("unavailable");
			for (const key of keys) values.delete(key);
		},
	};
}

function transport(overrides: Partial<AnalyticsTransport> = {}): AnalyticsTransport {
	return {
		track: async () => true,
		disable: async () => undefined,
		purge: async () => true,
		reset: async () => undefined,
		destroy: () => undefined,
		...overrides,
	};
}

function client(options: Partial<ClientOptions> = {}) {
	const storage = memoryStorage();
	return new AnalyticsClient({
		consent: new ConsentStore(storage),
		createTransport: () => transport(),
		purgeStorage: async () => true,
		createId: () => "11111111-1111-4111-8111-111111111111",
		environment: "development",
		platform: "ios",
		appVersion: "1",
		buildNumber: "1",
		...options,
	});
}

function DenyCapture({ onDeny }: { onDeny(deny: () => Promise<void>): void }) {
	const { deny } = useAnalytics();
	useEffect(() => onDeny(deny), [deny, onDeny]);
	return createElement(View);
}

function TransportReadyCapture({ onChange }: { onChange(value: boolean | undefined): void }) {
	const { transportReady } = useAnalytics();
	useEffect(() => {
		onChange(transportReady);
	}, [onChange, transportReady]);
	return createElement(View);
}

describe("analytics runtime consent boundary", () => {
	it("does not create a client, identity, or event before consent", async () => {
		let clients = 0;
		let ids = 0;
		const analytics = client({
			createTransport: () => {
				clients += 1;
				return transport();
			},
			createId: () => {
				ids += 1;
				return "11111111-1111-4111-8111-111111111111";
			},
		});
		await analytics.initialize();
		expect(await analytics.trackEvent("app_opened", {}, { source: "app" })).toEqual({ kind: "disabled" });
		expect(clients).toBe(0);
		expect(ids).toBe(0);
	});

	it("keeps a repeated accepted choice granted without recreating or withdrawing the transport", async () => {
		let clients = 0;
		let disabled = 0;
		const analytics = client({
			createTransport: () => {
				clients += 1;
				return transport({ disable: async () => void disabled++ });
			},
		});

		await analytics.grant();
		await analytics.grant();

		expect(analytics.consent.status).toBe("granted");
		expect(analytics.configured).toBe(true);
		expect(clients).toBe(1);
		expect(disabled).toBe(0);
	});

	it("preserves the durable onboarding occurrence time instead of replacing it at replay", async () => {
		let payload: AnalyticsPayload | undefined;
		const analytics = client({
			now: () => "2026-09-27T10:10:00.000Z",
			createTransport: () =>
				transport({
					track: async (next) => {
						payload = next;
						return true;
					},
				}),
		});
		await analytics.grant();

		expect(
			await analytics.trackEvent(
				"onboarding_completed",
				{ flow_id: "11111111-1111-4111-8111-111111111111", genres_count: 3 },
				{
					source: "onboarding",
					event_id: "22222222-2222-4222-8222-222222222222",
					occurred_at: "2026-09-27T10:00:00.000Z",
				},
			),
		).toEqual({ kind: "accepted" });
		expect(payload?.properties.occurred_at).toBe("2026-09-27T10:00:00.000Z");
	});

	it("fails closed without throwing when consent or identity storage is unavailable", async () => {
		const unavailable: KeyValueStorage = {
			getItem: async () => Promise.reject(new Error("unavailable")),
			setItem: async () => Promise.reject(new Error("unavailable")),
			removeItem: async () => Promise.reject(new Error("unavailable")),
		};
		let clients = 0;
		const analytics = client({
			consent: new ConsentStore(unavailable),
			createTransport: () => {
				clients += 1;
				return transport();
			},
		});
		await expect(analytics.initialize()).resolves.toMatchObject({ status: "unknown" });
		await expect(analytics.grant()).resolves.toMatchObject({ status: "unknown" });
		expect(analytics.configured).toBe(false);
		expect(clients).toBe(0);
	});

	it("does not propagate an anonymous-id persistence failure or create Segment", async () => {
		const storage = memoryStorage();
		const originalSet = storage.setItem;
		storage.setItem = async (key, value) => {
			if (key.includes("anonymous")) throw new Error("disk full");
			await originalSet(key, value);
		};
		let clients = 0;
		const analytics = client({
			consent: new ConsentStore(storage),
			createTransport: () => {
				clients += 1;
				return transport();
			},
		});
		await expect(analytics.grant()).resolves.toMatchObject({ status: "denied" });
		expect(analytics.configured).toBe(false);
		expect(clients).toBe(0);
		expect(await new ConsentStore(storage).read()).toMatchObject({ status: "denied" });
	});

	it("does not let a delayed persisted grant overwrite a newer revoke", async () => {
		const storage = memoryStorage(
			new Map([["track1.analytics-consent.v1", '{"version":1,"status":"granted"}']]),
		);
		let releaseRead: (() => void) | undefined;
		let signalReadStarted: (() => void) | undefined;
		const readStarted = new Promise<void>((resolve) => {
			signalReadStarted = resolve;
		});
		const originalGet = storage.getItem;
		storage.getItem = async (key) => {
			if (key === "track1.analytics-consent.v1") {
				signalReadStarted?.();
				await new Promise<void>((resolve) => {
					releaseRead = resolve;
				});
			}
			return originalGet(key);
		};
		let clients = 0;
		const analytics = client({
			consent: new ConsentStore(storage),
			createTransport: () => {
				clients += 1;
				return transport();
			},
		});
		const initialize = analytics.initialize();
		await readStarted;
		const revoke = analytics.revoke();
		releaseRead?.();
		await Promise.all([initialize, revoke]);
		expect(analytics.consent.status).toBe("denied");
		expect(analytics.configured).toBe(false);
		expect(clients).toBe(0);
	});

	it("replaces a malformed durable identity before creating Segment", async () => {
		const storage = memoryStorage(new Map([["track1.analytics-anonymous-id.v1", "person@example.test"]]));
		let clients = 0;
		const analytics = client({
			consent: new ConsentStore(storage),
			createTransport: () => {
				clients += 1;
				return transport();
			},
		});
		await analytics.grant();
		expect(clients).toBe(1);
		expect(storage.values.get("track1.analytics-anonymous-id.v1")).toBe(
			"11111111-1111-4111-8111-111111111111",
		);
	});

	it("rolls back a durable grant when no transport can be activated", async () => {
		const storage = memoryStorage();
		const analytics = client({
			consent: new ConsentStore(storage),
			createTransport: () => undefined,
		});
		await expect(analytics.grant()).resolves.toMatchObject({ status: "denied" });
		expect(await new ConsentStore(storage).read()).toMatchObject({ status: "denied" });
		expect(analytics.configured).toBe(false);
	});

	it("records app_opened only once while two calls overlap", async () => {
		let releaseTrack: (() => void) | undefined;
		let tracked = 0;
		const analytics = client({
			createTransport: () =>
				transport({
					track: async () => {
						tracked += 1;
						await new Promise<void>((resolve) => {
							releaseTrack = resolve;
						});
						return true;
					},
				}),
		});
		await analytics.grant();
		const first = analytics.recordAppOpened();
		const second = analytics.recordAppOpened();
		expect(tracked).toBe(1);
		releaseTrack?.();
		await expect(Promise.all([first, second])).resolves.toEqual([{ kind: "accepted" }, { kind: "accepted" }]);
	});

	it("disposes an old controller without changing durable consent or accepting stale callbacks", async () => {
		const storage = memoryStorage();
		const calls: string[] = [];
		let ready: (() => void) | undefined;
		const analytics = client({
			consent: new ConsentStore(storage),
			createTransport: () =>
				transport({
					disable: async () => void calls.push("disable"),
					destroy: () => void calls.push("destroy"),
					onReady: (callback) => {
						ready = callback;
						return () => void calls.push("unsubscribe");
					},
				}),
		});
		await analytics.grant();
		await Promise.all([analytics.dispose(), analytics.dispose()]);
		ready?.();
		await Promise.resolve();
		expect(calls).toEqual(["unsubscribe", "disable", "destroy"]);
		expect(await new ConsentStore(storage).read()).toMatchObject({ status: "granted" });
		expect(await analytics.trackEvent("app_opened", {}, { source: "app" })).toEqual({ kind: "disabled" });
	});

	it("finishes an admitted revoke before dispose tears down its detached transport", async () => {
		const storage = memoryStorage();
		const calls: string[] = [];
		let durablePurges = 0;
		const analytics = client({
			consent: new ConsentStore(storage),
			purgeStorage: async () => {
				durablePurges += 1;
				return true;
			},
			createTransport: () =>
				transport({
					disable: async () => void calls.push("disable"),
					purge: async () => {
						calls.push("purge");
						return true;
					},
					reset: async () => void calls.push("reset"),
					destroy: () => void calls.push("destroy"),
				}),
		});
		await analytics.grant();
		const revoke = analytics.revoke();
		const dispose = analytics.dispose();
		await Promise.all([revoke, dispose]);
		expect(await new ConsentStore(storage).read()).toMatchObject({ status: "denied" });
		expect(storage.values.has("track1.analytics-anonymous-id.v1")).toBe(false);
		expect(durablePurges).toBe(1);
		expect(calls).toEqual(["disable", "purge", "reset", "destroy"]);
	});

	it("records the tombstone and denial even when transport disable, purge, and reset reject", async () => {
		const storage = memoryStorage();
		const analytics = client({
			consent: new ConsentStore(storage),
			createTransport: () =>
				transport({
					disable: async () => Promise.reject(new Error("disable")),
					purge: async () => Promise.reject(new Error("purge")),
					reset: async () => Promise.reject(new Error("reset")),
				}),
		});
		await analytics.grant();
		await expect(analytics.revoke()).resolves.toMatchObject({ status: "denied" });
		expect(analytics.purgeIncomplete).toBe(true);
		expect(await new ConsentStore(storage).read()).toMatchObject({ status: "denied" });
		expect(await new ConsentStore(storage).revocationPending()).toBe(true);
	});

	it("purges the durable namespace on first refusal without a write key or client", async () => {
		const namespace = durableStorage(
			new Map([
				["track1.analytics-segment.v1.old-events", "queued"],
				["other-app-setting", "survives"],
			]),
		);
		let clients = 0;
		const analytics = client({
			createTransport: () => {
				clients += 1;
				return transport();
			},
			purgeStorage: () => purgeSegmentStorage(namespace),
		});
		await analytics.revoke();
		expect(namespace.values).toEqual(new Map([["other-app-setting", "survives"]]));
		expect(clients).toBe(0);
		expect(analytics.purgeIncomplete).toBe(false);
	});

	it("keeps the tombstone after a failed restart purge and retries without creating Segment", async () => {
		const consentStorage = memoryStorage(new Map([["track1.analytics-revocation.v1", "pending"]]));
		const namespace = durableStorage(new Map([["track1.analytics-segment.v1.old-events", "queued"]]), true);
		let clients = 0;
		const analytics = client({
			consent: new ConsentStore(consentStorage),
			createTransport: () => {
				clients += 1;
				return transport();
			},
			purgeStorage: () => purgeSegmentStorage(namespace),
		});
		await analytics.initialize();
		await analytics.revoke();
		await analytics.grant();
		expect(analytics.consent.status).toBe("denied");
		expect(analytics.purgeIncomplete).toBe(true);
		expect(clients).toBe(0);
	});

	it("makes a concurrent revoke the last intent and never recreates the transport", async () => {
		const storage = memoryStorage();
		let releaseGrant: (() => void) | undefined;
		const originalSet = storage.setItem;
		storage.setItem = async (key, value) => {
			if (value.includes("granted"))
				await new Promise<void>((resolve) => {
					releaseGrant = resolve;
				});
			await originalSet(key, value);
		};
		let clients = 0;
		const analytics = client({
			consent: new ConsentStore(storage),
			createTransport: () => {
				clients += 1;
				return transport();
			},
		});
		const grant = analytics.grant();
		await Promise.resolve();
		const revoke = analytics.revoke();
		releaseGrant?.();
		await Promise.all([grant, revoke]);
		expect(analytics.consent.status).toBe("denied");
		expect(analytics.configured).toBe(false);
		expect(clients).toBe(0);
	});
});

describe("analytics contract and persistence", () => {
	it("locks the 17-event public contract and rejects properties outside each schema", () => {
		const eventProperties: ReadonlyArray<readonly [EventName, Record<string, string | number>]> = [
			["app_opened", {}],
			["onboarding_started", { flow_id: "11111111-1111-4111-8111-111111111111" }],
			["onboarding_completed", { flow_id: "11111111-1111-4111-8111-111111111111", genres_count: 3 }],
			["preferences_updated", { genres_count: 3, action: "updated" }],
			[
				"daily_recommendation_viewed",
				{ recommendation_id: "daily-1", local_date: "2026-09-27", node_id: "artist:a", node_type: "artist" },
			],
			[
				"daily_recommendation_opened",
				{ recommendation_id: "daily-1", local_date: "2026-09-27", node_id: "artist:a", node_type: "artist" },
			],
			["notification_permission_result", { status: "granted" }],
			["notification_opened", { notification_id: "notification-1", target_local_date: "2026-09-27" }],
			["node_viewed", { node_id: "artist:a", node_type: "artist" }],
			[
				"relation_opened",
				{ from_node_id: "artist:a", node_id: "artist:b", node_type: "artist", relation_kind: "influenced" },
			],
			["search_submitted", { filter: "all" }],
			["search_result_opened", { node_type: "artist", availability: "cached", results_count: 1 }],
			["generation_requested", { request_id: "11111111-1111-4111-8111-111111111111", node_type: "artist" }],
			[
				"generation_completed",
				{ request_id: "11111111-1111-4111-8111-111111111111", node_id: "artist:a", node_type: "artist" },
			],
			[
				"generation_failed",
				{ request_id: "11111111-1111-4111-8111-111111111111", node_type: "artist", error_code: "failed" },
			],
			[
				"external_listening_opened",
				{ node_id: "artist:a", node_type: "artist", provider: "spotify", link_kind: "exact" },
			],
			[
				"external_listening_failed",
				{
					node_id: "artist:a",
					node_type: "artist",
					provider: "spotify",
					link_kind: "exact",
					error_code: "open_failed",
				},
			],
		];

		expect(EVENT_NAMES).toEqual(eventProperties.map(([name]) => name));
		for (const [name, properties] of eventProperties) {
			expect(validateEvent(name, properties, { source: "app" })).toMatchObject({ ok: true, name });
			expect(validateEvent(name, { ...properties, unexpected: "value" }, { source: "app" })).toEqual({
				ok: false,
			});
		}
		expect(validateEvent("unlisted_event", {}, { source: "app" })).toEqual({ ok: false });
	});

	it("persists the stable event id as Segment's messageId before its queue", async () => {
		const storage = durableStorage();
		let persistor: { set<T>(key: string, state: T): Promise<void> } | undefined;
		let plugin:
			| { track(event: { properties?: Record<string, unknown>; messageId?: string }): { messageId?: string } }
			| undefined;
		class EventPlugin {
			type = "before" as const;
			track(event: { properties?: Record<string, unknown>; messageId?: string }) {
				return event;
			}
		}
		const runtime = {
			track: async (
				_name: string,
				properties: Record<string, string | number>,
				enrich: (event: { properties?: Record<string, unknown>; messageId?: string }) => unknown,
			) => {
				const queued = plugin?.track({ properties });
				await persistor?.set("events", { queued });
				enrich(queued ?? { properties });
			},
			enabled: { set: async () => undefined },
			running: { set: async () => undefined },
			isReady: { value: true, onChange: () => () => undefined },
			add: (input: { plugin: typeof plugin }) => {
				plugin = input.plugin;
			},
			clear: () => undefined,
			reset: async () => undefined,
			cleanup: () => undefined,
		};
		const segment = createSegmentTransport(
			"public-key",
			{
				createClient: (config) => {
					persistor = config.storePersistor;
					return runtime;
				},
				EventPlugin,
				PluginType: { before: "before" },
			},
			storage,
		);
		const payload: AnalyticsPayload = {
			name: "app_opened",
			properties: {
				event_id: "22222222-2222-4222-8222-222222222222",
				schema_version: 1,
				platform: "ios",
				app_version: "1",
				build_number: "1",
				environment: "development",
				source: "app",
				occurred_at: "2026-01-01T00:00:00.000Z",
				anonymousId: "11111111-1111-4111-8111-111111111111",
			},
			context: { source: "app" },
		};
		await segment.track(payload);
		expect(storage.values.get("track1.analytics-segment.v1.events")).toContain(
			'"messageId":"22222222-2222-4222-8222-222222222222"',
		);
	});

	it("rejects inherited keys and Map-like inputs instead of accepting their prototype", () => {
		const inherited = Object.create({ node_id: "node", node_type: "artist" }) as Record<string, unknown>;
		expect(validateEvent("node_viewed", inherited, { source: "home" })).toEqual({ ok: false });
		expect(validateEvent("node_viewed", new Map([["node_id", "node"]]), { source: "home" })).toEqual({
			ok: false,
		});
		expect(
			validateEvent(
				"node_viewed",
				{ node_id: "node", node_type: "artist" },
				Object.create({ source: "home" }),
			),
		).toEqual({ ok: false });
	});

	it("blocks a late persist then removes every namespaced SDK key", async () => {
		const storage = durableStorage(
			new Map([
				["track1.analytics-segment.v1.events", "old"],
				["track1.analytics-segment.v1.identity", "old"],
				["other", "keep"],
			]),
		);
		const persistor = new ConsentBoundPersistor(storage);
		expect(await persistor.purge()).toBe(true);
		await persistor.set("events", { event: "must-not-return" });
		expect(storage.values).toEqual(new Map([["other", "keep"]]));
	});
});

describe("analytics provider lifecycle", () => {
	it("publishes the native Segment-ready transition to consumers", async () => {
		mockAsyncValues.clear();
		mockSegmentRuntimes.splice(0);
		mockAsyncValues.set("track1.analytics-consent.v1", '{"version":1,"status":"granted"}');
		mockAsyncValues.set("track1.analytics-anonymous-id.v1", "11111111-1111-4111-8111-111111111111");
		const values: Array<boolean | undefined> = [];
		render(
			createElement(
				AnalyticsProvider,
				{ environment: "development", writeKey: "first" },
				createElement(TransportReadyCapture, { onChange: (value) => values.push(value) }),
			),
		);
		await waitFor(() => expect(mockSegmentRuntimes).toHaveLength(1));
		expect(values).toContain(false);
		await act(async () => mockSegmentRuntimes[0]?.ready?.());
		await waitFor(() => expect(values).toContain(true));
	});

	it("makes the previous write-key runtime inert after remount", async () => {
		mockAsyncValues.clear();
		mockSegmentRuntimes.splice(0);
		mockAsyncValues.set("track1.analytics-consent.v1", '{"version":1,"status":"granted"}');
		mockAsyncValues.set("track1.analytics-anonymous-id.v1", "11111111-1111-4111-8111-111111111111");
		const view = render(
			createElement(
				AnalyticsProvider,
				{ environment: "development", writeKey: "first" },
				createElement(View),
			),
		);
		await waitFor(() => expect(mockSegmentRuntimes).toHaveLength(1));
		const previous = mockSegmentRuntimes[0];
		view.rerender(
			createElement(
				AnalyticsProvider,
				{ environment: "development", writeKey: "second" },
				createElement(View),
			),
		);
		await waitFor(() => expect(mockSegmentRuntimes).toHaveLength(2));
		await waitFor(() => expect(previous?.disabled).toBe(1));
		previous?.ready?.();
		await Promise.resolve();
		expect(previous?.tracks).toBe(0);
		expect(previous?.cleaned).toBe(1);
	});

	it("ignores a stale deny callback after a write-key swap", async () => {
		mockAsyncValues.clear();
		mockSegmentRuntimes.splice(0);
		mockPurgeCalls = 0;
		mockAsyncValues.set("track1.analytics-consent.v1", '{"version":1,"status":"granted"}');
		mockAsyncValues.set("track1.analytics-anonymous-id.v1", "11111111-1111-4111-8111-111111111111");
		mockAsyncValues.set("track1.analytics-segment.v1.first-events", "old-queue");
		let oldDeny: (() => Promise<void>) | undefined;
		const capture = (deny: () => Promise<void>) => {
			oldDeny ??= deny;
		};
		const view = render(
			createElement(
				AnalyticsProvider,
				{ environment: "development", writeKey: "first" },
				createElement(DenyCapture, { onDeny: capture }),
			),
		);
		await waitFor(() => expect(oldDeny).toBeDefined());
		await waitFor(() => expect(mockSegmentRuntimes).toHaveLength(1));
		view.rerender(
			createElement(
				AnalyticsProvider,
				{ environment: "development", writeKey: "second" },
				createElement(DenyCapture, { onDeny: capture }),
			),
		);
		await waitFor(() => expect(mockSegmentRuntimes).toHaveLength(2));
		await act(async () => {
			await oldDeny?.();
		});
		expect(mockAsyncValues.get("track1.analytics-consent.v1")).toContain('"granted"');
		expect(mockAsyncValues.get("track1.analytics-segment.v1.first-events")).toBe("old-queue");
		expect(mockPurgeCalls).toBe(0);
		expect(mockSegmentRuntimes[1]?.disabled).toBe(0);
		expect(mockSegmentRuntimes[1]?.cleaned).toBe(0);
	});
});
const mockAsyncValues = new Map<string, string>();
let mockPurgeCalls = 0;
const mockAsyncStorage = {
	getItem: async (key: string) => mockAsyncValues.get(key) ?? null,
	setItem: async (key: string, value: string) => void mockAsyncValues.set(key, value),
	removeItem: async (key: string) => void mockAsyncValues.delete(key),
	getAllKeys: async () => [...mockAsyncValues.keys()],
	multiRemove: async (keys: string[]) => {
		mockPurgeCalls += 1;
		for (const key of keys) mockAsyncValues.delete(key);
	},
};
const mockSegmentRuntimes: Array<{
	ready: (() => void) | undefined;
	tracks: number;
	disabled: number;
	cleaned: number;
}> = [];

jest.mock("@react-native-async-storage/async-storage", () => ({ default: mockAsyncStorage }));
jest.mock("@segment/analytics-react-native", () => {
	class EventPlugin {
		type = "before" as const;
		track(event: { properties?: Record<string, unknown> }) {
			return event;
		}
	}
	return {
		EventPlugin,
		PluginType: { before: "before" },
		createClient: () => {
			const runtime = {
				ready: undefined as (() => void) | undefined,
				tracks: 0,
				disabled: 0,
				cleaned: 0,
				track: async () => {
					runtime.tracks += 1;
				},
				enabled: {
					set: async () => {
						runtime.disabled += 1;
					},
				},
				running: { set: async () => undefined },
				isReady: {
					value: false,
					onChange: (callback: (ready: boolean) => void) => {
						runtime.ready = () => callback(true);
						return () => undefined;
					},
				},
				add: () => undefined,
				clear: () => undefined,
				reset: async () => undefined,
				cleanup: () => {
					runtime.cleaned += 1;
				},
			};
			mockSegmentRuntimes.push(runtime);
			return runtime;
		},
	};
});
