import Foundation

/// What syncs, field by field — the phone's copy of the registry.
///
/// The counterpart of `apps/api/src/services/syncEntities.ts`. It is repeated
/// rather than fetched because the local SQLite schema is built from it: the
/// phone has to know the columns before it has ever spoken to the Mac.
///
/// Keeping two copies in step is a real cost, so there is a test that holds
/// this against a fixture exported from the API (`EntityParityTests`). If you
/// add a field on the server, that test is what tells you about it.
public enum FieldKind: String, Sendable, CaseIterable {
    case string
    case int
    case bool
    case date
    case json
    case strings
    case dates

    /// The SQLite column type.
    ///
    /// Dates are stored as the ISO strings they arrive as, not as numbers:
    /// they travel as ISO, they are displayed as ISO-derived, and a round trip
    /// through a float is one more place for a timezone to go missing.
    var columnType: String {
        switch self {
        case .int: return "INTEGER"
        case .bool: return "INTEGER"
        default: return "TEXT"
        }
    }
}

public struct SideEffect: Sendable {
    public enum Kind: Sendable {
        /// The child row goes with the parent.
        case delete
        /// The child row survives with the reference cleared.
        case clear
    }
    public let kind: Kind
    public let entity: String
    public let fk: String
}

public struct EntitySpec: Sendable {
    public let name: String
    /// Ordered so the SQLite table definition is stable across launches.
    public let fieldOrder: [String]
    public let fields: [String: FieldKind]
    public let required: [String]
    /// Foreign keys point at lower ranks only.
    public let rank: Int
    public let sideEffects: [SideEffect]

    init(
        _ name: String,
        rank: Int,
        required: [String],
        fields: [(String, FieldKind)],
        sideEffects: [SideEffect] = []
    ) {
        self.name = name
        self.rank = rank
        self.required = required
        self.fieldOrder = fields.map(\.0)
        self.fields = Dictionary(uniqueKeysWithValues: fields)
        self.sideEffects = sideEffects
    }

    public var table: String { name }
}

public enum SyncEntities {
    public static let all: [EntitySpec] = [
        EntitySpec(
            "Client",
            rank: 0,
            required: ["name"],
            fields: [
                ("name", .string), ("company", .string), ("email", .string), ("phone", .string),
                ("street", .string), ("zip", .string), ("city", .string), ("country", .string),
                ("vatId", .string), ("currency", .string), ("hourlyRateCents", .int),
                ("paymentTermDays", .int), ("notes", .string), ("archived", .bool),
            ],
            sideEffects: [
                SideEffect(kind: .clear, entity: "Project", fk: "clientId"),
                SideEffect(kind: .clear, entity: "CalendarEvent", fk: "clientId"),
                SideEffect(kind: .clear, entity: "Meeting", fk: "clientId"),
                SideEffect(kind: .clear, entity: "Note", fk: "clientId"),
                SideEffect(kind: .clear, entity: "Lead", fk: "clientId"),
                SideEffect(kind: .clear, entity: "TimeEntry", fk: "clientId"),
            ]
        ),
        EntitySpec(
            "Project",
            rank: 1,
            required: ["key", "name"],
            fields: [
                ("key", .string), ("name", .string), ("description", .string),
                ("status", .string), ("color", .string), ("clientId", .string),
                ("hourlyRateCents", .int), ("budgetCents", .int), ("startsOn", .date),
                ("dueOn", .date),
            ],
            sideEffects: [
                SideEffect(kind: .delete, entity: "TimeEntry", fk: "projectId"),
                SideEffect(kind: .clear, entity: "CalendarEvent", fk: "projectId"),
                SideEffect(kind: .clear, entity: "Meeting", fk: "projectId"),
                SideEffect(kind: .clear, entity: "Note", fk: "projectId"),
                SideEffect(kind: .clear, entity: "ActionItem", fk: "projectId"),
                SideEffect(kind: .clear, entity: "Lead", fk: "projectId"),
            ]
        ),
        EntitySpec(
            "CalendarEvent",
            rank: 2,
            required: ["title", "startsAt", "endsAt"],
            fields: [
                ("title", .string), ("description", .string), ("location", .string),
                ("startsAt", .date), ("endsAt", .date), ("allDay", .bool), ("kind", .string),
                ("projectId", .string), ("clientId", .string), ("videoUrl", .string),
                ("videoProvider", .string), ("recurring", .bool), ("readOnly", .bool),
                ("sourceUid", .string), ("rrule", .string), ("timeZone", .string),
                ("exDates", .dates), ("recurrenceId", .date),
            ],
            sideEffects: [SideEffect(kind: .clear, entity: "Meeting", fk: "eventId")]
        ),
        EntitySpec(
            "Lead",
            rank: 2,
            required: ["title"],
            fields: [
                ("title", .string), ("stage", .string), ("source", .string),
                ("contactName", .string), ("contactEmail", .string), ("company", .string),
                ("phone", .string), ("valueCents", .int), ("currency", .string),
                ("probability", .int), ("expectedCloseOn", .date), ("lostReason", .string),
                ("notes", .string), ("lastActivityAt", .date), ("followUpOn", .date),
                ("followUpNote", .string), ("aiScore", .int), ("aiScoreReason", .string),
                ("aiNextStep", .string), ("aiScoredAt", .date), ("clientId", .string),
                ("projectId", .string), ("archived", .bool),
            ]
        ),
        EntitySpec(
            "TimeEntry",
            rank: 2,
            required: ["projectId", "startedAt"],
            fields: [
                ("projectId", .string), ("clientId", .string), ("description", .string),
                ("startedAt", .date), ("endedAt", .date), ("durationSec", .int),
                ("billable", .bool), ("rateCents", .int), ("tags", .strings),
                ("source", .string),
            ]
        ),
        EntitySpec(
            "Meeting",
            rank: 3,
            required: ["title", "startsAt"],
            fields: [
                ("title", .string), ("status", .string), ("startsAt", .date), ("endsAt", .date),
                ("participants", .strings), ("agenda", .string), ("minutes", .string),
                ("summary", .string), ("decisions", .json), ("projectId", .string),
                ("clientId", .string), ("eventId", .string), ("videoUrl", .string),
                ("videoProvider", .string),
            ],
            sideEffects: [
                SideEffect(kind: .delete, entity: "ActionItem", fk: "meetingId"),
                SideEffect(kind: .clear, entity: "Note", fk: "meetingId"),
            ]
        ),
        EntitySpec(
            "ActionItem",
            rank: 4,
            required: ["title"],
            fields: [
                ("title", .string), ("done", .bool), ("dueOn", .date), ("assignee", .string),
                ("source", .string), ("meetingId", .string), ("projectId", .string),
            ]
        ),
        EntitySpec(
            "Note",
            rank: 4,
            required: ["title"],
            fields: [
                ("title", .string), ("body", .string), ("tags", .strings), ("pinned", .bool),
                ("projectId", .string), ("clientId", .string), ("meetingId", .string),
            ]
        ),
    ]

    static let byName: [String: EntitySpec] = Dictionary(
        uniqueKeysWithValues: all.map { ($0.name, $0) }
    )

    public static func spec(_ name: String) -> EntitySpec? { byName[name] }

    public static func isKnown(_ name: String) -> Bool { byName[name] != nil }

    /// Upsert order: parents first. Deletes run in reverse.
    public static var byRank: [EntitySpec] {
        all.sorted { $0.rank < $1.rank }
    }

    /// Which table a foreign key points at, as `"Child.field" -> "Parent"`.
    ///
    /// Derived by inverting the cascade table rather than written out again.
    /// The cascades already say "deleting a Client clears Lead.clientId",
    /// which is the same fact read from the other end — and a second
    /// hand-written list would be a second thing to forget.
    ///
    /// Deriving it also avoids the trap of guessing from the column name.
    /// `Client.vatId` ends in `Id` and refers to nothing; treating it as a
    /// reference would have the app refuse to insert any client with a VAT
    /// number, because the "parent row" is never there.
    static let referenceTargets: [String: String] = {
        var out: [String: String] = [:]
        for parent in all {
            for effect in parent.sideEffects {
                out["\(effect.entity).\(effect.fk)"] = parent.name
            }
        }
        return out
    }()

    public static func referenceTarget(entity: String, field: String) -> String? {
        referenceTargets["\(entity).\(field)"]
    }
}
