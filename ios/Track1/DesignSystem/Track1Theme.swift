import SwiftUI

enum Track1Theme {
	static let actionTint = Color(red: 0, green: 0.451, blue: 0.902)
	static let minimumHitTarget: CGFloat = 44
	static let contentSpacing: CGFloat = 16
	static let sectionSurface = Color(uiColor: .secondarySystemBackground)
}

struct Track1PrimaryButtonStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(.headline)
			.frame(minWidth: Track1Theme.minimumHitTarget, minHeight: Track1Theme.minimumHitTarget)
			.padding(.horizontal, Track1Theme.contentSpacing)
			.background(Track1Theme.actionTint, in: Capsule())
			.foregroundStyle(.white)
			.opacity(configuration.isPressed ? 0.8 : 1)
	}
}
