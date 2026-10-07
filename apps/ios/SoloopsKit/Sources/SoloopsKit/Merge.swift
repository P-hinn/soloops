import Foundation

/// Who wins when both devices changed the same thing — the phone's half.
///
/// The counterpart of `apps/api/src/services/syncMerge.ts`, and the file where
/// agreement matters most. The two devices never compare notes about *why* a
/// field was kept; each one runs this rule over its own log. If the rules
/// differ by even one case, the pair converges on two different states and
/// neither side reports anything wrong.
///
/// So the cases below are in the same order as the TypeScript, with the same
/// reasons, including the one that is a judgement call rather than a
/// consequence: an edit made after a delete keeps the row alive.
public enum Merge {
    /// What the local log already holds for one row.
    public struct KnownOp: Equatable, Sendable {
        public let hlc: String
        public let op: OpKind
        public let fields: [String]

        public init(hlc: String, op: OpKind, fields: [String]) {
            self.hlc = hlc
            self.op = op
            self.fields = fields
        }
    }

    public enum Decision: Equatable, Sendable {
        /// Nothing to do, and why. Carried through so the caller can report
        /// it rather than silently dropping the op.
        case skip(reason: String)
        case delete
        /// Only the fields that actually won.
        case create(patch: Patch)
        case update(patch: Patch)
    }

    public static func decide(
        incoming: SyncOp,
        known: [KnownOp],
        exists: Bool
    ) -> Decision {
        guard let spec = SyncEntities.spec(incoming.entity) else {
            return .skip(reason: "unbekannte Entitaet \(incoming.entity)")
        }

        // --- Delete --------------------------------------------------------
        if incoming.op == .delete {
            if !exists { return .skip(reason: "bereits geloescht") }
            // A row edited after this delete was made is not deleted: the edit
            // is work, the delete is the absence of it. Keeping the row loses
            // nothing a second delete cannot fix; honouring the delete throws
            // away an edit nobody can get back.
            if known.contains(where: { $0.op == .upsert && Hlc.isNewer($0.hlc, than: incoming.hlc) })
            {
                return .skip(reason: "nach dem Loeschen wurde die Zeile geaendert")
            }
            return .delete
        }

        // --- Upsert --------------------------------------------------------
        if known.contains(where: { $0.op == .delete && Hlc.isNewer($0.hlc, than: incoming.hlc) }) {
            return .skip(reason: "Zeile wurde danach geloescht")
        }

        var claimed = Set<String>()
        for op in known where Hlc.isNewer(op.hlc, than: incoming.hlc) {
            claimed.formUnion(op.fields)
        }

        var surviving: Patch = [:]
        for (field, value) in incoming.patch ?? [:] where !claimed.contains(field) {
            surviving[field] = value
        }

        if surviving.isEmpty {
            return .skip(reason: exists ? "jedes Feld lokal neuer" : "keine verwertbaren Felder")
        }

        if exists { return .update(patch: surviving) }

        let missing = spec.required.filter { surviving[$0] == nil || surviving[$0]!.isNull }
        if !missing.isEmpty {
            return .skip(reason: "Pflichtfelder fehlen: \(missing.joined(separator: ", "))")
        }

        return .create(patch: surviving)
    }

    public static func rowKey(entity: String, entityId: String) -> String {
        "\(entity) \(entityId)"
    }

    /// Index a flat list of log rows by row, so one batch costs one query.
    public static func group(_ rows: [(entity: String, entityId: String, op: KnownOp)])
        -> [String: [KnownOp]]
    {
        var out: [String: [KnownOp]] = [:]
        for row in rows {
            out[rowKey(entity: row.entity, entityId: row.entityId), default: []].append(row.op)
        }
        return out
    }
}
