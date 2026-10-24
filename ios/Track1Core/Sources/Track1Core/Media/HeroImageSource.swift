import Foundation

/// One place the hero image of a node page may come from, tried in order (plan F.4, Data contract hero rows).
public enum HeroCandidate: Equatable, Sendable {
	/// An image URL the API sent for the node itself (`image_url`).
	case url(URL)
	/// A node whose `/image` stands in for this one: the node itself, whose answer the server derives from a
	/// release that declares it, or a track's own project.
	case node(NodeIdentity)
}

/// How the hero draws the image it got (plan Part 3, decision 5: an album cover on an artist, label or genre
/// page is never presented as a photo).
public enum HeroImageStyle: Equatable, Sendable {
	/// The image fills the frame: a portrait, a logo, or the node's own release cover.
	case photo
	/// A release cover standing in for the node: shown whole (aspect fit) over the type gradient.
	case derivedCover
}

/// Which images a node page hero may use, and the fallback chain over them.
///
/// Every node kind carries its own `image_url` (TRA-455), so it always comes first. The edges carry no cover
/// (D10, Q5).
///
/// 2026-10-24 (TRA-593): the hero used to borrow the `/image` of the first work listed on the page
/// (`discography`, `notable_releases`, `landmark_*`). Such a list can be polluted by a homonym or a
/// hallucination, and the borrowed work then lends a stranger's sleeve to the page (the server saw
/// label:mille-plateaux get the cover of Electric Ladyland, a Reprise release, TRA-591). A page edge carries
/// neither the work's label, nor its artists, nor its genres, so the client cannot tell which work points
/// back at the node. The server can: `/image` of the node itself borrows a cover only from a work that
/// declares the node (TRA-591, TRA-592, TRA-597). So an artist, label or genre with no `image_url` asks for
/// its own `/image`, and shows the type gradient when the server finds no reciprocal work.
/// A track still takes its own project's cover: that is its album, not a list.
public enum HeroImageSource {
	public static func candidates(for node: NodeDetail) -> [HeroCandidate] {
		candidates(type: node.type, id: node.id, imageURL: node.imageURL, edges: node.edges)
	}

	/// Takes the parts rather than a `NodeDetail` because decoding already refuses a non-HTTPS `image_url`:
	/// this entry point is what lets the second check be exercised on its own.
	///
	/// Every URL is untrusted API data. One that fails `URLValidation.publicHTTPSURL` is skipped as a
	/// candidate, and the next one is tried.
	public static func candidates(
		type: NodeType, id: NodeIdentity, imageURL: URL?, edges: [String: NodeEdgeValue]
	) -> [HeroCandidate] {
		let own = imageURL.flatMap { URLValidation.publicHTTPSURL(from: $0.absoluteString) }.map(
			HeroCandidate.url)
		switch type {
		case .artist, .label, .genre: return [own ?? .node(id)]
		case .project: return own.map { [$0] } ?? []
		case .track: return [own, first(of: edges["project"])].compactMap { $0 }
		}
	}

	/// How the hero draws the image that came from `candidate`. Only artist, label and genre pages can show a
	/// cover standing in for themselves; a project or a track draws its own cover (or its project's) as is.
	///
	/// - The node's own image (`.url`) is a derived cover when the API says so (`image_source`).
	/// - An image read from a node's `/image` (`.node`) is always a release cover, never the node's own picture.
	public static func style(of candidate: HeroCandidate, type: NodeType, imageSource: String?) -> HeroImageStyle
	{
		switch type {
		case .project, .track: return .photo
		case .artist, .label, .genre:
			switch candidate {
			case .node: return .derivedCover
			case .url: return imageSource == derivedCoverSource ? .derivedCover : .photo
			}
		}
	}

	/// The `image_source` the server gives to a cover derived from a release.
	private static let derivedCoverSource = "derived-cover"

	/// The first candidate that yields an image, or `nil` when none does or the caller was cancelled.
	/// A candidate the server is still resolving (`pending`) is skipped without waiting, so a node with no
	/// image of its own shows a derived cover now rather than after a minute (TRA-586).
	/// Candidates are tried one after the other, never in parallel: the first one usually wins and a
	/// speculative `/image` read for the rest would only cost requests.
	public static func firstImage<Image: Sendable>(
		among candidates: [HeroCandidate], store: NodeImageStore<Image>
	) async -> Image? {
		await firstMatch(among: candidates, store: store)?.image
	}

	/// Like `firstImage`, and also says which candidate produced the image, so the caller can pick its style.
	public static func firstMatch<Image: Sendable>(
		among candidates: [HeroCandidate], store: NodeImageStore<Image>
	) async -> (image: Image, candidate: HeroCandidate)? {
		for candidate in candidates {
			if Task.isCancelled { return nil }
			let image: Image?
			switch candidate {
			case .url(let url): image = await store.image(at: url)
			case .node(let identity): image = await store.image(for: identity, policy: .noWait)
			}
			if Task.isCancelled { return nil }
			if let image { return (image, candidate) }
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
