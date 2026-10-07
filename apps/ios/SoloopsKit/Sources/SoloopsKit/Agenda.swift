import Foundation

/// What the app shows, and what the car reads aloud.
///
/// In the kit rather than the app target, because this is the part with
/// judgement in it — which events count as today's, when a follow-up is
/// overdue, how a briefing is worded — and all of that is testable without a
/// phone. The CarPlay templates on top are a thin rendering of these types.
public struct AgendaEvent: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let startsAt: Date
    public let endsAt: Date
    public let allDay: Bool
    public let location: String?
    public let kind: String
    public let clientId: String?
    public let projectId: String?

    /// Running right now.
    public func isCurrent(at now: Date) -> Bool {
        !allDay && startsAt <= now && now < endsAt
    }
}

public struct AgendaFollowUp: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let company: String?
    public let phone: String?
    public let note: String?
    public let dueOn: Date
    public let stage: String

    /// Negative while it is still in the future.
    public func daysOverdue(at now: Date, calendar: Calendar) -> Int {
        let from = calendar.startOfDay(for: dueOn)
        let to = calendar.startOfDay(for: now)
        return calendar.dateComponents([.day], from: from, to: to).day ?? 0
    }
}

public struct AgendaTask: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let dueOn: Date?
    public let projectId: String?
}

/// Reading the local database for the views and the briefing.
///
/// Every query goes against SQLite, never the network: in the car there is
/// frequently no network, and an agenda that is sometimes empty is worse than
/// no agenda at all.
public struct Agenda {
    let store: Store
    let calendar: Calendar

    public init(store: Store, calendar: Calendar = .current) {
        self.store = store
        self.calendar = calendar
    }

    static func string(_ value: SyncValue?) -> String? {
        guard let value else { return nil }
        switch value {
        case .string(let s): return s.isEmpty ? nil : s
        case .isoDate(let s): return s.isEmpty ? nil : s
        default: return nil
        }
    }

    static func date(_ value: SyncValue?) -> Date? {
        guard case .isoDate(let s) = value else { return nil }
        return SyncCodec.date(s)
    }

    static func bool(_ value: SyncValue?) -> Bool {
        if case .bool(let b) = value { return b }
        return false
    }

    /// Everything on one day, in the order it happens.
    ///
    /// The window is computed in the local calendar and compared as ISO
    /// strings, which works because the stored values are UTC ISO: that
    /// ordering is the same as the chronological one.
    public func events(on day: Date) throws -> [AgendaEvent] {
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }

        // Overlap, not containment: a meeting that started before midnight
        // and runs into the morning belongs to this day too.
        let rows = try store.rows(
            entity: "CalendarEvent",
            where: "startsAt < ? AND endsAt > ?",
            bind: [.string(SyncCodec.isoString(end)), .string(SyncCodec.isoString(start))],
            orderBy: "startsAt ASC"
        )

        return rows.compactMap { row in
            guard let title = Self.string(row.patch["title"]),
                let startsAt = Self.date(row.patch["startsAt"]),
                let endsAt = Self.date(row.patch["endsAt"])
            else { return nil }

            return AgendaEvent(
                id: row.id,
                title: title,
                startsAt: startsAt,
                endsAt: endsAt,
                allDay: Self.bool(row.patch["allDay"]),
                location: Self.string(row.patch["location"]),
                kind: Self.string(row.patch["kind"]) ?? "FOCUS",
                clientId: Self.string(row.patch["clientId"]),
                projectId: Self.string(row.patch["projectId"])
            )
        }
    }

    /// The next thing that has not finished yet.
    ///
    /// Takes the one in progress over the one coming up: in the car, "what am
    /// I in" is a more useful answer than "what is next" when both exist.
    public func current(at now: Date) throws -> AgendaEvent? {
        let today = try events(on: now)
        if let running = today.first(where: { $0.isCurrent(at: now) }) { return running }
        return today.first { $0.startsAt > now && !$0.allDay }
    }

    /// Follow-ups that are due, oldest first.
    public func dueFollowUps(at now: Date, includingToday: Bool = true) throws -> [AgendaFollowUp] {
        let boundary =
            includingToday
            ? calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))
            : calendar.startOfDay(for: now)
        guard let boundary else { return [] }

        let rows = try store.rows(
            entity: "Lead",
            where: "followUpOn IS NOT NULL AND followUpOn < ? AND (archived IS NULL OR archived = 0)",
            bind: [.string(SyncCodec.isoString(boundary))],
            orderBy: "followUpOn ASC"
        )

        return rows.compactMap { row in
            guard let title = Self.string(row.patch["title"]),
                let dueOn = Self.date(row.patch["followUpOn"])
            else { return nil }

            // A lead that is already won or lost is not waiting for a call.
            let stage = Self.string(row.patch["stage"]) ?? "NEW"
            guard stage != "WON", stage != "LOST" else { return nil }

            return AgendaFollowUp(
                id: row.id,
                title: title,
                company: Self.string(row.patch["company"]),
                phone: Self.string(row.patch["phone"]),
                note: Self.string(row.patch["followUpNote"]),
                dueOn: dueOn,
                stage: stage
            )
        }
    }

    /// Open action items, the ones with a date first.
    public func openTasks(limit: Int = 20) throws -> [AgendaTask] {
        let rows = try store.rows(
            entity: "ActionItem",
            where: "done IS NULL OR done = 0",
            orderBy: "dueOn IS NULL ASC, dueOn ASC",
            limit: limit
        )
        return rows.compactMap { row in
            guard let title = Self.string(row.patch["title"]) else { return nil }
            return AgendaTask(
                id: row.id,
                title: title,
                dueOn: Self.date(row.patch["dueOn"]),
                projectId: Self.string(row.patch["projectId"])
            )
        }
    }

    public func clientName(_ id: String?) throws -> String? {
        guard let id, let row = try store.row(entity: "Client", id: id) else { return nil }
        return Self.string(row["company"]) ?? Self.string(row["name"])
    }

    public func projectName(_ id: String?) throws -> String? {
        guard let id, let row = try store.row(entity: "Project", id: id) else { return nil }
        return Self.string(row["name"])
    }

    /// Projects to log time against, most recently used first is not possible
    /// without a usage column — so active ones, by name.
    public func activeProjects() throws -> [(id: String, name: String, clientId: String?)] {
        let rows = try store.rows(
            entity: "Project",
            where: "status IS NULL OR status IN ('ACTIVE', 'LEAD', 'PAUSED')",
            orderBy: "name ASC"
        )
        return rows.compactMap { row in
            guard let name = Self.string(row.patch["name"]) else { return nil }
            return (id: row.id, name: name, clientId: Self.string(row.patch["clientId"]))
        }
    }
}

// ---------------------------------------------------------------------------
// The spoken briefing
// ---------------------------------------------------------------------------

/// Wording the day for a speech synthesiser.
///
/// Separate from `Agenda` because it is about language rather than data, and
/// because it is the part worth reading in a test: a briefing that says
/// "null Termine" or reads out an ISO timestamp is useless at 60 km/h, and
/// that is not something a type checker notices.
public struct Briefing {
    public let calendar: Calendar
    /// Injected so the tests are not at the mercy of the machine's locale.
    public let locale: Locale

    public init(calendar: Calendar = .current, locale: Locale = Locale(identifier: "de_DE")) {
        self.calendar = calendar
        self.locale = locale
    }

    var timeFormatter: DateFormatter {
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "HH:mm"
        return f
    }

    public func time(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    /// One line per event, as it should be heard.
    public func line(for event: AgendaEvent, clientName: String? = nil) -> String {
        var parts: [String] = []
        parts.append(event.allDay ? "ganztägig" : "\(time(event.startsAt)) Uhr")
        parts.append(event.title)
        if let clientName, !clientName.isEmpty, !event.title.contains(clientName) {
            parts.append("mit \(clientName)")
        }
        if let location = event.location, !location.isEmpty {
            parts.append("in \(location)")
        }
        return parts.joined(separator: ", ")
    }

    public func line(for followUp: AgendaFollowUp, at now: Date) -> String {
        let days = followUp.daysOverdue(at: now, calendar: calendar)
        let when: String
        switch days {
        case 0: return describe(followUp, when: "heute fällig")
        case 1: when = "seit gestern fällig"
        case let d where d > 1: when = "seit \(d) Tagen fällig"
        default: when = "fällig"
        }
        return describe(followUp, when: when)
    }

    private func describe(_ followUp: AgendaFollowUp, when: String) -> String {
        var text = followUp.title
        if let company = followUp.company, !company.isEmpty, !text.contains(company) {
            text += ", \(company)"
        }
        text += ", \(when)"
        if let note = followUp.note, !note.isEmpty { text += ". \(note)" }
        return text
    }

    /// The whole thing, as one block of speech.
    ///
    /// Written to be heard once, while driving: the count first so the length
    /// is known in advance, then the items. No numbers that need looking at,
    /// no words that only make sense on a screen.
    public func spoken(
        events: [AgendaEvent],
        followUps: [AgendaFollowUp],
        clientNames: [String: String] = [:],
        at now: Date
    ) -> String {
        var sentences: [String] = []

        let remaining = events.filter { $0.endsAt > now }
        if remaining.isEmpty {
            sentences.append("Keine Termine mehr heute.")
        } else {
            sentences.append(
                remaining.count == 1 ? "Noch ein Termin heute." : "Noch \(remaining.count) Termine heute."
            )
            for event in remaining {
                sentences.append(line(for: event, clientName: clientNames[event.clientId ?? ""]) + ".")
            }
        }

        if followUps.isEmpty {
            sentences.append("Keine offenen Wiedervorlagen.")
        } else {
            sentences.append(
                followUps.count == 1
                    ? "Eine Wiedervorlage." : "\(followUps.count) Wiedervorlagen."
            )
            // Three is what fits before the listener loses the thread; the
            // rest is a count, because a list nobody can remember is noise.
            for followUp in followUps.prefix(3) {
                sentences.append(line(for: followUp, at: now) + ".")
            }
            if followUps.count > 3 {
                sentences.append("Und \(followUps.count - 3) weitere.")
            }
        }

        return sentences.joined(separator: " ")
    }

    /// The short form, for the moment of getting into the car.
    public func greeting(next: AgendaEvent?, clientName: String?, at now: Date) -> String {
        guard let next else { return "Nichts weiter für heute." }
        if next.isCurrent(at: now) {
            return "Läuft gerade: \(line(for: next, clientName: clientName))."
        }
        let minutes = Int(next.startsAt.timeIntervalSince(now) / 60)
        if minutes <= 60 && minutes >= 0 {
            return "In \(minutes) Minuten: \(line(for: next, clientName: clientName))."
        }
        return "Als Nächstes: \(line(for: next, clientName: clientName))."
    }
}
