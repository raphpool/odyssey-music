jest.mock("@react-native-async-storage/async-storage", () => ({
	getItem: jest.fn(),
	setItem: jest.fn(),
	removeItem: jest.fn(),
}));
jest.mock("expo-router", () => ({
	router: { back: jest.fn(), replace: jest.fn() },
	useLocalSearchParams: jest.fn(),
}));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import PrivacyChoiceScreen, { safeInternalReturnTo } from "../app/privacy-choice";
import { ConsentStore, type KeyValueStorage } from "../src/analytics/consent";
import { useAnalytics } from "../src/analytics/provider";

const memoryStorage = (): KeyValueStorage => {
	const values = new Map<string, string>();
	return {
		getItem: async (key) => values.get(key) ?? null,
		setItem: async (key, value) => void values.set(key, value),
		removeItem: async (key) => void values.delete(key),
	};
};

describe("analytics consent persistence", () => {
	it("uses a dated, versioned choice independent of profile and push data", async () => {
		const store = new ConsentStore(memoryStorage(), () => "2026-01-01T00:00:00.000Z");
		expect(await store.read()).toEqual({ version: 1, status: "unknown" });
		await store.grant();
		expect(await store.read()).toEqual({
			version: 1,
			status: "granted",
			decidedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("fails closed on restart when a revocation tombstone remains", async () => {
		const storage = memoryStorage();
		await storage.setItem(
			"track1.analytics-consent.v1",
			JSON.stringify({ version: 1, status: "granted", decidedAt: "2026-01-01T00:00:00.000Z" }),
		);
		await storage.setItem("track1.analytics-revocation.v1", "pending");
		expect(await new ConsentStore(storage).read()).toEqual({ version: 1, status: "denied" });
	});

	it("returns unknown when persistent consent storage cannot be read", async () => {
		const unavailable: KeyValueStorage = {
			getItem: async () => Promise.reject(new Error("storage unavailable")),
			setItem: async () => Promise.reject(new Error("storage unavailable")),
			removeItem: async () => Promise.reject(new Error("storage unavailable")),
		};
		expect(await new ConsentStore(unavailable).read()).toEqual({ version: 1, status: "unknown" });
	});

	it("does not revive a stored grant when storage has become read-only", async () => {
		const values = new Map<string, string>([
			[
				"track1.analytics-consent.v1",
				JSON.stringify({ version: 1, status: "granted", decidedAt: "2026-01-01T00:00:00.000Z" }),
			],
		]);
		const readOnly: KeyValueStorage = {
			getItem: async (key) => values.get(key) ?? null,
			setItem: async () => Promise.reject(new Error("storage unavailable")),
			removeItem: async () => Promise.reject(new Error("storage unavailable")),
		};
		expect(await new ConsentStore(readOnly).read()).toEqual({ version: 1, status: "unknown" });
	});
});

describe("privacy choice gate", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.mocked(useLocalSearchParams).mockReturnValue({});
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "unknown" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent: async () => ({ kind: "disabled" }),
		});
	});

	it("keeps the initial unknown choice in front of tabs", () => {
		const screen = render(<PrivacyChoiceScreen />);
		expect(screen.getByRole("header", { name: "Mesure d’usage" })).toBeTruthy();
		expect(router.replace).not.toHaveBeenCalled();
	});

	it.each([
		["/node/artist%3Amassive-attack", "/node/artist%3Amassive-attack"],
		["//evil.example", "/"],
		["/\\evil", "/"],
		["https://evil.example", "/"],
		["/%2f%2fevil.example", "/"],
		["/%255cevil", "/"],
		["/node/a#external", "/"],
	])("canonicalizes returnTo %s", (value, expected) => {
		expect(safeInternalReturnTo(value)).toBe(expected);
	});

	it("keeps settings editing open and serializes double presses", async () => {
		let finishGrant: (() => void) | undefined;
		const grant = jest.fn(
			() =>
				new Promise<void>((resolve) => {
					finishGrant = resolve;
				}),
		);
		jest.mocked(useLocalSearchParams).mockReturnValue({ mode: "edit" });
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied", decidedAt: "2026-01-01T00:00:00.000Z" },
			configured: false,
			purgeIncomplete: false,
			grant,
			deny: async () => undefined,
			trackEvent: async () => ({ kind: "disabled" }),
		});
		const screen = render(<PrivacyChoiceScreen />);
		expect(router.replace).not.toHaveBeenCalled();
		const accept = screen.getByLabelText("Accepter la mesure d’usage");
		fireEvent.press(accept);
		fireEvent.press(accept);
		expect(grant).toHaveBeenCalledTimes(1);
		finishGrant?.();
		await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
	});
});
