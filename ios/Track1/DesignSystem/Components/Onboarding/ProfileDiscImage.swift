import SwiftUI
import Track1Core

/// Measurements of the profile disc in the v1 mock-up (Figma `362:3008`, the empty disc `362:3129`, TRA-721).
/// The shadow is read on a disc of 72.7 and scales with the size, so the same disc looks the same at any
/// size.
enum ProfileDiscMetrics {
	/// A Figma drop shadow: no horizontal offset, at the reference size.
	struct Shadow: Equatable, Sendable {
		let y: CGFloat
		let blur: CGFloat
		let spread: CGFloat
	}

	/// Side of the disc the shadow was measured on.
	static let referenceSize: CGFloat = 72.7

	/// `0 1.385 2.423 -0.346 rgba(19,33,42,0.28)` on a disc of `referenceSize`.
	static let referenceShadow = Shadow(y: 1.385, blur: 2.423, spread: -0.346)
	static let shadowColor = Color(.sRGB, red: 19.0 / 255, green: 33.0 / 255, blue: 42.0 / 255, opacity: 0.28)

	/// The empty disc, `362:3129`, is built like the six images: a plain circle with an opaque white ellipse
	/// in the middle (the `Center opening` layer of the Figma, a fill and not a hole). 2026-11-17 (decision
	/// on TRA-721): a hole would show the background and make the empty slot differ from the filled ones.
	static let emptyColor = Track1Tokens.colorDiscEmpty
	static let openingColor = Color.white
	static let emptyOpeningRatio: CGFloat = 0.0782

	static func emptyOpeningDiameter(size: CGFloat) -> CGFloat {
		size * emptyOpeningRatio
	}

	/// The shadow of a disc of `size`: every measure is proportional to it.
	static func shadow(size: CGFloat) -> Shadow {
		let scale = size / referenceSize
		return Shadow(
			y: referenceShadow.y * scale, blur: referenceShadow.blur * scale,
			spread: referenceShadow.spread * scale)
	}
}

/// A profile disc as a square of `size`: one of the six images of the `Disc` namespace, or, for `nil`, the
/// empty disc drawn from the token colour, with no image. The component draws the drop shadow itself, the
/// images carry none. VoiceOver reads one element named by `accessibilityLabel(for:)`.
struct ProfileDiscImage: View {
	private let disc: ProfileDisc?
	private let size: CGFloat

	init(disc: ProfileDisc?, size: CGFloat) {
		self.disc = disc
		self.size = size
	}

	/// Name of the image in the asset catalogue (`Disc` namespace).
	static func assetName(for disc: ProfileDisc) -> String {
		switch disc {
		case .iridescent: "Disc/Iridescent"
		case .blue: "Disc/Blue"
		case .mint: "Disc/Mint"
		case .coral: "Disc/Coral"
		case .violet: "Disc/Violet"
		case .teal: "Disc/Teal"
		}
	}

	/// The image the view loads: nil for the empty disc, which is drawn and loads nothing.
	static func imageName(for disc: ProfileDisc?) -> String? {
		guard let disc else { return nil }
		return assetName(for: disc)
	}

	static func accessibilityLabel(for disc: ProfileDisc?) -> String {
		switch disc {
		case .iridescent: "Disque iridescent"
		case .blue: "Disque bleu"
		case .mint: "Disque menthe"
		case .coral: "Disque corail"
		case .violet: "Disque violet"
		case .teal: "Disque sarcelle"
		case nil: "Emplacement vide"
		}
	}

	var body: some View {
		ZStack {
			shadowCaster
			face
		}
		.frame(width: size, height: size)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Self.accessibilityLabel(for: disc))
		.accessibilityAddTraits(.isImage)
	}

	@ViewBuilder private var face: some View {
		if let name = Self.imageName(for: disc) {
			Image(name)
				.resizable()
				.scaledToFit()
				.frame(width: size, height: size)
		} else {
			let opening = ProfileDiscMetrics.emptyOpeningDiameter(size: size)
			Circle()
				.fill(ProfileDiscMetrics.emptyColor)
				.overlay {
					Circle()
						.fill(ProfileDiscMetrics.openingColor)
						.frame(width: opening, height: opening)
				}
		}
	}

	/// SwiftUI has no shadow spread, and its radius is half the Figma blur (as in `DeviceOutline`). The shadow
	/// is cast by the disc grown by `spread` on every side: with the negative spread of the mock-up that is a
	/// slightly smaller disc, hidden under the real one.
	private var shadowCaster: some View {
		let shadow = ProfileDiscMetrics.shadow(size: size)
		return Circle()
			.inset(by: -shadow.spread)
			.fill(Color.black)
			.shadow(color: ProfileDiscMetrics.shadowColor, radius: shadow.blur / 2, x: 0, y: shadow.y)
	}
}

#Preview("Profile discs") {
	let discs: [ProfileDisc?] = ProfileDisc.allCases.map(Optional.some) + [nil]
	return HStack(spacing: 12) {
		ForEach(Array(discs.enumerated()), id: \.offset) { _, disc in
			ProfileDiscImage(disc: disc, size: 72.7)
		}
	}
	.padding()
	.background(Track1Tokens.colorBackgroundBase)
}
