// @polsia:user-owned
import Foundation

enum MusicFullTrackAccess: String, Equatable {
    case available
    case proRequired = "pro_required"
    case rightsUnverified = "rights_unverified"
    case unavailable
    case unknown

    static func map(_ value: String?) -> MusicFullTrackAccess {
        guard let value, let state = MusicFullTrackAccess(rawValue: value) else { return .unknown }
        return state
    }

    func allowsPlayback(albumID: String?) -> Bool {
        self == .available && !(albumID?.isEmpty ?? true)
    }

    var localizedLabel: String {
        switch self {
        case .available:
            "Ascolto integrale autorizzato con Solco Pro"
        case .proRequired:
            "Richiede Solco Pro attivo"
        case .rightsUnverified:
            "Fonte o diritti Solco non verificati"
        case .unavailable:
            "Ascolto integrale non disponibile"
        case .unknown:
            "Verifica temporaneamente non disponibile"
        }
    }
}
