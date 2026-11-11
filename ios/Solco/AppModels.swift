// @polsia:user-owned
import Foundation

enum SolcoSection: String, CaseIterable, Identifiable {
    case discover
    case community
    case messages
    case player
    case account

    var id: String { rawValue }

    var titleKey: String {
        switch self {
        case .discover: "nav.discover"
        case .community: "nav.community"
        case .messages: "nav.messages"
        case .player: "nav.player"
        case .account: "nav.account"
        }
    }

    var symbol: String {
        switch self {
        case .discover: "waveform"
        case .community: "person.2"
        case .messages: "bubble.left.and.bubble.right"
        case .player: "music.note.list"
        case .account: "person.crop.circle"
        }
    }
}

struct AudiusTrack: Decodable, Identifiable, Hashable {
    let provider: String
    let id: String
    let qualifiedId: String
    let title: String
    let artistName: String?
    let artistHandle: String?
    let artistId: String?
    let artistQualifiedId: String?
    let artistUrl: String?
    let trackUrl: String
    let artworkUrl: String?
    let durationSeconds: Int?
    let genre: String?
    let mood: String?
    let tags: String?
    let releaseDate: String?
    let license: String?
    let licensorName: String?
    let copyrightNotice: String?
    let producerCopyrightNotice: String?
    let attributionRemovalRequested: Bool
    let attributionComplete: Bool
    let playbackEligible: Bool
    let playbackReason: String
    var albumId: String? = nil
    var fullAccess: String? = nil

    var displayArtist: String { artistName ?? artistHandle ?? Copy.unknownArtist }
    var fullTrackAccess: MusicFullTrackAccess { MusicFullTrackAccess.map(fullAccess) }
    var canPlayFullTrack: Bool { fullTrackAccess.allowsPlayback(albumID: albumId) }
}

struct AudiusAlbum: Decodable, Identifiable, Hashable {
    let provider: String
    let id: String
    let qualifiedId: String
    let title: String
    let artistName: String?
    let artistUrl: String?
    let albumUrl: String
    let artworkUrl: String?
    let releaseDate: String?
    let trackCount: Int?
}

struct AudiusAlbumDetail: Decodable {
    let album: AudiusAlbum
    let tracks: [AudiusTrack]
}

struct YouTubeVideo: Decodable, Identifiable, Hashable {
    let provider: String
    let videoId: String
    let title: String
    let channelTitle: String
    let channelId: String?
    let description: String?
    let publishedAt: String?
    let thumbnailUrl: String?

    var id: String { videoId }
}

struct MusicSourceStatus: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let active: Bool
    let searchOutcome: String
    let unavailableReason: String?
    let blockers: [String]?
    let retryAfterSeconds: Int?
    let summary: String
    let prerequisite: String
}

struct MusicSearchResponse: Decodable {
    let source: String
    let outcome: String
    let tracks: [AudiusTrack]
    let albums: [AudiusAlbum]
    let videos: [YouTubeVideo]
    let sourceStatus: MusicSourceStatus
}

struct MusicTrendingResponse: Decodable {
    let outcome: String
    let tracks: [AudiusTrack]
    let albums: [AudiusAlbum]
    let sourceStatus: MusicSourceStatus
}

struct AudiusPlaybackCheck: Decodable {
    let allowed: Bool
    let reason: String?
}

struct MusicCollectionItem: Decodable, Identifiable, Hashable {
    let id: String
    let source: String
    let sourceId: String
    let title: String?
    let creatorName: String?
    let artworkUrl: String?
    let sourceUrl: String?
    let artistUrl: String?
    let durationSeconds: Int?
    let createdAt: String
    let expiresAt: String?
}

struct MusicCollection: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let kind: String
    let createdAt: String
    let items: [MusicCollectionItem]
}

struct MusicCollectionsResponse: Decodable {
    let collections: [MusicCollection]
}

struct CollectionMutationResponse: Decodable {
    let collections: [MusicCollection]
    let message: String?
}

struct SignedInUser: Decodable, Identifiable {
    let id: String
    let email: String
    let name: String?
}

struct AuthSessionResponse: Decodable {
    let user: SignedInUser
}

struct CommunityProfileSummary: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let role: String
    let isFollowing: Bool

    var roleLabel: String { role == "artist" ? "Artista" : "Fan" }
}

struct CommunityDirectoryResponse: Decodable {
    let profiles: [CommunityProfileSummary]
    let nextOffset: Int?
}

struct MessageItem: Decodable, Identifiable, Hashable {
    let id: String
    let senderId: String
    let content: String
    let createdAt: String
}

struct MessageConversationSummary: Decodable, Identifiable, Hashable {
    struct Participant: Decodable, Hashable {
        let id: String
        let name: String
        let role: String

        var roleLabel: String { role == "artist" ? "Artista" : "Fan" }
    }

    struct Preview: Decodable, Hashable {
        let content: String
        let createdAt: String
    }

    let id: String
    let participant: Participant
    let lastMessage: Preview
}

struct MessagesInboxResponse: Decodable {
    let conversations: [MessageConversationSummary]
}

struct MessageThreadResponse: Decodable {
    let currentUserId: String
    let conversation: MessageThreadConversation
    let messages: [MessageItem]
}

struct MessageThreadConversation: Decodable {
    let id: String
    let participant: MessageConversationSummary.Participant
}

struct MessageMutationResponse: Decodable {
    let conversationId: String
    let message: MessageItem
}

enum Copy {
    static let unknownArtist = String(localized: "common.unknownArtist")
}
