import Foundation
import Testing

@testable import SoloopsKit

/// The phone's registry against the API's.
///
/// `SyncEntities` is a hand-kept copy of `apps/api/src/services/
/// syncEntities.ts`, which it has to be: the app builds its SQLite schema
/// before it has ever paired, so it cannot ask. Copies drift, and this one
/// drifts silently — a field the Mac syncs and the phone does not know is
/// simply dropped on arrival, with no error anywhere.
///
/// So the API writes its registry to a fixture (`npm -w @soloops/api run
/// sync:registry`) and these tests hold the Swift side against it. When one of
/// them fails, the fix is to mirror the change here, not to regenerate the
/// fixture.
@Suite("Registry-Paritaet")
struct EntityParityTests {
    struct Registry: Decodable {
        struct Entity: Decodable {
            let name: String
            let rank: Int
            let required: [String]
            let fields: [String: String]
            let sideEffects: [Effect]
        }
        struct Effect: Decodable {
            let kind: String
            let entity: String
            let fk: String
        }
        let entities: [Entity]
    }

    let registry: Registry

    init() throws {
        let url = try #require(
            Bundle.module.url(forResource: "registry", withExtension: "json"),
            "registry.json fehlt im Testbundle"
        )
        registry = try JSONDecoder().decode(Registry.self, from: Data(contentsOf: url))
    }

    @Test("beide Seiten kennen dieselben Entitaeten")
    func sameEntities() {
        let server = Set(registry.entities.map(\.name))
        let phone = Set(SyncEntities.all.map(\.name))
        #expect(server == phone, "nur auf dem Server: \(server.subtracting(phone)), nur auf dem Telefon: \(phone.subtracting(server))")
    }

    @Test("beide Seiten kennen dieselben Felder mit denselben Typen")
    func sameFields() throws {
        for entity in registry.entities {
            let spec = try #require(SyncEntities.spec(entity.name), "\(entity.name) fehlt")

            let serverFields = Set(entity.fields.keys)
            let phoneFields = Set(spec.fields.keys)
            #expect(
                serverFields == phoneFields,
                "\(entity.name): nur Server \(serverFields.subtracting(phoneFields)), nur Telefon \(phoneFields.subtracting(serverFields))"
            )

            for (field, kind) in entity.fields {
                #expect(
                    spec.fields[field]?.rawValue == kind,
                    "\(entity.name).\(field): Server sagt \(kind), Telefon sagt \(spec.fields[field]?.rawValue ?? "nichts")"
                )
            }
        }
    }

    @Test("Pflichtfelder stimmen ueberein")
    func sameRequired() throws {
        for entity in registry.entities {
            let spec = try #require(SyncEntities.spec(entity.name))
            #expect(
                spec.required.sorted() == entity.required.sorted(),
                "\(entity.name): \(spec.required.sorted()) gegen \(entity.required.sorted())"
            )
        }
    }

    @Test("die Rangfolge stimmt ueberein")
    func sameRanks() throws {
        for entity in registry.entities {
            let spec = try #require(SyncEntities.spec(entity.name))
            #expect(spec.rank == entity.rank, "\(entity.name): \(spec.rank) gegen \(entity.rank)")
        }
    }

    /// The one most likely to rot: a relation added in schema.prisma without a
    /// matching line on either side leaves rows behind on one device for good.
    @Test("die Cascade-Tabellen stimmen ueberein")
    func sameSideEffects() throws {
        for entity in registry.entities {
            let spec = try #require(SyncEntities.spec(entity.name))

            let server = Set(entity.sideEffects.map { "\($0.kind) \($0.entity).\($0.fk)" })
            let phone = Set(
                spec.sideEffects.map {
                    "\($0.kind == .delete ? "delete" : "clear") \($0.entity).\($0.fk)"
                }
            )
            #expect(
                server == phone,
                "\(entity.name): nur Server \(server.subtracting(phone)), nur Telefon \(phone.subtracting(server))"
            )
        }
    }

    /// The reference map is inverted from the cascade table, so every entry
    /// has to name a column that exists on a table that exists.
    @Test("jeder abgeleitete Fremdschluessel zeigt auf eine bekannte Tabelle")
    func referencesResolve() {
        var broken: [String] = []
        for (key, target) in SyncEntities.referenceTargets {
            let parts = key.split(separator: ".")
            guard parts.count == 2, let child = SyncEntities.spec(String(parts[0])) else {
                broken.append("\(key): Kindtabelle unbekannt")
                continue
            }
            if child.fields[String(parts[1])] == nil {
                broken.append("\(key): Spalte gibt es nicht")
            }
            if SyncEntities.spec(target) == nil {
                broken.append("\(key) -> \(target): Zieltabelle unbekannt")
            }
        }
        #expect(broken.isEmpty, "kaputt: \(broken)")
        // Sanity: the inversion found something at all. An empty map would
        // make every test above pass and the deferral logic do nothing.
        #expect(SyncEntities.referenceTargets.count >= 10)
    }

    /// A column whose name ends in `Id` but refers to nothing. Guessing from
    /// the name would make the app refuse every client with a VAT number.
    @Test("vatId wird nicht fuer einen Fremdschluessel gehalten")
    func vatIdIsNotAReference() {
        #expect(SyncEntities.referenceTarget(entity: "Client", field: "vatId") == nil)
        #expect(SyncEntities.referenceTarget(entity: "Lead", field: "clientId") == "Client")
        #expect(SyncEntities.referenceTarget(entity: "Meeting", field: "eventId") == "CalendarEvent")
    }
}
