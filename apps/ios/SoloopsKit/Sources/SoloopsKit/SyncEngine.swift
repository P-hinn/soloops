import Foundation

/// The phone's side of the sync.
///
/// Three jobs: stamp and log the changes made here, apply the ones that come
/// from the Mac, and keep the cursor straight. The two transports are handed
/// in rather than built, because which one is reachable changes while the app
/// is running — in the car it is usually neither for a while, and the engine
/// has to behave the same when that happens.
///
/// Everything goes through the local database first. A change made in a tunnel
/// is written, stamped and shown immediately; the sync is a separate matter
/// that catches up later. That is the whole reason for the op log, and it is
/// why nothing here waits on a network call before letting the UI move on.
public final class SyncEngine {
    public struct Identity: Equatable, Sendable {
        public let deviceId: String
        public let token: String

        public init(deviceId: String, token: String) {
            self.deviceId = deviceId
            self.token = token
        }
    }

    /// How a batch went, for the UI and for the log.
    public struct Report: Equatable, Sendable {
        public var pushed = 0
        public var pulled = 0
        public var applied = 0
        public var skipped = 0
        public var failed = 0
        /// The reasons, so a stuck row can be explained rather than guessed at.
        public var notes: [String] = []
    }

    static let cursorKey = "sync.cursor"
    static let clockKey = "sync.clock"

    public let store: Store
    public let identity: Identity
    private let clock: HlcClock

    public init(store: Store, identity: Identity) throws {
        self.store = store
        self.identity = identity

        // Restore the clock from the newest op this device knows, not from the
        // wall clock. A relaunch that minted a stamp behind one already pushed
        // would have the Mac reject this device's next edit as stale.
        let newest = try store.newestHlc()
        let restored = max(newest, (try? store.meta(Self.clockKey)) ?? "")
        let weak = WeakBox()
        self.clock = HlcClock(
            deviceId: identity.deviceId,
            restoringFrom: restored,
            onChange: { state in
                try? weak.store?.setMeta(
                    Self.clockKey,
                    Hlc.format(state, deviceId: identity.deviceId)
                )
            }
        )
        weak.store = store
    }

    /// Breaks the cycle between the clock's callback and the store.
    private final class WeakBox {
        weak var store: Store?
    }

    public var cursor: String {
        (try? store.meta(Self.cursorKey)) ?? Hlc.zero
    }

    // --- Changes made here -------------------------------------------------

    /// Write a change locally and log it for the next push.
    ///
    /// `id` is minted by the caller, which is deliberate: a row created in the
    /// car gets its identity from the phone and keeps it when the Mac picks it
    /// up. An id handed out by a server would mean no offline creation at all.
    @discardableResult
    public func recordLocal(
        entity: String,
        id: String,
        patch: Patch,
        isCreate: Bool? = nil
    ) throws -> SyncOp {
        guard SyncEntities.isKnown(entity) else {
            throw Store.StoreError.sql("unbekannte Entitaet \(entity)")
        }

        return try store.transaction {
            let creating = try isCreate ?? !store.exists(entity: entity, id: id)
            try store.write(entity: entity, id: id, patch: patch, isCreate: creating)

            let op = SyncOp(
                deviceId: identity.deviceId,
                seq: try store.nextSeq(deviceId: identity.deviceId),
                hlc: clock.next(),
                entity: entity,
                entityId: id,
                op: .upsert,
                patch: patch
            )
            try store.appendOp(op, pushed: false)
            return op
        }
    }

    /// Delete locally, including what the foreign keys would take with it.
    ///
    /// The Mac's hook expands cascades itself and stands down while applying a
    /// remote op, which means these derived ops have to come from here. If
    /// they did not, deleting a meeting on the phone would leave its action
    /// items on the Mac for good.
    @discardableResult
    public func deleteLocal(entity: String, id: String) throws -> [SyncOp] {
        try store.transaction {
            var ops: [SyncOp] = []
            var seq = try store.nextSeq(deviceId: identity.deviceId)

            let children = try store.childrenAffectedBy(entity: entity, ids: [id])

            for child in children {
                switch child.kind {
                case .delete:
                    try store.delete(entity: child.entity, id: child.id)
                    ops.append(
                        SyncOp(
                            deviceId: identity.deviceId, seq: seq, hlc: clock.next(),
                            entity: child.entity, entityId: child.id, op: .delete
                        ))
                case .clear:
                    let patch: Patch = [child.fk: .null]
                    try store.write(
                        entity: child.entity, id: child.id, patch: patch, isCreate: false)
                    ops.append(
                        SyncOp(
                            deviceId: identity.deviceId, seq: seq, hlc: clock.next(),
                            entity: child.entity, entityId: child.id, op: .upsert, patch: patch
                        ))
                }
                seq += 1
            }

            try store.delete(entity: entity, id: id)
            ops.append(
                SyncOp(
                    deviceId: identity.deviceId, seq: seq, hlc: clock.next(),
                    entity: entity, entityId: id, op: .delete
                ))

            for op in ops { try store.appendOp(op, pushed: false) }
            return ops
        }
    }

    // --- Changes from the Mac ----------------------------------------------

    /// Apply a pulled batch.
    ///
    /// Same shape as the API's `applyOps`: ordered by stamp, every op logged
    /// whether it won or not, and a second pass for the ones whose parent row
    /// arrived later in the same batch.
    @discardableResult
    public func applyRemote(_ ops: [SyncOp]) throws -> Report {
        var report = Report()
        let ordered = ops.sorted { $0.hlc < $1.hlc }
        var deferred: [SyncOp] = []

        for op in ordered {
            // Already seen. The iCloud route redelivers by design.
            if try store.hasOp(deviceId: op.deviceId, seq: op.seq) {
                report.skipped += 1
                continue
            }
            try applyOne(op, into: &report, deferring: &deferred, isRetry: false)
        }

        // Second pass, for the ones whose parent arrived later in the batch.
        // `applyOne` reports rather than defers when `isRetry` is set, so this
        // terminates after exactly one more round.
        var unused: [SyncOp] = []
        for op in deferred {
            try applyOne(op, into: &report, deferring: &unused, isRetry: true)
        }

        report.pulled = ops.count
        return report
    }

    private func applyOne(
        _ op: SyncOp,
        into report: inout Report,
        deferring: inout [SyncOp],
        isRetry: Bool
    ) throws {
        guard Hlc.parse(op.hlc) != nil else {
            report.failed += 1
            report.notes.append("\(op.entity) \(op.entityId): ungueltiger Zeitstempel")
            return
        }
        guard SyncEntities.isKnown(op.entity) else {
            // A newer Mac syncing a table this build does not have. Logged as
            // skipped rather than failed: there is nothing wrong, this app is
            // simply behind.
            report.skipped += 1
            return
        }

        // The clock moves past every stamp seen, so this device's next edit
        // sorts after it — see Hlc.observe.
        clock.witness(op.hlc)

        let known = try store.knownOps(entity: op.entity, entityId: op.entityId)
        let exists = try store.exists(entity: op.entity, id: op.entityId)
        let decision = Merge.decide(incoming: op, known: known, exists: exists)

        // A row pointing at something this device has not got yet is the one
        // case worth a second try: the parent may be later in the same batch.
        // Second time round there is nothing left to wait for, so it is
        // reported — and the op is still logged, because it is part of the
        // shared history either way.
        let writes: Bool
        switch decision {
        case .create, .update: writes = true
        case .skip, .delete: writes = false
        }

        if writes, try missingReference(op) {
            if !isRetry {
                deferring.append(op)
                return
            }
            try store.appendOp(op, pushed: true)
            report.failed += 1
            report.notes.append("\(op.entity) \(op.entityId): Verweis zeigt ins Leere")
            return
        }

        try store.transaction {
            try store.appendOp(op, pushed: true)

            switch decision {
            case .skip(let reason):
                report.skipped += 1
                report.notes.append("\(op.entity) \(op.entityId): \(reason)")

            case .delete:
                // The Mac sends its own ops for the cascade, so this only
                // removes the row it was told about.
                try store.delete(entity: op.entity, id: op.entityId)
                report.applied += 1

            case .create(let patch):
                try store.write(entity: op.entity, id: op.entityId, patch: patch, isCreate: true)
                report.applied += 1

            case .update(let patch):
                try store.write(entity: op.entity, id: op.entityId, patch: patch, isCreate: false)
                report.applied += 1
            }
        }
    }

    /// Whether this op points at a row that is not here.
    ///
    /// Checked rather than caught, because SQLite has foreign keys switched
    /// off: an insert referring to a missing project would succeed and leave a
    /// row the app cannot display.
    private func missingReference(_ op: SyncOp) throws -> Bool {
        guard let patch = op.patch else { return false }
        for (field, value) in patch {
            guard case .string(let referenced) = value,
                let target = SyncEntities.referenceTarget(entity: op.entity, field: field)
            else { continue }
            if try !store.exists(entity: target, id: referenced) { return true }
        }
        return false
    }

    // --- Cursor ------------------------------------------------------------

    /// Store the cursor only once the batch is in.
    ///
    /// Advancing it when the request returns, rather than when the rows are
    /// written, is how a sync loses a batch to a crash — and a lost batch is
    /// invisible, because the next pull starts after it.
    public func commitCursor(_ cursor: String) throws {
        guard !cursor.isEmpty else { return }
        try store.setMeta(Self.cursorKey, cursor)
    }

    public func unpushed(limit: Int = 500) throws -> [SyncOp] {
        try store.unpushedOps(limit: limit)
    }

    public func markPushed(_ ops: [SyncOp]) throws {
        try store.markPushed(deviceId: identity.deviceId, seqs: ops.map(\.seq))
    }
}
