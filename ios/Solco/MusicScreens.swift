// @polsia:user-owned
import SwiftUI

struct PlayerLandingView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var collections: [MusicCollection] = []
    @State private var playlistName = ""
    @State private var selectedVideoID: String?
    @State private var isLoading = true
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("LA TUA MUSICA")
                        .font(.caption.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(SolcoPalette.aqua)
                    Text("Raccolte")
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                    Text("Preferiti e playlist restano associati al tuo account. Le raccolte possono contenere Audius e YouTube.")
                        .font(.subheadline)
                        .lineSpacing(4)
                        .foregroundStyle(SolcoPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                createPlaylist

                if let message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(SolcoPalette.aqua)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if isLoading {
                    ProgressView("Caricamento raccolte…")
                        .tint(SolcoPalette.lime)
                        .frame(maxWidth: .infinity, minHeight: 90)
                } else if collections.isEmpty {
                    stateCard("Accedi per aprire le raccolte", body: "Le raccolte vengono caricate dal tuo account Solco.")
                } else {
                    ForEach(collections) { collection in
                        collectionCard(collection)
                    }
                }
            }
            .frame(maxWidth: 820, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollIndicators(.hidden)
        .background(SolcoPalette.background)
        .navigationTitle("nav.player")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        // YouTube API policy: no invisible playback. Switching tab or opening another screen unmounts
        // the official player, whose web view is paused and emptied in `dismantleUIView`.
        .onDisappear { selectedVideoID = nil }
        .modifier(ClosesYouTubeWhenAudiusPlays(selectedVideoID: $selectedVideoID))
    }

    private var createPlaylist: some View {
        HStack(spacing: 10) {
            TextField("Nome playlist", text: $playlistName)
                .textInputAutocapitalization(.sentences)
                .padding(.horizontal, 13)
                .frame(minHeight: 46)
                .background(SolcoPalette.elevated, in: RoundedRectangle(cornerRadius: 12))
            Button {
                Task { await submitNewPlaylist() }
            } label: {
                Image(systemName: "plus")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(SolcoPalette.ink)
                    .frame(width: 46, height: 46)
                    .background(SolcoPalette.lime, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(playlistName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel(Text("Crea playlist"))
        }
    }

    private func collectionCard(_ collection: MusicCollection) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(collection.name)
                        .font(.system(.title3, design: .rounded).weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                    Text(collection.kind == "favorites" ? "BRANI SALVATI" : "\(collection.items.count) ELEMENTI")
                        .font(.caption.weight(.bold))
                        .tracking(1.3)
                        .foregroundStyle(SolcoPalette.aqua)
                }
                Spacer()
                if collection.kind == "playlist" {
                    Button {
                        Task { await mutate(["action": "delete_playlist", "collectionId": collection.id]) }
                    } label: {
                        Image(systemName: "trash")
                            .foregroundStyle(SolcoPalette.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Elimina playlist \(collection.name)"))
                }
            }

            if collection.items.isEmpty {
                Text("Questa raccolta non contiene ancora brani.")
                    .font(.subheadline)
                    .foregroundStyle(SolcoPalette.muted)
                    .padding(.vertical, 8)
            } else {
                ForEach(collection.items) { item in
                    collectionItem(item, in: collection)
                }
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17).stroke(SolcoPalette.border, lineWidth: 1))
    }

    @ViewBuilder
    private func collectionItem(_ item: MusicCollectionItem, in collection: MusicCollection) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 11) {
                cover(item.artworkUrl, title: item.title ?? "Video YouTube salvato")
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.source == "youtube" ? "YouTube" : "Solco · Audius")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(SolcoPalette.aqua)
                    Text(item.title ?? "Video YouTube salvato")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(item.creatorName ?? (item.source == "youtube" ? "Metadati aggiornabili dalla ricerca" : Copy.unknownArtist))
                        .font(.caption)
                        .foregroundStyle(SolcoPalette.muted)
                        .lineLimit(1)
                    if item.source == "audius", let artist = item.artistUrl, let url = URL(string: artist) {
                        Link("Profilo artista Audius", destination: url)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(SolcoPalette.aqua)
                    }
                }
                Spacer(minLength: 0)
                Button {
                    Task { await remove(collectionID: collection.id, itemID: item.id) }
                } label: {
                    Image(systemName: "xmark")
                        .foregroundStyle(SolcoPalette.muted)
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Rimuovi \(item.title ?? "elemento")"))
            }

            if item.source == "audius" {
                Text("Le raccolte conservano i metadati. L’ascolto integrale parte dalla scheda album dopo le verifiche Solco Pro e dei diritti.")
                    .font(.caption)
                    .foregroundStyle(SolcoPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                WithAudiusPlayer { audio in
                    Button {
                        if selectedVideoID == item.sourceId {
                            selectedVideoID = nil
                        } else {
                            // One audio at a time: opening the YouTube player pauses Audius.
                            audio.pause()
                            selectedVideoID = item.sourceId
                        }
                    } label: {
                        Label(
                            selectedVideoID == item.sourceId ? "Chiudi player YouTube" : "Apri player YouTube ufficiale",
                            systemImage: "play.rectangle"
                        )
                        .frame(maxWidth: .infinity, minHeight: 42)
                    }
                    .buttonStyle(SolcoSecondaryButtonStyle())
                }
                if selectedVideoID == item.sourceId {
                    if scenePhase == .active {
                        YouTubeOfficialPlayer(videoID: item.sourceId)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Player YouTube sospeso quando Solco è in background.")
                            .font(.footnote)
                            .foregroundStyle(SolcoPalette.muted)
                    }
                }
            }
        }
        .padding(.top, 9)
        .overlay(alignment: .top) {
            Rectangle().fill(SolcoPalette.border).frame(height: 1)
        }
    }

    private func cover(_ artworkURL: String?, title: String) -> some View {
        Group {
            if let artworkURL, let url = URL(string: artworkURL) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    coverFallback
                }
            } else {
                coverFallback
            }
        }
        .frame(width: 54, height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .accessibilityLabel(Text("Copertina: \(title)"))
    }

    private var coverFallback: some View {
        Image(systemName: "waveform")
            .foregroundStyle(SolcoPalette.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(SolcoPalette.elevated)
    }

    private func stateCard(_ title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).foregroundStyle(SolcoPalette.foreground)
            Text(body).font(.subheadline).foregroundStyle(SolcoPalette.muted)
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 16))
    }

    @MainActor
    private func reload() async {
        isLoading = true
        do {
            collections = try await APIClient.shared.collections().collections
            message = nil
        } catch SolcoAPIError.unauthorized {
            collections = []
            message = "Accedi dalla scheda Account per usare le raccolte."
        } catch {
            collections = []
            message = error.localizedDescription
        }
        isLoading = false
    }

    @MainActor
    private func submitNewPlaylist() async {
        let value = playlistName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        await mutate(["action": "create_playlist", "name": value])
        playlistName = ""
    }

    @MainActor
    private func remove(collectionID: String, itemID: String) async {
        await mutate(["action": "remove_item", "collectionId": collectionID, "itemId": itemID])
    }

    @MainActor
    private func mutate(_ payload: [String: String]) async {
        do {
            collections = try await APIClient.shared.mutateCollections(payload).collections
            message = "Raccolte aggiornate."
        } catch SolcoAPIError.unauthorized {
            message = "Accedi dalla scheda Account per aggiornare le raccolte."
        } catch {
            message = error.localizedDescription
        }
    }
}

/// One audio at a time: closes the screen's YouTube player as soon as Audius starts playing (mini-player,
/// headset, AirPods). The modifier observes the shared player on its own: the player publishes its progress
/// twice a second, and only this modifier's body re-runs then, not the screen it is attached to.
struct ClosesYouTubeWhenAudiusPlays: ViewModifier {
    @EnvironmentObject private var audio: AudiusMusicPlayer
    @Binding private var selectedVideoID: String?

    init(selectedVideoID: Binding<String?>) {
        _selectedVideoID = selectedVideoID
    }

    func body(content: Content) -> some View {
        content.onChange(of: audio.isPlaying) {
            if audio.isPlaying { selectedVideoID = nil }
        }
    }
}

/// Hands the shared Audius player to a small piece of UI (a button that pauses or stops it), so the screen
/// around it does not observe the player: only this view re-renders when the player publishes its progress.
struct WithAudiusPlayer<Content: View>: View {
    @EnvironmentObject private var audio: AudiusMusicPlayer
    private let content: (AudiusMusicPlayer) -> Content

    init(@ViewBuilder content: @escaping (AudiusMusicPlayer) -> Content) {
        self.content = content
    }

    var body: some View {
        content(audio)
    }
}

struct AudiusAlbumDetailView: View {
    let album: AudiusAlbum

    @EnvironmentObject private var audio: AudiusMusicPlayer
    @State private var detail: AudiusAlbumDetail?
    @State private var isLoading = true
    @State private var isUnavailable = false

    private var shownAlbum: AudiusAlbum { detail?.album ?? album }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 16) {
                    albumArtwork(shownAlbum.artworkUrl)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("ALBUM · AUDIUS")
                            .font(.caption.weight(.bold))
                            .tracking(1.7)
                            .foregroundStyle(SolcoPalette.aqua)
                        Text(shownAlbum.title)
                            .font(.system(.title, design: .rounded).weight(.semibold))
                            .foregroundStyle(SolcoPalette.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(shownAlbum.artistName ?? Copy.unknownArtist)
                            .font(.subheadline)
                            .foregroundStyle(SolcoPalette.muted)
                        if let date = shownAlbum.releaseDate {
                            Text("Uscita · \(date)")
                                .font(.caption)
                                .foregroundStyle(SolcoPalette.muted)
                        }
                        if let url = URL(string: shownAlbum.albumUrl) {
                            Link("Scheda originale su Audius", destination: url)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(SolcoPalette.aqua)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(alignment: .firstTextBaseline) {
                    Text("Tracklist")
                        .font(.system(.title2, design: .rounded).weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                    Spacer()
                    Text("Diritti ricontrollati a ogni ascolto")
                        .font(.caption)
                        .foregroundStyle(SolcoPalette.muted)
                        .multilineTextAlignment(.trailing)
                }

                if isLoading {
                    ProgressView("Caricamento dal catalogo…")
                        .tint(SolcoPalette.lime)
                        .frame(maxWidth: .infinity, minHeight: 90)
                } else if isUnavailable {
                    stateCard("Album non disponibile", body: "Il catalogo non ha restituito metadati e tracklist verificabili. Solco non aggiunge brani sostitutivi.")
                } else if let detail, detail.tracks.isEmpty {
                    stateCard("Tracklist non disponibile", body: "Audius non ha restituito brani per questo album.")
                } else if let detail {
                    ForEach(Array(detail.tracks.enumerated()), id: \.element.id) { index, track in
                        trackRow(track, number: index + 1, queue: detail.tracks)
                    }
                }
            }
            .frame(maxWidth: 820, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollIndicators(.hidden)
        .background(SolcoPalette.background)
        .navigationTitle(shownAlbum.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: album.id) { await loadAlbum() }
    }

    private func trackRow(_ track: AudiusTrack, number: Int, queue: [AudiusTrack]) -> some View {
        HStack(spacing: 12) {
            Text(String(format: "%02d", number))
                .font(.caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(SolcoPalette.muted)
            VStack(alignment: .leading, spacing: 4) {
                Text(track.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SolcoPalette.foreground)
                    .lineLimit(2)
                Text(track.displayArtist)
                    .font(.caption)
                    .foregroundStyle(SolcoPalette.muted)
                Text(track.fullTrackAccess.localizedLabel)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(track.canPlayFullTrack ? SolcoPalette.aqua : SolcoPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            if track.canPlayFullTrack {
                Button {
                    Task {
                        if audio.currentTrack?.id == track.id && audio.currentTrack?.albumId == track.albumId {
                            await audio.togglePlayback()
                        } else {
                            await audio.play(track: track, queue: queue)
                        }
                    }
                } label: {
                    Image(systemName: audio.currentTrack?.id == track.id && audio.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(SolcoPalette.ink)
                        .frame(width: 42, height: 42)
                        .background(SolcoPalette.lime, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Ascolta \(track.title)"))
                .disabled(audio.isLoading)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(SolcoPalette.border, lineWidth: 1))
    }

    private func albumArtwork(_ urlString: String?) -> some View {
        Group {
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() }
                    else { albumArtworkFallback }
                }
            } else {
                albumArtworkFallback
            }
        }
        .frame(width: 146, height: 146)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityLabel(Text("Copertina di \(shownAlbum.title)"))
    }

    private var albumArtworkFallback: some View {
        Image(systemName: "waveform")
            .font(.system(size: 38, weight: .light))
            .foregroundStyle(SolcoPalette.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(SolcoPalette.elevated)
    }

    private func stateCard(_ title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.headline).foregroundStyle(SolcoPalette.foreground)
            Text(body).font(.subheadline).foregroundStyle(SolcoPalette.muted)
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 16))
    }

    @MainActor
    private func loadAlbum() async {
        isLoading = true
        isUnavailable = false
        do {
            detail = try await APIClient.shared.album(albumID: album.id)
        } catch is CancellationError {
            return
        } catch {
            detail = nil
            isUnavailable = true
        }
        isLoading = false
    }
}
