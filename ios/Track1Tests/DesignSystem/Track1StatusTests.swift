import XCTest

@testable import Track1

/// The table is spelled out again here from the TRA-386 ticket (Q1, validated 2026-10-11): a string or an
/// identifier changed in `Track1Status` alone fails here.
final class Track1StatusTests: XCTestCase {
	private typealias Row = (
		status: Track1Status, title: String, message: String?, action: String?, identifier: String,
		actionIdentifier: String?
	)

	private let table: [Row] = [
		(
			.nodeMissing, "Pas encore de fiche", "Cette page n'existe pas encore dans track1.", nil,
			"node-missing", nil
		),
		(.nodeFailed, "Fiche indisponible", nil, "Réessayer", "node-failed", "node-retry"),
		(
			.todayEmpty, "Aucune découverte pour ces goûts", nil, "Modifier mes genres", "today-empty",
			"today-edit-genres"
		),
		(.todayUnavailable, "Découverte indisponible", nil, "Réessayer", "today-unavailable", "today-retry"),
		(.searchFailed, "Recherche indisponible", nil, "Réessayer", "search-failed", "search-retry"),
		(
			.loadingTimeout, "Ça prend plus de temps que prévu", nil, "Réessayer", "loading-timeout",
			"loading-retry"
		),
	]

	func testEveryCaseReturnsTheTitleMessageButtonAndIdentifiersOfTheTable() {
		for row in table {
			XCTAssertEqual(
				row.status.content,
				Track1Status.StatusContent(
					title: row.title, message: row.message, actionTitle: row.action,
					identifier: row.identifier, actionIdentifier: row.actionIdentifier),
				"\(row.status)")
		}
	}

	func testTheTableCoversEveryCaseOnce() {
		XCTAssertEqual(table.count, Track1Status.allCases.count)
		XCTAssertEqual(Set(table.map(\.status)), Set(Track1Status.allCases))
	}

	func testOnlyNodeMissingHasNoAction() {
		for status in Track1Status.allCases {
			let content = status.content
			let hasAction = status != .nodeMissing
			XCTAssertEqual(content.actionTitle != nil, hasAction, "\(status) button")
			XCTAssertEqual(content.actionIdentifier != nil, hasAction, "\(status) action identifier")
		}
	}

	func testTheV1TestsStillFindTheirIdentifiers() {
		XCTAssertEqual(Track1Status.nodeMissing.content.identifier, "node-missing")
		XCTAssertEqual(Track1Status.nodeFailed.content.identifier, "node-failed")
		XCTAssertEqual(Track1Status.nodeFailed.content.actionIdentifier, "node-retry")
	}

	func testIdentifiersAreUniqueAcrossStatuses() {
		let identifiers = Track1Status.allCases.flatMap { status in
			[status.content.identifier] + [status.content.actionIdentifier].compactMap { $0 }
		}
		XCTAssertEqual(Set(identifiers).count, identifiers.count)
	}

	func testTheButtonIsShownOnlyWhenAnActionIsGiven() {
		XCTAssertEqual(Track1StatusView.visibleActionTitle(for: .nodeFailed, hasAction: true), "Réessayer")
		XCTAssertNil(Track1StatusView.visibleActionTitle(for: .nodeFailed, hasAction: false))
		XCTAssertNil(Track1StatusView.visibleActionTitle(for: .nodeMissing, hasAction: true))
	}
}
