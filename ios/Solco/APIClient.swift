// @polsia:user-owned
import Foundation

enum SolcoAPIError: Error {
    case notConfigured
    case invalidAddress
    case unauthorized
    case unavailable
    case requestFailed
}

extension SolcoAPIError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .notConfigured: String(localized: "connection.notConfigured")
        case .invalidAddress: String(localized: "connection.invalidAddress")
        case .unauthorized: String(localized: "connection.sessionExpired")
        case .unavailable: String(localized: "connection.unavailable")
        case .requestFailed: String(localized: "connection.unavailable")
        }
    }
}

final class APIClient {
    static let shared = APIClient()

    private let session: URLSession

    private var baseURL: URL? {
        guard let rawValue = Bundle.main.object(forInfoDictionaryKey: "SOLCO_API_BASE_URL") as? String else {
            return nil
        }
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("$("), let url = URL(string: value) else { return nil }
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let localHost = host == "localhost" || host == "127.0.0.1"
        guard scheme == "https" || (scheme == "http" && localHost) else { return nil }
        guard url.path.isEmpty || url.path == "/", url.user == nil, url.password == nil else { return nil }
        return url
    }

    private init() {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = .shared
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    func get<Value: Decodable>(
        _ type: Value.Type,
        path: String,
        query: [URLQueryItem] = []
    ) async throws -> Value {
        var request = try makeRequest(path: path, query: query)
        request.httpMethod = "GET"
        return try decode(type, from: await sendAsync(request))
    }

    func searchMusic(_ term: String, source: String) async throws -> MusicSearchResponse {
        var query = [
            URLQueryItem(name: "source", value: source),
            URLQueryItem(name: "q", value: term),
        ]
        if source == "youtube" {
            query.append(URLQueryItem(name: "youtubeConsent", value: "accepted"))
        }
        return try await get(MusicSearchResponse.self, path: "/api/music/search", query: query)
    }

    func trending() async throws -> MusicTrendingResponse {
        try await get(MusicTrendingResponse.self, path: "/api/music/trending")
    }

    func album(albumID: String) async throws -> AudiusAlbumDetail {
        guard isCatalogID(albumID) else { throw SolcoAPIError.invalidAddress }
        return try await get(AudiusAlbumDetail.self, path: "/api/music/albums/\(albumID)")
    }

    func audiusPlayback(albumID: String, trackID: String) async throws -> AudiusPlaybackCheck {
        guard isCatalogID(albumID), isCatalogID(trackID) else { throw SolcoAPIError.invalidAddress }
        return try await get(
            AudiusPlaybackCheck.self,
            path: "/api/music/albums/\(albumID)/tracks/\(trackID)/playback"
        )
    }

    private func isCatalogID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }

    func collections() async throws -> MusicCollectionsResponse {
        try await get(MusicCollectionsResponse.self, path: "/api/music/collections")
    }

    func communityProfiles(role: String, offset: Int = 0) async throws -> CommunityDirectoryResponse {
        try await get(
            CommunityDirectoryResponse.self,
            path: "/api/community/profiles",
            query: [URLQueryItem(name: "role", value: role), URLQueryItem(name: "offset", value: String(offset))]
        )
    }

    func messagesInbox() async throws -> MessagesInboxResponse {
        try await get(MessagesInboxResponse.self, path: "/api/messages")
    }

    func messageThread(conversationID: String) async throws -> MessageThreadResponse {
        guard isCatalogID(conversationID) else { throw SolcoAPIError.invalidAddress }
        return try await get(MessageThreadResponse.self, path: "/api/messages/\(conversationID)")
    }

    func startConversation(profileID: String, content: String) async throws -> MessageMutationResponse {
        try await mutateMessage(
            path: "/api/messages",
            payload: ["profileId": profileID, "content": content]
        )
    }

    func sendMessage(conversationID: String, content: String) async throws -> MessageMutationResponse {
        guard isCatalogID(conversationID) else { throw SolcoAPIError.invalidAddress }
        return try await mutateMessage(
            path: "/api/messages/\(conversationID)",
            payload: ["content": content]
        )
    }

    private func mutateMessage(path: String, payload: [String: String]) async throws -> MessageMutationResponse {
        var request = try makeRequest(path: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(originHeader, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        return try decode(MessageMutationResponse.self, from: await sendAsync(request))
    }

    func mutateCollections(_ payload: [String: String]) async throws -> CollectionMutationResponse {
        var request = try makeRequest(path: "/api/music/collections")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(originHeader, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        return try decode(CollectionMutationResponse.self, from: await sendAsync(request))
    }

    func currentSession() async throws -> SignedInUser? {
        var request = try makeRequest(path: "/api/auth/get-session")
        request.httpMethod = "GET"
        let data = try await sendAsync(request)
        if String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "null" {
            return nil
        }
        return try decode(AuthSessionResponse.self, from: data).user
    }

    func signIn(email: String, password: String) async throws -> SignedInUser {
        try await authenticate(
            path: "/api/auth/sign-in/email",
            body: ["email": email, "password": password]
        )
    }

    func signUp(name: String, email: String, password: String) async throws -> SignedInUser {
        try await authenticate(
            path: "/api/auth/sign-up/email",
            body: ["name": name, "email": email, "password": password]
        )
    }

    func signOut() async throws {
        var request = try makeRequest(path: "/api/auth/sign-out")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(originHeader, forHTTPHeaderField: "Origin")
        _ = try await sendAsync(request)
    }

    func absoluteURL(path: String) throws -> URL {
        let request = try makeRequest(path: path)
        guard let url = request.url else { throw SolcoAPIError.invalidAddress }
        return url
    }

    func cookieHeader(for url: URL) -> String {
        HTTPCookieStorage.shared.cookies(for: url)?
            .map { "\($0.name)=\($0.value)" }
            .joined(separator: "; ") ?? ""
    }

    private func authenticate(path: String, body: [String: String]) async throws -> SignedInUser {
        var request = try makeRequest(path: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(originHeader, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        _ = try await sendAsync(request)
        guard let user = try await currentSession() else { throw SolcoAPIError.unauthorized }
        return user
    }

    private var originHeader: String {
        guard let baseURL, var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return ""
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url?.absoluteString ?? ""
    }

    private func makeRequest(path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        guard let baseURL else { throw SolcoAPIError.notConfigured }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw SolcoAPIError.invalidAddress
        }
        let split = URLComponents(string: path)
        guard let pathValue = split?.path, pathValue.hasPrefix("/") else {
            throw SolcoAPIError.invalidAddress
        }
        components.path = pathValue
        components.queryItems = query.isEmpty ? split?.queryItems : query
        guard let url = components.url else { throw SolcoAPIError.invalidAddress }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpShouldHandleCookies = true
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func sendAsync(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        try validate(response: response)
        return data
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw SolcoAPIError.unavailable
        }
    }

    private func validate(response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse else { throw SolcoAPIError.unavailable }
        if (200..<300).contains(response.statusCode) { return }
        if response.statusCode == 401 { throw SolcoAPIError.unauthorized }
        if response.statusCode >= 500 { throw SolcoAPIError.unavailable }
        throw SolcoAPIError.requestFailed
    }
}
