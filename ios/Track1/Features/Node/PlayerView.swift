import SwiftUI
import Track1Core
import UIKit

/// Measures of Figma `338:2461` (file `phudxrQNlzQJafXLma4FyX`, 393 x 844, TRA-731). The ticket wins.
enum PlayerMetrics {
	static let identifier = "player"
	static let backIdentifier = "player-back"
	static func paragraphIdentifier(_ index: Int) -> String { "player-paragraph-\(index)" }

	/// `338:2492`: centered, paragraphs left-aligned and 56 apart.
	static let columnWidth: CGFloat = 309
	static let paragraphSpacing: CGFloat = 56
	/// `338:2558`, measured from the top-left corner of the screen. `338:2559` is the 40 x 40 back button.
	static let headerLeading: CGFloat = 24
	static let headerTop: CGFloat = 56
	static let headerHeight: CGFloat = 40
	static let backSize: CGFloat = 40
	/// The Now bar ends this far above the tab bar (749 - (694 + 50)).
	static let nowBarGap: CGFloat = 5
	/// Where the centred paragraph sits, from the top of the screen: `338:2480` spans 268 to 506 in the mockup,
	/// which is not the middle of the 844 pt frame. `PlayerScroll` takes a window centred on it.
	static let readingCenter: CGFloat = 387
	static let readingViewport = 2 * readingCenter
	static let focusedRole = Track1TextRole.reader
	static let dimRole = Track1TextRole.readerDim
	static let focusedColor = Track1Tokens.colorTextPrimary
	static let dimColor = Track1Tokens.colorTextTertiary
	static let backFill = Track1Tokens.colorGlassPill
	static let arrowColor = Track1Tokens.colorIconPrimary
	static let arrowStroke: CGFloat = 1.8
	static let contentSpace = "player-content"

	/// `338:2463`: a 393 x 2064 frame, the three cover bands at 0, 5 and 10 %, then `background.elevated`
	/// from 15 %. `CoverTintGradient` cannot draw it: its stops are fixed at 0, 13, 27 and 50 %.
	static let tintHeight: CGFloat = 2064
	static let tintPositions: [CGFloat] = [0, 0.05, 0.10]
	static let tintEndpoint: CGFloat = 0.15

	/// Where the mockup paragraphs fade, in the 844 pt frame: `338:2479` is clear at 42 + 5.637 % x 170 and
	/// opaque at its end, `338:2491` opaque at its start (562) and clear at 562 + 89.869 % x 306.
	static let designHeight: CGFloat = 844
	static let fadeTopClear: CGFloat = 51.58
	static let fadeTopOpaque: CGFloat = 212
	static let fadeBottomOpaque: CGFloat = 562
	static let fadeBottomClear: CGFloat = 837

	static func tintStops(_ tint: CoverTint) -> [Gradient.Stop] {
		let end = Track1Tokens.colorBackgroundElevated
		let bands = zip(tint.stops, tintPositions).map { Gradient.Stop(color: Color($0), location: $1) }
		return bands + [
			Gradient.Stop(color: end, location: tintEndpoint), Gradient.Stop(color: end, location: 1),
		]
	}

	/// An alpha mask: clear at both ends of the screen, opaque in the middle.
	static func fadeStops(height: CGFloat) -> [Gradient.Stop] {
		let height = max(height, 1)
		func at(_ y: CGFloat) -> CGFloat { min(max(y / height, 0), 1) }
		func fromBottom(_ y: CGFloat) -> CGFloat { at(height - (designHeight - y)) }
		return [
			.init(color: .clear, location: 0), .init(color: .clear, location: at(fadeTopClear)),
			.init(color: .black, location: at(fadeTopOpaque)),
			.init(color: .black, location: max(at(fadeTopOpaque), fromBottom(fadeBottomOpaque))),
			.init(color: .clear, location: fromBottom(fadeBottomClear)), .init(color: .clear, location: 1),
		]
	}

	/// From the bottom of the screen: the window's safe area, the tab bar, then the gap (694 in the mockup).
	static func nowBarBottomInset(safeAreaBottom: CGFloat) -> CGFloat {
		safeAreaBottom + Track1TabBarMetrics.reservedHeight(safeAreaBottom: safeAreaBottom) + nowBarGap
	}

	/// Room above the first and under the last paragraph, so that each one can reach `readingCenter`.
	static func topMargin(paragraph: CGFloat) -> CGFloat {
		max(0, readingCenter - paragraph / 2)
	}

	static func bottomMargin(viewport: CGFloat, paragraph: CGFloat) -> CGFloat {
		max(0, viewport - readingCenter - paragraph / 2)
	}

	static func snappedOffset(
		proposed: CGFloat, viewport: CGFloat, content: CGFloat, frames: [PlayerItemFrame]
	) -> CGFloat {
		let snapped = PlayerScroll.snapOffset(
			proposed: Double(proposed), viewportHeight: Double(readingViewport), frames: frames)
		return min(max(CGFloat(snapped), 0), max(0, content - viewport))
	}
}

/// The reader (Figma `338:2461`): one sentence per paragraph, the centred one in the `reader` role.
/// The text moves under the finger only. The article comes from the network: `Text(verbatim:)`, never a link.
struct PlayerView: View {
	static let emptyMessage = "Pas encore de texte pour cette œuvre."

	enum Screen {
		case reader(NodeDetail)
		case loading, missing, failed
	}

	private let model: NodeViewModel
	private let imageStore: NodeImageStore<UIImage>
	private let safeAreaBottom: CGFloat
	let onBack: () -> Void

	/// `safeAreaBottom` is the window's, as `RootView` reads it for the tab bar.
	init(
		model: NodeViewModel, imageStore: NodeImageStore<UIImage>, safeAreaBottom: CGFloat,
		onBack: @escaping () -> Void
	) {
		self.model = model
		self.imageStore = imageStore
		self.safeAreaBottom = safeAreaBottom
		self.onBack = onBack
	}

	static func screen(for state: NodeViewState) -> Screen {
		switch state {
		case .loaded(let node): .reader(node)
		case .loading: .loading
		case .missing: .missing
		case .failed: .failed
		}
	}

	/// The sentences of the article; an empty article falls back on the cleaned teaser, then on the message.
	static func paragraphs(for node: NodeDetail) -> [String] {
		let sentences = ArticleSentences.split(node.article)
		return sentences.isEmpty ? [NodePageHeader(node: node).teaser ?? emptyMessage] : sentences
	}

	static func artistNames(of node: NodeDetail) -> String? {
		let edges: [NodeEdge]
		switch node.edges["artists"] {
		case .one(let edge): edges = [edge]
		case .many(let list): edges = list
		case nil: return nil
		}
		let names = edges.map { oneLine($0.name) }.filter { !$0.isEmpty }
		return names.isEmpty ? nil : names.joined(separator: ", ")
	}

	/// A network string on one line, as `NodePageHeader.clean` (internal to `Track1Core`) makes subtitles:
	/// control characters become a space, and the bidirectional controls that reorder text are dropped.
	static func oneLine(_ text: String) -> String {
		let bidiControls: Set<Unicode.Scalar> = [
			"\u{061C}", "\u{200E}", "\u{200F}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}",
			"\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}",
		]
		let scalars = text.unicodeScalars.compactMap { scalar -> Unicode.Scalar? in
			if bidiControls.contains(scalar) { return nil }
			return scalar.properties.generalCategory == .control ? " " : scalar
		}
		return String(String.UnicodeScalarView(scalars)).split(separator: " ").joined(separator: " ")
	}

	/// Frames in the order of the paragraphs, from what each one reports.
	static func items(from frames: [Int: CGRect]) -> [PlayerItemFrame] {
		frames.sorted { $0.key < $1.key }
			.map { PlayerItemFrame(minY: Double($0.value.minY), height: Double($0.value.height)) }
	}

	/// The first paragraph until the frames are measured.
	static func focusedIndex(offset: CGFloat, frames: [PlayerItemFrame]) -> Int {
		let viewport = Double(PlayerMetrics.readingViewport)
		return PlayerScroll.focusedIndex(offset: Double(offset), viewportHeight: viewport, frames: frames) ?? 0
	}

	static func role(forParagraph index: Int, focusedIndex: Int) -> Track1TextRole {
		index == focusedIndex ? PlayerMetrics.focusedRole : PlayerMetrics.dimRole
	}

	var body: some View {
		ZStack(alignment: .topLeading) {
			switch Self.screen(for: model.state) {
			case .reader(let node):
				PlayerReader(node: node, model: model, imageStore: imageStore, safeAreaBottom: safeAreaBottom)
					.id(node.id)
			case .loading: SplashView()
			case .missing: Track1StatusView(.nodeMissing, action: nil)
			case .failed: Track1StatusView(.nodeFailed, action: { Task { await model.load() } })
			}
			// Drawn in every state: it is the only way out. No share button (Q11).
			HStack {
				PlayerBackButton(action: onBack)
				Spacer(minLength: 0)
			}
			.frame(height: PlayerMetrics.headerHeight)
			.padding(.horizontal, PlayerMetrics.headerLeading)
			.padding(.top, PlayerMetrics.headerTop)
			.accessibilitySortPriority(1)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background { Track1Tokens.colorBackgroundElevated }
		.ignoresSafeArea()
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier(PlayerMetrics.identifier)
		.task { await model.load() }
	}
}

private struct PlayerReader: View {
	let node: NodeDetail
	let model: NodeViewModel
	let safeAreaBottom: CGFloat
	/// Cut once: the body runs again each time the focus changes.
	let paragraphs: [String]
	@State private var hero: NodeHeroModel
	@State private var focused = 0
	@State private var frames: [PlayerItemFrame] = []
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.openURL) private var openURL

	init(node: NodeDetail, model: NodeViewModel, imageStore: NodeImageStore<UIImage>, safeAreaBottom: CGFloat) {
		self.node = node
		self.model = model
		self.safeAreaBottom = safeAreaBottom
		paragraphs = PlayerView.paragraphs(for: node)
		_hero = State(initialValue: NodeHeroModel(node: node, store: imageStore))
	}

	var body: some View {
		let tint = NodePageView.pageTint(coverTint: NodePageView.coverTint(for: hero.state), type: node.type)
		GeometryReader { proxy in reading(height: proxy.size.height) }
			.background(alignment: .top) {
				LinearGradient(stops: PlayerMetrics.tintStops(tint), startPoint: .top, endPoint: .bottom)
					.frame(height: PlayerMetrics.tintHeight)
			}
			.overlay(alignment: .bottom) { bottomBar }
			.task { await hero.load() }
	}

	private var cover: Image? {
		guard case .loaded(let image, _, _) = hero.state else { return nil }
		return Image(uiImage: image)
	}

	/// Drawn once there is something to open (none for a genre or a label, nor while `/links` loads): a bar
	/// without buttons would only be a title. Capped at the column, so a long name is cut, not stretched.
	@ViewBuilder
	private var bottomBar: some View {
		let actions = NodePageListening.actions(for: node.type, state: model.listening)
		if !actions.isEmpty {
			VStack(spacing: Track1Tokens.spacing8) {
				if let notice = NodePageView.listeningNotice(for: model.listeningFailure) { notice }
				PlayerNowBar(
					title: PlayerView.oneLine(node.name), artist: PlayerView.artistNames(of: node), cover: cover,
					actions: actions, isOpening: model.isOpeningListening
				) { action in
					Task { await model.openListening(action, using: { await openURL.openAndWait($0) }) }
				}
			}
			.frame(maxWidth: PlayerMetrics.columnWidth)
			.padding(.bottom, PlayerMetrics.nowBarBottomInset(safeAreaBottom: safeAreaBottom))
		}
	}

	private func reading(height: CGFloat) -> some View {
		let top = PlayerMetrics.topMargin(paragraph: CGFloat(frames.first?.height ?? 0))
		let bottom = PlayerMetrics.bottomMargin(viewport: height, paragraph: CGFloat(frames.last?.height ?? 0))
		return ScrollView(showsIndicators: false) {
			VStack(alignment: .leading, spacing: PlayerMetrics.paragraphSpacing) {
				ForEach(Array(paragraphs.enumerated()), id: \.offset) { index, text in
					PlayerParagraph(
						text: text, index: index,
						role: PlayerView.role(forParagraph: index, focusedIndex: focused), reduceMotion: reduceMotion)
				}
			}
			.frame(width: PlayerMetrics.columnWidth)
			.padding(.top, top)
			.padding(.bottom, bottom)
			.frame(maxWidth: .infinity)
			.background {
				GeometryReader { proxy in
					let offset = -proxy.frame(in: .scrollView).minY
					Color.clear.preference(
						key: PlayerFocusKey.self, value: PlayerView.focusedIndex(offset: offset, frames: frames))
				}
			}
			.coordinateSpace(name: PlayerMetrics.contentSpace)
		}
		.scrollTargetBehavior(PlayerSnapBehavior(frames: frames))
		.mask {
			LinearGradient(stops: PlayerMetrics.fadeStops(height: height), startPoint: .top, endPoint: .bottom)
		}
		.onPreferenceChange(PlayerFocusKey.self) { focused = $0 }
		.onPreferenceChange(PlayerFramesKey.self) { frames = PlayerView.items(from: $0) }
	}
}

private struct PlayerParagraph: View {
	let text: String
	let index: Int
	let role: Track1TextRole
	let reduceMotion: Bool

	var body: some View {
		let isFocused = role == PlayerMetrics.focusedRole
		Track1Text(text, role: role, verbatim: true)
			// The inner animation drives the body, the outer one the colour: under Reduce Motion the body
			// changes at once and only the colour fades.
			.animation(Track1Motion.animation(.fast, reduceMotion: reduceMotion), value: isFocused)
			.foregroundStyle(isFocused ? PlayerMetrics.focusedColor : PlayerMetrics.dimColor)
			.animation(Track1Motion.animation(.fast, reduceMotion: false), value: isFocused)
			.frame(width: PlayerMetrics.columnWidth, alignment: .leading)
			.accessibilityElement(children: .combine)
			.accessibilityIdentifier(PlayerMetrics.paragraphIdentifier(index))
			.background {
				GeometryReader { proxy in
					Color.clear.preference(
						key: PlayerFramesKey.self, value: [index: proxy.frame(in: .named(PlayerMetrics.contentSpace))])
				}
			}
	}
}

/// D3: `viewAligned` aligns on the top edge on iOS 17, so the target is the offset that centres a paragraph.
private struct PlayerSnapBehavior: ScrollTargetBehavior {
	let frames: [PlayerItemFrame]

	func updateTarget(_ target: inout ScrollTarget, context: TargetContext) {
		target.rect.origin.y = PlayerMetrics.snappedOffset(
			proposed: target.rect.minY, viewport: context.containerSize.height,
			content: context.contentSize.height, frames: frames)
	}
}

/// The focused paragraph, read from the offset behind the content: it only fires when the focus changes,
/// not at every scroll frame. And the frame of each paragraph.
private struct PlayerFocusKey: PreferenceKey {
	static let defaultValue = 0

	static func reduce(value: inout Int, nextValue: () -> Int) { value = nextValue() }
}

private struct PlayerFramesKey: PreferenceKey {
	static let defaultValue: [Int: CGRect] = [:]

	static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
		value.merge(nextValue()) { $1 }
	}
}

/// `338:2559`: the "Arrow left" vector exported from Figma (`M20 28L12 20L20 12M12 20H28` in 40 x 40, stroke
/// 1.8, round), drawn as a shape because the ticket's scope holds no asset file. The circle follows the v1
/// tab bar's recipe (a flat `colorGlassPill`, no border, no material), not Figma's Glass effect.
private struct PlayerBackArrow: Shape {
	func path(in rect: CGRect) -> Path {
		let scale = rect.width / 40
		func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
			CGPoint(x: rect.minX + x * scale, y: rect.minY + y * scale)
		}
		var path = Path()
		path.move(to: point(20, 28))
		path.addLine(to: point(12, 20))
		path.addLine(to: point(20, 12))
		path.move(to: point(12, 20))
		path.addLine(to: point(28, 20))
		return path
	}
}

private struct PlayerBackButton: View {
	let action: () -> Void

	var body: some View {
		// The touch area reaches 44 x 44, as the Now bar's buttons do; the layout keeps the 40 pt of the mockup.
		let outset = (PlayerNowBarMetrics.minimumTouchTarget - PlayerMetrics.backSize) / 2
		Button(action: action) {
			PlayerBackArrow()
				.stroke(
					PlayerMetrics.arrowColor,
					style: StrokeStyle(lineWidth: PlayerMetrics.arrowStroke, lineCap: .round, lineJoin: .round)
				)
				.frame(width: PlayerMetrics.backSize, height: PlayerMetrics.backSize)
				.background(PlayerMetrics.backFill, in: Circle())
				.padding(outset)
				.contentShape(Rectangle())
				.padding(-outset)
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Retour")
		.accessibilityIdentifier(PlayerMetrics.backIdentifier)
	}
}

extension OpenURLAction {
	/// `false` when the OS declines the URL, as the completion reports it (the same as `NodeView`'s).
	@MainActor
	fileprivate func openAndWait(_ url: URL) async -> Bool {
		await withCheckedContinuation { continuation in
			callAsFunction(url) { continuation.resume(returning: $0) }
		}
	}
}
