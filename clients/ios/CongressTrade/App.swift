import SwiftUI
import SwiftData
import OSLog
import StoreKit

/// Tab identity shared with `TabRouter` so any screen can programmatically
/// switch tabs.
/// Order matches `MainTabView`: Trends | Trades | Directory | Delivery
/// (owner punch list #2, item 9 — Directory inserted between Trades and
/// Delivery).  There is no Settings tab: account, alerts, theme, export and
/// legal all live in the header hamburger's `AccountQuickMenu`, which is a
/// strict superset of the old tab.
enum AppTab: Hashable {
    case trends, trades, people, delivery
}

/// Cross-tab navigation for any screen that needs to move the user to another
/// tab.  Trends is the default/leftmost tab (owner punch list item 1).
@MainActor
final class TabRouter: ObservableObject {
    @Published var selection: AppTab =
        ProcessInfo.processInfo.arguments.contains("-startOnTrades") ? .trades : .trends
}

@main
struct CongressTradeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())
    @StateObject private var pushManager = PushNotificationManager.shared
    @StateObject private var tabRouter = TabRouter()
    @AppStorage("app_color_scheme") private var appColorScheme = "light"

    /// Built once, eagerly, instead of via `.modelContainer(for: ClientTrade.self)`
    /// — that convenience modifier has no error path and no recovery, so a store
    /// the current build cannot read takes the whole app down. See
    /// `makeTradeCacheContainer()`.
    private let tradeCacheContainer = CongressTradeApp.makeTradeCacheContainer()

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(store)
                .environmentObject(pushManager)
                .environmentObject(tabRouter)
                .modifier(CTPaletteInjector(pref: appColorScheme))
                .preferredColorScheme(colorScheme)
                .font(.custom("ZillaSlab-Regular", size: 17, relativeTo: .body))
                .onAppear { AppAppearance.apply(appColorScheme) }
                .onChange(of: appColorScheme) { _, pref in
                    AppAppearance.apply(pref)
                }
                .appUpdatePrompt()
        }
        .modelContainer(tradeCacheContainer)
    }

    private var colorScheme: ColorScheme? {
        switch appColorScheme {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

// MARK: - Trade cache container

/// Opening and, when necessary, discarding the local `ClientTrade` cache.
///
/// This store is a **pure cache** of `GET /api/client/v1/feed`: the only writer
/// is `CongressTradeStore.replaceCache`, the only reader is
/// `FeedDashboardView`'s `@Query`, and every durable preference (watchlist,
/// delivery, entitlement) lives server-side. Nothing in it is user-authored, so
/// throwing it away costs one refetch — which makes "discard and refetch" the
/// correct answer to *any* doubt about the store, and makes crashing on a stale
/// one indefensible.
///
/// Four crash reports from 2026-08-10 (`~/Library/Logs/DiagnosticReports`) show
/// the failure this replaces: `EXC_BREAKPOINT` in `_assertionFailure`, three
/// SwiftData frames, then `ClientTrade.storedAsset.getter` under
/// `TradeCard.body`. Install succeeds; the first paint of a cached Trades row
/// kills the process, every launch, forever.
extension CongressTradeApp {
    private static let logger = Logger(subsystem: "trade.congress.ios", category: "tradecache")

    /// Opens the cache, in descending order of preference:
    ///
    /// 1. **Prevent.** Compare the persisted shape stamp with
    ///    `ClientTradeCacheSchema.identity` and delete the store on any
    ///    mismatch, *before* SwiftData can fault a row out of it.
    /// 2. **Break the loop.** A probe marker is written before the first read
    ///    and cleared only after it succeeds. A launch that finds the marker
    ///    still set knows the previous launch died mid-read and wipes. This is
    ///    what covers a shape change the stamp fails to notice: the crash
    ///    happens at most once instead of on every launch forever.
    /// 3. **Recover.** If the open throws, wipe and retry once.
    /// 4. **Degrade, never refuse.** If it throws again, run on an in-memory
    ///    container: the app works and refetches on every launch, which is far
    ///    better than an app that will not start.
    static func makeTradeCacheContainer() -> ModelContainer {
        let schema = Schema([ClientTrade.self])
        let configuration = ModelConfiguration(schema: schema)
        let storeURL = configuration.url
        let currentIdentity = ClientTradeCacheSchema.identity
        let stampURL = cacheStampURL(besides: storeURL)
        let probeURL = probeMarkerURL(besides: storeURL)

        // Step 1/2 — decide whether this store is safe to open at all.
        if FileManager.default.fileExists(atPath: probeURL.path) {
            logger.error("cache: previous launch did not survive its first read — wiping")
            wipeTradeCache(at: storeURL)
        } else {
            let persistedIdentity = try? String(contentsOf: stampURL, encoding: .utf8)
            if persistedIdentity != currentIdentity {
                logger.notice("""
                    cache: persisted shape \(persistedIdentity ?? "<none>", privacy: .public) \
                    != current \(currentIdentity, privacy: .public) — wiping
                    """)
                wipeTradeCache(at: storeURL)
            }
        }

        // The marker has to reach disk before the first fault, or the launch it
        // is meant to describe leaves no trace.
        writeMarker(at: probeURL)
        try? currentIdentity.write(to: stampURL, atomically: true, encoding: .utf8)

        // Step 3 — open, wipe-and-retry, then degrade.
        var container: ModelContainer
        do {
            container = try ModelContainer(for: schema, configurations: configuration)
        } catch {
            logger.error("cache: open failed (\(error.localizedDescription, privacy: .public)) — wiping and retrying")
            wipeTradeCache(at: storeURL)
            do {
                container = try ModelContainer(for: schema, configurations: configuration)
            } catch {
                logger.fault("""
                    cache: reopen failed (\(error.localizedDescription, privacy: .public)) \
                    — running in memory, every launch will refetch
                    """)
                try? FileManager.default.removeItem(at: probeURL)
                return makeInMemoryTradeCacheContainer()
            }
        }

        probeTradeCache(container, storeURL: storeURL)
        try? FileManager.default.removeItem(at: probeURL)
        return container
    }

    /// Faults every cached row's composite properties once, here at launch,
    /// while the probe marker is on disk.
    ///
    /// This is deliberate, and it is the honest answer to "guard the per-row
    /// failure": **a Swift-level guard cannot intercept it.** The failure is
    /// `_assertionFailure` inside SwiftData — a runtime trap, not a thrown error
    /// and not an ObjC exception — so `try?`, `catch` and any top-level handler
    /// are all powerless, and the standalone repro confirms the container opens
    /// and the fetch succeeds before the getter traps. What *can* be controlled
    /// is where the trap lands. Pulling it forward to a point where a marker is
    /// on disk converts an unrecoverable crash loop into one crash followed by
    /// an automatic wipe, which the stamp in step 1 should already have made
    /// unnecessary.
    ///
    /// Cost is one fetch of at most `cacheLimit` (400) small rows.
    private static func probeTradeCache(_ container: ModelContainer, storeURL: URL) {
        let context = ModelContext(container)
        guard let rows = try? context.fetch(FetchDescriptor<ClientTrade>()) else {
            logger.error("cache: probe fetch failed — leaving the store in place, next launch will wipe")
            return
        }
        // Summed rather than discarded so the optimiser cannot drop the faults.
        var faulted = 0
        for row in rows {
            faulted += row.storedMember == nil ? 0 : 1
            faulted += row.storedAsset == nil ? 0 : 1
            faulted += row.storedTransaction == nil ? 0 : 1
            faulted += row.storedFiling == nil ? 0 : 1
            faulted += row.source == nil ? 0 : 1
        }
        logger.notice("cache: opened \(storeURL.lastPathComponent, privacy: .public), \(rows.count) row(s), \(faulted) propert(ies) faulted")
    }

    private static func makeInMemoryTradeCacheContainer() -> ModelContainer {
        do {
            return try ModelContainer(
                for: Schema([ClientTrade.self]),
                configurations: ModelConfiguration(isStoredInMemoryOnly: true)
            )
        } catch {
            // One entity, no file system, nothing to migrate. If SwiftData cannot
            // build this there is no container to hand SwiftUI and no screen to
            // show an error on.
            fatalError("SwiftData cannot create an in-memory container for ClientTrade: \(error)")
        }
    }

    /// SQLite keeps its write-ahead log and shared-memory index beside the store;
    /// deleting only `default.store` leaves committed rows in `-wal` that the
    /// next open replays straight back into the poisoned state.
    private static func wipeTradeCache(at storeURL: URL) {
        for suffix in ["", "-wal", "-shm"] {
            let url = URL(fileURLWithPath: storeURL.path + suffix)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                logger.error("cache: could not delete \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private static func cacheStampURL(besides storeURL: URL) -> URL {
        URL(fileURLWithPath: storeURL.path + ".shape")
    }

    private static func probeMarkerURL(besides storeURL: URL) -> URL {
        URL(fileURLWithPath: storeURL.path + ".probe")
    }

    /// SwiftData creates the store's directory on first open, so on a clean
    /// install the marker would otherwise have nowhere to go.
    private static func writeMarker(at url: URL) {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? Data().write(to: url, options: .atomic)
    }
}

struct MainTabView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var tabRouter: TabRouter
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    @State private var showSubscribeSheet = CommandLine.arguments.contains("-screenshotPaywall") || CommandLine.arguments.contains("-showSubscribe")

    var body: some View {
        TabView(selection: $tabRouter.selection) {
            // Trends is first/leftmost and the default tab on launch
            // (TabRouter.selection starts at .trends).
            TrendsView()
                .tabItem {
                    Label("Trends", systemImage: "chart.line.uptrend.xyaxis")
                }
                .tag(AppTab.trends)

            FeedDashboardView()
                .tabItem {
                    Label("Trades", systemImage: "list.bullet.rectangle")
                }
                .tag(AppTab.trades)

            PeopleDirectoryView()
                .tabItem {
                    Label("Directory", systemImage: "person.2")
                }
                .tag(AppTab.people)

            DeliveryView()
                .tabItem {
                    Label("Delivery", systemImage: "bell.badge")
                }
                .tag(AppTab.delivery)
        }
        .tint(.blue)
        .toolbarBackground(.ultraThinMaterial, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .environment(\.openPremium) { showSubscribeSheet = true }
        .sheet(isPresented: $showSubscribeSheet) {
            PremiumSheet()
                .environmentObject(store)
        }
        // Truth-table row 4 (owner directive 2026-08-21): a signed-in
        // account whose device already holds an UNCLAIMED Apple purchase is
        // asked once — never linked silently — whether to link it. "Not
        // now" (`dismissAppleLinkPrompt`) remembers per account so this does
        // not reappear on every launch; the Link action itself stays
        // available afterward from the Premium sheet and Restore Purchases.
        .alert(
            "Link This Subscription?",
            isPresented: Binding(get: { store.showsAppleLinkOffer }, set: { _ in })
        ) {
            Button("Not Now", role: .cancel) { store.dismissAppleLinkPrompt() }
            Button("Link") { Task { await store.linkAppleEntitlementToCurrentAccount() } }
        } message: {
            Text("This device already has an active Congress.Trade Premium subscription through the App Store.  "
                + "Link it to your account to use it on the website and your other devices too.")
        }
        // StoreKit 2 requires a listener for the whole app lifetime: Ask to Buy
        // approvals, renewals, and retries of a redeem that failed mid-purchase
        // all arrive here and nowhere else. See Store/AppleIAP.swift.
        .task {
            await store.observeAppleTransactions()
        }
        .onAppear {
            if CommandLine.arguments.contains("-screenshotPaywall") || CommandLine.arguments.contains("-showSubscribe") {
                showSubscribeSheet = true
            }
        }
        .task {
            store.modelContext = modelContext
            if store.feed == nil {
                await store.refresh()
            }
            // Catch-up for a purchase that was charged and finished locally but
            // never recorded server-side. No-op for everyone already Premium.
            await store.reconcileAppleEntitlementsQuietly()
        }
        // Pause the nextPollAfterSec poll loop while backgrounded.
        .onChange(of: scenePhase) { _, phase in
            store.setAutoRefreshPaused(phase != .active)
        }
        // congresstrade:// deep links. The auth callback
        // (congresstrade://auth?token=…) arrives here on cold opens
        // while ASWebAuthenticationSession intercepts it for in-app OAuth.
        .onOpenURL { url in
            // Only accept session handoff on congresstrade://auth?token=…
            // (never any arbitrary deep link that happens to carry ?token=).
            guard url.scheme?.lowercased() == "congresstrade" else { return }
            let host = (url.host ?? "").lowercased()
            guard host == "auth" || host.isEmpty && url.path.contains("auth") else { return }
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
                  !token.isEmpty else { return }
            _ = store.saveSessionToken(token)
        }
    }
}

// MARK: - AppUpdatePrompt (canonical: /Users/jay/apps/ios-fleet/AppUpdatePrompt.swift)
//
//  AppUpdatePrompt.swift
//
//  Portable first-launch update check for every fleet iOS app.
//  Canonical copy: /Users/jay/apps/ios-fleet/AppUpdatePrompt.swift
//  Copy this file into each app target.  Do not fork behavior.
//
//  On the first scene of a cold launch the app:
//    1. Detects Xcode / TestFlight / App Store (StoreKit AppTransaction).
//    2. Reads the latest marketing version from the public fleet manifest
//       (TestFlight source of truth) and the iTunes Lookup API (App Store).
//    3. If the installed version is older, asks whether to update.
//    4. Update opens TestFlight (itms-beta) or the App Store (itms-apps).
//
//  DEBUG / Xcode / screenshot launches stay silent.  "Not Now" skips that
//  version until a newer one appears.  Failures are silent (no network
//  error alerts).  No secrets are fetched or stored.
//

enum AppUpdatePrompt {

    static let defaultManifestURL = URL(
        string: "https://raw.githubusercontent.com/jaywedgeworth22/ios-app-versions/main/versions.json"
    )!

    /// Numeric Apple IDs for TestFlight / App Store deep links.
    /// Keep in sync with /Users/jay/apps/ios-fleet/apps.json.
    static let knownAppleIds: [String: Int] = [
        "trade.socratic.app": 6_799_238_379,
        "trade.congress.ios": 6_798_076_688,
        "services.jays.usage.client.monitor": 6_799_230_435,
        "services.jays.usage.local.monitor": 6_799_230_729,
        "online.dealdex": 6_802_474_288,
    ]

    private static let skippedVersionKeyPrefix = "appUpdatePrompt.skippedVersion."

    struct Config: Equatable {
        var bundleId: String
        var appleId: Int?
        var manifestURL: URL
        var currentMarketingVersion: String
        var currentBuild: String

        static func fromBundle(_ bundle: Bundle = .main) -> Config {
            let info = bundle.infoDictionary ?? [:]
            let bundleId = bundle.bundleIdentifier ?? ""
            let plistAppleId = intValue(info["AppUpdateAppleId"])
            let manifest = (info["AppUpdateManifestURL"] as? String)
                .flatMap(URL.init(string:)) ?? AppUpdatePrompt.defaultManifestURL
            return Config(
                bundleId: bundleId,
                appleId: plistAppleId ?? knownAppleIds[bundleId],
                manifestURL: manifest,
                currentMarketingVersion: (info["CFBundleShortVersionString"] as? String) ?? "0",
                currentBuild: (info["CFBundleVersion"] as? String) ?? "0"
            )
        }
    }

    struct Version: Comparable, Equatable, CustomStringConvertible {
        let raw: String
        let parts: [Int]

        var description: String { raw }

        init(_ raw: String) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            self.raw = trimmed
            self.parts = trimmed.split(separator: ".", omittingEmptySubsequences: true).map { segment in
                Int(segment.filter(\.isNumber)) ?? 0
            }
        }

        static func == (lhs: Version, rhs: Version) -> Bool {
            !(lhs < rhs) && !(rhs < lhs)
        }

        static func < (lhs: Version, rhs: Version) -> Bool {
            let count = max(lhs.parts.count, rhs.parts.count)
            for index in 0..<count {
                let left = index < lhs.parts.count ? lhs.parts[index] : 0
                let right = index < rhs.parts.count ? rhs.parts[index] : 0
                if left != right { return left < right }
            }
            return false
        }
    }

    enum Channel: Equatable {
        case xcode
        case testFlight
        case appStore
        case unknown
    }

    struct Offer: Equatable {
        var latestVersion: String
        var currentVersion: String
        var channel: Channel
        var storeURL: URL
        var fallbackURL: URL

        var message: String {
            "Version \(latestVersion) is available.\u{00A0} You have \(currentVersion)."
        }
    }

    static var shouldSkipLaunchChecks: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["APP_UPDATE_PROMPT_FORCE"] != "1" {
            return true
        }
        #endif
        let process = ProcessInfo.processInfo
        if process.arguments.contains("-ASCScreenshots") { return true }
        if process.arguments.contains("-ScreenshotDemo") { return true }
        if process.environment["ASC_SCREENSHOTS"] == "1" { return true }
        if UserDefaults.standard.bool(forKey: "ascScreenshots") { return true }
        return false
    }

    static func detectChannel() async -> Channel {
        do {
            let result = try await AppTransaction.shared
            switch result {
            case .verified(let transaction):
                switch transaction.environment {
                case .xcode: return .xcode
                case .sandbox: return .testFlight
                case .production: return .appStore
                default: break
                }
            case .unverified:
                break
            }
        } catch {
            // Fall through to the receipt path.  StoreKit is unavailable in
            // some simulator / unsigned CI builds.
        }
        return receiptChannel()
    }

    static func receiptChannel() -> Channel {
        guard let receiptURL = Bundle.main.appStoreReceiptURL else { return .unknown }
        if receiptURL.lastPathComponent == "sandboxReceipt" {
            return .testFlight
        }
        if FileManager.default.fileExists(atPath: receiptURL.path) {
            return .appStore
        }
        return .unknown
    }

    static func isNewer(latestMarketing: String, latestBuild: String?, currentMarketing: String, currentBuild: String) -> Bool {
        let latest = Version(latestMarketing)
        let current = Version(currentMarketing)
        if latest > current { return true }
        if latest < current { return false }
        guard let latestBuild, !latestBuild.isEmpty else { return false }
        return Version(latestBuild) > Version(currentBuild)
    }

    static func skippedVersion(for bundleId: String, defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: skippedVersionKeyPrefix + bundleId)
    }

    static func rememberSkip(version: String, bundleId: String, defaults: UserDefaults = .standard) {
        defaults.set(version, forKey: skippedVersionKeyPrefix + bundleId)
    }

    static func storeURLs(channel: Channel, appleId: Int, testFlightURL: String?, appStoreURL: String?) -> (primary: URL, fallback: URL)? {
        switch channel {
        case .testFlight, .unknown:
            let primary = testFlightURL.flatMap(URL.init(string:))
                ?? URL(string: "itms-beta://beta.itunes.apple.com/v1/app/\(appleId)")
            let fallback = URL(string: "https://beta.itunes.apple.com/v1/app/\(appleId)")
            if let primary, let fallback { return (primary, fallback) }
            return nil
        case .appStore, .xcode:
            let primary = appStoreURL.flatMap(URL.init(string:))
                ?? URL(string: "itms-apps://itunes.apple.com/app/id\(appleId)")
            let fallback = URL(string: "https://apps.apple.com/app/id\(appleId)")
            if let primary, let fallback { return (primary, fallback) }
            return nil
        }
    }

    static func evaluate(
        config: Config,
        channel: Channel,
        manifest: ManifestFile?,
        lookup: LookupFile?
    ) -> Offer? {
        guard channel != .xcode else { return nil }

        let entry = manifest?.apps[config.bundleId]
        let lookupResult = lookup?.results.first

        let latestMarketing: String?
        switch channel {
        case .appStore:
            latestMarketing = lookupResult?.version ?? entry?.marketingVersion
        case .testFlight, .unknown:
            latestMarketing = entry?.marketingVersion ?? lookupResult?.version
        case .xcode:
            return nil
        }

        guard let latestMarketing, !latestMarketing.isEmpty else { return nil }
        let latestBuild = entry?.build
        guard isNewer(
            latestMarketing: latestMarketing,
            latestBuild: channel == .appStore ? nil : latestBuild,
            currentMarketing: config.currentMarketingVersion,
            currentBuild: config.currentBuild
        ) else { return nil }

        if let skipped = skippedVersion(for: config.bundleId), Version(skipped) >= Version(latestMarketing) {
            return nil
        }

        let appleId = entry?.appleId ?? lookupResult?.trackId ?? config.appleId
        guard let appleId else { return nil }
        guard let urls = storeURLs(
            channel: channel,
            appleId: appleId,
            testFlightURL: entry?.testFlightURL,
            appStoreURL: entry?.appStoreURL ?? lookupResult?.trackViewUrl
        ) else { return nil }

        return Offer(
            latestVersion: latestMarketing,
            currentVersion: config.currentMarketingVersion,
            channel: channel,
            storeURL: urls.primary,
            fallbackURL: urls.fallback
        )
    }

    struct ManifestFile: Decodable, Equatable {
        var apps: [String: ManifestApp]
    }

    struct ManifestApp: Decodable, Equatable {
        var marketingVersion: String
        var build: String?
        var appleId: Int?
        var testFlightURL: String?
        var appStoreURL: String?
    }

    struct LookupFile: Decodable, Equatable {
        var resultCount: Int
        var results: [LookupResult]
    }

    struct LookupResult: Decodable, Equatable {
        var version: String
        var trackId: Int
        var trackViewUrl: String?
    }

    static func fetchManifest(from url: URL) async -> ManifestFile? {
        await fetchJSON(ManifestFile.self, from: url)
    }

    static func fetchLookup(bundleId: String) async -> LookupFile? {
        guard let url = URL(string: "https://itunes.apple.com/lookup?bundleId=\(bundleId)") else {
            return nil
        }
        return await fetchJSON(LookupFile.self, from: url)
    }

    private static func fetchJSON<T: Decodable>(_ type: T.Type, from url: URL) async -> T? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return nil
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }

    private static func intValue(_ value: Any?) -> Int? {
        switch value {
        case let number as Int: return number
        case let number as NSNumber: return number.intValue
        case let text as String: return Int(text)
        default: return nil
        }
    }
}

extension View {
    func appUpdatePrompt(config: AppUpdatePrompt.Config = .fromBundle()) -> some View {
        modifier(AppUpdatePromptModifier(config: config))
    }
}

private struct AppUpdatePromptModifier: ViewModifier {
    let config: AppUpdatePrompt.Config
    @Environment(\.openURL) private var openURL
    @State private var offer: AppUpdatePrompt.Offer?

    func body(content: Content) -> some View {
        content
            .task { await checkOnce() }
            .alert("Update Available", isPresented: offerPresented) {
                Button("Update") { openStore() }
                Button("Not Now", role: .cancel) { skipCurrent() }
            } message: {
                Text(offer?.message ?? "")
            }
    }

    private var offerPresented: Binding<Bool> {
        Binding(
            get: { offer != nil },
            set: { if !$0 { skipCurrent() } }
        )
    }

    @MainActor
    private func checkOnce() async {
        guard !AppUpdatePrompt.shouldSkipLaunchChecks else { return }
        let channel = await AppUpdatePrompt.detectChannel()
        guard channel != .xcode else { return }
        async let manifest = AppUpdatePrompt.fetchManifest(from: config.manifestURL)
        async let lookup = AppUpdatePrompt.fetchLookup(bundleId: config.bundleId)
        offer = AppUpdatePrompt.evaluate(
            config: config,
            channel: channel,
            manifest: await manifest,
            lookup: await lookup
        )
    }

    private func skipCurrent() {
        if let offer {
            AppUpdatePrompt.rememberSkip(version: offer.latestVersion, bundleId: config.bundleId)
        }
        offer = nil
    }

    private func openStore() {
        guard let offer else { return }
        openURL(offer.storeURL) { accepted in
            if !accepted {
                openURL(offer.fallbackURL)
            }
        }
        self.offer = nil
    }
}

