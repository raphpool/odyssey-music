import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useLocalSearchParams } from "expo-router";

import NodeScreen from "../app/node/[slug]";
import { useAnalytics } from "../src/analytics/provider";
import { createApiClient } from "../src/api/client";

jest.mock("expo-router", () => ({
	useLocalSearchParams: jest.fn(),
	router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock("../src/api/client", () => ({ createApiClient: jest.fn() }));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));

const mockedUseLocalSearchParams = jest.mocked(useLocalSearchParams);
const mockedCreateApiClient = jest.mocked(createApiClient);
const mockedUseAnalytics = jest.mocked(useAnalytics);

type NodeType = "artist" | "project" | "track" | "genre" | "label";

const analytics = {
	ready: true,
	consent: { version: 1 as const, status: "granted" as const },
	configured: true,
	purgeIncomplete: false,
	grant: async () => undefined,
	deny: async () => undefined,
	trackEvent: jest.fn(async (): Promise<{ kind: "accepted" | "disabled" }> => ({ kind: "accepted" })),
};

function nodeResponse(type: NodeType, name: string, id = `${type}:sample-node`) {
	return {
		node: {
			id,
			type,
			name,
			teaser: "Une courte présentation.",
			article: "Introduction.\n\n- Premier élément\n- Second élément\n\n<script>ne pas exécuter</script>",
			citations: [
				{ url: "https://example.com/source", title: "Source fiable" },
				{ url: "javascript:alert(1)", title: "Source hostile" },
			],
			edges: {},
			facts: {},
			materialized_at: "2026-09-27T00:00:00.000Z",
		},
		source: "cache" as const,
	};
}

function success(value: unknown) {
	return { kind: "success" as const, value };
}

describe("NodeScreen", () => {
	let getNode: jest.Mock;
	let getImage: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
		mockedUseLocalSearchParams.mockReturnValue({ slug: "artist:sample-node", source: "home" });
		mockedUseAnalytics.mockReturnValue(analytics);
		getNode = jest.fn(async () => success(nodeResponse("artist", "Artiste exemple")));
		getImage = jest.fn(async () =>
			success({
				slug: "artist:sample-node",
				image_url: null,
				source: "cache",
			}),
		);
		mockedCreateApiClient.mockReturnValue({
			getNode,
			getImage,
		} as unknown as ReturnType<typeof createApiClient>);
	});

	it.each([
		["artist", "Artiste exemple", "Artiste"],
		["project", "Projet exemple", "Projet"],
		["track", "Titre exemple", "Morceau"],
		["genre", "Genre exemple", "Genre"],
		["label", "Label exemple", "Label"],
	] as const)("renders the common native presentation for %s", async (type, name, label) => {
		mockedUseLocalSearchParams.mockReturnValue({ slug: `${type}:sample-node`, source: "home" });
		getNode.mockResolvedValueOnce(success(nodeResponse(type, name)));
		getImage.mockResolvedValueOnce(
			success({ slug: `${type}:sample-node`, image_url: null, source: "cache" }),
		);

		const screen = render(<NodeScreen />);

		await waitFor(() => expect(screen.getByRole("header", { name })).toBeTruthy());
		expect(screen.getByText(`Type : ${label}`)).toBeTruthy();
		expect(screen.getByText("Une courte présentation.")).toBeTruthy();
		expect(screen.getByText("Introduction.")).toBeTruthy();
		expect(screen.getByText("• Premier élément")).toBeTruthy();
		expect(screen.getByText("<script>ne pas exécuter</script>")).toBeTruthy();
		expect(screen.getByText("Source fiable")).toBeTruthy();
		expect(screen.getByText("Source hostile")).toBeTruthy();
		expect(screen.getByText("Image indisponible")).toBeTruthy();
	});

	it("uses the canonical identity for an alias and tracks one canonical view after loading", async () => {
		mockedUseLocalSearchParams.mockReturnValue({
			slug: "artist:old-name",
			source: "notification",
			notification_id: "11111111-1111-4111-8111-111111111111",
		});
		getNode.mockResolvedValueOnce({
			...success(nodeResponse("artist", "Nom canonique", "artist:canonical-name")),
			value: {
				...nodeResponse("artist", "Nom canonique", "artist:canonical-name"),
				redirected_from: "artist:old-name",
			},
		});
		getImage.mockResolvedValueOnce(
			success({ slug: "artist:canonical-name", image_url: null, source: "cache" }),
		);

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByText("artist:canonical-name")).toBeTruthy());
		screen.rerender(<NodeScreen />);

		expect(screen.queryByText("artist:old-name")).toBeNull();
		expect(analytics.trackEvent).toHaveBeenCalledTimes(1);
		expect(analytics.trackEvent).toHaveBeenCalledWith(
			"node_viewed",
			{
				node_id: "artist:canonical-name",
				node_type: "artist",
				notification_id: "11111111-1111-4111-8111-111111111111",
			},
			{ source: "notification", notification_id: "11111111-1111-4111-8111-111111111111" },
		);
	});

	it("drops unsafe attribution values before they reach analytics", async () => {
		mockedUseLocalSearchParams.mockReturnValue({
			slug: "artist:sample-node",
			source: "notification",
			notification_id: "person@example.com",
		});

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByText("artist:sample-node")).toBeTruthy());

		expect(analytics.trackEvent).toHaveBeenCalledWith(
			"node_viewed",
			{ node_id: "artist:sample-node", node_type: "artist" },
			{ source: "notification" },
		);
	});

	it("retries a view until the analytics transport accepts it", async () => {
		analytics.trackEvent
			.mockResolvedValueOnce({ kind: "disabled" })
			.mockResolvedValueOnce({ kind: "accepted" });

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByText("artist:sample-node")).toBeTruthy());
		await waitFor(() => expect(analytics.trackEvent).toHaveBeenCalledTimes(2), { timeout: 1000 });
	});

	it("distinguishes a missing fiche from a network failure and retries without generation", async () => {
		getNode
			.mockResolvedValueOnce({ kind: "error", error: { kind: "network_error", message: "" } })
			.mockResolvedValueOnce({
				kind: "error",
				error: { kind: "api", status: 404, code: "not_found", retryable: false, message: "" },
			});

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(screen.getByText("Impossible de charger cette fiche")).toBeTruthy();
		fireEvent.press(screen.getByLabelText("Réessayer de charger la fiche"));
		await waitFor(() => expect(screen.getByText("Fiche introuvable")).toBeTruthy());
		expect(getNode).toHaveBeenCalledTimes(2);
		expect(
			(mockedCreateApiClient.mock.results[0]?.value as { createGeneration?: unknown }).createGeneration,
		).toBeUndefined();
		expect(analytics.trackEvent).not.toHaveBeenCalled();
	});

	it("shows an accessible image fallback after a native image error", async () => {
		getImage.mockResolvedValueOnce(
			success({
				slug: "artist:sample-node",
				image_url: "https://images.example.test/artist.jpg",
				source: "cache",
			}),
		);

		const screen = render(<NodeScreen />);
		const image = await waitFor(() => screen.getByTestId("node-image"));
		fireEvent(image, "error");

		expect(screen.getByText("Image indisponible")).toBeTruthy();
	});
});
