import SwiftUI
import AuthenticationServices

class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        guard let windowScene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              let window = windowScene.windows.first(where: { $0.isKeyWindow }) else {
            return ASPresentationAnchor()
        }
        return window
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @State private var isAuthenticating = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Theme Mode", selection: $appColorScheme) {
                        Text("Match System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                }

                Section {
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
                        Button {
                            startGoogleSignIn()
                        } label: {
                            Label(
                                isAuthenticating ? "Opening Google…" : "Sign In with Google",
                                systemImage: "person.crop.circle.fill"
                            )
                            .fontWeight(.medium)
                        }
                        .disabled(isAuthenticating)
                    }
                } header: {
                    Text("Account")
                } footer: {
                    Text("Sign in to manage delivery alerts and a saved watchlist. Preferences sync to the Congress.Trade backend — this app never holds provider keys or admin tokens.")
                }

                if let notice = store.watchlistNotice, !notice.isEmpty {
                    Section {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Settings")
        }
    }

    private func startGoogleSignIn() {
        guard !isAuthenticating else { return }
        isAuthenticating = true

        let authURL = URL(string: "https://congress.trade/auth/google/start?client=ios")!
        let scheme = "congresstrade"

        let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: scheme) { callbackURL, error in
            isAuthenticating = false
            guard error == nil, let callbackURL = callbackURL else { return }

            // Expected URL: congresstrade://auth?token=XYZ
            guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let token = components.queryItems?.first(where: { $0.name == "token" })?.value else {
                return
            }

            _ = store.saveSessionToken(token)
        }

        session.presentationContextProvider = AuthPresentationContext.shared
        session.start()
    }
}
