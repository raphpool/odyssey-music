import Foundation

/// The three variants of the node page hero (Figma `Hero`, ensemble `171:34`, doc `171:36`), kept free of
/// SwiftUI so that `swift test` covers the type mapping. One variant per node family.
public enum NodeHeroKind: CaseIterable, Sendable {
	/// Project and track: a jewel case with a partially exposed disc.
	case release
	/// Artist: a circular photo.
	case artist
	/// Genre and label: a square cover.
	case cover

	public init(_ type: NodeType) {
		switch type {
		case .project, .track: self = .release
		case .artist: self = .artist
		case .genre, .label: self = .cover
		}
	}
}
