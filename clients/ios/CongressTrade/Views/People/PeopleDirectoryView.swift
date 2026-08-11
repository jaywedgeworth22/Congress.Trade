import SwiftUI

/// Directory tab — mirrors web Directory (`loadPeopleDirectory` /
/// multi-token name/state/party search + column sort).
struct PeopleDirectoryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @State private var selectedMemberId: String?
    @State private var selectedMemberName: String?
    @State private var sortKey: MemberDirectorySearch.SortKey = .trades
    @State private var sortAscending = false
    /// Zero-based page over the already-loaded roster. `/api/members` is a
    /// deliberate full-roster endpoint (30-minute KV cache, no paging params,
    /// ~14KB gzipped for 379 members), so paging here is a pure display
    /// concern — it must never turn into an offset request or we lose both the
    /// cache and instant local search/sort.
    @State private var page = 0
    @AppStorage("directory_page_size") private var pageSize = 50

    private static let listTopAnchor = "directory-list-top"

    private var filteredMembers: [MemberDirectoryEntry] {
        let matched = store.members.filter { MemberDirectorySearch.matches($0, query: searchText) }
        return MemberDirectorySearch.sort(matched, key: sortKey, ascending: sortAscending)
    }

    /// Clamped so a shrinking result set (typing into search) can never strand
    /// the reader on an empty page.
    private var pagedMembers: ArraySlice<MemberDirectoryEntry> {
        let all = filteredMembers
        guard !all.isEmpty else { return [] }
        let size = max(1, pageSize)
        let start = min(page * size, ((all.count - 1) / size) * size)
        return all[start..<min(start + size, all.count)]
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(spacing: 10) {
                    PeopleSearchField(text: $searchText, focused: $searchFocused)
                        .accessibilityLabel("Search directory by name, state, or party")

                    DirectorySortHeader(
                        sortKey: $sortKey,
                        sortAscending: $sortAscending
                    )

                    // Pager sits above the list as well as below it (owner:
                    // pagination was "way at bottom and missing from top").
                    // Its range label doubles as the result count, so the old
                    // standalone "X of Y shown" row is gone.
                    if !filteredMembers.isEmpty {
                        ClientPaginationBar(
                            page: $page,
                            pageSize: $pageSize,
                            total: filteredMembers.count,
                            unit: "politicians"
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 8)
                .background(AppTheme.background)

                ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 8) {
                        // Anchor for the page-change scroll reset below; a new
                        // page of rows under an unchanged scroll offset drops
                        // you into the middle of it.
                        Color.clear.frame(height: 0).id(Self.listTopAnchor)

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
                                        : "Try a name, state (full or CA), party, or “CA Ro”."
                                )
                            }
                            .padding(.top, 40)
                        } else {
                            LazyVStack(spacing: 8) {
                                ForEach(pagedMembers) { member in
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

                            ClientPaginationBar(
                                page: $page,
                                pageSize: $pageSize,
                                total: filteredMembers.count,
                                unit: "politicians"
                            )
                            .padding(.top, 4)
                        }

                        LegalFooterLinks()
                            .padding(.top, 8)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: page) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(Self.listTopAnchor, anchor: .top)
                    }
                }
                }
            }
            .background(AppTheme.background)
            .inlineNavigationTitle()
            // Directory is a browsing tab like Trends and Trades, so it gets
            // their chrome rather than a text title: the same `BrandTitle`
            // lockup at the same size, and the same header menu. The ⓘ
            // disclaimer toggle is Trends/Trades-only — there is no chart or
            // dollar estimate on this screen for it to qualify.
            .toolbar {
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    HamburgerMenuButton()
                }
            }
            .refreshable { await store.loadMembersDirectory(force: true) }
            .task {
                await store.loadMembersDirectory()
            }
            // Narrowing or reordering the roster invalidates the current page
            // number, so every input that changes the result set resets it.
            .onChange(of: searchText) { _, _ in page = 0 }
            .onChange(of: sortKey) { _, _ in page = 0 }
            .onChange(of: sortAscending) { _, _ in page = 0 }
            .onChange(of: pageSize) { _, _ in page = 0 }
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

/// Client-side pager for a collection that is already fully in memory.
///
/// Geometry is deliberately identical to the Trades tab's server-driven
/// `FeedPaginationBar` (30pt chevron targets, `.caption` labels, 12pt
/// continuous-radius material panel) because the owner called out that the
/// app's controls "look like different styles" from one another. The two
/// differ only in where the numbers come from: `FeedPaginationBar` reads
/// `total`/`limit` off the feed response, this one is handed a count that was
/// filtered locally. Once the Trades restyle lands, `FeedPaginationBar` should
/// be reduced to a thin wrapper over this view and this struct moved to
/// `Components.swift` — there is no reason for two pagers to exist.
///
/// The centre label is a range ("1–50 of 379"), not "Page 1 of 8": it answers
/// the position question and the how-many question in one control, which is
/// what let the standalone result-count row be deleted.
struct ClientPaginationBar: View {
    @Binding var page: Int
    @Binding var pageSize: Int
    let total: Int
    /// Plural noun for VoiceOver only — the visible label stays numeric.
    var unit: String = "results"
    var pageSizeOptions: [Int] = [25, 50, 100]

    private var pageCount: Int { max(1, Int(ceil(Double(total) / Double(max(1, pageSize))))) }
    private var clampedPage: Int { min(max(0, page), pageCount - 1) }
    private var lowerBound: Int { total == 0 ? 0 : clampedPage * pageSize + 1 }
    private var upperBound: Int { min((clampedPage + 1) * pageSize, total) }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                page = max(0, clampedPage - 1)
            } label: {
                Image(systemName: "chevron.left")
                    .font(.caption.weight(.bold))
                    .frame(width: 30, height: 30)
            }
            .disabled(clampedPage == 0)
            .accessibilityLabel("Previous page")

            Text("\(lowerBound)–\(upperBound) of \(total)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .frame(minWidth: 84)
                .accessibilityLabel("Showing \(lowerBound) to \(upperBound) of \(total) \(unit)")

            Button {
                page = min(pageCount - 1, clampedPage + 1)
            } label: {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .frame(width: 30, height: 30)
            }
            .disabled(clampedPage >= pageCount - 1)
            .accessibilityLabel("Next page")

            Spacer(minLength: 8)

            Menu {
                ForEach(pageSizeOptions, id: \.self) { size in
                    Button {
                        pageSize = size
                    } label: {
                        HStack {
                            Text("\(size) / page")
                            if pageSize == size {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 3) {
                    Text("\(pageSize)/page")
                        .font(.caption.weight(.semibold))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .opacity(0.5)
                }
                .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Rows per page, \(pageSize)")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
    }
}

/// Sticky-style sort controls (mirrors web column headings).
private struct DirectorySortHeader: View {
    @Binding var sortKey: MemberDirectorySearch.SortKey
    @Binding var sortAscending: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(MemberDirectorySearch.SortKey.allCases) { key in
                    Button {
                        if sortKey == key {
                            sortAscending.toggle()
                        } else {
                            sortKey = key
                            sortAscending = key != .trades
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text(key.label)
                                .font(.caption.weight(.semibold))
                            if sortKey == key {
                                Image(systemName: sortAscending ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 9, weight: .bold))
                            }
                        }
                        // Same capsule metrics as `FilterChip` (12/7) so the
                        // app carries one chip geometry rather than one per
                        // screen; the softer tinted fill is deliberate — a
                        // solid-accent chip reads as a hard filter, and this
                        // only reorders.
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(
                            sortKey == key
                                ? Color.accentColor.opacity(0.16)
                                : Color(uiColor: .secondarySystemBackground),
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Sort by \(key.label)")
                    .accessibilityValue(sortKey == key ? (sortAscending ? "Ascending" : "Descending") : "Off")
                }
            }
        }
    }
}

/// One Directory row: avatar, name + chamber/party-state meta, trade count.
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
        var partyStateBits: [String] = []
        if let party = member.party, !party.isEmpty {
            partyStateBits.append(party)
        }
        if let state = member.state, !state.isEmpty {
            let district = CompactFormat.districtOrdinal(member.district)
            partyStateBits.append(district.isEmpty ? state : "\(state) - \(district)")
        }
        if !partyStateBits.isEmpty {
            parts.append(partyStateBits.joined(separator: " · "))
        }
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

private struct PeopleSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField("Name, state, party… e.g. CA Ro", text: $text)
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
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
