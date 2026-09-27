import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

type MockAsyncStorage = {
	values: Map<string, string>;
	getItem: jest.Mock<Promise<string | null>, [string]>;
	setItem: jest.Mock<Promise<void>, [string, string]>;
	removeItem: jest.Mock<Promise<void>, [string]>;
};

const mockAsyncStorage: MockAsyncStorage = {
	values: new Map<string, string>(),
	getItem: jest.fn(async (key: string) => mockAsyncStorage.values.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => void mockAsyncStorage.values.set(key, value)),
	removeItem: jest.fn(async (key: string) => void mockAsyncStorage.values.delete(key)),
};

import TodayScreen from "../app/(tabs)/index";
import { useAnalytics } from "../src/analytics/provider";
import { createApiClient } from "../src/api/client";
import { useProfile } from "../src/profile/useProfile";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("../src/api/client", () => ({ createApiClient: jest.fn() }));
jest.mock("../src/profile/useProfile", () => ({
	useProfile: jest.fn(),
	profileFromState: (state: unknown) => (state as { profile?: unknown }).profile,
}));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({ default: mockAsyncStorage }));

const mockedClient = jest.mocked(createApiClient);
const mockedProfile = jest.mocked(useProfile);
const mockedAnalytics = jest.mocked(useAnalytics);
const profile = {
	version: 1 as const,
	local_id: "11111111-1111-4111-8111-111111111111",
	genre_ids: ["genre:ambient"],
	revision: 1,
	onboarding_completed: true,
	flow_id: "22222222-2222-4222-8222-222222222222",
};
const catalog = {
	version: "v1" as const,
	revision: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	taxonomy: { mode: "degraded" as const, available: true },
	nodes: [
		{ identity: "genre:ambient", type: "genre" as const, name: "Ambient", teaser: null },
		{ identity: "artist:sample", type: "artist" as const, name: "Sample", teaser: "À écouter." },
	],
	edges: [{ source: "artist:sample", target: "genre:ambient", type: "genres" }],
};

describe("TodayScreen", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockAsyncStorage.values.clear();
		mockedProfile.mockReturnValue({
			ready: true,
			state: { kind: "profile", profile },
			reload: async () => ({ kind: "profile", profile }),
		});
		mockedAnalytics.mockReturnValue({
			ready: true,
			consent: { version: 1 as const, status: "denied" as const },
			configured: false,
			transportReady: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent: jest.fn(async () => ({ kind: "disabled" as const })),
		});
		mockedClient.mockReturnValue({
			getCatalog: jest.fn(async () => ({ kind: "success" as const, value: catalog })),
			getImage: jest.fn(async () => ({ kind: "success" as const, value: { image_url: null } })),
		} as unknown as ReturnType<typeof createApiClient>);
	});

	it("keeps discovering and opening the fiche when analytics or notifications are refused and no image exists", async () => {
		const screen = render(<TodayScreen />);
		await waitFor(() => expect(screen.getByRole("header", { name: "Sample" })).toBeTruthy());
		expect(screen.getByText("Image indisponible")).toBeTruthy();

		fireEvent.press(screen.getByRole("button", { name: "Découvrir Sample" }));
		expect(router.push).toHaveBeenCalledWith({
			pathname: "/node/[slug]",
			params: expect.objectContaining({ slug: "artist:sample", source: "home" }),
		});
		expect(mockedAnalytics.mock.results[0]?.value.trackEvent).not.toHaveBeenCalled();
	});

	it("does not load a catalog or create a recommendation without a profile", async () => {
		mockedProfile.mockReturnValue({
			ready: true,
			state: { kind: "missing" },
			reload: async () => ({ kind: "missing" }),
		});
		const screen = render(<TodayScreen />);
		await waitFor(() =>
			expect(screen.getByText("Choisissez vos goûts pour recevoir une découverte.")).toBeTruthy(),
		);
		expect(mockedClient.mock.results[0]?.value.getCatalog).not.toHaveBeenCalled();
	});

	it("waits for ready analytics before recording the persistent view event", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		mockedAnalytics.mockReturnValue({
			ready: false,
			consent: { version: 1 as const, status: "granted" as const },
			configured: true,
			transportReady: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		const screen = render(<TodayScreen />);
		await waitFor(() => expect(screen.getByRole("header", { name: "Sample" })).toBeTruthy());
		expect(trackEvent).not.toHaveBeenCalled();
		mockedAnalytics.mockReturnValue({
			ready: true,
			consent: { version: 1 as const, status: "granted" as const },
			configured: true,
			transportReady: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		await act(async () => screen.rerender(<TodayScreen />));
		await waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(1));
		expect(trackEvent).toHaveBeenNthCalledWith(
			1,
			"daily_recommendation_viewed",
			expect.objectContaining({ node_id: "artist:sample" }),
			expect.objectContaining({ source: "home" }),
		);
	});
});
