// @polsia:user-owned
import AVFoundation
import MediaPlayer
import SwiftUI
import WebKit

/// Native Audius player, built around Apple's media-app guidance:
/// - `isPlaying`, `isBuffering` and the Now Playing rate are read back from `AVPlayer.timeControlStatus`
///   (KVO), never set by hand: AVPlayer pauses by itself on interruptions (calls, Siri, alarms) and when
///   headphones, Bluetooth or CarPlay are removed;
/// - after an interruption playback resumes only if iOS reports `.shouldResume` and audio was playing
///   before; a removed audio route pauses for good;
/// - Solco Pro and the track rights are re-checked (`/playback`) before every start, every resume
///   (including the automatic one after a call) and every queue advance.
/// One instance lives for the whole app (`ContentView`'s `@StateObject`): the remote-command targets are
/// app-lifetime by design; the audio-session observers are removed if the instance is ever released.
@MainActor
final class AudiusMusicPlayer: ObservableObject {
    @Published private(set) var currentTrack: AudiusTrack?
    @Published private(set) var queue: [AudiusTrack] = []
    @Published private(set) var queueIndex = -1
    /// Mirrors AVPlayer: true while playing or buffering, false as soon as AVPlayer pauses.
    @Published private(set) var isPlaying = false
    /// True while AVPlayer waits for stream data (`.waitingToPlayAtSpecifiedRate`).
    @Published private(set) var isBuffering = false
    /// True while the Solco Pro/rights check of a start or resume is in flight.
    @Published private(set) var isLoading = false
    @Published private(set) var currentSeconds = 0.0
    @Published private(set) var durationSeconds = 0.0
    @Published private(set) var errorMessage: String?

    private var player: AVPlayer?
    private var timeControlObservation: NSKeyValueObservation?
    private var timeObserver: Any?
    /// The player `timeObserver` was added to: AVPlayer requires removal from that same player.
    private var timeObserverOwner: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private var failObserver: NSObjectProtocol?
    private var itemStatusObservation: NSKeyValueObservation?
    private let sessionObservers = NotificationTokens()
    private var commandsConfigured = false
    /// What the listener asked for. AVPlayer's own state can differ (interruption, unplug, buffering).
    private var playWhenReady = false
    private var resumeAfterInterruption = false
    /// Bumped by every start, resume, pause-while-loading and stop, so a slow `/playback` answer can
    /// never start a track the listener has already left.
    private var loadGeneration = 0
    /// Background task taken shortly before a track ends and held until the next one actually sounds, so
    /// the silent gap of a queue advance (rights check + new item + buffering) is covered from its start.
    private var advanceAssertion: BackgroundPlaybackAssertion?
    private var artwork: MPMediaItemArtwork?
    private var artworkTrackKey: String?
    private var artworkTask: Task<Void, Never>?

    init() {
        configureRemoteCommands()
        observeAudioSession()
        updateNowPlaying()
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

    /// Play/pause toggle used by the mini-player, the album rows and the headset/AirPods button.
    func togglePlayback() async {
        if isLoading {
            // Pressing the button while the next start is being verified cancels that start.
            pause()
        } else if let player, player.timeControlStatus != .paused {
            pause()
        } else {
            await resume()
        }
    }

    func pause() {
        haltPlayback()
        releaseSessionIfIdleInBackground()
    }

    private func haltPlayback() {
        playWhenReady = false
        resumeAfterInterruption = false
        if isLoading {
            // A pending start or resume must not produce sound after an explicit pause.
            loadGeneration += 1
            isLoading = false
        }
        endAdvanceAssertion()
        player?.pause()
        syncWithPlayer()
    }

    /// Resumes the current track after a fresh Solco Pro/rights check. Rebuilds the item (or the whole
    /// player after a media-services reset) when nothing is loaded.
    func resume() async {
        guard let track = currentTrack, !isLoading else { return }
        guard let player, player.currentItem != nil else {
            await playCurrent()
            return
        }
        let assertion = BackgroundPlaybackAssertion(name: "solco.audio.resume")
        defer { assertion.end() }
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        errorMessage = nil
        defer { if generation == loadGeneration { isLoading = false } }
        do {
            try await verifyAccess(for: track)
        } catch {
            guard generation == loadGeneration else { return }
            stopAfterAccessDenial("L’accesso Solco Pro o i diritti del brano non sono più verificati. Audio fermato.")
            return
        }
        guard generation == loadGeneration, player === self.player, player.currentItem != nil else { return }
        guard activateSession() else { return }
        playWhenReady = true
        player.play()
        syncWithPlayer()
    }

    /// Stops audio and forgets the queue (for sign-out or an account switch): clears Now Playing and lets
    /// the app that Solco interrupted resume its own audio.
    func stop() {
        loadGeneration += 1
        playWhenReady = false
        resumeAfterInterruption = false
        endAdvanceAssertion()
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        releaseObservers()
        artworkTask?.cancel()
        artworkTask = nil
        artwork = nil
        artworkTrackKey = nil
        queue = []
        queueIndex = -1
        currentTrack = nil
        isLoading = false
        currentSeconds = 0
        durationSeconds = 0
        errorMessage = nil
        syncWithPlayer()
        deactivateSession()
    }

    func previousTrack() {
        if currentSeconds > 3 || queueIndex <= 0 {
            seek(to: 0)
        } else {
            queueIndex -= 1
            Task { await playCurrent() }
        }
    }

    func nextTrack() {
        guard queueIndex + 1 < queue.count else {
            // End of the queue: stop on the last track, rewound, so a later Play starts it again
            // instead of hitting the end-of-item straight away. Other apps may resume their audio.
            haltPlayback()
            seek(to: 0)
            deactivateSession()
            return
        }
        queueIndex += 1
        Task { await playCurrent() }
    }

    func seek(to seconds: Double) {
        guard seconds.isFinite else { return }
        let bounded = max(0, min(seconds, durationSeconds > 0 ? durationSeconds : seconds))
        currentSeconds = bounded
        player?.seek(to: CMTime(seconds: bounded, preferredTimescale: 600)) { [weak self] finished in
            guard finished else { return }
            Task { @MainActor in self?.syncWithPlayer() }
        }
        updateNowPlaying()
    }

    private func playCurrent() async {
        guard queue.indices.contains(queueIndex) else { return }
        // With the screen locked the app only stays awake while it produces sound. Hold a background
        // task across the silent gap (rights check + new item) instead of letting iOS suspend us; a queue
        // advance is already covered by `advanceAssertion`, taken before the previous track ended.
        let assertion = BackgroundPlaybackAssertion(name: "solco.audio.load")
        defer { assertion.end() }
        loadGeneration += 1
        let generation = loadGeneration
        let track = queue[queueIndex]
        playWhenReady = false
        resumeAfterInterruption = false
        // Drop the previous item at once: its audio must never play under the new title.
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        releaseObservers()
        currentTrack = track
        isLoading = true
        currentSeconds = 0
        durationSeconds = Double(track.durationSeconds ?? 0)
        errorMessage = nil
        loadArtwork(for: track)
        syncWithPlayer()
        defer { if generation == loadGeneration { isLoading = false } }

        let streamURL: URL
        do {
            try await verifyAccess(for: track)
            streamURL = try APIClient.shared.absoluteURL(
                path: "/api/music/albums/\(track.albumId ?? "")/tracks/\(track.id)/stream"
            )
        } catch {
            guard generation == loadGeneration else { return }
            stopAfterAccessDenial("Il brano non è disponibile: Solco Pro, la fonte o i diritti non sono verificati.")
            return
        }
        // Another track was chosen (or pause pressed) while this one was being verified.
        guard generation == loadGeneration else { return }

        // Public AVURLAsset option: the Solco session cookie travels with every request of the stream.
        let cookies = HTTPCookieStorage.shared.cookies(for: streamURL) ?? []
        let asset = AVURLAsset(url: streamURL, options: [AVURLAssetHTTPCookiesKey: cookies])
        let item = AVPlayerItem(asset: asset)
        let activePlayer = player ?? makePlayer()
        player = activePlayer
        releaseObservers()
        activePlayer.replaceCurrentItem(with: item)
        observe(item: item, player: activePlayer)
        guard activateSession() else { return }
        playWhenReady = true
        activePlayer.play()
        syncWithPlayer()
    }

    private func verifyAccess(for track: AudiusTrack) async throws {
        guard track.canPlayFullTrack, let albumID = track.albumId else {
            throw SolcoAPIError.requestFailed
        }
        let trackID = track.id
        // Answer well inside the background-task budget; a timeout counts as "not verified".
        let timeoutNanoseconds: UInt64 = 15_000_000_000
        let allowed = try await withThrowingTaskGroup(of: Bool.self, returning: Bool.self) { group in
            group.addTask {
                try await APIClient.shared.audiusPlayback(albumID: albumID, trackID: trackID).allowed
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
                throw SolcoAPIError.unavailable
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw SolcoAPIError.unavailable }
            return first
        }
        guard allowed else { throw SolcoAPIError.requestFailed }
    }

    private func stopAfterAccessDenial(_ message: String) {
        loadGeneration += 1
        playWhenReady = false
        resumeAfterInterruption = false
        endAdvanceAssertion()
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        releaseObservers()
        isLoading = false
        currentSeconds = 0
        errorMessage = message
        syncWithPlayer()
        deactivateSession()
    }

    // MARK: - Player state

    private func makePlayer() -> AVPlayer {
        let newPlayer = AVPlayer()
        // Apple: observe timeControlStatus to follow the pauses AVPlayer makes on its own.
        timeControlObservation = newPlayer.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.syncWithPlayer() }
        }
        return newPlayer
    }

    /// Reads the real state back from AVPlayer and republishes it to the UI and to Now Playing.
    private func syncWithPlayer() {
        let status = player?.timeControlStatus ?? .paused
        let playing = status != .paused
        let buffering = status == .waitingToPlayAtSpecifiedRate
        // Sound is coming out again: the audio background mode keeps the app running from here.
        if status == .playing { endAdvanceAssertion() }
        if isPlaying != playing { isPlaying = playing }
        if isBuffering != buffering { isBuffering = buffering }
        if let player, player.currentItem != nil {
            let seconds = player.currentTime().seconds
            if seconds.isFinite { currentSeconds = max(0, seconds) }
        }
        updateNowPlaying()
    }

    private func observe(item: AVPlayerItem, player: AVPlayer) {
        let itemID = ObjectIdentifier(item)
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                if time.seconds.isFinite { self.currentSeconds = max(0, time.seconds) }
                // Now Playing extrapolates the elapsed time from the rate: refresh it only when the real
                // duration becomes known, not on every tick.
                if let itemDuration = self.player?.currentItem?.duration.seconds,
                   itemDuration.isFinite, itemDuration > 0,
                   abs(itemDuration - self.durationSeconds) > 0.5 {
                    self.durationSeconds = itemDuration
                    self.updateNowPlaying()
                }
                // Apple: request a background task "as early as possible", while the app still runs
                // for its audio, not once the track has already gone silent.
                if self.advanceAssertion == nil, self.playWhenReady, self.isCurrentItem(itemID),
                   self.queueIndex + 1 < self.queue.count,
                   self.durationSeconds > 0, time.seconds.isFinite,
                   self.durationSeconds - time.seconds < 10 {
                    self.advanceAssertion = BackgroundPlaybackAssertion(name: "solco.audio.advance")
                }
            }
        }
        timeObserverOwner = player
        // Both notifications may be posted on another thread; `queue: .main` delivers them on main.
        endObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handleItemEnded(itemID) }
        }
        failObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.failedToPlayToEndTimeNotification,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handlePlaybackFailure(itemID) }
        }
        itemStatusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] observedItem, _ in
            guard observedItem.status == .failed else { return }
            Task { @MainActor in self?.handlePlaybackFailure(itemID) }
        }
    }

    private func releaseObservers() {
        if let timeObserver, let timeObserverOwner { timeObserverOwner.removeTimeObserver(timeObserver) }
        timeObserver = nil
        timeObserverOwner = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
        failObserver = nil
        itemStatusObservation?.invalidate()
        itemStatusObservation = nil
    }

    private func endAdvanceAssertion() {
        advanceAssertion?.end()
        advanceAssertion = nil
    }

    private func isCurrentItem(_ itemID: ObjectIdentifier) -> Bool {
        guard let item = player?.currentItem else { return false }
        return ObjectIdentifier(item) == itemID
    }

    private func handleItemEnded(_ itemID: ObjectIdentifier) {
        guard isCurrentItem(itemID) else { return }
        nextTrack()
    }

    /// Stream lost mid-track (network, or the stream route refusing a lapsed Solco Pro session).
    private func handlePlaybackFailure(_ itemID: ObjectIdentifier) {
        guard isCurrentItem(itemID) else { return }
        stopAfterAccessDenial("Riproduzione interrotta: connessione o accesso Solco Pro non disponibili.")
    }

    // MARK: - Audio session

    /// `.playback` is not silenced by the Ring/Silent switch and, with UIBackgroundModes=audio, keeps
    /// playing in background. A busy session (call in progress) is not a rights problem, so it keeps
    /// the queue and the loaded item and only reports the error.
    private func activateSession() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            return true
        } catch {
            playWhenReady = false
            endAdvanceAssertion()
            errorMessage = "Audio occupato da una chiamata o da un’altra app. Riprova tra poco."
            syncWithPlayer()
            return false
        }
    }

    /// Called only after pausing: deactivating with running audio stops it and reports `isBusy`.
    private func deactivateSession(notifyOthers: Bool = true) {
        try? AVAudioSession.sharedInstance().setActive(false, options: notifyOthers ? .notifyOthersOnDeactivation : [])
    }

    /// Apple (interruptionNotification): a nonmixable `.playback` session that is not in use should be
    /// deactivated in the background. Otherwise iOS deactivates it when it suspends the app and posts a
    /// late `.began` once the app runs again — typically on the lock-screen Play that wakes it, which would
    /// cancel that very Play. Same end state as the system's own deactivation, so other apps are not
    /// notified (locking the phone with Solco paused must not restart someone else's audio). Never during
    /// an interruption that may still resume.
    private func releaseSessionIfIdleInBackground() {
        guard UIApplication.shared.applicationState == .background,
              !playWhenReady, !isLoading, !resumeAfterInterruption else { return }
        deactivateSession(notifyOthers: false)
    }

    private func observeAudioSession() {
        let center = NotificationCenter.default
        sessionObservers.add(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsRaw = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
            Task { @MainActor in self?.handleInterruption(typeRaw: typeRaw, optionsRaw: optionsRaw) }
        })
        sessionObservers.add(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.releaseSessionIfIdleInBackground() }
        })
        // Posted on a secondary thread; `queue: .main` moves the block to main.
        sessionObservers.add(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            Task { @MainActor in self?.handleRouteChange(reasonRaw: reasonRaw) }
        })
        sessionObservers.add(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handleMediaServicesReset() }
        })
    }

    private func handleInterruption(typeRaw: UInt?, optionsRaw: UInt) {
        guard let typeRaw, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            // The late `.began` iOS posts after deactivating the session of a suspended app cannot be told
            // apart on iOS 17 (`.appWasSuspended` is deprecated since iOS 16, "reason no longer present");
            // releaseSessionIfIdleInBackground prevents it instead.
            // AVPlayer has already paused itself. Remember whether audio was wanted, cancel any pending
            // start and keep the session active (Apple: do not deactivate on an interruption). A repeated
            // `.began` keeps a resume that is already pending.
            let wanted = playWhenReady || isLoading || resumeAfterInterruption
            haltPlayback()
            resumeAfterInterruption = wanted
        case .ended:
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            let shouldResume = options.contains(.shouldResume) && resumeAfterInterruption
            resumeAfterInterruption = false
            if shouldResume {
                // resume() re-checks Solco Pro and the rights before any sound comes out.
                Task { await resume() }
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(reasonRaw: UInt?) {
        guard let reasonRaw,
              AVAudioSession.RouteChangeReason(rawValue: reasonRaw) == .oldDeviceUnavailable else { return }
        // Headphones, Bluetooth or CarPlay removed: AVPlayer has paused; make it final so nothing restarts
        // on the loudspeaker. The session stays active in the foreground and is released in the background
        // (see releaseSessionIfIdleInBackground). A new device never starts playback.
        pause()
    }

    private func handleMediaServicesReset() {
        // Apple: rebuild the audio objects and the session configuration, but do not restart playback
        // until the listener asks. resume() rebuilds the player through playCurrent() when it is nil.
        loadGeneration += 1
        isLoading = false
        playWhenReady = false
        resumeAfterInterruption = false
        endAdvanceAssertion()
        releaseObservers()
        timeControlObservation?.invalidate()
        timeControlObservation = nil
        player = nil
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        syncWithPlayer()
    }

    // MARK: - Now Playing and remote commands

    private func updateNowPlaying() {
        let commands = MPRemoteCommandCenter.shared()
        guard let track = currentTrack else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            commands.playCommand.isEnabled = false
            commands.pauseCommand.isEnabled = false
            commands.togglePlayPauseCommand.isEnabled = false
            commands.nextTrackCommand.isEnabled = false
            commands.previousTrackCommand.isEnabled = false
            commands.changePlaybackPositionCommand.isEnabled = false
            return
        }
        // On iOS the lock screen reads the state from the rate (playbackState is macOS-only); the
        // elapsed time is extrapolated by the system from elapsed time + rate.
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.displayArtist,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentSeconds,
            MPNowPlayingInfoPropertyPlaybackRate: player?.timeControlStatus == .playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: max(queueIndex, 0),
            MPNowPlayingInfoPropertyPlaybackQueueCount: queue.count,
        ]
        if durationSeconds > 0 { info[MPMediaItemPropertyPlaybackDuration] = durationSeconds }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        commands.playCommand.isEnabled = true
        commands.pauseCommand.isEnabled = true
        commands.togglePlayPauseCommand.isEnabled = true
        commands.previousTrackCommand.isEnabled = true
        commands.nextTrackCommand.isEnabled = queueIndex + 1 < queue.count
        commands.changePlaybackPositionCommand.isEnabled = durationSeconds > 0 && player?.currentItem != nil
    }

    private func loadArtwork(for track: AudiusTrack) {
        let key = "\(track.albumId ?? "")/\(track.id)"
        guard key != artworkTrackKey else { return }
        artworkTrackKey = key
        artworkTask?.cancel()
        artworkTask = nil
        artwork = nil
        guard let raw = track.artworkUrl, let url = URL(string: raw), url.scheme?.lowercased() == "https" else {
            return
        }
        artworkTask = Task { [weak self] in
            guard let result = try? await URLSession.shared.data(from: url),
                  !Task.isCancelled,
                  let image = UIImage(data: result.0) else { return }
            guard let self, self.artworkTrackKey == key else { return }
            self.artwork = AudiusMusicPlayer.makeArtwork(image)
            self.updateNowPlaying()
        }
    }

    /// Built outside the main actor: MediaPlayer may call the request handler from a background queue.
    private nonisolated static func makeArtwork(_ image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }

    private func configureRemoteCommands() {
        guard !commandsConfigured else { return }
        commandsConfigured = true
        let center = MPRemoteCommandCenter.shared()
        // Play only plays and pause only pauses (Apple's model); the headset/AirPods button and some
        // car or Bluetooth controls send togglePlayPause.
        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                await self.resume()
            }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                await self.togglePlayback()
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
            let position = event.positionTime
            Task { @MainActor in self?.seek(to: position) }
            return .success
        }
        // Not offered: no podcast-style skips, scanning or speed control for music.
        let unsupported: [MPRemoteCommand] = [
            center.skipForwardCommand,
            center.skipBackwardCommand,
            center.seekForwardCommand,
            center.seekBackwardCommand,
            center.changePlaybackRateCommand,
        ]
        for command in unsupported {
            command.isEnabled = false
        }
    }
}

/// Owns block-based NotificationCenter observers and removes them when its owner is released. Kept
/// outside `AudiusMusicPlayer` so no main-actor state is touched from a nonisolated deinit (the target
/// builds in Swift 5 mode, without isolated deinit).
private final class NotificationTokens {
    private var tokens: [NSObjectProtocol] = []

    func add(_ token: NSObjectProtocol) {
        tokens.append(token)
    }

    deinit {
        for token in tokens {
            NotificationCenter.default.removeObserver(token)
        }
    }
}

/// UIKit background-task assertion held while the next track is verified and loaded, so iOS does not
/// suspend the app in the silent gap between two tracks (Apple: use a background task, never stream
/// silence). Queue advances take it a few seconds before the track ends and keep it until the next one is
/// `.playing`; user-initiated starts hold their own around the load. The expiration handler ends it, so
/// the app is never terminated for overrunning.
@MainActor
private final class BackgroundPlaybackAssertion {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    init(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            // Documented: the system calls this handler synchronously on the main thread.
            MainActor.assumeIsolated {
                guard let assertion = self else { return }
                assertion.end()
            }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
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
                            if audio.isLoading || audio.isBuffering {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(SolcoPalette.lime)
                            } else {
                                Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                            }
                        }
                        .accessibilityLabel(Text(audio.isPlaying || audio.isLoading ? "Pausa" : "Riprendi"))
                        Button(action: audio.nextTrack) {
                            Image(systemName: "forward.end.fill")
                        }
                        .disabled(audio.queueIndex + 1 >= audio.queue.count)
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

    /// SwiftUI removes this view whenever the app stops being active or the screen holding it goes away.
    /// Silence the iframe before the web view is released, so YouTube never keeps playing unseen
    /// (YouTube API policy: no background or audio-only playback).
    static func dismantleUIView(_ uiView: WKWebView, coordinator: ()) {
        uiView.pauseAllMediaPlayback(completionHandler: nil)
        uiView.stopLoading()
        uiView.loadHTMLString("", baseURL: nil)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: WKWebView, context: Context) -> CGSize? {
        let width = max(200, proposal.width ?? 320)
        return CGSize(width: width, height: max(200, width * 9 / 16))
    }
}
