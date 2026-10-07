import Foundation
import Testing

@testable import SoloopsKit

/// The merge, case for case against the API's `sync.test.ts`.
///
/// The names are the same as over there on purpose: when one side changes, the
/// pair of test names makes it obvious which case is now decided differently.
@Suite("Merge")
struct MergeTests {
    let phone = "phone"
    let mac = "mac"

    func stamp(_ millis: Int64, _ counter: Int, _ device: String) -> String {
        Hlc.format(Hlc.State(millis: millis, counter: counter), deviceId: device)
    }

    func op(
        hlc: String? = nil,
        entity: String = "ActionItem",
        id: String = "a1",
        kind: OpKind = .upsert,
        patch: Patch? = ["title": .string("Rueckruf")]
    ) -> SyncOp {
        SyncOp(
            deviceId: phone,
            seq: 1,
            hlc: hlc ?? stamp(1000, 0, phone),
            entity: entity,
            entityId: id,
            op: kind,
            patch: kind == .delete ? nil : patch
        )
    }

    func known(_ hlc: String, _ kind: OpKind, _ fields: [String]) -> Merge.KnownOp {
        Merge.KnownOp(hlc: hlc, op: kind, fields: fields)
    }

    @Test("eine neue Zeile wird angelegt")
    func createsANewRow() {
        let decision = Merge.decide(
            incoming: op(patch: ["title": .string("Rueckruf"), "done": .bool(false)]),
            known: [],
            exists: false
        )
        #expect(decision == .create(patch: ["title": .string("Rueckruf"), "done": .bool(false)]))
    }

    @Test("ohne Pflichtfeld wird nicht angelegt")
    func refusesIncompleteCreate() {
        let decision = Merge.decide(
            incoming: op(patch: ["done": .bool(true)]), known: [], exists: false)
        #expect(decision == .skip(reason: "Pflichtfelder fehlen: title"))
    }

    @Test("ein Pflichtfeld auf null zaehlt nicht als gesetzt")
    func nullIsNotAValueForRequired() {
        let decision = Merge.decide(
            incoming: op(patch: ["title": .null]), known: [], exists: false)
        #expect(decision == .skip(reason: "Pflichtfelder fehlen: title"))
    }

    @Test("eine bestehende Zeile wird geaendert")
    func updatesExisting() {
        let decision = Merge.decide(
            incoming: op(patch: ["done": .bool(true)]), known: [], exists: true)
        #expect(decision == .update(patch: ["done": .bool(true)]))
    }

    /// The case the per-field rule exists for.
    @Test("zwei Geraete, zwei Felder, beide Aenderungen bleiben")
    func differentFieldsBothSurvive() {
        let decision = Merge.decide(
            incoming: op(hlc: stamp(1000, 0, phone), patch: ["done": .bool(true)]),
            known: [known(stamp(2000, 0, mac), .upsert, ["title"])],
            exists: true
        )
        #expect(decision == .update(patch: ["done": .bool(true)]))
    }

    @Test("dasselbe Feld, lokal neuer: der aeltere Schreiber verliert")
    func olderWriterLoses() {
        let decision = Merge.decide(
            incoming: op(hlc: stamp(1000, 0, phone), patch: ["done": .bool(true)]),
            known: [known(stamp(2000, 0, mac), .upsert, ["done"])],
            exists: true
        )
        #expect(decision == .skip(reason: "jedes Feld lokal neuer"))
    }

    @Test("dasselbe Feld, lokal aelter: der neuere Schreiber gewinnt")
    func newerWriterWins() {
        let decision = Merge.decide(
            incoming: op(hlc: stamp(3000, 0, phone), patch: ["done": .bool(true)]),
            known: [known(stamp(2000, 0, mac), .upsert, ["done"])],
            exists: true
        )
        #expect(decision == .update(patch: ["done": .bool(true)]))
    }

    @Test("aus einem gemischten Patch bleibt das Frische uebrig")
    func mixedPatchIsFiltered() {
        let decision = Merge.decide(
            incoming: op(
                hlc: stamp(1000, 0, phone),
                patch: [
                    "title": .string("Neu"), "done": .bool(true),
                    "assignee": .string("Philipp"),
                ]
            ),
            known: [known(stamp(2000, 0, mac), .upsert, ["title"])],
            exists: true
        )
        #expect(
            decision == .update(patch: ["done": .bool(true), "assignee": .string("Philipp")])
        )
    }

    @Test("ein Op gegen sich selbst gehalten blockiert sich nicht")
    func opDoesNotBlockItself() {
        let hlc = stamp(1000, 0, phone)
        let decision = Merge.decide(
            incoming: op(hlc: hlc, patch: ["done": .bool(true)]),
            known: [known(hlc, .upsert, ["done"])],
            exists: true
        )
        #expect(decision == .update(patch: ["done": .bool(true)]))
    }

    @Test("ein Loeschen wird ausgefuehrt")
    func deletes() {
        #expect(Merge.decide(incoming: op(kind: .delete), known: [], exists: true) == .delete)
    }

    @Test("ein Loeschen auf eine schon fehlende Zeile ist still")
    func deleteOnMissingRow() {
        #expect(
            Merge.decide(incoming: op(kind: .delete), known: [], exists: false)
                == .skip(reason: "bereits geloescht")
        )
    }

    /// Stated choice, not a consequence of the algorithm.
    @Test("eine Aenderung nach dem Loeschen haelt die Zeile am Leben")
    func laterEditBeatsDelete() {
        let decision = Merge.decide(
            incoming: op(hlc: stamp(1000, 0, phone), kind: .delete),
            known: [known(stamp(2000, 0, mac), .upsert, ["title"])],
            exists: true
        )
        #expect(decision == .skip(reason: "nach dem Loeschen wurde die Zeile geaendert"))
    }

    @Test("eine Aenderung vor einem spaeteren Loeschen wird nicht mehr angewandt")
    func editBeforeDeleteIsDropped() {
        let decision = Merge.decide(
            incoming: op(hlc: stamp(1000, 0, phone), patch: ["done": .bool(true)]),
            known: [known(stamp(2000, 0, mac), .delete, [])],
            exists: false
        )
        #expect(decision == .skip(reason: "Zeile wurde danach geloescht"))
    }

    @Test("eine unbekannte Entitaet wird gemeldet, nicht angewandt")
    func unknownEntity() {
        #expect(
            Merge.decide(incoming: op(entity: "Invoice"), known: [], exists: false)
                == .skip(reason: "unbekannte Entitaet Invoice")
        )
    }

    @Test("Ops werden nach Zeile gruppiert")
    func groups() {
        let grouped = Merge.group([
            (entity: "ActionItem", entityId: "a1", op: known("h1", .upsert, ["done"])),
            (entity: "ActionItem", entityId: "a2", op: known("h2", .delete, [])),
            (entity: "ActionItem", entityId: "a1", op: known("h3", .upsert, ["title"])),
        ])
        #expect(grouped["ActionItem a1"]?.count == 2)
        #expect(grouped["ActionItem a2"]?.count == 1)
    }
}

/// The codec, where a wrong answer becomes a corrupted row rather than an
/// error.
@Suite("Codec")
struct CodecTests {
    @Test("ein ISO-String bleibt als ISO-String erhalten")
    func dateRoundTrip() throws {
        let value = try SyncCodec.value(
            "2026-10-03T08:00:00.000Z", kind: .date, field: "dueOn")
        #expect(value == .isoDate("2026-10-03T08:00:00.000Z"))
    }

    @Test("ein kaputtes Datum wird gemeldet, nicht geraten")
    func badDate() {
        #expect(throws: SyncCodec.DecodeError.badField(field: "dueOn", reason: "ungueltiges Datum"))
        {
            try SyncCodec.value("morgen", kind: .date, field: "dueOn")
        }
    }

    @Test("null ist ein Wert, kein fehlender Wert")
    func nullIsAValue() throws {
        #expect(try SyncCodec.value(NSNull(), kind: .date, field: "dueOn") == .null)
    }

    @Test("eine Zahl mit Komma ist keine Ganzzahl")
    func fractionalIsNotAnInt() {
        #expect(throws: SyncCodec.DecodeError.badField(field: "valueCents", reason: "Ganzzahl erwartet"))
        {
            try SyncCodec.value(1.5, kind: .int, field: "valueCents")
        }
    }

    /// `true` bridges to `NSNumber`, so without an explicit check it would
    /// arrive as the integer 1 and quietly become a money amount.
    @Test("true ist keine Ganzzahl")
    func boolIsNotAnInt() {
        #expect(throws: SyncCodec.DecodeError.badField(field: "valueCents", reason: "Ganzzahl erwartet"))
        {
            try SyncCodec.value(true, kind: .int, field: "valueCents")
        }
    }

    @Test("eine Zahl ist kein Boolean")
    func intIsNotABool() {
        #expect(throws: SyncCodec.DecodeError.badField(field: "done", reason: "Boolean erwartet")) {
            try SyncCodec.value(1, kind: .bool, field: "done")
        }
    }

    @Test("unbekannte Felder werden verworfen, nicht abgelehnt")
    func dropsUnknownFields() throws {
        let patch = try SyncCodec.patch(
            from: ["title": "X", "erfundenesFeld": 1], entity: "ActionItem")
        #expect(patch == ["title": .string("X")])
    }

    @Test("host-lokale Spalten gehen nicht mit auf Reisen")
    func hostLocalColumnsAreNotSynced() throws {
        let patch = try SyncCodec.patch(
            from: ["title": "X", "followUpNotifiedAt": "2026-10-03T00:00:00.000Z"],
            entity: "Lead"
        )
        #expect(patch == ["title": .string("X")])
    }

    @Test("ein Op geht als JSON raus und kommt gleich wieder rein")
    func opRoundTrip() throws {
        let original = SyncOp(
            deviceId: "phone",
            seq: 7,
            hlc: Hlc.format(Hlc.State(millis: 1000, counter: 0), deviceId: "phone"),
            entity: "Lead",
            entityId: "l1",
            op: .upsert,
            patch: [
                "title": .string("Anfrage"),
                "valueCents": .int(250_000),
                "archived": .bool(false),
                "followUpOn": .isoDate("2026-10-10T09:00:00.000Z"),
                "notes": .null,
            ]
        )
        let json = SyncCodec.jsonObject(original)
        let back = try SyncCodec.op(from: json)
        #expect(back == original)
    }

    @Test("ein Loeschen traegt keinen Patch")
    func deleteCarriesNoPatch() throws {
        let original = SyncOp(
            deviceId: "phone", seq: 1,
            hlc: Hlc.format(Hlc.State(millis: 1, counter: 0), deviceId: "phone"),
            entity: "Note", entityId: "n1", op: .delete
        )
        let back = try SyncCodec.op(from: SyncCodec.jsonObject(original))
        #expect(back.patch == nil)
        #expect(back.fields.isEmpty)
    }
}
