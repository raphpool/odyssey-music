import CoreImage
import SwiftUI
import UIKit

/// The tint of a node image (disc label, glow of project and track pages), computed on the phone (D10, Q6):
/// the pipeline stores no colour, so the schema stays as it is.
enum DominantColor {
	/// The image is reduced to this many pixels per side first, so the cost does not depend on the download.
	static let sampleSide = 32

	/// The average colour of `image`, each pixel weighted by its opacity (a logo on a transparent background
	/// gives the logo's colour), or `nil` for an image that is fully transparent: there is no colour to average.
	static func of(_ image: UIImage) -> Color? {
		guard let sample = reduced(image), let rgba = average(of: sample) else { return nil }
		return Color(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: 1)
	}

	/// Redraws the image into a `sampleSide` square, in sRGB, whatever its size, scale or orientation.
	private static func reduced(_ image: UIImage) -> CGImage? {
		let format = UIGraphicsImageRendererFormat()
		format.scale = 1
		format.opaque = false
		format.preferredRange = .standard
		let size = CGSize(width: sampleSide, height: sampleSide)
		return UIGraphicsImageRenderer(size: size, format: format).image { _ in
			image.draw(in: CGRect(origin: .zero, size: size))
		}.cgImage
	}

	/// `CIAreaAverage` over the whole sample, read back as one pixel. Core Image works on premultiplied values,
	/// so the colour is divided by the alpha: a half-transparent red averages to red, not to dark red. The
	/// pixel is read as floats because 8 bits would leave a mostly transparent image with a few steps of
	/// colour, and dividing those by a tiny alpha amplifies the rounding into a wrong hue.
	static func average(of sample: CGImage) -> (red: Double, green: Double, blue: Double)? {
		let input = CIImage(cgImage: sample)
		guard let filter = CIFilter(name: "CIAreaAverage") else { return nil }
		filter.setValue(input, forKey: kCIInputImageKey)
		filter.setValue(CIVector(cgRect: input.extent), forKey: kCIInputExtentKey)
		guard let output = filter.outputImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else {
			return nil
		}
		var pixel = [Float](repeating: 0, count: 4)
		CIContext(options: [.workingColorSpace: space, .outputColorSpace: space]).render(
			output, toBitmap: &pixel, rowBytes: 4 * MemoryLayout<Float>.stride,
			bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBAf, colorSpace: space)
		let alpha = Double(pixel[3])
		guard alpha > 0 else { return nil }
		func channel(_ value: Float) -> Double { min(max(Double(value) / alpha, 0), 1) }
		return (channel(pixel[0]), channel(pixel[1]), channel(pixel[2]))
	}
}
