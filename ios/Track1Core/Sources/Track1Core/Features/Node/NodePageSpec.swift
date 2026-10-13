import Foundation

/// The Figma Data contract (page `168:1401`), projected for the node page. The constants between the parity
/// markers repeat `src/node-spec.ts`; `test/ios-node-page-spec.test.ts` reads this file and fails when either
/// side moves alone. Anything that is not such a constant goes below the END marker.
public enum NodePageSpec {
	// BEGIN node-spec-parity

	/// Rule 2: sections appear in schema order, the keys of `EDGE_FIELDS_BY_TYPE` in declaration order.
	/// A JSON object has no order and `JSONDecoder` keeps none in a `Dictionary`, so the order lives here.
	public static let sectionOrder: [NodeType: [String]] = [
		.genre: [
			"parent_genres", "subgenres", "related_genres", "key_artists", "key_labels", "landmark_projects",
			"landmark_tracks",
		],
		.label: ["genres", "roster", "notable_releases"],
		.artist: [
			"genres", "labels", "discography", "notable_tracks", "influences", "influenced", "collaborators",
			"aliases", "members",
		],
		.project: [
			"artists", "label", "genres", "tracklist", "producers", "personnel", "related_projects",
		],
		.track: [
			"artists", "project", "label", "genres", "producers", "personnel", "samples", "sampled_by",
			"remix_of", "remixed_by",
		],
	]

	/// Rule 6: single edges render one chip, with no count in the header (`SINGULAR_EDGES_BY_TYPE`).
	public static let singleFields: [NodeType: [String]] = [
		.genre: [],
		.label: [],
		.artist: [],
		.project: ["label"],
		.track: ["project", "label", "remix_of"],
	]

	/// Rule 4: the project edge that renders as a cover carousel (`PROJECT_CAROUSEL_EDGE` in `web/index.html`).
	public static let carouselField: [NodeType: String] = [
		.artist: "discography",
		.label: "notable_releases",
		.genre: "landmark_projects",
		.project: "related_projects",
	]

	/// Rule 5: `project.tracklist` renders as numbered track rows, the full list, in array order.
	public static let trackListField = "tracklist"

	/// Rule 3: a list shows this many chips, then an overflow chip. The view applies it, not the model.
	public static let chipLimit = 8

	/// Rule 9 hides third-party and bookkeeping fields. These two are shown anyway: the article and the citations
	/// are the one exception Raphael validated on 2026-10-11 (D15). The parity test accepts exactly this list.
	public static let rule9Deviations = ["editorial_article", "citations"]

	// END node-spec-parity

	/// `KIND_LABEL` of `web/index.html`. A field it does not list uses its name, as `label(field:type:)` says.
	private static let kindLabels: [String: String] = [
		"label": "label",
		"artists": "artist(s)",
		"personnel": "performers",
		"producers": "producers",
		"tracklist": "tracks",
		"discography": "discography",
		"notable_tracks": "notable tracks",
		"notable_releases": "notable releases",
		"related_projects": "related albums",
		"key_artists": "key artists",
		"key_labels": "key labels",
		"landmark_tracks": "landmark tracks",
		"landmark_projects": "landmark albums",
		"parent_genres": "parent genres",
		"related_genres": "related genres",
		"sampled_by": "sampled by",
		"remix_of": "remix of",
		"remixed_by": "remixed by",
	]

	/// Rule 2: lowercase section labels, those of the web front. `project` reads "album / ep" on a track, since
	/// a track points at the release it belongs to.
	public static func label(field: String, type: NodeType) -> String {
		if field == "project" { return type == .track ? "album / ep" : "project" }
		return kindLabels[field] ?? field.replacingOccurrences(of: "_", with: " ")
	}
}
