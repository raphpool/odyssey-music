import Foundation
import Observation

/// Selection state of the single-screen onboarding accordion: one card per family, and only genres are ticked
/// (the chips of a card). A family is never stored here, it is derived from the genres ticked in it, so there
/// is no "family alone means the whole family" state to carry (plan D1). It reasons on the editorial
/// taxonomy: families are keyed by `String`, genres by taxonomy id, never by `NodeIdentity` (plan D3).
/// Nothing is persisted until the caller saves the `ProfileDraft`.
@MainActor
@Observable
public final class GenreSelectionModel {
	/// Taxonomy ids of the ticked genres, in tick order and without duplicates. The order matters: it is what
	/// `selection.genres` stores and what a reload reads back, so keeping it makes a reload a fixed point.
	public private(set) var selectedGenres: [String]

	private let taxonomy: EditorialGenreTaxonomy
	private let editing: Profile?
	private let flowID: UUID
	private let onboardingStartedRecorded: Bool

	/// The v1 slugs with no editorial equivalent. Always empty here: restoring a v1 profile is a separate
	/// ticket (1.3), which fills it. It stays a plain value: showing it is not this model's job.
	public let droppedGenreIDs: [NodeIdentity]

	/// `draft` is the one the `ProfileStore` already holds for this flow. It carries the `flow_id` shared with
	/// analytics and the "start event already sent" flag, and `makeDraft()` must hand both back unchanged:
	/// a fresh draft would reset the flag and a resumed flow would send `onboarding_started` twice.
	///
	/// This is also the path that rebuilds the state from an existing profile (`editing`, used by the edit
	/// flow). A stored selection is a fixed point of `restore`, so a profile created by this flow reloads
	/// unchanged. A profile without a selection (written before the editorial taxonomy) restores an empty
	/// selection for now: rebuilding it from its v1 slugs is a separate ticket. A draft without a selection
	/// is not a profile, so it defers to the selection of `editing`, if any.
	public init(taxonomy: EditorialGenreTaxonomy, editing: Profile? = nil, draft: ProfileDraft? = nil) {
		self.taxonomy = taxonomy
		self.editing = editing
		flowID = draft?.flowID ?? editing?.flowID ?? UUID()
		onboardingStartedRecorded = draft?.onboardingStartedRecorded ?? false
		if let stored = draft?.selection ?? editing?.selection {
			selectedGenres = Self.restore(stored, in: taxonomy)
		} else {
			selectedGenres = []
		}
		droppedGenreIDs = []
	}

	/// Rules, applied to the stored selection. What the taxonomy cannot show any more is discarded in silence:
	/// 1. A genre is ticked if the taxonomy still shows it, in the stored order, once.
	/// 2. A stored family that the taxonomy still shows and in which no genre got ticked by rule 1 ticks all
	///    its visible genres, in served order. Before this screen a family alone meant the whole family, and
	///    the recommendation used all of it: ticking it keeps the same `genre_ids` and shows what is used.
	/// A genre whose stored family is missing is still ticked by rule 1: the ticked genres are the truth.
	private static func restore(_ stored: GenreSelection, in taxonomy: EditorialGenreTaxonomy) -> [String] {
		var genres = [String]()
		for id in stored.genres where taxonomy.genre(id) != nil && !genres.contains(id) {
			genres.append(id)
		}
		for key in stored.families where taxonomy.family(key) != nil {
			let visible = taxonomy.genres(of: key).map(\.id)
			if visible.contains(where: { genres.contains($0) }) { continue }
			genres.append(contentsOf: visible)
		}
		return genres
	}

	/// The cards of the screen, in display order. The model hands them out so the screen never holds the
	/// taxonomy itself: it reads and toggles through the model only.
	public var familyChoices: [FamilyChoice] { taxonomy.families }

	/// The chips of a card, in served order. An unknown key has none.
	public func subgenres(of family: String) -> [EditorialGenreChoice] {
		taxonomy.genres(of: family)
	}

	public func isSubgenreSelected(_ id: String) -> Bool {
		selectedGenres.contains(id)
	}

	/// An id the taxonomy does not show (unknown, or without a slug in the catalog) is ignored, so a stale
	/// call can never tick a genre that no card can display.
	public func toggleSubgenre(_ id: String) {
		if let index = selectedGenres.firstIndex(of: id) {
			selectedGenres.remove(at: index)
		} else if taxonomy.genre(id) != nil {
			selectedGenres.append(id)
		}
	}

	/// Unticks the whole card when it is complete, otherwise ticks what is missing, after the genres already
	/// ticked. An unknown key has no genre, so nothing changes.
	public func toggleAll(of family: String) {
		let all = taxonomy.genres(of: family).map(\.id)
		if isAllSelected(of: family) {
			selectedGenres.removeAll { all.contains($0) }
		} else {
			let missing = all.filter { !selectedGenres.contains($0) }
			selectedGenres.append(contentsOf: missing)
		}
	}

	/// Derived from the selection, not stored, so ticking every chip by hand also counts.
	public func isAllSelected(of family: String) -> Bool {
		let all = taxonomy.genres(of: family).map(\.id)
		return !all.isEmpty && all.allSatisfy { selectedGenres.contains($0) }
	}

	public func selectedCount(of family: String) -> Int {
		taxonomy.genres(of: family).filter { selectedGenres.contains($0.id) }.count
	}

	public var selectedSubgenreCount: Int { selectedGenres.count }

	public var canContinue: Bool { selectedSubgenreCount >= 1 }

	/// The edit flow has no Welcome screen and ends on "Enregistrer": it starts from a saved profile.
	public var isEditing: Bool { editing != nil }

	public var ctaTitle: String { isEditing ? "Enregistrer" : "Continuer" }

	/// The families with at least one ticked genre, as cards, in card order (not tick order, which has no
	/// effect on the recommendation). The Genres tab shows these.
	public var selectedFamilyChoices: [FamilyChoice] {
		taxonomy.families.filter { selectedCount(of: $0.id) > 0 }
	}

	public var selectedFamilies: [String] { selectedFamilyChoices.map(\.id) }

	/// With no genre there is no valid `GenreSelection` (it needs at least one family), so the draft then
	/// carries none and an empty `genreIDs`: the same "nothing chosen yet" the profile store already refuses.
	public func makeDraft() -> ProfileDraft {
		guard !selectedGenres.isEmpty else {
			return ProfileDraft(
				version: Profile.version, flowID: flowID, genreIDs: [],
				onboardingStartedRecorded: onboardingStartedRecorded)
		}
		let selection = GenreSelection(families: selectedFamilies, genres: selectedGenres)
		return ProfileDraft(
			version: Profile.version,
			flowID: flowID,
			genreIDs: selection.derivedGenreIDs(in: taxonomy),
			onboardingStartedRecorded: onboardingStartedRecorded,
			selection: selection
		)
	}
}
