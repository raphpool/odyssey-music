import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, usePathname } from "expo-router";
import { Alert, ScrollView } from "react-native";

import RootLayout from "../app/_layout";
import TabsLayout from "../app/(tabs)/_layout";
import TodayScreen from "../app/(tabs)/index";
import SearchScreen from "../app/(tabs)/search";
import SettingsScreen from "../app/(tabs)/settings";
import RootIndex from "../app/index";
import { useAnalytics } from "../src/analytics/provider";
import { ConfigurationError } from "../src/components/ConfigurationError";
import { readPublicConfig } from "../src/config";
import { ProfileStore } from "../src/profile/store";
import { useProfile } from "../src/profile/useProfile";

const mockOutboxListeners = new Set<() => void>();

jest.mock("expo-router", () => {
	const React = require("react");
	const { Text, View } = require("react-native");

	const createNavigator = (testID: string) => {
		const Navigator = (props: { children?: React.ReactNode; [key: string]: unknown }) =>
			React.createElement(View, { testID, ...props }, props.children);

		Navigator.Screen = ({ name, options }: { name: string; options?: Record<string, unknown> }) =>
			React.createElement(View, {
				accessibilityLabel: options?.tabBarAccessibilityLabel ?? options?.title ?? name,
				testID: `${testID}-${name}-screen`,
			});

		return Navigator;
	};

	return {
		Redirect: ({ href }: { href: string }) => React.createElement(Text, { testID: "redirect-target" }, href),
		router: { push: jest.fn(), replace: jest.fn() },
		Stack: createNavigator("stack-navigator"),
		Tabs: createNavigator("tabs-navigator"),
		useGlobalSearchParams: jest.fn(() => ({ entry: "direct" })),
		useLocalSearchParams: jest.fn(() => ({})),
		usePathname: jest.fn(() => "/onboarding"),
	};
});

jest.mock("../src/config", () => ({
	readPublicConfig: jest.fn(),
}));
jest.mock("../src/analytics/provider", () => {
	const React = require("react");
	return {
		AnalyticsProvider: ({ children }: { children?: React.ReactNode }) => children,
		analyticsStatusLabel: (status: string) => status,
		useAnalytics: jest.fn(),
	};
});
jest.mock("../src/profile/useProfile", () => {
	const React = require("react");
	return {
		ProfileProvider: ({ children }: { children?: React.ReactNode }) => children,
		profileFromState: (state: unknown) =>
			typeof state === "object" &&
			state !== null &&
			"kind" in state &&
			(state as { kind: string }).kind === "profile"
				? (state as unknown as { profile: unknown }).profile
				: undefined,
		useProfile: jest.fn(),
	};
});
jest.mock("../src/profile/store", () => {
	const ProfileStore = jest.fn();
	Object.assign(ProfileStore, {
		subscribeOnboardingOutbox: (listener: () => void) => {
			mockOutboxListeners.add(listener);
			return () => mockOutboxListeners.delete(listener);
		},
	});
	return { ProfileStore };
});

const mockedReadPublicConfig = readPublicConfig as jest.MockedFunction<typeof readPublicConfig>;

describe("track1 navigation", () => {
	const completionStore = {
		readOnboardingStarted: jest.fn(async (): Promise<unknown> => undefined),
		acknowledgeOnboardingStarted: jest.fn(async () => true),
		onboardingOutboxPurgePending: jest.fn(async () => false),
		discardOnboardingOutboxes: jest.fn(async () => true),
		clear: jest.fn(async () => ({ kind: "cleared" as const })),
		readOnboardingCompletion: jest.fn(async (): Promise<unknown> => undefined),
		acknowledgeOnboardingCompletion: jest.fn(async () => true),
	};
	beforeEach(() => {
		mockOutboxListeners.clear();
		jest.mocked(ProfileStore).mockImplementation(() => completionStore as never);
		jest.mocked(usePathname).mockReturnValue("/onboarding");
		completionStore.readOnboardingStarted.mockResolvedValue(undefined);
		completionStore.onboardingOutboxPurgePending.mockResolvedValue(false);
		completionStore.acknowledgeOnboardingStarted.mockResolvedValue(true);
		completionStore.discardOnboardingOutboxes.mockResolvedValue(true);
		completionStore.clear.mockResolvedValue({ kind: "cleared" });
		completionStore.readOnboardingCompletion.mockResolvedValue(undefined);
		completionStore.acknowledgeOnboardingCompletion.mockResolvedValue(true);
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: { kind: "profile", profile: { genre_ids: [], revision: 1 } },
			reload: async () => ({ kind: "missing" }),
		} as unknown as ReturnType<typeof useProfile>);
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
	afterEach(() => jest.clearAllMocks());
	it("opens the French Today tab through the root route", () => {
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);
		const bootstrap = render(<RootIndex />);
		expect(bootstrap.getByTestId("redirect-target").props.children).toBe("/(tabs)");
		const tabs = render(<TabsLayout />);
		expect(tabs.getByTestId("tabs-navigator-index-screen").props.accessibilityLabel).toBe("Aujourd'hui");
		expect(tabs.getByTestId("tabs-navigator-search-screen").props.accessibilityLabel).toBe("Recherche");
		expect(tabs.getByTestId("tabs-navigator-settings-screen").props.accessibilityLabel).toBe("Réglages");
	});

	it("blocks a direct tab launch when public configuration is invalid", () => {
		mockedReadPublicConfig.mockReturnValue({ ok: false, error: {} } as ReturnType<typeof readPublicConfig>);

		const root = render(<RootLayout />);

		expect(root.getByRole("alert")).toBeTruthy();
		expect(root.getByText("Configuration requise")).toBeTruthy();
		expect(root.queryByTestId("stack-navigator")).toBeNull();
	});

	it("gates onboarding until an unknown consent choice is made", () => {
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		const root = render(<RootLayout />);
		const applicationNavigator = root.UNSAFE_getByProps({ testID: "application-navigator" });

		expect(applicationNavigator.props.importantForAccessibility).toBe("no-hide-descendants");
		expect(applicationNavigator.props.accessibilityElementsHidden).toBe(true);
		expect(root.getByLabelText("Chargement du choix de mesure")).toBeTruthy();
		expect(root.queryByTestId("stack-navigator")).toBeNull();
		expect(root.queryByLabelText("Bienvenue")).toBeNull();
		expect(router.replace).toHaveBeenCalledWith({
			pathname: "/privacy-choice",
			params: { returnTo: "/onboarding?entry=direct" },
		});
	});

	it("replays a persisted onboarding completion with its stable event id once consent is granted", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		completionStore.readOnboardingCompletion.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "22222222-2222-4222-8222-222222222222",
			genres_count: 3,
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			transportReady: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		const view = render(<RootLayout />);
		await waitFor(() => expect(completionStore.readOnboardingCompletion).toHaveBeenCalled());
		expect(trackEvent).not.toHaveBeenCalled();
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			transportReady: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		view.rerender(<RootLayout />);

		await waitFor(() =>
			expect(trackEvent).toHaveBeenCalledWith(
				"onboarding_completed",
				{ flow_id: "11111111-1111-4111-8111-111111111111", genres_count: 3 },
				{
					source: "onboarding",
					event_id: "22222222-2222-4222-8222-222222222222",
					occurred_at: "2026-09-27T10:00:00.000Z",
				},
			),
		);
		expect(completionStore.acknowledgeOnboardingCompletion).toHaveBeenCalledWith(
			"22222222-2222-4222-8222-222222222222",
		);
	});

	it("keeps Recherche reachable before a profile exists", () => {
		jest.mocked(usePathname).mockReturnValue("/search");
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: { kind: "missing" },
			reload: async () => ({ kind: "missing" }),
		} as unknown as ReturnType<typeof useProfile>);
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent: async () => ({ kind: "disabled" }),
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		const root = render(<RootLayout />);

		expect(root.getByTestId("stack-navigator")).toBeTruthy();
		expect(router.replace).not.toHaveBeenCalledWith("/onboarding");
	});

	it("keeps Réglages reachable before a profile exists so analytics can be withdrawn", () => {
		jest.mocked(usePathname).mockReturnValue("/settings");
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: { kind: "corrupt" },
			reload: async () => ({ kind: "corrupt" }),
		} as unknown as ReturnType<typeof useProfile>);
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent: async () => ({ kind: "disabled" }),
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		const root = render(<RootLayout />);

		expect(root.getByTestId("stack-navigator")).toBeTruthy();
		expect(router.replace).not.toHaveBeenCalledWith("/onboarding");
	});

	it("discards a pending completion without emitting it after analytics was refused", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "disabled" as const }));
		completionStore.readOnboardingCompletion.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "22222222-2222-4222-8222-222222222222",
			genres_count: 3,
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		render(<RootLayout />);

		await waitFor(() => expect(completionStore.discardOnboardingOutboxes).toHaveBeenCalledTimes(1));
		expect(trackEvent).not.toHaveBeenCalled();
	});

	it("purges pending onboarding events after refusal even without a readable profile", async () => {
		completionStore.readOnboardingStarted.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "33333333-3333-4333-8333-333333333333",
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		completionStore.readOnboardingCompletion.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "22222222-2222-4222-8222-222222222222",
			genres_count: 3,
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		jest.mocked(useProfile).mockReturnValue({
			ready: true,
			state: { kind: "unavailable" },
			reload: async () => ({ kind: "unavailable" }),
		} as unknown as ReturnType<typeof useProfile>);
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent: async () => ({ kind: "disabled" }),
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		render(<RootLayout />);

		await waitFor(() => expect(completionStore.discardOnboardingOutboxes).toHaveBeenCalledTimes(1));
	});

	it("retries an unavailable denied-consent purge without emitting an onboarding event", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "disabled" as const }));
		const timeout = jest.spyOn(globalThis, "setTimeout");
		completionStore.discardOnboardingOutboxes.mockResolvedValueOnce(false);
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		render(<RootLayout />);

		await waitFor(() => expect(completionStore.discardOnboardingOutboxes).toHaveBeenCalledTimes(1));
		expect(timeout).toHaveBeenCalled();
		expect(trackEvent).not.toHaveBeenCalled();
		timeout.mockRestore();
	});

	it("never replays old events when analytics is regranted before a failed purge retry", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		completionStore.discardOnboardingOutboxes.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);
		const view = render(<RootLayout />);
		await waitFor(() => expect(completionStore.discardOnboardingOutboxes).toHaveBeenCalledTimes(1));

		completionStore.onboardingOutboxPurgePending.mockResolvedValue(true);
		completionStore.readOnboardingStarted.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "33333333-3333-4333-8333-333333333333",
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			transportReady: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		view.rerender(<RootLayout />);

		await waitFor(() => expect(completionStore.discardOnboardingOutboxes).toHaveBeenCalledTimes(2));
		expect(trackEvent).not.toHaveBeenCalled();
	});

	it("replays a pending onboarding start only when Segment reports ready", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		completionStore.readOnboardingStarted.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "33333333-3333-4333-8333-333333333333",
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			transportReady: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		const view = render(<RootLayout />);
		await waitFor(() => expect(completionStore.readOnboardingStarted).toHaveBeenCalled());
		expect(trackEvent).not.toHaveBeenCalled();
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			transportReady: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		view.rerender(<RootLayout />);

		await waitFor(() =>
			expect(trackEvent).toHaveBeenCalledWith(
				"onboarding_started",
				{ flow_id: "11111111-1111-4111-8111-111111111111" },
				{
					source: "onboarding",
					event_id: "33333333-3333-4333-8333-333333333333",
					occurred_at: "2026-09-27T10:00:00.000Z",
				},
			),
		);
		expect(completionStore.acknowledgeOnboardingStarted).toHaveBeenCalledWith(
			"33333333-3333-4333-8333-333333333333",
		);
	});

	it("retries each non-accepted onboarding event independently", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "disabled" as const }));
		completionStore.readOnboardingStarted.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "33333333-3333-4333-8333-333333333333",
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		completionStore.readOnboardingCompletion.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "22222222-2222-4222-8222-222222222222",
			genres_count: 3,
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			transportReady: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);

		render(<RootLayout />);

		await waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(2));
	});

	it("wakes the worker when onboarding starts after Segment is already ready", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			transportReady: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		mockedReadPublicConfig.mockReturnValue({ ok: true, value: {} } as ReturnType<typeof readPublicConfig>);
		render(<RootLayout />);
		await waitFor(() => expect(completionStore.readOnboardingStarted).toHaveBeenCalled());
		completionStore.readOnboardingStarted.mockResolvedValue({
			flow_id: "11111111-1111-4111-8111-111111111111",
			event_id: "33333333-3333-4333-8333-333333333333",
			occurred_at: "2026-09-27T10:00:00.000Z",
		});
		await act(async () => {
			for (const listener of mockOutboxListeners) listener();
		});

		await waitFor(() =>
			expect(trackEvent).toHaveBeenCalledWith(
				"onboarding_started",
				{ flow_id: "11111111-1111-4111-8111-111111111111" },
				{
					source: "onboarding",
					event_id: "33333333-3333-4333-8333-333333333333",
					occurred_at: "2026-09-27T10:00:00.000Z",
				},
			),
		);
	});

	it("keeps tab screens mounted when the active tab changes", () => {
		const tabs = render(<TabsLayout />);

		expect(tabs.getByTestId("tabs-navigator").props.backBehavior).toBe("history");
		expect(tabs.getByTestId("tabs-navigator").props.detachInactiveScreens).toBe(false);
	});

	it("exposes accessible, scalable screen content without audio commands", () => {
		const today = render(<TodayScreen />);
		expect(today.getByRole("header").props.allowFontScaling).toBe(true);

		const search = render(<SearchScreen />);
		const input = search.getByLabelText("Rechercher dans Odyssey");
		expect(input.props.allowFontScaling).toBe(true);
		fireEvent.changeText(input, "ambient");
		expect(input.props.value).toBe("ambient");

		const settings = render(<SettingsScreen />);
		expect(settings.getByRole("header").props.allowFontScaling).toBe(true);
		expect(settings.UNSAFE_getByType(ScrollView).props.contentContainerStyle).toEqual(
			expect.objectContaining({ flexGrow: 1 }),
		);
		fireEvent.press(settings.getByLabelText("Modifier le choix de mesure d’usage"));
		expect(router.push).toHaveBeenCalledWith({
			pathname: "/privacy-choice",
			params: { mode: "edit", returnTo: "/(tabs)/settings" },
		});
	});

	it("clears the profile and emits its preference event only once after duplicate confirmation", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, actions) => {
			const confirm = actions?.find((action) => action.text === "Effacer")?.onPress;
			confirm?.();
			confirm?.();
		});
		const settings = render(<SettingsScreen />);

		fireEvent.press(settings.getByLabelText("Effacer le profil musical"));

		await waitFor(() => expect(completionStore.clear).toHaveBeenCalledTimes(1));
		expect(trackEvent).toHaveBeenCalledWith(
			"preferences_updated",
			{ genres_count: 0, action: "cleared" },
			{ source: "settings" },
		);
		expect(router.replace).toHaveBeenCalledWith("/onboarding");
		alert.mockRestore();
	});

	it("keeps long configuration guidance reachable on a small screen", () => {
		const cause = "Cause publique ".repeat(40);
		const instruction = "Instruction de configuration ".repeat(40);
		const screen = render(<ConfigurationError cause={cause} instruction={instruction} />);

		expect(screen.UNSAFE_getByType(ScrollView).props.contentContainerStyle).toEqual(
			expect.objectContaining({ flexGrow: 1 }),
		);
		expect(screen.getByText(cause)).toBeTruthy();
		expect(screen.getByText(instruction)).toBeTruthy();
	});

	it("shows a public configuration error without attempting network access", () => {
		mockedReadPublicConfig.mockReturnValue({ ok: false, error: {} } as ReturnType<typeof readPublicConfig>);
		const fetchSpy = jest.spyOn(globalThis, "fetch");

		const screen = render(<RootIndex />);

		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.getByText("Configuration requise")).toBeTruthy();
		expect(screen.getByText(/Aucun appel réseau n'a été effectué/)).toBeTruthy();
		expect(screen.queryByTestId("redirect-target")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();

		fetchSpy.mockRestore();
	});
});
