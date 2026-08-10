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
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @State private var isAuthenticating = false
    @State private var magicEmail = ""
    @State private var showSubscribe = false
    /// Raw nonce for the in-flight Sign in with Apple request — see
    /// `Store/AppleSignIn.swift` / `AccountQuickMenu`'s identical button.
    @State private var currentAppleNonce: String?
    @FocusState private var magicEmailFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
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
                        signInButtons
                    }
                } header: {
                    Text("Account")
                } footer: {
                    accountFooter
                }

                Section {
                    HStack {
                        Text("Theme")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 12)
                        ThemeSegmentControl(selection: $appColorScheme)
                            .frame(maxWidth: 280)
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .contain)
                } header: {
                    Text("Appearance")
                }

                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Real-Time Trade Alerts")
                                .font(.body.weight(.medium))
                            Text(pushStatusCaption)
                                .font(.caption)
                                .foregroundStyle(pushStatusColor)
                        }
                        Spacer()
                        if pushManager.isAuthorized {
                            if pushManager.isBackendSynced {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            } else if store.signedIn {
                                Button("Sync") {
                                    Task {
                                        await pushManager.syncTokenWithBackend(api: store.api, force: true)
                                    }
                                }
                                .buttonStyle(.bordered)
                            } else {
                                Image(systemName: "checkmark.circle")
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Button("Enable Alerts") {
                                Task { await pushManager.requestAuthorization() }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }

                    // APNs device token is never shown in Settings (not even DEBUG).

                    if let error = pushManager.lastError {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Push Notifications")
                }

                if store.signedIn && !store.isPremium {
                    Section("Premium") {
                        Text("1-month free trial, then $5/month or $50/year.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button {
                            showSubscribe = true
                        } label: {
                            Label("Subscribe with Apple", systemImage: "apple.logo")
                        }
                        if let url = store.api.upgradeURL {
                            Link("Subscribe on Congress.Trade", destination: url)
                        }
                    }
                }

                Section("About") {
                    Link("Privacy Policy", destination: URL(string: "https://Congress.Trade/privacy-policy")!)
                    Link("Terms of Service", destination: URL(string: "https://Congress.Trade/terms-of-service")!)
                    Link("Pricing", destination: URL(string: "https://Congress.Trade/pricing")!)
                    Link("Support", destination: URL(string: "mailto:congress.trade@jays.services")!)
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationTitle("Settings")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { magicEmailFocused = false }
                }
            }
            .sheet(isPresented: $showSubscribe) {
                SubscribeView()
                    .environmentObject(store)
            }
        }
    }

    /// Full-width Apple + Google buttons (ST-style parity: same height/radius,
    /// Google uses outline + multicolor G mark; Apple stays the system control).
    @ViewBuilder
    private var signInButtons: some View {
        VStack(spacing: 12) {
            SignInWithAppleButton(.signIn) { request in
                // Request name + email on first authorization so the backend
                // can store a display name (email also lands in the JWT).
                request.requestedScopes = [.fullName, .email]
                let nonce = AppleSignInNonce.generate()
                currentAppleNonce = nonce
                request.nonce = nonce
            } onCompletion: { result in
                Task {
                    await store.handleAppleSignIn(result, rawNonce: currentAppleNonce)
                    currentAppleNonce = nil
                }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 48)
            .frame(maxWidth: 375)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityLabel("Sign in with Apple")

            Button {
                startGoogleSignIn()
            } label: {
                HStack(spacing: 8) {
                    GoogleMark()
                        .frame(width: 18, height: 18)
                    Text(isAuthenticating ? "Opening Google…" : "Sign in with Google")
                        .font(.subheadline.weight(.medium))
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 48)
                .foregroundStyle(Color.primary)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(colorScheme == .dark
                              ? Color(white: 0.09).opacity(0.78)
                              : Color.white.opacity(0.65))
                        .overlay {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(
                                    Color.primary.opacity(colorScheme == .dark ? 0.12 : 0.1),
                                    lineWidth: 1
                                )
                        }
                }
            }
            .buttonStyle(.plain)
            .disabled(isAuthenticating)
            .accessibilityLabel("Sign in with Google")

            HStack(spacing: 8) {
                TextField("you@example.com", text: $magicEmail)
                    .urlKeyboard()
                    .neverAutocapitalized()
                    .autocorrectionDisabled()
                    .focused($magicEmailFocused)
                    .submitLabel(.done)
                    .onSubmit { magicEmailFocused = false }
                Button {
                    magicEmailFocused = false
                    Task { await store.requestMagicLink(email: magicEmail) }
                } label: {
                    Text("Email Link")
                        .font(.subheadline.weight(.medium))
                }
                .disabled(magicEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
    }

    @ViewBuilder
    private var accountFooter: some View {
        if let notice = store.watchlistNotice, !notice.isEmpty {
            Text(notice)
        } else if !store.signedIn {
            Text("Sign in to manage delivery alerts and a saved watchlist.")
        }
    }

    private var pushStatusCaption: String {
        // Secondary status / data lines: sentence case per FLEET-UI-COPY.md
        if !pushManager.isAuthorized {
            return "notifications disabled"
        }
        if !store.signedIn {
            return "sign in to register this device"
        }
        if pushManager.isBackendSynced {
            return "device registered for alerts"
        }
        if pushManager.isRegistering {
            return "registering device…"
        }
        if pushManager.lastError != nil {
            return "registration failed — tap Sync"
        }
        return "permission granted — waiting for sync"
    }

    private var pushStatusColor: Color {
        if !pushManager.isAuthorized { return .secondary }
        if pushManager.isBackendSynced { return .green }
        if pushManager.lastError != nil { return .red }
        return .secondary
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
            if let error {
                if let authError = error as? ASWebAuthenticationSessionError,
                   authError.code == .canceledLogin {
                    return
                }
                store.setAccountNotice("Google sign-in failed: \(error.localizedDescription)")
                return
            }
            guard let callbackURL else {
                store.setAccountNotice("Google sign-in did not return a session.")
                return
            }

            // Expected URL: congresstrade://auth?token=XYZ
            guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
                  !token.isEmpty else {
                store.setAccountNotice("Google sign-in did not return a usable session token.")
                return
            }

            _ = store.saveSessionToken(token)
        }

        session.presentationContextProvider = AuthPresentationContext.shared
        session.start()
    }
}

// MARK: - Google mark (ST LoginView parity — multicolor G ring)

/// Multicolor "G" mark matching Socratic.Trade's `LoginView.GoogleMark` so the
/// Google button sits next to Apple with comparable visual weight.
private struct GoogleMark: View {
    var body: some View {
        Canvas { context, size in
            let blue = Color(red: 0x42 / 255, green: 0x85 / 255, blue: 0xF4 / 255)
            let green = Color(red: 0x34 / 255, green: 0xA8 / 255, blue: 0x53 / 255)
            let yellow = Color(red: 0xFB / 255, green: 0xBC / 255, blue: 0x05 / 255)
            let red = Color(red: 0xEA / 255, green: 0x43 / 255, blue: 0x35 / 255)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = size.width * 0.42
            let lw = size.width * 0.18

            func arc(_ start: Double, _ end: Double, _ color: Color) {
                var p = Path()
                p.addArc(
                    center: center,
                    radius: radius,
                    startAngle: .degrees(start),
                    endAngle: .degrees(end),
                    clockwise: false
                )
                context.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: lw, lineCap: .butt))
            }
            arc(-35, 20, blue)
            arc(20, 120, green)
            arc(120, 220, yellow)
            arc(220, 325, red)
            context.fill(
                Path(CGRect(
                    x: size.width * 0.48,
                    y: size.height * 0.42,
                    width: size.width * 0.42,
                    height: size.width * 0.16
                )),
                with: .color(blue)
            )
        }
        .accessibilityHidden(true)
    }
}
