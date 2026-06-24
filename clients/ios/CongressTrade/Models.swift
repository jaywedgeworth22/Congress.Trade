import Foundation

struct BootstrapResponse: Decodable {
    let serverTime: String
    let auth: Auth
    let capabilities: [String: Bool]
    let endpoints: [String: String]

    struct Auth: Decodable {
        let user: User?
        let entitlement: Entitlement
    }
}

struct User: Decodable {
    let id: String
    let email: String
    let name: String?
    let picture: String?
}

struct Entitlement: Decodable {
    let premium: Bool
    let status: String?
    let plan: String?
}

struct ClientFeedResponse: Decodable {
    let items: [ClientTrade]
    let cursor: Int
    let count: Int
    let total: Int
    let limit: Int
    let nextPollAfterSec: Int
}

struct ClientTrade: Decodable, Identifiable {
    let id: String
    let cursor: Int
    let docId: String
    let member: Member
    let asset: Asset
    let transaction: Transaction
    let filing: Filing
    let confidence: Double
    let source: Source

    enum Source: String, Decodable {
        case primary
        case seedDataset = "seed_dataset"
    }

    struct Member: Decodable {
        let id: String?
        let name: String?
        let chamber: String?
        let party: String?
        let state: String?
        let photoUrl: String?
    }

    struct Asset: Decodable {
        let name: String
        let ticker: String?
        let type: String?
        let sector: String?
        let marketCapBucket: String?
    }

    struct Transaction: Decodable {
        let date: String?
        let type: String
        let owner: String?
        let amountMin: Int?
        let amountMax: Int?
        let isOption: Bool
    }

    struct Filing: Decodable {
        let filedDate: String?
        let firstSeenAt: String?
        let sourceUrl: String?
    }
}

struct ClientCommandResponse<ResultPayload: Decodable>: Decodable {
    let command: ClientCommand
    let result: ResultPayload?
    let replayed: Bool?
    let error: String?
}

struct ClientCommand: Decodable, Identifiable {
    let id: String
    let userId: String
    let type: String
    let status: Status
    let idempotencyKey: String?
    let error: String?
    let createdAt: String
    let updatedAt: String
    let startedAt: String?
    let finishedAt: String?

    enum Status: String, Decodable {
        case queued
        case running
        case succeeded
        case failed
        case canceled
    }
}

struct SubscriptionCommandResult: Decodable {
    let subscription: Subscription
}

struct Subscription: Decodable, Identifiable {
    let id: String
    let delivery: String
    let targetUrl: String?
    let cursor: Int
    let active: Bool
    let createdAt: String
    let hasSecret: Bool
    let secret: String?
    let streamUrl: String?
}
