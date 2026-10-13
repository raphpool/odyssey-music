import Foundation
import ImageIO
import Track1Core
import UIKit

/// Downloads one node image from an untrusted URL and decodes it at screen size.
///
/// Why a session of its own with a delegate: `URLSession` follows redirects by default, so an image host
/// could answer `302 -> http://169.254.169.254/` and have the phone fetch it. The initial URL and every
/// redirect target go through `URLValidation.publicHTTPSURL`; a refused redirect is never requested.
enum NodeImageLoader {
	static let maximumBodyBytes = 10 * 1024 * 1024
	static let maximumPixelSize = 600
	static let maximumResourceSeconds: TimeInterval = 30
	/// Decoding cost follows the pixel count, not the byte count: a small PNG can declare a huge bitmap.
	static let maximumSourcePixels = 50_000_000

	/// `nil` for an unsafe URL, a refused redirect, a non-2xx answer, a type other than `image/*`, a body
	/// over `maximumBodyBytes`, or bytes ImageIO cannot decode.
	static func load(url: URL, configuration: URLSessionConfiguration = .ephemeral) async -> UIImage? {
		guard let initial = URLValidation.publicHTTPSURL(from: url.absoluteString) else { return nil }
		guard let data = await download(initial, configuration: configuration) else { return nil }
		return downsampledImage(from: data)
	}

	private static func download(_ url: URL, configuration: URLSessionConfiguration) async -> Data? {
		let transfer = ImageTransfer(maximumBytes: maximumBodyBytes)
		// The per-request timeout is an idle timeout: without a resource timeout a host that trickles bytes
		// keeps the transfer alive for days. Work on a copy so the caller's configuration is left untouched.
		let bounded = (configuration.copy() as? URLSessionConfiguration) ?? configuration
		bounded.timeoutIntervalForResource = min(bounded.timeoutIntervalForResource, maximumResourceSeconds)
		let session = URLSession(configuration: bounded, delegate: transfer, delegateQueue: nil)
		defer { session.finishTasksAndInvalidate() }
		var request = URLRequest(url: url)
		request.timeoutInterval = 20
		let task = session.dataTask(with: request)
		// Not cancellable on purpose: the store runs loads in unstructured tasks that outlive their callers.
		return await withCheckedContinuation { continuation in
			transfer.begin(task, continuation: continuation)
		}
	}

	/// Decodes at most `maximumPixelSize` pixels on the long side, without ever allocating the full bitmap.
	/// A smaller image keeps its own size: the thumbnail API would otherwise scale it up.
	static func downsampledImage(from data: Data, maximumSourcePixels: Int = maximumSourcePixels) -> UIImage? {
		let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
		guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary),
			let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
			let width = properties[kCGImagePropertyPixelWidth] as? Int,
			let height = properties[kCGImagePropertyPixelHeight] as? Int,
			width > 0, height > 0, width * height <= maximumSourcePixels
		else { return nil }
		let thumbnailOptions: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceCreateThumbnailWithTransform: true,
			kCGImageSourceShouldCacheImmediately: true,
			kCGImageSourceThumbnailMaxPixelSize: min(max(width, height), maximumPixelSize),
		]
		guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary)
		else { return nil }
		return UIImage(cgImage: image)
	}
}

/// One download, driven by `URLSession` delegate callbacks. The lock guards the state shared between the
/// caller and the session queue.
private final class ImageTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
	private let lock = NSLock()
	private let maximumBytes: Int
	private var continuation: CheckedContinuation<Data?, Never>?
	private var buffer = Data()

	init(maximumBytes: Int) {
		self.maximumBytes = maximumBytes
	}

	func begin(_ task: URLSessionTask, continuation: CheckedContinuation<Data?, Never>) {
		lock.lock()
		self.continuation = continuation
		lock.unlock()
		task.resume()
	}

	/// Resumes the caller once. A later call (the cancellation we trigger ourselves ends in
	/// `didCompleteWithError`) finds no continuation and does nothing.
	private func finish(_ data: Data?) {
		lock.lock()
		let continuation = self.continuation
		self.continuation = nil
		lock.unlock()
		continuation?.resume(returning: data)
	}

	func urlSession(
		_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
	) {
		// Answering nil keeps the 3xx as the final response: it is not 2xx, so the download ends in `nil`
		// and the target was never requested.
		guard let target = request.url, URLValidation.publicHTTPSURL(from: target.absoluteString) != nil else {
			completionHandler(nil)
			return
		}
		completionHandler(request)
	}

	func urlSession(
		_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
		completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
	) {
		guard let http = response as? HTTPURLResponse,
			(200..<300).contains(http.statusCode),
			http.mimeType?.lowercased().hasPrefix("image/") == true,
			http.expectedContentLength <= Int64(maximumBytes)
		else {
			completionHandler(.cancel)
			finish(nil)
			return
		}
		completionHandler(.allow)
	}

	func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
		lock.lock()
		buffer.append(data)
		let isTooLarge = buffer.count > maximumBytes
		if isTooLarge { buffer = Data() }
		lock.unlock()
		if isTooLarge {
			dataTask.cancel()
			finish(nil)
		}
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		lock.lock()
		let body = buffer
		lock.unlock()
		finish(error == nil ? body : nil)
	}
}
