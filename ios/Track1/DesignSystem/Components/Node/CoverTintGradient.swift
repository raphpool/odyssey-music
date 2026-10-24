import SwiftUI
import Track1Core
import UIKit

/// Figma `282:837` (page) and `285:1034` (card): the soft linear tint derived from the cover, running from the top
/// of the frame to an opaque endpoint colour. Three cover stops at `CoverTintTone.stopPositions`, then the
/// endpoint from `CoverTintTone.endpointPosition` to the bottom.
///
/// Opaque everywhere, by spec: the gradient never fades to transparency, so no stop and no endpoint carries an
/// opacity. The page ends in `background.base`, the card in `background.elevated`.
struct CoverTintGradient: View {
	private let tint: CoverTint
	private let endpoint: Color

	init(tint: CoverTint, endpoint: Color) {
		self.tint = tint
		self.endpoint = endpoint
	}

	/// Five stops: the three cover stops, then the endpoint at 0.50 and at 1.0.
	static func stops(tint: CoverTint, endpoint: Color) -> [Gradient.Stop] {
		let positions = CoverTintTone.stopPositions
		var stops = zip(tint.stops, positions).map { Gradient.Stop(color: Color($0), location: CGFloat($1)) }
		stops.append(Gradient.Stop(color: endpoint, location: CGFloat(CoverTintTone.endpointPosition)))
		stops.append(Gradient.Stop(color: endpoint, location: 1))
		return stops
	}

	var body: some View {
		LinearGradient(stops: Self.stops(tint: tint, endpoint: endpoint), startPoint: .top, endPoint: .bottom)
	}
}

// The only place of the app that builds a colour from raw components: `Track1Core` carries a palette as
// `LinearRGB`, the views draw `Color`. `test/ios-design-tokens.test.ts` does not scan `DesignSystem/`.
extension Color {
	/// An opaque sRGB colour.
	init(_ rgb: LinearRGB) {
		self.init(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue, opacity: 1)
	}
}

extension LinearRGB {
	/// The sRGB components of `color`; `nil` when UIKit cannot express it in an RGB space. Opacity is dropped.
	init?(_ color: Color) {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
		self.init(red: Double(red), green: Double(green), blue: Double(blue))
	}
}
