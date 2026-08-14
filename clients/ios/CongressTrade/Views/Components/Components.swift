import AuthenticationServices
import SwiftUI
import UserNotifications

enum AppTheme {
    static let background = Color(uiColor: .systemBackground)
    static let panel = Color(uiColor: .systemGray6).opacity(0.4)
    static let panelElevated = Color(uiColor: .systemGray5).opacity(0.6)
    static let borderColor = Color(uiColor: .separator)
    static let primaryGradient = LinearGradient(colors: [.blue, .indigo], startPoint: .topLeading, endPoint: .bottomTrailing)
    
    // Web app aesthetic alignment
    static let houseColor = Color.blue.opacity(0.8)
    static let senateColor = Color.purple.opacity(0.8)
    static let execColor = Color.orange.opacity(0.8)

    static func border(cornerRadius: CGFloat = 16) -> some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .stroke(borderColor, lineWidth: 1)
    }
}

// Party animals stay available for compact text annotations (a trade row
// prefix). They are NOT a face fallback — a missing portrait uses initials,
// matching the web avatar, so a Democrat never becomes a donkey on the
// politician sheet.
extension String {
    var partyEmoji: String {
        switch self.lowercased() {
        case "democrat", "dem", "d": return "🫏"
        case "republican", "rep", "r": return "🐘"
        default: return "🦅" // Independent/Other
        }
    }

    /// Two-letter initials from a politician name (`Ro Khanna` → `RK`).
    var nameInitials: String {
        let parts = split(whereSeparator: { $0.isWhitespace }).filter { !$0.isEmpty }
        guard let first = parts.first else { return "?" }
        if parts.count == 1 { return String(first.prefix(2)).uppercased() }
        let last = parts.last!
        return String(first.prefix(1) + last.prefix(1)).uppercased()
    }

    var chamberLabel: String {
        switch self.lowercased() {
        case "house": return "House"
        case "senate": return "Senate"
        case "executive": return "Executive"
        default: return self.capitalized
        }
    }
}

enum MemberPhotoURL {
    /// First usable absolute URL among the API profile, a Directory-row seed,
    /// and any already-loaded roster entry. Relative `/api/photos/...` paths
    /// are ignored: SwiftUI `AsyncImage` cannot resolve them.
    static func resolve(_ candidates: String?...) -> URL? {
        for raw in candidates {
            guard let raw, !raw.isEmpty, let url = URL(string: raw), url.scheme != nil else { continue }
            return url
        }
        return nil
    }
}

/// Headshot with initials underneath (web `memberAvatarHtml`). A broken or
/// missing image leaves the initials — never a party mascot.
struct MemberAvatar: View {
    let photoURL: URL?
    let name: String
    var size: CGFloat = 44

    var body: some View {
        ZStack {
            Text(name.nameInitials)
                .font(.system(size: max(11, size * 0.34), weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: size, height: size)
                .background(Color(uiColor: .secondarySystemBackground), in: Circle())
            if let photoURL {
                AsyncImage(url: photoURL) { phase in
                    if case .success(let image) = phase {
                        image.resizable().aspectRatio(contentMode: .fill)
                    }
                }
                .frame(width: size, height: size)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
        .accessibilityHidden(true)
    }
}

struct MetricTile: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panelElevated, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    var icon: String? = nil
    var compact: Bool = false

    var body: some View {
        HStack(spacing: compact ? 2 : 4) {
            if let icon {
                Image(systemName: icon)
            }
            Text(text)
        }
        .font(compact ? .caption2.weight(.bold) : .caption.weight(.bold))
        .padding(.horizontal, compact ? 7 : 10)
        .padding(.vertical, compact ? 3 : 6)
        .foregroundStyle(color)
        .background(color.opacity(0.15), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.3), lineWidth: 1))
    }
}

/// Selectable capsule chip used by delivery filters and similar multi-select UIs.
struct FilterChip: View {
    let title: String
    let isSelected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .background(
                    isSelected ? Color.accentColor : Color(uiColor: .systemGray5),
                    in: Capsule()
                )
        }
        .buttonStyle(.plain)
    }
}

struct AssetMark: View {
    let symbol: String
    var isTicker: Bool = true
    var size: CGFloat = 48
    @Environment(\.colorScheme) private var colorScheme

    private var themedLogoURL: URL? {
        guard isTicker else { return nil }
        let trimmed = symbol.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let encodedSymbol = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            return nil
        }
        // Logos are served at site origin, not under /api/client/v1.
        let origin = CongressTradeAPIClient.defaultBaseURL
            .deletingLastPathComponent() // v1
            .deletingLastPathComponent() // client
            .deletingLastPathComponent() // api
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/api/logos/ticker"
        components.queryItems = [
            URLQueryItem(name: "symbol", value: encodedSymbol),
            URLQueryItem(name: "theme", value: colorScheme == .dark ? "dark" : "light")
        ]
        return components.url
    }

    var body: some View {
        // No monogram / blue-square placeholders: when there is no real logo,
        // take zero space so asset + politician names get the width.
        if let url = themedLogoURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .padding(size * 0.12)
                        .frame(width: size, height: size)
                        .background(
                            colorScheme == .dark
                                ? Color(uiColor: .secondarySystemBackground)
                                : Color.white,
                            in: RoundedRectangle(cornerRadius: size * 0.22)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: size * 0.22)
                                .stroke(AppTheme.borderColor, lineWidth: 1)
                        )
                default:
                    EmptyView()
                }
            }
        }
    }
}

/// Compact money/count formatting (Trends KPIs + trade amount brackets).
/// Fleet UI copy: lowercase suffixes `$15k`, `$99.8k`, `$1.2m`, `$3.4b`, `$3.62t`.
enum CompactFormat {
    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let absV = abs(value)
        let sign = value < 0 ? "-" : ""
        if absV >= 1_000_000_000_000 {
            // Trillion+ always shows 2 decimal places ("$3.62t") so a mega-cap
            // market cap never falls back to a 4+ digit billions number
            // ("$3622.5b") the way the plain billions branch below would render it.
            return "\(sign)$\(String(format: "%.2f", absV / 1_000_000_000_000))t"
        }
        if absV >= 1_000_000_000 {
            return "\(sign)$\(Self.compactNumber(absV / 1_000_000_000))b"
        }
        if absV >= 1_000_000 {
            return "\(sign)$\(Self.compactNumber(absV / 1_000_000))m"
        }
        if absV >= 1_000 {
            return "\(sign)$\(Self.compactNumber(absV / 1_000))k"
        }
        return "\(sign)$\(String(format: "%.0f", absV))"
    }

    /// STOCK Act-style bracket floors/ceilings: `$15k`, `$50k`, `$500k`, `$1m`.
    static func usdBracket(_ value: Int) -> String {
        usd(Double(value))
    }

    /// Display-only integer grouping (`22,293`). Storage/API stay bare numbers.
    /// Always full digits with thousand separators — no k/m abbreviation for counts.
    static func count(_ value: Int?) -> String {
        guard let value else { return "—" }
        return value.formatted(.number.grouping(.automatic))
    }

    /// District ordinal for display: `1` → `1st`, `2` → `2nd`, `3` → `3rd`, `11` → `11th`.
    /// Non-numeric values pass through unchanged. Display-only.
    static func districtOrdinal(_ raw: String?) -> String {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return ""
        }
        guard raw.range(of: #"^\d+(?:st|nd|rd|th)?$"#, options: [.regularExpression, .caseInsensitive]) != nil else {
            return raw
        }
        let digits = String(raw.prefix(while: \.isNumber))
        guard let n = Int(digits), n > 0 else { return raw }
        let suffix: String
        let mod100 = n % 100
        if (11...13).contains(mod100) {
            suffix = "th"
        } else {
            switch n % 10 {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(n)\(suffix)"
    }

    /// Signed money for net-flow readouts: positives carry an explicit `+`
    /// (`net +$1.2m`), negatives keep the `-` `usd` already produces, and zero
    /// stays unsigned (`$0` — "+$0" reads as a gain that isn't there).
    /// `nil` → `—`, same as `usd`.
    ///
    /// This exists so every net/delta call site prints the sign the same way
    /// instead of each screen hand-rolling `value > 0 ? "+" : ""`.
    static func signedUsd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let base = usd(value)
        // `usd` rounds, so a tiny positive can render as "$0" — key the sign
        // off the rendered string, not the raw value, or "+$0" comes back.
        guard value > 0, !base.hasPrefix("-"), base != "$0" else { return base }
        return "+\(base)"
    }

    /// Drop trailing `.0` so `$1.0m` → `$1m`, keep `$1.2m` / `$15k`.
    private static func compactNumber(_ value: Double) -> String {
        if value == value.rounded(.towardZero) || abs(value - value.rounded()) < 0.05 {
            return String(format: "%.0f", value.rounded())
        }
        return String(format: "%.1f", value)
    }
}

struct DetailSection<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(AppTheme.border(cornerRadius: 16))
    }
}

// MARK: - Ledger row geometry

/// Two-column ledger layout: a fixed-fraction label column, a gutter, then the
/// value filling the rest — **left-aligned**.
///
/// This replaces `HStack { label; Spacer(); value }`, which pushes the two
/// halves to opposite edges and leaves a measured 52% dead gap mid-row (KO
/// ticker sheet). The web already solved this: `.drawer-kv` in
/// `app/src/ui/dashboardHtml.ts` is `grid-template-columns: 35% 1fr` with the
/// value left-aligned, carrying the owner's note that stacked label-above-value
/// "is impossible to look at without getting a headache".
///
/// Rejected alternatives, recorded so they don't get re-proposed:
/// - **Leader dots** — rejected outright.
/// - **Right-aligned values** — rejected: ragged-left values force the eye to
///   re-find where each number starts on every row.
/// - **Intrinsic label width** (`.frame(maxWidth:)` on the label inside an
///   `HStack`) — sizes each row to its own label, so the value column zig-zags
///   down the section instead of forming a column.
/// - **`containerRelativeFrame`** — measures the enclosing scroll view, not the
///   padded row, so 38% comes out far too wide inside a card.
///
/// A `Layout` is what makes the column *shared*: every row resolves the same
/// fraction of the same proposed width, so the values line up without any
/// cross-row preference plumbing. Both columns are proposed a real width, so
/// long labels **wrap** (to two lines and beyond at accessibility text sizes)
/// rather than truncating.
struct LedgerRowLayout: Layout {
    /// Share of the row given to the label. 38% keeps "Discovered"/"Market Cap"
    /// on one line at default text sizes on the narrowest supported iPhone.
    var labelFraction: CGFloat = 0.38
    /// Hard cap so the label column stops growing on iPad / Mac-idiom widths
    /// where 38% would be a canyon.
    var labelColumnCap: CGFloat = 160
    var gutter: CGFloat = 14

    private struct Columns {
        let label: CGFloat
        let value: CGFloat
    }

    private func columns(for width: CGFloat) -> Columns {
        let usable = max(width, 0)
        let label = min(usable * labelFraction, labelColumnCap)
        return Columns(label: label, value: max(usable - label - gutter, 0))
    }

    /// Layout negotiation also asks with `nil`/infinite widths; fall back to the
    /// two ideal widths so those passes get a sane answer instead of `inf`.
    private func resolvedWidth(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGFloat {
        if let width = proposal.width, width.isFinite { return max(width, 0) }
        let label = subviews[0].sizeThatFits(.unspecified).width
        let value = subviews[1].sizeThatFits(.unspecified).width
        return label + gutter + value
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        guard subviews.count == 2 else {
            return CGSize(width: resolvedWidth(proposal, subviews), height: 0)
        }
        let width = resolvedWidth(proposal, subviews)
        let columns = columns(for: width)
        let label = subviews[0].dimensions(in: ProposedViewSize(width: columns.label, height: nil))
        let value = subviews[1].dimensions(in: ProposedViewSize(width: columns.value, height: nil))
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        // Height is measured from the shared baseline, not from the top edges:
        // a two-line label and a one-line value must still sit on the same
        // first baseline and neither may be clipped below it.
        let height = max(
            baseline - label[.firstTextBaseline] + label.height,
            baseline - value[.firstTextBaseline] + value.height
        )
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        guard subviews.count == 2 else { return }
        let columns = columns(for: bounds.width)
        let labelProposal = ProposedViewSize(width: columns.label, height: nil)
        let valueProposal = ProposedViewSize(width: columns.value, height: nil)
        let label = subviews[0].dimensions(in: labelProposal)
        let value = subviews[1].dimensions(in: valueProposal)
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        subviews[0].place(
            at: CGPoint(x: bounds.minX, y: bounds.minY + baseline - label[.firstTextBaseline]),
            anchor: .topLeading,
            proposal: labelProposal
        )
        subviews[1].place(
            at: CGPoint(x: bounds.minX + columns.label + gutter, y: bounds.minY + baseline - value[.firstTextBaseline]),
            anchor: .topLeading,
            proposal: valueProposal
        )
    }

    /// Republishes the row's shared text baseline. Without this a caller that
    /// aligns something beside a `DetailRow` on `.firstTextBaseline` — e.g. the
    /// disclosure chevron in `TradeDetailView.linkedDetailRow` — would fall back
    /// to the row's bottom edge and sit visibly low.
    func explicitAlignment(
        of guide: VerticalAlignment,
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Void
    ) -> CGFloat? {
        guard subviews.count == 2, guide == .firstTextBaseline || guide == .lastTextBaseline else {
            return nil
        }
        let columns = columns(for: bounds.width)
        let label = subviews[0].dimensions(in: ProposedViewSize(width: columns.label, height: nil))
        let value = subviews[1].dimensions(in: ProposedViewSize(width: columns.value, height: nil))
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        if guide == .firstTextBaseline { return bounds.minY + baseline }
        return bounds.minY + max(
            baseline - label[.firstTextBaseline] + label[.lastTextBaseline],
            baseline - value[.firstTextBaseline] + value[.lastTextBaseline]
        )
    }
}

/// Label/value row shared by every detail sheet. See `LedgerRowLayout` for why
/// the geometry is a column pair rather than an `HStack` with a `Spacer`.
struct DetailRow: View {
    let label: String
    let value: String

    /// The cap scales with Dynamic Type: at accessibility sizes a fixed 160pt
    /// column would wrap even short labels to three lines on a wide screen.
    /// It scales identically for every row, so the columns stay aligned.
    @ScaledMetric(relativeTo: .subheadline) private var labelColumnCap: CGFloat = 160

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        LedgerRowLayout(labelColumnCap: labelColumnCap) {
            // No `lineLimit`: the label wraps as far as it needs to. Truncating
            // a label is never acceptable — the reader loses which row they are
            // looking at, which is worse than an extra line.
            Text(label)
                .foregroundStyle(.secondary)
            Text(value)
                .fontWeight(.medium)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

struct NoticeView: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay(AppTheme.border(cornerRadius: 12))
    }
}

struct FeedFreshnessView: View {
    let isOffline: Bool
    let lastRefresh: Date?
    let notice: String?
    let onRetry: () -> Void

    var body: some View {
        if isOffline || notice != nil || lastRefresh != nil {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: isOffline ? "wifi.slash" : "clock.arrow.circlepath")
                    .foregroundStyle(isOffline ? .orange : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    if let notice {
                        Text(notice)
                            .font(.footnote)
                    }
                    if let lastRefresh {
                        Text("Updated \(lastRefresh.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if notice != nil {
                    Button("Retry", action: onRetry)
                        .buttonStyle(.bordered)
                        .clipShape(Capsule())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay(AppTheme.border(cornerRadius: 12))
        }
    }
}

@MainActor
enum DisplayFormatters {
    static let inputDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static let shortDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static let longDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static let currency: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 0
        return formatter
    }()
}

@MainActor
extension Optional where Wrapped == String {
    var shortDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, using: DisplayFormatters.shortDate)
    }

    var longDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, using: DisplayFormatters.longDate)
    }

    private static func format(_ value: String, using output: DateFormatter) -> String {
        let raw = String(value.prefix(10))
        guard let date = DisplayFormatters.inputDate.date(from: raw) else { return value }
        return output.string(from: date)
    }
}

@MainActor
extension ClientTrade {
    /// Compact bracket label, e.g. `$15k - $50k`, `$500k - $1m`.
    var amountLabel: String {
        guard let min = transaction.amountMin else { return "Undisclosed" }
        let low = CompactFormat.usdBracket(min)
        guard let max = transaction.amountMax else { return "\(low)+" }
        let high = CompactFormat.usdBracket(max)
        return "\(low) - \(high)"
    }
}

extension String {
    /// Product labels: Buy / Sell / Exchange. Storage codes remain P|S|E; B is a buy alias.
    var label: String {
        switch self {
        case "S": return "Sell"
        case "B", "P": return "Buy"
        case "E": return "Exchange"
        default: return self
        }
    }

    var tint: Color {
        switch self {
        case "S": return .red
        case "B", "P": return .green
        default: return .blue
        }
    }
}

extension ClientCommand.Status {
    var tint: Color {
        switch self {
        case .queued: return .orange
        case .running: return .blue
        case .succeeded: return .green
        case .failed: return .red
        case .canceled: return .secondary
        }
    }
}

enum AppToolbarPlacement {
    static var trailing: ToolbarItemPlacement {
        #if os(iOS)
        return .topBarTrailing
        #else
        return .automatic
        #endif
    }
}

extension View {
    @ViewBuilder
    func neverAutocapitalized() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder
    func tickerAutocapitalized() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.characters)
        #else
        self
        #endif
    }

    @ViewBuilder
    func urlKeyboard() -> some View {
        #if os(iOS)
        self.keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}

// MARK: - Header chrome (subtle icon buttons + hamburger account menu)

/// The grey the header glyphs actually render in.
///
/// A concrete `Color`, deliberately, not the hierarchical `.secondary`
/// `ShapeStyle`: hierarchical styles resolve against the environment's tint,
/// and `MainTabView` sets `.tint(.blue)` (App.swift), so `.foregroundStyle(.secondary)`
/// inside a toolbar `Button` came back accent blue. That is the fix that was
/// already tried and lost; this one cannot be re-tinted.
private let headerGlyphGrey = Color(uiColor: .secondaryLabel)

/// Subtle header circle button used for the ⓘ / export-arrow controls on
/// Trades and Trends: no tinted stroke (the SF Symbol's own `.circle` glyph
/// already reads as a circle), grey, a slightly larger glyph, and a tap target
/// smaller than the default ~44pt toolbar hit area.
///
/// Grey is defended twice, because one defence has already failed in shipped
/// builds: `.buttonStyle(.plain)` stops the button style re-applying the
/// inherited tint to its label, and `headerGlyphGrey` is a concrete color that
/// nothing downstream can resolve against the accent.
struct HeaderIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                // `.title3` (not a fixed point size) so the "slightly larger"
                // glyph still scales with Dynamic Type.
                .font(.title3.weight(.semibold))
                .foregroundStyle(headerGlyphGrey)
                // minWidth/minHeight (not a fixed frame) so the tap target can
                // grow past 34pt for large Dynamic Type sizes instead of
                // clipping the glyph.
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .tint(headerGlyphGrey)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Header hamburger button (top-right on Trades/Trends) opening
/// `AccountQuickMenu` — mobile-web parity with `.acct-hamburger` /
/// `#acctMobileMenu` in `app/src/ui/dashboardHtml.ts`.
///
/// The menu is a full-height sheet, not the old 290pt popover: everything the
/// account surface has to hold (sign-in, alerts, export, Premium, theme, legal)
/// cannot be read through a letterbox, and a popover on iPhone is a
/// compact-adapted sheet anyway.
struct HamburgerMenuButton: View {
    @State private var showMenu = false

    var body: some View {
        Button {
            showMenu = true
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.title3.weight(.semibold))
                .foregroundStyle(headerGlyphGrey)
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .tint(headerGlyphGrey)
        .accessibilityLabel("Menu")
        .sheet(isPresented: $showMenu) {
            AccountQuickMenu(isPresented: $showMenu)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

/// The account surface behind the header hamburger — everything an account can
/// do, in one full-height sheet: sign in, trade disclosure alerts, CSV export,
/// Premium, theme, legal links, disclaimer.
///
/// It used to be a 290pt popover that could only fit a native Apple button and
/// a "More Sign-In Options" signpost to the Settings tab; Google and magic-link
/// lived only in Settings, so the two surfaces drifted. Sign-in is now one
/// component (`SignInPanel`) used by both, and this sheet has the room to show
/// it.
struct AccountQuickMenu: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.openURL) private var openURL
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @Binding var isPresented: Bool
    @State private var showPremiumInfo = false
    @State private var showExportSheet = false
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    accountSection
                }

                Section {
                    TradeDisclosureAlertsToggle()
                }

                Section {
                    Button {
                        showExportSheet = true
                    } label: {
                        Label("Export CSV", systemImage: "arrow.down.circle")
                    }
                    billingRow
                }

                Section {
                    // No "Theme" caption and no explanation of what Light/Dark
                    // do: the three icons say it (owner: "Don't need bunch of
                    // words on that tab").
                    ThemeSegmentControl(selection: $appColorScheme)
                        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                }

                if store.signedIn || store.hasStoredSessionToken {
                    Section {
                        Button(role: .destructive) {
                            Task { await store.signOut() }
                        } label: {
                            Label(
                                store.isLoggingOut ? "Signing Out…" : "Sign Out",
                                systemImage: "rectangle.portrait.and.arrow.right"
                            )
                        }
                        .disabled(store.isLoggingOut)
                    }
                }

                Section {
                    LegalFooterLinks()
                        .frame(maxWidth: .infinity, alignment: .leading)
                    // Short disclaimer line — mobile-web parity with `.site-footer`.
                    Text("Congress.Trade is an educational tool for public STOCK Act disclosures.  Not financial advice — dollar figures are estimates from disclosed brackets.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Account")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isPresented = false }
                }
            }
        }
        .sheet(isPresented: $showPremiumInfo) {
            PremiumSheet()
                .environmentObject(store)
        }
        .sheet(isPresented: $showExportSheet) {
            // The existing Trades export sheet, presented as-is.
            ExportCSVSheet()
                .environmentObject(store)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        if store.signedIn, let user = store.signedInUser {
            HStack(spacing: 10) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(user.name?.isEmpty == false ? user.name! : user.email)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(store.entitlementLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                }
            }
            .accessibilityElement(children: .combine)
        } else if store.hasStoredSessionToken {
            Text("Session could not be verified.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                Task { await store.refresh() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
        } else {
            SignInPanel(onSignedIn: { isPresented = false })
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        }
    }

    /// Premium entry point. The Manage Subscription path is the pre-existing
    /// `resolveManageSubscriptionURL` routing, preserved exactly; only the
    /// not-yet-premium path changed, from a straight jump into the StoreKit
    /// purchase sheet to `PremiumSheet` (what you get, the plans, a way out).
    @ViewBuilder
    private var billingRow: some View {
        if store.isPremium {
            Button {
                Task { await openManageSubscription() }
            } label: {
                HStack {
                    Label("Manage Subscription", systemImage: "creditcard")
                    if isOpeningManageSubscription {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isOpeningManageSubscription)
            .accessibilityHint(
                store.entitlementSource == "apple"
                    ? "Opens the App Store subscriptions page"
                    : "Opens the Congress.Trade billing portal"
            )
            if let manageSubscriptionError {
                Text(manageSubscriptionError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Button {
                showPremiumInfo = true
            } label: {
                Label("Premium", systemImage: "sparkles")
            }
        }
    }

    /// Routes by `entitlementSource` — see `Store/ManageSubscription.swift`.
    /// A failure stays put and shows `manageSubscriptionError` inline instead
    /// of silently closing on a dead link.
    private func openManageSubscription() async {
        manageSubscriptionError = nil
        isOpeningManageSubscription = true
        defer { isOpeningManageSubscription = false }
        switch await store.resolveManageSubscriptionURL() {
        case .url(let url):
            isPresented = false
            openURL(url)
        case .failed(let message):
            manageSubscriptionError = message
        }
    }
}

// MARK: - Sign-in (one implementation, every surface)

/// The app's single sign-in stack: native Apple button, Google button, magic
/// link — plus the account notice, which is the part that was missing.
///
/// Every failure path in `Store/AppleSignIn.swift` already writes
/// `setAccountNotice`, but the hamburger popover rendered no notice at all, so
/// a failed Apple sign-in there did nothing visible and looked like a dead
/// button. The notice is part of this component precisely so no surface can
/// adopt sign-in and forget to show why it failed.
struct SignInPanel: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.colorScheme) private var colorScheme
    /// Raw nonce for the in-flight Sign in with Apple request, set by the
    /// button's request-configuration closure and consumed by
    /// `handleAppleSignIn` on completion. See `Store/AppleSignIn.swift`.
    @State private var currentAppleNonce: String?
    @State private var isAuthenticatingWithGoogle = false
    @State private var magicEmail = ""
    @FocusState private var magicEmailFocused: Bool

    /// Fired once a session token has actually been stored — used by sheets
    /// that should close themselves on success.
    var onSignedIn: () -> Void = {}

    var body: some View {
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
                    // `signedIn` only flips after the bootstrap refresh that
                    // `saveSessionToken` kicks off, so success is measured on
                    // the token landing, not on the user object arriving.
                    let hadToken = store.hasStoredSessionToken
                    await store.handleAppleSignIn(result, rawNonce: currentAppleNonce)
                    currentAppleNonce = nil
                    if store.hasStoredSessionToken, !hadToken { onSignedIn() }
                }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityLabel("Sign in with Apple")

            GoogleSignInButton(isBusy: isAuthenticatingWithGoogle) {
                startGoogleSignIn()
            }

            HStack(spacing: 8) {
                // `verbatim:` is load-bearing. A string LITERAL passed to
                // `Text`/`TextField` is a `LocalizedStringKey`, which SwiftUI
                // parses as Markdown — and Markdown autolinks a bare email
                // address, so `"you@example.com"` rendered as a link in the
                // accent color. It looked like the tint leak that grey-ed the
                // header glyphs, but it is not: `.foregroundStyle` on the
                // field, a `prompt:` styled `.secondary`, a `prompt:` styled
                // with a concrete color, dropping `.roundedBorder`, and
                // overriding `.tint` were all tried on device and all stayed
                // blue, because link styling outranks every one of them.
                // Not parsing it as Markdown is the fix.
                TextField(
                    "",
                    text: $magicEmail,
                    prompt: Text(verbatim: "you@example.com")
                )
                    .foregroundStyle(Color.primary)
                    .accessibilityLabel("Email address")
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
                .buttonStyle(.bordered)
                .disabled(magicEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            // The keyboard-dismiss bar travels with the field it serves, so it
            // works from Settings and from the account sheet alike.
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { magicEmailFocused = false }
                }
            }

            if let notice = store.watchlistNotice, !notice.isEmpty {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isStaticText)
            }
        }
    }

    /// Google OAuth via `ASWebAuthenticationSession`, the app's only copy.
    /// Lived in `SettingsView` before, which is why the hamburger could not
    /// offer Google at all.
    private func startGoogleSignIn() {
        guard !isAuthenticatingWithGoogle else { return }

        // Honor the configured API base URL (CONGRESS_TRADE_API_BASE_URL) so
        // non-prod backends get the OAuth round trip too.
        var components = URLComponents(
            url: store.api.origin.appendingPathComponent("auth/google/start"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "client", value: "ios")]
        guard let authURL = components?.url else {
            store.setAccountNotice("Google sign-in is not configured for this build.")
            return
        }
        isAuthenticatingWithGoogle = true

        let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: "congresstrade") { callbackURL, error in
            Task { @MainActor in
                GoogleAuthSession.current = nil
                isAuthenticatingWithGoogle = false
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

                if store.saveSessionToken(token) { onSignedIn() }
            }
        }

        session.presentationContextProvider = AuthPresentationContext.shared
        // Must outlive `start()` — see `GoogleAuthSession`.
        GoogleAuthSession.current = session
        if !session.start() {
            GoogleAuthSession.current = nil
            isAuthenticatingWithGoogle = false
            store.setAccountNotice("Google sign-in could not start.")
        }
    }
}

/// Google-branded sign-in button at Apple-button parity: 50pt tall, 8pt
/// continuous radius, full width, multicolor G, and Google's own surface /
/// border / label colors for each appearance (light `#FFFFFF` / `#747775` /
/// `#1F1F1F`, dark `#131314` / `#8E918F` / `#E3E3E3`).
///
/// `.buttonStyle(.plain)` is load-bearing, not decoration: inside a `Form` row
/// the row's accent tint repainted the entire label — mark and text — accent
/// blue, which is the "Google button renders all blue" report.
struct GoogleSignInButton: View {
    var isBusy: Bool = false
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var surface: Color {
        colorScheme == .dark
            ? Color(red: 0x13 / 255, green: 0x13 / 255, blue: 0x14 / 255)
            : .white
    }

    private var stroke: Color {
        colorScheme == .dark
            ? Color(red: 0x8E / 255, green: 0x91 / 255, blue: 0x8F / 255)
            : Color(red: 0x74 / 255, green: 0x77 / 255, blue: 0x75 / 255)
    }

    private var label: Color {
        colorScheme == .dark
            ? Color(red: 0xE3 / 255, green: 0xE3 / 255, blue: 0xE3 / 255)
            : Color(red: 0x1F / 255, green: 0x1F / 255, blue: 0x1F / 255)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                GoogleMark()
                    .frame(width: 20, height: 20)
                // System font, not the app's Zilla Slab body font: Google's
                // brand guidance is a neutral sans for the button label.
                Text(isBusy ? "Opening Google…" : "Sign in with Google")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(label)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(stroke, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .tint(label)
        .disabled(isBusy)
        .accessibilityLabel("Sign in with Google")
    }
}

/// Multicolor "G" mark. Canvas' y-axis points down, so these angles read
/// clockwise on screen: blue at 3 o'clock plus the crossbar, green sweeping the
/// bottom, yellow up the left, red across the top — the Google order.
struct GoogleMark: View {
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

// MARK: - Trade disclosure alerts

/// The device-notification switch, in the owner's words rather than the
/// platform's: "Trade Disclosure Alerts", one sentence-case status line, and
/// no "APNs" anywhere on screen.
///
/// The switch reflects the *system* permission, which the app can grant-request
/// but never revoke — so "off" and a denied permission both route to iOS
/// Settings rather than flipping a switch that would silently do nothing.
struct TradeDisclosureAlertsToggle: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var pushManager: PushNotificationManager
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle("Trade Disclosure Alerts", isOn: Binding(
                get: { pushManager.isAuthorized },
                set: { wantsOn in Task { await setEnabled(wantsOn) } }
            ))

            HStack(spacing: 10) {
                Text(statusLine)
                    .font(.caption)
                    .foregroundStyle(statusColor)
                    .fixedSize(horizontal: false, vertical: true)
                if showsRetry {
                    Button("Retry") {
                        Task { await pushManager.syncTokenWithBackend(api: store.api, force: true) }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
                }
            }
        }
        // The status is only trustworthy if it is re-read after the user has
        // been to iOS Settings and come back.
        .task { await pushManager.checkPermissionStatus() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await pushManager.checkPermissionStatus() }
        }
    }

    private var showsRetry: Bool {
        pushManager.isAuthorized && store.signedIn && pushManager.lastError != nil
    }

    /// Secondary status lines are sentence case per `FLEET-UI-COPY.md`.
    private var statusLine: String {
        if pushManager.authorizationStatus == .denied {
            return "turned off for this app in iOS Settings — tap to open"
        }
        if !pushManager.isAuthorized {
            return "not enabled on this device"
        }
        if !store.signedIn {
            return "sign in to receive alerts on this device"
        }
        if pushManager.isBackendSynced {
            return "this device is registered"
        }
        if pushManager.isRegistering {
            return "registering this device…"
        }
        if pushManager.lastError != nil {
            return "registration failed"
        }
        return "waiting to register this device"
    }

    private var statusColor: Color {
        if pushManager.isAuthorized, store.signedIn {
            if pushManager.isBackendSynced { return .green }
            if pushManager.lastError != nil { return .red }
        }
        return .secondary
    }

    private func setEnabled(_ on: Bool) async {
        switch pushManager.authorizationStatus {
        case .notDetermined:
            guard on else { return }
            await pushManager.requestAuthorization()
            if pushManager.isAuthorized, store.signedIn {
                await pushManager.syncTokenWithBackend(api: store.api)
            }
        case .denied:
            // Never pretend: the app cannot re-enable a denied permission.
            openSystemNotificationSettings()
        default:
            if on {
                if store.signedIn {
                    await pushManager.syncTokenWithBackend(api: store.api, force: true)
                }
            } else {
                openSystemNotificationSettings()
            }
        }
    }

    private func openSystemNotificationSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

// MARK: - Footer + filter chrome

/// Small grey Privacy / Terms / Pricing / Support row for the bottom of a tab.
///
/// Buttons rather than `Link`s: a `Link` renders in the accent color and this
/// row must stay quiet chrome, not four blue calls to action.
struct LegalFooterLinks: View {
    @Environment(\.openURL) private var openURL

    private struct Destination: Identifiable {
        let id = UUID()
        let title: String
        let url: URL
    }

    private let destinations: [Destination] = [
        .init(title: "Privacy", url: URL(string: "https://Congress.Trade/privacy-policy")!),
        .init(title: "Terms", url: URL(string: "https://Congress.Trade/terms-of-service")!),
        .init(title: "Pricing", url: URL(string: "https://Congress.Trade/pricing")!),
        .init(title: "Support", url: URL(string: "mailto:congress.trade@jays.services")!),
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(destinations.enumerated()), id: \.element.id) { index, destination in
                if index > 0 {
                    Text("  •  ")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                Button(destination.title) { openURL(destination.url) }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                    .tint(Color(uiColor: .secondaryLabel))
            }
        }
    }
}

/// Spinner that occupies its slot whether or not it is spinning, so a filter
/// strip does not grow a row (and shove everything below it down) the moment a
/// query starts.
struct FilterActivityIndicator: View {
    let isActive: Bool

    var body: some View {
        ProgressView()
            .controlSize(.small)
            .opacity(isActive ? 1 : 0)
            // Constant footprint — the reserved height is the whole point.
            .frame(width: 18, height: 18)
            .accessibilityHidden(!isActive)
            .accessibilityLabel("Updating")
    }
}

// MARK: - Theme segment (pictographic, matches web + ST console)

/// Light / Dark / System control with SF Symbol icons — same pattern as
/// Congress.Trade `theme-seg` and Socratic console (Sun / Moon / Monitor).
/// Labels use Title Case per `/Users/jay/apps/FLEET-UI-COPY.md`.
struct ThemeSegmentControl: View {
    @Binding var selection: String

    private struct Option: Identifiable {
        let id: String
        let label: String
        let systemImage: String
    }

    private let options: [Option] = [
        .init(id: "light", label: "Light", systemImage: "sun.max"),
        .init(id: "dark", label: "Dark", systemImage: "moon"),
        .init(id: "system", label: "System", systemImage: "desktopcomputer"),
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { option in
                Button {
                    selection = option.id
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: option.systemImage)
                            .font(.system(size: 13, weight: .semibold))
                        Text(option.label)
                            .font(.caption.weight(selection == option.id ? .semibold : .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(selection == option.id ? Color.primary : Color.secondary)
                    .background {
                        if selection == option.id {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color(uiColor: .secondarySystemGroupedBackground))
                                .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
                        }
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(
                                selection == option.id ? Color(uiColor: .separator) : Color.clear,
                                lineWidth: 1
                            )
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Set Theme To \(option.label)")
                .accessibilityAddTraits(selection == option.id ? [.isSelected] : [])
            }
        }
        .padding(3)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Theme")
    }
}
