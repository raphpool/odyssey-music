jest.mock("expo-router", () => ({
	router: { replace: jest.fn() },
}));
jest.mock("../src/api/client", () => ({ createApiClient: jest.fn() }));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));
jest.mock("../src/profile/useProfile", () => ({
	useProfile: jest.fn(),
	profileFromState: (state: unknown) =>
		typeof state === "object" &&
		state !== null &&
		"kind" in state &&
		(state as { kind: string }).kind === "profile"
			? (state as unknown as { profile: unknown }).profile
			: undefined,
}));
jest.mock("../src/profile/store", () => ({ ProfileStore: jest.fn() }));

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import OnboardingScreen from "../app/onboarding";
import { useAnalytics } from "../src/analytics/provider";
import { createApiClient } from "../src/api/client";
import { ProfileStore } from "../src/profile/store";
import { useProfile } from "../src/profile/useProfile";
import { catalogFixture } from "./fixtures/api";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const LOCAL_ID = "22222222-2222-4222-8222-222222222222";
const catalog = {
	...catalogFixture,
	nodes: [
		{ identity: "genre:ambient", type: "genre" as const, name: "Ambient", teaser: null },
		{ identity: "genre:house", type: "genre" as const, name: "House", teaser: null },
		{ identity: "genre:jazz", type: "genre" as const, name: "Jazz", teaser: null },
	],
};

describe("music onboarding", () => {
	const trackEvent = jest.fn(async () => ({ kind: "disabled" as const }));
	const store = {
		beginDraft: jest.fn(async () => ({
			version: 1 as const,
			flow_id: FLOW_ID,
			genre_ids: [],
			started_recorded: false,
		})),
		prepareOnboardingStarted: jest.fn(async () => ({
			version: 1 as const,
			flow_id: FLOW_ID,
			event_id: "33333333-3333-4333-8333-333333333333",
			occurred_at: "2026-09-27T10:00:00.000Z",
		})),
		saveDraft: jest.fn(async () => true),
		commit: jest.fn(async ({ genreIds, flowId }: { genreIds: string[]; flowId: string }) => ({
			kind: "saved" as const,
			profile: {
				version: 1 as const,
				local_id: LOCAL_ID,
				genre_ids: genreIds,
				revision: 1,
				onboarding_completed: true,
				flow_id: flowId,
			},
		})),
		clear: jest.fn(async () => ({ kind: "cleared" as const })),
	};

	beforeEach(() => {
		jest.clearAllMocks();
		jest
			.mocked(useAnalytics)
			.mockReturnValue({ trackEvent, consent: { version: 1, status: "granted" } } as unknown as ReturnType<
				typeof useAnalytics
			>);
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: { kind: "missing" },
			reload: jest.fn(async () => ({ kind: "missing" as const })),
		} as ReturnType<typeof useProfile>);
		jest.mocked(ProfileStore).mockImplementation(() => store as never);
		jest
			.mocked(createApiClient)
			.mockReturnValue({ getCatalog: jest.fn(async () => ({ kind: "success", value: catalog })) } as never);
	});

	it("persists selection, requires three available genres and queues no taste data", async () => {
		const screen = render(<OnboardingScreen />);
		await screen.findByRole("checkbox", { name: "Ambient" });

		await waitFor(() => expect(store.prepareOnboardingStarted).toHaveBeenCalledWith(FLOW_ID));
		expect(trackEvent).not.toHaveBeenCalledWith("onboarding_started", expect.anything(), expect.anything());
		expect(screen.getByText("Continuer").props.disabled).toBe(true);
		fireEvent.press(screen.getByRole("checkbox", { name: "Ambient" }));
		await waitFor(() =>
			expect(screen.getByRole("checkbox", { name: "Ambient" }).props.accessibilityState.checked).toBe(true),
		);
		fireEvent.press(screen.getByRole("checkbox", { name: "House" }));
		await waitFor(() =>
			expect(screen.getByRole("checkbox", { name: "House" }).props.accessibilityState.checked).toBe(true),
		);
		await waitFor(() => expect(screen.getByText("Continuer").props.disabled).toBe(true));
		fireEvent.press(screen.getByRole("checkbox", { name: "Jazz" }));
		await waitFor(() => expect(screen.getByText("Continuer").props.disabled).toBe(false));
		fireEvent.press(screen.getByText("Continuer"));

		await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/(tabs)"));
		expect(store.commit).toHaveBeenCalledWith({
			genreIds: ["genre:ambient", "genre:house", "genre:jazz"],
			availableGenreIds: ["genre:ambient", "genre:house", "genre:jazz"],
			flowId: FLOW_ID,
			trackOnboardingCompletion: true,
		});
		expect(trackEvent).not.toHaveBeenCalledWith("onboarding_completed", expect.anything(), expect.anything());
		expect(JSON.stringify(trackEvent.mock.calls)).not.toContain("genre:ambient");
	});

	it("allows all choices when only two genres exist, and keeps a zero-catalog user out of false completion", async () => {
		jest.mocked(createApiClient).mockReturnValue({
			getCatalog: jest.fn(async () => ({
				kind: "success",
				value: { ...catalog, nodes: catalog.nodes.slice(0, 2) },
			})),
		} as never);
		const two = render(<OnboardingScreen />);
		await two.findByRole("checkbox", { name: "Ambient" });
		fireEvent.press(two.getByRole("checkbox", { name: "Ambient" }));
		await waitFor(() =>
			expect(two.getByRole("checkbox", { name: "Ambient" }).props.accessibilityState.checked).toBe(true),
		);
		fireEvent.press(two.getByRole("checkbox", { name: "House" }));
		await waitFor(() =>
			expect(two.getByRole("checkbox", { name: "House" }).props.accessibilityState.checked).toBe(true),
		);
		await waitFor(() => expect(two.getByText("Continuer").props.disabled).toBe(false));

		jest.mocked(createApiClient).mockReturnValue({
			getCatalog: jest.fn(async () => ({ kind: "success", value: { ...catalog, nodes: [] } })),
		} as never);
		const zero = render(<OnboardingScreen />);
		await zero.findByText(/Aucun genre n’est disponible/);
		expect(zero.queryByText("Continuer")).toBeNull();
		fireEvent.press(zero.getByText("Ouvrir la Recherche"));
		expect(router.replace).toHaveBeenCalledWith("/(tabs)/search");
	});

	it("does not emit an onboarding start while editing an existing profile", async () => {
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: {
				kind: "profile",
				profile: {
					version: 1,
					local_id: LOCAL_ID,
					genre_ids: ["genre:ambient", "genre:house", "genre:jazz"],
					revision: 1,
					onboarding_completed: true,
					flow_id: FLOW_ID,
				},
			},
			reload: jest.fn(async () => ({ kind: "missing" as const })),
		} as ReturnType<typeof useProfile>);
		const screen = render(<OnboardingScreen />);
		await screen.findByRole("checkbox", { name: "Ambient" });
		await waitFor(() => expect(store.prepareOnboardingStarted).not.toHaveBeenCalled());
		for (const name of ["Ambient", "House", "Jazz"]) {
			fireEvent.press(screen.getByRole("checkbox", { name }));
			await waitFor(() =>
				expect(screen.getByRole("checkbox", { name }).props.accessibilityState.checked).toBe(true),
			);
		}
		fireEvent.press(screen.getByText("Enregistrer mes goûts"));
		fireEvent.press(screen.getByText("Enregistrer mes goûts"));
		await waitFor(() =>
			expect(trackEvent).toHaveBeenCalledWith(
				"preferences_updated",
				{ genres_count: 3, action: "updated" },
				{ source: "settings" },
			),
		);
		expect(store.commit).toHaveBeenCalledWith(expect.objectContaining({ trackOnboardingCompletion: false }));
		expect(store.commit).toHaveBeenCalledTimes(1);
		expect(trackEvent).toHaveBeenCalledTimes(1);
	});

	it("stays on the screen and exposes retry when local persistence fails", async () => {
		store.commit.mockResolvedValueOnce({ kind: "unavailable" } as never);
		const screen = render(<OnboardingScreen />);
		await screen.findByRole("checkbox", { name: "Ambient" });
		for (const name of ["Ambient", "House", "Jazz"]) {
			fireEvent.press(screen.getByRole("checkbox", { name }));
			await waitFor(() =>
				expect(screen.getByRole("checkbox", { name }).props.accessibilityState.checked).toBe(true),
			);
		}
		await waitFor(() => expect(screen.getByText("Continuer").props.disabled).toBe(false));
		fireEvent.press(screen.getByText("Continuer"));
		await screen.findByText("Le profil n’a pas pu être enregistré. Réessayez.");
		expect(router.replace).not.toHaveBeenCalledWith("/(tabs)");
	});

	it("does not request an onboarding outbox after analytics was refused", async () => {
		jest
			.mocked(useAnalytics)
			.mockReturnValue({ trackEvent, consent: { version: 1, status: "denied" } } as unknown as ReturnType<
				typeof useAnalytics
			>);
		const screen = render(<OnboardingScreen />);
		await screen.findByRole("checkbox", { name: "Ambient" });
		for (const name of ["Ambient", "House", "Jazz"]) {
			fireEvent.press(screen.getByRole("checkbox", { name }));
			await waitFor(() =>
				expect(screen.getByRole("checkbox", { name }).props.accessibilityState.checked).toBe(true),
			);
		}
		fireEvent.press(screen.getByText("Continuer"));
		await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/(tabs)"));
		expect(store.commit).toHaveBeenCalledWith(expect.objectContaining({ trackOnboardingCompletion: false }));
		expect(store.prepareOnboardingStarted).not.toHaveBeenCalled();
		expect(trackEvent).not.toHaveBeenCalled();
	});

	it("does not create a draft or analytics start while the profile store is unavailable", async () => {
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: { kind: "unavailable" },
			reload: jest.fn(async () => ({ kind: "unavailable" as const })),
		} as ReturnType<typeof useProfile>);
		const screen = render(<OnboardingScreen />);
		await screen.findByText("Le stockage local est indisponible. Réessayez avant de choisir vos goûts.");
		expect(store.beginDraft).not.toHaveBeenCalled();
		expect(store.prepareOnboardingStarted).not.toHaveBeenCalled();
		expect(trackEvent).not.toHaveBeenCalled();
	});

	it("keeps analytics withdrawal reachable when local profile storage is unavailable", async () => {
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: { kind: "unavailable" },
			reload: jest.fn(async () => ({ kind: "unavailable" as const })),
		} as ReturnType<typeof useProfile>);
		const screen = render(<OnboardingScreen />);
		await screen.findByText("Le stockage local est indisponible. Réessayez avant de choisir vos goûts.");
		fireEvent.press(screen.getByText("Ouvrir les Réglages"));
		expect(router.replace).toHaveBeenCalledWith("/(tabs)/settings");
	});
});
