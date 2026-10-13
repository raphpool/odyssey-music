import SwiftUI
import Track1Core
import UIKit

/// Figma `Release card` (`172:16`, doc `172:21`): a project in a horizontal cover carousel. A 120 pt cover,
/// the title on two lines at most, and a "2015 · album" line when the edge has one. The whole card is the tap
/// target ("Tap -> project node"). The caller supplies the decoded cover, like `Track1Artwork`: this view
/// never loads anything. Title and meta are third-party data, drawn verbatim. Figma draws no pressed state.
struct ReleaseCard: View {
	/// Doc `172:32`: "Title max 2 lines, then ellipsis".
	static let titleLineLimit = 2
	/// `size/release-card`: the card and its square cover are 120 pt wide.
	static let width = Track1Tokens.sizeReleaseCard
	/// Figma draws the cover border at 1 pt, as every border of the design system.
	static let coverBorderWidth: CGFloat = 1

	/// `release-card-<identity>`.
	static func identifier(for identity: NodeIdentity) -> String {
		"release-card-\(identity.rawValue)"
	}

	/// "2015 · album", nil when there is neither a year nor a release type.
	static func meta(year: String?, releaseType: String?) -> String? {
		ReleaseCardFormat.meta(year: year, releaseType: releaseType)
	}

	private let title: String
	private let meta: String?
	private let cover: Track1Artwork.State
	private let identity: NodeIdentity?
	private let action: () -> Void

	/// `identity` only names the control for UI tests (`release-card-<identity>`).
	init(
		title: String, meta: String?, cover: Track1Artwork.State, identity: NodeIdentity? = nil,
		action: @escaping () -> Void
	) {
		self.title = title
		self.meta = meta
		self.cover = cover
		self.identity = identity
		self.action = action
	}

	var body: some View {
		Button(action: action) {
			VStack(alignment: .leading, spacing: Track1Tokens.spacing8) {
				coverView
				Track1Text(title, role: .labelSmall, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextPrimary)
					.lineLimit(Self.titleLineLimit)
					.truncationMode(.tail)
					.multilineTextAlignment(.leading)
					.frame(maxWidth: .infinity, alignment: .leading)
				if let meta {
					Track1Text(meta, role: .caption, verbatim: true)
						.foregroundStyle(Track1Tokens.colorTextSecondary)
						.lineLimit(1)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
			}
			.frame(width: Self.width, alignment: .topLeading)
			// The title may take two lines: a parent that proposes less height must not clip it.
			.fixedSize(horizontal: false, vertical: true)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		// One spoken label from the title and the meta: the cover's image trait does not belong on a button.
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Text(verbatim: ReleaseCardFormat.spokenLabel(title: title, meta: meta)))
		.modifier(ReleaseCardIdentifier(identity: identity))
	}

	/// The cover is the Release placeholder gradient until a decoded image replaces it.
	private var coverView: some View {
		let shape = RoundedRectangle(cornerRadius: Track1Tokens.radius8, style: .continuous)
		return HeroCoverFill(
			image: NodeHero.decodedImage(for: cover), kind: .release,
			size: CGSize(width: Self.width, height: Self.width)
		)
		.clipShape(shape)
		.overlay { shape.strokeBorder(Track1Tokens.colorBorderDefault, lineWidth: Self.coverBorderWidth) }
	}
}

/// Sets the identifier only when there is one: an empty identifier would hide the one a container sets.
private struct ReleaseCardIdentifier: ViewModifier {
	let identity: NodeIdentity?

	@ViewBuilder
	func body(content: Content) -> some View {
		if let identity {
			content.accessibilityIdentifier(ReleaseCard.identifier(for: identity))
		} else {
			content
		}
	}
}
