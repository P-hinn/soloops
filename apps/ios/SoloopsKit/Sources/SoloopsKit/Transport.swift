import Foundation

/// Getting ops across, by whichever route is open.
///
/// Two of them, with different failure modes, and the engine does not care
/// which one it got a batch from:
///
///  - **LAN.** The Mac answers on the local network. Fast, two-way in one
///    round trip, and the only route that can hand over a snapshot. Gone the
///    moment the phone leaves the house.
///  - **iCloud.** The phone drops a file in its own container and Apple moves
///    it; the desktop app picks it up on the other side. Works from anywhere,
///    takes seconds to minutes, and has no delivery receipt — so every batch
///    may be delivered more than once, which the op log is built to absorb.
///
/// Neither is a fallback for the other in the usual sense: the phone uses the
/// LAN when it is there because it is immediate, and iCloud otherwise because
/// it is the only thing left. Both end up in the same log.
public protocol SyncTransport: Sendable {
    /// Hand over what this device made. Returns the ops the far side accepted.
    func push(ops: [SyncOp], cursor: String) async throws -> PushOutcome
    /// Fetch what happened elsewhere.
    func pull(cursor: String) async throws -> PullOutcome
}

public struct PushOutcome: Sendable {
    /// Which ops the far side has taken responsibility for, by `seq`.
    public var settled: [Int]
    public var applied: Int
    public var skipped: Int
    public var failed: Int
    public var notes: [String]

    public init(
        settled: [Int] = [], applied: Int = 0, skipped: Int = 0, failed: Int = 0,
        notes: [String] = []
    ) {
        self.settled = settled
        self.applied = applied
        self.skipped = skipped
        self.failed = failed
        self.notes = notes
    }
}

public struct PullOutcome: Sendable {
    public var ops: [SyncOp]
    public var cursor: String
    public var more: Bool

    public init(ops: [SyncOp] = [], cursor: String = "", more: Bool = false) {
        self.ops = ops
        self.cursor = cursor
        self.more = more
    }
}

public enum TransportError: Error, Equatable {
    case notReachable
    case unauthorised
    case server(status: Int, message: String)
    case malformed(String)
}

// ---------------------------------------------------------------------------
// LAN
// ---------------------------------------------------------------------------

/// Talking to the API over the local network.
public struct LanTransport: SyncTransport {
    public struct Endpoint: Equatable, Sendable, Codable {
        public var host: String
        public var port: Int

        public init(host: String, port: Int) {
            self.host = host
            self.port = port
        }

        var base: URL? { URL(string: "http://\(host):\(port)/api/sync") }
    }

    let endpoint: Endpoint
    let identity: SyncEngine.Identity
    let session: URLSession

    public init(
        endpoint: Endpoint,
        identity: SyncEngine.Identity,
        session: URLSession = .shared
    ) {
        self.endpoint = endpoint
        self.identity = identity
        self.session = session
    }

    public func push(ops: [SyncOp], cursor: String) async throws -> PushOutcome {
        let body: [String: Any] = [
            "ops": ops.map(SyncCodec.jsonObject),
            "cursor": cursor,
        ]
        let answer = try await call("push", body: body)

        let results = answer["results"] as? [[String: Any]] ?? []
        var notes: [String] = []
        var settled: [Int] = []
        for result in results {
            guard let seq = (result["seq"] as? NSNumber)?.intValue else { continue }
            let status = result["status"] as? String ?? ""
            // `applied` and `skipped` both mean the Mac has it and will never
            // need it again. Only `failed` is worth another attempt — usually
            // a row referring to something the Mac has not got yet, which the
            // next batch may well bring.
            if status == "applied" || status == "skipped" { settled.append(seq) }
            if let reason = result["reason"] as? String, status != "applied" {
                notes.append("\(seq): \(reason)")
            }
        }

        return PushOutcome(
            settled: settled,
            applied: (answer["applied"] as? NSNumber)?.intValue ?? 0,
            skipped: (answer["skipped"] as? NSNumber)?.intValue ?? 0,
            failed: (answer["failed"] as? NSNumber)?.intValue ?? 0,
            notes: notes
        )
    }

    public func pull(cursor: String) async throws -> PullOutcome {
        let answer = try await call("pull", body: ["cursor": cursor])
        let raw = answer["ops"] as? [[String: Any]] ?? []
        return PullOutcome(
            ops: raw.compactMap { try? SyncCodec.op(from: $0) },
            cursor: answer["cursor"] as? String ?? cursor,
            more: answer["more"] as? Bool ?? false
        )
    }

    /// The one-off handover for a device that has never synced.
    public func snapshot() async throws -> (cursor: String, entities: [String: [[String: Any]]]) {
        let answer = try await call("snapshot", body: [:])
        return (
            cursor: answer["cursor"] as? String ?? "",
            entities: answer["entities"] as? [String: [[String: Any]]] ?? [:]
        )
    }

    private func call(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let base = endpoint.base else {
            throw TransportError.malformed("Adresse unbrauchbar")
        }

        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(identity.token)", forHTTPHeaderField: "Authorization")
        request.setValue(identity.deviceId, forHTTPHeaderField: "X-Soloops-Device")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        // Short on purpose. The Mac is either on this network and answers at
        // once, or it is not there and the iCloud route is the answer. Waiting
        // thirty seconds for that verdict is thirty seconds of a progress
        // spinner in a car.
        request.timeoutInterval = 5

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw TransportError.notReachable
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 || status == 403 { throw TransportError.unauthorised }
        guard status == 200 else {
            let message =
                (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"]
                as? String
            throw TransportError.server(status: status, message: message ?? "")
        }

        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TransportError.malformed("Antwort ist kein Objekt")
        }
        return object
    }
}

// ---------------------------------------------------------------------------
// iCloud
// ---------------------------------------------------------------------------

/// Ops as files in the app's own iCloud container.
///
/// The counterpart is `apps/desktop/src-tauri/src/sync.rs`. The split of
/// responsibility is: this side writes into `to-mac` and reads `to-phone`,
/// that side does the reverse, and neither ever rewrites the other's folder.
public struct ICloudTransport: SyncTransport {
    public static let inbox = "to-phone"
    public static let outbox = "to-mac"

    let root: URL
    let identity: SyncEngine.Identity
    /// `nonisolated(unsafe)` because `FileManager` is not `Sendable`. The
    /// instance is only ever read here, and the documented thread-safe subset
    /// is all this uses — file existence, directory listing, move, remove.
    nonisolated(unsafe) let fileManager: FileManager

    public init(root: URL, identity: SyncEngine.Identity, fileManager: FileManager = .default) {
        self.root = root
        self.identity = identity
        self.fileManager = fileManager
    }

    /// The container path, if iCloud Drive is switched on for this app.
    ///
    /// Nil is a normal answer, not an error: the user may have iCloud Drive
    /// off, in which case the LAN is the only route and the app says so rather
    /// than failing every thirty seconds.
    public static func containerRoot(
        identifier: String = "iCloud.com.soloops.app",
        fileManager: FileManager = .default
    ) -> URL? {
        fileManager.url(forUbiquityContainerIdentifier: identifier)?
            .appendingPathComponent("Documents/sync", isDirectory: true)
    }

    public func push(ops: [SyncOp], cursor: String) async throws -> PushOutcome {
        guard !ops.isEmpty || !cursor.isEmpty else { return PushOutcome() }

        let folder = root.appendingPathComponent(Self.outbox, isDirectory: true)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)

        // Named by the range it covers, so writing the same batch twice
        // overwrites rather than piles up, and so the Mac's log shows what a
        // file held without opening it.
        let first = ops.first?.seq ?? 0
        let last = ops.last?.seq ?? 0
        let name = "\(sanitise(identity.deviceId))-\(first)-\(last).json"

        let payload: [String: Any] = [
            "deviceId": identity.deviceId,
            "ops": ops.map(SyncCodec.jsonObject),
            "cursor": cursor,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        try writeAtomically(data, to: folder.appendingPathComponent(name))

        // Nothing is settled yet. The file has been handed to iCloud, which is
        // not the same as the Mac having seen it — the ops stay unpushed until
        // they come back in a pull as somebody else's history, or until the
        // LAN route settles them. Reporting them as settled here is exactly
        // how an offline-first sync loses a day of work.
        return PushOutcome(settled: [], notes: ["über iCloud abgelegt, noch nicht bestätigt"])
    }

    public func pull(cursor: String) async throws -> PullOutcome {
        let folder = root.appendingPathComponent(Self.inbox, isDirectory: true)
        guard fileManager.fileExists(atPath: folder.path) else { return PullOutcome(cursor: cursor) }

        let name = "\(sanitise(identity.deviceId)).pending.json"
        let file = folder.appendingPathComponent(name)
        guard fileManager.fileExists(atPath: file.path) else { return PullOutcome(cursor: cursor) }

        // iCloud hands out a placeholder until the file is actually here.
        try? (file as NSURL).setResourceValue(true, forKey: .ubiquitousItemDownloadRequestedKey)

        guard let data = fileManager.contents(atPath: file.path), !data.isEmpty,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            // Still downloading. Not an error; the next round will find it.
            return PullOutcome(cursor: cursor)
        }

        // A batch addressed to another device must not be applied. It should
        // not happen — the Mac writes one file per device — but a stale file
        // from a previous pairing would otherwise be read as our own.
        if let forDevice = object["forDevice"] as? String, forDevice != identity.deviceId {
            return PullOutcome(cursor: cursor)
        }

        let raw = object["ops"] as? [[String: Any]] ?? []
        return PullOutcome(
            ops: raw.compactMap { try? SyncCodec.op(from: $0) },
            cursor: object["cursor"] as? String ?? cursor,
            more: object["more"] as? Bool ?? false
        )
    }

    /// Drop the file once its contents are in the local log.
    ///
    /// Separate from `pull` on purpose: deleting on read would lose the batch
    /// if the app were killed before the rows were written, and the Mac's
    /// cursor would already have moved past it.
    public func acknowledge() throws {
        let name = "\(sanitise(identity.deviceId)).pending.json"
        let file = root.appendingPathComponent(Self.inbox).appendingPathComponent(name)
        if fileManager.fileExists(atPath: file.path) {
            try fileManager.removeItem(at: file)
        }
    }

    /// Clear out batches the Mac has confirmed, so the folder does not grow.
    public func pruneOutbox(settledThrough seq: Int) throws {
        let folder = root.appendingPathComponent(Self.outbox, isDirectory: true)
        guard let names = try? fileManager.contentsOfDirectory(atPath: folder.path) else { return }
        let prefix = "\(sanitise(identity.deviceId))-"

        for name in names where name.hasPrefix(prefix) && name.hasSuffix(".json") {
            // `<device>-<first>-<last>.json`
            let middle = name.dropFirst(prefix.count).dropLast(".json".count)
            let parts = middle.split(separator: "-")
            guard parts.count == 2, let last = Int(parts[1]), last <= seq else { continue }
            try? fileManager.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    /// A device id ends up in a path, so it is reduced to characters that
    /// cannot climb out of the folder. Same rule as on the Rust side.
    func sanitise(_ id: String) -> String {
        String(
            id.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" }
        )
    }

    /// Write to a temporary name, then move it into place.
    ///
    /// iCloud uploads whatever it finds. A half-written file would reach the
    /// Mac as a truncated batch; a move within the same folder is atomic.
    private func writeAtomically(_ data: Data, to url: URL) throws {
        let temp = url.deletingPathExtension().appendingPathExtension("tmp")
        try data.write(to: temp, options: .atomic)
        if fileManager.fileExists(atPath: url.path) {
            _ = try fileManager.replaceItemAt(url, withItemAt: temp)
        } else {
            try fileManager.moveItem(at: temp, to: url)
        }
    }
}
