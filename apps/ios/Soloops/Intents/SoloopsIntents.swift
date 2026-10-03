import AppIntents
import SoloopsKit

/// Siri, which works in CarPlay whatever the entitlement says.
///
/// Worth having regardless: these are the things you want at a red light or
/// with both hands on the wheel, and asking is faster than any list. They also
/// keep the app useful while the CarPlay entitlement is still being reviewed.
///
/// Every one of them reads and writes the local database only. A phrase that
/// needed the network would fail exactly where it is most wanted.

struct NextAppointmentIntent: AppIntent {
    static let title: LocalizedStringResource = "Nächster Termin"
    static let description = IntentDescription("Sagt, was als Nächstes ansteht.")
    /// Spoken answers only; opening the app at the wheel is the opposite of
    /// the point.
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let agenda = AppEnvironment.shared.agenda else {
            return .result(dialog: "soloops ist noch nicht gekoppelt.")
        }
        let now = Date()
        let next = try agenda.current(at: now)
        let clientName = try agenda.clientName(next?.clientId)
        let text = Briefing().greeting(next: next, clientName: clientName, at: now)
        return .result(dialog: IntentDialog(stringLiteral: text))
    }
}

struct DailyBriefingIntent: AppIntent {
    static let title: LocalizedStringResource = "Tag vorlesen"
    static let description = IntentDescription(
        "Liest Termine und fällige Wiedervorlagen für heute vor.")
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let agenda = AppEnvironment.shared.agenda else {
            return .result(dialog: "soloops ist noch nicht gekoppelt.")
        }
        let now = Date()
        let events = try agenda.events(on: now)
        let followUps = try agenda.dueFollowUps(at: now)

        var names: [String: String] = [:]
        for event in events {
            if let id = event.clientId, let name = try agenda.clientName(id) { names[id] = name }
        }

        let text = Briefing().spoken(
            events: events, followUps: followUps, clientNames: names, at: now)
        return .result(dialog: IntentDialog(stringLiteral: text))
    }
}

struct DueFollowUpsIntent: AppIntent {
    static let title: LocalizedStringResource = "Fällige Wiedervorlagen"
    static let description = IntentDescription("Zählt auf, welche Leads dran sind.")
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let agenda = AppEnvironment.shared.agenda else {
            return .result(dialog: "soloops ist noch nicht gekoppelt.")
        }
        let now = Date()
        let due = try agenda.dueFollowUps(at: now)
        guard !due.isEmpty else { return .result(dialog: "Keine offenen Wiedervorlagen.") }

        let briefing = Briefing()
        let lines = due.prefix(3).map { briefing.line(for: $0, at: now) }
        var text = due.count == 1 ? "Eine Wiedervorlage. " : "\(due.count) Wiedervorlagen. "
        text += lines.joined(separator: ". ")
        if due.count > 3 { text += ". Und \(due.count - 3) weitere." }
        return .result(dialog: IntentDialog(stringLiteral: text))
    }
}

/// A thought on the way back from a customer, before it is gone.
///
/// Written straight into the local database, so it works in a tunnel; the sync
/// picks it up whenever there is a route again.
struct CaptureNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "Notiz an soloops"
    static let description = IntentDescription("Schreibt eine Notiz, auch ohne Netz.")
    static let openAppWhenRun = false

    @Parameter(title: "Notiz", requestValueDialog: "Was soll ich notieren?")
    var text: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let engine = AppEnvironment.shared.engine else {
            return .result(dialog: "soloops ist noch nicht gekoppelt.")
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .result(dialog: "Die Notiz war leer.") }

        // The first line is the title, the whole thing is the body — dictated
        // text has no headings, and an empty title would fail the merge's
        // required-field check on the Mac.
        let title = String(trimmed.prefix(60))

        try engine.recordLocal(
            entity: "Note",
            id: UUID().uuidString,
            patch: [
                "title": .string(title),
                "body": .string(trimmed),
                "tags": .strings(["unterwegs"]),
                "pinned": .bool(false),
            ]
        )

        Task { await AppEnvironment.shared.sync() }
        return .result(dialog: "Notiert.")
    }
}

/// Start the clock against a project, by name.
struct StartTimerIntent: AppIntent {
    static let title: LocalizedStringResource = "Zeit starten"
    static let description = IntentDescription("Startet die Zeiterfassung für ein Projekt.")
    static let openAppWhenRun = false

    @Parameter(title: "Projekt", requestValueDialog: "Für welches Projekt?")
    var project: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let engine = AppEnvironment.shared.engine,
            let agenda = AppEnvironment.shared.agenda
        else {
            return .result(dialog: "soloops ist noch nicht gekoppelt.")
        }

        let wanted = project.lowercased()
        let projects = try agenda.activeProjects()
        // Prefix before contains, so "App" picks the project called App and
        // not the one called "Relaunch App-Store-Auftritt".
        let match =
            projects.first { $0.name.lowercased() == wanted }
            ?? projects.first { $0.name.lowercased().hasPrefix(wanted) }
            ?? projects.first { $0.name.lowercased().contains(wanted) }

        guard let match else {
            return .result(dialog: "Kein Projekt gefunden, das zu \(project) passt.")
        }

        try engine.recordLocal(
            entity: "TimeEntry",
            id: UUID().uuidString,
            patch: [
                "projectId": .string(match.id),
                "clientId": match.clientId.map { SyncValue.string($0) } ?? .null,
                "startedAt": .isoDate(SyncCodec.isoString(Date())),
                "endedAt": .null,
                "durationSec": .int(0),
                "billable": .bool(true),
                "source": .string("TIMER"),
                "description": .string(""),
            ]
        )

        Task { await AppEnvironment.shared.sync() }
        return .result(dialog: "Zeit läuft für \(match.name).")
    }
}

struct SoloopsShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NextAppointmentIntent(),
            phrases: [
                "Nächster Termin in \(.applicationName)",
                "Was steht an in \(.applicationName)",
            ],
            shortTitle: "Nächster Termin",
            systemImageName: "calendar"
        )
        AppShortcut(
            intent: DailyBriefingIntent(),
            phrases: [
                "\(.applicationName) Tagesbriefing",
                "Lies mir den Tag vor mit \(.applicationName)",
            ],
            shortTitle: "Tag vorlesen",
            systemImageName: "speaker.wave.2"
        )
        AppShortcut(
            intent: DueFollowUpsIntent(),
            phrases: ["Fällige Wiedervorlagen in \(.applicationName)"],
            shortTitle: "Wiedervorlagen",
            systemImageName: "arrow.uturn.backward"
        )
        AppShortcut(
            intent: CaptureNoteIntent(),
            phrases: ["Notiz an \(.applicationName)"],
            shortTitle: "Notiz",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: StartTimerIntent(),
            phrases: ["Zeit starten in \(.applicationName)"],
            shortTitle: "Zeit starten",
            systemImageName: "play.circle"
        )
    }
}
