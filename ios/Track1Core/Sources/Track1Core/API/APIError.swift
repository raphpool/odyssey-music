import Foundation

enum APIError: Error, Equatable, Sendable {
	case cancelled
	case timeout
	case network
	case invalidResponse
	case invalidRequest
	case http(status: Int, code: String?, retryable: Bool?, retryAfterSeconds: Int?)
}

enum APIResult<Value: Sendable>: Sendable {
	case success(Value, etag: String?)
	case notModified(etag: String)
	case failure(APIError)
}

extension APIResult {
	var value: Value? {
		guard case .success(let value, _) = self else { return nil }
		return value
	}
}
