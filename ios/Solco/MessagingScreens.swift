// @polsia:user-owned
import SwiftUI

private enum CommunityRole: String, CaseIterable, Identifiable {
    case fan
    case artist

    var id: String { rawValue }
    var title: String { self == .fan ? "Fan" : "Artisti" }
}

struct CommunityView: View {
    @State private var role: CommunityRole = .fan
    @State private var profiles: [CommunityProfileSummary] = []
    @State private var nextOffset: Int?
    @State private var isLoading = true
    @State private var isLoadingMore = false
    @State private var errorMessage: String?
    @State private var selectedProfile: CommunityProfileSummary?
    @State private var queuedConversationID: String?
    @State private var activeConversation: ConversationReference?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("SOLCO · COMMUNITY")
                        .font(.caption.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(SolcoPalette.aqua)
                    Text("Trova la tua community.")
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                    Text("Apri un profilo e scrivi in privato a fan e artisti.")
                        .font(.subheadline)
                        .foregroundStyle(SolcoPalette.muted)
                }

                HStack(spacing: 8) {
                    ForEach(CommunityRole.allCases) { item in
                        Button {
                            role = item
                        } label: {
                            Text(item.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(role == item ? SolcoPalette.ink : SolcoPalette.muted)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(
                                    role == item ? SolcoPalette.lime : SolcoPalette.surface,
                                    in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(role == item ? .isSelected : [])
                    }
                }
                .padding(5)
                .background(SolcoPalette.elevated, in: RoundedRectangle(cornerRadius: 16))

                if isLoading {
                    ProgressView("Caricamento profili…")
                        .tint(SolcoPalette.lime)
                        .frame(maxWidth: .infinity, minHeight: 110)
                } else if let errorMessage {
                    messagingState(title: "Profili non disponibili", message: errorMessage) {
                        Task { await loadProfiles(append: false) }
                    }
                } else if profiles.isEmpty {
                    messagingState(
                        title: "Nessun profilo visibile",
                        message: "I profili pubblici di \(role.title.lowercased()) appariranno qui."
                    )
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(profiles) { profile in
                            Button {
                                selectedProfile = profile
                            } label: {
                                HStack(spacing: 13) {
                                    profileAvatar(profile.name)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(profile.name)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(SolcoPalette.foreground)
                                            .lineLimit(1)
                                        Text(profile.roleLabel)
                                            .font(.caption.weight(.medium))
                                            .foregroundStyle(SolcoPalette.muted)
                                    }
                                    Spacer(minLength: 4)
                                    Text("Messaggia")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(SolcoPalette.ink)
                                        .padding(.horizontal, 12)
                                        .frame(minHeight: 36)
                                        .background(SolcoPalette.lime, in: Capsule())
                                }
                                .padding(13)
                                .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(SolcoPalette.border, lineWidth: 1))
                                .contentShape(RoundedRectangle(cornerRadius: 16))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Messaggia \(profile.name), \(profile.roleLabel)")
                        }
                    }

                    if nextOffset != nil {
                        Button {
                            Task { await loadProfiles(append: true) }
                        } label: {
                            HStack(spacing: 8) {
                                if isLoadingMore { ProgressView().tint(SolcoPalette.lime) }
                                Text("Carica altri profili")
                            }
                            .frame(maxWidth: .infinity, minHeight: 46)
                        }
                        .buttonStyle(SolcoSecondaryButtonStyle())
                        .disabled(isLoadingMore)
                    }
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollIndicators(.hidden)
        .background(SolcoPalette.background)
        .navigationTitle("nav.community")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: role) { await loadProfiles(append: false) }
        .sheet(item: $selectedProfile, onDismiss: showStartedConversation) { profile in
            NewConversationSheet(profile: profile) { conversationID in
                queuedConversationID = conversationID
            }
        }
        .sheet(item: $activeConversation) { conversation in
            NavigationStack {
                MessagesThreadView(conversationID: conversation.id)
            }
        }
    }

    @MainActor
    private func loadProfiles(append: Bool) async {
        if append { isLoadingMore = true } else { isLoading = true }
        errorMessage = nil
        let offset = append ? (nextOffset ?? 0) : 0
        do {
            let response = try await APIClient.shared.communityProfiles(role: role.rawValue, offset: offset)
            profiles = append ? profiles + response.profiles : response.profiles
            nextOffset = response.nextOffset
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
        isLoadingMore = false
    }

    private func showStartedConversation() {
        guard let queuedConversationID else { return }
        activeConversation = ConversationReference(id: queuedConversationID)
        self.queuedConversationID = nil
    }
}

struct MessagesInboxView: View {
    @State private var user: SignedInUser?
    @State private var conversations: [MessageConversationSummary] = []
    @State private var isLoading = true
    @State private var isLoadingMessages = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Caricamento inbox…")
                    .tint(SolcoPalette.lime)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let user {
                inbox(for: user)
            } else {
                signedOutView
            }
        }
        .background(SolcoPalette.background)
        .navigationTitle("nav.messages")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadSession() }
    }

    private func inbox(for user: SignedInUser) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("SOLCO · PRIVATO")
                        .font(.caption.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(SolcoPalette.aqua)
                    Text("I tuoi messaggi")
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                    Text("Conversazioni accessibili solo ai partecipanti.")
                        .font(.subheadline)
                        .foregroundStyle(SolcoPalette.muted)
                }

                if isLoadingMessages {
                    ProgressView("Caricamento conversazioni…")
                        .tint(SolcoPalette.lime)
                        .frame(maxWidth: .infinity, minHeight: 110)
                } else if let errorMessage {
                    messagingState(title: "Inbox non disponibile", message: errorMessage) {
                        Task { await loadMessages() }
                    }
                } else if conversations.isEmpty {
                    messagingState(
                        title: "Ancora nessun messaggio",
                        message: "Esplora la community e apri un profilo per iniziare una conversazione."
                    )
                } else {
                    LazyVStack(spacing: 9) {
                        ForEach(conversations) { conversation in
                            NavigationLink {
                                MessagesThreadView(conversationID: conversation.id)
                            } label: {
                                HStack(spacing: 13) {
                                    profileAvatar(conversation.participant.name)
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack(alignment: .firstTextBaseline) {
                                            Text(conversation.participant.name)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(SolcoPalette.foreground)
                                                .lineLimit(1)
                                            Spacer(minLength: 5)
                                            Text(messageDate(conversation.lastMessage.createdAt))
                                                .font(.caption2)
                                                .foregroundStyle(SolcoPalette.muted)
                                        }
                                        Text(conversation.participant.roleLabel)
                                            .font(.caption.weight(.medium))
                                            .foregroundStyle(SolcoPalette.aqua)
                                        Text(conversation.lastMessage.content)
                                            .font(.caption)
                                            .foregroundStyle(SolcoPalette.muted)
                                            .lineLimit(1)
                                    }
                                }
                                .padding(13)
                                .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(SolcoPalette.border, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Text(user.name ?? user.email)
                    .font(.caption2)
                    .foregroundStyle(SolcoPalette.muted)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .refreshable { await loadMessages() }
    }

    private var signedOutView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("SOLCO · PRIVATO")
                    .font(.caption.weight(.bold))
                    .tracking(2)
                    .foregroundStyle(SolcoPalette.aqua)
                Text("Accedi per aprire la tua inbox.")
                    .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                    .foregroundStyle(SolcoPalette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                AuthFormView { signedInUser in
                    user = signedInUser
                    errorMessage = nil
                    Task { await loadMessages() }
                }
            }
            .frame(maxWidth: 620, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    @MainActor
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
        if user != nil { await loadMessages() }
    }

    @MainActor
    private func loadMessages() async {
        guard user != nil else { return }
        isLoadingMessages = true
        errorMessage = nil
        do {
            conversations = try await APIClient.shared.messagesInbox().conversations
        } catch SolcoAPIError.unauthorized {
            user = nil
            conversations = []
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingMessages = false
    }
}

private struct NewConversationSheet: View {
    let profile: CommunityProfileSummary
    let onStarted: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var user: SignedInUser?
    @State private var isCheckingSession = true
    @State private var content = ""
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 13) {
                        profileAvatar(profile.name)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(profile.name)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(SolcoPalette.foreground)
                            Text(profile.roleLabel)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(SolcoPalette.aqua)
                        }
                    }

                    if isCheckingSession {
                        ProgressView("Verifica accesso…").tint(SolcoPalette.lime)
                    } else if let user {
                        Text("Nuovo messaggio · \(user.name ?? user.email)")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(SolcoPalette.foreground)
                        TextEditor(text: $content)
                            .scrollContentBackground(.hidden)
                            .padding(10)
                            .frame(minHeight: 170)
                            .background(SolcoPalette.elevated, in: RoundedRectangle(cornerRadius: 14))
                            .overlay(RoundedRectangle(cornerRadius: 14).stroke(SolcoPalette.border, lineWidth: 1))
                            .foregroundStyle(SolcoPalette.foreground)
                            .accessibilityLabel("Il tuo messaggio")
                        Text("Solo tu e \(profile.name) potrete leggere questa chat.")
                            .font(.caption)
                            .foregroundStyle(SolcoPalette.muted)
                        if let errorMessage {
                            Text(errorMessage)
                                .font(.footnote)
                                .foregroundStyle(SolcoPalette.aqua)
                                .accessibilityAddTraits(.updatesFrequently)
                        }
                        Button {
                            Task { await startConversation() }
                        } label: {
                            HStack(spacing: 8) {
                                if isSending { ProgressView().tint(SolcoPalette.ink) }
                                Text(isSending ? "Invio…" : "Invia e apri la chat")
                            }
                            .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(SolcoPrimaryButtonStyle())
                        .disabled(isSending || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } else {
                        Text("Accedi prima di mostrare o inviare messaggi.")
                            .font(.subheadline)
                            .foregroundStyle(SolcoPalette.muted)
                        AuthFormView { signedInUser in
                            user = signedInUser
                            errorMessage = nil
                        }
                    }
                }
                .frame(maxWidth: 620, alignment: .leading)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .top)
            }
            .background(SolcoPalette.background)
            .navigationTitle("Nuovo messaggio")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Chiudi") { dismiss() }
                }
            }
            .task { await checkSession() }
        }
    }

    @MainActor
    private func checkSession() async {
        do {
            user = try await APIClient.shared.currentSession()
        } catch {
            user = nil
            errorMessage = error.localizedDescription
        }
        isCheckingSession = false
    }

    @MainActor
    private func startConversation() async {
        isSending = true
        errorMessage = nil
        do {
            let result = try await APIClient.shared.startConversation(profileID: profile.id, content: content)
            onStarted(result.conversationId)
            dismiss()
        } catch {
            errorMessage = "Messaggio non inviato. Il testo è ancora qui: riprova."
        }
        isSending = false
    }
}

struct MessagesThreadView: View {
    let conversationID: String
    @State private var user: SignedInUser?
    @State private var thread: MessageThreadResponse?
    @State private var isCheckingSession = true
    @State private var isLoading = true
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var sendError: String?
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        Group {
            if isCheckingSession {
                ProgressView("Verifica accesso…")
                    .tint(SolcoPalette.lime)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if user == nil {
                signedOutView
            } else if isLoading {
                ProgressView("Caricamento messaggi…")
                    .tint(SolcoPalette.lime)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let thread {
                threadView(thread)
            } else {
                messagingState(
                    title: "Conversazione non disponibile",
                    message: errorMessage ?? "Accedi con uno dei due account per aprire questa chat."
                ) {
                    Task { await loadThread() }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(SolcoPalette.background)
        .navigationTitle(thread?.conversation.participant.name ?? "Messaggi")
        .navigationBarTitleDisplayMode(.inline)
        .task { await checkSession() }
    }

    private var signedOutView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Accedi per leggere questa conversazione.")
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                    .foregroundStyle(SolcoPalette.foreground)
                AuthFormView { signedInUser in
                    user = signedInUser
                    errorMessage = nil
                    Task { await loadThread() }
                }
            }
            .frame(maxWidth: 620, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private func threadView(_ thread: MessageThreadResponse) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 11) {
                profileAvatar(thread.conversation.participant.name)
                VStack(alignment: .leading, spacing: 3) {
                    Text(thread.conversation.participant.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(SolcoPalette.foreground)
                    Text(thread.conversation.participant.roleLabel)
                        .font(.caption)
                        .foregroundStyle(SolcoPalette.aqua)
                }
                Spacer()
                Label("Privata", systemImage: "lock.fill")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(SolcoPalette.muted)
            }
            .padding(14)
            .overlay(alignment: .bottom) { SolcoPalette.border.frame(height: 1) }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(thread.messages) { message in
                            let isOwn = message.senderId == thread.currentUserId
                            HStack {
                                if isOwn { Spacer(minLength: 34) }
                                VStack(alignment: .trailing, spacing: 5) {
                                    Text(message.content)
                                        .font(.body)
                                        .foregroundStyle(isOwn ? SolcoPalette.ink : SolcoPalette.foreground)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text(messageDate(message.createdAt))
                                        .font(.system(size: 9, weight: .medium))
                                        .foregroundStyle(isOwn ? SolcoPalette.ink.opacity(0.7) : SolcoPalette.muted)
                                }
                                .padding(.horizontal, 13)
                                .padding(.vertical, 10)
                                .frame(maxWidth: 480, alignment: .leading)
                                .background(
                                    isOwn ? SolcoPalette.lime : SolcoPalette.surface,
                                    in: UnevenRoundedRectangle(
                                        topLeadingRadius: 17,
                                        bottomLeadingRadius: isOwn ? 17 : 5,
                                        bottomTrailingRadius: isOwn ? 5 : 17,
                                        topTrailingRadius: 17
                                    )
                                )
                                if !isOwn { Spacer(minLength: 34) }
                            }
                            .id(message.id)
                        }
                    }
                    .padding(16)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: thread.messages.count) {
                    guard let last = thread.messages.last else { return }
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            VStack(spacing: 7) {
                HStack(alignment: .bottom, spacing: 9) {
                    TextField("Scrivi un messaggio…", text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($composerFocused)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 11)
                        .background(SolcoPalette.elevated, in: RoundedRectangle(cornerRadius: 15))
                        .overlay(RoundedRectangle(cornerRadius: 15).stroke(SolcoPalette.border, lineWidth: 1))
                        .foregroundStyle(SolcoPalette.foreground)
                        .accessibilityLabel("Scrivi un messaggio")
                    Button {
                        Task { await sendMessage() }
                    } label: {
                        Image(systemName: isSending ? "hourglass" : "arrow.up")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(SolcoPalette.ink)
                            .frame(width: 44, height: 44)
                            .background(SolcoPalette.lime, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Invia messaggio")
                    .disabled(isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let sendError {
                    Text(sendError)
                        .font(.caption)
                        .foregroundStyle(SolcoPalette.aqua)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(SolcoPalette.background)
            .overlay(alignment: .top) { SolcoPalette.border.frame(height: 1) }
        }
        .onChange(of: thread.messages.count) { composerFocused = false }
    }

    @MainActor
    private func checkSession() async {
        do {
            user = try await APIClient.shared.currentSession()
        } catch {
            user = nil
            errorMessage = error.localizedDescription
        }
        isCheckingSession = false
        if user != nil { await loadThread() }
    }

    @MainActor
    private func loadThread() async {
        isLoading = true
        errorMessage = nil
        do {
            thread = try await APIClient.shared.messageThread(conversationID: conversationID)
        } catch SolcoAPIError.unauthorized {
            user = nil
            thread = nil
            errorMessage = nil
        } catch {
            thread = nil
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    @MainActor
    private func sendMessage() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, let thread else { return }
        isSending = true
        sendError = nil
        do {
            let result = try await APIClient.shared.sendMessage(conversationID: conversationID, content: text)
            self.thread = MessageThreadResponse(
                currentUserId: thread.currentUserId,
                conversation: thread.conversation,
                messages: thread.messages + [result.message]
            )
            draft = ""
            composerFocused = false
        } catch {
            sendError = "Messaggio non inviato. Il testo è ancora qui: riprova."
        }
        isSending = false
    }
}

private struct ConversationReference: Identifiable {
    let id: String
}

private func profileAvatar(_ name: String) -> some View {
    Text(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1).uppercased())
        .font(.system(.headline, design: .rounded).weight(.bold))
        .foregroundStyle(SolcoPalette.lime)
        .frame(width: 46, height: 46)
        .background(SolcoPalette.elevated, in: Circle())
        .overlay(Circle().stroke(SolcoPalette.border, lineWidth: 1))
        .accessibilityHidden(true)
}

@ViewBuilder
private func messagingState(
    title: String,
    message: String,
    retry: (() -> Void)? = nil
) -> some View {
    VStack(alignment: .leading, spacing: 10) {
        Text(title)
            .font(.headline)
            .foregroundStyle(SolcoPalette.foreground)
        Text(message)
            .font(.subheadline)
            .foregroundStyle(SolcoPalette.muted)
            .fixedSize(horizontal: false, vertical: true)
        if let retry {
            Button("Riprova", action: retry)
                .buttonStyle(SolcoSecondaryButtonStyle())
        }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(18)
    .background(SolcoPalette.surface, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(SolcoPalette.border, lineWidth: 1))
}

private func messageDate(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    guard let date else { return value }
    return date.formatted(date: .abbreviated, time: .shortened)
}
