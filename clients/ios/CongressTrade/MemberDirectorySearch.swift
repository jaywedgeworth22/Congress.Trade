import Foundation

/// Shared Directory search: multi-token AND matching for name (first/last/partial),
/// state abbreviation **or full name**, and party labels
/// (Democrat(s)/Republican(s)/Independent(s)/Other).
/// Example: `"CA Ro"` matches Ro Khanna (CA).
enum MemberDirectorySearch {
    /// US state / territory abbr → full name (lowercase).
    static let stateAbbrToName: [String: String] = [
        "al": "alabama", "ak": "alaska", "az": "arizona", "ar": "arkansas",
        "ca": "california", "co": "colorado", "ct": "connecticut", "de": "delaware",
        "fl": "florida", "ga": "georgia", "hi": "hawaii", "id": "idaho",
        "il": "illinois", "in": "indiana", "ia": "iowa", "ks": "kansas",
        "ky": "kentucky", "la": "louisiana", "me": "maine", "md": "maryland",
        "ma": "massachusetts", "mi": "michigan", "mn": "minnesota", "ms": "mississippi",
        "mo": "missouri", "mt": "montana", "ne": "nebraska", "nv": "nevada",
        "nh": "new hampshire", "nj": "new jersey", "nm": "new mexico", "ny": "new york",
        "nc": "north carolina", "nd": "north dakota", "oh": "ohio", "ok": "oklahoma",
        "or": "oregon", "pa": "pennsylvania", "ri": "rhode island", "sc": "south carolina",
        "sd": "south dakota", "tn": "tennessee", "tx": "texas", "ut": "utah",
        "vt": "vermont", "va": "virginia", "wa": "washington", "wv": "west virginia",
        "wi": "wisconsin", "wy": "wyoming", "dc": "district of columbia",
        "pr": "puerto rico", "vi": "virgin islands", "gu": "guam",
        "as": "american samoa", "mp": "northern mariana islands",
    ]

    static let stateNameToAbbr: [String: String] = {
        var map: [String: String] = [:]
        for (abbr, name) in stateAbbrToName { map[name] = abbr }
        return map
    }()

    enum SortKey: String, CaseIterable, Identifiable {
        case name, chamber, party, state, trades
        var id: String { rawValue }
        var label: String {
            switch self {
            case .name: return "Politician"
            case .chamber: return "Branch"
            case .party: return "Party"
            case .state: return "State"
            case .trades: return "Trades"
            }
        }
    }

    static func matches(_ member: MemberDirectoryEntry, query: String) -> Bool {
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !raw.isEmpty else { return true }
        let tokens = raw.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let name = (member.fullName ?? "").lowercased()
        let nameParts = name.split { !$0.isLetter && !$0.isNumber }.map(String.init)
        let filer = member.filerId.lowercased()
        let state = (member.state ?? "").lowercased()
        let chamber = (member.chamber ?? "").lowercased()
        let district = (member.district ?? "").lowercased()
        let party = member.party ?? ""

        return tokens.allSatisfy { tok in
            if stateMatches(tok, stateAbbr: state) { return true }
            if partyMatches(tok, party: party) { return true }
            if name.contains(tok) { return true }
            if filer.contains(tok) { return true }
            if chamber.contains(tok) { return true }
            if !district.isEmpty && district.contains(tok) { return true }
            if nameParts.contains(where: { $0.hasPrefix(tok) || $0.contains(tok) }) { return true }
            return false
        }
    }

    static func sort(
        _ members: [MemberDirectoryEntry],
        key: SortKey,
        ascending: Bool
    ) -> [MemberDirectoryEntry] {
        members.sorted { a, b in
            let cmp: ComparisonResult
            switch key {
            case .trades:
                let av = a.txCount ?? 0
                let bv = b.txCount ?? 0
                cmp = av == bv ? .orderedSame : (av < bv ? .orderedAscending : .orderedDescending)
            case .name:
                cmp = (a.fullName ?? a.filerId).localizedCaseInsensitiveCompare(b.fullName ?? b.filerId)
            case .chamber:
                cmp = (a.chamber ?? "").localizedCaseInsensitiveCompare(b.chamber ?? "")
            case .party:
                cmp = (a.party ?? "").localizedCaseInsensitiveCompare(b.party ?? "")
            case .state:
                cmp = (a.state ?? "").localizedCaseInsensitiveCompare(b.state ?? "")
            }
            if cmp == .orderedSame {
                let nameCmp = (a.fullName ?? a.filerId).localizedCaseInsensitiveCompare(b.fullName ?? b.filerId)
                if nameCmp != .orderedSame { return nameCmp == .orderedAscending }
                return (a.txCount ?? 0) > (b.txCount ?? 0)
            }
            return ascending ? cmp == .orderedAscending : cmp == .orderedDescending
        }
    }

    /// Public wrappers used by `TradeSearch`.
    static func stateMatchesPublic(_ token: String, stateAbbr: String) -> Bool {
        stateMatches(token, stateAbbr: stateAbbr)
    }
    static func partyMatchesPublic(_ token: String, party: String) -> Bool {
        partyMatches(token, party: party)
    }

    private static func stateMatches(_ token: String, stateAbbr: String) -> Bool {
        guard !stateAbbr.isEmpty else { return false }
        if token == stateAbbr { return true }
        let full = stateAbbrToName[stateAbbr] ?? ""
        if !full.isEmpty {
            if full == token || full.hasPrefix(token) || full.contains(token) { return true }
            for word in full.split(separator: " ") {
                if word == token || word.hasPrefix(token) { return true }
            }
        }
        if let abbr = stateNameToAbbr[token], abbr == stateAbbr { return true }
        // token is full name that maps to this abbr via prefix on keys
        for (name, abbr) in stateNameToAbbr where abbr == stateAbbr {
            if name.hasPrefix(token) || name.contains(token) { return true }
        }
        return false
    }

    private static func partyMatches(_ token: String, party: String) -> Bool {
        let blob = partySearchBlob(party)
        if blob.contains(token) { return true }
        let families: [(prefixes: [String], needles: [String])] = [
            (["d", "dem"], ["democrat", "democrats", "d"]),
            (["r", "rep", "gop"], ["republican", "republicans", "r", "gop"]),
            (["i", "ind", "oth"], ["independent", "independents", "other", "i"]),
        ]
        for fam in families {
            let tokenHitsFamily = fam.prefixes.contains { token.hasPrefix($0) || $0.hasPrefix(token) }
                || fam.needles.contains { $0.hasPrefix(token) || token.hasPrefix($0) }
            guard tokenHitsFamily else { continue }
            if fam.needles.contains(where: { blob.contains($0) }) { return true }
        }
        return false
    }

    private static func partySearchBlob(_ party: String) -> String {
        let p = party.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if p.isEmpty { return "other independent independents" }
        if p == "d" || p.hasPrefix("dem") { return p + " democrat democrats d" }
        if p == "r" || p.hasPrefix("rep") { return p + " republican republicans r gop" }
        if p == "i" || p == "id" || p.hasPrefix("ind") || p.hasPrefix("other") {
            return p + " independent independents other i"
        }
        return p + " other independent independents"
    }
}
