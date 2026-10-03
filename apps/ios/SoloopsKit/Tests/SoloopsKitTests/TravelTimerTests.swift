import Foundation
import Testing

@testable import SoloopsKit

/// The guesswork in the travel timer.
///
/// This is the one feature here that writes something billable without being
/// asked, so every rule that decides "yes, record this, against that customer"
/// is pinned down. A wrong guess ends up on an invoice.
@Suite("Fahrzeit")
struct TravelTimerTests {
    var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return c
    }

    var timer: TravelTimer { TravelTimer(calendar: calendar) }

    func at(_ iso: String) -> Date { SyncCodec.date(iso)! }

    func drive(_ from: String, _ to: String) -> TravelTimer.Drive {
        TravelTimer.Drive(startedAt: at(from), endedAt: at(to))
    }

    func meeting(
        _ title: String, from: String, to: String, project: String? = "p1",
        client: String? = "c1", allDay: Bool = false
    ) -> AgendaEvent {
        AgendaEvent(
            id: title, title: title, startsAt: at(from), endsAt: at(to),
            allDay: allDay, location: nil, kind: "MEETING",
            clientId: client, projectId: project
        )
    }

    // --- What is not a journey ---------------------------------------------

    @Test("zu kurz ist keine Fahrt")
    func tooShort() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:02:00.000Z"), around: [])
        #expect(outcome == .ignore(reason: "unter 3 Minuten"))
    }

    /// The phone left in a parked car with the ignition on. Recording eight
    /// hours of travel would be worse than recording nothing.
    @Test("zu lang ist keine Fahrt")
    func tooLong() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T06:00:00.000Z", "2026-10-06T15:00:00.000Z"), around: [])
        #expect(outcome == .ignore(reason: "länger als 4 Stunden"))
    }

    @Test("eine Fahrt ohne passenden Termin wird trotzdem erfasst, nur ohne Projekt")
    func recordedWithoutAProject() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:40:00.000Z"), around: [])
        #expect(outcome == .record(projectId: nil, clientId: nil, description: "Fahrt"))
    }

    // --- Finding the destination -------------------------------------------

    @Test("eine Fahrt kurz vor einem Termin ist die Anfahrt")
    func driveBeforeAMeeting() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:45:00.000Z"),
            around: [meeting("ACME Workshop", from: "2026-10-06T09:00:00.000Z", to: "2026-10-06T11:00:00.000Z")]
        )
        #expect(
            outcome
                == .record(projectId: "p1", clientId: "c1", description: "Anfahrt ACME Workshop"))
    }

    @Test("eine Fahrt kurz nach einem Termin ist die Rueckfahrt")
    func driveAfterAMeeting() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T11:10:00.000Z", "2026-10-06T11:55:00.000Z"),
            around: [meeting("ACME Workshop", from: "2026-10-06T09:00:00.000Z", to: "2026-10-06T11:00:00.000Z")]
        )
        #expect(
            outcome
                == .record(projectId: "p1", clientId: "c1", description: "Rückfahrt ACME Workshop"))
    }

    @Test("ein weit entfernter Termin ist nicht das Ziel")
    func meetingTooFarAway() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:40:00.000Z"),
            around: [meeting("Spaet", from: "2026-10-06T16:00:00.000Z", to: "2026-10-06T17:00:00.000Z")]
        )
        #expect(outcome == .record(projectId: nil, clientId: nil, description: "Fahrt"))
    }

    @Test("von zwei Terminen gewinnt der naehere")
    func nearestMeetingWins() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:45:00.000Z"),
            around: [
                meeting("Weiter weg", from: "2026-10-06T10:00:00.000Z", to: "2026-10-06T11:00:00.000Z", project: "fern"),
                meeting("Gleich", from: "2026-10-06T09:00:00.000Z", to: "2026-10-06T09:30:00.000Z", project: "nah"),
            ]
        )
        #expect(outcome == .record(projectId: "nah", clientId: "c1", description: "Anfahrt Gleich"))
    }

    /// An all-day entry has no time to be near, so it cannot be a destination.
    @Test("ein ganztaegiger Eintrag ist kein Ziel")
    func allDayIsNotADestination() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:45:00.000Z"),
            around: [
                meeting(
                    "Urlaub", from: "2026-10-06T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z",
                    allDay: true)
            ]
        )
        #expect(outcome == .record(projectId: nil, clientId: nil, description: "Fahrt"))
    }

    @Test("ein Termin ohne Projekt liefert kein Projekt, aber den Kunden")
    func meetingWithoutAProject() {
        let outcome = timer.outcome(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:45:00.000Z"),
            around: [
                meeting(
                    "Kennenlernen", from: "2026-10-06T09:00:00.000Z",
                    to: "2026-10-06T10:00:00.000Z", project: nil, client: "c9")
            ]
        )
        #expect(
            outcome == .record(projectId: nil, clientId: "c9", description: "Anfahrt Kennenlernen"))
    }

    // --- The entry ---------------------------------------------------------

    @Test("die Zeitbuchung traegt Dauer, Beschreibung und Kennzeichnung")
    func patchIsComplete() {
        let journey = drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:45:00.000Z")
        let patch = timer.patch(
            for: journey, projectId: "p1", clientId: "c1", description: "Anfahrt ACME")

        #expect(patch["projectId"] == .string("p1"))
        #expect(patch["clientId"] == .string("c1"))
        #expect(patch["durationSec"] == .int(45 * 60))
        #expect(patch["startedAt"] == .isoDate("2026-10-06T08:00:00.000Z"))
        #expect(patch["endedAt"] == .isoDate("2026-10-06T08:45:00.000Z"))
        #expect(patch["billable"] == .bool(true))
        #expect(patch["description"] == .string("Anfahrt ACME"))
        // Tagged so a drive can be told from desk work on an invoice.
        #expect(patch["tags"] == .strings(["fahrt"]))
    }

    /// `TimeSource` has no `TRAVEL`, and inventing one here would be a value
    /// the API's enum rejects — so the entry stays a timer entry.
    @Test("die Quelle bleibt ein Wert, den die API kennt")
    func sourceStaysValid() {
        let patch = timer.patch(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:45:00.000Z"),
            projectId: "p1", clientId: nil, description: "Fahrt"
        )
        #expect(patch["source"] == .string("TIMER"))
        #expect(patch["clientId"] == .null)
    }

    @Test("eine Fahrzeitbuchung laesst sich wirklich speichern")
    func patchIsAcceptedByTheStore() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("soloops-travel-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = try Store(path: dir.appendingPathComponent("t.sqlite").path)
        let engine = try SyncEngine(
            store: store, identity: SyncEngine.Identity(deviceId: "phone", token: "t"))

        try store.write(
            entity: "Project", id: "p1",
            patch: ["key": .string("ACME-APP"), "name": .string("App")], isCreate: true)

        let patch = timer.patch(
            for: drive("2026-10-06T08:00:00.000Z", "2026-10-06T08:45:00.000Z"),
            projectId: "p1", clientId: nil, description: "Anfahrt ACME"
        )
        let op = try engine.recordLocal(entity: "TimeEntry", id: "te1", patch: patch)

        // Every field in the patch is one the registry knows, so the op claims
        // all of them and the Mac will accept it.
        #expect(Set(op.fields) == Set(patch.keys))
        #expect(try store.row(entity: "TimeEntry", id: "te1")?["durationSec"] == .int(2700))
    }
}

/// The pairing payload, which arrives as a scanned string and must not be
/// trusted to be well formed.
@Suite("Kopplung")
struct PairingTests {
    @Test("eine Einladung wird aus dem QR-Code gelesen")
    func parsesInvitation() throws {
        let url = try #require(
            URL(
                string:
                    "soloops://pair?code=ABCD2345&host=192.168.1.20&host=10.0.0.5&port=3000"))
        let invitation = try #require(Pairing.Invitation(url: url))
        #expect(invitation.code == "ABCD2345")
        #expect(invitation.addresses == ["192.168.1.20", "10.0.0.5"])
        #expect(invitation.port == 3000)
    }

    @Test("ohne Port gilt der Standard")
    func defaultPort() throws {
        let url = try #require(URL(string: "soloops://pair?code=ABCD2345&host=192.168.1.20"))
        #expect(Pairing.Invitation(url: url)?.port == 3000)
    }

    @Test("unbrauchbare Einladungen werden abgelehnt")
    func rejectsRubbish() throws {
        // Someone else's QR code, a typo, or a deep link from another app.
        for text in [
            "https://example.com/pair?code=X&host=h",
            "soloops://etwasanderes?code=X&host=h",
            "soloops://pair?host=192.168.1.20",
            "soloops://pair?code=ABCD2345",
            "soloops://pair?code=&host=192.168.1.20",
        ] {
            let url = try #require(URL(string: text))
            #expect(Pairing.Invitation(url: url) == nil, "angenommen: \(text)")
        }
    }
}
