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

	// MARK: - pending (TRA-586)

	func testPendingThenFoundRendersTheImageAfterOneWait() async throws {
		let backend = ScriptedBackend([pending(2), found])
		let store = backend.makeStore()

		let image = await store.image(for: try identity())

		XCTAssertEqual(image, "image:\(imageURL)")
		XCTAssertEqual(backend.reads, 2)
		XCTAssertEqual(backend.loads, 1)
		XCTAssertEqual(backend.sleeps, [.seconds(2)])
	}

	func testSixPendingAnswersGiveNilWithoutRememberingTheWait() async throws {
		let backend = ScriptedBackend(Array(repeating: pending(2), count: 6) + [found])
		let store = backend.makeStore()
		let identity = try identity()

		let first = await store.image(for: identity)
		XCTAssertNil(first)
		XCTAssertEqual(backend.reads, 6)
		XCTAssertEqual(backend.sleeps.count, 5)

		let second = await store.image(for: identity)
		XCTAssertEqual(second, "image:\(imageURL)", "Nothing was remembered, so the next call reads again.")
		XCTAssertEqual(backend.reads, 7)
	}

	func testTheWaitFollowsRetryAfterWithinTwoAndThirtySeconds() async throws {
		let cases: [(String, Duration)] = [
			(pending(nil), .seconds(5)), (pending(0), .seconds(2)), (pending(1), .seconds(2)),
			(pending(12), .seconds(12)), (pending(120), .seconds(30)),
		]
		for (answer, expected) in cases {
			let backend = ScriptedBackend([answer, found])
			let image = await backend.makeStore().image(for: try identity())
			XCTAssertNotNil(image)
			XCTAssertEqual(backend.sleeps, [expected], answer)
		}
	}

	func testConcurrentWaitersShareOneSeriesAndOneCancelledWaiterDoesNotStopIt() async throws {
		let backend = ScriptedBackend([pending(2), found])
		backend.holdSleeps()
		let store = backend.makeStore()
		let identity = try identity()

		let staying = Task { await store.image(for: identity) }
		let leaving = Task { await store.image(for: identity) }
		await backend.waitForSleeps(1)
		for _ in 0..<20 { await Task.yield() }
		leaving.cancel()
		let leavingResult = await leaving.value
		backend.releaseSleeps()
		let stayingResult = await staying.value

		XCTAssertNil(leavingResult, "A cancelled caller gets nil at once.")
		XCTAssertEqual(stayingResult, "image:\(imageURL)")
		XCTAssertEqual(backend.reads, 2, "Both callers shared one series of reads.")
	}

	func testWhenEveryWaiterIsCancelledTheSeriesStopsAtTheNextPendingAnswer() async throws {
		let backend = ScriptedBackend(Array(repeating: pending(2), count: 6) + [found])
		backend.holdSleeps()
		let store = backend.makeStore()
		let identity = try identity()

		let first = Task { await store.image(for: identity) }
		let second = Task { await store.image(for: identity) }
		await backend.waitForSleeps(1)
		for _ in 0..<20 { await Task.yield() }
		first.cancel()
		second.cancel()
		_ = await (first.value, second.value)
		backend.releaseSleeps()
		for _ in 0..<50 { await Task.yield() }

		XCTAssertEqual(backend.reads, 2, "One more read after the wait, then nobody is left: no third read.")
		XCTAssertEqual(backend.sleeps.count, 1)
	}

	func testANewCallerJoinsASeriesThatEveryoneElseLeft() async throws {
		let backend = ScriptedBackend([pending(2), pending(2), found])
		backend.holdSleeps()
		let store = backend.makeStore()
		let identity = try identity()

		let leaving = Task { await store.image(for: identity) }
		await backend.waitForSleeps(1)
		leaving.cancel()
		_ = await leaving.value
		let joining = Task { await store.image(for: identity) }
		for _ in 0..<20 { await Task.yield() }
		backend.releaseSleeps()
		let result = await joining.value

		XCTAssertEqual(result, "image:\(imageURL)")
		XCTAssertEqual(backend.reads, 3, "The joining caller kept the series alive instead of starting another.")
	}

	func testNoWaitGivesNilAtOnceOnPendingAndRemembersNothing() async throws {
		let backend = ScriptedBackend([pending(2), found])
		let store = backend.makeStore()
		let identity = try identity()

		let skipped = await store.image(for: identity, policy: .noWait)
		XCTAssertNil(skipped)
		XCTAssertEqual(backend.reads, 1)
		XCTAssertEqual(backend.sleeps, [])

		let waited = await store.image(for: identity)
		XCTAssertEqual(waited, "image:\(imageURL)")
		XCTAssertEqual(backend.reads, 2)
	}

	func testNoneAndAnAnswerWithoutStateAreRememberedAsUnavailable() async throws {
		let explicitNone = #"{"slug":"artist:massive-attack","image_url":null,"source":"cache","state":"none"}"#
		for answer in [explicitNone, none] {
			let backend = ScriptedBackend([answer, found])
			let store = backend.makeStore()
			let identity = try identity()

			let first = await store.image(for: identity)
			let second = await store.image(for: identity)

			XCTAssertNil(first)
			XCTAssertNil(second)
			XCTAssertEqual(backend.reads, 1, answer)
			XCTAssertEqual(backend.sleeps, [])
		}
	}

	func testAFoundAnswerWithAStateIsLoadedAndRemembered() async throws {
		let backend = ScriptedBackend([
			#"{"slug":"artist:massive-attack","image_url":"\#(imageURL)","source":"cache","state":"found"}"#
		])
		let store = backend.makeStore()
		let identity = try identity()

		_ = await store.image(for: identity)
		let again = await store.image(for: identity)

		XCTAssertEqual(again, "image:\(imageURL)")
		XCTAssertEqual(backend.reads, 1)
	}

	// MARK: - Fixtures

	private func identity() throws -> NodeIdentity { try XCTUnwrap(NodeIdentity(rawValue: massiveAttack)) }

	private func pending(_ retryAfter: Int?) -> String {
		let retry = retryAfter.map { ",\"retry_after_seconds\":\($0)" } ?? ""
		return #"{"slug":"artist:massive-attack","image_url":null,"source":"cache","state":"pending"\#(retry)}"#
	}

	private var found: String {
		#"{"slug":"artist:massive-attack","image_url":"\#(imageURL)","source":"cache"}"#
	}

	private var none: String { #"{"slug":"artist:massive-attack","image_url":null,"source":"cache"}"# }
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

/// `/image` answers played in order (the last one repeats), a loader, and a `sleep` that records its durations
/// instead of sleeping. `holdSleeps()` parks every sleep until `releaseSleeps()` so that tests can cancel
/// callers while the store waits.
private final class ScriptedBackend: @unchecked Sendable {
	private let lock = NSLock()
	private let bodies: [String]
	private var readCount = 0
	private var loadCount = 0
	private var recordedSleeps: [Duration] = []
	private var sleepsHeld = false
	private var parked: [CheckedContinuation<Void, Never>] = []

	init(_ bodies: [String]) {
		self.bodies = bodies
	}

	var reads: Int { locked { readCount } }
	var loads: Int { locked { loadCount } }
	var sleeps: [Duration] { locked { recordedSleeps } }

	func makeStore() -> NodeImageStore<String> {
		NodeImageStore<String>(
			readImage: { [self] _ in read() },
			load: { [self] url in
				locked { loadCount += 1 }
				return "image:\(url.absoluteString)"
			},
			sleep: { [self] in await sleep($0) })
	}

	func holdSleeps() { locked { sleepsHeld = true } }

	func releaseSleeps() {
		let pending = locked {
			sleepsHeld = false
			defer { parked = [] }
			return parked
		}
		for continuation in pending { continuation.resume() }
	}

	/// Bounded, so a store that never sleeps fails the test instead of hanging the job.
	func waitForSleeps(_ count: Int) async {
		var spins = 0
		while sleeps.count < count, spins < 100_000 {
			spins += 1
			await Task.yield()
		}
	}

	private func read() -> APIResult<ImageResponse> {
		let body = locked {
			defer { readCount += 1 }
			return bodies[min(readCount, bodies.count - 1)]
		}
		guard let response = try? JSONDecoder().decode(ImageResponse.self, from: Data(body.utf8)) else {
			return .failure(.invalidResponse)
		}
		return .success(response, etag: nil)
	}

	private func sleep(_ duration: Duration) async {
		locked { recordedSleeps.append(duration) }
		await withCheckedContinuation { continuation in
			let resumeNow = locked {
				if !sleepsHeld { return true }
				parked.append(continuation)
				return false
			}
			if resumeNow { continuation.resume() }
		}
	}

	private func locked<T>(_ body: () -> T) -> T {
		lock.lock()
		defer { lock.unlock() }
		return body()
	}
}
