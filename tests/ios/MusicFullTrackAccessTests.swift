// @polsia:user-owned
import Foundation

@main
enum MusicFullTrackAccessTests {
    static func main() {
        precondition(MusicFullTrackAccess.map("available") == .available)
        precondition(MusicFullTrackAccess.map("pro_required") == .proRequired)
        precondition(MusicFullTrackAccess.map("rights_unverified") == .rightsUnverified)
        precondition(MusicFullTrackAccess.map("unavailable") == .unavailable)
        precondition(MusicFullTrackAccess.map("future_state") == .unknown)
        precondition(MusicFullTrackAccess.map(nil) == .unknown)
        precondition(MusicFullTrackAccess.available.allowsPlayback(albumID: "album-71"))
        precondition(!MusicFullTrackAccess.available.allowsPlayback(albumID: nil))
        precondition(!MusicFullTrackAccess.proRequired.allowsPlayback(albumID: "album-71"))
        precondition(!MusicFullTrackAccess.rightsUnverified.allowsPlayback(albumID: "album-71"))
        precondition(!MusicFullTrackAccess.unavailable.allowsPlayback(albumID: "album-71"))
        print("MusicFullTrackAccess mapping: passed")
    }
}
