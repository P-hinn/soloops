import Foundation
import Testing

@testable import SoloopsKit

/// The store and the engine against real SQLite.
///
/// The counterpart of the API's `test/sync.integration.ts`, and for the same
/// reason: the interesting failures are not in the decision but in what gets
/// written. A cascade the phone resolves differently from the Mac, a clock
/// that forgets where it was, a batch applied twice — none of those show up in
/// a pure merge test.
@Suite("Store und Engine")
struct EngineTests {
    let phone = "phone-device"
    let mac = "mac-device"

    /// A fresh database per test. In a temporary directory rather than in
    /// memory, so the WAL mode and the file-level behaviour are the real ones.
    func makeStore() throws -> (Store, URL) {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("soloopskit-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let store = try Store(path: dir.appendingPathComponent("soloops.sqlite").path)
        return (store, dir)
    }

    func makeEngine() throws -> (SyncEngine, Store, URL) {
        let (store, dir) = try makeStore()
        let engine = try SyncEngine(
            store: store,
            identity: SyncEngine.Identity(deviceId: phone, token: "t")
        )
        return (engine, store, dir)
    }

    func stamp(_ millis: Int64, _ counter: Int = 0, _ device: String) -> String {
        Hlc.format(Hlc.State(millis: millis, counter: counter), deviceId: device)
    }

    // --- The schema --------------------------------------------------------

    @Test("die Tabellen entstehen aus der Registry")
    func schemaFollowsTheRegistry() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        // Every entity gets a table with every declared column, so a field
        // added to the registry cannot be missing here.
        for spec in SyncEntities.all {
            try store.write(
                entity: spec.name,
                id: "probe",
                patch: Dictionary(
                    uniqueKeysWithValues: spec.fieldOrder.map { ($0, SyncValue.null) }),
                isCreate: true
            )
            #expect(try store.exists(entity: spec.name, id: "probe"))
        }
    }

    @Test("jeder Feldtyp uebersteht Schreiben und Lesen")
    func everyKindRoundTrips() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        let patch: Patch = [
            "title": .string("Jour fixe"),
            "startsAt": .isoDate("2026-10-06T09:00:00.000Z"),
            "participants": .strings(["philipp@example.com", "kunde@example.com"]),
            "decisions": .json(Data("[\"Angebot bis Freitag\"]".utf8)),
            "status": .string("PLANNED"),
            "endsAt": .null,
        ]
        try store.write(entity: "Meeting", id: "m1", patch: patch, isCreate: true)

        let back = try #require(try store.row(entity: "Meeting", id: "m1"))
        #expect(back["title"] == .string("Jour fixe"))
        #expect(back["startsAt"] == .isoDate("2026-10-06T09:00:00.000Z"))
        #expect(back["participants"] == .strings(["philipp@example.com", "kunde@example.com"]))
        #expect(back["endsAt"] == .null)

        // `exDates` is the only list of dates, and it is on another table.
        try store.write(
            entity: "CalendarEvent",
            id: "e1",
            patch: [
                "title": .string("Serie"),
                "startsAt": .isoDate("2026-10-06T09:00:00.000Z"),
                "endsAt": .isoDate("2026-10-06T10:00:00.000Z"),
                "exDates": .dates(["2026-10-13T09:00:00.000Z"]),
                "allDay": .bool(false),
            ],
            isCreate: true
        )
        let event = try #require(try store.row(entity: "CalendarEvent", id: "e1"))
        #expect(event["exDates"] == .dates(["2026-10-13T09:00:00.000Z"]))
        #expect(event["allDay"] == .bool(false))
    }

    @Test("ein Update schreibt nur die genannten Spalten")
    func updateTouchesOnlyWhatItNames() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try store.write(
            entity: "ActionItem",
            id: "a1",
            patch: ["title": .string("Rueckruf"), "done": .bool(false)],
            isCreate: true
        )
        try store.write(entity: "ActionItem", id: "a1", patch: ["done": .bool(true)], isCreate: false)

        let row = try #require(try store.row(entity: "ActionItem", id: "a1"))
        #expect(row["title"] == .string("Rueckruf"))
        #expect(row["done"] == .bool(true))
    }

    // --- Local changes -----------------------------------------------------

    @Test("eine lokale Aenderung ist sofort da und wartet auf den Push")
    func localChangeIsImmediate() throws {
        let (engine, store, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        let op = try engine.recordLocal(
            entity: "Lead",
            id: "l1",
            patch: ["title": .string("Anfrage aus dem Auto"), "stage": .string("NEW")]
        )

        #expect(try store.exists(entity: "Lead", id: "l1"))
        #expect(op.deviceId == phone)
        #expect(op.seq == 1)
        // Unpushed: nothing has been online yet, and the change still counts.
        #expect(try engine.unpushed().count == 1)
    }

    @Test("Sequenznummern laufen hoch und wiederholen sich nicht")
    func seqIncrements() throws {
        let (engine, _, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        let first = try engine.recordLocal(entity: "Note", id: "n1", patch: ["title": .string("A")])
        let second = try engine.recordLocal(entity: "Note", id: "n2", patch: ["title": .string("B")])
        #expect(first.seq == 1)
        #expect(second.seq == 2)
        #expect(second.hlc > first.hlc)
    }

    @Test("ein bestaetigter Push wiederholt sich nicht")
    func pushedOpsAreNotResent() throws {
        let (engine, _, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        let op = try engine.recordLocal(entity: "Note", id: "n1", patch: ["title": .string("A")])
        try engine.markPushed([op])
        #expect(try engine.unpushed().isEmpty)
    }

    /// The phone has to expand cascades itself: the Mac's write hook stands
    /// down while applying a remote op, so if these ops did not come from
    /// here, deleting a meeting on the phone would leave its action items on
    /// the Mac for good.
    @Test("ein lokales Loeschen traegt die Folgen mit")
    func localDeleteCarriesItsConsequences() throws {
        let (engine, store, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        try engine.recordLocal(
            entity: "Meeting", id: "m1",
            patch: ["title": .string("Jour fixe"), "startsAt": .isoDate("2026-10-06T09:00:00.000Z")]
        )
        try engine.recordLocal(
            entity: "ActionItem", id: "a1",
            patch: ["title": .string("Angebot schicken"), "meetingId": .string("m1")]
        )
        try engine.recordLocal(
            entity: "Note", id: "n1",
            patch: ["title": .string("Protokoll"), "meetingId": .string("m1")]
        )

        let ops = try engine.deleteLocal(entity: "Meeting", id: "m1")

        // The cascaded action item is gone, the note survives with a cleared
        // reference, and both are in the log as their own ops.
        #expect(try !store.exists(entity: "ActionItem", id: "a1"))
        #expect(try store.exists(entity: "Note", id: "n1"))
        #expect(try store.row(entity: "Note", id: "n1")?["meetingId"] == .null)

        let described = Set(ops.map { "\($0.op.rawValue) \($0.entity) \($0.entityId)" })
        #expect(described.contains("delete ActionItem a1"))
        #expect(described.contains("upsert Note n1"))
        #expect(described.contains("delete Meeting m1"))

        // The note's op claims only the one field it changed, so a title edit
        // made on the Mac at the same time still wins.
        let noteOp = try #require(ops.first { $0.entity == "Note" })
        #expect(noteOp.fields == ["meetingId"])
    }

    // --- Changes from the Mac ----------------------------------------------

    @Test("ein Op vom Mac wird angewandt")
    func appliesRemote() throws {
        let (engine, store, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        let report = try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
                entity: "Client", entityId: "c1", op: .upsert,
                patch: ["name": .string("ACME GmbH"), "city": .string("Koeln")]
            )
        ])

        #expect(report.applied == 1)
        #expect(try store.row(entity: "Client", id: "c1")?["name"] == .string("ACME GmbH"))
    }

    @Test("ein zweites Mal geliefertes Op aendert nichts")
    func redeliveryIsFree() throws {
        let (engine, _, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        let op = SyncOp(
            deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
            entity: "Client", entityId: "c1", op: .upsert,
            patch: ["name": .string("ACME GmbH")]
        )
        #expect(try engine.applyRemote([op]).applied == 1)

        let second = try engine.applyRemote([op])
        #expect(second.applied == 0)
        #expect(second.skipped == 1)
    }

    @Test("ein angewandtes Op wird nicht als eigene Aenderung zurueckgeschickt")
    func noEcho() throws {
        let (engine, _, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
                entity: "Client", entityId: "c1", op: .upsert,
                patch: ["name": .string("ACME GmbH")]
            )
        ])

        // The op is logged under the Mac's identity and already settled, so
        // the next push has nothing to send. Without this the two devices
        // would trade the same change back and forth for ever.
        #expect(try engine.unpushed().isEmpty)
    }

    @Test("gleichzeitige Aenderungen an verschiedenen Feldern bleiben beide")
    func concurrentFieldsBothSurvive() throws {
        let (engine, store, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        // The Mac created the item a while ago.
        try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
                entity: "ActionItem", entityId: "a1", op: .upsert,
                patch: ["title": .string("Rueckruf Mueller"), "done": .bool(false)]
            )
        ])

        // The phone ticks it off — stamped now, so after the Mac's op.
        try engine.recordLocal(entity: "ActionItem", id: "a1", patch: ["done": .bool(true)])

        // And an older title change from the Mac arrives late.
        let report = try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 2, hlc: stamp(1_500_000, 0, mac),
                entity: "ActionItem", entityId: "a1", op: .upsert,
                patch: ["title": .string("Rueckruf Meier")]
            )
        ])

        #expect(report.applied == 1)
        let row = try #require(try store.row(entity: "ActionItem", id: "a1"))
        #expect(row["title"] == .string("Rueckruf Meier"))
        // The tick was stamped from the wall clock and is newer than anything
        // at millis 1_500_000, so it stands.
        #expect(row["done"] == .bool(true))
    }

    @Test("ein alter Schreiber auf dasselbe Feld verliert")
    func staleWriteLoses() throws {
        let (engine, store, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
                entity: "ActionItem", entityId: "a1", op: .upsert,
                patch: ["title": .string("Alt"), "done": .bool(false)]
            )
        ])
        try engine.recordLocal(entity: "ActionItem", id: "a1", patch: ["done": .bool(true)])

        let report = try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 2, hlc: stamp(1_200_000, 0, mac),
                entity: "ActionItem", entityId: "a1", op: .upsert,
                patch: ["done": .bool(false)]
            )
        ])

        #expect(report.skipped == 1)
        #expect(try store.row(entity: "ActionItem", id: "a1")?["done"] == .bool(true))
    }

    @Test("Elternzeile und Kind in einem Schwung, in der falschen Reihenfolge")
    func childBeforeParentInOneBatch() throws {
        let (engine, store, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        // The time entry sorts first and refers to a project that is not here
        // yet. The second pass has to pick it up.
        let report = try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
                entity: "TimeEntry", entityId: "t1", op: .upsert,
                patch: [
                    "projectId": .string("p1"),
                    "startedAt": .isoDate("2026-10-03T08:00:00.000Z"),
                    "description": .string("Anfahrt Kunde"),
                ]
            ),
            SyncOp(
                deviceId: mac, seq: 2, hlc: stamp(1_000_001, 0, mac),
                entity: "Project", entityId: "p1", op: .upsert,
                patch: ["key": .string("ACME-APP"), "name": .string("App")]
            ),
        ])

        #expect(report.applied == 2)
        #expect(report.failed == 0)
        #expect(try store.exists(entity: "TimeEntry", id: "t1"))
    }

    @Test("ein Verweis ins Leere wird gemeldet, nicht stillschweigend geschrieben")
    func danglingReferenceIsReported() throws {
        let (engine, store, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        let report = try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
                entity: "TimeEntry", entityId: "t1", op: .upsert,
                patch: [
                    "projectId": .string("gibt-es-nicht"),
                    "startedAt": .isoDate("2026-10-03T08:00:00.000Z"),
                ]
            )
        ])

        #expect(report.failed == 1)
        // SQLite has foreign keys off, so an unchecked insert would have
        // succeeded and left a row the app cannot display.
        #expect(try !store.exists(entity: "TimeEntry", id: "t1"))
    }

    @Test("eine Entitaet, die dieses Build nicht kennt, blockiert nichts")
    func unknownEntityDoesNotBlock() throws {
        let (engine, _, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        let report = try engine.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(1_000_000, 0, mac),
                entity: "Invoice", entityId: "i1", op: .upsert,
                patch: nil
            ),
            SyncOp(
                deviceId: mac, seq: 2, hlc: stamp(1_000_001, 0, mac),
                entity: "Client", entityId: "c1", op: .upsert,
                patch: ["name": .string("ACME GmbH")]
            ),
        ])

        #expect(report.skipped == 1)
        #expect(report.applied == 1)
    }

    // --- The clock, across a restart ---------------------------------------

    @Test("die Uhr ueberlebt einen Neustart der App")
    func clockSurvivesRelaunch() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        let identity = SyncEngine.Identity(deviceId: phone, token: "t")
        let first = try SyncEngine(store: store, identity: identity)

        // A stamp far in the future arrives from the Mac — a clock skew, or a
        // phone whose time was corrected backwards afterwards.
        try first.applyRemote([
            SyncOp(
                deviceId: mac, seq: 1, hlc: stamp(4_000_000_000_000, 0, mac),
                entity: "Client", entityId: "c1", op: .upsert,
                patch: ["name": .string("ACME GmbH")]
            )
        ])

        // Relaunch on the same database.
        let second = try SyncEngine(store: store, identity: identity)
        let op = try second.recordLocal(entity: "Client", id: "c2", patch: ["name": .string("B")])

        // The new instance must not mint a stamp behind what it already knows,
        // or the Mac would reject this edit as stale.
        #expect(op.hlc > stamp(4_000_000_000_000, 0, mac))
    }

    @Test("der Cursor wird erst gespeichert, wenn der Stapel drin ist")
    func cursorIsCommittedExplicitly() throws {
        let (engine, _, dir) = try makeEngine()
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(engine.cursor == Hlc.zero)
        try engine.commitCursor(stamp(1_000_000, 0, mac))
        #expect(engine.cursor == stamp(1_000_000, 0, mac))
        // An empty cursor is never stored over a real one: a pull that found
        // nothing must not rewind the device to the beginning of the log.
        try engine.commitCursor("")
        #expect(engine.cursor == stamp(1_000_000, 0, mac))
    }
}

/// The iCloud transport's file handling, without iCloud.
///
/// `ICloudTransport` takes its root as a parameter precisely so this can run
/// against a temporary directory: the behaviour worth testing is the naming,
/// the atomic write and the refusal to read another device's file.
@Suite("iCloud-Transport")
struct ICloudTransportTests {
    func makeTransport() throws -> (ICloudTransport, URL) {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("soloops-icloud-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (
            ICloudTransport(
                root: dir,
                identity: SyncEngine.Identity(deviceId: "phone-1", token: "t")
            ), dir
        )
    }

    @Test("ein Push landet als Datei im Postfach")
    func pushWritesAFile() async throws {
        let (transport, dir) = try makeTransport()
        defer { try? FileManager.default.removeItem(at: dir) }

        let op = SyncOp(
            deviceId: "phone-1", seq: 3,
            hlc: Hlc.format(Hlc.State(millis: 1000, counter: 0), deviceId: "phone-1"),
            entity: "Note", entityId: "n1", op: .upsert, patch: ["title": .string("A")]
        )
        _ = try await transport.push(ops: [op], cursor: "")

        let outbox = dir.appendingPathComponent(ICloudTransport.outbox)
        let names = try FileManager.default.contentsOfDirectory(atPath: outbox.path)
        #expect(names == ["phone-1-3-3.json"])
    }

    /// Handing a file to iCloud is not the Mac having read it. Reporting these
    /// as settled is exactly how an offline-first sync loses a day of work.
    @Test("ein Push ueber iCloud gilt noch nicht als bestaetigt")
    func icloudPushSettlesNothing() async throws {
        let (transport, dir) = try makeTransport()
        defer { try? FileManager.default.removeItem(at: dir) }

        let op = SyncOp(
            deviceId: "phone-1", seq: 1,
            hlc: Hlc.format(Hlc.State(millis: 1000, counter: 0), deviceId: "phone-1"),
            entity: "Note", entityId: "n1", op: .upsert, patch: ["title": .string("A")]
        )
        let outcome = try await transport.push(ops: [op], cursor: "")
        #expect(outcome.settled.isEmpty)
    }

    @Test("ein Pull liest die eigene Datei")
    func pullReadsOwnFile() async throws {
        let (transport, dir) = try makeTransport()
        defer { try? FileManager.default.removeItem(at: dir) }

        let inbox = dir.appendingPathComponent(ICloudTransport.inbox, isDirectory: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)

        let hlc = Hlc.format(Hlc.State(millis: 2000, counter: 0), deviceId: "mac")
        let payload: [String: Any] = [
            "forDevice": "phone-1",
            "cursor": hlc,
            "more": false,
            "ops": [
                [
                    "deviceId": "mac", "seq": 1, "hlc": hlc, "entity": "Note",
                    "entityId": "n1", "op": "upsert", "patch": ["title": "Vom Mac"],
                ]
            ],
        ]
        try JSONSerialization.data(withJSONObject: payload)
            .write(to: inbox.appendingPathComponent("phone-1.pending.json"))

        let outcome = try await transport.pull(cursor: "")
        #expect(outcome.ops.count == 1)
        #expect(outcome.cursor == hlc)
        #expect(outcome.ops.first?.patch?["title"] == .string("Vom Mac"))
    }

    /// A stale file from an earlier pairing must not be read as our own.
    @Test("eine Datei fuer ein anderes Geraet wird nicht angewandt")
    func refusesAnotherDevicesFile() async throws {
        let (transport, dir) = try makeTransport()
        defer { try? FileManager.default.removeItem(at: dir) }

        let inbox = dir.appendingPathComponent(ICloudTransport.inbox, isDirectory: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)

        let payload: [String: Any] = ["forDevice": "ein-anderes-telefon", "ops": [], "cursor": "x"]
        try JSONSerialization.data(withJSONObject: payload)
            .write(to: inbox.appendingPathComponent("phone-1.pending.json"))

        let outcome = try await transport.pull(cursor: "alt")
        #expect(outcome.ops.isEmpty)
        #expect(outcome.cursor == "alt")
    }

    @Test("bestaetigte Stapel werden aufgeraeumt, unbestaetigte nicht")
    func prunesOnlyWhatIsSettled() async throws {
        let (transport, dir) = try makeTransport()
        defer { try? FileManager.default.removeItem(at: dir) }

        let outbox = dir.appendingPathComponent(ICloudTransport.outbox, isDirectory: true)
        try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
        for name in ["phone-1-1-3.json", "phone-1-4-6.json", "phone-1-7-9.json"] {
            try Data("{}".utf8).write(to: outbox.appendingPathComponent(name))
        }

        try transport.pruneOutbox(settledThrough: 6)

        let left = try FileManager.default.contentsOfDirectory(atPath: outbox.path).sorted()
        #expect(left == ["phone-1-7-9.json"])
    }

    @Test("eine Geraete-ID kann nicht aus dem Ordner klettern")
    func deviceIdCannotEscape() throws {
        let (transport, dir) = try makeTransport()
        defer { try? FileManager.default.removeItem(at: dir) }
        // Same rule as the Rust side's `sanitise`.
        #expect(transport.sanitise("../../etc/passwd") == "------etc-passwd")
        #expect(transport.sanitise("cmusfwj2f0000c9v") == "cmusfwj2f0000c9v")
    }
}
