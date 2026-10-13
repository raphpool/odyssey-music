import SwiftUI
import Track1Core

/// The search sheet (Figma 3.1 `178:68`, Search sheet `174:113`): the field, then the lines of the model. The
/// sheet only reports a choice (`open`); the app root closes it and pushes the page, so that the stack of the
/// current tab is the only one (no stack of its own for Search, G.1).
struct SearchSheetView: View {
	static let identifier = "search-sheet"
	/// Figma `Suggestions label` `174:120`. It also heads the recents: the sheet draws a single label.
	static let listLabel = "SUGGESTIONS"
	static let tooLongMessage = "Recherche limitée à 120 caractères."
	static let emptyMessage = "Aucun résultat"

	@State private var model: SearchViewModel
	@FocusState private var isFocused: Bool
	@Environment(\.dismiss) private var dismiss
	private let open: (NodeIdentity, NavigationContext, String) -> Void

	init(
		search: @escaping SearchReader,
		recents: RecentNodesStore,
		recordEvent: @escaping NodeEventRecorder,
		open: @escaping (NodeIdentity, NavigationContext, String) -> Void
	) {
		_model = State(initialValue: SearchViewModel(search: search, recordEvent: recordEvent, recents: recents))
		self.open = open
	}

	var body: some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing4) {
			Track1SearchField(text: $model.query, focus: $isFocused, onSubmit: submit)
			content
		}
		.padding(.horizontal, Track1Tokens.spacing24)
		.padding(.top, Track1Tokens.spacing24)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
		.presentationDetents([.large])
		.presentationDragIndicator(.visible)
		.presentationBackground { SheetGlass() }
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier(Self.identifier)
		// The model of a sheet that is shown again reads the store on creation, but a "Effacer le profil" or a
		// card recorded since must not leave old recents on screen (I.1 note).
		.task { await model.loadRecents() }
		.defaultFocus($isFocused, true)
		.onAppear { isFocused = true }
	}

	@ViewBuilder
	private var content: some View {
		let rows = model.rows
		if !rows.isEmpty {
			list(rows)
		} else {
			switch model.phase {
			case .tooLong:
				message(Self.tooLongMessage, identifier: "search-too-long")
			case .empty:
				message(Self.emptyMessage, identifier: "search-empty")
			case .failed:
				Track1StatusView(.searchFailed, action: model.retry)
					.frame(maxHeight: .infinity)
			case .idle, .tooShort, .loading, .results:
				EmptyView()
			}
		}
	}

	private func list(_ rows: [SearchRow]) -> some View {
		ScrollView {
			LazyVStack(alignment: .leading, spacing: 0) {
				Track1Text(Self.listLabel, role: .monoLabel)
					.foregroundStyle(Track1Tokens.colorTextTertiary)
					.padding(.horizontal, Track1Tokens.spacing4)
					.padding(.top, Track1Tokens.spacing12)
					.padding(.bottom, Track1Tokens.spacing4)
					.accessibilityAddTraits(.isHeader)
				ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
					Track1ListItem(
						title: row.title, subtitle: row.subtitle, accessory: row.isAvailable ? .chevron : .none
					) {
						choose(index)
					}
					.disabled(!row.isAvailable)
					.accessibilityIdentifier(row.isAvailable ? "search-row-\(index)" : "search-missing-\(index)")
				}
			}
		}
		.scrollDismissesKeyboard(.interactively)
	}

	private func message(_ text: String, identifier: String) -> some View {
		Track1Text(text, role: .bodyMedium)
			.foregroundStyle(Track1Tokens.colorTextSecondary)
			.padding(Track1Tokens.spacing16)
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityIdentifier(identifier)
	}

	/// "Rechercher" on an empty field closes the sheet; on a typed query the results are already live.
	private func submit() {
		if model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { dismiss() }
	}

	private func choose(_ index: Int) {
		let rows = model.rows
		guard rows.indices.contains(index), case .node(let identity, let context)? = model.openRow(at: index)
		else { return }
		open(identity, context, rows[index].title)
	}
}

/// D8: the glass of iOS 26 where it exists, a frosted material with the glass tokens before. One background
/// only: a second `.background` chained after it would sit behind the first.
private struct SheetGlass: View {
	var body: some View {
		if #available(iOS 26, *) {
			Rectangle().fill(.clear).glassEffect(.regular.tint(Track1Tokens.colorGlassSurface), in: Rectangle())
		} else {
			ZStack {
				Rectangle().fill(.ultraThinMaterial)
				Track1Tokens.colorGlassSurface
			}
		}
	}
}
