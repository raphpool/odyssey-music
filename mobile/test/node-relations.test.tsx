import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import { useAnalytics } from "../src/analytics/provider";
import { NodeRelations } from "../src/components/NodeRelations";

jest.mock("expo-router", () => ({
	router: { push: jest.fn() },
}));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));

const mockedUseAnalytics = jest.mocked(useAnalytics);
const mockedRouter = jest.mocked(router);

describe("NodeRelations", () => {
	const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));

	beforeEach(() => {
		jest.clearAllMocks();
		mockedUseAnalytics.mockReturnValue({
			ready: true,
			consent: { version: 1, status: "granted" },
			configured: true,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
	});

	it("renders simple and array relations and pushes a new stack entry with attribution", () => {
		const screen = render(
			<NodeRelations
				fromNodeId="artist:massive-attack"
				navigationContext={{
					source: "home",
					recommendation_id: "22222222-2222-4222-8222-222222222222",
				}}
				edges={{
					projects: {
						slug: "project:blue-lines",
						type: "project",
						name: "Blue Lines",
					},
					artists: [
						{ slug: "artist:tricky", type: "artist", name: "Tricky" },
						{ slug: "artist:dummy", type: "artist", name: "Dummy" },
					],
					empty: [],
				}}
			/>,
		);

		expect(screen.getByText("Projets")).toBeTruthy();
		expect(screen.getByText("Blue Lines")).toBeTruthy();
		expect(screen.getByText("Artistes")).toBeTruthy();
		expect(screen.getByText("Tricky")).toBeTruthy();
		expect(screen.queryByText("Empty")).toBeNull();

		fireEvent.press(screen.getByRole("button", { name: "Ouvrir Blue Lines" }));
		fireEvent.press(screen.getByRole("button", { name: "Ouvrir Blue Lines" }));

		expect(trackEvent).toHaveBeenCalledWith(
			"relation_opened",
			{
				from_node_id: "artist:massive-attack",
				node_id: "project:blue-lines",
				node_type: "project",
				relation_kind: "projects",
				recommendation_id: "22222222-2222-4222-8222-222222222222",
			},
			{ source: "relation", recommendation_id: "22222222-2222-4222-8222-222222222222" },
		);
		expect(mockedRouter.push).toHaveBeenCalledWith({
			pathname: "/node/[slug]",
			params: {
				slug: "project:blue-lines",
				source: "home",
				recommendation_id: "22222222-2222-4222-8222-222222222222",
			},
		});
	});

	it("navigates after a denied consent without collecting relation analytics", () => {
		mockedUseAnalytics.mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
		const screen = render(
			<NodeRelations
				fromNodeId="genre:trip-hop"
				navigationContext={{ source: "deeplink" }}
				edges={{ influences: { slug: "artist:portishead", type: "artist", name: "Portishead" } }}
			/>,
		);

		fireEvent.press(screen.getByRole("button", { name: "Ouvrir Portishead" }));

		expect(trackEvent).not.toHaveBeenCalled();
		expect(mockedRouter.push).toHaveBeenCalledWith({
			pathname: "/node/[slug]",
			params: { slug: "artist:portishead", source: "deeplink" },
		});
	});
});
