import Foundation

/// Deciding when and how to sync, and surviving both answers being "not now".
///
/// The engine applies and records; this picks a route and runs the round trip.
/// Kept apart because the interesting behaviour is in the choosing: the phone
/// is on the house Wi-Fi, or on mobile data with the Mac asleep, or in a
/// tunnel, and all three have to leave the local database in a usable state.
public actor SyncCoordinator {
    /// What the UI shows about the last attempt.
    public enum Route: Equatable, Sendable {
        case lan
        case iCloud
        case none
    }

    public struct Status: Equatable, Sendable {
        public var route: Route = .none
        public var lastSuccess: Date?
        public var lastAttempt: Date?
        public var pending: Int = 0
        public var lastError: String?
        public var report = SyncEngine.Report()
    }

    let engine: SyncEngine
    /// The address last paired with. Nil until the phone has been paired.
    var lan: LanTransport.Endpoint?
    var iCloudRoot: URL?
    var status = Status()

    public init(engine: SyncEngine, lan: LanTransport.Endpoint?, iCloudRoot: URL?) {
        self.engine = engine
        self.lan = lan
        self.iCloudRoot = iCloudRoot
    }

    public func currentStatus() -> Status { status }

    public func setEndpoint(_ endpoint: LanTransport.Endpoint?) { lan = endpoint }

    /// One full round: hand over what is ours, take in what is not.
    ///
    /// The LAN is tried first because it settles ops in the same request. When
    /// it is not there, the iCloud route takes over — and it deliberately does
    /// *not* mark anything as pushed, because a file handed to iCloud is not a
    /// file the Mac has read. Those ops stay pending until they come back as
    /// history, which is the only acknowledgement that route can give.
    @discardableResult
    public func syncNow() async -> Status {
        status.lastAttempt = Date()
        status.lastError = nil

        let pending = (try? engine.unpushed()) ?? []
        status.pending = pending.count

        if let endpoint = lan {
            let transport = LanTransport(endpoint: endpoint, identity: engine.identity)
            do {
                try await run(transport, pending: pending)
                status.route = .lan
                status.lastSuccess = Date()
                status.pending = ((try? engine.unpushed()) ?? []).count
                return status
            } catch TransportError.unauthorised {
                // The device was revoked on the Mac. Retrying is pointless
                // and the user has to pair again, so say so plainly.
                status.route = .none
                status.lastError = "Gerät ist nicht mehr gekoppelt"
                return status
            } catch {
                // Not reachable, almost certainly. Fall through to iCloud
                // rather than reporting a failure the user cannot act on.
                status.lastError = nil
            }
        }

        if let root = iCloudRoot {
            let transport = ICloudTransport(root: root, identity: engine.identity)
            do {
                try await run(transport, pending: pending)
                try? transport.acknowledge()
                status.route = .iCloud
                status.lastSuccess = Date()
                return status
            } catch {
                status.route = .none
                status.lastError = "iCloud-Ablage nicht erreichbar"
                return status
            }
        }

        status.route = .none
        status.lastError = lan == nil ? "Noch nicht gekoppelt" : "Kein Weg zum Mac"
        return status
    }

    private func run(_ transport: some SyncTransport, pending: [SyncOp]) async throws {
        // Push first. An op applied on the Mac comes back in the same pull as
        // part of the shared history, which is how the phone learns that its
        // change was accepted even over a route with no receipts.
        if !pending.isEmpty {
            let outcome = try await transport.push(ops: pending, cursor: engine.cursor)
            let settled = Set(outcome.settled)
            let done = pending.filter { settled.contains($0.seq) }
            if !done.isEmpty { try engine.markPushed(done) }

            status.report.pushed = done.count
            status.report.notes = outcome.notes
        }

        // Then pull, and keep pulling while the far side says there is more:
        // after a few days away the log does not fit in one batch, and
        // stopping halfway would leave a cursor that looks up to date.
        var guard_ = 0
        while true {
            let outcome = try await transport.pull(cursor: engine.cursor)
            guard !outcome.ops.isEmpty else { break }

            let report = try engine.applyRemote(outcome.ops)
            status.report.applied += report.applied
            status.report.skipped += report.skipped
            status.report.failed += report.failed
            status.report.notes.append(contentsOf: report.notes.prefix(10))

            // Only now. Advancing the cursor before the rows are written is
            // how a sync loses a batch invisibly.
            try engine.commitCursor(outcome.cursor)

            guard_ += 1
            if !outcome.more || guard_ >= 50 { break }
        }
    }
}
