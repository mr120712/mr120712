// @polsia:user-owned
import AVFoundation
import MediaPlayer
import SwiftUI
import WebKit

@MainActor
final class AudiusMusicPlayer: ObservableObject {
    @Published private(set) var currentTrack: AudiusTrack?
    @Published private(set) var queue: [AudiusTrack] = []
    @Published private(set) var queueIndex = -1
    @Published private(set) var isPlaying = false
    @Published private(set) var isLoading = false
    @Published private(set) var currentSeconds = 0.0
    @Published private(set) var durationSeconds = 0.0
    @Published private(set) var errorMessage: String?

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var commandsConfigured = false

    init() {
        configureRemoteCommands()
    }

    func play(track: AudiusTrack, queue tracks: [AudiusTrack]) async {
        guard track.canPlayFullTrack else {
            stopAfterAccessDenial("Apri la scheda album: Solco Pro e i diritti devono essere verificati per il brano.")
            return
        }
        var nextQueue = tracks.filter(\.canPlayFullTrack)
        var index = nextQueue.firstIndex(where: { $0.id == track.id })
        if index == nil {
            nextQueue.insert(track, at: 0)
            index = 0
        }
        queue = nextQueue
        queueIndex = index ?? 0
        await playCurrent()
    }

    func togglePlayback() async {
        guard let player else { return }
        if isPlaying {
            player.pause()
            isPlaying = false
            updateNowPlaying()
        } else if let track = currentTrack {
            isLoading = true
            do {
                if player.currentItem == nil {
                    await playCurrent()
                    return
                }
                try await verifyAccess(for: track)
                player.play()
                isPlaying = true
                errorMessage = nil
                updateNowPlaying()
            } catch {
                stopAfterAccessDenial("L’accesso Solco Pro o i diritti del brano non sono più verificati. Audio fermato.")
            }
            isLoading = false
        }
    }

    func previousTrack() {
        if currentSeconds > 3 {
            seek(to: 0)
        } else if queueIndex > 0 {
            queueIndex -= 1
            Task { await playCurrent() }
        }
    }

    func nextTrack() {
        guard queueIndex + 1 < queue.count else {
            player?.pause()
            isPlaying = false
            updateNowPlaying()
            return
        }
        queueIndex += 1
        Task { await playCurrent() }
    }

    func seek(to seconds: Double) {
        guard seconds.isFinite else { return }
        let bounded = max(0, min(seconds, durationSeconds > 0 ? durationSeconds : seconds))
        player?.seek(to: CMTime(seconds: bounded, preferredTimescale: 600))
        currentSeconds = bounded
        updateNowPlaying()
    }

    private func playCurrent() async {
        guard queue.indices.contains(queueIndex) else { return }
        let track = queue[queueIndex]
        currentTrack = track
        isLoading = true
        isPlaying = false
        currentSeconds = 0
        durationSeconds = Double(track.durationSeconds ?? 0)
        errorMessage = nil
        releaseObservers()
        do {
            try await verifyAccess(for: track)
            let streamURL = try APIClient.shared.absoluteURL(
                path: "/api/music/albums/\(track.albumId ?? "")/tracks/\(track.id)/stream"
            )
            let cookie = APIClient.shared.cookieHeader(for: streamURL)
            let headers = cookie.isEmpty ? [:] : ["Cookie": cookie]
            let asset = AVURLAsset(url: streamURL, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
            let item = AVPlayerItem(asset: asset)
            let activePlayer = player ?? AVPlayer()
            player = activePlayer
            activePlayer.replaceCurrentItem(with: item)
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            observe(item: item, player: activePlayer)
            activePlayer.play()
            isPlaying = true
            updateNowPlaying()
        } catch {
            stopAfterAccessDenial("Il brano non è disponibile: Solco Pro, la fonte o i diritti non sono verificati.")
        }
        isLoading = false
    }

    private func verifyAccess(for track: AudiusTrack) async throws {
        guard track.canPlayFullTrack, let albumID = track.albumId else {
            throw SolcoAPIError.requestFailed
        }
        let verdict = try await APIClient.shared.audiusPlayback(albumID: albumID, trackID: track.id)
        guard verdict.allowed else { throw SolcoAPIError.requestFailed }
    }

    private func stopAfterAccessDenial(_ message: String) {
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        releaseObservers()
        isPlaying = false
        isLoading = false
        currentSeconds = 0
        errorMessage = message
        updateNowPlaying()
    }

    private func observe(item: AVPlayerItem, player: AVPlayer) {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                if time.seconds.isFinite { self.currentSeconds = max(0, time.seconds) }
                let itemDuration = item.duration.seconds
                if itemDuration.isFinite && itemDuration > 0 { self.durationSeconds = itemDuration }
                self.updateNowPlaying()
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.nextTrack() }
        }
    }

    private func releaseObservers() {
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
    }

    private func updateNowPlaying() {
        guard let track = currentTrack else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.displayArtist,
            MPMediaItemPropertyPlaybackDuration: durationSeconds,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentSeconds,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
    }

    private func configureRemoteCommands() {
        guard !commandsConfigured else { return }
        commandsConfigured = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                await self.togglePlayback()
            }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                self?.player?.pause()
                self?.isPlaying = false
                self?.updateNowPlaying()
            }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.nextTrack() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.previousTrack() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.seek(to: event.positionTime) }
            return .success
        }
    }
}

struct AudiusMiniPlayer: View {
    @EnvironmentObject private var audio: AudiusMusicPlayer

    var body: some View {
        Group {
            if let track = audio.currentTrack {
                VStack(spacing: 7) {
                    HStack(spacing: 11) {
                        Group {
                            if let artwork = track.artworkUrl, let url = URL(string: artwork) {
                                AsyncImage(url: url) { image in
                                    image.resizable().scaledToFill()
                                } placeholder: {
                                    coverFallback
                                }
                            } else {
                                coverFallback
                            }
                        }
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 9))

                        VStack(alignment: .leading, spacing: 3) {
                            Text(track.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(SolcoPalette.foreground)
                                .lineLimit(1)
                            Text(track.displayArtist)
                                .font(.caption)
                                .foregroundStyle(SolcoPalette.muted)
                                .lineLimit(1)
                            if let artist = track.artistUrl, let url = URL(string: artist) {
                                Link("Profilo Audius", destination: url)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(SolcoPalette.aqua)
                            }
                        }
                        Spacer(minLength: 3)
                        Button(action: audio.previousTrack) {
                            Image(systemName: "backward.end.fill")
                        }
                        .accessibilityLabel(Text("Brano precedente"))
                        Button {
                            Task { await audio.togglePlayback() }
                        } label: {
                            Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                        }
                        .accessibilityLabel(Text(audio.isPlaying ? "Pausa" : "Riprendi"))
                        Button(action: audio.nextTrack) {
                            Image(systemName: "forward.end.fill")
                        }
                        .accessibilityLabel(Text("Brano successivo"))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(SolcoPalette.lime)
                    Slider(
                        value: Binding(
                            get: { audio.currentSeconds },
                            set: { audio.seek(to: $0) }
                        ),
                        in: 0...max(audio.durationSeconds, 1)
                    )
                    .tint(SolcoPalette.lime)
                    .accessibilityLabel(Text("Avanzamento del brano"))
                    HStack {
                        Text(playerTime(audio.currentSeconds))
                        Spacer()
                        Text(playerTime(audio.durationSeconds))
                    }
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(SolcoPalette.muted)
                    DisclosureGroup("Coda · \(audio.queue.count)") {
                        ForEach(audio.queue) { queued in
                            Button {
                                Task { await audio.play(track: queued, queue: audio.queue) }
                            } label: {
                                HStack(spacing: 8) {
                                    Group {
                                        if let artwork = queued.artworkUrl, let url = URL(string: artwork) {
                                            AsyncImage(url: url) { image in
                                                image.resizable().scaledToFill()
                                            } placeholder: {
                                                coverFallback
                                            }
                                        } else {
                                            coverFallback
                                        }
                                    }
                                    .frame(width: 34, height: 34)
                                    .clipShape(RoundedRectangle(cornerRadius: 7))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(queued.title).lineLimit(1)
                                        Text(queued.displayArtist).lineLimit(1)
                                            .foregroundStyle(SolcoPalette.muted)
                                    }
                                    Spacer(minLength: 4)
                                }
                                .font(.caption)
                                .foregroundStyle(queued.id == audio.currentTrack?.id ? SolcoPalette.lime : SolcoPalette.muted)
                            }
                            .buttonStyle(.plain)
                            if let artist = queued.artistUrl, let url = URL(string: artist) {
                                Link("Profilo artista Audius", destination: url)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(SolcoPalette.aqua)
                            }
                        }
                    }
                    .font(.caption.weight(.medium))
                    .foregroundStyle(SolcoPalette.foreground)
                    if let errorMessage = audio.errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(SolcoPalette.aqua)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 9)
                .padding(.bottom, 6)
                .background(SolcoPalette.surface)
                .overlay(alignment: .top) {
                    Rectangle().fill(SolcoPalette.border).frame(height: 1)
                }
                .accessibilityElement(children: .contain)
            }
        }
    }

    private var coverFallback: some View {
        Image(systemName: "waveform")
            .foregroundStyle(SolcoPalette.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(SolcoPalette.elevated)
    }

    private func playerTime(_ seconds: Double) -> String {
        let value = max(0, Int(seconds.isFinite ? seconds : 0))
        return "\(value / 60):\(String(format: "%02d", value % 60))"
    }
}

struct YouTubeOfficialPlayer: UIViewRepresentable {
    let videoID: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.scrollView.isScrollEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor.black
        let escapedID = videoID.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{width:100%;height:100%;margin:0;background:#000;overflow:hidden}</style></head>
        <body><iframe width="100%" height="100%" src="https://www.youtube.com/embed/\(escapedID)?controls=1&playsinline=1" title="Player video YouTube" frameborder="0" allow="encrypted-media; web-share" allowfullscreen></iframe></body></html>
        """
        webView.loadHTMLString(html, baseURL: URL(string: "https://www.youtube.com"))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: WKWebView, context: Context) -> CGSize? {
        let width = max(200, proposal.width ?? 320)
        return CGSize(width: width, height: max(200, width * 9 / 16))
    }
}
