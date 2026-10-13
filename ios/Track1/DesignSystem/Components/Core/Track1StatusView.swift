import SwiftUI

/// The states Figma does not draw (D14): a missing or failed page, an empty or unavailable Today, a failed
/// search and a loading that took too long. They are composed from drawn components, so no visual is
/// invented here. The copy lives in `content` only, so that a change of language touches this file alone.
enum Track1Status: CaseIterable {
	case nodeMissing, nodeFailed, todayEmpty, todayUnavailable, searchFailed, loadingTimeout

	struct StatusContent: Equatable {
		let title: String
		let message: String?
		let actionTitle: String?
		/// Accessibility identifier of the status. The V1 tests read `node-missing`, `node-failed` and
		/// `node-retry`: they stay as they are.
		let identifier: String
		let actionIdentifier: String?
	}

	/// French copy validated at the 2026-10-11 gate (Q1).
	var content: StatusContent {
		switch self {
		case .nodeMissing:
			StatusContent(
				title: "Pas encore de fiche", message: "Cette page n'existe pas encore dans track1.",
				actionTitle: nil, identifier: "node-missing", actionIdentifier: nil)
		case .nodeFailed:
			StatusContent(
				title: "Fiche indisponible", message: nil, actionTitle: "Réessayer",
				identifier: "node-failed", actionIdentifier: "node-retry")
		case .todayEmpty:
			StatusContent(
				title: "Aucune découverte pour ces goûts", message: nil, actionTitle: "Modifier mes genres",
				identifier: "today-empty", actionIdentifier: "today-edit-genres")
		case .todayUnavailable:
			StatusContent(
				title: "Découverte indisponible", message: nil, actionTitle: "Réessayer",
				identifier: "today-unavailable", actionIdentifier: "today-retry")
		case .searchFailed:
			StatusContent(
				title: "Recherche indisponible", message: nil, actionTitle: "Réessayer",
				identifier: "search-failed", actionIdentifier: "search-retry")
		case .loadingTimeout:
			StatusContent(
				title: "Ça prend plus de temps que prévu", message: nil, actionTitle: "Réessayer",
				identifier: "loading-timeout", actionIdentifier: "loading-retry")
		}
	}
}

/// A centered column: title (Title/3), optional message (Body/Medium, secondary text) and an optional
/// Secondary Medium button. The screen that shows it owns the background and the Ambient glow, which sit
/// behind every screen. A status that has an action but receives none shows no button, since a button that
/// does nothing is worse than none.
struct Track1StatusView: View {
	private let status: Track1Status
	private let action: (() -> Void)?

	init(_ status: Track1Status, action: (() -> Void)?) {
		self.status = status
		self.action = action
	}

	/// The button title shown for `status`, or `nil` when the status has no action or none was given.
	static func visibleActionTitle(for status: Track1Status, hasAction: Bool) -> String? {
		hasAction ? status.content.actionTitle : nil
	}

	var body: some View {
		// Scrolls when the column outgrows the screen (accessibility sizes), so the button stays reachable;
		// `minHeight` keeps it centered otherwise.
		GeometryReader { proxy in
			ScrollView {
				column.frame(maxWidth: .infinity, minHeight: proxy.size.height)
			}
			.scrollBounceBehavior(.basedOnSize)
		}
	}

	private var column: some View {
		let content = status.content
		return VStack(spacing: Track1Tokens.spacing16) {
			Track1Text(content.title, role: .title3)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.accessibilityIdentifier(content.identifier)
				.accessibilityAddTraits(.isHeader)
			if let message = content.message {
				Track1Text(message, role: .bodyMedium)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
			}
			if let title = Self.visibleActionTitle(for: status, hasAction: action != nil), let action {
				Track1Button(title, kind: .secondary, size: .medium, action: action)
					.accessibilityIdentifier(content.actionIdentifier ?? "")
					.padding(.top, Track1Tokens.spacing8)
			}
		}
		.multilineTextAlignment(.center)
		.padding(Track1Tokens.spacing24)
	}
}
