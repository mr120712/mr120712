// @polsia:user-owned
import SwiftUI

private enum MusicTab: String, CaseIterable {
    case audius
    case youtube

    var label: String { self == .audius ? "Solco" : "YouTube" }
}

private enum SearchContentState {
    case idle
    case loading
    case ready
    case unavailable(String)
}

struct DiscoveryView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: MusicTab = .audius
    @State private var query = ""
    @State private var submittedQuery = ""
    @State private var contentState: SearchContentState = .idle
    @State private var search: MusicSearchResponse?
    @State private var trending: MusicTrendingResponse?
    @State private var collections: [MusicCollection] = []
    @State private var selectedVideoID: String?
    @State private var youtubeConsent = false
    @State private var notice: String?

    private var requestKey: String { "\(tab.rawValue):\(submittedQuery):\(youtubeConsent)" }
    private var visibleTracks: [AudiusTrack] { search?.tracks ?? trending?.tracks ?? [] }
    private var visibleAlbums: [AudiusAlbum] { search?.albums ?? trending?.albums ?? [] }
    private var playlists: [MusicCollection] { collections.filter { $0.kind == "playlist" } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("DISCOVER · SOLCO")
                        .font(.caption.weight(.bold))
                        .tracking(2.2)
                        .foregroundStyle(SolcoPalette.aqua)
                    Text("Trova il tuo prossimo ascolto.")
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Esplora il catalogo Audius e i video musicali YouTube. L’ascolto integrale su Solco richiede diritti verificati e Solco Pro attivo.")
                        .font(.body)
                        .lineSpacing(4)
                        .foregroundStyle(SolcoPalette.muted)
                }

                searchField
                sourceTabs

                if tab == .youtube {
                    youtubeNotice
                }

                if let notice {
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(SolcoPalette.aqua)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.updatesFrequently)
                }

                content
            }
            .frame(maxWidth: 820, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollIndicators(.hidden)
        .background(SolcoPalette.background)
        .navigationTitle("nav.discover")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: requestKey) { await loadContent() }
        .task { await loadCollections() }
    }

    private var searchField: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(SolcoPalette.lime)
                .accessibilityHidden(true)
            TextField("Cerca un brano o un artista", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityLabel(Text("Cerca un brano o un artista"))
                .onSubmit { submitSearch() }
            Button(action: submitSearch) {
                Text("Cerca")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SolcoPalette.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 40)
                    .background(SolcoPalette.lime, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 58)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17).stroke(SolcoPalette.border, lineWidth: 1))
    }

    private var sourceTabs: some View {
        HStack(spacing: 8) {
            ForEach(MusicTab.allCases, id: \.rawValue) { item in
                Button {
                    tab = item
                    selectedVideoID = nil
                } label: {
                    Text(item.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(tab == item ? SolcoPalette.ink : SolcoPalette.muted)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(
                            tab == item ? SolcoPalette.lime : SolcoPalette.surface,
                            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                        )
                        .overlay(RoundedRectangle(cornerRadius: 13).stroke(SolcoPalette.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == item ? .isSelected : [])
            }
        }
        .padding(5)
        .background(SolcoPalette.elevated, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }

    private var youtubeNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("YouTube usa la propria API di ricerca e il player ufficiale. Il video resta visibile e può includere annunci.")
                .font(.footnote)
                .lineSpacing(3)
                .foregroundStyle(SolcoPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Accetto l’uso della YouTube Data API", isOn: $youtubeConsent)
                .font(.subheadline.weight(.medium))
                .tint(SolcoPalette.lime)
                .foregroundStyle(SolcoPalette.foreground)
        }
        .padding(14)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(SolcoPalette.border, lineWidth: 1))
    }

    @ViewBuilder
    private var content: some View {
        switch contentState {
        case .loading:
            ProgressView("Caricamento dalla fonte…")
                .tint(SolcoPalette.lime)
                .frame(maxWidth: .infinity, minHeight: 120)
        case .unavailable(let message):
            stateCard(title: "Fonte non disponibile", message: message)
        case .idle:
            if tab == .youtube, submittedQuery.isEmpty {
                stateCard(title: "Cerca su YouTube", message: "Inserisci un titolo o un artista per avviare la ricerca.")
            } else {
                EmptyView()
            }
        case .ready:
            if tab == .audius, submittedQuery.isEmpty {
                trendingSection
            } else if let search {
                if search.outcome == "unavailable" || search.outcome == "inactive" {
                    stateCard(title: "Ricerca non disponibile", message: search.sourceStatus.summary)
                } else if search.outcome == "no_results" && search.tracks.isEmpty && search.albums.isEmpty {
                    stateCard(title: "Nessun risultato", message: "La fonte non ha restituito corrispondenze per questa ricerca.")
                } else if tab == .audius {
                    audiusResults(search.tracks, albums: search.albums)
                } else {
                    youtubeResults(search.videos)
                }
            }
        }
    }

    private var trendingSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("AUDIUS · ADESSO")
                        .font(.caption.weight(.bold))
                        .tracking(1.8)
                        .foregroundStyle(SolcoPalette.aqua)
                    Text("Brani di tendenza")
                        .font(.system(.title2, design: .rounded).weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                }
                Spacer()
                Button {
                    Task { await loadTrending() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(SolcoPalette.lime)
                        .frame(width: 42, height: 42)
                        .background(SolcoPalette.surface, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Aggiorna tendenze"))
            }

            if let trending, trending.outcome == "unavailable" || trending.outcome == "inactive" {
                stateCard(title: "Tendenze non disponibili", message: trending.sourceStatus.summary)
            } else if visibleTracks.isEmpty && visibleAlbums.isEmpty {
                stateCard(title: "Nessun risultato disponibile", message: "Audius non ha restituito brani o album di tendenza.")
            } else {
                audiusResults(visibleTracks, albums: visibleAlbums)
            }
        }
    }

    private func audiusResults(_ tracks: [AudiusTrack], albums: [AudiusAlbum]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if !albums.isEmpty {
                sectionTitle("Album · Audius")
                ForEach(albums) { album in
                    NavigationLink {
                        AudiusAlbumDetailView(album: album)
                    } label: {
                        albumRow(album)
                    }
                    .buttonStyle(.plain)
                }
            }
            if !tracks.isEmpty {
                sectionTitle(submittedQuery.isEmpty ? "Brani · Solco" : "Brani · Audius")
                ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                    audiusRow(track, number: index + 1)
                }
            }
        }
    }

    private func albumRow(_ album: AudiusAlbum) -> some View {
        HStack(spacing: 12) {
            artwork(album.artworkUrl, label: album.title, size: 68)
            VStack(alignment: .leading, spacing: 4) {
                sourcePill("Album · Audius")
                Text(album.title)
                    .font(.headline)
                    .foregroundStyle(SolcoPalette.foreground)
                    .lineLimit(2)
                Text(album.artistName ?? Copy.unknownArtist)
                    .font(.subheadline)
                    .foregroundStyle(SolcoPalette.muted)
                    .lineLimit(1)
                if let trackCount = album.trackCount {
                    Text("\(trackCount) brani · Apri tracklist")
                        .font(.caption)
                        .foregroundStyle(SolcoPalette.aqua)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(SolcoPalette.muted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17).stroke(SolcoPalette.border, lineWidth: 1))
    }

    private func audiusRow(_ track: AudiusTrack, number: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                artwork(track.artworkUrl, label: track.title, size: 68)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Text(String(format: "%02d", number))
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(SolcoPalette.lime)
                        sourcePill("Solco · Audius")
                    }
                    Text(track.title)
                        .font(.headline)
                        .foregroundStyle(SolcoPalette.foreground)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(track.displayArtist)
                        .font(.subheadline)
                        .foregroundStyle(SolcoPalette.muted)
                        .lineLimit(1)
                    if let urlString = track.artistUrl, let url = URL(string: urlString) {
                        Link("Profilo artista Audius", destination: url)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(SolcoPalette.aqua)
                    }
                }
                Spacer(minLength: 0)
                Text("Apri album per verificare l’ascolto")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(SolcoPalette.muted)
                    .multilineTextAlignment(.trailing)
            }
            HStack(spacing: 8) {
                Button {
                    Task { await saveFavorite(source: "audius", sourceId: track.id) }
                } label: {
                    Label("Preferiti", systemImage: "heart")
                }
                .buttonStyle(SolcoSecondaryButtonStyle())
                playlistMenu(source: "audius", sourceId: track.id)
            }
            .font(.footnote.weight(.medium))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17).stroke(SolcoPalette.border, lineWidth: 1))
    }

    private func youtubeResults(_ videos: [YouTubeVideo]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Risultati · YouTube")
            ForEach(videos) { video in
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .center, spacing: 12) {
                        artwork(video.thumbnailUrl, label: video.title, size: 68)
                        VStack(alignment: .leading, spacing: 5) {
                            sourcePill("YouTube")
                            Text(video.title)
                                .font(.headline)
                                .foregroundStyle(SolcoPalette.foreground)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(video.channelTitle)
                                .font(.subheadline)
                                .foregroundStyle(SolcoPalette.muted)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    HStack(spacing: 8) {
                        Button {
                            selectedVideoID = selectedVideoID == video.videoId ? nil : video.videoId
                        } label: {
                            Label(
                                selectedVideoID == video.videoId ? "Chiudi player" : "Apri player YouTube ufficiale",
                                systemImage: "play.rectangle"
                            )
                        }
                        .buttonStyle(SolcoPrimaryButtonStyle())
                        .accessibilityHint(Text("Il video resta visibile e si ferma quando l’app passa in background."))
                        Button {
                            Task { await saveFavorite(source: "youtube", sourceId: video.videoId) }
                        } label: {
                            Label("Preferiti", systemImage: "heart")
                        }
                        .buttonStyle(SolcoSecondaryButtonStyle())
                        playlistMenu(source: "youtube", sourceId: video.videoId)
                    }
                    .font(.footnote.weight(.medium))

                    if selectedVideoID == video.videoId {
                        if scenePhase == .active {
                            YouTubeOfficialPlayer(videoID: video.videoId)
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Player YouTube sospeso mentre Solco è in background.")
                                .font(.footnote)
                                .foregroundStyle(SolcoPalette.muted)
                        }
                    }
                }
                .padding(14)
                .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 17).stroke(SolcoPalette.border, lineWidth: 1))
            }
        }
    }

    private func playlistMenu(source: String, sourceId: String) -> some View {
        Menu {
            if playlists.isEmpty {
                Text("Crea una playlist nella scheda Raccolte")
            } else {
                ForEach(playlists) { playlist in
                    Button(playlist.name) {
                        Task {
                            await mutateCollections([
                                "action": "add",
                                "collectionId": playlist.id,
                                "source": source,
                                "sourceId": sourceId,
                            ])
                        }
                    }
                }
            }
        } label: {
            Label("Playlist", systemImage: "text.badge.plus")
                .padding(.horizontal, 12)
                .frame(minHeight: 38)
                .background(SolcoPalette.elevated, in: RoundedRectangle(cornerRadius: 12))
        }
        .foregroundStyle(SolcoPalette.foreground)
    }

    private func artwork(_ urlString: String?, label: String, size: CGFloat) -> some View {
        Group {
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        artworkFallback
                    }
                }
            } else {
                artworkFallback
            }
        }
        .frame(width: size, height: size)
        .background(SolcoPalette.elevated)
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .accessibilityLabel(Text("Copertina: \(label)"))
    }

    private var artworkFallback: some View {
        Image(systemName: "waveform")
            .font(.system(size: 22, weight: .light))
            .foregroundStyle(SolcoPalette.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func sourcePill(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .tracking(0.8)
            .foregroundStyle(SolcoPalette.aqua)
            .lineLimit(1)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(.title3, design: .rounded).weight(.semibold))
            .foregroundStyle(SolcoPalette.foreground)
    }

    private func stateCard(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.headline)
                .foregroundStyle(SolcoPalette.foreground)
            Text(message)
                .font(.subheadline)
                .lineSpacing(3)
                .foregroundStyle(SolcoPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(SolcoPalette.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func submitSearch() {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        submittedQuery = value
        selectedVideoID = nil
    }

    @MainActor
    private func loadContent() async {
        contentState = .loading
        search = nil
        if submittedQuery.isEmpty {
            guard tab == .audius else {
                contentState = .idle
                return
            }
            await loadTrending()
            return
        }
        guard tab != .youtube || youtubeConsent else {
            contentState = .unavailable("Accetta l’uso della YouTube Data API prima di cercare su YouTube.")
            return
        }
        do {
            let response = try await APIClient.shared.searchMusic(submittedQuery, source: tab.rawValue)
            guard !Task.isCancelled else { return }
            search = response
            contentState = .ready
        } catch is CancellationError {
            return
        } catch {
            contentState = .unavailable(error.localizedDescription)
        }
    }

    @MainActor
    private func loadTrending() async {
        contentState = .loading
        do {
            let response = try await APIClient.shared.trending()
            guard !Task.isCancelled else { return }
            trending = response
            contentState = .ready
        } catch is CancellationError {
            return
        } catch {
            contentState = .unavailable(error.localizedDescription)
        }
    }

    @MainActor
    private func loadCollections() async {
        do {
            collections = try await APIClient.shared.collections().collections
        } catch {
            collections = []
        }
    }

    @MainActor
    private func saveFavorite(source: String, sourceId: String) async {
        await mutateCollections(["action": "favorite", "source": source, "sourceId": sourceId])
    }

    @MainActor
    private func mutateCollections(_ payload: [String: String]) async {
        do {
            collections = try await APIClient.shared.mutateCollections(payload).collections
            notice = "Salvato nelle raccolte del tuo account."
        } catch SolcoAPIError.unauthorized {
            notice = "Accedi dalla scheda Account per salvare elementi nelle raccolte."
        } catch {
            notice = "Impossibile aggiornare la raccolta. Riprova quando la fonte è disponibile."
        }
    }
}
// @polsia:user-owned
import SwiftUI

struct AccountView: View {
    @State private var user: SignedInUser?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("account.eyebrow")
                    .font(.caption.weight(.bold))
                    .tracking(2)
                    .foregroundStyle(SolcoPalette.aqua)
                Text("account.title")
                    .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                    .foregroundStyle(SolcoPalette.foreground)

                if isLoading {
                    ProgressView()
                        .tint(SolcoPalette.lime)
                        .accessibilityLabel(Text("common.loading"))
                } else if let user {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(user.name ?? user.email)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(SolcoPalette.foreground)
                        Text(user.email)
                            .font(.subheadline)
                            .foregroundStyle(SolcoPalette.muted)
                        Button {
                            Task { await signOut() }
                        } label: {
                            Text("account.signOut")
                                .frame(maxWidth: .infinity, minHeight: 48)
                        }
                        .buttonStyle(SolcoSecondaryButtonStyle())
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 18))
                } else {
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(SolcoPalette.muted)
                            .accessibilityAddTraits(.isStaticText)
                    }
                    AuthFormView { user in
                        self.user = user
                        errorMessage = nil
                    }
                }

                Text("account.securityNote")
                    .font(.footnote)
                    .lineSpacing(4)
                    .foregroundStyle(SolcoPalette.muted)
            }
            .frame(maxWidth: 620, alignment: .leading)
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(SolcoPalette.background)
        .navigationTitle("nav.account")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadSession() }
    }

    private func loadSession() async {
        isLoading = true
        do {
            user = try await APIClient.shared.currentSession()
            errorMessage = nil
        } catch {
            user = nil
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func signOut() async {
        isLoading = true
        do {
            try await APIClient.shared.signOut()
            user = nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

struct AuthFormView: View {
    let onAuthenticated: (SignedInUser) -> Void

    @State private var isCreatingAccount = false
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: AuthField?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(isCreatingAccount ? "auth.createTitle" : "auth.signInTitle")
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(SolcoPalette.foreground)

            if isCreatingAccount {
                TextField("auth.name", text: $name)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                    .focused($focusedField, equals: .name)
                    .authFieldStyle()
            }
            TextField("auth.email", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .email)
                .authFieldStyle()
            SecureField("auth.password", text: $password)
                .textContentType(isCreatingAccount ? .newPassword : .password)
                .focused($focusedField, equals: .password)
                .authFieldStyle()

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(SolcoPalette.muted)
                    .accessibilityAddTraits(.updatesFrequently)
            }

            Button {
                Task { await submit() }
            } label: {
                HStack(spacing: 9) {
                    if isSubmitting { ProgressView().tint(SolcoPalette.ink) }
                    Text(isCreatingAccount ? "auth.createAction" : "auth.signInAction")
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(SolcoPrimaryButtonStyle())
            .disabled(isSubmitting || email.isEmpty || password.isEmpty || (isCreatingAccount && name.isEmpty))

            Button {
                isCreatingAccount.toggle()
                errorMessage = nil
            } label: {
                Text(isCreatingAccount ? "auth.haveAccount" : "auth.needAccount")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(SolcoSecondaryButtonStyle())
            .disabled(isSubmitting)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(SolcoPalette.border, lineWidth: 1))
    }

    private func submit() async {
        isSubmitting = true
        errorMessage = nil
        do {
            let user: SignedInUser
            if isCreatingAccount {
                user = try await APIClient.shared.signUp(name: name, email: email, password: password)
            } else {
                user = try await APIClient.shared.signIn(email: email, password: password)
            }
            password = ""
            onAuthenticated(user)
        } catch {
            errorMessage = error.localizedDescription
        }
        isSubmitting = false
    }
}

private enum AuthField: Hashable {
    case name
    case email
    case password
}

private extension View {
    func authFieldStyle() -> some View {
        self
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(SolcoPalette.elevated, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(SolcoPalette.border, lineWidth: 1))
            .foregroundStyle(SolcoPalette.foreground)
    }
}
