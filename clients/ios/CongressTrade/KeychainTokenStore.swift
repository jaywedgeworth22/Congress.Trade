import Foundation
import Security

final class KeychainTokenStore: SessionTokenStore {
    private let sessionService = "trade.congress.session"
    private let account = "default"

    func load() throws -> String? {
        try loadSecret(service: sessionService)
    }

    func save(_ token: String) throws {
        try saveSecret(token, service: sessionService)
    }

    func clear() throws {
        try clearSecret(service: sessionService)
    }

    private func loadSecret(service: String) throws -> String? {
        var query = baseQuery(service: service)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        // Simulator: missing entitlement (-34018) must not block public feed.
        if status == errSecItemNotFound || status == errSecMissingEntitlement { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func saveSecret(_ token: String, service: String) throws {
        let data = Data(token.utf8)
        var query = baseQuery(service: service)
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        if status == errSecSuccess {
            let update = [kSecValueData as String: data]
            let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            guard updateStatus == errSecSuccess else { throw KeychainError(status: updateStatus) }
            return
        }
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        if addStatus == errSecMissingEntitlement { return }
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
    }

    private func clearSecret(service: String) throws {
        let status = SecItemDelete(baseQuery(service: service) as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw KeychainError(status: status)
        }
    }

    private func baseQuery(service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        "Keychain error \(status)"
    }
}
