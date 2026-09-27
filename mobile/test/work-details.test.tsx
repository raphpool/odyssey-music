import { fireEvent, render } from "@testing-library/react-native";
import type { NodeEdgeRef } from "../src/components/NodeRelations";
import type { NodeNavigationContext } from "../src/navigation/context";

const mockRouterPush = jest.fn();
const mockTrackEvent = jest.fn().mockResolvedValue({ kind: "accepted" });
const navigationContext: NodeNavigationContext = { source: "home" };

jest.mock("expo-router", () => ({ router: { push: mockRouterPush } }));
jest.mock("../src/analytics/provider", () => ({
	useAnalytics: () => ({ consent: { status: "granted" }, trackEvent: mockTrackEvent }),
}));

const { ArtistDetails } = jest.requireActual(
	"../src/components/ArtistDetails",
) as typeof import("../src/components/ArtistDetails");
const { ProjectDetails } = jest.requireActual(
	"../src/components/ProjectDetails",
) as typeof import("../src/components/ProjectDetails");
const { TrackDetails } = jest.requireActual(
	"../src/components/TrackDetails",
) as typeof import("../src/components/TrackDetails");

function edge(slug: string, type: NodeEdgeRef["type"], name: string): NodeEdgeRef {
	return { slug, type, name };
}

describe("specialized node details", () => {
	beforeEach(() => {
		mockRouterPush.mockClear();
		mockTrackEvent.mockClear();
	});

	it("presents artist facts and every supported relation without empty groups", () => {
		const { getByText, queryByText } = render(
			<ArtistDetails
				edges={{
					genres: [edge("genre:jazz", "genre", "Jazz")],
					labels: edge("label:blue-note", "label", "Blue Note"),
					discography: [edge("project:kind-of-blue", "project", "Kind of Blue")],
					notable_tracks: [edge("track:so-what", "track", "So What")],
					influences: edge("artist:duke-ellington", "artist", "Duke Ellington"),
					influenced: edge("artist:future-artist", "artist", "Future Artist"),
					collaborators: edge("artist:john-coltrane", "artist", "John Coltrane"),
					aliases: edge("artist:miles-davis", "artist", "Miles Dewey Davis"),
					members: [],
				}}
				facts={{ origin: "Alton, Illinois", active_years: "1944–1991" }}
				fromNodeId="artist:miles-davis"
				navigationContext={navigationContext}
			/>,
		);

		expect(getByText("Origine")).toBeTruthy();
		expect(getByText("Alton, Illinois")).toBeTruthy();
		expect(getByText("Période d’activité")).toBeTruthy();
		expect(getByText("Kind of Blue")).toBeTruthy();
		expect(getByText("So What")).toBeTruthy();
		expect(getByText("Duke Ellington")).toBeTruthy();
		expect(getByText("John Coltrane")).toBeTruthy();
		expect(queryByText("members")).toBeNull();
	});

	it.each([
		["album", "Album"],
		["ep", "EP"],
		["single", "Single"],
		["mixtape", "Projet"],
		[undefined, "Projet"],
	])("labels a %s release as %s", (releaseType, expectedLabel) => {
		const { getByText, queryByText } = render(
			<ProjectDetails
				edges={{}}
				facts={releaseType === undefined ? {} : { release_type: releaseType }}
				fromNodeId="project:release"
				navigationContext={navigationContext}
			/>,
		);

		expect(getByText(expectedLabel)).toBeTruthy();
		if (releaseType === "mixtape") expect(queryByText("mixtape")).toBeNull();
	});

	it("presents project and track facts, ordered relations, and long text", () => {
		const longNotes = "A detailed production note that remains readable on a narrow mobile screen.";
		const project = render(
			<ProjectDetails
				edges={{
					artists: [edge("artist:producer", "artist", "Producer")],
					tracklist: [edge("track:intro", "track", "Intro"), edge("track:finale", "track", "Finale")],
					genres: edge("genre:ambient", "genre", "Ambient"),
				}}
				facts={{ year: "2024", bpm: "120", musical_key: "C minor", vocals: "None", samples_notes: longNotes }}
				fromNodeId="project:release"
				navigationContext={navigationContext}
			/>,
		);
		expect(project.getByText("Année")).toBeTruthy();
		expect(project.getByText(longNotes)).toBeTruthy();
		expect(project.getByText("Intro")).toBeTruthy();
		expect(project.getByText("Finale")).toBeTruthy();

		const track = render(
			<TrackDetails
				edges={{
					artists: edge("artist:guest", "artist", "Guest"),
					samples: edge("track:source", "track", "Source"),
				}}
				facts={{ year: "2024", duration: "3:45", inspirations: "A long-form inspiration" }}
				fromNodeId="track:single"
				navigationContext={navigationContext}
			/>,
		);
		expect(track.getByText("Durée")).toBeTruthy();
		expect(track.getByText("3:45")).toBeTruthy();
		expect(track.getByText("Guest")).toBeTruthy();
		expect(track.queryByText("Projet")).toBeNull();
	});

	it("keeps relation navigation and analytics contracts", () => {
		const { getByRole } = render(
			<TrackDetails
				edges={{ projects: edge("project:album", "project", "Album") }}
				facts={{}}
				fromNodeId="track:single"
				navigationContext={navigationContext}
			/>,
		);

		fireEvent.press(getByRole("button", { name: "Ouvrir Album" }));

		expect(mockRouterPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/node/[slug]" }));
		expect(mockTrackEvent).toHaveBeenCalledWith(
			"relation_opened",
			expect.objectContaining({ from_node_id: "track:single", node_id: "project:album" }),
			expect.objectContaining({ source: "relation" }),
		);
	});

	it("omits empty fact and relation sections", () => {
		const { queryByText } = render(
			<TrackDetails
				edges={{ genres: [], artists: [] }}
				facts={{ year: "", duration: "   " }}
				fromNodeId="track:empty"
				navigationContext={navigationContext}
			/>,
		);

		expect(queryByText("Détails du morceau")).toBeNull();
		expect(queryByText("Explorer les relations")).toBeNull();
	});
});
