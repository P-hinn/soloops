import Foundation
import SoloopsKit
import SwiftUI

/// Everything the app shares between its two faces.
///
/// The phone UI and the CarPlay scene are separate scenes in one process, and
/// both need the same store, the same engine and the same sync. Building that
/// twice would mean two SQLite connections writing the same file and two
/// clocks minting stamps independently — so there is exactly one of each, here.
@MainActor
@Observable
public final class AppEnvironment {
    /// The one instance. A singleton because `CPTemplateApplicationSceneDelegate`
    /// is created by the system with no way to inject anything into it.
    public static let shared = AppEnvironment()

    public enum State: Equatable {
        case needsPairing
        case ready
        case broken(String)
    }

    public private(set) var state: State = .needsPairing
    public private(set) var status = SyncCoordinator.Status()

    public private(set) var store: Store?
    public private(set) var engine: SyncEngine?
    public private(set) var coordinator: SyncCoordinator?

    /// Where the identity lives between launches.
    ///
    /// The token belongs in the keychain, not in `UserDefaults`: a device
    /// token opens the sync routes, and a backup of app preferences should not
    /// carry it. `Credentials` wraps that so the rest of the app does not have
    /// to think about it.
    let credentials = Credentials()

    private init() {
        restore()
    }

    // --- Lifecycle ---------------------------------------------------------

    func restore() {
        guard let identity = credentials.identity else {
            state = .needsPairing
            return
        }
        do {
            try open(identity: identity, endpoint: credentials.endpoint)
            state = .ready
        } catch {
            state = .broken("Lokale Datenbank nicht lesbar: \(error)")
        }
    }

    private func open(identity: SyncEngine.Identity, endpoint: LanTransport.Endpoint?) throws {
        let store = try Store(path: Self.databasePath())
        let engine = try SyncEngine(store: store, identity: identity)
        self.store = store
        self.engine = engine
        self.coordinator = SyncCoordinator(
            engine: engine,
            lan: endpoint,
            iCloudRoot: ICloudTransport.containerRoot()
        )
    }

    /// Application Support, not Documents.
    ///
    /// Documents is user-visible in Files, and the database is not a document
    /// — it is a cache of the Mac's state that happens to be writable. It is
    /// excluded from iCloud backup for the same reason: the op log would be
    /// restored onto a device whose identity no longer matches it.
    static func databasePath() -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let folder = base.appendingPathComponent("soloops", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        var url = folder.appendingPathComponent("soloops.sqlite")
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try? url.setResourceValues(resourceValues)

        return url.path
    }

    // --- Pairing -----------------------------------------------------------

    public func pair(with invitation: Pairing.Invitation) async -> String? {
        let name = UIDevice.current.name
        let result = await Pairing.claim(invitation: invitation, deviceName: name)

        switch result {
        case .failure(let error):
            switch error {
            case .notReachable: return "Mac nicht erreichbar. Gleiches WLAN?"
            case .rejected(let reason): return reason
            case .malformed(let reason): return reason
            }

        case .success(let (claim, endpoint)):
            let identity = SyncEngine.Identity(deviceId: claim.deviceId, token: claim.token)
            credentials.save(identity: identity, endpoint: endpoint, host: claim.host)

            do {
                try open(identity: identity, endpoint: endpoint)
            } catch {
                return "Lokale Datenbank konnte nicht angelegt werden: \(error)"
            }

            // The first fill comes from a snapshot rather than from replaying
            // the log, which only gets longer — see SnapshotImport.
            guard let engine else { return "Sync nicht bereit" }
            do {
                let transport = LanTransport(endpoint: endpoint, identity: identity)
                let snapshot = try await transport.snapshot()
                _ = try SnapshotImport(engine: engine).apply(
                    cursor: snapshot.cursor, entities: snapshot.entities)
            } catch {
                // Pairing worked; the first fill did not. The next sync will
                // catch up from the cursor, so this is not worth undoing.
                state = .ready
                return "Gekoppelt, aber die Erstübertragung fehlt noch"
            }

            state = .ready
            await sync()
            return nil
        }
    }

    public func unpair() {
        credentials.clear()
        store = nil
        engine = nil
        coordinator = nil
        // The local database stays. Re-pairing the same device would
        // otherwise re-download everything, and deleting data because a token
        // was removed is not a trade anybody asked for.
        state = .needsPairing
    }

    // --- Sync --------------------------------------------------------------

    public func sync() async {
        guard let coordinator else { return }
        status = await coordinator.syncNow()
    }

    public var agenda: Agenda? {
        store.map { Agenda(store: $0) }
    }
}

/// The device identity, split between the keychain and preferences.
final class Credentials {
    private let service = "com.soloops.app.sync"
    private let deviceKey = "sync.deviceId"
    private let endpointKey = "sync.endpoint"
    private let hostKey = "sync.host"

    var identity: SyncEngine.Identity? {
        guard let deviceId = UserDefaults.standard.string(forKey: deviceKey),
            let token = readToken(for: deviceId)
        else { return nil }
        return SyncEngine.Identity(deviceId: deviceId, token: token)
    }

    var endpoint: LanTransport.Endpoint? {
        guard let data = UserDefaults.standard.data(forKey: endpointKey) else { return nil }
        return try? JSONDecoder().decode(LanTransport.Endpoint.self, from: data)
    }

    func save(identity: SyncEngine.Identity, endpoint: LanTransport.Endpoint, host: String) {
        UserDefaults.standard.set(identity.deviceId, forKey: deviceKey)
        UserDefaults.standard.set(host, forKey: hostKey)
        UserDefaults.standard.set(try? JSONEncoder().encode(endpoint), forKey: endpointKey)
        writeToken(identity.token, for: identity.deviceId)
    }

    func clear() {
        if let deviceId = UserDefaults.standard.string(forKey: deviceKey) {
            deleteToken(for: deviceId)
        }
        UserDefaults.standard.removeObject(forKey: deviceKey)
        UserDefaults.standard.removeObject(forKey: endpointKey)
        UserDefaults.standard.removeObject(forKey: hostKey)
    }

    // --- Keychain ----------------------------------------------------------

    private func query(for deviceId: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: deviceId,
        ]
    }

    private func readToken(for deviceId: String) -> String? {
        var query = self.query(for: deviceId)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeToken(_ token: String, for deviceId: String) {
        deleteToken(for: deviceId)
        var attributes = query(for: deviceId)
        attributes[kSecValueData as String] = Data(token.utf8)
        // Readable after first unlock, because the sync has to run in the
        // background and in the car without the phone being unlocked first.
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    private func deleteToken(for deviceId: String) {
        SecItemDelete(query(for: deviceId) as CFDictionary)
    }
}
