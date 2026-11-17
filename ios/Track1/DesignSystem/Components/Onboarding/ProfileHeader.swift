import SwiftUI
import Track1Core

/// Measurements of the profile header at the top of the v1 Genres tab (TRA-733): the profile disc in a light
/// ring, with the pseudo under it. The ticket's measures are the reference.
enum ProfileHeaderMetrics {
	/// The avatar is a square of this side: the ring, and the tile centred in it.
	static let avatarSize: CGFloat = 89
	/// The ring has no fill: only a border, drawn inside its 89 x 89 frame.
	static let borderWidth: CGFloat = 3.296
	static let ringCornerRadius: CGFloat = 19.469
	static let ringColor = Track1Tokens.colorIconPrimary

	/// Centred in the avatar, so it starts 1.691 from the edge: about 1.6 of the 3.296 border lies under it, as
	/// in the mock-up. Both are the same tint today; a change of either tint must keep that overlap in mind.
	static let tileSize: CGFloat = 85.618
	static let tileCornerRadius: CGFloat = 18.729

	/// `#F6E9D8` at 10 % at the top, the same tint at 0 % at 151.15 % of the height. The second stop lies below
	/// the shape, so the gradient line is stretched to `y = 1.5115` instead of bending the alpha: at the bottom
	/// edge the tint is still there, as in the mock-up.
	static let tileTopColor = Track1Tokens.colorTintWarm
	static let tileBottomColor = Track1Tokens.colorTintWarm.opacity(0)
	static let tileGradientStart = UnitPoint.top
	static let tileGradientEnd = UnitPoint(x: 0.5, y: 1.5115)

	static let discSize: CGFloat = 72.7
	/// Offset of the disc from the top and leading edges of the tile. 2026-11-17: the ticket gives one inset
	/// and a disc of 72.7 in a tile of 85.618, which is 1.84 more than 2 x 5.54, so the disc is placed from
	/// the top leading corner and not centred (0.92 pt off the centre).
	static let discInset: CGFloat = 5.54

	/// Between the avatar and the pseudo.
	static let nameSpacing: CGFloat = 16
	static let nameRole = Track1TextRole.title3
	static let nameColor = Track1Tokens.colorTextPrimary
	static let nameLineLimit = 1

	static let accessibilityIdentifier = "profile-header"

	/// One accessibility element for the whole header: the pseudo, then the disc. The pseudo is typed by the
	/// person, so it goes in as it is.
	static func accessibilityLabel(name: String, disc: ProfileDisc) -> String {
		"\(name), \(ProfileDiscImage.accessibilityLabel(for: disc))"
	}
}

/// The profile disc in a light ring, with the pseudo centred under it. The pseudo stays on one line and
/// stops with an ellipsis at its end when the width is short. VoiceOver reads one header, "<name>, <disc>".
struct ProfileHeader: View {
	private typealias Metrics = ProfileHeaderMetrics

	private let disc: ProfileDisc
	private let name: String

	init(disc: ProfileDisc, name: String) {
		self.disc = disc
		self.name = name
	}

	var body: some View {
		VStack(spacing: Metrics.nameSpacing) {
			avatar
			Track1Text(name, role: Metrics.nameRole, verbatim: true)
				.foregroundStyle(Metrics.nameColor)
				.multilineTextAlignment(.center)
				.lineLimit(Metrics.nameLineLimit)
				.truncationMode(.tail)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Text(verbatim: Metrics.accessibilityLabel(name: name, disc: disc)))
		.accessibilityAddTraits(.isHeader)
		.accessibilityIdentifier(Metrics.accessibilityIdentifier)
	}

	private var avatar: some View {
		ZStack {
			RoundedRectangle(cornerRadius: Metrics.ringCornerRadius, style: .continuous)
				.strokeBorder(Metrics.ringColor, lineWidth: Metrics.borderWidth)
			tile
		}
		.frame(width: Metrics.avatarSize, height: Metrics.avatarSize)
	}

	private var tile: some View {
		let shape = RoundedRectangle(cornerRadius: Metrics.tileCornerRadius, style: .continuous)
		let colors = [Metrics.tileTopColor, Metrics.tileBottomColor]
		let gradient = LinearGradient(
			colors: colors, startPoint: Metrics.tileGradientStart, endPoint: Metrics.tileGradientEnd)
		return ZStack(alignment: .topLeading) {
			ProfileDiscImage(disc: disc, size: Metrics.discSize)
				.padding(.top, Metrics.discInset)
				.padding(.leading, Metrics.discInset)
		}
		.frame(width: Metrics.tileSize, height: Metrics.tileSize, alignment: .topLeading)
		.background(gradient, in: shape)
	}
}

#Preview("Profile header") {
	VStack(spacing: 32) {
		ProfileHeader(disc: .iridescent, name: "Raphael")
		ProfileHeader(disc: .teal, name: "WWWWWWWWWWWWWWWWWWWW")
	}
	.padding()
	.background(Track1Tokens.colorBackgroundBase)
}
