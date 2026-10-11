import SwiftUI

struct NodeView: View {
	@State private var model: NodeViewModel

	init(model: NodeViewModel) {
		_model = State(initialValue: model)
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
