import SwiftUI
import SwiftData
import FirebaseCore

@main
struct CongressTradeApp: App {
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())
    @AppStorage("app_color_scheme") private var appColorScheme = "system"

    init() {
        FirebaseApp.configure()
    }

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
    @State private var showEagleSplash = true

    var body: some View {
        ZStack {
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
                        Label("Alerts", systemImage: "bell.badge")
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

            if showEagleSplash {
                EagleSplashView {
                    showEagleSplash = false
                }
                .transition(.opacity)
                .zIndex(10)
            }
        }
    }
}
