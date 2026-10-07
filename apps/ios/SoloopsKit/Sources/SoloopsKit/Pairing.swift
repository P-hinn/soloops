import Foundation

/// Getting this device known to the Mac, once.
///
/// There is no account anywhere, so the first handshake has to happen over
/// something both ends can see: the Mac shows an eight-character code (the web
/// UI renders it as a QR), the phone redeems it, and from then on the phone
/// holds a long random token. The code is deliberately short-lived and
/// single-use — see `apps/api/src/services/syncPairing.ts`.
public struct Pairing {
    public struct Claim: Equatable, Sendable, Codable {
        public let deviceId: String
        public let token: String
        public let name: String
        /// The Mac's own device id. Stored so the app can tell "the Mac"
        /// apart from a second phone later on.
        public let host: String
    }

    public enum PairingError: Error, Equatable {
        case notReachable
        case rejected(String)
        case malformed(String)
    }

    let endpoint: LanTransport.Endpoint
    let session: URLSession

    public init(endpoint: LanTransport.Endpoint, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    /// What a scanned QR code contains.
    ///
    /// The code alone is not enough: the phone also has to know where to send
    /// it, and asking the user to type an IP address is the kind of step that
    /// makes a feature go unused.
    public struct Invitation: Equatable, Sendable, Codable {
        public let code: String
        public let addresses: [String]
        public let port: Int

        public init(code: String, addresses: [String], port: Int) {
            self.code = code
            self.addresses = addresses
            self.port = port
        }

        /// Parse the payload the web UI puts in the QR code.
        ///
        /// `soloops://pair?code=ABCD2345&host=192.168.1.20&host=10.0.0.5&port=3000`
        public init?(url: URL) {
            guard url.scheme == "soloops", url.host == "pair",
                let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
            else { return nil }

            guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty
            else { return nil }

            let hosts = items.filter { $0.name == "host" }.compactMap(\.value)
            guard !hosts.isEmpty else { return nil }

            self.code = code
            self.addresses = hosts
            self.port = items.first(where: { $0.name == "port" })?.value.flatMap(Int.init) ?? 3000
        }
    }

    /// Redeem a code.
    ///
    /// The invitation may list several addresses — a Mac on Wi-Fi and Ethernet
    /// has two, and only one of them is the one this phone can reach. They are
    /// tried in order and the first that answers wins, because asking the user
    /// which network interface to use is not a question anybody should be
    /// asked.
    public static func claim(
        invitation: Invitation,
        deviceName: String,
        session: URLSession = .shared
    ) async -> Result<(claim: Claim, endpoint: LanTransport.Endpoint), PairingError> {
        var lastError = PairingError.notReachable

        for address in invitation.addresses {
            let endpoint = LanTransport.Endpoint(host: address, port: invitation.port)
            let pairing = Pairing(endpoint: endpoint, session: session)
            switch await pairing.redeem(code: invitation.code, deviceName: deviceName) {
            case .success(let claim):
                return .success((claim: claim, endpoint: endpoint))
            case .failure(let error):
                // A rejection is the Mac's final answer and the same from
                // every address — no point working through the rest.
                if case .rejected = error { return .failure(error) }
                lastError = error
            }
        }

        return .failure(lastError)
    }

    func redeem(code: String, deviceName: String) async -> Result<Claim, PairingError> {
        guard let base = endpoint.base else { return .failure(.malformed("Adresse unbrauchbar")) }

        var request = URLRequest(url: base.appendingPathComponent("pair/claim"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 5
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "code": code,
            "name": deviceName,
            "platform": "ios",
        ])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            return .failure(.notReachable)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]

        guard status == 201 else {
            return .failure(.rejected((object?["error"] as? String) ?? "Kopplung abgelehnt"))
        }
        guard let claim = try? JSONDecoder().decode(Claim.self, from: data) else {
            return .failure(.malformed("Antwort nicht lesbar"))
        }
        return .success(claim)
    }
}

/// The first fill of the local database.
///
/// A freshly paired device could also replay the whole op log, and that would
/// get slower every month the Mac has been running. The snapshot is the state
/// as of one point in time, and the cursor that comes with it says where the
/// log carries on — so nothing is applied twice and nothing is missed.
public struct SnapshotImport {
    public let engine: SyncEngine

    public init(engine: SyncEngine) {
        self.engine = engine
    }

    public struct Result: Equatable, Sendable {
        public var written = 0
        public var skipped = 0
        public var notes: [String] = []
    }

    /// Write a snapshot into the local store.
    ///
    /// Not recorded as ops: these rows are not changes anybody made, they are
    /// the starting point. Logging them would hand the Mac back its own state
    /// as if the phone had just typed all of it.
    public func apply(cursor: String, entities: [String: [[String: Any]]]) throws -> Result {
        var result = Result()

        // Parents before children, so a reference always has something to
        // point at by the time it is written.
        for spec in SyncEntities.byRank {
            guard let rows = entities[spec.name] else { continue }

            try engine.store.transaction {
                for raw in rows {
                    guard let id = raw["id"] as? String else {
                        result.skipped += 1
                        continue
                    }
                    do {
                        let patch = try SyncCodec.patch(from: raw, entity: spec.name)
                        try engine.store.write(
                            entity: spec.name, id: id, patch: patch, isCreate: true)
                        result.written += 1
                    } catch {
                        // One unreadable row must not cost the whole import.
                        result.skipped += 1
                        result.notes.append("\(spec.name) \(id): \(error)")
                    }
                }
            }
        }

        try engine.commitCursor(cursor)
        return result
    }
}
