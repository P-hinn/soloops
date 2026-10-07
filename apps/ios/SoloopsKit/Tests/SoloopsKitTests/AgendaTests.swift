import Foundation
import Testing

@testable import SoloopsKit

/// The read model and the wording of the briefing.
///
/// Fixed clock, fixed time zone, fixed locale. A test that depends on the
/// machine's settings passes in Cologne and fails in CI, and the thing being
/// checked here — that a driver hears something usable — has nothing to do
/// with either.
@Suite("Agenda und Briefing")
struct AgendaTests {
    /// Berlin, so the day boundary is the one the user lives in and not UTC.
    var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Berlin")!
        c.locale = Locale(identifier: "de_DE")
        return c
    }

    /// Tuesday, 6 October 2026, 09:30 local (07:30 UTC).
    let now = SyncCodec.date("2026-10-06T07:30:00.000Z")!

    func makeStore() throws -> (Store, URL) {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("soloops-agenda-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (try Store(path: dir.appendingPathComponent("a.sqlite").path), dir)
    }

    func addEvent(
        _ store: Store, _ id: String, _ title: String, from: String, to: String,
        location: String? = nil, allDay: Bool = false, clientId: String? = nil,
        kind: String = "MEETING"
    ) throws {
        var patch: Patch = [
            "title": .string(title),
            "startsAt": .isoDate(from),
            "endsAt": .isoDate(to),
            "allDay": .bool(allDay),
            "kind": .string(kind),
        ]
        if let location { patch["location"] = .string(location) }
        if let clientId { patch["clientId"] = .string(clientId) }
        try store.write(entity: "CalendarEvent", id: id, patch: patch, isCreate: true)
    }

    // --- Events ------------------------------------------------------------

    @Test("der Tag enthaelt genau die Termine dieses Tages")
    func eventsOfTheDay() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try addEvent(store, "e1", "Jour fixe", from: "2026-10-06T08:00:00.000Z", to: "2026-10-06T09:00:00.000Z")
        try addEvent(store, "e2", "Gestern", from: "2026-10-05T08:00:00.000Z", to: "2026-10-05T09:00:00.000Z")
        try addEvent(store, "e3", "Morgen", from: "2026-10-07T08:00:00.000Z", to: "2026-10-07T09:00:00.000Z")

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.events(on: now).map(\.id) == ["e1"])
    }

    /// A late meeting that runs past midnight belongs to both days, and the
    /// morning view has to show it or the driver thinks the day is clear.
    @Test("ein Termin ueber Mitternacht gehoert zu beiden Tagen")
    func eventAcrossMidnight() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        // 23:30 to 00:30 Berlin, i.e. 21:30 to 22:30 UTC on the 5th/6th.
        try addEvent(
            store, "e1", "Deployment",
            from: "2026-10-05T21:30:00.000Z", to: "2026-10-05T22:30:00.000Z")

        let agenda = Agenda(store: store, calendar: calendar)
        let yesterday = SyncCodec.date("2026-10-05T12:00:00.000Z")!
        #expect(try agenda.events(on: yesterday).map(\.id) == ["e1"])
        #expect(try agenda.events(on: now).map(\.id) == ["e1"])
    }

    @Test("Termine kommen in der Reihenfolge, in der sie passieren")
    func eventsAreOrdered() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try addEvent(store, "spaet", "Spaet", from: "2026-10-06T15:00:00.000Z", to: "2026-10-06T16:00:00.000Z")
        try addEvent(store, "frueh", "Frueh", from: "2026-10-06T06:00:00.000Z", to: "2026-10-06T07:00:00.000Z")

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.events(on: now).map(\.id) == ["frueh", "spaet"])
    }

    /// "What am I in" beats "what is next" when both exist.
    @Test("ein laufender Termin geht dem naechsten vor")
    func currentBeatsNext() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try addEvent(store, "laeuft", "Laeuft", from: "2026-10-06T07:00:00.000Z", to: "2026-10-06T08:00:00.000Z")
        try addEvent(store, "danach", "Danach", from: "2026-10-06T10:00:00.000Z", to: "2026-10-06T11:00:00.000Z")

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.current(at: now)?.id == "laeuft")
    }

    @Test("ohne laufenden Termin kommt der naechste")
    func nextWhenNothingRuns() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try addEvent(store, "vorbei", "Vorbei", from: "2026-10-06T05:00:00.000Z", to: "2026-10-06T06:00:00.000Z")
        try addEvent(store, "danach", "Danach", from: "2026-10-06T10:00:00.000Z", to: "2026-10-06T11:00:00.000Z")

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.current(at: now)?.id == "danach")
    }

    // --- Follow-ups --------------------------------------------------------

    func addLead(
        _ store: Store, _ id: String, _ title: String, followUpOn: String?,
        stage: String = "QUALIFIED", company: String? = nil, archived: Bool = false,
        note: String? = nil
    ) throws {
        var patch: Patch = [
            "title": .string(title),
            "stage": .string(stage),
            "archived": .bool(archived),
        ]
        patch["followUpOn"] = followUpOn.map { SyncValue.isoDate($0) } ?? .null
        if let company { patch["company"] = .string(company) }
        if let note { patch["followUpNote"] = .string(note) }
        try store.write(entity: "Lead", id: id, patch: patch, isCreate: true)
    }

    @Test("faellige Wiedervorlagen kommen, kuenftige nicht")
    func dueFollowUps() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try addLead(store, "faellig", "Mueller", followUpOn: "2026-10-01T09:00:00.000Z")
        try addLead(store, "heute", "Schmidt", followUpOn: "2026-10-06T06:00:00.000Z")
        try addLead(store, "spaeter", "Meier", followUpOn: "2026-10-20T09:00:00.000Z")
        try addLead(store, "ohne", "Ohne Datum", followUpOn: nil)

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.dueFollowUps(at: now).map(\.id) == ["faellig", "heute"])
    }

    /// A deal that is done is not waiting for a call, whatever its date says.
    @Test("gewonnene und verlorene Leads tauchen nicht auf")
    func closedLeadsAreNotDue() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try addLead(store, "offen", "Offen", followUpOn: "2026-10-01T09:00:00.000Z")
        try addLead(store, "gewonnen", "Gewonnen", followUpOn: "2026-10-01T09:00:00.000Z", stage: "WON")
        try addLead(store, "verloren", "Verloren", followUpOn: "2026-10-01T09:00:00.000Z", stage: "LOST")

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.dueFollowUps(at: now).map(\.id) == ["offen"])
    }

    @Test("archivierte Leads tauchen nicht auf")
    func archivedLeadsAreNotDue() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try addLead(store, "offen", "Offen", followUpOn: "2026-10-01T09:00:00.000Z")
        try addLead(store, "archiv", "Archiviert", followUpOn: "2026-10-01T09:00:00.000Z", archived: true)

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.dueFollowUps(at: now).map(\.id) == ["offen"])
    }

    @Test("die Ueberfaelligkeit zaehlt in Kalendertagen")
    func overdueInCalendarDays() throws {
        let followUp = AgendaFollowUp(
            id: "l1", title: "Mueller", company: nil, phone: nil, note: nil,
            dueOn: SyncCodec.date("2026-10-03T22:00:00.000Z")!, stage: "QUALIFIED"
        )
        // 04.10. 00:00 Berlin, three calendar days before the 6th at 09:30 —
        // not two, which is what a division by 86400 would say.
        #expect(followUp.daysOverdue(at: now, calendar: calendar) == 2)
    }

    // --- Open tasks --------------------------------------------------------

    @Test("offene Punkte mit Datum kommen vor denen ohne")
    func datedTasksFirst() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        try store.write(
            entity: "ActionItem", id: "ohne",
            patch: ["title": .string("Irgendwann"), "done": .bool(false), "dueOn": .null],
            isCreate: true)
        try store.write(
            entity: "ActionItem", id: "mit",
            patch: [
                "title": .string("Freitag"), "done": .bool(false),
                "dueOn": .isoDate("2026-10-09T09:00:00.000Z"),
            ],
            isCreate: true)
        try store.write(
            entity: "ActionItem", id: "fertig",
            patch: ["title": .string("Erledigt"), "done": .bool(true)],
            isCreate: true)

        let agenda = Agenda(store: store, calendar: calendar)
        #expect(try agenda.openTasks().map(\.id) == ["mit", "ohne"])
    }

    // --- The wording -------------------------------------------------------

    var briefing: Briefing {
        Briefing(calendar: calendar, locale: Locale(identifier: "de_DE"))
    }

    func event(
        _ title: String, at iso: String, until: String, location: String? = nil,
        clientId: String? = nil, allDay: Bool = false
    ) -> AgendaEvent {
        AgendaEvent(
            id: title, title: title,
            startsAt: SyncCodec.date(iso)!, endsAt: SyncCodec.date(until)!,
            allDay: allDay, location: location, kind: "MEETING",
            clientId: clientId, projectId: nil
        )
    }

    @Test("eine Terminzeile nennt Uhrzeit, Titel und Ort")
    func eventLine() {
        let line = briefing.line(
            for: event(
                "Jour fixe", at: "2026-10-06T08:00:00.000Z", until: "2026-10-06T09:00:00.000Z",
                location: "Köln"),
            clientName: "ACME GmbH"
        )
        // 08:00 UTC is 10:00 in Berlin — the driver hears local time.
        #expect(line == "10:00 Uhr, Jour fixe, mit ACME GmbH, in Köln")
    }

    /// Saying the customer's name twice is the kind of thing that makes a
    /// spoken briefing sound broken.
    @Test("der Kundenname wird nicht doppelt gesagt")
    func clientNameIsNotRepeated() {
        let line = briefing.line(
            for: event(
                "Termin ACME GmbH", at: "2026-10-06T08:00:00.000Z",
                until: "2026-10-06T09:00:00.000Z"),
            clientName: "ACME GmbH"
        )
        #expect(line == "10:00 Uhr, Termin ACME GmbH")
    }

    @Test("ein ganztaegiger Termin nennt keine Uhrzeit")
    func allDayHasNoTime() {
        let line = briefing.line(
            for: event(
                "Messe", at: "2026-10-06T00:00:00.000Z", until: "2026-10-07T00:00:00.000Z",
                allDay: true))
        #expect(line == "ganztägig, Messe")
    }

    @Test("eine leere Wiedervorlagenliste wird als solche gesagt")
    func emptyFollowUpsAreSpoken() {
        let text = briefing.spoken(events: [], followUps: [], at: now)
        #expect(text == "Keine Termine mehr heute. Keine offenen Wiedervorlagen.")
    }

    /// The count is first so the listener knows how long this will take.
    @Test("das Briefing nennt die Anzahl vor den Punkten")
    func countComesFirst() {
        let text = briefing.spoken(
            events: [
                event("Vorbei", at: "2026-10-06T05:00:00.000Z", until: "2026-10-06T06:00:00.000Z"),
                event("Jour fixe", at: "2026-10-06T08:00:00.000Z", until: "2026-10-06T09:00:00.000Z"),
                event("Abstimmung", at: "2026-10-06T13:00:00.000Z", until: "2026-10-06T14:00:00.000Z"),
            ],
            followUps: [],
            at: now
        )
        // The one that is already over is not mentioned at all.
        #expect(text.hasPrefix("Noch 2 Termine heute."))
        #expect(!text.contains("Vorbei"))
    }

    @Test("ein einzelner Termin wird im Singular gesagt")
    func singularForOne() {
        let text = briefing.spoken(
            events: [
                event("Jour fixe", at: "2026-10-06T08:00:00.000Z", until: "2026-10-06T09:00:00.000Z")
            ],
            followUps: [],
            at: now
        )
        #expect(text.hasPrefix("Noch ein Termin heute."))
    }

    @Test("mehr als drei Wiedervorlagen werden gekuerzt")
    func followUpsAreCapped() {
        let followUps = (1...5).map { index in
            AgendaFollowUp(
                id: "l\(index)", title: "Lead \(index)", company: nil, phone: nil, note: nil,
                dueOn: SyncCodec.date("2026-10-05T09:00:00.000Z")!, stage: "QUALIFIED"
            )
        }
        let text = briefing.spoken(events: [], followUps: followUps, at: now)
        #expect(text.contains("5 Wiedervorlagen."))
        #expect(text.contains("Lead 3"))
        #expect(!text.contains("Lead 4"))
        #expect(text.contains("Und 2 weitere."))
    }

    @Test("die Ueberfaelligkeit wird in Worten gesagt")
    func overdueInWords() {
        func line(_ iso: String) -> String {
            briefing.line(
                for: AgendaFollowUp(
                    id: "l", title: "Mueller", company: "ACME", phone: nil, note: nil,
                    dueOn: SyncCodec.date(iso)!, stage: "QUALIFIED"
                ),
                at: now
            )
        }
        #expect(line("2026-10-06T06:00:00.000Z") == "Mueller, ACME, heute fällig")
        #expect(line("2026-10-05T06:00:00.000Z") == "Mueller, ACME, seit gestern fällig")
        #expect(line("2026-10-01T06:00:00.000Z") == "Mueller, ACME, seit 5 Tagen fällig")
    }

    @Test("eine Notiz zur Wiedervorlage wird mitgesagt")
    func followUpNoteIsSpoken() {
        let text = briefing.line(
            for: AgendaFollowUp(
                id: "l", title: "Mueller", company: nil, phone: nil,
                note: "Angebot nachfassen", dueOn: SyncCodec.date("2026-10-06T06:00:00.000Z")!,
                stage: "QUALIFIED"
            ),
            at: now
        )
        #expect(text == "Mueller, heute fällig. Angebot nachfassen")
    }

    @Test("die Begruessung sagt, was gleich ansteht")
    func greetingIsUseful() {
        // Within the hour, so it counts down.
        let soon = briefing.greeting(
            next: event("Jour fixe", at: "2026-10-06T08:00:00.000Z", until: "2026-10-06T09:00:00.000Z"),
            clientName: nil, at: now
        )
        #expect(soon == "In 30 Minuten: 10:00 Uhr, Jour fixe.")

        let running = briefing.greeting(
            next: event("Laeuft", at: "2026-10-06T07:00:00.000Z", until: "2026-10-06T08:00:00.000Z"),
            clientName: nil, at: now
        )
        #expect(running.hasPrefix("Läuft gerade:"))

        let later = briefing.greeting(
            next: event("Spaet", at: "2026-10-06T15:00:00.000Z", until: "2026-10-06T16:00:00.000Z"),
            clientName: nil, at: now
        )
        #expect(later.hasPrefix("Als Nächstes:"))

        #expect(briefing.greeting(next: nil, clientName: nil, at: now) == "Nichts weiter für heute.")
    }
}
