import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";

import { useAnalytics } from "../src/analytics/provider";
import { GenreDetails } from "../src/components/GenreDetails";
import { LabelDetails } from "../src/components/LabelDetails";

jest.mock("expo-router", () => ({
	router: { push: jest.fn() },
}));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));

const mockedUseAnalytics = jest.mocked(useAnalytics);
const mockedRouter = jest.mocked(router);

describe("GenreDetails", () => {
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

	it("renders genre facts and every ordered relation with French labels", () => {
		const screen = render(
			<GenreDetails
				node={{
					id: "genre:trip-hop",
					facts: { era: "1990s", origin: "Bristol", sonic_markers: "Breakbeats, bass" },
					edges: {
						parent_genres: { slug: "genre:electronic", type: "genre", name: "Electronic" },
						subgenres: [{ slug: "genre:future-garage", type: "genre", name: "Future garage" }],
						related_genres: [{ slug: "genre:downtempo", type: "genre", name: "Downtempo" }],
						key_artists: [{ slug: "artist:massive-attack", type: "artist", name: "Massive Attack" }],
						key_labels: [{ slug: "label:mo-wax", type: "label", name: "Mo' Wax" }],
						landmark_projects: [{ slug: "project:blue-lines", type: "project", name: "Blue Lines" }],
						landmark_tracks: [
							{ slug: "track:unfinished-sympathy", type: "track", name: "Unfinished Sympathy" },
						],
					},
				}}
				navigationContext={{ source: "home", recommendation_id: "22222222-2222-4222-8222-222222222222" }}
			/>,
		);

		expect(screen.getByText("Repères du genre")).toBeTruthy();
		expect(screen.getByText("Époque")).toBeTruthy();
		expect(screen.getByText("Marqueurs sonores")).toBeTruthy();
		expect(screen.getByText("Genres parents")).toBeTruthy();
		expect(screen.getByText("Sous-genres")).toBeTruthy();
		expect(screen.getByText("Genres associés")).toBeTruthy();
		expect(screen.getByText("Artistes clés")).toBeTruthy();
		expect(screen.getByText("Labels clés")).toBeTruthy();
		expect(screen.getByText("Projets marquants")).toBeTruthy();
		expect(screen.getByText("Titres marquants")).toBeTruthy();
		expect(screen.getByText("Future garage")).toBeTruthy();
		expect(screen.getByText("Unfinished Sympathy")).toBeTruthy();

		fireEvent.press(screen.getByRole("button", { name: "Ouvrir Massive Attack" }));
		fireEvent.press(screen.getByRole("button", { name: "Ouvrir Massive Attack" }));

		expect(trackEvent).toHaveBeenCalledTimes(1);
		expect(trackEvent).toHaveBeenCalledWith(
			"relation_opened",
			{
				from_node_id: "genre:trip-hop",
				node_id: "artist:massive-attack",
				node_type: "artist",
				relation_kind: "key_artists",
				recommendation_id: "22222222-2222-4222-8222-222222222222",
			},
			{ source: "relation", recommendation_id: "22222222-2222-4222-8222-222222222222" },
		);
		expect(mockedRouter.push).toHaveBeenCalledWith({
			pathname: "/node/[slug]",
			params: {
				slug: "artist:massive-attack",
				source: "home",
				recommendation_id: "22222222-2222-4222-8222-222222222222",
			},
		});
	});

	it("keeps cyclic relations and omits empty or absent fields", () => {
		const screen = render(
			<GenreDetails
				node={{
					id: "genre:ambient",
					facts: {},
					edges: {
						parent_genres: [{ slug: "genre:electronic", type: "genre", name: "Electronic" }],
						subgenres: [{ slug: "genre:ambient", type: "genre", name: "Ambient" }],
						related_genres: [],
					},
				}}
				navigationContext={{ source: "deeplink" }}
			/>,
		);

		expect(screen.getByText("Genres parents")).toBeTruthy();
		expect(screen.getByText("Sous-genres")).toBeTruthy();
		expect(screen.getByText("Electronic")).toBeTruthy();
		expect(screen.getByText("Ambient")).toBeTruthy();
		expect(screen.queryByText("Genres associés")).toBeNull();
		expect(screen.queryByText("Repères du genre")).toBeNull();
	});
});

describe("LabelDetails", () => {
	const trackEvent = jest.fn(async () => ({ kind: "accepted" as const }));

	beforeEach(() => {
		jest.clearAllMocks();
		mockedUseAnalytics.mockReturnValue({
			ready: true,
			consent: { version: 1, status: "denied" },
			configured: false,
			purgeIncomplete: false,
			grant: async () => undefined,
			deny: async () => undefined,
			trackEvent,
		});
	});

	it("renders partial label details, navigates without audio actions, and respects denied consent", () => {
		const screen = render(
			<LabelDetails
				node={{
					id: "label:warp",
					facts: { founded: "1989", location: "Sheffield" },
					edges: {
						genres: [{ slug: "genre:electronic", type: "genre", name: "Electronic" }],
						roster: [],
					},
				}}
				navigationContext={{ source: "search" }}
			/>,
		);

		expect(screen.getByText("Repères du label")).toBeTruthy();
		expect(screen.getByText("Fondé en")).toBeTruthy();
		expect(screen.getByText("Localisation")).toBeTruthy();
		expect(screen.getByText("Genres")).toBeTruthy();
		expect(screen.getByText("Electronic")).toBeTruthy();
		expect(screen.queryByText("Fondateurs")).toBeNull();
		expect(screen.queryByText("Artistes du catalogue")).toBeNull();
		expect(screen.queryByText("Sorties notables")).toBeNull();
		expect(screen.queryByText("Écouter ailleurs")).toBeNull();

		fireEvent.press(screen.getByRole("button", { name: "Ouvrir Electronic" }));

		expect(trackEvent).not.toHaveBeenCalled();
		expect(mockedRouter.push).toHaveBeenCalledWith({
			pathname: "/node/[slug]",
			params: { slug: "genre:electronic", source: "search" },
		});
	});
});
