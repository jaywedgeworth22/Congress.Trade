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

    var body: some View {
        TabView {
            FeedDashboardView()
                .tabItem {
                    Label("Feed", systemImage: "list.bullet.rectangle")
                }

            TrendsView()
                .tabItem {
                    Label("Trends", systemImage: "chart.line.uptrend.xyaxis")
                }

            DeliveryView()
                .tabItem {
                    Label("Delivery", systemImage: "antenna.radiowaves.left.and.right")
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
    }
}
