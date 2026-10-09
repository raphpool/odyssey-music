import Foundation
import SwiftUI

struct NodeView: View {
	@State private var model: NodeViewModel
	let imageSession: URLSession
	let openRelation: (NodeIdentity, NavigationContext) -> Void

	init(
		model: NodeViewModel,
		imageSession: URLSession,
		openRelation: @escaping (NodeIdentity, NavigationContext) -> Void
	) {
		_model = State(initialValue: model)
		self.imageSession = imageSession
		self.openRelation = openRelation
	}

	var body: some View {
		Group {
			switch model.state {
			case .loading:
				ProgressView("Chargement de la fiche")
			case .loaded(let node):
				ScrollView {
					VStack(alignment: .leading, spacing: Track1Theme.contentSpacing) {
						header(node)
						NodeArticleView(article: node.article, citations: node.citations)
						NodeRelationsView(
							edges: node.edges,
							fromNodeID: node.id,
							context: model.context,
							recordEvent: model.relationEventRecorder,
							openDestination: openRelation
						)
					}
					.padding(Track1Theme.contentSpacing)
				}
			case .missing(let identity):
				ContentUnavailableView(
					"Fiche indisponible",
					systemImage: "music.note.list",
					description: Text("La fiche \(identity.rawValue) n’est pas encore disponible.")
				)
			case .failed:
				ContentUnavailableView(
					"Impossible de charger cette fiche",
					systemImage: "wifi.exclamationmark",
					description: Text("Réessayez plus tard.")
				)
			}
		}
		.task { await model.load() }
	}

	private func header(_ node: NodeDetail) -> some View {
		VStack(spacing: 8) {
			NodeImageView(type: node.type, name: node.name, state: model.imageState, session: imageSession)
			Text(NodePresentation.typeName(node.type).uppercased())
				.font(.subheadline.weight(.semibold))
				.foregroundStyle(Track1Theme.actionTint)
			Text(node.name)
				.font(.title.bold())
				.multilineTextAlignment(.center)
			if let teaser = node.teaser {
				Text(teaser)
					.font(.body)
					.foregroundStyle(.secondary)
					.multilineTextAlignment(.center)
			}
		}
		.frame(maxWidth: .infinity)
	}
}

enum NodePresentation {
	static func typeName(_ type: NodeType) -> String {
		switch type {
		case .artist: "Artiste"
		case .project: "Album"
		case .track: "Titre"
		case .genre: "Genre"
		case .label: "Label"
		}
	}
}
