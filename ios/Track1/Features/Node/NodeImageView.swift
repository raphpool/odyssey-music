import SwiftUI
import UIKit

struct NodeImageView: View {
	let type: NodeType
	let name: String
	let state: NodeImageState
	let session: URLSession

	var body: some View {
		Group {
			switch state {
			case .loading:
				ProgressView()
					.frame(width: 96, height: 96)
					.accessibilityLabel("Chargement de l’image de \(name)")
			case .available(let url):
				NodeRemoteImage(url: url, name: name, session: session, placeholder: placeholder)
			case .unavailable:
				placeholder
			}
		}
		.clipShape(
			type == .artist
				? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: Track1Theme.artworkCornerRadius)))
	}

	private var placeholder: some View {
		Image(systemName: "music.note")
			.font(.title)
			.foregroundStyle(Track1Theme.actionTint)
			.frame(width: 96, height: 96)
			.background(Track1Theme.sectionSurface)
			.accessibilityLabel("Image indisponible pour \(name)")
			.accessibilityIdentifier("node-image-unavailable")
	}
}

private struct NodeRemoteImage<Placeholder: View>: View {
	let url: URL
	let name: String
	let session: URLSession
	let placeholder: Placeholder
	@State private var phase = RemoteImagePhase.loading

	var body: some View {
		Group {
			switch phase {
			case .loading:
				ProgressView().accessibilityLabel("Chargement de l’image de \(name)")
			case .image(let image):
				Image(uiImage: image).resizable().scaledToFill().accessibilityLabel("Image de \(name)")
			case .unavailable:
				placeholder
			}
		}
		.frame(width: 96, height: 96)
		.task(id: url) { await loadImage() }
	}

	private func loadImage() async {
		guard URLValidation.publicHTTPSURL(from: url.absoluteString) == url else {
			phase = .unavailable
			return
		}
		phase = .loading
		guard let image = await NodeImageLoader.load(url: url, session: session), !Task.isCancelled else {
			if !Task.isCancelled { phase = .unavailable }
			return
		}
		phase = .image(image)
	}
}

enum NodeImageLoader {
	static func load(url: URL, session: URLSession) async -> UIImage? {
		guard URLValidation.publicHTTPSURL(from: url.absoluteString) == url else { return nil }
		let safeSession = URLSession(
			configuration: session.configuration,
			delegate: SafeImageRedirectDelegate.shared,
			delegateQueue: nil
		)
		defer { safeSession.finishTasksAndInvalidate() }
		do {
			let (data, response) = try await safeSession.data(for: URLRequest(url: url))
			guard let httpResponse = response as? HTTPURLResponse,
				(200...299).contains(httpResponse.statusCode)
			else { return nil }
			return UIImage(data: data)
		} catch { return nil }
	}
}

private final class SafeImageRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
	static let shared = SafeImageRedirectDelegate()

	func urlSession(
		_ session: URLSession,
		task: URLSessionTask,
		willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest,
		completionHandler: @escaping (URLRequest?) -> Void
	) {
		guard let redirectURL = request.url,
			URLValidation.publicHTTPSURL(from: redirectURL.absoluteString) == redirectURL
		else {
			completionHandler(nil)
			task.cancel()
			return
		}
		completionHandler(request)
	}
}

private enum RemoteImagePhase {
	case loading
	case image(UIImage)
	case unavailable
}
