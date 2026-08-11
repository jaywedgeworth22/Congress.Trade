import AuthenticationServices
import SwiftUI

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

// Helper for Party Emojis
extension String {
    var partyEmoji: String {
        switch self.lowercased() {
        case "democrat", "dem", "d": return "🫏"
        case "republican", "rep", "r": return "🐘"
        default: return "🦅" // Independent/Other
        }
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
/// Fleet UI copy: lowercase suffixes `$15k`, `$99.8k`, `$1.2m`, `$3.4b`.
enum CompactFormat {
    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let absV = abs(value)
        let sign = value < 0 ? "-" : ""
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

struct DetailRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer(minLength: 18)
            Text(value)
                .multilineTextAlignment(.trailing)
                .fontWeight(.medium)
        }
        .font(.subheadline)
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

/// Subtle header circle button used for the ⓘ / export-arrow controls on
/// Trades and Trends: no tinted stroke (the SF Symbol's own `.circle` glyph
/// already reads as a circle), grey secondary color, a slightly larger glyph,
/// and a tap target smaller than the default ~44pt toolbar hit area.
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
                .foregroundStyle(.secondary)
                // minWidth/minHeight (not a fixed frame) so the tap target can
                // grow past 34pt for large Dynamic Type sizes instead of
                // clipping the glyph.
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Header hamburger button (top-right on Trades/Trends) opening
/// `AccountQuickMenu` — mobile-web parity with `.acct-hamburger` /
/// `#acctMobileMenu` in `app/src/ui/dashboardHtml.ts`.
struct HamburgerMenuButton: View {
    @State private var showMenu = false

    var body: some View {
        Button {
            showMenu = true
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        .accessibilityLabel("Menu")
        .popover(isPresented: $showMenu) {
            AccountQuickMenu(isPresented: $showMenu)
                .presentationCompactAdaptation(.popover)
        }
    }
}

/// Compact account/theme/upgrade dropdown — mobile-web parity with the
/// hamburger's `#acctMobileMenu` content (Sign In/account, theme picker,
/// Upgrade or Manage Subscription, Sign Out) plus the short site-footer
/// disclaimer line. Sign in with Apple is native (no browser hop), so it's
/// offered right here; Google + magic-link still route to the Settings tab
/// instead of duplicating that browser-based OAuth flow in a popover.
struct AccountQuickMenu: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var tabRouter: TabRouter
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @Binding var isPresented: Bool
    @State private var showSubscribe = false
    /// Raw nonce for the in-flight Sign in with Apple request, set by the
    /// button's request-configuration closure and consumed by
    /// `handleAppleSignIn` on completion. See `Store/AppleSignIn.swift`.
    @State private var currentAppleNonce: String?
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            accountSection

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Theme")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                ThemeSegmentControl(selection: $appColorScheme)
            }

            if store.signedIn {
                Divider()
                billingButton
                Divider()
                Button(role: .destructive) {
                    isPresented = false
                    Task { await store.signOut() }
                } label: {
                    Label(
                        store.isLoggingOut ? "Signing Out…" : "Sign Out",
                        systemImage: "rectangle.portrait.and.arrow.right"
                    )
                    .font(.subheadline.weight(.medium))
                }
                .disabled(store.isLoggingOut)
            }

            Divider()

            // Short disclaimer line — mobile-web parity with `.site-footer`.
            Text("Congress.Trade is an educational tool for public STOCK Act disclosures. Not financial advice — dollar figures are estimates from disclosed brackets.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(width: 290)
        .sheet(isPresented: $showSubscribe) {
            SubscribeView()
                .environmentObject(store)
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
        } else {
            VStack(alignment: .leading, spacing: 8) {
                SignInWithAppleButton(.signIn) { request in
                    // Match SettingsView: name + email scopes + nonce.
                    request.requestedScopes = [.fullName, .email]
                    let nonce = AppleSignInNonce.generate()
                    currentAppleNonce = nonce
                    request.nonce = nonce
                } onCompletion: { result in
                    Task {
                        await store.handleAppleSignIn(result, rawNonce: currentAppleNonce)
                        currentAppleNonce = nil
                        if store.signedIn { isPresented = false }
                    }
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                // 48pt matches Settings' ST-parity Apple button height.
                .frame(height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel("Sign in with Apple")

                Button {
                    isPresented = false
                    tabRouter.selection = .settings
                } label: {
                    Label("More Sign-In Options", systemImage: "person.crop.circle")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private var billingButton: some View {
        if store.isPremium {
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    Task { await openManageSubscription() }
                } label: {
                    HStack {
                        Label("Manage Subscription", systemImage: "creditcard")
                            .font(.subheadline.weight(.medium))
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
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else {
            Button {
                isPresented = false
                showSubscribe = true
            } label: {
                Label("Upgrade to Premium", systemImage: "sparkles")
                    .font(.subheadline.weight(.medium))
            }
        }
    }

    /// Routes by `entitlementSource` — see `Store/ManageSubscription.swift`.
    /// Only dismisses the popover once a URL is actually opened; a failure
    /// stays put and shows `manageSubscriptionError` inline instead of
    /// silently closing on a dead link.
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

// ==== TEMPORARY LOCAL BUILD STAND-INS (Lane 2 owns the real ones) ====
struct LegalFooterLinks: View {
    var body: some View {
        Text("[Privacy](https://Congress.Trade/privacy-policy)  •  [Terms](https://Congress.Trade/terms-of-service)")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .tint(Color.secondary)
            .frame(maxWidth: .infinity)
    }
}

struct FilterActivityIndicator: View {
    let isActive: Bool
    var body: some View {
        HStack(spacing: 6) {
            if isActive {
                ProgressView().controlSize(.mini)
                Text("Updating results…").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(height: 18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct TradeDisclosureAlertsToggle: View {
    @EnvironmentObject private var pushManager: PushNotificationManager
    var body: some View {
        Toggle("Trade Disclosure Alerts", isOn: .constant(pushManager.isAuthorized))
    }
}
