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

struct SubscriptionListResponse: Decodable {
    let subscriptions: [Subscription]
}

struct CommandListResponse: Decodable {
    let commands: [ClientCommand]
}

struct SubscriptionFilters: Codable, Hashable {
    var members: [String]?
    var tickers: [String]?
    var chambers: [String]?
    var minAmount: Int?
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

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let int = try? container.decode(Int.self) {
            self = .number(Double(int))
        } else if let double = try? container.decode(Double.self) {
            self = .number(double)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let string):
            try container.encode(string)
        case .number(let number):
            try container.encode(number)
        case .bool(let bool):
            try container.encode(bool)
        case .object(let object):
            try container.encode(object)
        case .array(let array):
            try container.encode(array)
        case .null:
            try container.encodeNil()
        }
    }

    var prettyPrinted: String {
        let payload = foundationValue
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8)
        else {
            return String(describing: payload)
        }
        return string
    }

    private var foundationValue: Any {
        switch self {
        case .string(let string):
            return string
        case .number(let number):
            return number
        case .bool(let bool):
            return bool
        case .object(let object):
            return object.mapValues { $0.foundationValue }
        case .array(let array):
            return array.map { $0.foundationValue }
        case .null:
            return NSNull()
        }
    }
}
