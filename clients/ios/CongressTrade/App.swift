import SwiftUI
import SwiftData

@main
struct CongressTradeApp: App {
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
        .modelContainer(for: ClientTrade.self)
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

            WatchlistView()
                .tabItem {
                    Label("Watch", systemImage: "line.3.horizontal.decrease.circle")
                }

            DeliveryView()
                .tabItem {
                    Label("Delivery", systemImage: "antenna.radiowaves.left.and.right")
                }

            CommandStatusView()
                .tabItem {
                    Label("Status", systemImage: "checkmark.seal")
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
