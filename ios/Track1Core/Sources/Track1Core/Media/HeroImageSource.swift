import Foundation

/// One place the hero image of a node page may come from, tried in order (plan F.4, Data contract hero rows).
public enum HeroCandidate: Equatable, Sendable {
	/// An image URL the API sent for the node itself (`image_url`).
	case url(URL)
	/// Another node whose `/image` stands in for this one: a cover of the node's own releases.
	case node(NodeIdentity)
}

/// Which images a node page hero may use, and the fallback chain over them.
///
/// Every node kind carries its own `image_url` (TRA-455), so it always comes first. The edges carry no cover
/// (D10, Q5): the fallback after it borrows the cover of a landmark release. For a genre the last step is
/// `landmark_tracks[0]`: its `/image` answers with the cover of the track or of its project, which spares a
/// `/node` read followed by a second `/image`.
public enum HeroImageSource {
	public static func candidates(for node: NodeDetail) -> [HeroCandidate] {
		candidates(type: node.type, imageURL: node.imageURL, edges: node.edges)
	}

	/// Takes the parts rather than a `NodeDetail` because decoding already refuses a non-HTTPS `image_url`:
	/// this entry point is what lets the second check be exercised on its own.
	///
	/// Every URL is untrusted API data. One that fails `URLValidation.publicHTTPSURL` is skipped as a
	/// candidate, and the next one is tried.
	public static func candidates(
		type: NodeType, imageURL: URL?, edges: [String: NodeEdgeValue]
	) -> [HeroCandidate] {
		let own = imageURL.flatMap { URLValidation.publicHTTPSURL(from: $0.absoluteString) }.map(
			HeroCandidate.url)
		let steps: [HeroCandidate?]
		switch type {
		case .artist: steps = [own, first(of: edges["discography"])]
		case .project: steps = [own]
		case .track: steps = [own, first(of: edges["project"])]
		case .genre:
			steps = [own, first(of: edges["landmark_projects"]), first(of: edges["landmark_tracks"])]
		case .label: steps = [own, first(of: edges["notable_releases"])]
		}
		return steps.compactMap { $0 }
	}

	/// The first candidate that yields an image, or `nil` when none does or the caller was cancelled.
	/// Candidates are tried one after the other, never in parallel: the first one usually wins and a
	/// speculative `/image` read for the rest would only cost requests.
	public static func firstImage<Image: Sendable>(
		among candidates: [HeroCandidate], store: NodeImageStore<Image>
	) async -> Image? {
		for candidate in candidates {
			if Task.isCancelled { return nil }
			let image: Image?
			switch candidate {
			case .url(let url): image = await store.image(at: url)
			case .node(let identity): image = await store.image(for: identity)
			}
			if Task.isCancelled { return nil }
			if let image { return image }
		}
		return nil
	}

	private static func first(of value: NodeEdgeValue?) -> HeroCandidate? {
		switch value {
		case .one(let edge): .node(edge.slug)
		case .many(let edges): edges.first.map { .node($0.slug) }
		case nil: nil
		}
	}
}
