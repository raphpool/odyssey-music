import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useLocalSearchParams } from "expo-router";
import { Linking } from "react-native";

import NodeScreen from "../app/node/[slug]";
import { useAnalytics } from "../src/analytics/provider";
import { createApiClient } from "../src/api/client";
import { NODE_STORAGE_KEY } from "../src/cache/nodes";

jest.mock("expo-router", () => ({
	useLocalSearchParams: jest.fn(),
	router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock("../src/api/client", () => ({ createApiClient: jest.fn() }));
jest.mock("../src/analytics/provider", () => ({ useAnalytics: jest.fn() }));

const mockNodeStorage = new Map<string, string>();
jest.mock("@react-native-async-storage/async-storage", () => ({
	default: {
		getItem: async (key: string) => mockNodeStorage.get(key) ?? null,
		setItem: async (key: string, value: string) => void mockNodeStorage.set(key, value),
		removeItem: async (key: string) => void mockNodeStorage.delete(key),
	},
}));

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

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("NodeScreen", () => {
	let getNode: jest.Mock;
	let getImage: jest.Mock;
	let getLinks: jest.Mock;
	let openUrl: jest.SpiedFunction<typeof Linking.openURL>;

	beforeAll(() => {
		openUrl = jest.spyOn(Linking, "openURL");
	});

	afterAll(() => {
		openUrl.mockRestore();
	});

	beforeEach(() => {
		jest.clearAllMocks();
		mockNodeStorage.clear();
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
		getLinks = jest.fn(async () =>
			success({
				slug: "artist:sample-node",
				spotify: null,
				apple: null,
				sources: {},
				resolvedAt: "2026-09-27T00:00:00.000Z",
			}),
		);
		openUrl.mockResolvedValue(undefined);
		mockedCreateApiClient.mockReturnValue({
			getNode,
			getImage,
			getLinks,
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

	it("shows an expired cached fiche before its revalidation completes", async () => {
		const saved = nodeResponse("artist", "Fiche enregistrée");
		saved.node.citations = [{ url: "https://example.com/source", title: "Source fiable" }];
		mockNodeStorage.set(
			NODE_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				nodes: {
					"artist:sample-node": {
						response: saved,
						touchedAt: 0,
						checkedAt: 0,
					},
				},
				aliases: { "artist:sample-node": "artist:sample-node" },
				protected: [],
			}),
		);
		const slowNode = deferred<ReturnType<typeof success>>();
		getNode.mockImplementationOnce(() => slowNode.promise);

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByRole("header", { name: "Fiche enregistrée" })).toBeTruthy());
		expect(getNode).toHaveBeenCalledTimes(1);
		slowNode.resolve(success(nodeResponse("artist", "Fiche actualisée")));
		await waitFor(() => expect(screen.getByRole("header", { name: "Fiche actualisée" })).toBeTruthy());
	});

	it("labels a retryable server revalidation as stale instead of offline", async () => {
		const saved = nodeResponse("artist", "Fiche enregistrée");
		saved.node.citations = [{ url: "https://example.com/source", title: "Source fiable" }];
		mockNodeStorage.set(
			NODE_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				nodes: { "artist:sample-node": { response: saved, touchedAt: 0, checkedAt: 0 } },
				aliases: { "artist:sample-node": "artist:sample-node" },
				protected: [],
			}),
		);
		getNode.mockResolvedValueOnce({
			kind: "error",
			error: { kind: "api", status: 503, code: "unavailable", retryable: true, message: "retry" },
		});

		const screen = render(<NodeScreen />);
		await waitFor(() =>
			expect(
				screen.getByText("Affichage de la dernière version enregistrée pendant la mise à jour."),
			).toBeTruthy(),
		);
		expect(screen.queryByText("La recherche externe et la création sont suspendues.")).toBeNull();
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

	it("announces the search fallback and exposes an external-opening error on the fiche", async () => {
		getLinks.mockResolvedValueOnce(
			success({
				slug: "artist:sample-node",
				spotify: "https://open.spotify.com/artist/123",
				apple: null,
				sources: {},
				resolvedAt: "2026-09-27T00:00:00.000Z",
			}),
		);
		openUrl.mockRejectedValueOnce(new Error("provider unavailable"));

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByLabelText("Ouvrir dans Spotify")).toBeTruthy());
		expect(
			screen.getByText(
				"Nous ouvrons la page exacte si elle est disponible ; sinon, une recherche dans le service.",
			),
		).toBeTruthy();

		fireEvent.press(screen.getByLabelText("Ouvrir dans Spotify"));
		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

		expect(screen.getByText("Impossible d’ouvrir ce service. Réessayez plus tard.")).toBeTruthy();
		expect(openUrl).toHaveBeenCalledWith("https://open.spotify.com/artist/123");
		expect(analytics.trackEvent).toHaveBeenCalledWith(
			"external_listening_failed",
			expect.objectContaining({ provider: "spotify", link_kind: "exact", error_code: "open_failed" }),
			{ source: "home" },
		);
	});

	it("does not send listening analytics before measurement consent", async () => {
		mockedUseAnalytics.mockReturnValue({ ...analytics, consent: { version: 1, status: "denied" } });
		getLinks.mockResolvedValueOnce(
			success({
				slug: "artist:sample-node",
				spotify: "https://open.spotify.com/artist/123",
				apple: null,
				sources: {},
				resolvedAt: "2026-09-27T00:00:00.000Z",
			}),
		);

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByLabelText("Ouvrir dans Spotify")).toBeTruthy());
		fireEvent.press(screen.getByLabelText("Ouvrir dans Spotify"));
		await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://open.spotify.com/artist/123"));

		expect(analytics.trackEvent).not.toHaveBeenCalled();
	});

	it("coalesces duplicate callbacks for one external-opening gesture", async () => {
		let completeOpen: (() => void) | undefined;
		openUrl.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					completeOpen = resolve;
				}),
		);

		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByLabelText("Ouvrir dans Spotify")).toBeTruthy());
		fireEvent.press(screen.getByLabelText("Ouvrir dans Spotify"));
		fireEvent.press(screen.getByLabelText("Ouvrir dans Spotify"));

		expect(getLinks).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(completeOpen).toBeDefined());
		const complete = completeOpen;
		if (complete === undefined) throw new Error("external opening did not start");
		complete();
		await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
	});

	it("cancels a late link lookup on unmount before it can open or track", async () => {
		const links = deferred<ReturnType<typeof success>>();
		getLinks.mockImplementationOnce(() => links.promise);
		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByLabelText("Ouvrir dans Spotify")).toBeTruthy());
		analytics.trackEvent.mockClear();
		fireEvent.press(screen.getByLabelText("Ouvrir dans Spotify"));
		await waitFor(() => expect(getLinks).toHaveBeenCalledTimes(1));

		screen.unmount();
		links.resolve(
			success({
				slug: "artist:sample-node",
				spotify: "https://open.spotify.com/artist/123",
				apple: null,
				sources: {},
				resolvedAt: "2026-09-27T00:00:00.000Z",
			}),
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(openUrl).not.toHaveBeenCalled();
		expect(analytics.trackEvent).not.toHaveBeenCalledWith(
			"external_listening_opened",
			expect.anything(),
			expect.anything(),
		);
		expect(analytics.trackEvent).not.toHaveBeenCalledWith(
			"external_listening_failed",
			expect.anything(),
			expect.anything(),
		);
	});

	it("invalidates a late link lookup when navigation changes to another fiche", async () => {
		const links = deferred<ReturnType<typeof success>>();
		getLinks.mockImplementationOnce(() => links.promise);
		const screen = render(<NodeScreen />);
		await waitFor(() => expect(screen.getByLabelText("Ouvrir dans Spotify")).toBeTruthy());
		analytics.trackEvent.mockClear();
		fireEvent.press(screen.getByLabelText("Ouvrir dans Spotify"));
		await waitFor(() => expect(getLinks).toHaveBeenCalledTimes(1));

		getNode.mockResolvedValueOnce(success(nodeResponse("artist", "Autre fiche", "artist:another-node")));
		mockedUseLocalSearchParams.mockReturnValue({ slug: "artist:another-node", source: "search" });
		screen.rerender(<NodeScreen />);
		await waitFor(() => expect(getNode).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByRole("header", { name: "Autre fiche" })).toBeTruthy());
		links.resolve(
			success({
				slug: "artist:sample-node",
				spotify: "https://open.spotify.com/artist/123",
				apple: null,
				sources: {},
				resolvedAt: "2026-09-27T00:00:00.000Z",
			}),
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(openUrl).not.toHaveBeenCalled();
		expect(analytics.trackEvent).not.toHaveBeenCalledWith(
			"external_listening_opened",
			expect.anything(),
			expect.anything(),
		);
		expect(analytics.trackEvent).not.toHaveBeenCalledWith(
			"external_listening_failed",
			expect.anything(),
			expect.anything(),
		);
		expect(screen.getByLabelText("Ouvrir dans Spotify").props.disabled).not.toBe(true);
		expect(screen.getByLabelText("Ouvrir dans Apple Music").props.disabled).not.toBe(true);
		expect(screen.queryByText("Recherche Spotify ouverte.")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		screen.unmount();
	});
});
