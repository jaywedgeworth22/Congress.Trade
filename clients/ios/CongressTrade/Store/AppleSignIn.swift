import AuthenticationServices
import Foundation

/// Sign in with Apple completion handling, shared by every sign-in surface
/// (Settings' Account section + the header hamburger menu's `AccountQuickMenu`
/// — both use SwiftUI's `SignInWithAppleButton`, which manages its own
/// `ASAuthorizationController` + presentation context, so no delegate/context
/// provider boilerplate is needed here, unlike the Google flow's
/// `ASWebAuthenticationSession` in `SettingsView.AuthPresentationContext`).
extension CongressTradeStore {
    /// Handles the `SignInWithAppleButton(.signIn) { } onCompletion:` result.
    /// On success, forwards the identity token to `POST /auth/apple` and
    /// stores the returned session the same way the Google/magic-link flows
    /// do (`saveSessionToken` → Keychain via `KeychainTokenStore`).
    ///
    /// Cancel is handled quietly (no notice); any other failure surfaces
    /// through `watchlistNotice`, the same account-status notice channel the
    /// Google/email flows already use in `SettingsView`.
    func handleAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let error):
            if let authError = error as? ASAuthorizationError, authError.code == .canceled {
                return
            }
            setAccountNotice("Sign in with Apple failed: \(error.localizedDescription)")

        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                setAccountNotice("Sign in with Apple did not return an Apple ID credential.")
                return
            }
            guard let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8),
                  !identityToken.isEmpty else {
                setAccountNotice("Sign in with Apple did not return a usable identity token.")
                return
            }
            // Apple only ever includes `fullName` on the device's very first
            // authorization for this app — capture it now or lose it forever.
            let fullName = Self.formattedFullName(credential.fullName)
            do {
                let response = try await api.signInWithApple(
                    identityToken: identityToken,
                    fullName: fullName
                )
                _ = saveSessionToken(response.token)
            } catch {
                setAccountNotice("Sign in with Apple failed: \(error.localizedDescription)")
            }
        }
    }

    private static func formattedFullName(_ components: PersonNameComponents?) -> String? {
        guard let components else { return nil }
        let formatted = PersonNameComponentsFormatter().string(from: components)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return formatted.isEmpty ? nil : formatted
    }
}
