import SwiftUI

struct NodeView: View {
	@State private var model: NodeViewModel
	@Environment(\.openURL) private var openURL
	private let openRelation: (NodeIdentity, NavigationContext) -> Void

	init(model: NodeViewModel, openRelation: @escaping (NodeIdentity, NavigationContext) -> Void) {
		_model = State(initialValue: model)
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
						NodeListeningView(
							state: model.listening,
							isOpening: model.isOpeningListening,
							failure: model.listeningFailure,
							open: { action in
								Task { await model.openListening(action, using: { await openURL.open($0) }) }
							}
						)
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
			case .missing:
				ContentUnavailableView {
					Label("Fiche indisponible", systemImage: "music.note.list")
				} description: {
					Text("Cette fiche n’existe pas encore dans track1.")
						.accessibilityIdentifier("node-missing")
				}
			case .failed:
				ContentUnavailableView {
					Label("Impossible de charger cette fiche", systemImage: "wifi.exclamationmark")
				} description: {
					Text("Réessayez dans un instant.")
						.accessibilityIdentifier("node-failed")
				} actions: {
					Button("Réessayer") { Task { await model.load() } }
						.buttonStyle(.bordered)
						.accessibilityIdentifier("node-retry")
				}
			}
		}
		.navigationTitle("Fiche")
		.navigationBarTitleDisplayMode(.inline)
		.task { await model.load() }
	}

	private func header(_ node: NodeDetail) -> some View {
		VStack(spacing: 8) {
			Text(NodePresentation.typeName(node.type).uppercased())
				.font(.subheadline.weight(.semibold))
				.foregroundStyle(.secondary)
			// verbatim: name and teaser come from the API and must not be interpreted as Markdown.
			Text(verbatim: node.name)
				.font(.title.bold())
				.multilineTextAlignment(.center)
			if let teaser = node.teaser {
				Text(verbatim: teaser)
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
