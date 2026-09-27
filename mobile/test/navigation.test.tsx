import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import { ScrollView } from "react-native";

import RootLayout from "../app/_layout";
import TabsLayout from "../app/(tabs)/_layout";
import TodayScreen from "../app/(tabs)/index";
import SearchScreen from "../app/(tabs)/search";
import SettingsScreen from "../app/(tabs)/settings";
import RootIndex from "../app/index";
import { useAnalytics } from "../src/analytics/provider";
import { ConfigurationError } from "../src/components/ConfigurationError";
import { readPublicConfig } from "../src/config";

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

const mockedReadPublicConfig = readPublicConfig as jest.MockedFunction<typeof readPublicConfig>;

describe("track1 navigation", () => {
	beforeEach(() => {
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
