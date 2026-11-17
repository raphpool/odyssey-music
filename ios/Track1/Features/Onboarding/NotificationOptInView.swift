import SwiftUI
import Track1Core

/// Geometry and style of the notification opt-in screen, read on the 393 x 852 frame of the ticket TRA-746 on
/// 2026-11-17. Each position is from the top left corner of the frame, or of the scene for the two layers
/// staged in it.
enum NotificationOptInMetrics {
	static let frameWidth: CGFloat = 393
	static let frameHeight: CGFloat = 852

	/// The header starts at y 78 of the frame, whose status bar takes 59 pt (the safe area of the iPhone with
	/// that frame): the content starts under the safe area, so the header is pushed down by the difference, as
	/// on the genre screen (`GenresStepLayout.headerTop`).
	static let headerTop: CGFloat = 78
	static let referenceTopInset: CGFloat = 59
	static var headerTopPadding: CGFloat { headerTop - referenceTopInset }
	/// Side margin of the header: the content column is the width minus twice this, 345 pt on the frame.
	static let headerSideInset = Track1Tokens.spacing24
	static let headerBottomInset = Track1Tokens.spacing16
	/// Between the title and the subtitle.
	static let headerTextSpacing = Track1Tokens.spacing8
	static var titleWidth: CGFloat { frameWidth - 2 * headerSideInset }

	static let titleRole: Track1TextRole = .title1
	static let subtitleRole: Track1TextRole = .bodyMedium
	static let titleColor = Track1Tokens.colorTextPrimary
	static let subtitleColor = Track1Tokens.colorTextSecondary

	/// The scene: the outline of an iPhone and the preview of the notification, cropped to its own edges.
	static let sceneSize = CGSize(width: 345, height: 520)
	static let sceneTop: CGFloat = 248
	static let deviceOutlineOrigin = CGPoint(x: 35, y: 99)
	static let previewOrigin = CGPoint(x: 9, y: 249)
	static let previewWidth: CGFloat = 327

	/// The fade of the action bar spans y 657 to the bottom of the frame. It is the height of the fade
	/// `BottomActionBar` draws, a test keeps the two in line.
	static let barTop: CGFloat = 657
	static let barHeight: CGFloat = 195

	/// `screen/gradient-top` at the top, `background/elevated` from 33.099 % of the height down, as on the
	/// neighbouring screens.
	static let backgroundStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorScreenGradientTop, location: 0),
		.init(color: Track1Tokens.colorBackgroundElevated, location: 0.33099),
	]
}

/// One passage on the opt-in screen: asks the system once, whatever the answer, then lets the flow go on.
///
/// A second touch while the question is open does nothing. After the answer a touch only goes on again with
/// that same answer, without asking: the host can stay on the screen (the onboarding keeps it when the
/// profile cannot be written) and tells the person to touch "Continuer" again. The state is a reference of
/// its own so that the screen, rebuilt by its parent, keeps it.
@MainActor
final class NotificationOptInPassage {
	enum Phase: Equatable {
		case idle
		case requesting
		case answered(granted: Bool)
	}

	private(set) var phase = Phase.idle

	func proceed(center: any ReminderCenter, onContinue: (_ granted: Bool) -> Void) async {
		switch phase {
		case .requesting:
			return
		case .answered(let granted):
			onContinue(granted)
		case .idle:
			phase = .requesting
			let granted = await center.requestAuthorization()
			phase = .answered(granted: granted)
			onContinue(granted)
		}
	}
}

/// The last step of the onboarding (TRA-746): explains the daily reminder, and "Continuer" opens the system
/// prompt. Nothing is asked before that touch. Local notifications only: no push capability.
///
/// Contract: the ticket gave `init(onContinue:)`. The center is injected, so that the screen is tested and
/// driven by the UI tests without the system prompt, and `onContinue` receives the answer, which the host
/// that already holds a profile needs to plan the reminders (the onboarding ignores it: Today plans them).
struct NotificationOptInView: View {
	typealias Metrics = NotificationOptInMetrics

	/// The screen as a whole, and the button of its bar.
	static let identifier = "onboarding-notifications"
	static let continueIdentifier = "onboarding-notifications-continue"

	static let title = "Obtiens ta recommandation quotidienne"
	static let subtitle = "Chaque jour, un track ou album de tes genres sélectionnés"
	static let continueTitle = "Continuer"
	/// The title is the one of the real notification, so the preview cannot drift from it.
	static let previewTitle = ReminderPlan.title
	static let previewBody = "Aphex Twin, album Selected Ambient Works 85-92"

	/// VoiceOver reads the title as a heading, then the subtitle, the preview and the button: the order of the
	/// views of `body`, the outline of the phone being hidden.
	static var titleTraits: AccessibilityTraits { .isHeader }

	/// The bar as the screen builds it, so a test reads the parameters the screen really passes: no counter, and
	/// the fade over the scene.
	@MainActor
	static func actionBar(onContinue: @escaping () -> Void) -> BottomActionBar {
		BottomActionBar(
			title: continueTitle, isEnabled: true, counter: nil, identifier: continueIdentifier, showsFade: true,
			action: onContinue)
	}

	private let center: any ReminderCenter
	private let onContinue: (_ granted: Bool) -> Void
	@State private var passage = NotificationOptInPassage()

	init(center: any ReminderCenter, onContinue: @escaping (_ granted: Bool) -> Void) {
		self.center = center
		self.onContinue = onContinue
	}

	var body: some View {
		ZStack(alignment: .top) {
			ScrollView {
				VStack(spacing: 0) {
					header
					scene
				}
				.frame(maxWidth: .infinity)
			}
			.scrollBounceBehavior(.basedOnSize)
			// Figma measures the bar from the physical bottom edge (the fade from y 657 to 852): it ignores the
			// bottom safe area, as on the pseudo screen.
			Self.actionBar(onContinue: continueTapped)
				.frame(maxHeight: .infinity, alignment: .bottom)
				.ignoresSafeArea(.container, edges: .bottom)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background {
			LinearGradient(stops: Metrics.backgroundStops, startPoint: .top, endPoint: .bottom)
				.ignoresSafeArea()
		}
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier(Self.identifier)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: Metrics.headerTextSpacing) {
			Track1Text(Self.title, role: Metrics.titleRole)
				.foregroundStyle(Metrics.titleColor)
				.accessibilityAddTraits(Self.titleTraits)
			Track1Text(Self.subtitle, role: Metrics.subtitleRole)
				.foregroundStyle(Metrics.subtitleColor)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, Metrics.headerSideInset)
		.padding(.top, Metrics.headerTopPadding)
		.padding(.bottom, Metrics.headerBottomInset)
	}

	private var scene: some View {
		ZStack(alignment: .topLeading) {
			DeviceOutline()
				.offset(x: Metrics.deviceOutlineOrigin.x, y: Metrics.deviceOutlineOrigin.y)
			NotificationPreview(title: Self.previewTitle, body: Self.previewBody)
				.frame(width: Metrics.previewWidth)
				.offset(x: Metrics.previewOrigin.x, y: Metrics.previewOrigin.y)
		}
		.frame(width: Metrics.sceneSize.width, height: Metrics.sceneSize.height, alignment: .topLeading)
		.clipped()
		.frame(maxWidth: .infinity)
	}

	private func continueTapped() {
		let passage = passage
		let center = center
		let onContinue = onContinue
		Task { @MainActor in
			await passage.proceed(center: center, onContinue: onContinue)
		}
	}
}
