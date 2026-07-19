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
    @State private var sessionTokenInput = ""
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
                    if !store.signedIn {
                        Button {
                            startGoogleSignIn()
                        } label: {
                            Label("Sign In with Google", systemImage: "person.crop.circle.fill")
                                .fontWeight(.medium)
                        }
                        .disabled(isAuthenticating)

                        SecureField("Session Token", text: $sessionTokenInput)
                            .privacySensitive()
                            .padding(.vertical, 4)
                            
                        Button {
                            if store.saveSessionToken(sessionTokenInput) {
                                sessionTokenInput = ""
                            }
                        } label: {
                            Label("Save Session Token", systemImage: "key.fill")
                                .fontWeight(.medium)
                        }
                        .disabled(sessionTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    
                    if store.hasStoredSessionToken {
                        Button(role: .destructive) {
                            Task { await store.signOut() }
                        } label: {
                            Label("Sign Out and Revoke Session", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                        .disabled(store.isLoggingOut)
                    }
                } header: {
                    Text("Keychain Authentication")
                } footer: {
                    Text("The iPhone app saves preferences on the backend. The phone never stores provider keys, admin tokens, crawler logic, or MCP orchestration.")
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
