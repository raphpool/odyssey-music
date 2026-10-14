import SwiftUI
import Track1Core

/// Figma `Streaming button` (`172:75`, doc `172:105`): a pill with the mark of a streaming service and its
/// name, which opens the node on that service. Only Apple Music and Spotify exist (D12): `ListeningProvider`
/// has no YouTube Music, and neither does the asset catalog. The visible name is the lowercase one of the
/// Figma; the accessibility label is the action title ("Écouter sur ..." or "Rechercher sur ...") when the
/// caller has one, which is what tells an exact link from a search fallback.
///
/// The marks in `Assets.xcassets/Brand/` are the brand-colour exports of the Figma logos: see its `README.md`.
struct StreamingButton: View {
	/// `size/icon-small`: Figma draws the mark at 16 pt.
	static let logoSize = Track1Tokens.sizeIconSmall

	private let provider: ListeningProvider
	private let accessibilityText: String?
	private let action: () -> Void
	@State private var taps = 0

	init(provider: ListeningProvider, accessibilityLabel: String? = nil, action: @escaping () -> Void) {
		self.provider = provider
		self.accessibilityText = accessibilityLabel
		self.action = action
	}

	/// Name drawn in the button, as in the Figma variants (`apple music`, `spotify`).
	static func name(for provider: ListeningProvider) -> String {
		switch provider {
		case .appleMusic: "apple music"
		case .spotify: "spotify"
		}
	}

	/// Name of the image in the asset catalog (`Brand` provides a namespace).
	static func logoName(for provider: ListeningProvider) -> String {
		switch provider {
		case .appleMusic: "Brand/AppleMusic"
		case .spotify: "Brand/Spotify"
		}
	}

	/// Accessibility identifier of the button of a provider, for example `listen-apple_music` (TRA-368).
	static func identifier(for provider: ListeningProvider) -> String {
		"listen-\(provider.rawValue)"
	}

	var body: some View {
		Button {
			taps += 1
			action()
		} label: {
			HStack(spacing: Track1Tokens.spacing6) {
				Image(Self.logoName(for: provider))
					.resizable()
					.scaledToFit()
					.frame(width: Self.logoSize, height: Self.logoSize)
					.accessibilityHidden(true)
				Track1Text(Self.name(for: provider), role: .monoMicro, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextPrimary)
					.lineLimit(1)
					.fixedSize(horizontal: true, vertical: false)
			}
		}
		.buttonStyle(StreamingButtonStyle())
		.sensoryFeedback(.impact(weight: .light), trigger: taps)
		.accessibilityLabel(accessibilityText ?? Self.name(for: provider))
		.accessibilityIdentifier(Self.identifier(for: provider))
	}
}

/// Pill of the Streaming button. Figma draws no Pressed state: it uses `surface/pressed`, the token of the
/// other pressed surfaces. Disabled comes from the `isEnabled` environment, at the opacity of the buttons.
private struct StreamingButtonStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		StreamingButtonBody(isPressed: configuration.isPressed, label: configuration.label)
	}
}

private struct StreamingButtonBody: View {
	let isPressed: Bool
	let label: ButtonStyleConfiguration.Label
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: Track1Tokens.radiusFull, style: .continuous)
		label
			.padding(.leading, Track1Tokens.spacing12)
			.padding(.trailing, Track1Tokens.spacing16)
			.padding(.vertical, Track1Tokens.spacing8)
			.frame(minHeight: Track1Tokens.sizeControlMedium)
			.background(
				isPressed ? Track1Tokens.colorSurfacePressed : Track1Tokens.colorSurfaceDefault, in: shape
			)
			.opacity(isEnabled ? 1 : Track1ButtonColors.disabledOpacity)
			.contentShape(shape)
	}
}

/// Figma `Streaming bar` (`172:76`): a centered row of Streaming buttons, 8 pt apart, 12 pt from the edges.
/// Figma draws 3 buttons; D12 keeps 2 (Apple Music, then Spotify) and none at all for a genre or a label, for
/// which `ListeningActions` returns no action: the bar is then absent, not empty. Floating above the tab bar
/// is the job of the page that places it.
struct StreamingBar: View {
	static let identifier = "streaming-bar"

	private let actions: [ListeningAction]
	private let isOpening: Bool
	private let open: (ListeningAction) -> Void

	init(actions: [ListeningAction], isOpening: Bool, open: @escaping (ListeningAction) -> Void) {
		self.actions = Self.ordered(actions)
		self.isOpening = isOpening
		self.open = open
	}

	/// Apple Music, then Spotify, whatever the order `ListeningActions` returns. Stable for equal providers.
	static func ordered(_ actions: [ListeningAction]) -> [ListeningAction] {
		let rank: [ListeningProvider: Int] = [.appleMusic: 0, .spotify: 1]
		return actions.enumerated()
			.sorted { lhs, rhs in
				let (left, right) = (rank[lhs.element.provider] ?? .max, rank[rhs.element.provider] ?? .max)
				return left != right ? left < right : lhs.offset < rhs.offset
			}
			.map(\.element)
	}

	/// `false` when there is nothing to listen to: the bar then draws nothing, not an empty row.
	var isPresent: Bool { !actions.isEmpty }

	var body: some View {
		if isPresent {
			// At the largest Dynamic Type sizes the buttons stack instead of running off the screen.
			ViewThatFits(in: .horizontal) {
				HStack(spacing: Track1Tokens.spacing8) { buttons }
				VStack(spacing: Track1Tokens.spacing8) { buttons }
			}
			.frame(maxWidth: .infinity)
			.padding(.horizontal, Track1Tokens.spacing12)
			.disabled(isOpening)
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier(Self.identifier)
		}
	}

	private var buttons: some View {
		ForEach(actions, id: \.provider) { action in
			StreamingButton(provider: action.provider, accessibilityLabel: action.title) { open(action) }
		}
	}
}
