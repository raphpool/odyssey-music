import Foundation
import XCTest

@testable import Track1Core

/// The real store, with the `/image` reader and the loader as closures over a recording backend.
final class NodeImageStoreTests: XCTestCase {
	private let massiveAttack = "artist:massive-attack"
	private let imageURL = "https://img.example.com/a.jpg"

	func testConcurrentRequestsForOneIdentityReadImageOnceAndLaterCallsReadNothing() async throws {
		let backend = Backend(answers: [massiveAttack: .init(slug: massiveAttack, imageURL: imageURL)])
		backend.hold()
		let store = backend.makeStore()
		let identity = try XCTUnwrap(NodeIdentity(rawValue: massiveAttack))

		async let first = store.image(for: identity)
		async let second = store.image(for: identity)
		await backend.waitForReads()
		// Lets the second caller reach the store. If it were late the test would prove less, never fail.
		for _ in 0..<20 { await Task.yield() }
		backend.release()
		let results = await [first, second]
		let later = await store.image(for: identity)

		XCTAssertEqual(results, ["image:\(imageURL)", "image:\(imageURL)"])
		XCTAssertEqual(later, "image:\(imageURL)")
		XCTAssertEqual(backend.counts.reads, 1, "Concurrent and later requests share one /image call.")
		XCTAssertEqual(backend.counts.loads, 1, "They also share one image load.")
	}

	func testAnotherSlugOrANullImageURLGivesNilAndNothingIsLoaded() async throws {
		let backend = Backend(answers: [
			massiveAttack: .init(slug: "artist:portishead", imageURL: imageURL),
			"artist:portishead": .init(slug: "artist:portishead", imageURL: nil),
		])
		let store = backend.makeStore()

		for value in [massiveAttack, "artist:portishead"] {
			let image = await store.image(for: try XCTUnwrap(NodeIdentity(rawValue: value)))
			XCTAssertNil(image, value)
		}

		XCTAssertEqual(backend.counts.loads, 0, "Neither answer may lead to a load.")
	}

	func testFailedAnswersAreCachedForTheSession() async throws {
		let backend = Backend(answers: [:])  // /image fails for every identity
		let store = backend.makeStore()
		let identity = try XCTUnwrap(NodeIdentity(rawValue: massiveAttack))

		let first = await store.image(for: identity)
		let second = await store.image(for: identity)

		XCTAssertNil(first)
		XCTAssertNil(second)
		XCTAssertEqual(backend.counts.reads, 1)
	}

	func testImageAtURLSharesOneLoadAndNeverCallsImage() async throws {
		let backend = Backend(answers: [:])
		backend.hold()
		let store = backend.makeStore()
		let url = try XCTUnwrap(URL(string: imageURL))

		async let first = store.image(at: url)
		async let second = store.image(at: url)
		await backend.waitForLoads()
		for _ in 0..<20 { await Task.yield() }
		backend.release()
		let results = await [first, second]
		let later = await store.image(at: url)

		XCTAssertEqual(results + [later], Array(repeating: "image:\(imageURL)", count: 3))
		XCTAssertEqual(backend.counts.loads, 1)
		XCTAssertEqual(backend.counts.reads, 0)
	}

	func testImageAtAnUnsafeURLIsNeverHandedToTheLoader() async throws {
		let backend = Backend(answers: [:])
		let store = backend.makeStore()
		let unsafe = ["http://img.example.com/a.jpg", "https://127.0.0.1/a.jpg", "https://2130706433/a.jpg"]

		for value in unsafe + ["https://img.example.com:8443/a.jpg", "https://localhost/a.jpg"] {
			let image = await store.image(at: try XCTUnwrap(URL(string: value)))
			XCTAssertNil(image, value)
		}

		XCTAssertEqual(backend.counts.loads, 0)
	}
}

/// A recording stand-in for `/image` and the image loader. Images are plain strings so the store is tested
/// without UIKit; `hold()` parks every read and load until `release()` so that calls overlap.
private final class Backend: @unchecked Sendable {
	struct Answer {
		let slug: String
		let imageURL: String?
	}

	private let lock = NSLock()
	private let answers: [String: Answer]
	private var reads = 0
	private var loads = 0
	private var isHeld = false
	private var parked: [CheckedContinuation<Void, Never>] = []

	init(answers: [String: Answer]) {
		self.answers = answers
	}

	var counts: (reads: Int, loads: Int) { locked { (reads, loads) } }

	func makeStore() -> NodeImageStore<String> {
		NodeImageStore<String>(
			readImage: { [self] in await read($0) },
			load: { [self] in await load($0) })
	}

	func hold() { locked { isHeld = true } }

	func release() {
		let pending = locked {
			isHeld = false
			defer { parked = [] }
			return parked
		}
		for continuation in pending { continuation.resume() }
	}

	func waitForReads() async { while counts.reads < 1 { await Task.yield() } }
	func waitForLoads() async { while counts.loads < 1 { await Task.yield() } }

	private func parkIfHeld() async {
		await withCheckedContinuation { continuation in
			let resumeNow = locked {
				if !isHeld { return true }
				parked.append(continuation)
				return false
			}
			if resumeNow { continuation.resume() }
		}
	}

	private func read(_ identity: NodeIdentity) async -> APIResult<ImageResponse> {
		locked { reads += 1 }
		await parkIfHeld()
		guard let answer = answers[identity.rawValue] else { return .failure(.invalidResponse) }
		let url = answer.imageURL.map { "\"\($0)\"" } ?? "null"
		let body = #"{"slug":"\#(answer.slug)","image_url":\#(url),"source":"test"}"#
		guard let response = try? JSONDecoder().decode(ImageResponse.self, from: Data(body.utf8)) else {
			return .failure(.invalidResponse)
		}
		return .success(response, etag: nil)
	}

	private func load(_ url: URL) async -> String? {
		locked { loads += 1 }
		await parkIfHeld()
		return "image:\(url.absoluteString)"
	}

	private func locked<T>(_ body: () -> T) -> T {
		lock.lock()
		defer { lock.unlock() }
		return body()
	}
}
