import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

import SearchScreen from "../app/(tabs)/search";
import type { ApiClient } from "../src/api/client";
import { RequestState } from "../src/components/RequestState";

const mockValues = new Map<string, string>();

jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useLocalSearchParams: jest.fn(() => ({})) }));
jest.mock("../src/analytics/provider", () => ({
	useAnalytics: () => ({
		ready: true,
		consent: { version: 1 as const, status: "denied" as const },
		configured: false,
		purgeIncomplete: false,
		grant: async () => undefined,
		deny: async () => undefined,
		trackEvent: async () => ({ kind: "disabled" as const }),
	}),
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
	default: {
		getItem: async (key: string) => mockValues.get(key) ?? null,
		setItem: async (key: string, value: string) => void mockValues.set(key, value),
		removeItem: async (key: string) => void mockValues.delete(key),
	},
}));

describe("offline journey feedback", () => {
	beforeEach(() => {
		mockValues.clear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("states explicitly that external work is suspended while saved content remains available", async () => {
		const screen = render(<RequestState kind="offline" />);
		await waitFor(() =>
			expect(screen.getByText("Hors connexion : les fiches enregistrées restent consultables.")).toBeTruthy(),
		);
		expect(screen.getByText("La recherche externe et la création sont suspendues.")).toBeTruthy();
	});

	it("uses the saved catalogue after a network failure without pretending external search succeeded", async () => {
		mockValues.set(
			"track1.offline.catalog.v1",
			JSON.stringify({
				version: 1,
				checkedAt: 0,
				catalog: {
					version: "v1",
					revision: `sha256:${"a".repeat(64)}`,
					taxonomy: { mode: "degraded", available: true },
					nodes: [{ identity: "artist:sample", type: "artist", name: "Sample", teaser: null }],
					edges: [],
				},
			}),
		);
		jest.useFakeTimers();
		const search = jest.fn(async () => ({
			kind: "error" as const,
			error: { kind: "network_error" as const, message: "offline" },
		}));
		const screen = render(<SearchScreen apiClient={{ search } as unknown as ApiClient} />);
		fireEvent.changeText(screen.getByLabelText("Rechercher dans Odyssey"), "sample");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Sample")).toBeTruthy());
		expect(search).toHaveBeenCalledTimes(1);
		expect(screen.getByText("La recherche externe et la création sont suspendues.")).toBeTruthy();
	});

	it("keeps external search retryable after an API failure instead of entering offline mode", async () => {
		jest.useFakeTimers();
		const search = jest
			.fn()
			.mockResolvedValueOnce({
				kind: "error" as const,
				error: {
					kind: "api" as const,
					status: 503,
					code: "temporarily_unavailable",
					retryable: true,
					message: "unavailable",
				},
			})
			.mockResolvedValueOnce({
				kind: "success" as const,
				value: {
					q: "burial",
					hits: [
						{ source: "cache" as const, type: "artist" as const, name: "Burial", slug: "artist:burial" },
					],
					sources: { cache: 1, catalog: 0 },
				},
			});
		const screen = render(<SearchScreen apiClient={{ search } as unknown as ApiClient} />);
		const input = screen.getByLabelText("Rechercher dans Odyssey");
		fireEvent.changeText(input, "aphex");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("La recherche n’a pas pu aboutir.")).toBeTruthy());
		expect(screen.queryByText("La recherche externe et la création sont suspendues.")).toBeNull();
		fireEvent.changeText(input, "burial");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Burial")).toBeTruthy());
		expect(screen.queryByText("La recherche externe et la création sont suspendues.")).toBeNull();
		expect(search).toHaveBeenCalledTimes(2);
	});

	it("retries the remote search when the query changes after an offline fallback", async () => {
		mockValues.set(
			"track1.offline.catalog.v1",
			JSON.stringify({
				version: 1,
				checkedAt: 0,
				catalog: {
					version: "v1",
					revision: `sha256:${"a".repeat(64)}`,
					taxonomy: { mode: "degraded", available: true },
					nodes: [{ identity: "artist:sample", type: "artist", name: "Sample", teaser: null }],
					edges: [],
				},
			}),
		);
		jest.useFakeTimers();
		const search = jest
			.fn()
			.mockResolvedValueOnce({
				kind: "error" as const,
				error: { kind: "timeout" as const, message: "offline" },
			})
			.mockResolvedValueOnce({
				kind: "success" as const,
				value: {
					q: "burial",
					hits: [
						{ source: "cache" as const, type: "artist" as const, name: "Burial", slug: "artist:burial" },
					],
					sources: { cache: 1, catalog: 0 },
				},
			});
		const screen = render(<SearchScreen apiClient={{ search } as unknown as ApiClient} />);
		const input = screen.getByLabelText("Rechercher dans Odyssey");
		fireEvent.changeText(input, "sample");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Sample")).toBeTruthy());
		fireEvent.changeText(input, "burial");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Burial")).toBeTruthy());
		expect(search).toHaveBeenCalledTimes(2);
	});
});
