import Foundation
import Testing

@testable import SoloopsKit

/// The capture box turns one sentence into one row. These hold the rules that
/// are easy to break without noticing — the title cut, the fields a row needs
/// to be usable on the Mac, and the German words people write instead of dates.
@Suite("Erfassen")
@SyncActor
struct CaptureTests {
    /// A Wednesday, so "Freitag" is ahead and "Montag" wraps into next week.
    private let now = ISO8601DateFormatter().date(from: "2026-10-14T09:00:00Z")!

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        return calendar
    }

    private func days(from date: Date) -> Int {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: date).day ?? -1
    }

    @Test("die erste Zeile wird der Titel, der Rest der Rumpf")
    func splitsTitleFromBody() {
        let draft = Capture.draft(from: "Angebot Muster AG\nzwei Wochen Aufwand", as: .lead, now: now)
        #expect(draft.title == "Angebot Muster AG")
        #expect(draft.patch["notes"] == .string("zwei Wochen Aufwand"))
    }

    @Test("ein langer Titel wird gekuerzt, nicht abgelehnt")
    func cutsLongTitles() {
        let long = String(repeating: "a", count: 200)
        let draft = Capture.draft(from: long, as: .task, now: now)
        #expect(draft.title.count == Capture.titleLimit)
    }

    @Test("ein Lead startet im Trichter, nicht im Nichts")
    func leadStartsInThePipeline() {
        let draft = Capture.draft(from: "Muster AG", as: .lead, now: now)
        #expect(draft.patch["stage"] == .string("NEW"))
        #expect(draft.patch["archived"] == .bool(false))
    }

    @Test("eine Aufgabe startet offen und auf der ersten Spalte")
    func taskStartsOpen() {
        let draft = Capture.draft(from: "Rechnung schreiben", as: .task, now: now)
        #expect(draft.patch["done"] == .bool(false))
        #expect(draft.patch["status"] == .string("TODO"))
    }

    @Test("eine Notiz behaelt den ganzen Text, nicht nur die erste Zeile")
    func noteKeepsEverything() {
        let draft = Capture.draft(from: "Kurz\nund lang", as: .note, now: now)
        #expect(draft.patch["body"] == .string("Kurz\nund lang"))
    }

    @Test("ohne Datumswort bekommt nichts eine Frist")
    func noDateMeansNoDueDate() {
        let draft = Capture.draft(from: "Irgendwas tun", as: .task, now: now)
        #expect(draft.patch["dueOn"] == nil)
        #expect(Capture.dueHint(in: "Irgendwas tun", now: now) == nil)
    }

    @Test("heute, morgen und uebermorgen")
    func relativeDays() {
        #expect(days(from: Capture.due(in: "heute anrufen", now: now)!) == 0)
        #expect(days(from: Capture.due(in: "morgen anrufen", now: now)!) == 1)
        #expect(days(from: Capture.due(in: "übermorgen anrufen", now: now)!) == 2)
    }

    /// Typed without the umlaut this still has to mean the day after tomorrow.
    /// "uebermorgen" contains "morgen", so getting it wrong is not a missing
    /// date — it is a confidently wrong one.
    @Test("auch ohne Umlaut geschrieben")
    func asciiSpellings() {
        #expect(days(from: Capture.due(in: "uebermorgen anrufen", now: now)!) == 2)
        #expect(days(from: Capture.due(in: "naechste woche nachfassen", now: now)!) == 7)
    }

    /// The order matters: "übermorgen" contains "morgen", so a naive check in
    /// the wrong order books the day after tomorrow for tomorrow.
    @Test("uebermorgen schlaegt morgen, nicht umgekehrt")
    func dayAfterTomorrowWinsOverTomorrow() {
        #expect(days(from: Capture.due(in: "übermorgen", now: now)!) == 2)
    }

    @Test("naechste Woche sind sieben Tage")
    func nextWeek() {
        #expect(days(from: Capture.due(in: "nächste woche nachfassen", now: now)!) == 7)
    }

    @Test("in drei Tagen")
    func inNDays() {
        #expect(days(from: Capture.due(in: "in 3 Tagen erinnern", now: now)!) == 3)
    }

    @Test("ein Wochentag meint den naechsten, der kommt")
    func weekdayLooksForward() {
        // 14.10.2026 is a Wednesday.
        #expect(days(from: Capture.due(in: "Freitag anrufen", now: now)!) == 2)
        #expect(days(from: Capture.due(in: "Montag anrufen", now: now)!) == 5)
    }

    @Test("derselbe Wochentag meint naechste Woche, nicht heute")
    func sameWeekdayMeansNextWeek() {
        #expect(days(from: Capture.due(in: "Mittwoch anrufen", now: now)!) == 7)
    }

    @Test("das Datum landet auch im Entwurf, nicht nur im Hinweis")
    func draftCarriesTheDate() {
        let draft = Capture.draft(from: "morgen nachfassen", as: .task, now: now)
        #expect(draft.patch["dueOn"] != nil)
        #expect(Capture.dueHint(in: "morgen nachfassen", now: now) != nil)
    }

    @Test("ein Lead bekommt eine Wiedervorlage, keine Faelligkeit")
    func leadGetsFollowUp() {
        let draft = Capture.draft(from: "morgen bei Muster AG nachfassen", as: .lead, now: now)
        #expect(draft.patch["followUpOn"] != nil)
        #expect(draft.patch["dueOn"] == nil)
    }

    @Test("jede Art schreibt in eine Tabelle, die es gibt")
    func everyKindTargetsAKnownEntity() {
        for kind in Capture.Kind.allCases {
            #expect(SyncEntities.isKnown(kind.entity))
        }
    }

    /// A row the Mac rejects is worse than no row: it syncs, fails the merge's
    /// required-field check and vanishes without telling anyone.
    @Test("jede Art fuellt die Pflichtfelder ihrer Tabelle")
    func everyKindFillsRequiredFields() {
        for kind in Capture.Kind.allCases {
            let draft = Capture.draft(from: "Etwas", as: kind, now: now)
            let spec = SyncEntities.spec(kind.entity)!
            for field in spec.required {
                #expect(draft.patch[field] != nil, "\(kind.entity) braucht \(field)")
            }
        }
    }

    /// Writing a column the registry does not have is how a patch gets dropped
    /// on the far side without a word.
    @Test("kein Entwurf schreibt ein Feld, das es nicht gibt")
    func everyFieldExists() {
        for kind in Capture.Kind.allCases {
            let draft = Capture.draft(from: "Etwas\nund mehr, morgen", as: kind, now: now)
            let spec = SyncEntities.spec(kind.entity)!
            for field in draft.patch.keys {
                #expect(spec.fields[field] != nil, "\(kind.entity) kennt \(field) nicht")
            }
        }
    }
}
