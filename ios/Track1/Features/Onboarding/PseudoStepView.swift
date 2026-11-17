import SwiftUI
import Track1Core

/// Geometry and style of the pseudo screen, read on Figma `362:1766` (empty) and `362:2894` (filled) of
/// `phudxrQNlzQJafXLma4FyX` on 2026-11-17 (TRA-723, 393 x 852 frame). The two nodes differ only by the field
/// text and by the keyboard's return key.
enum PseudoStepMetrics {
	/// Top of the title (`362:1773`, y 164) and of the field (`362:2891`, y 344), from the top of the frame.
	static let titleTop: CGFloat = 164
	static let fieldTop: CGFloat = 344
	/// The status bar of the 393 x 852 frame takes 59 pt (the safe area of the iPhone with that frame). The
	/// content starts under the safe area, so each top is reduced by it: the title lands at y 164 and the field
	/// at y 344 on that device, and keep their gap to the status bar on the others (same rule as the genre
	/// screen, `GenresStepLayout.headerTop`).
	static let referenceTopInset: CGFloat = 59
	static var titleTopPadding: CGFloat { titleTop - referenceTopInset }
	static var fieldTopPadding: CGFloat { fieldTop - referenceTopInset }

	/// Margins of the bar (`362:1807`): 24 above the button, 32 under it, 16 on the sides. They are the ones of
	/// `BottomActionBar`, which draws the bar; a test keeps the two in line.
	static let barTopInset = Track1Tokens.spacing24
	static let barBottomInset = Track1Tokens.spacing32
	static let barHorizontalInset = Track1Tokens.spacing16

	/// Not drawn in Figma, whose texts are short: keeps the text off the screen edges. A long pseudo (20 wide
	/// glyphs at 34 pt are wider than the field) scrolls inside the field instead of being scaled.
	static let fieldHorizontalInset = Track1Tokens.spacing16

	/// Title `362:1781`: JetBrains Mono Regular 18/22. Field `362:2906`: "Inter" in the Figma, Roboto 34/41 in
	/// the app.
	static let titleRole: Track1TextRole = .monoItem
	static let fieldRole: Track1TextRole = .inputLarge
	static let titleColor = Track1Tokens.colorTextPrimary
	/// The typed text (`362:2906`) and the placeholder (`362:2893`).
	static let textColor = Track1Tokens.colorTextPrimary
	static let placeholderColor = Track1Tokens.colorTextTertiary

	/// `screen/gradient-top` at the top, `background/elevated` from 33.099 % of the height down, as on the
	/// root node.
	static let backgroundStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorScreenGradientTop, location: 0),
		.init(color: Track1Tokens.colorBackgroundElevated, location: 0.33099),
	]
}

/// Figma `1.3 Pseudo` (`362:1766` empty, `362:2894` filled): the second onboarding step. The person types a
/// pseudo and validates it with the return key of the keyboard or with "Continuer".
///
/// The empty screen exists as drawn (arbitration Q7): the field has the focus when the screen appears, so the
/// keyboard is already open, and the placeholder stays until the first letter. The keyboard covers the bar,
/// as in the mock-up, and the view does not rise with it; the bar still serves where there is no software
/// keyboard (hardware keyboard, simulator). The pseudo stays on the device: nothing here reaches analytics.
struct PseudoStepView: View {
	static let titleIdentifier = "onboarding-pseudo-title"
	static let fieldIdentifier = "onboarding-pseudo-field"
	static let continueIdentifier = "onboarding-pseudo-continue"

	static let title = "C'est quoi ton pseudo ?"
	/// Figma `362:2893`.
	static let placeholder = "Slim Shady"
	static let continueTitle = "Continuer"

	/// What the field holds when the screen opens: the pseudo kept by the step, so that coming back from the
	/// next one shows it again.
	static func startingText(for initial: String?) -> String {
		bounded(initial ?? "")
	}

	/// The text cut at `PseudoRules.maxLength` graphemes (`prefix` counts characters, not scalars or bytes): the
	/// 21st one never stays in the field.
	static func bounded(_ raw: String) -> String {
		String(raw.prefix(PseudoRules.maxLength))
	}

	/// The return key and "Continuer" share this rule: a pseudo that does not normalize cannot be sent.
	static func isContinueEnabled(_ text: String) -> Bool {
		PseudoRules.normalized(text) != nil
	}

	/// Calls `onSubmit` once with the stored form of the pseudo, or not at all when nothing visible is left of
	/// it. Returns whether it was called.
	@discardableResult
	static func submit(_ text: String, onSubmit: (String) -> Void) -> Bool {
		guard let pseudo = PseudoRules.normalized(text) else { return false }
		onSubmit(pseudo)
		return true
	}

	/// The bar as the screen builds it, so a test reads the parameters the screen really passes. No counter,
	/// and no fade: nothing scrolls under the bar, and Figma draws only the button on the screen gradient.
	@MainActor
	static func actionBar(text: String, onSubmit: @escaping (String) -> Void) -> BottomActionBar {
		BottomActionBar(
			title: continueTitle, isEnabled: isContinueEnabled(text), counter: nil, identifier: continueIdentifier,
			showsFade: false
		) {
			submit(text, onSubmit: onSubmit)
		}
	}

	private let onSubmit: (String) -> Void
	@State private var text: String
	@FocusState private var isFocused: Bool
	/// The field is 41 pt high at the default size (Figma line height), and grows with Dynamic Type.
	@ScaledMetric(relativeTo: .largeTitle) private var fieldHeight = PseudoStepMetrics.fieldRole.lineHeight

	init(initial: String?, onSubmit: @escaping (String) -> Void) {
		self.onSubmit = onSubmit
		_text = State(initialValue: Self.startingText(for: initial))
	}

	var body: some View {
		ZStack(alignment: .top) {
			LinearGradient(stops: PseudoStepMetrics.backgroundStops, startPoint: .top, endPoint: .bottom)
				.ignoresSafeArea()
			Track1Text(Self.title, role: PseudoStepMetrics.titleRole)
				.foregroundStyle(PseudoStepMetrics.titleColor)
				.accessibilityAddTraits(.isHeader)
				.accessibilityIdentifier(Self.titleIdentifier)
				.padding(.top, PseudoStepMetrics.titleTopPadding)
			field
				.padding(.top, PseudoStepMetrics.fieldTopPadding)
			// Figma measures the bar from the physical bottom edge (y 744 to 852): it ignores the bottom safe
			// area, unlike the genre screen's bar, so that the button sits at y 768 as drawn.
			Self.actionBar(text: text, onSubmit: onSubmit)
				.frame(maxHeight: .infinity, alignment: .bottom)
				.ignoresSafeArea(.container, edges: .bottom)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		// The keyboard covers the bar and the view stays where it is (Figma `362:1766`).
		.ignoresSafeArea(.keyboard)
		// Both, as the search sheet does (`SearchSheetView`): the keyboard is open when the step appears.
		.defaultFocus($isFocused, true)
		.onAppear { isFocused = true }
	}

	private var field: some View {
		TextField(
			Self.title, text: $text,
			prompt: Text(Self.placeholder).foregroundStyle(PseudoStepMetrics.placeholderColor)
		)
		.track1Text(PseudoStepMetrics.fieldRole)
		.foregroundStyle(PseudoStepMetrics.textColor)
		.multilineTextAlignment(.center)
		.focused($isFocused)
		.submitLabel(.continue)
		.onSubmit(handleReturn)
		.autocorrectionDisabled()
		.textInputAutocapitalization(.words)
		// VoiceOver reads the title as the label of the field, not the placeholder.
		.accessibilityLabel(Self.title)
		.accessibilityIdentifier(Self.fieldIdentifier)
		.frame(height: fieldHeight)
		.padding(.horizontal, PseudoStepMetrics.fieldHorizontalInset)
		.onChange(of: text) { _, newValue in
			let kept = Self.bounded(newValue)
			if kept != newValue { text = kept }
		}
	}

	/// The return key. The system closes the keyboard on return, after this callback: when nothing is sent, the
	/// field takes the focus back on the next turn of the main loop (a synchronous assignment would be
	/// overwritten by that loss), so that the person keeps typing.
	private func handleReturn() {
		guard !Self.submit(text, onSubmit: onSubmit) else { return }
		Task { @MainActor in isFocused = true }
	}
}
