import SwiftUI

/// Figma `SearchField` (`30:21`, doc `174:181`): a text input with a leading search glyph. Figma draws the
/// pattern and the native `TextField` owns the interaction. The border turns to the focus color while the
/// field has the focus (the Figma Filled variant `30:16` is the focused, typing field). The clear button
/// appears only while there is text to clear.
struct Track1SearchField: View {
	static let placeholder = "Rechercher un artiste ou une œuvre"
	static let fieldIdentifier = "search-field"
	static let clearIdentifier = "search-clear"
	/// Figma draws the glyph in a 22 pt frame, which no Figma variable covers: local token (TRA-443).
	static let iconSize = Track1Tokens.sizeIconSearch

	@Binding private var text: String
	private let focus: FocusState<Bool>.Binding
	private let onSubmit: () -> Void
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	init(text: Binding<String>, focus: FocusState<Bool>.Binding, onSubmit: @escaping () -> Void) {
		_text = text
		self.focus = focus
		self.onSubmit = onSubmit
	}

	static func showsClear(_ text: String) -> Bool {
		!text.isEmpty
	}

	/// `theme.color.border.focus` when focused (`30:16`), `theme.color.border.default` otherwise (`30:11`).
	static func borderColor(isFocused: Bool) -> Color {
		isFocused ? Track1Tokens.colorBorderFocus : Track1Tokens.colorBorderDefault
	}

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: Track1Tokens.radius12, style: .continuous)
		let isFocused = focus.wrappedValue
		HStack(spacing: Track1Tokens.spacing12) {
			Track1Icon(.search, color: Track1Tokens.colorIconAction, size: Self.iconSize)
			TextField(
				Self.placeholder, text: $text,
				prompt: Text(Self.placeholder).foregroundStyle(Track1Tokens.colorTextTertiary)
			)
			.track1Text(.bodyMedium)
			.foregroundStyle(Track1Tokens.colorTextPrimary)
			.focused(focus)
			.submitLabel(.search)
			.onSubmit(onSubmit)
			.autocorrectionDisabled()
			.textInputAutocapitalization(.never)
			.accessibilityIdentifier(Self.fieldIdentifier)
			if Self.showsClear(text) {
				Track1IconButton(
					.close, accessibilityLabel: "Effacer la recherche", kind: .ghost, size: .medium
				) {
					text = ""
					focus.wrappedValue = true
				}
				.accessibilityIdentifier(Self.clearIdentifier)
			}
		}
		.padding(.leading, Track1Tokens.spacing16)
		// The 44 pt clear button already brings its own room on the trailing edge.
		.padding(.trailing, Self.showsClear(text) ? Track1Tokens.spacing4 : Track1Tokens.spacing16)
		.frame(minHeight: Track1Tokens.sizeControlLarge)
		.background(Track1Tokens.colorSurfaceDefault, in: shape)
		.overlay { shape.strokeBorder(Self.borderColor(isFocused: isFocused), lineWidth: 1) }
		.contentShape(shape)
		.onTapGesture { focus.wrappedValue = true }
		.animation(Track1Motion.animation(.fast, reduceMotion: reduceMotion), value: isFocused)
	}
}
