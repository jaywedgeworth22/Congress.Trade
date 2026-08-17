import SwiftUI
import AuthenticationServices

/// Holds the in-flight Google OAuth session.
///
/// `ASWebAuthenticationSession` cancels as soon as the last strong reference
/// drops.  A local in `SignInPanel.startGoogleSignIn` is not enough: the
/// session must be held until the callback fires, or
/// `SFAuthenticationViewController` deallocates while loading its first view.
@MainActor
enum GoogleAuthSession {
    static var current: ASWebAuthenticationSession?
}

/// Presentation anchor for `ASWebAuthenticationSession` (the Google OAuth hop).
/// The session itself lives in `SignInPanel` (Components.swift) — this stays
/// here because it is the app's one window-anchor provider and has no other
/// home.
class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes
            .first(where: { $0.activationState == .foregroundActive })?
            .windows
            .first(where: { $0.isKeyWindow })
        {
            return window
        }
        if let window = scenes.flatMap(\.windows).first(where: { $0.isKeyWindow }) {
            return window
        }
        if let window = scenes.flatMap(\.windows).first {
            return window
        }
        return ASPresentationAnchor()
    }
}

/// Settings is deliberately short: an account, a switch, a theme, the legal
/// row. Sign-in, alerts and Premium are all shared components (`SignInPanel`,
/// `TradeDisclosureAlertsToggle`, `PremiumSheet`) so this view and the
/// header account sheet cannot drift apart again.
///
/// NOTE: no longer mounted as a tab — `AccountQuickMenu` (the header hamburger
/// sheet) is a strict superset of this screen and is the single account
/// surface. Kept because it is built entirely from those shared components, so
/// it costs nothing to keep in sync; `AuthPresentationContext` above is still
/// live and is used by `SignInPanel`'s Google hop.
struct SettingsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @AppStorage("app_color_scheme") private var appColorScheme = "light"
    @State private var showPremiumInfo = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    accountSection
                } footer: {
                    // Signed-out notices are rendered by SignInPanel itself.
                    if store.signedIn, let notice = store.watchlistNotice, !notice.isEmpty {
                        Text(notice)
                    }
                }

                Section {
                    TradeDisclosureAlertsToggle()
                }

                Section {
                    // No "Appearance" header, no "Theme" label, no explanation
                    // of what Light/Dark do (owner: "Don't need bunch of words
                    // on that tab").
                    ThemeSegmentControl(selection: $appColorScheme)
                        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                }

                if !store.isPremium {
                    Section {
                        Button {
                            showPremiumInfo = true
                        } label: {
                            Label("Premium", systemImage: "sparkles")
                        }
                    }
                }

                Section {
                    LegalFooterLinks()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .modifier(ForcedColorScheme(pref: appColorScheme))
            .navigationTitle("Settings")
            .inlineNavigationTitle()
            .environment(\.openPremium) { showPremiumInfo = true }
            .sheet(isPresented: $showPremiumInfo) {
                PremiumSheet()
                    .environmentObject(store)
            }
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        if store.signedIn, let user = store.signedInUser {
            HStack(spacing: 12) {
                if let picture = user.picture, let url = URL(string: picture) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        default:
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(Circle())
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(user.name?.isEmpty == false ? user.name! : user.email)
                        .font(.body.weight(.semibold))
                    Text(user.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(store.entitlementLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                }
            }
            .padding(.vertical, 4)

            Button(role: .destructive) {
                Task { await store.signOut() }
            } label: {
                Label(
                    store.isLoggingOut ? "Signing Out…" : "Sign Out",
                    systemImage: "rectangle.portrait.and.arrow.right"
                )
            }
            .disabled(store.isLoggingOut)
        } else if store.hasStoredSessionToken && !store.signedIn {
            // Token present but bootstrap hasn't resolved a user yet
            // (offline / expired). Offer retry + clear.
            Text("Session could not be verified.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                Task { await store.refresh() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
            Button(role: .destructive) {
                Task { await store.signOut() }
            } label: {
                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .disabled(store.isLoggingOut)
        } else {
            SignInPanel()
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        }
    }
}
