// @polsia:user-owned
import SwiftUI

struct ContentView: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @AppStorage("solco.onboarding.completed") private var onboardingCompleted = false
    @State private var phoneSection: SolcoSection = .discover
    @State private var tabletSection: SolcoSection? = .discover
    @StateObject private var audioPlayer = AudiusMusicPlayer()

    var body: some View {
        Group {
            if !onboardingCompleted {
                OnboardingView { onboardingCompleted = true }
            } else if sizeClass == .regular {
                tabletNavigation
            } else {
                phoneNavigation
            }
        }
        .environmentObject(audioPlayer)
        .background(SolcoPalette.background.ignoresSafeArea())
    }

    private var phoneNavigation: some View {
        TabView(selection: $phoneSection) {
            ForEach(SolcoSection.allCases) { section in
                NavigationStack {
                    sectionContent(section)
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            AudiusMiniPlayer()
                        }
                }
                .tabItem {
                    Label {
                        Text(LocalizedStringKey(section.titleKey))
                    } icon: {
                        Image(systemName: section.symbol)
                    }
                }
                .tag(section)
            }
        }
        .tint(SolcoPalette.lime)
    }

    private var tabletNavigation: some View {
        NavigationSplitView {
            List(selection: $tabletSection) {
                ForEach(SolcoSection.allCases) { section in
                    Label {
                        Text(LocalizedStringKey(section.titleKey))
                    } icon: {
                        Image(systemName: section.symbol)
                    }
                    .tag(section as SolcoSection?)
                }
            }
            .scrollContentBackground(.hidden)
            .background(SolcoPalette.background)
            .navigationTitle("SOLCO")
            .navigationSplitViewColumnWidth(min: 230, ideal: 260)
        } detail: {
            NavigationStack {
                sectionContent(tabletSection ?? .discover)
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        AudiusMiniPlayer()
                    }
            }
        }
    }

    @ViewBuilder
    private func sectionContent(_ section: SolcoSection) -> some View {
        switch section {
        case .discover:
            DiscoveryView()
        case .community:
            CommunityView()
        case .messages:
            MessagesInboxView()
        case .player:
            PlayerLandingView()
        case .account:
            AccountView()
        }
    }
}

private struct OnboardingPage: Identifiable {
    let id: Int
    let title: String
    let body: String
    let symbol: String

    static let all: [OnboardingPage] = [
        OnboardingPage(id: 0, title: "onboarding.first.title", body: "onboarding.first.body", symbol: "person.wave.2"),
        OnboardingPage(id: 1, title: "onboarding.second.title", body: "onboarding.second.body", symbol: "waveform.path"),
        OnboardingPage(id: 2, title: "onboarding.third.title", body: "onboarding.third.body", symbol: "checkmark.shield"),
    ]
}

private struct OnboardingView: View {
    let onComplete: () -> Void
    @State private var selectedPage = 0
    @ScaledMetric(relativeTo: .largeTitle) private var markSize: CGFloat = 112

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                SolcoMark()
                    .stroke(SolcoPalette.lime, style: SolcoMark().strokeStyle(in: CGRect(x: 0, y: 0, width: 42, height: 42)))
                    .frame(width: 42, height: 42)
                    .accessibilityLabel(Text("brand.accessibility"))
                Text("SOLCO")
                    .font(.system(.headline, design: .rounded).weight(.bold))
                    .tracking(2.5)
                    .foregroundStyle(SolcoPalette.foreground)
                Spacer()
                Text("onboarding.counter \(selectedPage + 1) \(OnboardingPage.all.count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(SolcoPalette.muted)
            }
            .padding(.horizontal, 24)
            .padding(.top, 16)

            TabView(selection: $selectedPage) {
                ForEach(OnboardingPage.all) { page in
                    VStack(alignment: .leading, spacing: 22) {
                        Spacer(minLength: 12)
                        Image(systemName: page.symbol)
                            .font(.system(size: markSize * 0.55, weight: .light))
                            .foregroundStyle(SolcoPalette.lime)
                            .frame(maxWidth: .infinity, minHeight: markSize + 36, alignment: .leading)
                        Text(LocalizedStringKey(page.title))
                            .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                            .foregroundStyle(SolcoPalette.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(LocalizedStringKey(page.body))
                            .font(.body)
                            .lineSpacing(6)
                            .foregroundStyle(SolcoPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 20)
                    }
                    .frame(maxWidth: 560, alignment: .leading)
                    .padding(.horizontal, 28)
                    .tag(page.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            HStack(spacing: 8) {
                ForEach(OnboardingPage.all) { page in
                    Capsule()
                        .fill(selectedPage == page.id ? SolcoPalette.lime : SolcoPalette.border)
                        .frame(width: selectedPage == page.id ? 24 : 7, height: 7)
                }
            }
            .padding(.bottom, 22)

            Button(action: advance) {
                Text(selectedPage == OnboardingPage.all.count - 1 ? "onboarding.start" : "common.continue")
                    .font(.system(.headline, design: .rounded).weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(SolcoPrimaryButtonStyle())
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SolcoPalette.background)
    }

    private func advance() {
        if selectedPage == OnboardingPage.all.count - 1 {
            onComplete()
        } else {
            withAnimation(.easeInOut(duration: 0.2)) { selectedPage += 1 }
        }
    }
}

struct SolcoMark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let scaleX = rect.width / 512
        let scaleY = rect.height / 512
        path.move(to: CGPoint(x: 96 * scaleX, y: 272 * scaleY))
        path.addLine(to: CGPoint(x: 160 * scaleX, y: 272 * scaleY))
        path.addLine(to: CGPoint(x: 192 * scaleX, y: 176 * scaleY))
        path.addLine(to: CGPoint(x: 256 * scaleX, y: 368 * scaleY))
        path.addLine(to: CGPoint(x: 304 * scaleX, y: 224 * scaleY))
        path.addLine(to: CGPoint(x: 352 * scaleX, y: 272 * scaleY))
        path.addLine(to: CGPoint(x: 416 * scaleX, y: 272 * scaleY))
        return path.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }

    func strokeStyle(in rect: CGRect) -> StrokeStyle {
        StrokeStyle(lineWidth: rect.width * 35.2 / 512, lineCap: .round, lineJoin: .round)
    }
}

struct SolcoPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(SolcoPalette.ink)
            .background(SolcoPalette.lime.opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct SolcoSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(SolcoPalette.foreground)
            .background(SolcoPalette.surface.opacity(configuration.isPressed ? 0.65 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(SolcoPalette.border, lineWidth: 1))
    }
}
