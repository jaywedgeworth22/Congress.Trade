import SwiftUI
import UserNotifications
import Combine

@MainActor
final class PushNotificationManager: ObservableObject {
    static let shared = PushNotificationManager()

    @Published var isAuthorized = false
    @Published var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published var deviceToken: String? {
        didSet {
            if let token = deviceToken {
                UserDefaults.standard.set(token, forKey: "apns_device_token")
            }
        }
    }
    @Published var lastError: String?
    @Published var isRegistering = false

    init() {
        if let storedToken = UserDefaults.standard.string(forKey: "apns_device_token") {
            self.deviceToken = storedToken
        }
        Task { await checkPermissionStatus() }
    }

    func checkPermissionStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
        isAuthorized = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }

    func requestAuthorization() async {
        isRegistering = true
        lastError = nil
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .sound, .badge]
            )
            await checkPermissionStatus()
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            lastError = error.localizedDescription
        }
        isRegistering = false
    }

    func handleDeviceToken(_ tokenString: String) {
        self.deviceToken = tokenString
        self.isAuthorized = true
        self.lastError = nil
        UserDefaults.standard.set(tokenString, forKey: "apns_device_token")
    }

    func handleRegistrationError(_ error: Error) {
        self.lastError = error.localizedDescription
    }

    func syncTokenWithBackend(api: CongressTradeAPIClient) async {
        let token = deviceToken ?? UserDefaults.standard.string(forKey: "apns_device_token")
        guard let apnsToken = token, !apnsToken.isEmpty else { return }
        do {
            _ = try await api.createAPNsSubscription(apnsToken: apnsToken)
        } catch {
            print("[PushNotificationManager] Failed to register push token with backend:", error.localizedDescription)
        }
    }
}
