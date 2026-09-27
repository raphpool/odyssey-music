import { fallbackSearchUrl, isSafeListeningUrl, openExternalListening } from "../src/listening/actions";

const node = { id: "track:windowlicker", type: "track" as const, name: "Windowlicker" };
const navigationContext = {
	source: "home" as const,
	recommendation_id: "11111111-1111-4111-8111-111111111111",
};

describe("external listening actions", () => {
	it("opens an exact trusted provider link and records an external opening, not audio playback", async () => {
		const openUrl = jest.fn(async () => undefined);
		const trackEvent = jest.fn(async () => ({ kind: "accepted" }));

		const result = await openExternalListening({
			node,
			provider: "spotify",
			exactUrl: "https://open.spotify.com/track/123",
			navigationContext,
			openUrl,
			analytics: { trackEvent },
		});

		expect(result).toEqual({
			kind: "opened",
			provider: "spotify",
			linkKind: "exact",
			url: "https://open.spotify.com/track/123",
		});
		expect(openUrl).toHaveBeenCalledWith("https://open.spotify.com/track/123");
		expect(trackEvent).toHaveBeenCalledWith(
			"external_listening_opened",
			{
				node_id: "track:windowlicker",
				node_type: "track",
				provider: "spotify",
				link_kind: "exact",
			},
			navigationContext,
		);
	});

	it("uses an explicitly labelled search fallback when no exact page exists", async () => {
		const openUrl = jest.fn(async () => undefined);
		const result = await openExternalListening({
			node,
			provider: "apple_music",
			exactUrl: null,
			navigationContext,
			openUrl,
		});

		expect(fallbackSearchUrl("apple_music", "Windowlicker")).toBe(
			"https://music.apple.com/search?term=Windowlicker",
		);
		expect(result).toEqual({
			kind: "opened",
			provider: "apple_music",
			linkKind: "search",
			url: "https://music.apple.com/search?term=Windowlicker",
		});
	});

	it("blocks hostile exact URLs and reports a visible failure without asking the OS to open them", async () => {
		const openUrl = jest.fn(async () => undefined);
		const trackEvent = jest.fn(async () => ({ kind: "accepted" }));
		const result = await openExternalListening({
			node,
			provider: "spotify",
			exactUrl: "https://open.spotify.com.evil.example/track/123",
			navigationContext,
			openUrl,
			analytics: { trackEvent },
		});

		expect(isSafeListeningUrl("spotify", "https://open.spotify.com.evil.example/track/123")).toBe(false);
		expect(result).toEqual({
			kind: "failed",
			provider: "spotify",
			linkKind: "exact",
			errorCode: "unsafe_url",
		});
		expect(openUrl).not.toHaveBeenCalled();
		expect(trackEvent).toHaveBeenCalledWith(
			"external_listening_failed",
			expect.objectContaining({ error_code: "unsafe_url", provider: "spotify" }),
			navigationContext,
		);
	});

	it("reports an OS opening failure once", async () => {
		const trackEvent = jest.fn(async () => ({ kind: "accepted" }));
		const result = await openExternalListening({
			node,
			provider: "apple_music",
			exactUrl: "https://music.apple.com/fr/album/example/1",
			navigationContext,
			openUrl: async () => Promise.reject(new Error("not installed")),
			analytics: { trackEvent },
		});

		expect(result).toEqual({
			kind: "failed",
			provider: "apple_music",
			linkKind: "exact",
			errorCode: "open_failed",
		});
		expect(trackEvent).toHaveBeenCalledTimes(1);
	});
});
