import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import SearchScreen from "../app/(tabs)/search";
import { useAnalytics } from "../src/analytics/provider";
import type { ApiClient } from "../src/api/client";
import type { SearchResponse } from "../src/api/contracts";
import type { ClientResult } from "../src/api/errors";
import { readNodeNavigationContext } from "../src/navigation/context";
import {
	normalizeSearchQuery,
	resultAvailability,
	SEARCH_FILTERS,
	searchKey,
	searchQueryState,
	searchType,
} from "../src/search/model";

jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useLocalSearchParams: jest.fn() }));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));

const mockedUseAnalytics = useAnalytics as jest.MockedFunction<typeof useAnalytics>;
const mockedUseLocalSearchParams = jest.mocked(useLocalSearchParams);

function analytics(
	status: "granted" | "denied" | "unknown",
	trackEvent = jest.fn(async () => ({ kind: "accepted" as const })),
) {
	return {
		ready: true,
		consent: { version: 1 as const, status },
		configured: status === "granted",
		purgeIncomplete: false,
		grant: async () => undefined,
		deny: async () => undefined,
		trackEvent,
	};
}

function clientWith(search: ApiClient["search"]): ApiClient {
	return { search } as unknown as ApiClient;
}

function success(value: SearchResponse): ClientResult<SearchResponse> {
	return { kind: "success", value };
}

const cacheHit = {
	source: "cache" as const,
	type: "artist" as const,
	name: "Massive Attack",
	slug: "artist:massive-attack",
};

describe("mobile global search", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockedUseLocalSearchParams.mockReturnValue({});
		mockedUseAnalytics.mockReturnValue(analytics("granted"));
	});

	afterEach(() => {
		jest.runOnlyPendingTimers();
		jest.useRealTimers();
		jest.clearAllMocks();
	});

	it("debounces the request, forwards the selected type, and never sends the query to analytics", async () => {
		const search = jest.fn(async () =>
			success({ q: "massive attack", hits: [cacheHit], sources: { cache: 1, catalog: 0 } }),
		);
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		mockedUseAnalytics.mockReturnValue(analytics("granted", trackEvent));
		const screen = render(<SearchScreen apiClient={clientWith(search)} />);
		const input = screen.getByLabelText("Rechercher dans Odyssey");

		fireEvent.changeText(input, "massive");
		fireEvent.changeText(input, "massive attack");
		act(() => jest.advanceTimersByTime(299));
		expect(search).not.toHaveBeenCalled();

		await act(async () => {
			jest.advanceTimersByTime(1);
			await Promise.resolve();
		});
		expect(search).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenCalledWith({ q: "massive attack", limit: 25, signal: expect.any(AbortSignal) });
		expect(trackEvent).toHaveBeenCalledWith("search_submitted", { filter: "all" }, { source: "search" });
		expect(JSON.stringify(trackEvent.mock.calls)).not.toContain("massive attack");

		const artistButtons = screen.getAllByRole("button", { name: "Artistes" });
		const artistFilter = artistButtons[0];
		if (artistFilter === undefined) throw new Error("The artist filter is not rendered.");
		fireEvent.press(artistFilter);
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		expect(search).toHaveBeenLastCalledWith({
			q: "massive attack",
			limit: 25,
			type: "artist",
			signal: expect.any(AbortSignal),
		});
		expect(trackEvent).toHaveBeenLastCalledWith(
			"search_submitted",
			{ filter: "artist" },
			{ source: "search" },
		);
	});

	it("prefills the query supplied by a missing-node route", async () => {
		mockedUseLocalSearchParams.mockReturnValue({ q: "massive attack" });
		const search = jest.fn(async () =>
			success({ q: "massive attack", hits: [cacheHit], sources: { cache: 1, catalog: 0 } }),
		);
		const screen = render(<SearchScreen apiClient={clientWith(search)} />);

		await waitFor(() =>
			expect(screen.getByLabelText("Rechercher dans Odyssey").props.value).toBe("massive attack"),
		);
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});

		expect(search).toHaveBeenCalledWith({
			q: "massive attack",
			limit: 25,
			signal: expect.any(AbortSignal),
		});
	});

	it("does not replay the search when the analytics provider value changes", async () => {
		const search = jest.fn(async () =>
			success({ q: "massive", hits: [cacheHit], sources: { cache: 1, catalog: 0 } }),
		);
		const apiClient = clientWith(search);
		const firstTrack = jest.fn(async () => ({ kind: "accepted" as const }));
		mockedUseAnalytics.mockReturnValue(analytics("granted", firstTrack));
		const screen = render(<SearchScreen apiClient={apiClient} />);
		fireEvent.changeText(screen.getByLabelText("Rechercher dans Odyssey"), "massive");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		const secondTrack = jest.fn(async () => ({ kind: "accepted" as const }));
		mockedUseAnalytics.mockReturnValue(analytics("denied", secondTrack));
		screen.rerender(<SearchScreen apiClient={apiClient} />);
		await act(async () => {
			await Promise.resolve();
		});

		expect(search).toHaveBeenCalledTimes(1);
		expect(firstTrack).toHaveBeenCalledTimes(1);
		expect(secondTrack).not.toHaveBeenCalled();
	});

	it("cancels the previous request and ignores a late response", async () => {
		const requests: Array<{
			resolve: (result: ClientResult<SearchResponse>) => void;
			signal: AbortSignal | undefined;
		}> = [];
		const search = jest.fn(
			({ signal }: Parameters<ApiClient["search"]>[0]) =>
				new Promise<ClientResult<SearchResponse>>((resolve) => requests.push({ resolve, signal })),
		);
		const screen = render(<SearchScreen apiClient={clientWith(search)} />);
		const input = screen.getByLabelText("Rechercher dans Odyssey");

		fireEvent.changeText(input, "first");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		fireEvent.changeText(input, "second");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});

		expect(requests).toHaveLength(2);
		expect(requests[0]?.signal?.aborted).toBe(true);
		await act(async () => {
			requests[0]?.resolve(
				success({
					q: "first",
					hits: [{ ...cacheHit, name: "First result" }],
					sources: { cache: 1, catalog: 0 },
				}),
			);
			requests[1]?.resolve(
				success({
					q: "second",
					hits: [{ ...cacheHit, name: "Second result" }],
					sources: { cache: 1, catalog: 0 },
				}),
			);
			await Promise.resolve();
		});

		expect(screen.queryByText("First result")).toBeNull();
		expect(screen.getByText("Second result")).toBeTruthy();
	});

	it("invalidates the previous result immediately when the filter changes", async () => {
		const search = jest.fn(async () =>
			success({ q: "massive", hits: [cacheHit], sources: { cache: 1, catalog: 0 } }),
		);
		const screen = render(<SearchScreen apiClient={clientWith(search)} />);
		const input = screen.getByLabelText("Rechercher dans Odyssey");
		fireEvent.changeText(input, "massive");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Massive Attack")).toBeTruthy());

		const artistButtons = screen.getAllByRole("button", { name: "Artistes" });
		const artistFilter = artistButtons[0];
		if (artistFilter === undefined) throw new Error("The artist filter is not rendered.");
		fireEvent.press(artistFilter);

		expect(screen.queryByText("Massive Attack")).toBeNull();
		expect(screen.getByLabelText("Recherche en cours")).toBeTruthy();
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
	});

	it("shows empty results and makes each result provenance explicit", async () => {
		const search = jest
			.fn()
			.mockResolvedValueOnce(success({ q: "none", hits: [], sources: { cache: 0, catalog: 0 } }))
			.mockResolvedValueOnce(
				success({
					q: "massive",
					hits: [cacheHit, { source: "catalog", type: "genre", name: "Trip-hop", subtitle: "À documenter" }],
					sources: { cache: 1, catalog: 1 },
				}),
			);
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		mockedUseAnalytics.mockReturnValue(analytics("granted", trackEvent));
		const screen = render(<SearchScreen apiClient={clientWith(search)} />);
		const input = screen.getByLabelText("Rechercher dans Odyssey");

		fireEvent.changeText(input, "none");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Aucun résultat.")).toBeTruthy());

		fireEvent.changeText(input, "massive");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Fiche disponible · source cache")).toBeTruthy());
		expect(screen.getByText("Fiche à créer · source catalogue")).toBeTruthy();
		fireEvent.press(screen.getByLabelText("Massive Attack, Fiche disponible · source cache"));
		expect(router.push).toHaveBeenCalledWith({
			pathname: "/node/[slug]",
			params: { slug: "artist:massive-attack", source: "search" },
		});
		expect(readNodeNavigationContext({ slug: "artist:massive-attack", source: "search" })).toEqual({
			source: "search",
		});
		expect(trackEvent).toHaveBeenCalledWith(
			"search_result_opened",
			{
				node_type: "artist",
				node_id: "artist:massive-attack",
				availability: "cached",
				results_count: 2,
			},
			{ source: "search" },
		);
	});

	it("validates query boundaries and maps all five filters without inventing a type", () => {
		expect(normalizeSearchQuery("  massive attack  ")).toBe("massive attack");
		expect(searchQueryState("")).toBe("empty");
		expect(searchQueryState("a")).toBe("too_short");
		expect(searchQueryState("a".repeat(121))).toBe("too_long");
		expect(searchQueryState("ab")).toBe("admissible");
		expect(SEARCH_FILTERS).toEqual(["all", "artist", "project", "track", "genre", "label"]);
		expect(searchType("all")).toBeUndefined();
		expect(searchType("genre")).toBe("genre");
		expect(searchKey("massive", "all")).not.toBe(searchKey("massive", "artist"));
		expect(resultAvailability({ ...cacheHit, type: "label", name: "Warp" })).toBe("cached");
		expect(resultAvailability({ source: "catalog", type: "label", name: "Warp" })).toBe("missing");
	});

	it("does not request a too-short or too-long query and retries a failed request", async () => {
		const search = jest
			.fn()
			.mockResolvedValueOnce({
				kind: "error",
				error: { kind: "api", status: 503, code: "unavailable", retryable: true, message: "safe" },
			} satisfies ClientResult<SearchResponse>)
			.mockResolvedValueOnce(success({ q: "ab", hits: [cacheHit], sources: { cache: 1, catalog: 0 } }));
		const screen = render(<SearchScreen apiClient={clientWith(search)} />);
		const input = screen.getByLabelText("Rechercher dans Odyssey");

		fireEvent.changeText(input, "a");
		act(() => jest.advanceTimersByTime(500));
		expect(search).not.toHaveBeenCalled();

		fireEvent.changeText(input, "a".repeat(121));
		act(() => jest.advanceTimersByTime(500));
		expect(search).not.toHaveBeenCalled();
		expect(screen.getByText("La recherche doit contenir au maximum 120 caractères.")).toBeTruthy();

		fireEvent.changeText(input, "ab");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		expect(screen.getByText("La recherche n’a pas pu aboutir.")).toBeTruthy();
		expect(screen.getByLabelText("Réessayer la recherche")).toBeTruthy();
		fireEvent.press(screen.getByLabelText("Réessayer la recherche"));
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});
		await waitFor(() => expect(screen.getByText("Massive Attack")).toBeTruthy());
		expect(search).toHaveBeenCalledTimes(2);
	});

	it("does not emit analytics while consent is denied", async () => {
		const search = jest.fn(async () =>
			success({ q: "massive", hits: [], sources: { cache: 0, catalog: 0 } }),
		);
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		mockedUseAnalytics.mockReturnValue(analytics("denied", trackEvent));
		const screen = render(<SearchScreen apiClient={clientWith(search)} />);

		fireEvent.changeText(screen.getByLabelText("Rechercher dans Odyssey"), "massive");
		await act(async () => {
			jest.advanceTimersByTime(300);
			await Promise.resolve();
		});

		expect(search).toHaveBeenCalledTimes(1);
		expect(trackEvent).not.toHaveBeenCalled();
	});
});
