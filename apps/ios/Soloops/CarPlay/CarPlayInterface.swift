import CarPlay
import SoloopsKit
import UIKit

/// The templates behind the icon.
///
/// Three tabs, and the ordering is the point: the briefing first because it is
/// the one thing safe to use while moving, then today's appointments, then the
/// follow-ups. Everything reads from the local database, so none of it depends
/// on the car having a network — which it usually does not.
///
/// Rows carry a `handler` and nothing more complicated. CarPlay redraws a tab
/// only when its template is replaced, so each tab is rebuilt from the store
/// on every refresh rather than mutated in place.
@MainActor
final class CarPlayInterface {
    let controller: CPInterfaceController
    let environment: AppEnvironment
    let player: BriefingPlayer

    private let briefing = Briefing()
    private var refreshTimer: Timer?

    init(controller: CPInterfaceController, environment: AppEnvironment, player: BriefingPlayer) {
        self.controller = controller
        self.environment = environment
        self.player = player
    }

    deinit {
        refreshTimer?.invalidate()
    }

    private let todayTab = CPListTemplate(title: "Heute", sections: [])
    private let followUpTab = CPListTemplate(title: "Wiedervorlage", sections: [])
    private let briefingTab = CPListTemplate(title: "Briefing", sections: [])

    func install() {
        briefingTab.tabTitle = "Briefing"
        briefingTab.tabImage = UIImage(systemName: "speaker.wave.2.fill")
        todayTab.tabTitle = "Heute"
        todayTab.tabImage = UIImage(systemName: "calendar")
        followUpTab.tabTitle = "Wiedervorlage"
        followUpTab.tabImage = UIImage(systemName: "arrow.uturn.backward")

        let tabs = CPTabBarTemplate(templates: [briefingTab, todayTab, followUpTab])
        controller.setRootTemplate(tabs, animated: false, completion: nil)

        refresh()

        // A minute is enough: the agenda only changes when a sync brings
        // something in or an appointment ends, and a timer that fires more
        // often in a parked car is battery for nothing.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        let now = Date()
        briefingTab.updateSections(briefingSections(at: now))
        todayTab.updateSections(todaySections(at: now))
        followUpTab.updateSections(followUpSections(at: now))
    }

    // --- Briefing ----------------------------------------------------------

    private func briefingSections(at now: Date) -> [CPListSection] {
        guard let agenda = environment.agenda else {
            return [CPListSection(items: [notPairedRow()])]
        }

        let events = (try? agenda.events(on: now)) ?? []
        let followUps = (try? agenda.dueFollowUps(at: now)) ?? []
        let next = (try? agenda.current(at: now))
        let clientName = (try? agenda.clientName(next?.clientId)) ?? nil

        let headline = briefing.greeting(next: next, clientName: clientName, at: now)

        let play = CPListItem(
            text: "Tag vorlesen",
            detailText: headline
        )
        play.handler = { [weak self] _, completion in
            guard let self else {
                completion()
                return
            }
            var names: [String: String] = [:]
            for event in events {
                if let id = event.clientId, let name = try? agenda.clientName(id) {
                    names[id] = name
                }
            }
            let text = briefing.spoken(
                events: events, followUps: followUps, clientNames: names, at: now)
            player.speak(text, title: "Tagesbriefing", subtitle: headline)
            controller.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
            completion()
        }

        let stop = CPListItem(text: "Vorlesen beenden", detailText: nil)
        stop.handler = { [weak self] _, completion in
            self?.player.stop()
            completion()
        }

        let sync = CPListItem(text: "Jetzt abgleichen", detailText: syncDetail())
        sync.handler = { [weak self] _, completion in
            Task { @MainActor in
                await self?.environment.sync()
                self?.refresh()
                completion()
            }
        }

        return [
            CPListSection(items: [play, stop]),
            CPListSection(items: [sync], header: "Abgleich", sectionIndexTitle: nil),
        ]
    }

    private func syncDetail() -> String {
        let status = environment.status
        if let error = status.lastError { return error }
        guard let last = status.lastSuccess else { return "Noch nicht abgeglichen" }

        let route: String
        switch status.route {
        case .lan: route = "über WLAN"
        case .iCloud: route = "über iCloud"
        case .none: route = ""
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        let pending = status.pending > 0 ? ", \(status.pending) offen" : ""
        return "\(formatter.string(from: last)) Uhr \(route)\(pending)"
    }

    // --- Today -------------------------------------------------------------

    private func todaySections(at now: Date) -> [CPListSection] {
        guard let agenda = environment.agenda else {
            return [CPListSection(items: [notPairedRow()])]
        }

        let events = (try? agenda.events(on: now)) ?? []
        guard !events.isEmpty else {
            return [CPListSection(items: [CPListItem(text: "Keine Termine heute", detailText: nil)])]
        }

        let items = events.map { event -> CPListItem in
            let name = (try? agenda.clientName(event.clientId)) ?? nil
            let item = CPListItem(
                text: event.allDay ? event.title : "\(briefing.time(event.startsAt)) \(event.title)",
                detailText: [name, event.location].compactMap { $0 }.joined(separator: " · ")
            )
            // The thing a driver actually wants from an appointment is the way
            // there, so tapping a row with an address hands it to Maps.
            if let location = event.location, !location.isEmpty {
                item.handler = { _, completion in
                    Self.navigate(to: location)
                    completion()
                }
            } else {
                item.handler = { [weak self] _, completion in
                    let line = self?.briefing.line(for: event, clientName: name) ?? event.title
                    self?.player.speak(line, title: event.title, subtitle: name ?? "Termin")
                    completion()
                }
            }
            return item
        }

        return [CPListSection(items: items)]
    }

    /// Hand an address to whatever is doing navigation.
    ///
    /// A URL rather than `MKMapItem.openMaps`, because in CarPlay the user's
    /// chosen navigation app answers this and that is the one they want.
    private static func navigate(to address: String) {
        let encoded =
            address.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? address
        guard let url = URL(string: "maps://?daddr=\(encoded)&dirflg=d") else { return }
        UIApplication.shared.open(url)
    }

    // --- Follow-ups --------------------------------------------------------

    private func followUpSections(at now: Date) -> [CPListSection] {
        guard let agenda = environment.agenda, let engine = environment.engine else {
            return [CPListSection(items: [notPairedRow()])]
        }

        let due = (try? agenda.dueFollowUps(at: now)) ?? []
        guard !due.isEmpty else {
            return [
                CPListSection(items: [CPListItem(text: "Nichts offen", detailText: nil)])
            ]
        }

        let items = due.map { followUp -> CPListItem in
            let item = CPListItem(
                text: followUp.title,
                detailText: briefing.line(for: followUp, at: now)
            )
            item.handler = { [weak self] _, completion in
                self?.showOptions(for: followUp, engine: engine, at: now)
                completion()
            }
            return item
        }

        return [CPListSection(items: items)]
    }

    /// What you can do with a follow-up without taking your eyes off the road.
    ///
    /// Three choices, all one tap: call, postpone a day, done. Anything more
    /// belongs on the phone — and an action sheet is the only safe way to
    /// confirm something irreversible in a moving car.
    private func showOptions(for followUp: AgendaFollowUp, engine: SyncEngine, at now: Date) {
        var actions: [CPAlertAction] = []

        if let phone = followUp.phone, !phone.isEmpty,
            let url = URL(string: "tel://\(phone.filter { $0.isNumber || $0 == "+" })")
        {
            actions.append(
                CPAlertAction(title: "Anrufen", style: .default) { _ in
                    UIApplication.shared.open(url)
                })
        }

        actions.append(
            CPAlertAction(title: "Morgen wieder", style: .default) { [weak self] _ in
                let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
                _ = try? engine.recordLocal(
                    entity: "Lead",
                    id: followUp.id,
                    patch: ["followUpOn": .isoDate(SyncCodec.isoString(tomorrow))],
                    isCreate: false
                )
                self?.afterChange()
            })

        actions.append(
            CPAlertAction(title: "Erledigt", style: .default) { [weak self] _ in
                // Clearing the date is what "done" means for a follow-up; the
                // lead itself stays where it is in the pipeline.
                _ = try? engine.recordLocal(
                    entity: "Lead",
                    id: followUp.id,
                    patch: ["followUpOn": .null, "followUpNote": .null],
                    isCreate: false
                )
                self?.afterChange()
            })

        actions.append(CPAlertAction(title: "Abbrechen", style: .cancel) { _ in })

        let sheet = CPActionSheetTemplate(
            title: followUp.title,
            message: followUp.company,
            actions: actions
        )
        controller.presentTemplate(sheet, animated: true, completion: nil)
    }

    private func afterChange() {
        controller.dismissTemplate(animated: true, completion: nil)
        refresh()
        // The change is already in the local log, so this is only about
        // getting it across sooner. If it fails, nothing is lost.
        Task { @MainActor in
            await environment.sync()
            refresh()
        }
    }

    // --- Shared ------------------------------------------------------------

    private func notPairedRow() -> CPListItem {
        CPListItem(
            text: "Noch nicht gekoppelt",
            detailText: "Am iPhone in soloops den Code vom Mac scannen."
        )
    }
}
