import Foundation
import Observation

/// Selection state of the onboarding flow: parent genres first, then one subgenre step per chosen parent.
/// Everything lives in memory so that going back never loses a choice; nothing is persisted until the
/// caller saves the `ProfileDraft`.
@MainActor
@Observable
public final class OnboardingFlowModel {
	public private(set) var selectedParents: [NodeIdentity]
	private var selectedSubgenres: [NodeIdentity]

	private let taxonomy: GenreTaxonomy
	private let editing: Profile?
	private let flowID: UUID
	private let onboardingStartedRecorded: Bool

	/// `draft` is the one the `ProfileStore` already holds for this flow. It carries the `flow_id` shared with
	/// analytics and the "start event already sent" flag, and `makeDraft()` must hand both back unchanged:
	/// a fresh draft would reset the flag and a resumed flow would send `onboarding_started` twice.
	public init(taxonomy: GenreTaxonomy, editing: Profile? = nil, draft: ProfileDraft? = nil) {
		self.taxonomy = taxonomy
		self.editing = editing
		flowID = draft?.flowID ?? editing?.flowID ?? UUID()
		onboardingStartedRecorded = draft?.onboardingStartedRecorded ?? false
		let stored = draft?.genreIDs ?? editing?.genreIDs ?? []
		let parents = stored.filter { id in taxonomy.parents.contains { $0.identity == id } }
		selectedParents = parents
		selectedSubgenres = stored.filter { id in
			parents.contains { parent in taxonomy.subgenres(of: parent).contains { $0.identity == id } }
		}
	}

	/// The tiles of the genre step, in display order. The model hands them out so the screen never holds the
	/// taxonomy itself: it reads and toggles through the model only.
	public var parentChoices: [GenreChoice] { taxonomy.parents }

	public var canContinueFromGenres: Bool { !selectedParents.isEmpty }

	public var subgenreSteps: [NodeIdentity] { selectedParents }

	public var selectedSubgenreCount: Int { selectedSubgenres.count }

	public func toggleParent(_ parent: NodeIdentity) {
		if let index = selectedParents.firstIndex(of: parent) {
			selectedParents.remove(at: index)
			// A subgenre shared with another still-selected parent stays: that screen still shows it.
			let kept = Set(selectedParents.flatMap { taxonomy.subgenres(of: $0).map(\.identity) })
			let owned = Set(taxonomy.subgenres(of: parent).map(\.identity))
			selectedSubgenres.removeAll { owned.contains($0) && !kept.contains($0) }
		} else if taxonomy.parents.contains(where: { $0.identity == parent }) {
			selectedParents.append(parent)
		}
	}

	public func toggleSubgenre(_ subgenre: NodeIdentity, of parent: NodeIdentity) {
		guard selectedParents.contains(parent),
			taxonomy.subgenres(of: parent).contains(where: { $0.identity == subgenre })
		else { return }
		if let index = selectedSubgenres.firstIndex(of: subgenre) {
			selectedSubgenres.remove(at: index)
		} else {
			selectedSubgenres.append(subgenre)
		}
	}

	public func toggleAll(of parent: NodeIdentity) {
		guard selectedParents.contains(parent) else { return }
		let all = taxonomy.subgenres(of: parent).map(\.identity)
		if isAllSelected(of: parent) {
			selectedSubgenres.removeAll { all.contains($0) }
		} else {
			selectedSubgenres.append(contentsOf: all.filter { !selectedSubgenres.contains($0) })
		}
	}

	/// Derived from the selection, not stored, so picking every row by hand also counts.
	public func isAllSelected(of parent: NodeIdentity) -> Bool {
		let all = taxonomy.subgenres(of: parent).map(\.identity)
		return !all.isEmpty && all.allSatisfy(selectedSubgenres.contains)
	}

	/// `index` is a position in `subgenreSteps`; the genre screen has its own CTA and does not call this.
	public func ctaTitle(forStep index: Int) -> String {
		guard index >= subgenreSteps.count - 1 else { return "Continuer" }
		return editing == nil ? "Terminer" : "Enregistrer"
	}

	public func makeDraft() -> ProfileDraft {
		var seen = Set<NodeIdentity>()
		return ProfileDraft(
			version: Profile.version,
			flowID: flowID,
			genreIDs: (selectedParents + selectedSubgenres).filter { seen.insert($0).inserted },
			onboardingStartedRecorded: onboardingStartedRecorded
		)
	}
}
