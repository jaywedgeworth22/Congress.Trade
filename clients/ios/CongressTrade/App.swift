import SwiftUI
import SwiftData

@main
struct CongressTradeApp: App {
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())
    @AppStorage("app_color_scheme") private var appColorScheme = "system"

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(store)
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
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            FeedDashboardView()
                .tabItem {
                    Label("Trades", systemImage: "list.bullet.rectangle")
                }

            TrendsView()
                .tabItem {
                    Label("Trends", systemImage: "chart.line.uptrend.xyaxis")
                }

            DeliveryView()
                .tabItem {
                    Label("Delivery", systemImage: "bell.badge")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
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
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
                  !token.isEmpty else { return }
            _ = store.saveSessionToken(token)
        }
    }
}
