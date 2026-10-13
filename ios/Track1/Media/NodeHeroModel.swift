import Observation
import SwiftUI
import Track1Core
import UIKit

/// What the hero of a node page shows: the first image of the node's fallback chain, and its tint.
///
/// Every URL and identity in the chain is untrusted API data and goes through `NodeImageStore`, which
/// validates URLs and redirects before anything is requested.
///
/// The candidates are fixed when the model is created: one model per node, so the view that owns it must be
/// keyed by the node (`.id(node.id)`).
@MainActor @Observable
final class NodeHeroModel {
	enum State: Equatable {
		case loading
		case loaded(UIImage, tint: Color?)
		case placeholder
	}

	private(set) var state: State = .loading

	@ObservationIgnored private let candidates: [HeroCandidate]
	@ObservationIgnored private let store: NodeImageStore<UIImage>

	init(node: NodeDetail, store: NodeImageStore<UIImage>) {
		candidates = HeroImageSource.candidates(for: node)
		self.store = store
	}

	/// Tries the candidates in order; the first image wins, and none leaves the placeholder. A load that
	/// finishes after its screen went away (task cancelled) changes nothing: the state stays `loading`, so a
	/// later `load` starts again instead of showing a stale answer.
	func load() async {
		guard case .loading = state else { return }
		let image = await HeroImageSource.firstImage(among: candidates, store: store)
		guard !Task.isCancelled else { return }
		if let image {
			state = .loaded(image, tint: DominantColor.of(image))
		} else {
			state = .placeholder
		}
	}
}
