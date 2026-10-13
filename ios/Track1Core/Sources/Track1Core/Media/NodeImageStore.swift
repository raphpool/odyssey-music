import Foundation

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

	private enum Resolution {
		case url(URL)
		case unavailable
	}

	private final class Box: Sendable {
		let image: Image
		init(_ image: Image) { self.image = image }
	}

	private let readImage: @Sendable (NodeIdentity) async -> APIResult<ImageResponse>
	private let load: @Sendable (URL) async -> Image?

	// `/image` answers are kept for the whole session, failures included: a redraw must not turn into a
	// request storm while the server is down.
	private var resolutions: [NodeIdentity: Resolution] = [:]
	private var resolutionsInFlight: [NodeIdentity: Task<Resolution, Never>] = [:]

	private let images = NSCache<NSString, Box>()
	private var failedURLs: Set<URL> = []
	private var loadsInFlight: [URL: Task<Image?, Never>] = [:]

	public init(
		readImage: @escaping @Sendable (NodeIdentity) async -> APIResult<ImageResponse>,
		load: @escaping @Sendable (URL) async -> Image?
	) {
		self.readImage = readImage
		self.load = load
		images.countLimit = Self.imageCountLimit
	}

	/// The image of `identity`, read through `/image`. `nil` when the answer is for another slug, carries no
	/// image URL, or the image cannot be loaded.
	public func image(for identity: NodeIdentity) async -> Image? {
		switch await resolution(of: identity) {
		case .url(let url): return await image(at: url)
		case .unavailable: return nil
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

	private func resolution(of identity: NodeIdentity) async -> Resolution {
		if let known = resolutions[identity] { return known }
		if let pending = resolutionsInFlight[identity] { return await pending.value }
		let readImage = self.readImage
		let task = Task<Resolution, Never> {
			let resolution = Self.resolution(from: await readImage(identity), for: identity)
			resolutions[identity] = resolution
			resolutionsInFlight[identity] = nil
			return resolution
		}
		resolutionsInFlight[identity] = task
		return await task.value
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
