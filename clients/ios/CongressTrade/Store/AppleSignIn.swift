import AuthenticationServices
import CryptoKit
import Foundation
import Security

/// Generates the replay-protection nonce for Sign in with Apple
/// (`ASAuthorizationAppleIDRequest.nonce`). The backend verifies the
/// identity token's `nonce` claim against the exact string the client sends
/// with plain string equality (`app/src/auth/appleIdentity.ts`:
/// `payload.nonce !== opts.nonce`) — so the SAME SHA256 digest generated
/// here is set as `request.nonce` (which Apple embeds unmodified into the
/// returned identity token's `nonce` claim) AND forwarded verbatim as
/// `signInWithApple`'s `nonce` argument, rather than the two-value
/// raw-vs-hashed split some (e.g. Firebase-fronted) Apple integrations use.
enum AppleSignInNonce {
    /// A fresh cryptographically random nonce, one per sign-in attempt.
    static func generate(byteCount: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        precondition(status == errSecSuccess, "Unable to generate a secure Sign in with Apple nonce")
        let digest = SHA256.hash(data: Data(bytes))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

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
    /// - Parameter rawNonce: The exact string the button's request builder
    ///   set as `request.nonce` via `AppleSignInNonce.generate()` (nil only
    ///   if a caller skipped the request-configuration closure, which no
    ///   in-app surface does — the backend simply skips nonce verification
    ///   in that case).
    ///
    /// Cancel is handled quietly (no notice); any other failure surfaces
    /// through `watchlistNotice`, the same account-status notice channel the
    /// Google/email flows already use in `SettingsView`.
    func handleAppleSignIn(_ result: Result<ASAuthorization, Error>, rawNonce: String? = nil) async {
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
                    nonce: rawNonce,
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
