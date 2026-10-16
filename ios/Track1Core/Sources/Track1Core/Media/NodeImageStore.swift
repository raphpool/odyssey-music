import Foundation

/// Whether `image(for:)` waits for a node whose image the server is still resolving (`pending`).
public enum ImageWaitPolicy: Sendable {
	/// Retry in the background, six reads at most, and give `nil` if the image is still not there.
	case waitForPending
	/// Ask once and give `nil` at once on `pending`.
	case noWait
}

/// Session cache and request coalescing for node images (plan D10).
///
/// Generic over the decoded image type so the package stays free of UIKit: the app instantiates it with
/// `UIImage`, the tests with a plain value. Nothing in here fetches bytes: `load` does, and it is the one
/// place that must validate redirects.
///
/// Every URL is untrusted API data. It is checked with `URLValidation.publicHTTPSURL` before `load` sees it,
/// and the loader checks it again, so a caller that skips this store still gets the same refusals. That
/// check classifies the host as written (literal IP spellings, `localhost`): a public-looking DNS name that
/// resolves to a private address is outside what it can see.
public actor NodeImageStore<Image: Sendable> {
	/// Upper bound on decoded images kept in memory. `NSCache` may evict earlier under memory pressure.
	static var imageCountLimit: Int { 200 }

	/// Reads of `/image` per identity and per series while the server answers `pending` (TRA-586, decision
	/// 3b-D6). Five waits of 2...30 s each: 25 s with the server's usual 5 s hint, 150 s at the very most.
	static var maxPendingReads: Int { 6 }
	static var defaultRetryAfterSeconds: Int { 5 }
	static var retryAfterRange: ClosedRange<Int> { 2...30 }

	private enum Resolution {
		case url(URL)
		case unavailable
	}

	/// What one `/image` read says: an answer worth remembering, or "not yet".
	private enum Outcome {
		case resolved(Resolution)
		case pending(retryAfterSeconds: Int?)
	}

	/// One shared retry series for an identity, and the callers that still want its result.
	private struct Series {
		var waiters: [UUID: CheckedContinuation<Resolution?, Never>] = [:]
	}

	private final class Box: Sendable {
		let image: Image
		init(_ image: Image) { self.image = image }
	}

	private let readImage: @Sendable (NodeIdentity) async -> APIResult<ImageResponse>
	private let load: @Sendable (URL) async -> Image?
	private let sleep: @Sendable (Duration) async throws -> Void

	// `/image` answers are kept for the whole session, failures included: a redraw must not turn into a
	// request storm while the server is down.
	// 2026-10-16: a 202 `pending` answer was cached as `unavailable` for the session, so covers stayed
	// gradients until the app restarted (TRA-586). `pending` never enters this table.
	private var resolutions: [NodeIdentity: Resolution] = [:]
	private var seriesInFlight: [NodeIdentity: Series] = [:]

	private let images = NSCache<NSString, Box>()
	private var failedURLs: Set<URL> = []
	private var loadsInFlight: [URL: Task<Image?, Never>] = [:]

	public init(
		readImage: @escaping @Sendable (NodeIdentity) async -> APIResult<ImageResponse>,
		load: @escaping @Sendable (URL) async -> Image?,
		sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
	) {
		self.readImage = readImage
		self.load = load
		self.sleep = sleep
		images.countLimit = Self.imageCountLimit
	}

	/// The image of `identity`, read through `/image`. `nil` when the answer is for another slug, carries no
	/// image URL, the image cannot be loaded, the caller is cancelled, or the server is still resolving it
	/// (`policy`).
	public func image(for identity: NodeIdentity, policy: ImageWaitPolicy = .waitForPending) async -> Image? {
		switch await resolution(of: identity, policy: policy) {
		case .url(let url): return await image(at: url)
		case .unavailable, nil: return nil
		}
	}

	/// The image at an URL the API already returned (for example `NodeDetail.image_url`).
	public func image(at url: URL) async -> Image? {
		guard let url = URLValidation.publicHTTPSURL(from: url.absoluteString) else { return nil }
		if let cached = images.object(forKey: Self.key(for: url)) { return cached.image }
		if failedURLs.contains(url) { return nil }
		if let pending = loadsInFlight[url] { return await pending.value }
		let load = self.load
		// Unstructured on purpose: the work outlives a caller that gets cancelled, so a cancelled screen
		// cannot leave a failure in the cache or abort the load another caller is waiting for.
		let task = Task<Image?, Never> {
			let image = await load(url)
			if let image {
				images.setObject(Box(image), forKey: Self.key(for: url))
			} else {
				failedURLs.insert(url)
			}
			loadsInFlight[url] = nil
			return image
		}
		loadsInFlight[url] = task
		return await task.value
	}

	/// `nil` means "no answer to remember": still pending, or the caller left.
	private func resolution(of identity: NodeIdentity, policy: ImageWaitPolicy) async -> Resolution? {
		if let known = resolutions[identity] { return known }
		switch policy {
		case .noWait:
			// One read, no series: the caller wants what is there now (a hero that would rather show a
			// derived cover than wait a minute for the node's own picture).
			let outcome = Self.outcome(from: await readImage(identity), for: identity)
			switch outcome {
			case .resolved(let resolution):
				resolutions[identity] = resolution
				return resolution
			case .pending: return nil
			}
		case .waitForPending:
			return await waitForResolution(of: identity)
		}
	}

	/// Joins the retry series of `identity`, starting it if there is none. Cancelling the caller returns
	/// `nil` at once; the series goes on while another caller waits and stops at its next `pending` answer
	/// otherwise, so a screen left behind does not keep polling.
	private func waitForResolution(of identity: NodeIdentity) async -> Resolution? {
		let token = UUID()
		return await withTaskCancellationHandler {
			await withCheckedContinuation { (continuation: CheckedContinuation<Resolution?, Never>) in
				if Task.isCancelled { return continuation.resume(returning: nil) }
				if seriesInFlight[identity] == nil {
					seriesInFlight[identity] = Series()
					// Unstructured on purpose, like `image(at:)`: it outlives any single caller.
					Task { await runSeries(for: identity) }
				}
				seriesInFlight[identity]?.waiters[token] = continuation
			}
		} onCancel: {
			Task { await self.stopWaiting(token, for: identity) }
		}
	}

	private func stopWaiting(_ token: UUID, for identity: NodeIdentity) {
		seriesInFlight[identity]?.waiters.removeValue(forKey: token)?.resume(returning: nil)
	}

	private func runSeries(for identity: NodeIdentity) async {
		var reads = 0
		while true {
			reads += 1
			switch Self.outcome(from: await readImage(identity), for: identity) {
			case .resolved(let resolution):
				resolutions[identity] = resolution
				return finishSeries(of: identity, with: resolution)
			case .pending(let retryAfterSeconds):
				let someoneWaits = !(seriesInFlight[identity]?.waiters.isEmpty ?? true)
				guard reads < Self.maxPendingReads, someoneWaits else {
					return finishSeries(of: identity, with: nil)
				}
				let seconds = min(
					max(retryAfterSeconds ?? Self.defaultRetryAfterSeconds, Self.retryAfterRange.lowerBound),
					Self.retryAfterRange.upperBound)
				do { try await sleep(.seconds(seconds)) } catch { return finishSeries(of: identity, with: nil) }
			}
		}
	}

	private func finishSeries(of identity: NodeIdentity, with resolution: Resolution?) {
		let waiters = seriesInFlight.removeValue(forKey: identity)?.waiters ?? [:]
		for continuation in waiters.values { continuation.resume(returning: resolution) }
	}

	private static func outcome(from result: APIResult<ImageResponse>, for identity: NodeIdentity) -> Outcome {
		if case .success(let response, _) = result, response.slug == identity, response.isPending {
			return .pending(retryAfterSeconds: response.retryAfterSeconds)
		}
		return .resolved(resolution(from: result, for: identity))
	}

	private static func resolution(from result: APIResult<ImageResponse>, for identity: NodeIdentity)
		-> Resolution
	{
		guard case .success(let response, _) = result,
			response.slug == identity,
			let imageURL = response.imageURL,
			let url = URLValidation.publicHTTPSURL(from: imageURL.absoluteString)
		else { return .unavailable }
		return .url(url)
	}

	private static func key(for url: URL) -> NSString {
		url.absoluteString as NSString
	}
}
