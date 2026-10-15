import Foundation
import Observation

/// Selection state of the editorial onboarding flow: families first (tiles), then one genre step per chosen
/// family (rows). It reasons on the editorial taxonomy: families are keyed by `String`, genres by taxonomy
/// id, never by `NodeIdentity` (plan D3). Nothing is persisted until the caller saves the `ProfileDraft`;
/// going back never loses a choice.
@MainActor
@Observable
public final class GenreOnboardingModel {
	public private(set) var selectedFamilies: [String]
	private var selectedGenres: [String]

	private let taxonomy: EditorialGenreTaxonomy
	private let editing: Profile?
	private let flowID: UUID
	private let onboardingStartedRecorded: Bool

	/// Stored genres that did not survive the load. Always empty for now: dropping a v1 genre that has no
	/// editorial equivalent belongs to the v1 restoration path (TRA-518), which is what fills this.
	public let droppedGenreIDs: [NodeIdentity] = []

	/// `draft` is the one the `ProfileStore` already holds for this flow. It carries the `flow_id` shared with
	/// analytics and the "start event already sent" flag, and `makeDraft()` must hand both back unchanged:
	/// a fresh draft would reset the flag and a resumed flow would send `onboarding_started` twice.
	///
	/// This is also the path that rebuilds the state from an existing profile (`editing`, used by the edit
	/// flow). A stored selection is a fixed point of `restore`, so a profile created by this flow reloads
	/// unchanged. A profile without a selection (written before the editorial taxonomy) loads empty here.
	public init(taxonomy: EditorialGenreTaxonomy, editing: Profile? = nil, draft: ProfileDraft? = nil) {
		self.taxonomy = taxonomy
		self.editing = editing
		flowID = draft?.flowID ?? editing?.flowID ?? UUID()
		onboardingStartedRecorded = draft?.onboardingStartedRecorded ?? false
		let restored = Self.restore(draft?.selection ?? editing?.selection, in: taxonomy)
		selectedFamilies = restored.families
		selectedGenres = restored.genres
	}

	/// Rules, applied to the stored selection. What the taxonomy cannot show any more is discarded in silence:
	/// 1. A family stays if the taxonomy still shows it, in the stored order.
	/// 2. A genre stays if the taxonomy still shows it and it belongs to a family that stayed.
	/// The minimum of one family is not forced here: if nothing survives, `canContinueFromGenres` stays false
	/// and the person must pick a family before saving.
	private static func restore(
		_ stored: GenreSelection?,
		in taxonomy: EditorialGenreTaxonomy
	) -> (families: [String], genres: [String]) {
		guard let stored else { return ([], []) }
		var families = [String]()
		for key in stored.families where taxonomy.family(key) != nil && !families.contains(key) {
			families.append(key)
		}
		var genres = [String]()
		for id in stored.genres where !genres.contains(id) {
			if let genre = taxonomy.genre(id), families.contains(genre.family) { genres.append(id) }
		}
		return (families, genres)
	}

	/// The tiles of the genre step, in display order. The model hands them out so the screen never holds the
	/// taxonomy itself: it reads and toggles through the model only.
	public var familyChoices: [FamilyChoice] { taxonomy.families }

	/// The edit flow has no Welcome screen and ends on "Enregistrer": it starts from a saved profile.
	public var isEditing: Bool { editing != nil }

	/// The selected families as tiles, in tile order (not selection order, which has no effect on the
	/// recommendation). The Genres tab shows these.
	public var selectedFamilyChoices: [FamilyChoice] {
		taxonomy.families.filter { selectedFamilies.contains($0.id) }
	}

	public var canContinueFromGenres: Bool { !selectedFamilies.isEmpty }

	public var subgenreSteps: [String] { selectedFamilies }

	public var selectedSubgenreCount: Int { selectedGenres.count }

	/// Unticking a family also removes the genres ticked in it. A key the taxonomy does not show is ignored.
	public func toggleFamily(_ key: String) {
		if let index = selectedFamilies.firstIndex(of: key) {
			selectedFamilies.remove(at: index)
			let owned = Set(taxonomy.genres(of: key).map(\.id))
			selectedGenres.removeAll { owned.contains($0) }
		} else if taxonomy.family(key) != nil {
			selectedFamilies.append(key)
		}
	}

	public func toggleSubgenre(_ id: String, of family: String) {
		guard selectedFamilies.contains(family),
			taxonomy.genres(of: family).contains(where: { $0.id == id })
		else { return }
		if let index = selectedGenres.firstIndex(of: id) {
			selectedGenres.remove(at: index)
		} else {
			selectedGenres.append(id)
		}
	}

	public func toggleAll(of family: String) {
		guard selectedFamilies.contains(family) else { return }
		let all = taxonomy.genres(of: family).map(\.id)
		if isAllSelected(of: family) {
			selectedGenres.removeAll { all.contains($0) }
		} else {
			selectedGenres.append(contentsOf: all.filter { !selectedGenres.contains($0) })
		}
	}

	/// Derived from the selection, not stored, so picking every row by hand also counts.
	public func isAllSelected(of family: String) -> Bool {
		let all = taxonomy.genres(of: family).map(\.id)
		return !all.isEmpty && all.allSatisfy(selectedGenres.contains)
	}

	/// The rows of a genre step, in served order, so the screen reads them through the model like the tiles.
	/// A family that is not selected has none: no row can be shown for a step that does not exist.
	public func subgenreChoices(of family: String) -> [EditorialGenreChoice] {
		selectedFamilies.contains(family) ? taxonomy.genres(of: family) : []
	}

	public func isSubgenreSelected(_ id: String) -> Bool {
		selectedGenres.contains(id)
	}

	/// The step that follows `family`, in selection order; nil after the last one, where the flow ends.
	/// A family that is not a step has no successor either, so a stale call can never skip ahead.
	public func subgenreStep(after family: String) -> String? {
		guard let index = subgenreSteps.firstIndex(of: family), index + 1 < subgenreSteps.count else {
			return nil
		}
		return subgenreSteps[index + 1]
	}

	/// `index` is a position in `subgenreSteps`; the genre screen has its own CTA and does not call this.
	public func ctaTitle(forStep index: Int) -> String {
		guard index >= subgenreSteps.count - 1 else { return "Continuer" }
		return editing == nil ? "Terminer" : "Enregistrer"
	}

	/// With no family there is no valid `GenreSelection` (it needs at least one), so the draft then carries
	/// none and an empty `genreIDs`: the same "nothing chosen yet" the profile store already refuses.
	public func makeDraft() -> ProfileDraft {
		guard !selectedFamilies.isEmpty else {
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
