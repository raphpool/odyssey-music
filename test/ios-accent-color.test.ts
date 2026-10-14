import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// TRA-434: the AccentColor of the asset catalog is the app-wide default tint. It kept the pre-Nocturne blue
// (0 / 0.451 / 0.902) after TRA-383 introduced Track1Tokens.colorTextAction, so anything that falls back to
// the catalog tint stayed blue. This guard runs without Xcode and fails when the token changes without the
// catalog following.
const TOKENS = "ios/Track1/DesignSystem/Track1Tokens.swift";
const ACCENT = "ios/Track1/Resources/Assets.xcassets/AccentColor.colorset/Contents.json";

interface Colorset {
	colors?: Array<{
		idiom?: string;
		appearances?: unknown;
		color?: { "color-space"?: string; components?: Record<string, string> };
	}>;
}

/** The 0xRRGGBB literal passed to `rgb(_:)` for `colorTextAction`. */
async function tokenHex(): Promise<string> {
	const source = await readFile(TOKENS, "utf8");
	const match = source.match(/static let colorTextAction = rgb\(0x([0-9A-Fa-f]{6})\)/);
	if (match?.[1] === undefined) throw new Error("colorTextAction is no longer declared as rgb(0xRRGGBB)");
	return match[1];
}

/** A channel byte as the 3-decimal string Xcode writes in a colorset. */
function component(hex: string, offset: number): string {
	return (Number.parseInt(hex.slice(offset, offset + 2), 16) / 255).toFixed(3);
}

describe("AccentColor colorset", () => {
	it("holds the sRGB value of Track1Tokens.colorTextAction, and only that value", async () => {
		const hex = await tokenHex();
		const colorset = JSON.parse(await readFile(ACCENT, "utf8")) as Colorset;

		// Nocturne is dark only: one universal entry, no light/dark appearance variants.
		expect(colorset.colors).toHaveLength(1);
		const [entry] = colorset.colors ?? [];
		expect(entry?.idiom).toBe("universal");
		expect(entry?.appearances).toBeUndefined();
		expect(entry?.color?.["color-space"]).toBe("srgb");
		expect(entry?.color?.components).toEqual({
			red: component(hex, 0),
			green: component(hex, 2),
			blue: component(hex, 4),
			alpha: "1.000",
		});
	});
});
