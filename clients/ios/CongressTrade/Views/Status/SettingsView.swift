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
    @State private var showPremiumInfo = false

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
                                // "Free" in accent blue read like a status
                                // worth having; only Premium earns the colour.
                                Text(store.entitlementLabel)
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(store.isPremium ? Color.blue : Color.secondary)
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
                        // One sign-in surface for the whole app (`SignInPanel`
                        // in Components.swift) — Apple, Google and the email
                        // link used to be hand-rolled here as well, which is
                        // how the Google button drifted into an all-blue
                        // Form-tinted row.
                        SignInPanel()
                    }
                } header: {
                    Text("Account")
                } footer: {
                    accountFooter
                }

                // No "Appearance" header and no "Theme" label: the three
                // pictographic segments say what they are, and the owner
                // explicitly does not want light/dark explained back to him.
                Section {
                    ThemeSegmentControl(selection: $appColorScheme)
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .contain)
                }

                // One switch, one name, same control as the header menu and the
                // Delivery tab.  The old block exposed APNs registration state
                // (permission / device-sync / "tap Sync") as if it were a
                // setting; that is plumbing, and it now lives inside the toggle.
                Section {
                    TradeDisclosureAlertsToggle()
                }

                if !store.isPremium {
                    Section {
                        Button {
                            showPremiumInfo = true
                        } label: {
                            Label("Upgrade to Premium", systemImage: "sparkles")
                        }
                    }
                }

                Section {
                    LegalFooterLinks()
                        .frame(maxWidth: .infinity)
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationTitle("Settings")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    // Resigns whatever is first responder rather than clearing
                    // one specific @FocusState — the email field now lives
                    // inside SignInPanel, so Settings no longer owns that flag.
                    Button("Done") { SettingsView.dismissKeyboard() }
                }
            }
            .sheet(isPresented: $showPremiumInfo) {
                // The sheet's signed-out CTA only has to get out of the way —
                // the sign-in panel is the section directly behind it.
                PremiumInfoSheet(onSignIn: { showPremiumInfo = false })
                    .environmentObject(store)
            }
        }
    }

    private static func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    @ViewBuilder
    private var accountFooter: some View {
        if let notice = store.watchlistNotice, !notice.isEmpty {
            Text(notice)
        } else if !store.signedIn {
            Text("Sign in to save a watchlist and set up deliveries.")
        }
    }
}
