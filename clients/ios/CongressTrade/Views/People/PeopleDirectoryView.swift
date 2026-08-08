import SwiftUI

/// People directory tab (owner punch list #2, item 9) — mirrors the web's
/// People directory (`app/src/ui/dashboardHtml.ts` `loadPeopleDirectory()`/
/// `renderPeopleDirectory()`): loads the full `GET /api/members` roster once
/// (memoized client-side, `CongressTradeStore.loadMembersDirectory`) and
/// filters/sorts it locally by name/state/party as the user types — the
/// roster is small enough (one filer per row, not one row per trade) that a
/// server round trip per keystroke isn't worth it, same call the web makes.
struct PeopleDirectoryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @State private var selectedMemberId: String?
    @State private var selectedMemberName: String?

    private var filteredMembers: [MemberDirectoryEntry] {
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Most-active-first, matching the roster's own server-side default order.
        let ranked = store.members.sorted { ($0.txCount ?? 0) > ($1.txCount ?? 0) }
        guard !needle.isEmpty else { return ranked }
        return ranked.filter { member in
            let haystack = [member.fullName, member.filerId, member.party, member.state, member.chamber]
                .compactMap { $0 }
                .joined(separator: " ")
                .lowercased()
            return haystack.contains(needle)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    PeopleSearchField(text: $searchText, focused: $searchFocused)
                        .accessibilityLabel("Search politicians by name, state, or party")

                    HStack {
                        Spacer(minLength: 0)
                        Text("\(filteredMembers.count) of \(store.members.count) shown")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }

                    if let notice = store.membersNotice {
                        FeedFreshnessView(
                            isOffline: false,
                            lastRefresh: nil,
                            notice: notice,
                            onRetry: { Task { await store.loadMembersDirectory(force: true) } }
                        )
                    }

                    if store.isLoadingMembers && store.members.isEmpty {
                        ProgressView("Loading Directory…")
                            .padding(.top, 40)
                    } else if filteredMembers.isEmpty {
                        ContentUnavailableView {
                            Label(
                                searchText.isEmpty ? "No Politicians Yet" : "No Matches",
                                systemImage: "person.2"
                            )
                        } description: {
                            Text(
                                searchText.isEmpty
                                    ? "The directory fills in as filings are ingested."
                                    : "Try another name, state, or party."
                            )
                        }
                        .padding(.top, 40)
                    } else {
                        LazyVStack(spacing: 8) {
                            ForEach(filteredMembers) { member in
                                Button {
                                    selectedMemberId = member.filerId
                                    selectedMemberName = member.fullName ?? member.filerId
                                } label: {
                                    PersonRow(member: member)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Opens politician details")
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationTitle("People")
            .refreshable { await store.loadMembersDirectory(force: true) }
            .task {
                await store.loadMembersDirectory()
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedMemberId != nil },
                set: { if !$0 { selectedMemberId = nil } }
            )) {
                if let memberId = selectedMemberId {
                    PoliticianDetailView(memberId: memberId, memberName: selectedMemberName ?? "Politician")
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
        }
    }
}

/// One People-directory row: avatar (photo, falling back to a party-emoji
/// tile), name + chamber/party-state meta line, trailing trade count.
private struct PersonRow: View {
    let member: MemberDirectoryEntry

    var body: some View {
        HStack(spacing: 12) {
            avatar

            VStack(alignment: .leading, spacing: 3) {
                Text(member.fullName ?? member.filerId)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(metaLine)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 2) {
                Text(CompactFormat.count(member.txCount))
                    .font(.subheadline.weight(.bold))
                Text("trades")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.borderColor.opacity(0.55), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(member.fullName ?? member.filerId), \(metaLine), \(member.txCount ?? 0) trades")
    }

    private var metaLine: String {
        var parts: [String] = []
        if let chamber = member.chamber, !chamber.isEmpty {
            parts.append(chamber.chamberLabel)
        }
        let partyState = [member.party, member.state]
            .compactMap { value -> String? in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " · ")
        if !partyState.isEmpty { parts.append(partyState) }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var avatar: some View {
        if let photoUrlString = member.photoUrl, let url = URL(string: photoUrlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().aspectRatio(contentMode: .fill)
                case .failure:
                    emojiTile
                case .empty:
                    ProgressView()
                @unknown default:
                    emojiTile
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(Circle())
            .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
        } else {
            emojiTile
        }
    }

    private var emojiTile: some View {
        Text((member.party ?? "").partyEmoji)
            .font(.system(size: 20))
            .frame(width: 44, height: 44)
            .background(Color(uiColor: .secondarySystemBackground), in: Circle())
            .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
    }
}

/// "Name" search field for the People directory — same visual language as
/// Trades' `CompactFilterField`, kept standalone here rather than reusing
/// that struct's `TradeFilterField`-typed focus binding, which is specific
/// to the Trades tab's own text fields.
private struct PeopleSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 6) {
            TextField("Name", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .font(.subheadline)
                .focused(focused)
                .submitLabel(.search)
                .onSubmit { focused.wrappedValue = false }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
    }
}
