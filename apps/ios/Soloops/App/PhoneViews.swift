import SoloopsKit
import SwiftUI

/// The phone side.
///
/// Deliberately small. The Mac has the full interface; what belongs on the
/// phone is the day, the follow-ups, the drives waiting to be assigned, and
/// the state of the sync — the things you look at when the laptop is shut.
struct PairingView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var code = ""
    @State private var host = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(
                        "Am Mac in soloops unter Einstellungen → Geräte einen Kopplungscode erzeugen und den QR-Code mit der Kamera scannen."
                    )
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }

                Section("Von Hand") {
                    TextField("Code", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    TextField("Adresse des Macs", text: $host)
                        .keyboardType(.numbersAndPunctuation)
                        .autocorrectionDisabled()

                    Button(busy ? "Koppeln …" : "Koppeln") {
                        Task { await pair() }
                    }
                    .disabled(busy || code.isEmpty || host.isEmpty)
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("soloops")
        }
    }

    private func pair() async {
        busy = true
        defer { busy = false }
        // The port is the API's default; the manual path exists for the case
        // where the camera cannot read the screen, not as the normal way in.
        let invitation = Pairing.Invitation(code: code, addresses: [host], port: 3000)
        error = await environment.pair(with: invitation)
    }
}

struct MainView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        TabView {
            Tab("Heute", systemImage: "calendar") { TodayView() }
            Tab("Wiedervorlage", systemImage: "arrow.uturn.backward") { FollowUpView() }
            Tab("Fahrten", systemImage: "car") { DrivesView() }
            Tab("Abgleich", systemImage: "arrow.triangle.2.circlepath") { SyncView() }
        }
    }
}

struct TodayView: View {
    @Environment(AppEnvironment.self) private var environment
    private let briefing = Briefing()

    // Loaded rather than read in `body`: the database is on its own actor now,
    // and a body cannot await. It was the wrong place anyway — a read in there
    // runs again on every redraw.
    @State private var events: [AgendaEvent] = []
    @State private var tasks: [AgendaTask] = []

    var body: some View {
        NavigationStack {
            List {
                if events.isEmpty {
                    ContentUnavailableView("Keine Termine heute", systemImage: "calendar")
                } else {
                    ForEach(events) { event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.allDay ? "ganztägig" : briefing.time(event.startsAt))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(event.title)
                            if let location = event.location, !location.isEmpty {
                                Text(location).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if !tasks.isEmpty {
                    Section("Offene Punkte") {
                        ForEach(tasks) { task in
                            Button {
                                Task { await tick(task) }
                            } label: {
                                HStack {
                                    Image(systemName: "circle")
                                    Text(task.title)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Heute")
            .task { await load() }
            .refreshable {
                await environment.sync()
                await load()
            }
        }
    }

    private func load() async {
        guard let agenda = environment.agenda else {
            events = []
            tasks = []
            return
        }
        events = (try? await agenda.events(on: Date())) ?? []
        tasks = (try? await agenda.openTasks(limit: 10)) ?? []
    }

    private func tick(_ task: AgendaTask) async {
        guard let engine = environment.engine else { return }
        _ = try? await engine.recordLocal(
            entity: "ActionItem", id: task.id, patch: ["done": .bool(true)], isCreate: false)
        await environment.sync()
        await load()
    }
}

struct FollowUpView: View {
    @Environment(AppEnvironment.self) private var environment
    private let briefing = Briefing()

    @State private var due: [AgendaFollowUp] = []

    var body: some View {
        NavigationStack {
            List {
                if due.isEmpty {
                    ContentUnavailableView("Nichts offen", systemImage: "checkmark.circle")
                } else {
                    ForEach(due) { followUp in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(followUp.title)
                            Text(briefing.line(for: followUp, at: Date()))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button("Erledigt") { Task { await clear(followUp) } }.tint(.green)
                            Button("Morgen") { Task { await postpone(followUp) } }.tint(.orange)
                        }
                    }
                }
            }
            .navigationTitle("Wiedervorlage")
            .task { await load() }
            .refreshable {
                await environment.sync()
                await load()
            }
        }
    }

    private func load() async {
        guard let agenda = environment.agenda else {
            due = []
            return
        }
        due = (try? await agenda.dueFollowUps(at: Date())) ?? []
    }

    private func clear(_ followUp: AgendaFollowUp) async {
        guard let engine = environment.engine else { return }
        _ = try? await engine.recordLocal(
            entity: "Lead", id: followUp.id,
            patch: ["followUpOn": .null, "followUpNote": .null], isCreate: false)
        await environment.sync()
        await load()
    }

    private func postpone(_ followUp: AgendaFollowUp) async {
        guard let engine = environment.engine else { return }
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        _ = try? await engine.recordLocal(
            entity: "Lead", id: followUp.id,
            patch: ["followUpOn": .isoDate(SyncCodec.isoString(tomorrow))], isCreate: false)
        await environment.sync()
        await load()
    }
}

/// Drives the car recorded but could not place.
///
/// This screen is the reason the travel timer is allowed to guess at all: a
/// drive it cannot match waits here instead of being booked against the wrong
/// customer.
struct DrivesView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var suggestions: [CarPlayTravel.Suggestion] = []

    var body: some View {
        NavigationStack {
            List {
                if suggestions.isEmpty {
                    ContentUnavailableView(
                        "Keine offenen Fahrten",
                        systemImage: "car",
                        description: Text(
                            "Fahrten mit passendem Termin werden direkt gebucht.")
                    )
                } else {
                    ForEach(suggestions) { suggestion in
                        NavigationLink {
                            AssignDriveView(suggestion: suggestion) { reload() }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(suggestion.description)
                                Text(
                                    "\(suggestion.startedAt.formatted(date: .abbreviated, time: .shortened)) · \(Int(suggestion.endedAt.timeIntervalSince(suggestion.startedAt) / 60)) min"
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Fahrten")
            .onAppear { reload() }
        }
    }

    private func reload() {
        suggestions = CarPlayTravel.shared.suggestions
    }
}

struct AssignDriveView: View {
    let suggestion: CarPlayTravel.Suggestion
    let onDone: () -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    @State private var projects: [(id: String, name: String, clientId: String?)] = []

    var body: some View {
        List {
            Section("Auf welches Projekt?") {
                ForEach(projects, id: \.id) { project in
                    Button(project.name) {
                        Task {
                            await CarPlayTravel.shared.accept(
                                suggestion, projectId: project.id, clientId: project.clientId)
                            onDone()
                            dismiss()
                        }
                    }
                }
            }
            Section {
                Button("Fahrt verwerfen", role: .destructive) {
                    CarPlayTravel.shared.discard(suggestion)
                    onDone()
                    dismiss()
                }
            }
        }
        .navigationTitle(suggestion.description)
        .task {
            projects = (try? await environment.agenda?.activeProjects()) ?? []
        }
    }
}

struct SyncView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        NavigationStack {
            Form {
                Section("Zuletzt") {
                    LabeledContent("Weg", value: route)
                    LabeledContent(
                        "Erfolg",
                        value: environment.status.lastSuccess?.formatted(
                            date: .omitted, time: .standard) ?? "noch nie")
                    LabeledContent("Offen", value: "\(environment.status.pending)")
                    if let error = environment.status.lastError {
                        Text(error).foregroundStyle(.orange)
                    }
                }

                Section("Letzter Stapel") {
                    LabeledContent("Gesendet", value: "\(environment.status.report.pushed)")
                    LabeledContent("Übernommen", value: "\(environment.status.report.applied)")
                    LabeledContent("Verworfen", value: "\(environment.status.report.skipped)")
                    LabeledContent("Fehler", value: "\(environment.status.report.failed)")
                }

                // The reasons, verbatim. A row that will not sync is otherwise
                // impossible to explain from the phone.
                if !environment.status.report.notes.isEmpty {
                    Section("Hinweise") {
                        ForEach(environment.status.report.notes, id: \.self) { note in
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                Section {
                    Button("Jetzt abgleichen") { Task { await environment.sync() } }
                    Button("Kopplung lösen", role: .destructive) { environment.unpair() }
                }
            }
            .navigationTitle("Abgleich")
        }
    }

    private var route: String {
        switch environment.status.route {
        case .lan: "WLAN"
        case .iCloud: "iCloud"
        case .none: "keiner"
        }
    }
}
