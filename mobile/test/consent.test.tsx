jest.mock("expo-router", () => ({
	router: { back: jest.fn(), replace: jest.fn() },
	useLocalSearchParams: jest.fn(),
}));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";

import PrivacyChoiceScreen, { safeInternalReturnTo } from "../app/privacy-choice";
import { useAnalytics } from "../src/analytics/provider";

describe("privacy choice", () => {
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

	it("keeps an undecided user in front of the application", () => {
		const screen = render(<PrivacyChoiceScreen />);

		expect(screen.getByRole("header", { name: "Mesure d’usage" })).toBeTruthy();
		expect(router.replace).not.toHaveBeenCalled();
	});

	it("accepts only one press and continues to a safe internal destination", async () => {
		let finishGrant: (() => void) | undefined;
		const grant = jest.fn(
			() =>
				new Promise<void>((resolve) => {
					finishGrant = resolve;
				}),
		);
		jest.mocked(useLocalSearchParams).mockReturnValue({ returnTo: "/node/artist%3Amassive-attack" });
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "unknown" },
			configured: true,
			purgeIncomplete: false,
			grant,
			deny: async () => undefined,
			trackEvent: async () => ({ kind: "disabled" }),
		});
		const screen = render(<PrivacyChoiceScreen />);
		const accept = screen.getByLabelText("Accepter la mesure d’usage");

		fireEvent.press(accept);
		fireEvent.press(accept);
		expect(grant).toHaveBeenCalledTimes(1);
		finishGrant?.();

		await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/node/artist%3Amassive-attack"));
	});

	it("returns to settings by replacement after an internal edit and rejects external return paths", async () => {
		jest.mocked(useLocalSearchParams).mockReturnValue({ mode: "edit", returnTo: "/(tabs)/settings" });
		jest.mocked(useAnalytics).mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted", decidedAt: "2026-09-27T00:00:00.000Z" },
			configured: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent: async () => ({ kind: "disabled" }),
		});
		const screen = render(<PrivacyChoiceScreen />);

		fireEvent.press(screen.getByLabelText("Refuser la mesure d’usage"));

		await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/(tabs)/settings"));
		expect(router.back).not.toHaveBeenCalled();
		expect(safeInternalReturnTo("//example.test")).toBe("/");
		expect(safeInternalReturnTo("/%2f%2fexample.test")).toBe("/");
	});

	it("treats an external edit parameter as an initial choice and keeps actions reachable", async () => {
		jest.mocked(useLocalSearchParams).mockReturnValue({ mode: "edit", returnTo: "//example.test" });
		const screen = render(<PrivacyChoiceScreen />);

		fireEvent.press(screen.getByLabelText("Refuser la mesure d’usage"));

		await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
		expect(router.back).not.toHaveBeenCalled();
		expect(screen.UNSAFE_getByType(ScrollView).props.contentContainerStyle).toEqual(
			expect.objectContaining({ flexGrow: 1 }),
		);
	});
});
