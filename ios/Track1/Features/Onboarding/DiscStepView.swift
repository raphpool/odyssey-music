import SwiftUI
import Track1Core

/// Measures of the disc screen, from the ticket TRA-730 (v1 mock-up, 393 x 852 frame). Every position is
/// read from the top-left corner of that frame. The screen draws a 393 pt wide board, centered, and the tops
/// are reduced by the status bar of the frame (same rule as `PseudoStepMetrics`).
enum DiscStepMetrics {
	static let referenceWidth: CGFloat = 393
	static let referenceHeight: CGFloat = 852
	static let referenceTopInset: CGFloat = 59

	/// `screen/gradient-top` at the top, `background/elevated` from 33.099 % of the height down.
	static let backgroundStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorScreenGradientTop, location: 0),
		.init(color: Track1Tokens.colorBackgroundElevated, location: 0.33099),
	]

	/// The block of the two titles: top at y 164, 12 between them, centered.
	static let titleTop: CGFloat = 164
	static let titleSpacing = Track1Tokens.spacing12
	static let titleRole: Track1TextRole = .monoItem
	static let titleColor = Track1Tokens.colorTextPrimary
	static let subtitleRole: Track1TextRole = .monoSection
	static let subtitleColor = Track1Tokens.colorTextSecondary

	/// The slot: a centered square at y 264.89, the chosen disc inset from its top-left corner. The inset
	/// is the offset read in Figma, so the disc is not centered (the ratio is the same on the tiles).
	static let slotTop: CGFloat = 264.89
	static let slotSize: CGFloat = 143.838
	static let slotRadius: CGFloat = 31.465
	static let slotDiscSize: CGFloat = 122.137
	static let slotDiscInset: CGFloat = 9.31
	static var slotLeft: CGFloat { (referenceWidth - slotSize) / 2 }

	/// The grid: 3 columns x 2 rows from (43, 506), in the order of `ProfileDisc.allCases`, 22 between tiles.
	static let gridOrigin = CGPoint(x: 43, y: 506)
	static let gridWidth: CGFloat = 306
	static let gridColumns = 3
	static let gridRows = 2
	static let gridSpacing: CGFloat = 22
	static let tileSize: CGFloat = 85.618
	static let tileRadius: CGFloat = 18.729
	static let tileDiscSize: CGFloat = 72.7
	static let tileDiscInset: CGFloat = 5.54
	static var tilePitch: CGFloat { tileSize + gridSpacing }

	/// Top of the bar (`BottomActionBar` without counter nor fade).
	static let barTop: CGFloat = 744

	/// Top-left corner of the tile at `index` of `ProfileDisc.allCases`, from the top-left of the frame.
	static func tileOrigin(at index: Int) -> CGPoint {
		CGPoint(
			x: gridOrigin.x + CGFloat(index % gridColumns) * tilePitch,
			y: gridOrigin.y + CGFloat(index / gridColumns) * tilePitch)
	}

	static func tileOrigin(of disc: ProfileDisc) -> CGPoint {
		tileOrigin(at: ProfileDisc.allCases.firstIndex(of: disc) ?? 0)
	}

	/// An empty slot or tile takes the blue tint.
	static func tint(for disc: ProfileDisc?) -> Color {
		switch disc {
		case .iridescent: Track1Tokens.colorDiscTintIridescent
		case .blue, nil: Track1Tokens.colorDiscTintBlue
		case .mint: Track1Tokens.colorDiscTintMint
		case .coral: Track1Tokens.colorDiscTintCoral
		case .violet: Track1Tokens.colorDiscTintViolet
		case .teal: Track1Tokens.colorDiscTintTeal
		}
	}

	/// The tint at 10 % on top, fading to 0 % at 151.15 % of the height. The gradient stops at 100 %, where
	/// the fade has reached `1 - 1 / 1.5115` of the way: the bottom opacity is that of the Figma ramp there.
	static let gradientTopOpacity = 0.1
	static let gradientZeroAt = 1.5115
	static var gradientBottomOpacity: Double { gradientTopOpacity * (1 - 1 / gradientZeroAt) }

	static func gradientStops(for disc: ProfileDisc?) -> [Gradient.Stop] {
		let color = tint(for: disc)
		return [
			.init(color: color.opacity(gradientTopOpacity), location: 0),
			.init(color: color.opacity(gradientBottomOpacity), location: 1),
		]
	}

	static func gradient(for disc: ProfileDisc?) -> LinearGradient {
		LinearGradient(stops: gradientStops(for: disc), startPoint: .top, endPoint: .bottom)
	}

	/// How a disc goes from its tile to the slot: it flies there, or cross-fades under Reduce Motion.
	enum Movement: Equatable {
		case flies, crossFades
	}

	static func movement(reduceMotion: Bool) -> Movement {
		reduceMotion ? .crossFades : .flies
	}

	/// The spring of `Track1Motion`; under Reduce Motion it has no spring, so the cross-fade takes the
	/// standard duration.
	static func animation(reduceMotion: Bool) -> Animation {
		Track1Motion.spring(reduceMotion: reduceMotion) ?? .easeInOut(duration: Track1Motion.standard.duration)
	}
}

/// The third onboarding step (TRA-730): the person picks one of six discs, which moves into the slot. The
/// view does not own the choice: it receives `selected` and reports a touch through `onSelect`.
struct DiscStepView: View {
	static let slotIdentifier = "onboarding-disc-slot"
	static let continueIdentifier = "onboarding-disc-continue"
	static let title = "Bienvenue sur track1"
	static let subtitle = "Choisis ton disque de profil"
	static let continueTitle = "Continuer"

	static func tileIdentifier(for disc: ProfileDisc) -> String {
		"onboarding-disc-\(disc.rawValue)"
	}

	static func tileLabel(for disc: ProfileDisc) -> String {
		ProfileDiscImage.accessibilityLabel(for: disc)
	}

	/// The disc a tile shows: its own, or the empty disc once it has moved to the slot.
	static func containedDisc(in tile: ProfileDisc, selected: ProfileDisc?) -> ProfileDisc? {
		tile == selected ? nil : tile
	}

	static func traits(for tile: ProfileDisc, selected: ProfileDisc?) -> AccessibilityTraits {
		var traits: AccessibilityTraits = .isButton
		if tile == selected { traits.insert(.isSelected) }
		return traits
	}

	/// A touch on a tile. The empty tile of the chosen disc does nothing. Returns whether it reported.
	@discardableResult
	static func choose(_ tile: ProfileDisc, selected: ProfileDisc?, onSelect: (ProfileDisc) -> Void) -> Bool {
		guard tile != selected else { return false }
		onSelect(tile)
		return true
	}

	static func isContinueEnabled(selected: ProfileDisc?) -> Bool {
		selected != nil
	}

	@discardableResult
	static func proceed(selected: ProfileDisc?, onContinue: () -> Void) -> Bool {
		guard selected != nil else { return false }
		onContinue()
		return true
	}

	/// The bar as the screen builds it: no counter, no fade, as on the pseudo screen.
	@MainActor
	static func actionBar(selected: ProfileDisc?, onContinue: @escaping () -> Void) -> BottomActionBar {
		BottomActionBar(
			title: continueTitle, isEnabled: isContinueEnabled(selected: selected), counter: nil,
			identifier: continueIdentifier, showsFade: false
		) {
			proceed(selected: selected, onContinue: onContinue)
		}
	}

	private let selected: ProfileDisc?
	private let onSelect: (ProfileDisc) -> Void
	private let onContinue: () -> Void
	@Namespace private var discSpace
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	init(selected: ProfileDisc?, onSelect: @escaping (ProfileDisc) -> Void, onContinue: @escaping () -> Void) {
		self.selected = selected
		self.onSelect = onSelect
		self.onContinue = onContinue
	}

	var body: some View {
		ZStack(alignment: .top) {
			LinearGradient(stops: DiscStepMetrics.backgroundStops, startPoint: .top, endPoint: .bottom)
				.ignoresSafeArea()
			board
			// Measured from the physical bottom edge (y 744 to 852), as on the pseudo screen.
			Self.actionBar(selected: selected, onContinue: onContinue)
				.frame(maxHeight: .infinity, alignment: .bottom)
				.ignoresSafeArea(.container, edges: .bottom)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}

	private var board: some View {
		ZStack(alignment: .topLeading) {
			titles
			ForEach(ProfileDisc.allCases, id: \.self) { disc in
				tile(disc)
			}
			// After the tiles, so that the disc flying to the slot passes over them and not under.
			slot
		}
		.frame(
			width: DiscStepMetrics.referenceWidth,
			height: DiscStepMetrics.referenceHeight - DiscStepMetrics.referenceTopInset,
			alignment: .topLeading
		)
		.animation(DiscStepMetrics.animation(reduceMotion: reduceMotion), value: selected)
		.sensoryFeedback(.selection, trigger: selected)
	}

	private var titles: some View {
		VStack(spacing: DiscStepMetrics.titleSpacing) {
			Track1Text(Self.title, role: DiscStepMetrics.titleRole)
				.foregroundStyle(DiscStepMetrics.titleColor)
				.accessibilityAddTraits(.isHeader)
			Track1Text(Self.subtitle, role: DiscStepMetrics.subtitleRole)
				.foregroundStyle(DiscStepMetrics.subtitleColor)
		}
		.multilineTextAlignment(.center)
		.padding(.horizontal, Track1Tokens.spacing16)
		.frame(width: DiscStepMetrics.referenceWidth)
		.offset(y: DiscStepMetrics.titleTop - DiscStepMetrics.referenceTopInset)
	}

	private var slot: some View {
		ZStack(alignment: .topLeading) {
			RoundedRectangle(cornerRadius: DiscStepMetrics.slotRadius)
				.fill(DiscStepMetrics.gradient(for: selected))
			slotDisc
				.offset(x: DiscStepMetrics.slotDiscInset, y: DiscStepMetrics.slotDiscInset)
		}
		.frame(width: DiscStepMetrics.slotSize, height: DiscStepMetrics.slotSize)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier(Self.slotIdentifier)
		.offset(x: DiscStepMetrics.slotLeft, y: DiscStepMetrics.slotTop - DiscStepMetrics.referenceTopInset)
	}

	@ViewBuilder private var slotDisc: some View {
		if let selected {
			flyingDisc(selected, size: DiscStepMetrics.slotDiscSize).id(selected)
		} else {
			ProfileDiscImage(disc: nil, size: DiscStepMetrics.slotDiscSize)
		}
	}

	private func tile(_ disc: ProfileDisc) -> some View {
		let contained = Self.containedDisc(in: disc, selected: selected)
		let origin = DiscStepMetrics.tileOrigin(of: disc)
		return Button {
			Self.choose(disc, selected: selected, onSelect: onSelect)
		} label: {
			ZStack(alignment: .topLeading) {
				RoundedRectangle(cornerRadius: DiscStepMetrics.tileRadius)
					.fill(DiscStepMetrics.gradient(for: contained))
				tileDisc(contained)
					.offset(x: DiscStepMetrics.tileDiscInset, y: DiscStepMetrics.tileDiscInset)
			}
			.frame(width: DiscStepMetrics.tileSize, height: DiscStepMetrics.tileSize)
			.contentShape(RoundedRectangle(cornerRadius: DiscStepMetrics.tileRadius))
		}
		.buttonStyle(.plain)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Self.tileLabel(for: disc))
		.accessibilityAddTraits(Self.traits(for: disc, selected: selected))
		.accessibilityIdentifier(Self.tileIdentifier(for: disc))
		.offset(x: origin.x, y: origin.y - DiscStepMetrics.referenceTopInset)
	}

	@ViewBuilder private func tileDisc(_ contained: ProfileDisc?) -> some View {
		if let contained {
			flyingDisc(contained, size: DiscStepMetrics.tileDiscSize)
		} else {
			ProfileDiscImage(disc: nil, size: DiscStepMetrics.tileDiscSize)
		}
	}

	/// The disc that changes place. The image is drawn at the size the layout gives it, so that the matched
	/// geometry grows it from the tile to the slot; under Reduce Motion it stays put and cross-fades.
	@ViewBuilder private func flyingDisc(_ disc: ProfileDisc, size: CGFloat) -> some View {
		switch DiscStepMetrics.movement(reduceMotion: reduceMotion) {
		case .flies:
			resizableDisc(disc).matchedGeometryEffect(id: disc, in: discSpace).frame(width: size, height: size)
		case .crossFades:
			resizableDisc(disc).frame(width: size, height: size).transition(.opacity)
		}
	}

	private func resizableDisc(_ disc: ProfileDisc) -> some View {
		GeometryReader { proxy in
			ProfileDiscImage(disc: disc, size: min(proxy.size.width, proxy.size.height))
		}
	}
}
