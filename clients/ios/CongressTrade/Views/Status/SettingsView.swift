import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @State private var sessionTokenInput = ""

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
}
