import Foundation

/// A value as it travels in a patch.
///
/// `Any` would be shorter and would also let a `Date` or an `NSNumber` slip
/// into the JSON, where the API expects ISO strings and plain numbers. Making
/// the cases explicit means the only way to build a patch is to say what kind
/// of value it is.
public enum SyncValue: Equatable, Sendable {
    case null
    case string(String)
    case int(Int)
    case bool(Bool)
    /// Always carried as the ISO string, which is what crosses the wire.
    case isoDate(String)
    case strings([String])
    case dates([String])
    /// Opaque JSON, for the one `decisions` column.
    case json(Data)

    public var isNull: Bool { self == .null }
}

public typealias Patch = [String: SyncValue]

public enum OpKind: String, Codable, Sendable {
    case upsert
    case delete
}

/// One change to one row.
public struct SyncOp: Equatable, Sendable {
    public var deviceId: String
    public var seq: Int
    public var hlc: String
    public var entity: String
    public var entityId: String
    public var op: OpKind
    public var patch: Patch?

    public init(
        deviceId: String,
        seq: Int,
        hlc: String,
        entity: String,
        entityId: String,
        op: OpKind,
        patch: Patch? = nil
    ) {
        self.deviceId = deviceId
        self.seq = seq
        self.hlc = hlc
        self.entity = entity
        self.entityId = entityId
        self.op = op
        self.patch = patch
    }

    /// The fields this op claims. Empty for a delete.
    public var fields: [String] {
        guard op == .upsert, let patch else { return [] }
        return patch.keys.sorted()
    }
}

/// Between a patch and the JSON the API speaks.
public enum SyncCodec {
    /// An ISO-8601 formatter with milliseconds, matching `Date.toISOString()`.
    ///
    /// The API compares nothing by string, but the op log stores the patch
    /// verbatim, and a stamp written two different ways on the two devices
    /// makes the log harder to read than it needs to be.
    /// `nonisolated(unsafe)` because `ISO8601DateFormatter` is not `Sendable`,
    /// and these two are configured once here and then only ever read.
    /// Formatting and parsing on a configured instance is thread-safe; the
    /// alternative is building a formatter per value, which this runs over
    /// every field of every op.
    nonisolated(unsafe) private static let withMillis: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    nonisolated(unsafe) private static let withoutMillis: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    public static func isoString(_ date: Date) -> String { withMillis.string(from: date) }

    public static func date(_ text: String) -> Date? {
        if let date = withMillis.date(from: text) { return date }
        // The API always emits milliseconds, but a value typed by hand or
        // written by an older build may not have them.
        return withoutMillis.date(from: text)
    }

    // --- Outbound ----------------------------------------------------------

    static func jsonValue(_ value: SyncValue) -> Any {
        switch value {
        case .null: return NSNull()
        case .string(let s): return s
        case .int(let i): return i
        case .bool(let b): return b
        case .isoDate(let s): return s
        case .strings(let a): return a
        case .dates(let a): return a
        case .json(let data):
            return (try? JSONSerialization.jsonObject(with: data)) ?? NSNull()
        }
    }

    public static func jsonObject(_ patch: Patch) -> [String: Any] {
        patch.mapValues(jsonValue)
    }

    public static func jsonObject(_ op: SyncOp) -> [String: Any] {
        var out: [String: Any] = [
            "deviceId": op.deviceId,
            "seq": op.seq,
            "hlc": op.hlc,
            "entity": op.entity,
            "entityId": op.entityId,
            "op": op.op.rawValue,
        ]
        if op.op == .upsert { out["patch"] = jsonObject(op.patch ?? [:]) }
        return out
    }

    // --- Inbound -----------------------------------------------------------

    public enum DecodeError: Error, Equatable {
        case unknownEntity(String)
        case badField(field: String, reason: String)
        case malformed(String)
    }

    /// One value, from JSON into a `SyncValue` of the declared kind.
    ///
    /// A value that does not fit is an error rather than a best guess. The
    /// alternative is writing something plausible into the row and finding out
    /// weeks later — the same reasoning as in the API's codec.
    static func value(_ raw: Any, kind: FieldKind, field: String) throws -> SyncValue {
        if raw is NSNull { return .null }

        switch kind {
        case .string:
            guard let s = raw as? String else {
                throw DecodeError.badField(field: field, reason: "Text erwartet")
            }
            return .string(s)

        case .int:
            // `NSNumber` is also what a JSON bool decodes to, so the bool
            // check has to come first or `true` would arrive as 1.
            if raw is Bool { throw DecodeError.badField(field: field, reason: "Ganzzahl erwartet") }
            guard let n = raw as? NSNumber, n.doubleValue == n.doubleValue.rounded() else {
                throw DecodeError.badField(field: field, reason: "Ganzzahl erwartet")
            }
            return .int(n.intValue)

        case .bool:
            guard let b = raw as? Bool else {
                throw DecodeError.badField(field: field, reason: "Boolean erwartet")
            }
            return .bool(b)

        case .date:
            guard let s = raw as? String else {
                throw DecodeError.badField(field: field, reason: "Datum erwartet")
            }
            guard date(s) != nil else {
                throw DecodeError.badField(field: field, reason: "ungueltiges Datum")
            }
            return .isoDate(s)

        case .strings:
            guard let a = raw as? [Any] else {
                throw DecodeError.badField(field: field, reason: "Liste von Texten erwartet")
            }
            let strings = a.compactMap { $0 as? String }
            guard strings.count == a.count else {
                throw DecodeError.badField(field: field, reason: "Liste von Texten erwartet")
            }
            return .strings(strings)

        case .dates:
            guard let a = raw as? [Any] else {
                throw DecodeError.badField(field: field, reason: "Liste von Daten erwartet")
            }
            var out: [String] = []
            for entry in a {
                guard let s = entry as? String, date(s) != nil else {
                    throw DecodeError.badField(field: field, reason: "ungueltiges Datum")
                }
                out.append(s)
            }
            return .dates(out)

        case .json:
            let data = try? JSONSerialization.data(withJSONObject: raw, options: [.fragmentsAllowed])
            return .json(data ?? Data("null".utf8))
        }
    }

    /// A whole patch.
    ///
    /// Unknown keys are dropped, not rejected — the Mac may be a build ahead
    /// and syncing a column this app does not know yet, and refusing the op
    /// would stall that row until the app is updated.
    public static func patch(from raw: [String: Any], entity: String) throws -> Patch {
        guard let spec = SyncEntities.spec(entity) else {
            throw DecodeError.unknownEntity(entity)
        }
        var out: Patch = [:]
        for (key, item) in raw {
            guard let kind = spec.fields[key] else { continue }
            out[key] = try value(item, kind: kind, field: key)
        }
        return out
    }

    public static func op(from raw: [String: Any]) throws -> SyncOp {
        guard let deviceId = raw["deviceId"] as? String,
            let seq = (raw["seq"] as? NSNumber)?.intValue,
            let hlc = raw["hlc"] as? String,
            let entity = raw["entity"] as? String,
            let entityId = raw["entityId"] as? String,
            let kindRaw = raw["op"] as? String,
            let kind = OpKind(rawValue: kindRaw)
        else {
            throw DecodeError.malformed("Op unvollstaendig")
        }

        let patch: Patch? =
            kind == .upsert
            ? try SyncCodec.patch(from: raw["patch"] as? [String: Any] ?? [:], entity: entity)
            : nil

        return SyncOp(
            deviceId: deviceId,
            seq: seq,
            hlc: hlc,
            entity: entity,
            entityId: entityId,
            op: kind,
            patch: patch
        )
    }
}
