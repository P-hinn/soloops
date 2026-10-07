import Foundation

/// Turning a drive into a billable time entry.
///
/// CarPlay connecting and disconnecting is a reliable signal that a car
/// journey started and ended, and travel to a customer is work that usually
/// goes unbilled because nobody starts a stopwatch while parking. This closes
/// that gap without asking anything of the driver.
///
/// The decision is separated from the side effects on purpose: "which project
/// does this drive belong to" is guesswork, and guesswork needs to be visible
/// in a test rather than discovered in an invoice.
public struct TravelTimer {
    /// Shorter than this and it was not a journey — moving the car in the
    /// yard, or CarPlay dropping out and reconnecting at a petrol station.
    public static let minimumSeconds = 180
    /// Longer than this and the phone almost certainly stayed in a parked car
    /// with the ignition on, or the disconnect was never seen. Recording an
    /// eight-hour drive to a customer would be worse than recording nothing.
    public static let maximumSeconds = 4 * 3600
    /// How far on either side of the drive a meeting still counts as its
    /// destination.
    public static let windowSeconds: TimeInterval = 90 * 60

    public struct Drive: Equatable, Sendable {
        public let startedAt: Date
        public let endedAt: Date

        public init(startedAt: Date, endedAt: Date) {
            self.startedAt = startedAt
            self.endedAt = endedAt
        }

        public var seconds: Int { Int(endedAt.timeIntervalSince(startedAt)) }
    }

    /// What should happen when a drive ends.
    public enum Outcome: Equatable, Sendable {
        /// Not worth recording, and why — surfaced in the app so a missing
        /// entry is explainable rather than mysterious.
        case ignore(reason: String)
        /// Write a time entry. `projectId` nil means the app has to ask.
        case record(projectId: String?, clientId: String?, description: String)
    }

    public let calendar: Calendar

    public init(calendar: Calendar = .current) {
        self.calendar = calendar
    }

    /// Decide what a finished drive is worth.
    ///
    /// The destination is inferred from the calendar: a drive that ends just
    /// before a meeting, or starts just after one, was almost certainly to or
    /// from it. When nothing lines up, the entry is still offered but without
    /// a project, because the alternative is silently attaching the time to
    /// the wrong customer.
    public func outcome(for drive: Drive, around events: [AgendaEvent]) -> Outcome {
        if drive.seconds < Self.minimumSeconds {
            return .ignore(reason: "unter \(Self.minimumSeconds / 60) Minuten")
        }
        if drive.seconds > Self.maximumSeconds {
            return .ignore(reason: "länger als \(Self.maximumSeconds / 3600) Stunden")
        }

        if let destination = destination(for: drive, among: events) {
            let direction = destination.startsAt >= drive.endedAt ? "Anfahrt" : "Rückfahrt"
            return .record(
                projectId: destination.projectId,
                clientId: destination.clientId,
                description: "\(direction) \(destination.title)"
            )
        }

        return .record(projectId: nil, clientId: nil, description: "Fahrt")
    }

    /// The meeting this drive most likely belongs to.
    ///
    /// Nearest in time wins, looking both ways. An all-day entry is never a
    /// destination — it has no time to be near.
    func destination(for drive: Drive, among events: [AgendaEvent]) -> AgendaEvent? {
        var best: (event: AgendaEvent, distance: TimeInterval)?

        for event in events where !event.allDay {
            // Arriving at it, or leaving from it.
            let toStart = event.startsAt.timeIntervalSince(drive.endedAt)
            let fromEnd = drive.startedAt.timeIntervalSince(event.endsAt)

            let distance: TimeInterval
            if toStart >= 0 && toStart <= Self.windowSeconds {
                distance = toStart
            } else if fromEnd >= 0 && fromEnd <= Self.windowSeconds {
                distance = fromEnd
            } else {
                continue
            }

            if best == nil || distance < best!.distance {
                best = (event: event, distance: distance)
            }
        }

        return best?.event
    }

    /// The patch for the time entry a recorded drive becomes.
    ///
    /// `TRAVEL` is not one of `TimeSource`'s values, so the source stays
    /// `TIMER` — the entry really was produced by a running clock. The fact
    /// that it was a drive is in the description, where an invoice can show
    /// it.
    public func patch(for drive: Drive, projectId: String, clientId: String?, description: String)
        -> Patch
    {
        var patch: Patch = [
            "projectId": .string(projectId),
            "startedAt": .isoDate(SyncCodec.isoString(drive.startedAt)),
            "endedAt": .isoDate(SyncCodec.isoString(drive.endedAt)),
            "durationSec": .int(drive.seconds),
            "description": .string(description),
            "billable": .bool(true),
            "source": .string("TIMER"),
            "tags": .strings(["fahrt"]),
        ]
        patch["clientId"] = clientId.map { SyncValue.string($0) } ?? .null
        return patch
    }
}
