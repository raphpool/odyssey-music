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
		case loaded(UIImage, tint: Color?, coverTint: CoverTint?)
		case placeholder
	}

	private(set) var state: State = .loading
	/// How to draw the loaded image; set before `state` leaves `loading`, so a view never pairs the new image
	/// with the previous style.
	private(set) var style: HeroImageStyle = .photo

	@ObservationIgnored private let candidates: [HeroCandidate]
	@ObservationIgnored private let type: NodeType
	@ObservationIgnored private let imageSource: String?
	@ObservationIgnored private let store: NodeImageStore<UIImage>

	init(node: NodeDetail, store: NodeImageStore<UIImage>) {
		candidates = HeroImageSource.candidates(for: node)
		type = node.type
		imageSource = node.imageSource
		self.store = store
	}

	/// Tries the candidates in order; the first image wins, and none leaves the placeholder. A load that
	/// finishes after its screen went away (task cancelled) changes nothing: the state stays `loading`, so a
	/// later `load` starts again instead of showing a stale answer.
	func load() async {
		guard case .loading = state else { return }
		let match = await HeroImageSource.firstMatch(among: candidates, store: store)
		guard !Task.isCancelled else { return }
		if let match {
			style = HeroImageSource.style(of: match.candidate, type: type, imageSource: imageSource)
			state = .loaded(
				match.image,
				tint: DominantColor.of(match.image),
				coverTint: DominantColor.bands(of: match.image).flatMap(CoverTintTone.tint(bands:)))
		} else {
			state = .placeholder
		}
	}
}
