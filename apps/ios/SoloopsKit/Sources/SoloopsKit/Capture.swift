import Foundation

/// Turning one typed sentence into one row.
///
/// Deliberately not an assistant. The Mac has the AI quick entry that reads a
/// sentence, proposes a client, a project and three appointments, and waits
/// for confirmation. That is right at a desk and wrong in a car park: it needs
/// the network, it needs reading, and it needs a decision. Here the rule is
/// blunt enough to predict — first line is the title, the rest is the body —
/// so what you get is what you typed.
///
/// The one piece of cleverness is the due date, because "morgen" is the word
/// people actually write and typing a date instead is what stops them writing
/// anything at all.
public enum Capture {
    public enum Kind: String, Sendable, CaseIterable {
        case lead
        case task
        case note

        public var entity: String {
            switch self {
            case .lead: return "Lead"
            case .task: return "ActionItem"
            case .note: return "Note"
            }
        }

        /// The button.
        public var action: String {
            switch self {
            case .lead: return "Als Lead anlegen"
            case .task: return "Als Aufgabe anlegen"
            case .note: return "Als Notiz anlegen"
            }
        }

        public var noun: String {
            switch self {
            case .lead: return "Lead"
            case .task: return "Aufgabe"
            case .note: return "Notiz"
            }
        }
    }

    public struct Draft: Equatable, Sendable {
        public let title: String
        public let patch: Patch
    }

    /// Titles are a line, not a paragraph. Sixty characters is roughly what
    /// fits on a list row before it is cut off anyway.
    static let titleLimit = 60

    public static func draft(from text: String, as kind: Kind, now: Date = Date()) -> Draft {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false)
        let first = lines.first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        let rest = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespaces)

        let title = String(first.isEmpty ? trimmed.prefix(titleLimit) : first.prefix(titleLimit))

        switch kind {
        case .lead:
            var patch: Patch = [
                "title": .string(title),
                // The stages the pipeline starts with, spelled out rather than
                // left to the server's defaults: a row written offline is
                // applied field by field, and a column nobody set stays empty.
                "stage": .string("NEW"),
                "source": .string("OTHER"),
                "archived": .bool(false),
            ]
            if !rest.isEmpty { patch["notes"] = .string(rest) }
            if let due = due(in: trimmed, now: now) {
                patch["followUpOn"] = .isoDate(SyncCodec.isoString(due))
            }
            return Draft(title: title, patch: patch)

        case .task:
            var patch: Patch = [
                "title": .string(title),
                "done": .bool(false),
                "status": .string("TODO"),
                "source": .string("MANUAL"),
            ]
            if let due = due(in: trimmed, now: now) {
                patch["dueOn"] = .isoDate(SyncCodec.isoString(due))
            }
            return Draft(title: title, patch: patch)

        case .note:
            return Draft(
                title: title,
                patch: [
                    "title": .string(title),
                    "body": .string(trimmed),
                    "tags": .strings(["unterwegs"]),
                    "pinned": .bool(false),
                ]
            )
        }
    }

    /// What to show under the field, so the date is visible before saving
    /// rather than a surprise in the list afterwards.
    public static func dueHint(in text: String, now: Date = Date()) -> String? {
        guard let date = due(in: text, now: now) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.dateFormat = "EEEE, d. MMMM"
        return "fällig \(formatter.string(from: date))"
    }

    /// The words people write instead of a date.
    ///
    /// Only unambiguous ones. "Freitag" means the coming Friday; if today is
    /// Friday it means next week, because a task you type today for today you
    /// would have written "heute".
    static func due(in text: String, now: Date = Date()) -> Date? {
        let haystack = text.lowercased()
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "de_DE")
        calendar.firstWeekday = 2

        func day(_ offset: Int) -> Date? {
            calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: now))
        }

        // The umlaut-free spellings are here because people type them, often
        // enough that leaving them out is a silent wrong answer rather than no
        // answer. And "übermorgen" has to be tested before "morgen", which it
        // contains — the other order books the wrong day and says nothing.
        if haystack.contains("übermorgen") || haystack.contains("uebermorgen") { return day(2) }
        if haystack.contains("morgen") { return day(1) }
        if haystack.contains("heute") { return day(0) }
        if haystack.contains("nächste woche") || haystack.contains("naechste woche") {
            return day(7)
        }

        // "in 3 tagen"
        if let match = haystack.range(of: #"in (\d{1,2}) tag"#, options: .regularExpression) {
            let digits = haystack[match].filter(\.isNumber)
            if let count = Int(digits), count > 0, count < 90 { return day(count) }
        }

        let weekdays = [
            "montag": 2, "dienstag": 3, "mittwoch": 4, "donnerstag": 5,
            "freitag": 6, "samstag": 7, "sonntag": 1,
        ]
        for (name, weekday) in weekdays where haystack.contains(name) {
            let today = calendar.component(.weekday, from: now)
            var ahead = weekday - today
            if ahead <= 0 { ahead += 7 }
            return day(ahead)
        }

        return nil
    }
}
