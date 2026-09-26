import { type PublicEnvironment, readPublicConfig } from "../src/config";

const validEnvironment: PublicEnvironment = {
	EXPO_PUBLIC_APP_ENV: "production",
	EXPO_PUBLIC_API_BASE_URL: "https://dropcliffs.com/api/odyssey/mobile/v1",
};

describe("readPublicConfig", () => {
	it("normalizes a valid public configuration", () => {
		expect(readPublicConfig(validEnvironment)).toEqual({
			ok: true,
			value: {
				appEnvironment: "production",
				apiBaseUrl: "https://dropcliffs.com/api/odyssey/mobile/v1/",
			},
		});
	});

	it("accepts another safe environment endpoint ending in /mobile/v1", () => {
		expect(
			readPublicConfig({
				...validEnvironment,
				EXPO_PUBLIC_APP_ENV: "preview",
				EXPO_PUBLIC_API_BASE_URL: "https://preview.dropcliffs.com/mobile/v1",
			}),
		).toEqual({
			ok: true,
			value: {
				appEnvironment: "preview",
				apiBaseUrl: "https://preview.dropcliffs.com/mobile/v1/",
			},
		});
	});

	it("returns a typed error when a required value is missing", () => {
		expect(readPublicConfig({ EXPO_PUBLIC_APP_ENV: "development" })).toMatchObject({
			ok: false,
			error: { code: "MISSING_VALUE", field: "EXPO_PUBLIC_API_BASE_URL" },
		});
	});

	it.each([
		"http://dropcliffs.com/api/odyssey/mobile/v1",
		"https://token@dropcliffs.com/api/odyssey/mobile/v1",
		"https://dropcliffs.com/api/odyssey/mobile/v1?token=public",
		"https://dropcliffs.com/api/odyssey/mobile/v2",
	])("rejects hostile or unsupported API URLs", (url) => {
		expect(readPublicConfig({ ...validEnvironment, EXPO_PUBLIC_API_BASE_URL: url })).toMatchObject({
			ok: false,
			error: { code: "INVALID_API_BASE_URL", field: "EXPO_PUBLIC_API_BASE_URL" },
		});
	});

	it("rejects an unknown public environment", () => {
		expect(readPublicConfig({ ...validEnvironment, EXPO_PUBLIC_APP_ENV: "staging" })).toMatchObject({
			ok: false,
			error: { code: "INVALID_APP_ENV", field: "EXPO_PUBLIC_APP_ENV" },
		});
	});

	it("accepts an absent optional Segment write key", () => {
		expect(readPublicConfig({ ...validEnvironment, EXPO_PUBLIC_SEGMENT_WRITE_KEY: " " })).toEqual({
			ok: true,
			value: {
				appEnvironment: "production",
				apiBaseUrl: "https://dropcliffs.com/api/odyssey/mobile/v1/",
			},
		});
	});
});
