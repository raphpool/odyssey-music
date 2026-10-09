import SwiftUI

struct NodeRelationsView: View {
	let edges: [String: NodeEdgeValue]
	let fromNodeID: NodeIdentity
	let context: NavigationContext
	let recordEvent: NodeEventRecorder?
	let openDestination: (NodeIdentity, NavigationContext) -> Void

	@State private var lastOpened: (key: String, date: Date)?

	var body: some View {
		let groups = relationGroups
		if !groups.isEmpty {
			VStack(alignment: .leading, spacing: Track1Theme.contentSpacing) {
				Text("Explorer les relations")
					.font(.title2.bold())
				ForEach(groups) { group in
					Section(group.label) {
						ForEach(group.relations, id: \.slug) { relation in
							Button {
								openRelation(relation, kind: group.kind)
							} label: {
								HStack(spacing: 12) {
									VStack(alignment: .leading, spacing: 2) {
										Text(relation.name).font(.headline)
										if let subtitle = relationSubtitle(relation) {
											Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
										}
									}
									Spacer()
									Image(systemName: "chevron.right").foregroundStyle(.tertiary)
								}
								.frame(maxWidth: .infinity, minHeight: Track1Theme.minimumHitTarget, alignment: .leading)
								.contentShape(Rectangle())
							}
							.buttonStyle(.plain)
							.accessibilityLabel("Ouvrir \(relation.name)")
						}
					}
				}
			}
		}
	}

	private var relationGroups: [NodeRelationGroup] {
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

	private func openRelation(_ relation: NodeEdge, kind: String) {
		let key = "\(kind)-\(relation.slug.rawValue)"
		let now = Date.now
		if let lastOpened, lastOpened.key == key, now.timeIntervalSince(lastOpened.date) < 0.75 { return }
		lastOpened = (key, now)

		recordEvent?(
			NodeAnalytics.relationOpened(from: fromNodeID, relation: relation, kind: kind, context: context))
		openDestination(relation.slug, context.followingRelation())
	}

	private func relationSubtitle(_ relation: NodeEdge) -> String? {
		[relation.year, relation.releaseType].compactMap { $0 }.joined(separator: " · ").nilIfEmpty
	}
}

private struct NodeRelationGroup: Identifiable {
	let kind: String
	let relations: [NodeEdge]
	var id: String { kind }
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
}

extension String {
	fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
