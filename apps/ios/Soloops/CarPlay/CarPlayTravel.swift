import Foundation
import SoloopsKit

/// Travel time, from getting in to getting out.
///
/// `TravelTimer` in the kit decides what a finished drive is worth; this is
/// the bit that knows when one happened and writes the result. Split that way
/// because the deciding is the part with judgement in it and is tested, and
/// this part is unavoidably about app lifecycle.
///
/// Deliberately conservative: a drive that cannot be matched to an appointment
/// is held as a suggestion rather than booked against a guess. Time landing on
/// the wrong customer is worse than time not landing at all, because nobody
/// goes looking for an entry they did not expect.
@MainActor
final class CarPlayTravel {
    static let shared = CarPlayTravel()

    private let timer = TravelTimer()
    private let connectedKey = "travel.connectedAt"
    /// Drives with no obvious destination, waiting for the user to assign one.
    private let suggestionKey = "travel.suggestions"

    private init() {}

    struct Suggestion: Codable, Equatable, Identifiable {
        var id: String { "\(startedAt.timeIntervalSince1970)" }
        let startedAt: Date
        let endedAt: Date
        let description: String
    }

    // --- Lifecycle ---------------------------------------------------------

    /// CarPlay connected. Stored rather than held in memory, because the app
    /// may well be terminated during the drive and relaunched on arrival.
    func didConnect(at date: Date) {
        UserDefaults.standard.set(date, forKey: connectedKey)
    }

    func didDisconnect(at date: Date) {
        guard let startedAt = UserDefaults.standard.object(forKey: connectedKey) as? Date else {
            return
        }
        UserDefaults.standard.removeObject(forKey: connectedKey)
        finish(TravelTimer.Drive(startedAt: startedAt, endedAt: date))
    }

    private func finish(_ drive: TravelTimer.Drive) {
        guard let environment = Optional(AppEnvironment.shared),
            let engine = environment.engine,
            let agenda = environment.agenda
        else { return }

        // Look at both days: a drive home at 23:40 belongs to appointments
        // that are still on yesterday's page.
        var events = (try? agenda.events(on: drive.startedAt)) ?? []
        if !Calendar.current.isDate(drive.startedAt, inSameDayAs: drive.endedAt) {
            events += (try? agenda.events(on: drive.endedAt)) ?? []
        }

        switch timer.outcome(for: drive, around: events) {
        case .ignore:
            return

        case .record(let projectId, let clientId, let description):
            guard let projectId else {
                // Nothing to book it against. Kept so the phone can offer it.
                remember(
                    Suggestion(
                        startedAt: drive.startedAt, endedAt: drive.endedAt,
                        description: description))
                return
            }

            let patch = timer.patch(
                for: drive, projectId: projectId, clientId: clientId, description: description)
            _ = try? engine.recordLocal(entity: "TimeEntry", id: UUID().uuidString, patch: patch)

            Task { await environment.sync() }
        }
    }

    // --- Open suggestions --------------------------------------------------

    var suggestions: [Suggestion] {
        guard let data = UserDefaults.standard.data(forKey: suggestionKey),
            let list = try? JSONDecoder().decode([Suggestion].self, from: data)
        else { return [] }
        return list
    }

    private func remember(_ suggestion: Suggestion) {
        // Capped, and oldest dropped first. An unbounded list of drives
        // nobody ever assigned would grow for years.
        var list = suggestions.filter { $0.id != suggestion.id }
        list.append(suggestion)
        if list.count > 20 { list.removeFirst(list.count - 20) }
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: suggestionKey)
    }

    func discard(_ suggestion: Suggestion) {
        let list = suggestions.filter { $0.id != suggestion.id }
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: suggestionKey)
    }

    /// Book a held drive against a project the user picked.
    func accept(_ suggestion: Suggestion, projectId: String, clientId: String?) {
        guard let engine = AppEnvironment.shared.engine else { return }

        let drive = TravelTimer.Drive(
            startedAt: suggestion.startedAt, endedAt: suggestion.endedAt)
        let patch = timer.patch(
            for: drive, projectId: projectId, clientId: clientId,
            description: suggestion.description)
        _ = try? engine.recordLocal(entity: "TimeEntry", id: UUID().uuidString, patch: patch)

        discard(suggestion)
        Task { await AppEnvironment.shared.sync() }
    }
}
