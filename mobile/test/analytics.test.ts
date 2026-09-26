jest.mock("@react-native-async-storage/async-storage", () => ({
	getItem: jest.fn(),
	setItem: jest.fn(),
	removeItem: jest.fn(),
}));

import { AnalyticsClient, type AnalyticsPayload, type AnalyticsTransport } from "../src/analytics/client";
import { ConsentStore, type KeyValueStorage } from "../src/analytics/consent";
import { validateEvent } from "../src/analytics/contracts";
import {
	ConsentBoundPersistor,
	createSegmentTransport,
	purgeSegmentStorage,
} from "../src/analytics/provider";

const storage = (): KeyValueStorage & { values: Map<string, string> } => {
	const values = new Map<string, string>();
	return {
		values,
		getItem: async (key) => values.get(key) ?? null,
		setItem: async (key, value) => void values.set(key, value),
		removeItem: async (key) => void values.delete(key),
	};
};

const segmentStorage = (values = new Map<string, string>(), removeFails = false) => ({
	values,
	getItem: async (key: string) => values.get(key) ?? null,
	setItem: async (key: string, value: string) => void values.set(key, value),
	removeItem: async (key: string) => {
		if (removeFails) throw new Error("storage unavailable");
		values.delete(key);
	},
	getAllKeys: async () => [...values.keys()],
	multiRemove: async (keys: string[]) => {
		if (removeFails) throw new Error("storage unavailable");
		for (const key of keys) values.delete(key);
	},
});

const examples = {
	app_opened: {},
	onboarding_started: { flow_id: "11111111-1111-4111-8111-111111111111" },
	onboarding_completed: { flow_id: "11111111-1111-4111-8111-111111111111", genres_count: 2 },
	preferences_updated: { genres_count: 2, action: "updated" },
	daily_recommendation_viewed: {
		recommendation_id: "r",
		local_date: "2026-01-01",
		node_id: "n",
		node_type: "artist",
	},
	daily_recommendation_opened: {
		recommendation_id: "r",
		local_date: "2026-01-01",
		node_id: "n",
		node_type: "artist",
	},
	notification_permission_result: { status: "granted" },
	notification_opened: { notification_id: "n", target_local_date: "2026-01-01" },
	node_viewed: { node_id: "n", node_type: "artist" },
	relation_opened: { from_node_id: "from", node_id: "n", node_type: "artist", relation_kind: "member" },
	search_submitted: { filter: "all" },
	search_result_opened: { node_type: "artist", availability: "cached", results_count: 1 },
	generation_requested: { request_id: "11111111-1111-4111-8111-111111111111", node_type: "artist" },
	generation_completed: {
		request_id: "11111111-1111-4111-8111-111111111111",
		node_id: "n",
		node_type: "artist",
	},
	generation_failed: {
		request_id: "11111111-1111-4111-8111-111111111111",
		node_type: "artist",
		error_code: "failed",
	},
	external_listening_opened: { node_id: "n", node_type: "artist", provider: "spotify", link_kind: "exact" },
	external_listening_failed: {
		node_id: "n",
		node_type: "artist",
		provider: "spotify",
		link_kind: "exact",
		error_code: "unsafe_url",
	},
} as const;

describe("analytics contracts", () => {
	it.each(Object.entries(examples))("accepts %s", (name, properties) => {
		expect(validateEvent(name, properties, { source: "app" }).ok).toBe(true);
	});

	it.each(Object.entries(examples))("rejects extra properties for %s", (name, properties) => {
		expect(validateEvent(name, { ...properties, email: "never" }, { source: "app" })).toEqual({ ok: false });
	});

	it("allows attribution only on the documented continuation events", () => {
		expect(
			validateEvent(
				"node_viewed",
				{ node_id: "node", node_type: "artist" },
				{ source: "notification", recommendation_id: "recommendation", notification_id: "notification" },
			),
		).toMatchObject({ ok: true });
		expect(
			validateEvent(
				"search_submitted",
				{ filter: "artist" },
				{ source: "search", recommendation_id: "recommendation" },
			),
		).toEqual({ ok: false });
		expect(
			validateEvent(
				"node_viewed",
				{ node_id: "node", node_type: "artist", recommendation_id: "one" },
				{ source: "home", recommendation_id: "two" },
			),
		).toEqual({ ok: false });
	});
});

describe("consent-gated transport", () => {
	it("does not create identity or Segment when consent storage cannot persist a grant", async () => {
		const unavailable: KeyValueStorage = {
			getItem: async () => Promise.reject(new Error("storage unavailable")),
			setItem: async () => Promise.reject(new Error("storage unavailable")),
			removeItem: async () => Promise.reject(new Error("storage unavailable")),
		};
		let created = 0;
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(unavailable),
			createTransport: () => {
				created += 1;
				return {
					track: async () => true,
					disable: async () => undefined,
					purge: async () => true,
					reset: async () => undefined,
					destroy: () => undefined,
				};
			},
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		expect((await analytics.initialize()).status).toBe("unknown");
		expect((await analytics.grant()).status).toBe("unknown");
		expect(analytics.anonymousId).toBeUndefined();
		expect(created).toBe(0);
	});
	it("keeps a persisted event id through transport and emits app_opened only after a real background return", async () => {
		const persisted = storage();
		const delivered: AnalyticsPayload[] = [];
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => ({
				track: async (payload) => {
					delivered.push(payload);
					return true;
				},
				disable: async () => undefined,
				purge: async () => true,
				reset: async () => undefined,
				destroy: () => undefined,
			}),
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.grant();
		await analytics.trackEvent(
			"node_viewed",
			{ node_id: "n", node_type: "artist" },
			{
				source: "home",
				event_id: "22222222-2222-4222-8222-222222222222",
				recommendation_id: "recommendation",
				notification_id: "notification",
			},
		);
		await analytics.onAppState("inactive");
		await analytics.onAppState("active");
		await analytics.onAppState("background");
		await analytics.onAppState("active");
		expect(delivered.map((event) => event.properties.event_id)).toEqual([
			"22222222-2222-4222-8222-222222222222",
			"11111111-1111-4111-8111-111111111111",
		]);
		expect(delivered[0]?.context).toEqual({
			source: "home",
			event_id: "22222222-2222-4222-8222-222222222222",
			recommendation_id: "recommendation",
			notification_id: "notification",
		});
		expect(delivered[0]?.properties).toMatchObject({
			recommendation_id: "recommendation",
			notification_id: "notification",
		});
	});

	it("never creates a client before consent and retains only future events after late consent", async () => {
		const persisted = storage();
		const delivered: unknown[] = [];
		const transport: AnalyticsTransport = {
			track: async (payload) => {
				delivered.push(payload);
				return true;
			},
			disable: async () => undefined,
			purge: async () => true,
			reset: async () => undefined,
			destroy: () => undefined,
		};
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => transport,
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.initialize();
		expect(await analytics.trackEvent("app_opened", {}, { source: "app" })).toEqual({ kind: "disabled" });
		await analytics.grant();
		expect(await analytics.trackEvent("app_opened", {}, { source: "app" })).toEqual({ kind: "accepted" });
		expect(delivered).toHaveLength(1);
	});

	it("withdrawal disables, purges, resets, destroys and rotates the anonymous id", async () => {
		const persisted = storage();
		const calls: string[] = [];
		const makeTransport = (): AnalyticsTransport => ({
			track: async () => true,
			disable: async () => void calls.push("disable"),
			purge: async () => {
				calls.push("purge");
				return true;
			},
			reset: async () => void calls.push("reset"),
			destroy: () => void calls.push("destroy"),
		});
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: makeTransport,
			createId: (() => {
				let n = 0;
				return () => `11111111-1111-4111-8111-${String(++n).padStart(12, "0")}`;
			})(),
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.grant();
		await analytics.revoke();
		expect(calls).toEqual(["disable", "purge", "reset", "destroy"]);
		await analytics.grant();
		expect(analytics.anonymousId).not.toBe("11111111-1111-4111-8111-000000000001");
	});

	it("makes the last consent intention win when a grant write races a withdrawal", async () => {
		const persisted = storage();
		let releaseGrant: (() => void) | undefined;
		const originalSet = persisted.setItem;
		persisted.setItem = async (key, value) => {
			if (value.includes("granted"))
				await new Promise<void>((resolve) => {
					releaseGrant = resolve;
				});
			await originalSet(key, value);
		};
		let created = 0;
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => {
				created += 1;
				return {
					track: async () => true,
					disable: async () => undefined,
					purge: async () => true,
					reset: async () => undefined,
					destroy: () => undefined,
				};
			},
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		const grant = analytics.grant();
		await Promise.resolve();
		const revoke = analytics.revoke();
		releaseGrant?.();
		await Promise.all([grant, revoke]);
		expect(analytics.consent.status).toBe("denied");
		expect(created).toBe(0);
	});
});

describe("Segment persistence boundary", () => {
	it("materializes messageId before a persisted queue and keeps recommendation attribution", async () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: async (key: string) => values.get(key) ?? null,
			setItem: async (key: string, value: string) => void values.set(key, value),
			removeItem: async (key: string) => void values.delete(key),
			getAllKeys: async () => [...values.keys()],
			multiRemove: async (keys: string[]) => {
				for (const key of keys) values.delete(key);
			},
		};
		let queuePersistor: { set<T>(key: string, state: T): Promise<void> } | undefined;
		let plugin:
			| {
					track(event: { properties?: Record<string, unknown>; messageId?: string }): {
						properties?: Record<string, unknown>;
						messageId?: string;
					};
			  }
			| undefined;
		let enriched: { context?: Record<string, unknown> } | undefined;
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
				enrich: (event: {
					messageId?: string;
					anonymousId?: string;
					timestamp?: string;
					context?: Record<string, unknown>;
				}) => {
					messageId?: string;
					anonymousId?: string;
					timestamp?: string;
					context?: Record<string, unknown>;
				},
			) => {
				const queued = plugin?.track({ properties });
				await queuePersistor?.set("public-key-events", { events: [queued] });
				enriched = enrich(queued ?? { properties });
			},
			enabled: { set: async () => undefined },
			running: { set: async () => undefined },
			isReady: { value: true, onChange: () => () => undefined },
			add: (input: {
				plugin: {
					track(event: { properties?: Record<string, unknown>; messageId?: string }): {
						properties?: Record<string, unknown>;
						messageId?: string;
					};
				};
			}) => {
				plugin = input.plugin;
			},
			clear: () => undefined,
			reset: async () => undefined,
			cleanup: () => undefined,
		};
		const transport = createSegmentTransport(
			"public-key",
			{
				createClient: (config) => {
					queuePersistor = config.storePersistor as { set<T>(key: string, state: T): Promise<void> };
					return runtime;
				},
				EventPlugin,
				PluginType: { before: "before" },
			},
			storage,
		);
		await transport.track({
			name: "node_viewed",
			properties: {
				node_id: "node",
				node_type: "artist",
				event_id: "22222222-2222-4222-8222-222222222222",
				schema_version: 1,
				platform: "ios",
				app_version: "1",
				build_number: "1",
				environment: "development",
				source: "home",
				occurred_at: "2026-01-01T00:00:00.000Z",
				anonymousId: "11111111-1111-4111-8111-111111111111",
			},
			context: {
				source: "home",
				event_id: "22222222-2222-4222-8222-222222222222",
				recommendation_id: "recommendation",
			},
		});
		expect(values.get("track1.analytics-segment.v1.public-key-events")).toContain(
			'"messageId":"22222222-2222-4222-8222-222222222222"',
		);
		expect(enriched?.context?.track1).toEqual({
			source: "home",
			event_id: "22222222-2222-4222-8222-222222222222",
			recommendation_id: "recommendation",
		});
	});

	it("blocks then physically purges persisted SDK keys", async () => {
		const values = new Map<string, string>([
			["track1.analytics-segment.v1.public-key-events", "queued"],
			["track1.analytics-segment.v1.public-key-context", "identity"],
		]);
		const storage = {
			getItem: async (key: string) => values.get(key) ?? null,
			setItem: async (key: string, value: string) => void values.set(key, value),
			removeItem: async (key: string) => void values.delete(key),
			getAllKeys: async () => [...values.keys()],
			multiRemove: async (keys: string[]) => {
				for (const key of keys) values.delete(key);
			},
		};
		const persistor = new ConsentBoundPersistor(storage);
		await persistor.purge();
		await persistor.set("public-key-events", { events: ["must-not-return"] });
		expect(values).toEqual(new Map());
	});

	it("returns an incomplete purge when every AsyncStorage removal fails", async () => {
		const values = new Map<string, string>([["track1.analytics-segment.v1.public-key-events", "queued"]]);
		const storage = {
			getItem: async (key: string) => values.get(key) ?? null,
			setItem: async (key: string, value: string) => void values.set(key, value),
			removeItem: async () => Promise.reject(new Error("storage unavailable")),
			getAllKeys: async () => [...values.keys()],
			multiRemove: async () => Promise.reject(new Error("storage unavailable")),
		};
		const persistor = new ConsentBoundPersistor(storage);
		expect(await persistor.purge()).toBe(false);
		expect(values.get("track1.analytics-segment.v1.public-key-events")).toBe("queued");
	});

	it("reports a failed physical purge and prevents a new grant until it is retried", async () => {
		const persisted = storage();
		let purgeAttempts = 0;
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => ({
				track: async () => true,
				disable: async () => undefined,
				purge: async () => {
					purgeAttempts += 1;
					return purgeAttempts > 1;
				},
				reset: async () => undefined,
				destroy: () => undefined,
			}),
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.grant();
		await analytics.revoke();
		expect(analytics.consent.status).toBe("denied");
		expect(analytics.purgeIncomplete).toBe(true);
		await analytics.grant();
		expect(analytics.consent.status).toBe("denied");
		await analytics.revoke();
		expect(analytics.purgeIncomplete).toBe(false);
		await analytics.grant();
		expect(analytics.consent.status).toBe("granted");
	});

	it("purges the old Segment boundary after restart without recreating the SDK", async () => {
		const persisted = storage();
		const segment = segmentStorage(
			new Map([
				["track1.analytics-segment.v1.public-key-pendingEvents", "old-event"],
				["track1.analytics-segment.v1.public-key-userInfo", "old-identity"],
				["profile-settings", "must-survive"],
			]),
		);
		let purgeAttempt = 0;
		let created = 0;
		let identities = 0;
		const makeClient = () =>
			new AnalyticsClient({
				consent: new ConsentStore(persisted),
				createTransport: () => {
					created += 1;
					return {
						track: async () => true,
						disable: async () => undefined,
						purge: async () => {
							purgeAttempt += 1;
							if (purgeAttempt === 1) return false;
							return true;
						},
						reset: async () => undefined,
						destroy: () => undefined,
					};
				},
				purgeStorage: () => purgeSegmentStorage(segment),
				createId: () => {
					identities += 1;
					return "11111111-1111-4111-8111-111111111111";
				},
				environment: "development",
				platform: "ios",
				appVersion: "1",
				buildNumber: "1",
			});
		const beforeKill = makeClient();
		await beforeKill.grant();
		await beforeKill.revoke();
		expect(segment.values.size).toBe(3);
		created = 0;
		identities = 0;

		const restarted = makeClient();
		await restarted.initialize();
		expect(restarted.purgeIncomplete).toBe(true);
		await restarted.revoke();
		expect(segment.values).toEqual(new Map([["profile-settings", "must-survive"]]));
		expect(created).toBe(0);
		expect(identities).toBe(0);
		await restarted.grant();
		expect(restarted.consent.status).toBe("granted");
		expect(created).toBe(1);
	});

	it("purges a durable Segment namespace when first refusal has no active transport", async () => {
		const persisted = storage();
		const segment = segmentStorage(
			new Map([
				["track1.analytics-segment.v1.public-key-pendingEvents", "old-event"],
				["track1.analytics-segment.v1.public-key-userInfo", "old-identity"],
				["profile-settings", "must-survive"],
			]),
		);
		let purgeCalls = 0;
		let created = 0;
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => {
				created += 1;
				return {
					track: async () => true,
					disable: async () => undefined,
					purge: async () => true,
					reset: async () => undefined,
					destroy: () => undefined,
				};
			},
			purgeStorage: async () => {
				purgeCalls += 1;
				return purgeSegmentStorage(segment);
			},
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.initialize();
		await analytics.revoke();
		expect(purgeCalls).toBe(1);
		expect(segment.values).toEqual(new Map([["profile-settings", "must-survive"]]));
		expect(analytics.consent.status).toBe("denied");
		expect(analytics.purgeIncomplete).toBe(false);
		expect(created).toBe(0);
	});

	it("keeps the tombstone and blocks grant when first refusal cannot purge durable storage", async () => {
		const persisted = storage();
		const segment = segmentStorage(
			new Map([["track1.analytics-segment.v1.public-key-pendingEvents", "old-event"]]),
			true,
		);
		let created = 0;
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => {
				created += 1;
				return {
					track: async () => true,
					disable: async () => undefined,
					purge: async () => true,
					reset: async () => undefined,
					destroy: () => undefined,
				};
			},
			purgeStorage: () => purgeSegmentStorage(segment),
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.initialize();
		await analytics.revoke();
		expect(analytics.consent.status).toBe("denied");
		expect(analytics.purgeIncomplete).toBe(true);
		expect(await new ConsentStore(persisted).revocationPending()).toBe(true);
		await analytics.grant();
		expect(analytics.consent.status).toBe("denied");
		expect(created).toBe(0);
	});

	it("keeps the tombstone and blocks grant when a restart cannot purge Segment storage", async () => {
		const persisted = storage();
		await persisted.setItem("track1.analytics-revocation.v1", "pending");
		const segment = segmentStorage(
			new Map([["track1.analytics-segment.v1.public-key-pendingEvents", "old-event"]]),
			true,
		);
		let created = 0;
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => {
				created += 1;
				return {
					track: async () => true,
					disable: async () => undefined,
					purge: async () => true,
					reset: async () => undefined,
					destroy: () => undefined,
				};
			},
			purgeStorage: () => purgeSegmentStorage(segment),
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.initialize();
		await analytics.revoke();
		expect(analytics.purgeIncomplete).toBe(true);
		expect(await new ConsentStore(persisted).revocationPending()).toBe(true);
		await analytics.grant();
		expect(analytics.consent.status).toBe("denied");
		expect(created).toBe(0);
	});

	it("does not recreate Segment when a revoke immediately races a grant and purge fails", async () => {
		const persisted = storage();
		let releasePurge: (() => void) | undefined;
		let created = 0;
		const analytics = new AnalyticsClient({
			consent: new ConsentStore(persisted),
			createTransport: () => {
				created += 1;
				return {
					track: async () => true,
					disable: async () => undefined,
					purge: async () =>
						new Promise<boolean>((resolve) => {
							releasePurge = () => resolve(false);
						}),
					reset: async () => undefined,
					destroy: () => undefined,
				};
			},
			createId: () => "11111111-1111-4111-8111-111111111111",
			environment: "development",
			platform: "ios",
			appVersion: "1",
			buildNumber: "1",
		});
		await analytics.grant();
		const revoke = analytics.revoke();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const grant = analytics.grant();
		expect(releasePurge).toBeDefined();
		releasePurge?.();
		await Promise.all([revoke, grant]);
		expect(analytics.consent.status).toBe("denied");
		expect(analytics.configured).toBe(false);
		expect(created).toBe(1);
	});

	it("does not queue while Segment readiness is suspended", async () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: async (key: string) => values.get(key) ?? null,
			setItem: async (key: string, value: string) => void values.set(key, value),
			removeItem: async (key: string) => void values.delete(key),
			getAllKeys: async () => [...values.keys()],
			multiRemove: async (keys: string[]) => {
				for (const key of keys) values.delete(key);
			},
		};
		class EventPlugin {
			type = "before" as const;
			track(event: { properties?: Record<string, unknown>; messageId?: string }) {
				return event;
			}
		}
		const track = jest.fn(async () => undefined);
		const transport = createSegmentTransport(
			"public-key",
			{
				createClient: () => ({
					track,
					enabled: { set: async () => undefined },
					running: { set: async () => undefined },
					isReady: { value: false, onChange: () => () => undefined },
					add: () => undefined,
					clear: () => undefined,
					reset: async () => undefined,
					cleanup: () => undefined,
				}),
				EventPlugin,
				PluginType: { before: "before" },
			},
			storage,
		);
		const result = await transport.track({
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
			context: { source: "app", event_id: "22222222-2222-4222-8222-222222222222" },
		});
		expect(result).toBe(false);
		expect(track).not.toHaveBeenCalled();
		expect(values).toEqual(new Map());
	});
});
