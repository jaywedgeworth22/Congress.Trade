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
    @EnvironmentObject private var pushManager: PushNotificationManager
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @State private var isAuthenticating = false
    @State private var magicEmail = ""

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

                Section("Push Notifications (APNs)") {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Real-Time Trade Alerts")
                                .font(.body.weight(.medium))
                            Text(pushManager.isAuthorized ? "APNs Notifications Active" : "Notifications Disabled")
                                .font(.caption)
                                .foregroundStyle(pushManager.isAuthorized ? .green : .secondary)
                        }
                        Spacer()
                        if pushManager.isAuthorized {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Button("Enable Alerts") {
                                Task { await pushManager.requestAuthorization() }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }

                    if let token = pushManager.deviceToken {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("APNs Device Token")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(token)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }

                    if let error = pushManager.lastError {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
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

                        HStack {
                            TextField("you@example.com", text: $magicEmail)
                                .urlKeyboard()
                                .neverAutocapitalized()
                                .autocorrectionDisabled()
                            Button {
                                Task { await store.requestMagicLink(email: magicEmail) }
                            } label: {
                                Label("Email Link", systemImage: "envelope")
                            }
                            .disabled(magicEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                } header: {
                    Text("Account")
                } footer: {
                    Text("Sign in to manage delivery alerts and a saved watchlist. Preferences sync to the Congress.Trade backend — this app never holds provider keys or admin tokens.")
                }

                if store.signedIn {
                    Section("Recent Activity") {
                        if store.commands.isEmpty {
                            Text("No recent commands.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(store.commands) { command in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(command.type.replacingOccurrences(of: "_", with: " ").capitalized)
                                            .font(.subheadline.weight(.medium))
                                        Text(Optional(command.createdAt).shortDate)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    StatusPill(
                                        text: command.status.rawValue.capitalized,
                                        color: command.status.tint,
                                        compact: true
                                    )
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
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

        // Honor the configured API base URL (CONGRESS_TRADE_API_BASE_URL) so
        // non-prod backends get the OAuth round trip too.
        var components = URLComponents(
            url: store.api.origin.appendingPathComponent("auth/google/start"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "client", value: "ios")]
        guard let authURL = components?.url else { return }
        isAuthenticating = true
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
