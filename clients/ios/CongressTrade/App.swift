import SwiftUI
import SwiftData

/// Tab identity shared with `TabRouter` so any screen (e.g. the header
/// hamburger menu's "Sign In" entry) can programmatically switch tabs.
enum AppTab: Hashable {
    case trends, trades, delivery, settings
}

/// Cross-tab navigation used by the header hamburger menu (`AccountQuickMenu`)
/// to jump to Settings for sign-in, without duplicating the OAuth flow.
/// Trends is the default/leftmost tab (owner punch list item 1).
@MainActor
final class TabRouter: ObservableObject {
    @Published var selection: AppTab = .trends
}

@main
struct CongressTradeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())
    @StateObject private var pushManager = PushNotificationManager.shared
    @StateObject private var tabRouter = TabRouter()
    @AppStorage("app_color_scheme") private var appColorScheme = "system"

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(store)
                .environmentObject(pushManager)
                .environmentObject(tabRouter)
                .preferredColorScheme(colorScheme)
                .font(.custom("ZillaSlab-Regular", size: 17, relativeTo: .body))
        }
        .modelContainer(for: ClientTrade.self)
    }

    private var colorScheme: ColorScheme? {
        switch appColorScheme {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

struct MainTabView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var tabRouter: TabRouter
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

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

            DeliveryView()
                .tabItem {
                    Label("Delivery", systemImage: "bell.badge")
                }
                .tag(AppTab.delivery)

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
                .tag(AppTab.settings)
        }
        .tint(.blue)
        .task {
            store.modelContext = modelContext
            if store.feed == nil {
                await store.refresh()
            }
        }
        // Pause the nextPollAfterSec poll loop while backgrounded.
        .onChange(of: scenePhase) { _, phase in
            store.setAutoRefreshPaused(phase != .active)
        }
        // congresstrade:// deep links. The auth callback
        // (congresstrade://auth?token=…) arrives here on cold opens —
        // e.g. tapping a magic link in Mail — while
        // ASWebAuthenticationSession intercepts it for in-app OAuth.
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
