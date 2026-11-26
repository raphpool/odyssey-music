import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The hero model over a real `NodeImageStore` whose `/image` reader and loader are closures: no network,
/// and no test waits on a timeout, since the one blocked load is released by the test itself.
@MainActor
final class HeroImageTests: XCTestCase {
	private let first = "https://img.example.com/first.jpg"
	private let second = "https://img.example.com/second.jpg"

	// MARK: - Dominant colour

	func testPureRedImageGivesRedWithinTolerance() throws {
		let tint = try XCTUnwrap(DominantColor.of(Self.solid(.red)))

		let components = Self.components(of: tint)
		XCTAssertEqual(components.red, 1, accuracy: 0.02)
		XCTAssertEqual(components.green, 0, accuracy: 0.02)
		XCTAssertEqual(components.blue, 0, accuracy: 0.02)
	}

	func testTranslucentRedStaysRedAndIsNotDarkened() throws {
		let tint = try XCTUnwrap(DominantColor.of(Self.solid(UIColor.red.withAlphaComponent(0.5))))

		let components = Self.components(of: tint)
		XCTAssertEqual(components.red, 1, accuracy: 0.02)
		XCTAssertEqual(components.green, 0, accuracy: 0.02)
	}

	func testFullyTransparentImageHasNoDominantColor() {
		XCTAssertNil(DominantColor.of(Self.solid(.clear)))
	}

	// MARK: - Colour bands

	func testThirdsRedGreenBlueGiveThreeBandsFromTopToBottom() throws {
		let bands = try XCTUnwrap(DominantColor.bands(of: Self.thirds()))

		Self.assertBands(bands, [(1, 0, 0), (0, 1, 0), (0, 0, 1)])
	}

	func testTranslucentBandsKeepTheirColourAndAreNotDarkened() throws {
		let bands = try XCTUnwrap(DominantColor.bands(of: Self.thirds(alpha: 0.5)))

		Self.assertBands(bands, [(1, 0, 0), (0, 1, 0), (0, 0, 1)])
	}

	func testFullyTransparentImageHasNoBands() {
		XCTAssertNil(DominantColor.bands(of: Self.solid(.clear, side: 32)))
	}

	func testOneTransparentBandGivesNoBandsAtAll() {
		XCTAssertNil(DominantColor.bands(of: Self.thirds(bottom: .clear)))
	}

	// MARK: - Fallback chain

	// A track is the one kind that still has a chain after its own image: its project's cover is its album.

	func testFirstCandidateWithoutImageFallsThroughToTheSecondAndTheStateIsLoaded() async throws {
		let backend = Backend(images: [second: Self.solid(.red)])
		let model = try model(backend, type: .track, imageURL: first, listed: ("project", "project:a"))
		backend.answers["project:a"] = second

		await model.load()

		guard case .loaded(_, let tint, let coverTint) = model.state else {
			return XCTFail("State was \(model.state).")
		}
		XCTAssertNotNil(tint)
		XCTAssertNotNil(coverTint)
		XCTAssertEqual(backend.loaded, [first, second])
	}

	func testALoadedImageCarriesTheCoverTintOfItsBands() async throws {
		let backend = Backend(images: [first: Self.thirds()])
		let model = try model(backend, imageURL: first)

		await model.load()

		guard case .loaded(_, _, let coverTint) = model.state else { return XCTFail("State was \(model.state).") }
		let bands = try XCTUnwrap(DominantColor.bands(of: Self.thirds()))
		XCTAssertEqual(coverTint, CoverTintTone.tint(bands: bands))
		XCTAssertNotNil(coverTint)
		XCTAssertNil(NodePageView.coverTint(for: .loading))
		XCTAssertNil(NodePageView.coverTint(for: .placeholder))
	}

	func testAPlayerScaleModelCarriesTheCoverTintOfItsBandsOnThePlayerScale() async throws {
		let backend = Backend(images: [first: Self.thirds()])
		let model = try model(backend, imageURL: first, scale: .player)

		await model.load()

		guard case .loaded(_, _, let coverTint) = model.state else { return XCTFail("State was \(model.state).") }
		let bands = try XCTUnwrap(DominantColor.bands(of: Self.thirds()))
		XCTAssertEqual(coverTint, CoverTintTone.tint(bands: bands, scale: .player))
		XCTAssertNotEqual(coverTint, CoverTintTone.tint(bands: bands))
		XCTAssertNotNil(coverTint)
	}

	func testFirstImageWinsAndLaterCandidatesAreNotRead() async throws {
		let backend = Backend(images: [first: Self.solid(.red), second: Self.solid(.blue)])
		let model = try model(backend, type: .track, imageURL: first, listed: ("project", "project:a"))
		backend.answers["project:a"] = second

		await model.load()

		guard case .loaded = model.state else { return XCTFail("State was \(model.state).") }
		XCTAssertEqual(backend.loaded, [first])
		XCTAssertEqual(backend.reads, [])
	}

	func testWhenEveryCandidateGivesNothingTheStateIsPlaceholder() async throws {
		let backend = Backend(images: [:])
		let model = try model(backend, type: .track, imageURL: first, listed: ("project", "project:a"))

		await model.load()

		XCTAssertEqual(model.state, .placeholder)
		XCTAssertEqual(backend.reads, ["project:a"])
	}

	// MARK: - No borrowing from a listed work (TRA-593)

	func testAnArtistWithoutImageAsksForItsOwnImageAndNeverForAListedWork() async throws {
		let backend = Backend(images: [second: Self.solid(.red)])
		let model = try model(backend, imageURL: nil, listed: ("discography", "project:a"))
		backend.answers["project:a"] = first
		backend.answers["artist:sample-artist"] = second

		await model.load()

		guard case .loaded = model.state else { return XCTFail("State was \(model.state).") }
		XCTAssertEqual(backend.reads, ["artist:sample-artist"])
		XCTAssertEqual(backend.loaded, [second])
	}

	func testAnArtistWhoseOwnImageEndpointGivesNothingIsAPlaceholderEvenWithAListedWork() async throws {
		let backend = Backend(images: [first: Self.solid(.red)])
		let model = try model(backend, imageURL: nil, listed: ("discography", "project:a"))
		backend.answers["project:a"] = first

		await model.load()

		XCTAssertEqual(model.state, .placeholder)
		XCTAssertEqual(backend.reads, ["artist:sample-artist"])
		XCTAssertEqual(backend.loaded, [])
	}

	// TRA-794: the home recommends a work after reading its `/image`, so the hero reads that same endpoint.
	func testAProjectWithoutImageReadsItsOwnImageOnceAndIsAPlaceholderWhenThereIsNone() async throws {
		let backend = Backend(images: [:])
		let model = try model(backend, type: .project, imageURL: nil)

		await model.load()

		XCTAssertEqual(model.state, .placeholder)
		XCTAssertEqual(backend.reads, ["project:sample-project"])
		XCTAssertEqual(backend.loaded, [])
	}

	func testAProjectWithoutImageShowsTheImageItsOwnImageEndpointGives() async throws {
		let backend = Backend(images: [first: Self.solid(.red)])
		let model = try model(backend, type: .project, imageURL: nil)
		backend.answers["project:sample-project"] = first

		await model.load()

		guard case .loaded = model.state else { return XCTFail("State was \(model.state).") }
		XCTAssertEqual(backend.reads, ["project:sample-project"])
		XCTAssertEqual(backend.loaded, [first])
	}

	// MARK: - Cancellation

	func testAnImageArrivingAfterCancellationDoesNotChangeTheState() async throws {
		let gate = Gate()
		let (started, signal) = AsyncStream.makeStream(of: Void.self)
		let image = Self.solid(.red)
		let backend = Backend(
			images: [first: image],
			beforeLoading: {
				signal.yield()
				await gate.wait()
			})
		let model = try model(backend, imageURL: first)

		let task = Task { await model.load() }
		for await _ in started { break }
		task.cancel()
		await gate.open()
		await task.value

		XCTAssertEqual(model.state, .loading)
		XCTAssertEqual(backend.loaded, [first])

		// A screen shown again loads afresh, and the image the cancelled load fetched is not lost.
		await model.load()

		guard case .loaded(_, let tint, _) = model.state else { return XCTFail("State was \(model.state).") }
		XCTAssertNotNil(tint)
		XCTAssertEqual(backend.loaded, [first])
	}

	// MARK: - Fixtures

	private static func solid(_ color: UIColor, side: Int = 4) -> UIImage {
		let format = UIGraphicsImageRendererFormat()
		format.scale = 1
		format.opaque = false
		format.preferredRange = .standard
		let size = CGSize(width: side, height: side)
		return UIGraphicsImageRenderer(size: size, format: format).image { context in
			color.setFill()
			context.fill(CGRect(origin: .zero, size: size))
		}
	}

	/// A 32 × 32 image whose rows 0–10, 11–21 and 22–31 are red, green and blue, at `alpha`.
	private static func thirds(
		alpha: CGFloat = 1, top: UIColor = .red, middle: UIColor = .green, bottom: UIColor = .blue
	) -> UIImage {
		let format = UIGraphicsImageRendererFormat()
		format.scale = 1
		format.opaque = false
		format.preferredRange = .standard
		let size = CGSize(width: 32, height: 32)
		let rows: [(UIColor, CGRect)] = [
			(top, CGRect(x: 0, y: 0, width: 32, height: 11)),
			(middle, CGRect(x: 0, y: 11, width: 32, height: 11)),
			(bottom, CGRect(x: 0, y: 22, width: 32, height: 10)),
		]
		return UIGraphicsImageRenderer(size: size, format: format).image { context in
			for (color, rect) in rows {
				color.withAlphaComponent(color == .clear ? 0 : alpha).setFill()
				context.fill(rect)
			}
		}
	}

	private static func assertBands(
		_ bands: [LinearRGB], _ expected: [(Double, Double, Double)], file: StaticString = #filePath,
		line: UInt = #line
	) {
		XCTAssertEqual(bands.count, expected.count, file: file, line: line)
		for (band, want) in zip(bands, expected) {
			XCTAssertEqual(band.red, want.0, accuracy: 2.0 / 255, file: file, line: line)
			XCTAssertEqual(band.green, want.1, accuracy: 2.0 / 255, file: file, line: line)
			XCTAssertEqual(band.blue, want.2, accuracy: 2.0 / 255, file: file, line: line)
		}
	}

	private static func components(of color: Color) -> (red: Double, green: Double, blue: Double) {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: nil)
		return (Double(red), Double(green), Double(blue))
	}

	private func model(
		_ backend: Backend, type: NodeType = .artist, imageURL: String?,
		listed: (edge: String, slug: String)? = nil, scale: CoverTintTone.Scale = .page
	) throws -> NodeHeroModel {
		NodeHeroModel(
			node: try Self.node(type: type, imageURL: imageURL, listed: listed), store: backend.store,
			scale: scale)
	}

	/// A node decoded from the JSON the API sends, so the fixture cannot drift from the real shape. `listed` is
	/// a work on one of the node's edges (an artist's `discography`, a track's `project`).
	private static func node(
		type: NodeType, imageURL: String?, listed: (edge: String, slug: String)?
	) throws -> NodeDetail {
		let image = imageURL.map { "\"\($0)\"" } ?? "null"
		let entry = listed.map {
			#""\#($0.edge)":[{"slug":"\#($0.slug)","type":"project","name":"Release"}]"#
		}
		let source = """
			{"id":"\(type.rawValue):sample-\(type.rawValue)","type":"\(type.rawValue)","name":"Sample","teaser":null,"article":"A","citations":[],"facts":{},"edges":{\(entry ?? "")},"materialized_at":"2026-10-08T00:00:00Z","image_url":\(image)}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}
}

/// Lets one load hang until the test opens it. `open` before `wait` is remembered, so the order never matters.
private actor Gate {
	private var isOpen = false
	private var waiters: [CheckedContinuation<Void, Never>] = []

	func wait() async {
		if isOpen { return }
		await withCheckedContinuation { waiters.append($0) }
	}

	func open() {
		isOpen = true
		let pending = waiters
		waiters = []
		for waiter in pending { waiter.resume() }
	}
}

/// A real `NodeImageStore` over closures: `/image` answers come from `answers`, images from `images`.
/// It records the identities read and the URLs loaded.
private final class Backend: @unchecked Sendable {
	private let lock = NSLock()
	private let images: [String: UIImage]
	private let beforeLoading: @Sendable () async -> Void
	private var recordedReads: [String] = []
	private var recordedLoads: [String] = []
	private var imageAnswers: [String: String] = [:]

	init(images: [String: UIImage], beforeLoading: @escaping @Sendable () async -> Void = {}) {
		self.images = images
		self.beforeLoading = beforeLoading
	}

	var answers: [String: String] {
		get { lock.withLock { imageAnswers } }
		set { lock.withLock { imageAnswers = newValue } }
	}

	var reads: [String] { lock.withLock { recordedReads } }
	var loaded: [String] { lock.withLock { recordedLoads } }

	var store: NodeImageStore<UIImage> {
		NodeImageStore<UIImage>(
			readImage: { [self] in read($0) },
			load: { [self] in await load($0) })
	}

	private func read(_ identity: NodeIdentity) -> APIResult<ImageResponse> {
		let url = lock.withLock { () -> String? in
			recordedReads.append(identity.rawValue)
			return imageAnswers[identity.rawValue]
		}
		let value = url.map { "\"\($0)\"" } ?? "null"
		let body = #"{"slug":"\#(identity.rawValue)","image_url":\#(value),"source":"test"}"#
		guard let response = try? JSONDecoder().decode(ImageResponse.self, from: Data(body.utf8)) else {
			return .failure(.invalidResponse)
		}
		return .success(response, etag: nil)
	}

	private func load(_ url: URL) async -> UIImage? {
		lock.withLock { recordedLoads.append(url.absoluteString) }
		await beforeLoading()
		return images[url.absoluteString]
	}
}
