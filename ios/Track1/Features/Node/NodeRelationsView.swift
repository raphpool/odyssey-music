import SwiftUI

/// Relations of one kind (`artists`, `projects`, ...) as the API keys them.
struct NodeRelationGroup: Identifiable {
	let kind: String
	let relations: [NodeEdge]
	var id: String { kind }

	/// Fixed French labels for the kinds the API documents. Any other key is untrusted API text: it is
	/// only made readable (`_` and `-` become spaces) and must still be shown with `Text(verbatim:)`.
	var label: String {
		switch kind {
		case "artists": "Artistes"
		case "projects": "Projets"
		case "tracks": "Titres"
		case "genres": "Genres"
		case "labels": "Labels"
		default: kind.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
		}
	}

	/// Non-empty groups sorted by kind: a dictionary has no order, and a stable one keeps the screen
	/// from reshuffling between two loads of the same node.
	static func groups(from edges: [String: NodeEdgeValue]) -> [NodeRelationGroup] {
		edges.compactMap { kind, value in
			let relations: [NodeEdge]
			switch value {
			case .one(let edge): relations = [edge]
			case .many(let edges): relations = edges
			}
			guard !relations.isEmpty else { return nil }
			return NodeRelationGroup(kind: kind, relations: relations)
		}
		.sorted { $0.kind < $1.kind }
	}
}

/// Refuses a second tap on the same relation shortly after the first, so a double tap neither pushes
/// the same node twice nor records the event twice.
struct RelationTapGuard {
	static let window: TimeInterval = 0.75

	private var last: (key: String, date: Date)?

	/// A refused tap does not restart the window: the guard measures from the last accepted tap.
	mutating func shouldOpen(key: String, at date: Date) -> Bool {
		if let last, last.key == key, date.timeIntervalSince(last.date) < Self.window { return false }
		last = (key, date)
		return true
	}
}

struct NodeRelationsView: View {
	let edges: [String: NodeEdgeValue]
	let fromNodeID: NodeIdentity
	let context: NavigationContext
	let recordEvent: NodeEventRecorder?
	let openDestination: (NodeIdentity, NavigationContext) -> Void

	@State private var tapGuard = RelationTapGuard()

	var body: some View {
		let groups = NodeRelationGroup.groups(from: edges)
		if !groups.isEmpty {
			VStack(alignment: .leading, spacing: Track1Theme.contentSpacing) {
				Text("Explorer les relations")
					.font(.title2.bold())
					.accessibilityAddTraits(.isHeader)
				ForEach(groups) { group in
					VStack(alignment: .leading, spacing: 4) {
						// verbatim: an unknown relation kind comes from the API.
						Text(verbatim: group.label)
							.font(.subheadline.weight(.semibold))
							.foregroundStyle(.secondary)
							.accessibilityAddTraits(.isHeader)
						ForEach(group.relations, id: \.slug) { relation in
							relationRow(relation, kind: group.kind)
						}
					}
				}
			}
		}
	}

	private func relationRow(_ relation: NodeEdge, kind: String) -> some View {
		Button {
			Self.open(
				relation, kind: kind, from: fromNodeID, context: context, tapGuard: &tapGuard, at: .now,
				recordEvent: recordEvent, openDestination: openDestination)
		} label: {
			HStack(spacing: 12) {
				VStack(alignment: .leading, spacing: 2) {
					// verbatim: name, year and release type come from the API.
					Text(verbatim: relation.name).font(.headline)
					if let subtitle = Self.subtitle(relation) {
						Text(verbatim: subtitle).font(.subheadline).foregroundStyle(.secondary)
					}
				}
				Spacer()
				Image(systemName: "chevron.right").foregroundStyle(.tertiary)
			}
			.frame(maxWidth: .infinity, minHeight: Track1Theme.minimumHitTarget, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(Text(verbatim: "Ouvrir \(relation.name)"))
	}

	/// One gesture: record `relation_opened`, then navigate with the attribution carried over. Returns
	/// false, doing neither, when the guard treats the tap as a repeat.
	@MainActor
	@discardableResult
	static func open(
		_ relation: NodeEdge,
		kind: String,
		from fromNodeID: NodeIdentity,
		context: NavigationContext,
		tapGuard: inout RelationTapGuard,
		at date: Date,
		recordEvent: NodeEventRecorder?,
		openDestination: (NodeIdentity, NavigationContext) -> Void
	) -> Bool {
		guard tapGuard.shouldOpen(key: "\(kind)-\(relation.slug.rawValue)", at: date) else { return false }
		recordEvent?(
			NodeAnalytics.relationOpened(from: fromNodeID, relation: relation, kind: kind, context: context))
		openDestination(relation.slug, context.followingRelation())
		return true
	}

	static func subtitle(_ relation: NodeEdge) -> String? {
		let subtitle = [relation.year, relation.releaseType].compactMap { $0 }.joined(separator: " · ")
		return subtitle.isEmpty ? nil : subtitle
	}
}
