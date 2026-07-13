import SwiftUI

struct CommandStatusView: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        NavigationStack {
            List {
                if let command = store.lastCommand {
                    Section("Latest") {
                        CommandRow(command: command)
                    }
                }

                Section("Recent Commands") {
                    if store.commands.isEmpty {
                        Text(store.signedIn ? "No commands yet." : "Sign in to view command status.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.commands) { command in
                            CommandRow(command: command)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Command Status")
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        Task { await store.refreshSignedInState() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .fontWeight(.semibold)
                    }
                    .accessibilityLabel("Refresh command status")
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let notice = store.commandNotice {
                    NoticeView(message: notice)
                        .padding(.horizontal)
                        .padding(.bottom, 8)
                }
            }
        }
    }
}

struct CommandRow: View {
    let command: ClientCommand

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(command.type.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.headline)
                Spacer()
                StatusPill(text: command.status.rawValue.capitalized, color: command.status.tint)
            }
            Text(command.id)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if let error = command.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 6)
    }
}
